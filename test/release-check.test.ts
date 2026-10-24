import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';

// The release checker is a plain .mjs script: load the real module through a
// computed specifier so the assertions below drive the shipped functions
// instead of a re-implementation of their predicates.
const checker: any = await import(new URL('../scripts/check-release.mjs', import.meta.url).href);
const run = promisify(execFile);
const SCRIPT_SOURCE = await readFile(new URL('../scripts/check-release.mjs', import.meta.url), 'utf8');

// Synthetic pollution values are assembled at runtime: this tracked test file is
// itself part of the repository the hygiene scan reads.
const FAKE_SECRET = ['sk', 'fixture'].join('-') + String(Date.now()).padEnd(24, '0');
const FAKE_HOME = ['', 'home', 'fixtureuser', 'projects', 'secret'].join('/');

const BASE_PACK_FILES = [
  'package.json',
  'README.md',
  'README.zh-CN.md',
  'LICENSE',
  'CHANGELOG.md',
  'docs/COMMUNICATION.md',
  'docs/RELEASING.md',
  'src/ui/index.ts',
];
const EXTENSIONS = ['./src/todos/index.ts', './src/plan/index.ts', './src/agents/index.ts', './src/goal/index.ts', './src/retry/index.ts', './src/team/index.ts'];

function manifestWith(extensions: unknown = EXTENSIONS): any {
  return {
    name: 'fixture-pkg',
    version: '1.2.3',
    license: 'MIT',
    keywords: ['pi-package'],
    files: ['src', 'README.md', 'README.zh-CN.md', 'LICENSE', 'CHANGELOG.md', 'docs'],
    repository: { type: 'git', url: 'git+https://github.com/example/fixture-pkg.git' },
    pi: { extensions },
  };
}

