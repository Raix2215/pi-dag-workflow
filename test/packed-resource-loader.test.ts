import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { DefaultResourceLoader, SettingsManager, type ExtensionAPI, type InlineExtension } from '@earendil-works/pi-coding-agent';

const packageRoot = fileURLToPath(new URL('../', import.meta.url));
const tempRootBase = join(packageRoot, 'artifacts', 'packed-loader');

interface PackedPackage {
  root: string;
  archive: string;
  archiveSha256: string;
  unpacked: string;
  sdkVersion: string;
}

/** The one independent registration proof per declared module; paths themselves always come from the packed manifest. */
const REGISTRATION_PROOF = {
  todos: { kind: 'tool', name: 'todo' },
  plan: { kind: 'command', name: 'plan' },
  agents: { kind: 'tool', name: 'subagent_spawn' },
  goal: { kind: 'tool', name: 'goal' },
  retry: { kind: 'command', name: 'retry' },
  team: { kind: 'tool', name: 'team_send' },
} as const;

interface TestContextLike {
  after(fn: () => unknown): void;
  diagnostic(message: string): void;
}

async function readManifestEntries(root: string): Promise<string[]> {
  const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) as { pi?: { extensions?: unknown } };
  const entries = manifest.pi?.extensions;
  assert.ok(Array.isArray(entries), 'the packed package.json must declare pi.extensions');
  assert.ok(entries.every((entry): entry is string => typeof entry === 'string'), 'every pi.extensions entry must be a string');
  assert.equal(new Set(entries).size, entries.length, 'the packed manifest must not declare the same entry twice');
  return entries as string[];
}