/** Packed path list a valid archive would contain for that manifest. */
function packedPaths(manifest: any, extra: string[] = []): string[] {
  const entries = (manifest.pi.extensions as string[]).map((entry) => entry.replace(/^\.\//, ''));
  return [...BASE_PACK_FILES, ...entries, ...extra];
}

test('checkPack rejects each of the six missing declared extensions independently', () => {
  const manifest = manifestWith();
  assert.deepEqual(checker.checkPack(packedPaths(manifest), manifest).errors, []);
  for (const entry of ['src/todos/index.ts', 'src/plan/index.ts', 'src/agents/index.ts', 'src/goal/index.ts', 'src/retry/index.ts', 'src/team/index.ts']) {
    const missing = checker.checkPack(packedPaths(manifest).filter((path) => path !== entry), manifest);
    assert.equal(missing.errors.length, 1, `missing ${entry} must be the only failure: ${JSON.stringify(missing.errors)}`);
    assert.equal(missing.errors[0], `packed tarball is missing declared extension ${entry}`);
  }
});

test('checkPack derives a newly declared entry instead of a fixed entry list', () => {
  const manifest = manifestWith([...EXTENSIONS, './src/extra/index.ts']);
  assert.deepEqual(checker.checkPack(packedPaths(manifest), manifest).errors, []);
  const missing = checker.checkPack(packedPaths(manifest).filter((path) => path !== 'src/extra/index.ts'), manifest);
  assert.equal(missing.errors.length, 1, `missing declared extra entry must be the only failure: ${JSON.stringify(missing.errors)}`);
  assert.equal(missing.errors[0], 'packed tarball is missing declared extension src/extra/index.ts');
});

test('checkPack rejects surrounding whitespace instead of silently changing a declared path', () => {
  const valid = manifestWith();
  assert.deepEqual(checker.checkPack(packedPaths(valid), valid).errors, [], 'ordinary ./ entries are valid');
  for (const declaration of [' ./src/team/index.ts', './src/team/index.ts ']) {
    const manifest = manifestWith([...EXTENSIONS.slice(0, -1), declaration]);
    assert.deepEqual(checker.checkPack(packedPaths(valid), manifest).errors, [
      'package.json pi.extensions[5] is not a relative file declaration',
    ], 'a packed canonical path cannot legitimize a different whitespace declaration');
  }
});

test('checkPack rejects absent or invalid extension declarations instead of passing an empty set', () => {
  const cases: Array<{ label: string; manifest: any }> = [
    { label: 'no pi block', manifest: { ...manifestWith(), pi: undefined } },
    { label: 'empty list', manifest: manifestWith([]) },
    { label: 'not an array', manifest: manifestWith('./src/todos/index.ts') },
    { label: 'non-string entry', manifest: manifestWith([...EXTENSIONS, 7]) },
    { label: 'absolute entry', manifest: manifestWith([...EXTENSIONS, '/etc/passwd']) },
    { label: 'parent traversal', manifest: manifestWith([...EXTENSIONS, '../outside/index.ts']) },
  ];
  for (const item of cases) {
    const result = checker.checkPack(packedPaths(manifestWith()), item.manifest);
    assert.equal(result.errors.length, 1, `${item.label} must be the only failure: ${JSON.stringify(result.errors)}`);
    assert.match(result.errors[0], /pi\.extensions/, item.label);
  }
});

test('checkMetadata accepts release metadata and rejects invalid release requirements independently', () => {
  assert.deepEqual(checker.checkMetadata(manifestWith()), { errors: [], warnings: [] });
  const cases = [
    { label: 'placeholder version', patch: { version: '0.0.0' }, error: 'package version must be a real release version (not 0.0.0)' },
    { label: 'malformed version', patch: { version: 'snapshot' }, error: 'package version must be a real release version (not 0.0.0)' },
    { label: 'license', patch: { license: 'UNLICENSED' }, error: 'package license must be MIT' },
    { label: 'private package', patch: { private: true }, error: 'package must not set private: true' },
    { label: 'required files', patch: { files: manifestWith().files.filter((path: string) => path !== 'docs') }, error: 'package files must include docs' },
    { label: 'package discovery', patch: { keywords: ['fixture'] }, error: 'package keywords must include pi-package' },
  ];
  for (const sample of cases) {
    assert.deepEqual(checker.checkMetadata({ ...manifestWith(), ...sample.patch }), {
      errors: [sample.error], warnings: [],
    }, `${sample.label} must be rejected without unrelated failures`);
  }
});

test('checkPack keeps the base files, the shared UI file, the docs allowlist and forbidden prefixes', () => {
  const manifest = manifestWith();
  assert.deepEqual(checker.checkPack(packedPaths(manifest).filter((path) => path !== 'src/ui/index.ts'), manifest).errors, ['packed tarball is missing src/ui/index.ts']);
  assert.deepEqual(checker.checkPack(packedPaths(manifest, ['docs/INTERNAL.md']), manifest).errors, ['packed tarball must not include extra docs file docs/INTERNAL.md']);
  assert.deepEqual(checker.checkPack(packedPaths(manifest, ['test/release-check.test.ts']), manifest).errors, ['packed tarball must not include test/release-check.test.ts']);
});

test('checkPack rejects representative private context, environment, log and dependency files', () => {
  const manifest = manifestWith();
  assert.deepEqual(checker.checkPack(packedPaths(manifest), manifest).errors, []);
  const cases = [
    { path: 'AGENTS.md', error: 'packed tarball must not include AGENTS.md' },
    { path: 'src/AGENTS.md', error: 'packed tarball must not include AGENTS.md' },
    { path: '.env', error: 'packed tarball must not include .env' },
    { path: 'src/.env.fixture', error: 'packed tarball must not include src/.env.fixture' },
    { path: 'src/events.jsonl', error: 'packed tarball must not include src/events.jsonl' },
    { path: 'node_modules/fixture/index.js', error: 'packed tarball must not include node_modules/fixture/index.js' },
  ];
  for (const sample of cases) {
    assert.deepEqual(checker.checkPack(packedPaths(manifest, [sample.path]), manifest).errors, [sample.error], `${sample.path} must be rejected as the sole invalid packed file`);
  }
});

function assertTextRule(rule: string, pollution: string, ordinary: string): void {
  assert.deepEqual(checker.scanText(`Ordinary fixture prose\n${pollution}`), [{ rule, line: 2 }], `${rule}: pollution must be located without unrelated findings`);
  assert.deepEqual(checker.scanText(`Ordinary fixture prose\n${ordinary}`), [], `${rule}: nearby ordinary text must remain allowed`);
}

test('scanText distinguishes private home paths from anonymous example paths', () => {
  assertTextRule('absolute-home-path', FAKE_HOME, '/home/example/projects/release');
});

test('scanText distinguishes serialized Windows home paths from application paths', () => {
  const pollution = ['C:', 'Users', 'fixtureuser', 'project'].join('\\\\');
  const ordinary = ['C:', 'ProgramData', 'fixture', 'project'].join('\\\\');
  assertTextRule('windows-home-path', pollution, ordinary);
});

test('scanText distinguishes namespaced private model literals from plain fixture names', () => {
  const pollution = ['model', " = 'fixture", '/primary', "'"].join('');
  assertTextRule('hardcoded-private-model-reference', pollution, "model = 'fixture'");
});

test('scanText distinguishes credential-shaped tokens from short fixture text', () => {
  assertTextRule('secret-token', FAKE_SECRET, ['sk', 'short'].join('-'));
});

test('scanText distinguishes private key blocks from public key prose', () => {
  const pollution = ['-----BEGIN', 'FIXTURE PRIVATE KEY-----'].join(' ');
  assertTextRule('private-key-block', pollution, '-----BEGIN PUBLIC KEY-----');
});

test('scanText distinguishes URL userinfo from an ordinary registry URL', () => {
  const pollution = 'https://' + ['fixture', 'password'].join(':') + '@example.com/path';
  assertTextRule('url-embedded-credentials', pollution, 'https://example.com/path');
});

test('scanText distinguishes a synthetic personal address from a documentation address', () => {
  const pollution = 'fixture@' + ['invalid', 'test'].join('.');
  assertTextRule('personal-email', pollution, 'fixture@example.com');
});

const FIXTURE_FILES: Record<string, string> = {
  'README.md': '# Fixture package\n',
  'README.zh-CN.md': '# 夹具包\n',
  'LICENSE': 'MIT\n',
  'CHANGELOG.md': '# Changelog\n',
  'docs/COMMUNICATION.md': '# Communication\n',
  'docs/RELEASING.md': '# Releasing\n',
  'src/todos/index.ts': 'export {};\n',
  'src/plan/index.ts': 'export {};\n',
  'src/agents/index.ts': 'export {};\n',
  'src/goal/index.ts': 'export {};\n',
  'src/retry/index.ts': 'export {};\n',
  'src/team/index.ts': 'export {};\n',
  'src/ui/index.ts': 'export {};\n',
};

async function git(cwd: string, args: string[]): Promise<void> {
  await run('git', ['-c', 'user.email=dev@example.com', '-c', 'user.name=Fixture', ...args], { cwd });
}

/** Isolated synthetic Git repository that the real CLI can run inside. */
async function makeRepo(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'release-check-'));
  const files: Record<string, string> = { ...FIXTURE_FILES, 'package.json': `${JSON.stringify(manifestWith(), null, 2)}\n`, 'scripts/check-release.mjs': SCRIPT_SOURCE };
  for (const [path, text] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), text);
  }
  await git(root, ['init', '-q']);
  await git(root, ['add', '-A']);
  await git(root, ['commit', '-qm', 'fixture baseline']);
  return root;
}

async function runCli(root: string, args: string[] = []): Promise<{ code: number; stdout: string; stderr: string }> {
  let result: { code: number; stdout: string; stderr: string };
  try {
    const { stdout, stderr } = await run(process.execPath, [join(root, 'scripts/check-release.mjs'), ...args], { cwd: root, timeout: 30_000 });
    result = { code: 0, stdout, stderr };
  } catch (error: any) {
    result = { code: Number(error?.code ?? NaN), stdout: String(error?.stdout ?? ''), stderr: String(error?.stderr ?? '') };
  }
  // Check both exits before any behavior assertion, including expected hygiene failures.
  assert.ok(Number.isInteger(result.code), 'the CLI must exit normally rather than fail to spawn or time out');
  assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /release check crashed:|SyntaxError:|ReferenceError:|TypeError:|ERR_MODULE_NOT_FOUND|could not run npm pack dry run:/, 'the CLI must reach the rule assertions without loading or pack errors');
  return result;
}

test('the CLI scans the checker itself in the working tree and never prints the matched value', async () => {
  const clean = await makeRepo();
  try {
    const cleanRun = await runCli(clean);
    assert.equal(cleanRun.code, 0, `clean definition must pass: ${cleanRun.stderr}`);
  } finally {
    await rm(clean, { recursive: true, force: true });
  }

  const polluted = await makeRepo();
  try {
    const scriptPath = join(polluted, 'scripts/check-release.mjs');
    const pollutionLine = SCRIPT_SOURCE.split('\n').length + 1;
    await writeFile(scriptPath, `${SCRIPT_SOURCE}\n// fixture marker ${FAKE_SECRET}\n`);
    const observed = await runCli(polluted);
    assert.equal(observed.code, 1, 'pollution inside the checker itself must fail the working-tree scan');
    assert.match(observed.stderr, new RegExp(`scripts/check-release\\.mjs:${pollutionLine} \\[secret-token\\]`));
    assert.ok(!observed.stderr.includes(FAKE_SECRET), 'stderr must not echo the matched value');
    assert.ok(!observed.stdout.includes(FAKE_SECRET), 'stdout must not echo the matched value');
  } finally {
    await rm(polluted, { recursive: true, force: true });
  }
});