async function packAndExtract(t: TestContextLike): Promise<PackedPackage> {
  await mkdir(tempRootBase, { recursive: true });
  const root = await mkdtemp(join(tempRootBase, 'loader-'));
  const previousHome = process.env.HOME;
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const previousNpmCache = process.env.npm_config_cache;
  const home = join(root, 'home');
  const agentDir = join(root, 'agent');
  const npmCache = join(root, 'npm-cache');
  let environmentApplied = false;
  t.after(async () => {
    try {
      if (environmentApplied) {
        if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome;
        if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
        if (previousNpmCache === undefined) delete process.env.npm_config_cache; else process.env.npm_config_cache = previousNpmCache;
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  assert.ok(root.startsWith(resolve(packageRoot) + sep), 'the packed fixture must stay inside the package workspace');
  await mkdir(home);
  await mkdir(agentDir);
  await mkdir(npmCache);
  process.env.HOME = home;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  process.env.npm_config_cache = npmCache;
  environmentApplied = true;
  assert.equal(process.env.HOME, home, 'the packed fixture must use its isolated HOME');
  assert.equal(process.env.PI_CODING_AGENT_DIR, agentDir, 'the packed fixture must use its isolated agent dir');

  const packedJson = JSON.parse(execFileSync('npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', root], {
    cwd: packageRoot, encoding: 'utf8', timeout: 60_000, env: { ...process.env, TMPDIR: root },
  })) as Record<string, { filename: string }>;
  const packed = Object.values(packedJson)[0];
  assert.ok(packed, 'npm pack must report the archive it wrote');
  const archive = join(root, packed.filename);
  const archiveSha256 = createHash('sha256').update(await readFile(archive)).digest('hex');
  execFileSync('tar', ['-xzf', archive, '-C', root], { encoding: 'utf8', timeout: 60_000, env: { ...process.env, TMPDIR: root } });
  const unpacked = join(root, 'package');
  assert.ok(existsSync(join(unpacked, 'package.json')), 'the tgz must contain the package manifest');
  assert.notEqual(resolve(unpacked), resolve(packageRoot), 'the fixture must not be the worktree');
  assert.ok(resolve(unpacked).startsWith(resolve(root) + sep), 'the unpacked package must stay inside its isolated fixture root');
  assert.equal(resolve(unpacked).startsWith(resolve(packageRoot, 'src') + sep), false, 'the unpacked package must not be the worktree source tree');
  assert.equal(existsSync(join(unpacked, 'test')), false, 'the packed fixture must not contain the worktree test directory');
  assert.equal(existsSync(join(unpacked, 'node_modules')), false, 'the packed fixture must not contain installed host modules');
  const sdkVersion = JSON.parse(await readFile(join(packageRoot, 'node_modules', '@earendil-works', 'pi-coding-agent', 'package.json'), 'utf8')).version as string;
  return { root, archive, archiveSha256, unpacked, sdkVersion };
}

function declaredEntryFor(declared: string[], unpackedRoot: string, feature: string): string {
  const entry = declared.find((candidate) => basename(dirname(resolve(unpackedRoot, candidate))) === feature);
  assert.ok(entry, `the packed manifest must declare the ${feature} entry`);
  return entry;
}

function createLoader(root: string, unpackedRoot: string, extensionFactories: InlineExtension[] = []): DefaultResourceLoader {
  return new DefaultResourceLoader({
    cwd: join(root, 'cwd'),
    agentDir: join(root, 'agent'),
    settingsManager: SettingsManager.inMemory({}),
    additionalExtensionPaths: [unpackedRoot],
    extensionFactories,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
  });
}

function assertManifestPaths(
  loaded: ReturnType<DefaultResourceLoader['getExtensions']>,
  declared: string[],
  unpackedRoot: string,
): void {
  assert.deepEqual(loaded.errors, [], 'the normal packed package must load without loader errors');
  assert.equal(loaded.extensions.length, declared.length, 'every declared entry must load once');
  const actual = loaded.extensions.map((extension) => extension.resolvedPath);
  const expected = declared.map((entry) => resolve(unpackedRoot, entry));
  assert.equal(new Set(actual).size, actual.length, 'no two declarations may resolve to the same loaded entry');
  assert.deepEqual(actual.slice().sort(), expected.slice().sort(), 'the loader must resolve exactly the passed manifest entries');
  const worktreeSourcePrefix = resolve(packageRoot, 'src') + sep;
  for (const resolvedPath of actual) {
    assert.ok(existsSync(resolvedPath), `${resolvedPath} must be a real unpacked file`);
    const inside = relative(unpackedRoot, resolvedPath);
    assert.ok(inside !== '' && inside !== '..' && !inside.startsWith(`..${sep}`) && !isAbsolute(inside), `${resolvedPath} must be inside the unpacked package root`);
    assert.ok(!resolvedPath.startsWith(worktreeSourcePrefix), `${resolvedPath} must not fall back to the worktree source`);
  }

  const toolNames = loaded.extensions.flatMap((extension) => [...extension.tools.keys()]);
  const commandNames = loaded.extensions.flatMap((extension) => [...extension.commands.keys()]);
  assert.equal(new Set(toolNames).size, toolNames.length, 'no two packed entries may register the same tool name');
  assert.equal(new Set(commandNames).size, commandNames.length, 'no two packed entries may register the same command name');
  const byPath = new Map(loaded.extensions.map((extension) => [extension.resolvedPath, extension]));
  for (const entry of declared) {
    const expectedPath = resolve(unpackedRoot, entry);
    const extension = byPath.get(expectedPath);
    assert.ok(extension, `the declared entry ${entry} must be loaded`);
    const feature = basename(dirname(expectedPath));
    const proof = REGISTRATION_PROOF[feature as keyof typeof REGISTRATION_PROOF];
    assert.ok(proof, `the declared entry ${entry} must name a known workflow module`);
    if (proof.kind === 'tool') {
      assert.ok(extension.tools.has(proof.name), `${feature} must actually register tool ${proof.name} from the unpacked entry`);
    } else {
      assert.ok(extension.commands.has(proof.name), `${feature} must actually register command /${proof.name} from the unpacked entry`);
    }
  }
}

test('packed package loads all six manifest entries through the real Pi loader from the unpacked root', {
  timeout: 60_000,
  skip: process.platform === 'win32' ? 'packed test relies on POSIX tar' : false,
}, async (t) => {
  const packed = await packAndExtract(t);
  const declared = await readManifestEntries(packed.unpacked);
  assert.equal(declared.length, 6, 'the current package manifest declares six workflow entries');
  const loader = createLoader(packed.root, packed.unpacked);
  try {
    await loader.reload();
    const loaded = loader.getExtensions();
    assertManifestPaths(loaded, declared, packed.unpacked);
    t.diagnostic(`node ${process.version}; Pi SDK ${packed.sdkVersion}; tgz ${basename(packed.archive)} sha256 ${packed.archiveSha256}; entries ${declared.length}`);
  } finally {
    loader.getExtensions().runtime.invalidate();
  }
});

test('removing one entry from the unpacked package removes exactly that manifest entry, never falling back to the worktree', {
  timeout: 60_000,
  skip: process.platform === 'win32' ? 'packed test relies on POSIX tar' : false,
}, async (t) => {
  const packed = await packAndExtract(t);
  const declared = await readManifestEntries(packed.unpacked);
  const removedEntry = declaredEntryFor(declared, packed.unpacked, 'plan');
  assert.ok(declared.includes(removedEntry), 'the baseline manifest must declare the entry this fixture removes');
  const removedPath = resolve(packed.unpacked, removedEntry);
  await rm(removedPath);
  const loader = createLoader(packed.root, packed.unpacked);
  try {
    await loader.reload();
    const loaded = loader.getExtensions();
    const actual = loaded.extensions.map((extension) => extension.resolvedPath);
    const expected = declared.filter((entry) => entry !== removedEntry).map((entry) => resolve(packed.unpacked, entry));
    assert.equal(loaded.extensions.length, declared.length - 1, 'the removed entry must not load');
    assert.equal(actual.includes(removedPath), false, 'the removed resolvedPath must not appear');
    assert.deepEqual(actual.slice().sort(), expected.slice().sort(), 'exactly the remaining manifest entries must load');
    assert.equal(loaded.extensions.flatMap((extension) => [...extension.commands.keys()]).includes('plan'), false, 'the removed plan entry must not register its command');
    t.diagnostic(`declared ${declared.length}; loaded ${actual.length}; removed ${removedEntry}; loader errors ${loaded.errors.length}`);
  } finally {
    loader.getExtensions().runtime.invalidate();
  }
});

test('the packed loader reports a real duplicate-tool conflict from an inline fixture instead of swallowing errors', {
  timeout: 60_000,
  skip: process.platform === 'win32' ? 'packed test relies on POSIX tar' : false,
}, async (t) => {
  const packed = await packAndExtract(t);
  const declared = await readManifestEntries(packed.unpacked);
  assert.equal(declared.length, 6, 'the current package manifest still declares six workflow entries');
  const declaredPaths = declared.map((entry) => resolve(packed.unpacked, entry));
  const inlineFixtureName = 'packed-loader-duplicate-todo';
  const inlineFixturePath = `<inline:${inlineFixtureName}>`;
  const duplicateTodoFixture: InlineExtension = {
    name: inlineFixtureName,
    factory: (pi: ExtensionAPI) => {
      pi.registerTool({
        name: 'todo',
        label: 'duplicate todo fixture',
        description: 'Offline duplicate tool fixture',
        parameters: {},
        execute: async () => ({ content: [], details: undefined }),
      });
    },
  };
  const loader = createLoader(packed.root, packed.unpacked, [duplicateTodoFixture]);
  try {
    await loader.reload();
    const loaded = loader.getExtensions();
    const inlineFixture = loaded.extensions.find((extension) => extension.resolvedPath === inlineFixturePath);
    const packedExtensions = loaded.extensions.filter((extension) => declaredPaths.includes(extension.resolvedPath));
    assert.equal(loaded.extensions.length, declared.length + 1, 'the inline fixture is an extra extension, not a seventh packed entry');
    assert.ok(inlineFixture, 'the inline duplicate-tool fixture must load as its own extension');
    assert.ok(inlineFixture.tools.has('todo'), 'the inline fixture must actually register the duplicate todo tool');
    assert.equal(packedExtensions.length, declared.length, 'a conflict error must not hide any of the six packed manifest entries');
    const actual = packedExtensions.map((extension) => extension.resolvedPath);
    assert.deepEqual(actual.slice().sort(), declaredPaths.slice().sort(), 'the conflict error must not change which packed entries loaded');
    const teamEntry = declaredEntryFor(declared, packed.unpacked, 'team');
    const team = packedExtensions.find((extension) => extension.resolvedPath === resolve(packed.unpacked, teamEntry));
    assert.ok(team, 'the packed team entry must still load beside the inline fixture');
    assert.ok(team.tools.has('team_send'), 'the packed team entry must still register its own team_send tool');
    assert.equal(loaded.errors.length, 1, `the duplicate todo fixture must produce exactly one real loader error, got ${loaded.errors.length}`);
    assert.equal(loaded.errors[0]?.path, inlineFixturePath, 'the loader must attribute the conflict to the inline fixture');
    assert.match(loaded.errors[0]?.error ?? '', /^Tool "todo" conflicts with .*[\\/]src[\\/]todos[\\/]index\.ts$/, 'the loader error must identify the packed todos entry as the existing owner');
    t.diagnostic(`packed entries loaded ${packedExtensions.length}/${declared.length}; extra inline fixtures ${loaded.extensions.length - packedExtensions.length}; loader errors ${loaded.errors.length}; conflict path ${loaded.errors[0]?.path ?? 'none'}`);
  } finally {
    loader.getExtensions().runtime.invalidate();
  }
});