test('the CLI scans the checker itself in history after the pollution left the working tree', async () => {
  const root = await makeRepo();
  try {
    const scriptPath = join(root, 'scripts/check-release.mjs');
    await writeFile(scriptPath, `${SCRIPT_SOURCE}\n// fixture marker ${FAKE_SECRET}\n`);
    await git(root, ['add', '-A']);
    await git(root, ['commit', '-qm', 'fixture polluted']);
    await writeFile(scriptPath, SCRIPT_SOURCE);
    await git(root, ['add', '-A']);
    await git(root, ['commit', '-qm', 'fixture cleaned']);

    const treeRun = await runCli(root);
    assert.equal(treeRun.code, 0, `current tree is clean: ${treeRun.stderr}`);
    const historyRun = await runCli(root, ['--history']);
    assert.equal(historyRun.code, 1, 'historical pollution inside the checker itself must fail the history scan');
    assert.match(historyRun.stderr, /history:scripts\/check-release\.mjs@[0-9a-f]{12}:\d+ \[secret-token\]/);
    assert.ok(!historyRun.stderr.includes(FAKE_SECRET), 'history findings must not echo the matched value');
    assert.ok(!historyRun.stdout.includes(FAKE_SECRET), 'history stdout must not echo the matched value');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('the CLI still catches ordinary files whose pollution only exists in history', async () => {
  const root = await makeRepo();
  try {
    const target = join(root, 'src/goal/index.ts');
    await writeFile(target, `export const home = '${FAKE_HOME}';\n`);
    await git(root, ['add', '-A']);
    await git(root, ['commit', '-qm', 'fixture polluted']);
    await writeFile(target, 'export {};\n');
    await git(root, ['add', '-A']);
    await git(root, ['commit', '-qm', 'fixture cleaned']);

    const treeRun = await runCli(root);
    assert.equal(treeRun.code, 0, `current tree is clean: ${treeRun.stderr}`);
    const historyRun = await runCli(root, ['--history']);
    assert.equal(historyRun.code, 1, 'historical pollution in an ordinary file must fail the history scan');
    assert.match(historyRun.stderr, /history:src\/goal\/index\.ts@[0-9a-f]{12}:1 \[absolute-home-path\]/);
    assert.ok(!historyRun.stderr.includes(FAKE_HOME), 'history findings must not echo the matched value');
    assert.ok(!historyRun.stdout.includes(FAKE_HOME), 'ordinary history stdout must not echo the matched value');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
