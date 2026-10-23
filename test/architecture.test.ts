import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { parse } from '@babel/parser';

test('U7 panel paths contain zero native dialogs; only two guarded non-TUI call sites live in menu.ts', () => {
  const files = ['todos/commands/register.ts', 'plan/commands/register.ts', 'goal/commands/register.ts', 'agents/commands/register.ts', 'retry/commands/menu.ts', 'shared/ui/panel.ts', 'workflow/commands/view.ts', 'shared/ui/menu.ts'];
  for (const file of files) {
    const source = readFileSync(new URL(`../src/${file}`, import.meta.url), 'utf8'), ast = parse(source, { sourceType: 'module', plugins: ['typescript'] });
    let calls = 0;
    const visit = (node: any) => {
      if (!node || typeof node !== 'object') return;
      if (node.type === 'CallExpression' && node.callee.type === 'MemberExpression' && node.callee.object.type === 'MemberExpression' && node.callee.object.object.name === 'ctx' && node.callee.object.property.name === 'ui' && (node.callee.computed || ['select', 'confirm', 'input', 'editor'].includes(node.callee.property.name))) calls++;
      for (const value of Object.values(node)) if (Array.isArray(value)) value.forEach(visit); else if (value && typeof value === 'object' && 'type' in value) visit(value);
    };
    // menu.ts owns the only native dialogs: one input/editor/confirm per text-client path (the projected
    // chooser and the dialog helper). TUI paths never reach them.
    visit(ast); assert.equal(calls, file === 'shared/ui/menu.ts' ? 4 : 0, file);
    if (file === 'shared/ui/menu.ts') { assert.match(source, /ctx\.mode === 'tui'\) return undefined/); assert.match(source, /if \(ctx\.mode === 'tui' \|\| !current\(options\)\) return undefined/); }
  }
});

test('ticket01 construction: module panel values never supply square-bracket decoration', () => {
  const literals = (node: any): string[] => {
    if (!node) return [];
    if (node.type === 'StringLiteral') return [node.value];
    if (node.type === 'TemplateLiteral') return [...node.quasis.map((part: any) => part.value.cooked ?? ''), ...node.expressions.flatMap(literals)];
    if (node.type === 'BinaryExpression' || node.type === 'LogicalExpression') return [...literals(node.left), ...literals(node.right)];
    if (node.type === 'ConditionalExpression') return [...literals(node.consequent), ...literals(node.alternate)];
    if (node.type === 'CallExpression') return node.arguments.flatMap(literals);
    if (node.type === 'ArrayExpression') return node.elements.flatMap(literals);
    if (node.type === 'ObjectExpression') return node.properties.filter((part: any) => part.type === 'ObjectProperty' && (part.key.name ?? part.key.value) === 'text').flatMap((part: any) => literals(part.value));
    return [];
  };
  const decorated: string[] = [];
  for (const file of Object.keys(layers).filter(file => file.includes('/commands/'))) {
    const ast = parse(readFileSync(new URL(`../src/${file}`, import.meta.url), 'utf8'), { sourceType: 'module', plugins: ['typescript'] });
    const visit = (node: any) => {
      if (!node || typeof node !== 'object') return;
      if (node.type === 'ObjectProperty' && ['value', 'values'].includes(node.key.name ?? node.key.value) && literals(node.value).some(text => /[\[\]]/.test(text))) decorated.push(`${file}:${node.loc.start.line}`);
      for (const value of Object.values(node)) if (Array.isArray(value)) value.forEach(visit); else if (value && typeof value === 'object' && 'type' in value) visit(value);
    };
    visit(ast);
  }
  assert.deepEqual(decorated, [], 'brackets belong to the dotted-column renderer, not module row construction');
});

test('ticket01 actionable-copy sweep covers source and runtime scripts without vague inspection prompts', () => {
  const hits: string[] = [];
  for (const directory of ['src', 'scripts']) {
    const root = fileURLToPath(new URL(`../${directory}/`, import.meta.url));
    for (const entry of readdirSync(root, { recursive: true, withFileTypes: true }).filter(entry => entry.isFile() && /\.[cm]?[jt]s$/.test(entry.name))) {
      const path = resolve(entry.parentPath, entry.name), source = readFileSync(path, 'utf8');
      if (/请(?:检查|查看|设置|确认)/.test(source)) hits.push(`${directory}/${relative(root, path)}`);
    }
  }
  assert.deepEqual(hits, [], 'test fixtures are outside runtime roots; production has no copy whitelist');
});

test('production code never writes debug output to a user terminal', () => {
  // A stray `console.error('DEBUG …')` reached every text-client pick once. Panels render through Pi, so the
  // only writer allowed here is the framework's own error channel.
  const hits: string[] = [];
  for (const entry of readdirSync(fileURLToPath(new URL('../src/', import.meta.url)), { recursive: true, withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.ts')) continue;
    const source = readFileSync(resolve(entry.parentPath, entry.name), 'utf8');
    if (/console\.(?:log|error|debug|warn)\(/.test(source)) hits.push(entry.name);
  }
  assert.deepEqual(hits, [], 'a panel reports through ctx.ui.notify, never through the terminal');
});

test('ticket02 single Job/Profile submenus exist only behind a non-TUI guard', () => {
  const source = readFileSync(new URL('../src/agents/commands/register.ts', import.meta.url), 'utf8');
  const ast = parse(source, { sourceType: 'module', plugins: ['typescript'] }), unguarded: number[] = [];
  let guarded = 0;
  const visit = (node: any, ancestors: any[] = []) => {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'CallExpression' && node.callee.name === 'panel' && node.arguments[0]?.type === 'TemplateLiteral' && /^(job|profile):/.test(node.arguments[0].quasis[0]?.value.cooked ?? '')) {
      const condition = ancestors.find(parent => parent.type === 'ConditionalExpression' && /ctx\.mode !== 'tui'/.test(source.slice(parent.test.start, parent.test.end)) && node.start >= parent.consequent.start && node.end <= parent.consequent.end);
      if (condition) guarded++; else unguarded.push(node.loc.start.line);
    }
    for (const value of Object.values(node)) if (Array.isArray(value)) value.forEach(child => visit(child, [...ancestors, node])); else if (value && typeof value === 'object' && 'type' in value) visit(value, [...ancestors, node]);
  };
  visit(ast); assert.deepEqual(unguarded, []); assert.equal(guarded, 2, 'the two text-client fallbacks remain');
  assert.doesNotMatch(source, /\^job:|\^profile:|startsWith\(`(?:job|profile):/);
  for (const file of ['todos/commands/register.ts', 'plan/commands/register.ts', 'goal/commands/register.ts', 'agents/commands/register.ts', 'retry/commands/menu.ts']) {
    const module = readFileSync(new URL(`../src/${file}`, import.meta.url), 'utf8');
    assert.doesNotMatch(module, /\^task:|\^goal:|\.kind\s*(?:===|!==)|switch\s*\([^)]*\.kind/, `${file}: modules execute declared operations rather than decode Enter from ids or row kind`);
  }
});

type Layer = 'commands' | 'domain' | 'io';
const layers: Record<string, Layer> = {
  'agents/commands/child.ts': 'commands',
  'agents/commands/register.ts': 'commands',
  'agents/domain/context.ts': 'domain',
  'agents/domain/diagnostics.ts': 'domain',
  'agents/domain/owner.ts': 'domain',
  'agents/domain/profiles.ts': 'domain',
  'agents/domain/runtime.ts': 'domain',
  'agents/domain/schema.ts': 'domain',
  'agents/index.ts': 'commands',
  'agents/io/contracts.ts': 'io',
  'agents/io/host.ts': 'io',
  'agents/io/notices.ts': 'io',
  'agents/io/persistence.ts': 'io',
  'agents/io/process.ts': 'io',
  'agents/io/profile-file.ts': 'io',
  'agents/io/skills.ts': 'io',
  'goal/commands/register.ts': 'commands',
  'goal/domain/failure.ts': 'domain',
  'goal/domain/owner.ts': 'domain',
  'goal/domain/policy.ts': 'domain',
  'goal/domain/prompt.ts': 'domain',
  'goal/domain/state.ts': 'domain',
  'goal/index.ts': 'commands',
  'goal/io/host.ts': 'io',
  'plan/commands/register.ts': 'commands',
  'plan/domain/owner.ts': 'domain',
  'plan/domain/policy.ts': 'domain',
  'plan/domain/state.ts': 'domain',
  'plan/index.ts': 'commands',
  'plan/io/records.ts': 'io',
  'retry/commands/menu.ts': 'commands',
  'retry/commands/register.ts': 'commands',
  'retry/domain/owner.ts': 'domain',
  'retry/domain/state.ts': 'domain',
  'retry/index.ts': 'commands',
  'retry/io/host.ts': 'io',
  'shared/agent-view.ts': 'domain',
  'shared/completion.ts': 'commands',
  'shared/config-file.ts': 'io',
  'shared/config.ts': 'domain',
  'shared/dag/cache.ts': 'domain',
  'shared/dag/graph.ts': 'domain',
  'shared/dag/layout.ts': 'domain',
  'shared/goal-view.ts': 'domain',
  'shared/i18n.ts': 'domain',
  'shared/message-types.ts': 'domain',
  'shared/profile-launch.ts': 'domain',
  'shared/messages.en.ts': 'domain',
  'shared/passive-message.ts': 'io',
  'shared/pi-cli.ts': 'io',
  'shared/state-types.ts': 'domain',
  'shared/task-schema.ts': 'domain',
  'shared/task-types.ts': 'domain',
  'shared/terminal.ts': 'io',
  'shared/tool-info.ts': 'domain',
  'shared/ui/filter.ts': 'domain',
  'shared/ui/menu.ts': 'commands',
  'shared/ui/panel.ts': 'commands',
  'shared/ui/presentation.ts': 'commands',
  'shared/ui/render-cache.ts': 'commands',
  'shared/ui/render.ts': 'commands',
  'shared/ui/symbols.ts': 'domain',
  'team/commands/bootstrap.ts': 'commands',
  'team/commands/controls.ts': 'commands',
  'team/commands/history.ts': 'commands',
  'team/commands/menu.ts': 'commands',
  'team/commands/register.ts': 'commands',
  'team/domain/teams.ts': 'domain',
  'team/domain/inbox.ts': 'domain',
  'team/domain/launcher.ts': 'domain',
  'team/domain/lifecycle.ts': 'domain',
  'team/io/inbox.ts': 'domain',
  'team/io/lock.ts': 'domain',
  'team/io/sid-lock.ts': 'domain',
  'team/io/sid-session.ts': 'domain',
  'team/io/runtime.ts': 'domain',
  'team/io/session-tail.ts': 'domain',
  'team/io/session-activity.ts': 'domain',
  'team/io/session-history.ts': 'domain',
  'team/io/session-delete.ts': 'domain',
  'team/io/launcher.ts': 'domain',
  'team/index.ts': 'commands',
  'team/io/registry.ts': 'domain', // registry owns fs IO for its own data shape; the layer name only gates imports
  'todos/commands/checkpoints.ts': 'commands',
  'todos/commands/register.ts': 'commands',
  'todos/domain/checkpoint-state.ts': 'domain',
  'todos/domain/checkpoint-summary.ts': 'domain',
  'todos/domain/cleanup.ts': 'domain',
  'todos/domain/owner.ts': 'domain',
  'todos/domain/presets.ts': 'domain',
  'todos/domain/state.ts': 'domain',
  'todos/index.ts': 'commands',
  'todos/io/records.ts': 'io',
  'ui/index.ts': 'commands',
  'workflow/commands/connect.ts': 'commands',
  'workflow/commands/view.ts': 'commands',
  'workflow/domain/features.ts': 'domain',
  'workflow/domain/view-owner.ts': 'domain',
  'workflow/domain/view-state.ts': 'domain',
  'workflow/index.ts': 'commands',
  'workflow/io/session.ts': 'io',
};

// D3/D4 逐批缩小至空。Each entry names the exact rule, files and import kind.
const allowedViolations: string[] = [];

test('source imports respect the three layers and module boundaries outside the explicit baseline', () => {
  const root = fileURLToPath(new URL('../src/', import.meta.url));
  const files = readdirSync(root, { recursive: true, withFileTypes: true }).filter(entry => entry.isFile() && entry.name.endsWith('.ts')).map(entry => relative(root, resolve(entry.parentPath, entry.name)).replaceAll('\\', '/')).sort();
  assert.deepEqual(files, Object.keys(layers).sort(), 'every source file must have exactly one layer');
  const rank = { commands: 0, domain: 1, io: 2 };
  const violations: string[] = [];
  for (const file of files) {
    const source = readFileSync(resolve(root, file), 'utf8');
    const ast = parse(source, { sourceType: 'module', plugins: ['typescript'] });
    const check = (specifier: string, kind: string) => {
      if (!specifier.startsWith('.')) return;
      const target = relative(root, resolve(root, dirname(file), specifier)).replaceAll('\\', '/');
      assert.ok(Object.hasOwn(layers, target), `${file}: unmapped import ${target}`);
      const edge = `${file} -> ${target} [${kind}]`;
      if (rank[layers[file]!] > rank[layers[target]!]) violations.push(`layer: ${edge}`);
      if (file.startsWith('shared/') && ['todos', 'plan', 'goal', 'agents', 'retry'].includes(target.split('/')[0]!)) violations.push(`shared: ${edge}`);
      if (!file.startsWith('shared/') && !target.startsWith('shared/') && !file.endsWith('/index.ts') && !target.endsWith('/index.ts') && file.split('/')[0] !== target.split('/')[0]) violations.push(`module: ${edge}`);
    };
    const walk = (node: unknown): void => {
      if (!node || typeof node !== 'object') return;
      if (Array.isArray(node)) { node.forEach(walk); return; }
      const item = node as Record<string, any>;
      if (['ImportDeclaration', 'ExportNamedDeclaration', 'ExportAllDeclaration'].includes(item.type) && item.source) check(item.source.value, item.importKind === 'type' || item.exportKind === 'type' || item.specifiers?.length && item.specifiers.every((value: any) => value.importKind === 'type' || value.exportKind === 'type') ? 'type' : 'value');
      if (item.type === 'CallExpression' && item.callee.type === 'Import') { assert.equal(item.arguments[0]?.type, 'StringLiteral', `${file}: dynamic imports must be literal`); check(item.arguments[0].value, 'dynamic'); }
      if (item.type === 'TSImportType') { assert.equal(item.argument?.type, 'StringLiteral'); check(item.argument.value, 'type'); }
      for (const [key, value] of Object.entries(item)) if (!['loc', 'extra', 'comments'].includes(key)) walk(value);
    };
    walk(ast.program);
  }
  assert.deepEqual(violations.sort(), [...allowedViolations].sort(), 'new violations are forbidden; remove resolved baseline entries');

  // Pure configuration, policy, selection and UI projections; panel frames are the U1 exception.
  const allowedInternalTests = ['config.test.ts', 'goal-policy.test.ts', 'prompt-guidance.test.ts', 'retry-models.test.ts', 'team-delete.test.ts', 'team-history.test.ts', 'team-inbox-sdk.test.ts', 'team-inbox.test.ts', 'team-inspect.test.ts', 'team-panel.test.ts', 'team-rebuild.test.ts', 'team-session-dir.test.ts', 'team-shrink.test.ts', 'team-sid-lock.test.ts', 'team.test.ts', 'ui-child-floor.test.ts', 'ui-graph.test.ts', 'ui-panel.test.ts', 'ui-projection.test.ts', 'ui-render.test.ts', 'workflow-flow.test.ts'];
  const testRoot = fileURLToPath(new URL('./', import.meta.url));
  const internalTests = new Set<string>();
  const fixtureViolations: string[] = [];
  const testFiles = readdirSync(testRoot, { recursive: true, withFileTypes: true }).filter(entry => entry.isFile() && (entry.name.endsWith('.test.ts') || relative(testRoot, entry.parentPath).split(/[\\/]/)[0] === 'fixtures') && /\.[cm]?[jt]s$/.test(entry.name));
  for (const entry of testFiles) {
    const path = resolve(entry.parentPath, entry.name);
    const file = relative(testRoot, path).replaceAll('\\', '/');
    const ast = parse(readFileSync(path, 'utf8'), { sourceType: 'module', plugins: ['typescript'] });
    const check = (specifier: string) => {
      if (!specifier.startsWith('.')) return;
      const target = relative(root, resolve(dirname(path), specifier)).replaceAll('\\', '/');
      if (target.startsWith('../') || /^(todos|plan|agents|goal|retry|team)\/index\.ts$/.test(target)) return;
      if (file.startsWith('fixtures/')) fixtureViolations.push(`${file} -> ${target}`);
      else internalTests.add(file);
    };
    const walk = (node: unknown): void => {
      if (!node || typeof node !== 'object') return;
      if (Array.isArray(node)) { node.forEach(walk); return; }
      const item = node as Record<string, any>;
      if (['ImportDeclaration', 'ExportNamedDeclaration', 'ExportAllDeclaration'].includes(item.type) && item.source) check(item.source.value);
      if (item.type === 'CallExpression' && item.callee.type === 'Import' && item.arguments[0]?.type === 'StringLiteral') check(item.arguments[0].value);
      if (item.type === 'TSImportType' && item.argument?.type === 'StringLiteral') check(item.argument.value);
      for (const [key, value] of Object.entries(item)) if (!['loc', 'extra', 'comments'].includes(key)) walk(value);
    };
    walk(ast.program);
  }
  assert.deepEqual([...internalTests].sort(), allowedInternalTests, 'behavior tests must use public entries; remove resolved pure-function exceptions');
  assert.deepEqual(fixtureViolations, [], 'fixtures must not hide imports of source internals');
});

test('ticket04b directory rows are counted exactly and no label ends with the truncation marker', () => {
  const file = (module: string) => `../src/${module}/commands/${module === 'retry' ? 'menu' : 'register'}.ts`;
  const count = (module: string) => (readFileSync(new URL(file(module), import.meta.url), 'utf8').match(/kind: 'directory'/g) ?? []).length;
  // The user replaced short-menu subscreens with inline entities. Long browse lists stay screens: the
  // dependency graph, the model catalog, and Agents' non-TUI Profile fallback.
  const teamCount = (readFileSync(new URL('../src/team/commands/menu.ts', import.meta.url), 'utf8').match(/kind: 'directory'/g) ?? []).length;
  assert.deepEqual({ plan: count('plan'), goal: count('goal'), todos: count('todos'), retry: count('retry'), agents: count('agents'), team: teamCount },
    { plan: 0, goal: 0, todos: 1, retry: 0, agents: 2, team: 0 });
  // No new short-menu directory families are introduced.
  const all = (readdirSync(new URL('../src', import.meta.url), { recursive: true }) as string[]).filter(name => name.endsWith('.ts'))
    .filter(name => /kind: 'directory'/.test(readFileSync(new URL(`../src/${name}`, import.meta.url), 'utf8'))).sort();
  assert.deepEqual(all, ['agents/commands/register.ts', 'todos/commands/register.ts']);
  const panel = readFileSync(new URL('../src/shared/ui/panel.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(panel, /keepLabel/, 'the identity clamp is gone');
  assert.doesNotMatch(panel, /directory[^\n]{0,40}' ›'/, 'directory rows carry no tail marker');
  // `…` is a truncation marker only: no quoted string may end with it (the marker literal is the exception).
  // Scanning every literal also covers `const add = msg('…')` used as a label later.
  const files = (readdirSync(new URL('../src', import.meta.url), { recursive: true }) as string[]).filter(name => name.endsWith('.ts'));
  for (const name of files) {
    const text = readFileSync(new URL(`../src/${name}`, import.meta.url), 'utf8');
    for (const literal of text.matchAll(/(['"])((?:\\.|(?!\1)[^\\\n])*)\1/g)) {
      const value = literal[2]!;
      assert.ok(value === '…' || !/…\s*$/.test(value), `${name}: ${JSON.stringify(value)} must not end with the truncation marker`);
    }
  }
  // /todos keeps fragment entries for text clients, mirroring /agents keeping its Profile row.
  const todos = readFileSync(new URL('../src/todos/commands/register.ts', import.meta.url), 'utf8');
  const textItems = /const items = ctx\.mode === 'tui' \? \[\] : \[([\s\S]*?)\n      \];/.exec(todos)?.[1] ?? '';
  assert.match(textItems, /preset:\$\{preset\.name\}/, 'text clients list every fragment');
  assert.match(textItems, /preset:\$\{preset\.name\}\/apply/, 'text clients can apply a fragment');
});

test('ticket04c childExtensions lives only on Profile and the machine-wide key is gone', () => {
  const config = readFileSync(new URL('../src/shared/config.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(config, /childExtensions\?:/, 'the machine-wide config type has no childExtensions');
  assert.doesNotMatch(config, /key === 'childExtensions'/, 'the parser no longer accepts the machine-wide key');
  assert.doesNotMatch(config, /writeConfig\(\{ childExtensions/, 'the writer has no machine-wide childExtensions call');
  const agents = readFileSync(new URL('../src/agents/commands/register.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(agents, /writeConfig\(|loadConfig\(/, 'the menu never writes the machine-wide config');
  const profiles = readFileSync(new URL('../src/agents/domain/profiles.ts', import.meta.url), 'utf8');
  assert.match(profiles, /exactKeys\(record, \["name", "model", "thinking", "tools", "skills", "instructions", "childExtensions", "isolate"\]\)/, 'Profile whitelists childExtensions and the optional isolate flag');
  assert.match(profiles, /validateChildExtensions\(/, 'Profile validates the extension list');
  const runtime = readFileSync(new URL('../src/agents/domain/runtime.ts', import.meta.url), 'utf8');
  assert.match(runtime, /this\.options\.getChildExtensions\(profile\)/, 'spawn resolves extensions from the dispatched profile');
  assert.doesNotMatch(runtime, /getChildExtensions\(\)/, 'spawn never falls back to a machine-wide list');
});

test('ticket05 every glyph comes from the symbol table and no source file carries private-use codepoints', () => {
  const root = fileURLToPath(new URL('../src/', import.meta.url));
  const files = (readdirSync(root, { recursive: true }) as string[]).filter(name => name.endsWith('.ts')).sort();
  const privateUse = /[\ue000-\uf8ff]|[\u{f0000}-\u{ffffd}]/u;
  const escaped = /\\u\{(?:f[0-9a-f]{4}|ffffd)\}/i;
  for (const name of files) {
    const source = readFileSync(resolve(root, name), 'utf8');
    if (name === 'shared/ui/symbols.ts') continue;
    assert.doesNotMatch(source, privateUse, `${name} must not embed private-use glyphs`);
    assert.doesNotMatch(source, escaped, `${name} must not embed Plane-15 escapes`);
  }
  const panel = readFileSync(new URL('../src/shared/ui/panel.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(panel, /panelIcons/, 'the old glyph constant is gone');
  // Known bad glyphs from the audit: BMP coffee glyph and the Plane-15 set used before the table.
  for (const codepoint of [0xf0c0, 0xf0279, 0xf04fe, 0xf03eb, 0xf012c, 0xf0954, 0xf04e6, 0xf02d7, 0xf09d1, 0xf018d, 0xf0415, 0xf01b4]) {
    const glyph = String.fromCodePoint(codepoint);
    for (const name of files) {
      if (name === 'shared/ui/symbols.ts') continue;
      assert.equal(readFileSync(resolve(root, name), 'utf8').includes(glyph), false, `${name} still contains U+${codepoint.toString(16).toUpperCase()}`);
    }
  }
  // The table is the single source: every key carries both renderings and plain is private-use free.
  // Parse line by line instead of matching complete entries: a missing `plain` must fail, not vanish.
  const table = readFileSync(new URL('../src/shared/ui/symbols.ts', import.meta.url), 'utf8');
  const body = table.slice(table.indexOf('export const SYMBOLS = {'), table.indexOf('} as const satisfies'));
  const keyPattern = /^ {2}(?:'([^']+)'|([\w-]+)):\s*\{/gm;
  const keys = [...body.matchAll(keyPattern)];
  assert.equal(keys.length, 75, 'the symbol table keeps its 75 entries (update this number with the table)');
  const escapedPlain = /\\u\{f[0-9a-f]{4}\}|\\u\{ffffd\}/i;
  let parsed = 0;
  for (const match of body.split('\n')) {
    if (!/^ {2}(?:'[^']+'|[\w-]+):\s*\{/.test(match)) continue;
    parsed += 1;
    assert.match(match, /\bnerd:\s*'[^']*'/, `missing nerd rendering: ${match.trim()}`);
    assert.match(match, /\bplain:\s*'[^']*'/, `missing plain rendering: ${match.trim()}`);
    const nerd = /\bnerd:\s*'([^']*)'/.exec(match)![1]!;
    const plain = /\bplain:\s*'([^']*)'/.exec(match)![1]!;
    assert.notEqual(nerd, '', 'every symbol has a Nerd Font rendering');
    assert.doesNotMatch(plain, privateUse, `plain renderings never carry private-use glyphs: ${match.trim()}`);
    assert.doesNotMatch(plain, escapedPlain, `plain renderings never use a private-use escape: ${match.trim()}`);
  }
  assert.equal(parsed, keys.length, 'every table key is a complete { nerd, plain } entry');
});

test('ticket06 business panels no longer own widget visibility toggles', () => {
  for (const file of ['plan/commands/register.ts', 'goal/commands/register.ts', 'retry/commands/menu.ts', 'agents/commands/register.ts', 'todos/commands/register.ts']) {
    const source = readFileSync(new URL(`../src/${file}`, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /显示摘要|Show summary/, `${file} must not render a summary toggle`);
    assert.doesNotMatch(source, /id: 'summary'/, `${file} must not keep a summary row`);
  }
  const workflow = readFileSync(new URL('../src/workflow/index.ts', import.meta.url), 'utf8');
  assert.match(workflow, /id: 'display'/, 'the Display panel lives in the workflow layer');
  assert.match(workflow, /anyModule\(\)/, 'Display appears whenever any module is enabled');
});

test('ticket07 numeric settings reuse the single config writer', () => {
  const configFile = readFileSync(new URL('../src/shared/config-file.ts', import.meta.url), 'utf8');
  assert.equal((configFile.match(/export async function writeWorkflowConfig\(/g) ?? []).length, 1, 'one config writer definition');
  const config = readFileSync(new URL('../src/shared/config.ts', import.meta.url), 'utf8');
  assert.equal((config.match(/writeWorkflowConfig\(/g) ?? []).length, 1, 'writeConfig is the only caller of the writer');
  const allowed = ['shared/config.ts', 'goal/commands/register.ts', 'plan/commands/register.ts', 'team/commands/register.ts', 'workflow/index.ts'];
  const root = fileURLToPath(new URL('../src/', import.meta.url));
  for (const file of (readdirSync(root, { recursive: true }) as string[]).filter(name => name.endsWith('.ts'))) {
    const source = readFileSync(resolve(root, file), 'utf8');
    if (file !== 'shared/config-file.ts' && source.includes('writeWorkflowConfig(')) assert.equal(file, 'shared/config.ts', `${file} must not add a second writer path`);
    if (source.includes('writeConfig(')) assert.ok(allowed.includes(file), `${file} must use shared writeConfig only`);
  }
});

test('ticket17 the symbol table declares no BMP private-use codepoints', () => {
  const table = readFileSync(new URL('../src/shared/ui/symbols.ts', import.meta.url), 'utf8');
  const body = table.slice(table.indexOf('export const SYMBOLS = {'), table.indexOf('} as const satisfies'));
  const entries = [...body.matchAll(/^ {2}(?:'([^']+)'|([\w-]+)):\s*\{ nerd: '(.*?)', plain: '(.*?)' \},$/gm)].map(match => ({ name: match[1] ?? match[2]!, nerd: match[3]!, plain: match[4]! }));
  assert.ok(entries.length >= 75, `the scan reads the whole table (${entries.length})`);
  // BMP private use (E000–F8FF) is stripped by the engine's text sanitiser in both modes, so a symbol
  // declared there can never render; Plane-15 (F0000–FFFFD) is the only valid icon range.
  const bmp = /[\ue000-\uf8ff]/u, bmpEscape = /\\u\{[e-f][0-9a-f]{3}\}|\\u[e-f][0-9a-f]{3}(?![0-9a-f])/i;
  for (const entry of entries) {
    assert.doesNotMatch(entry.nerd, bmp, `${entry.name} nerd glyph sits outside the BMP private-use block`);
    assert.doesNotMatch(entry.nerd, bmpEscape, `${entry.name} nerd glyph is not written as a BMP escape`);
    assert.doesNotMatch(entry.plain, bmp, `${entry.name} plain glyph is printable text`);
  }
  // The group glyph moved to md-account_multiple_outline, a sibling of the Agents family.
  const group = entries.find(entry => entry.name === 'group')!;
  assert.equal(group.nerd, '\\u{f000f}', 'group is U+F000F');
  assert.notEqual(group.nerd, '\\u{f0c0}', 'group is no longer the BMP codepoint');
});

test('ticket15 message custom types are dot-segmented, defined once, and never state keys', () => {
  const root = fileURLToPath(new URL('../src/', import.meta.url));
  const files = (readdirSync(root, { recursive: true }) as string[]).filter(name => name.endsWith('.ts')).sort();
  const messageTypes = ['pi-dag-workflow.agents.report', 'pi-dag-workflow.goal.retry', 'pi-dag-workflow.goal.continue', 'pi-dag-workflow.retry.request', 'pi-dag-workflow.team.message', 'pi-dag-workflow.team.membership'];
  const stateKeys = ['pi-dag-workflow.state', 'pi-dag-workflow.plan', 'pi-dag-workflow.goal', 'pi-dag-workflow.retry', 'pi-dag-workflow.view', 'pi-dag-workflow.checkpoint', 'pi-dag-workflow.goal-checkpoint', 'pi-dag-workflow.team-pointer'];
  const shaped = /^pi-dag-workflow\.[a-z]+(?:\.[a-z]+)?$/;
  for (const file of files) {
    const source = readFileSync(resolve(root, file), 'utf8');
    assert.doesNotMatch(source, /team-message|team-membership/, `${file} carries no bare message name`);
    // Every literal custom type is dot-segmented; the hyphenated ones may only be persisted state keys.
    for (const match of source.matchAll(/customType:\s*['"]([^'"]+)['"]/g)) {
      const value = match[1]!;
      assert.match(value, shaped, `${file} custom type ${value} is plugin.module[.info]`);
      assert.ok(!value.includes('-'), `${file} custom type ${value} carries no hyphen`);
    }
    for (const key of messageTypes) if (file !== 'shared/message-types.ts') assert.equal(source.includes(key), false, `${file} must import ${key} instead of writing it`);
  }
  // The state keys are untouched: they are still the persisted names the plugin reads and writes.
  const all = files.map(file => readFileSync(resolve(root, file), 'utf8')).join('\n');
  for (const key of stateKeys) assert.ok(all.includes(key), `${key} stays a persisted state key`);
  const declared = readFileSync(new URL('../src/shared/message-types.ts', import.meta.url), 'utf8');
  for (const key of messageTypes) assert.equal((declared.match(new RegExp(key.replaceAll('.', '\\.'), 'g')) ?? []).length, 1, `${key} is defined once`);
});

test('ticket18 every module menu exits on a closed panel before its inline-handled branch', () => {
  const modules = ['todos/commands/register.ts', 'plan/commands/register.ts', 'agents/commands/register.ts', 'goal/commands/register.ts', 'retry/commands/menu.ts', 'team/commands/menu.ts'];
  for (const file of modules) {
    const source = readFileSync(new URL(`../src/${file}`, import.meta.url), 'utf8');
    const exit = source.search(/if \([^\n]*selected === undefined[^\n]*\) (?:return|break);/);
    const inline = source.search(/if \(cursor\.handled\) continue;/);
    assert.ok(exit >= 0, `${file} has an undefined-exit branch`);
    assert.ok(inline >= 0, `${file} has an inline-handled branch`);
    assert.ok(exit < inline, `${file} must exit on a closed panel before it can loop on handled`);
  }
  // The engine clears the flag on entry and reports a closed panel to the caller.
  const menu = readFileSync(new URL('../src/shared/ui/menu.ts', import.meta.url), 'utf8');
  assert.match(menu, /if \(cursor\) \{ delete cursor\.handled; delete cursor\.closed; \}/, 'panelChoose clears the flag on entry');
  assert.match(menu, /if \(closed\) \{ delete cursor\.handled; cursor\.closed = true; \}/, 'a closed panel clears the flag and says so');
  assert.match(menu, /const gone = result\.action === 'closed' \|\| result\.action === 'stale';/, 'a disposed component is recognised');
});

test('ticket13 every dockable panel row carries an icon except the documented exemptions', () => {
  const root = fileURLToPath(new URL('../src/', import.meta.url));
  // The panel engine synthesises its own rows ($dialog, $confirm, the inline input, the divisor);
  // `heading` rows get the fold glyph from the engine; `band` rows are the information band, which
  // shares the entity gutter by design and is deliberately icon-free.
  const panelKinds = new Set(['entity', 'toggle', 'cycle', 'input', 'directory', 'action', 'readonly']);
  const missing: string[] = [];
  for (const file of (readdirSync(root, { recursive: true }) as string[]).filter(name => name.endsWith('.ts')).sort()) {
    if (file.startsWith('shared/ui/')) continue;
    const source = readFileSync(resolve(root, file), 'utf8');
    if (!source.includes('kind:')) continue;
    const ast = parse(source, { sourceType: 'module', plugins: ['typescript'] });
    const walk = (node: any) => {
      if (!node || typeof node !== 'object') return;
      if (node.type === 'ObjectExpression') {
        const property = (name: string) => node.properties.find((entry: any) => entry.type === 'ObjectProperty' && !entry.computed && (entry.key.name ?? entry.key.value) === name);
        const kind = property('kind');
        // `kind: 'cycle' as const` wraps the literal, so unwrap the assertion before reading it.
        const literal = kind?.value?.type === 'TSAsExpression' ? kind.value.expression : kind?.value;
        const value = literal?.type === 'StringLiteral' ? literal.value as string : undefined;
        // Only panel rows count: `kind` is also used for message kinds elsewhere.
        // `{ ...row, kind }` rows inherit their icon from the spread source; a conditional
        // `...(flag ? {a} : {})` spread only adds optional props and must not exempt the row.
        const spread = node.properties.some((entry: any) => entry.type === 'SpreadElement' && entry.argument?.type === 'Identifier');
        if (value && panelKinds.has(value) && !property('icon') && !property('band') && !spread) missing.push(`${file}:${node.loc.start.line} ${value}`);
      }
      for (const entry of Object.values(node)) if (Array.isArray(entry)) entry.forEach(walk); else if (entry && typeof entry === 'object' && 'type' in entry) walk(entry);
    };
    walk(ast.program);
  }
  assert.deepEqual(missing, [], 'every dockable row has an icon');
  for (const file of ['team/commands/menu.ts', 'goal/commands/register.ts', 'todos/commands/register.ts', 'agents/commands/register.ts', 'retry/commands/menu.ts', 'plan/commands/register.ts', 'workflow/index.ts']) {
    const source = readFileSync(new URL(`../src/${file}`, import.meta.url), 'utf8');
    assert.match(source, /icon: glyph\(/, `${file} uses table icons`);
  }
});

test('ticket10 the mislabelled glyphs carry their real Nerd Font codepoints', () => {
  const table = readFileSync(new URL('../src/shared/ui/symbols.ts', import.meta.url), 'utf8');
  const body = table.slice(table.indexOf('export const SYMBOLS = {'), table.indexOf('} as const satisfies'));
  const entries = [...body.matchAll(/^ {2}(?:'([^']+)'|([\w-]+)):\s*\{ nerd: '\\u\{([0-9a-f]+)\}', plain: '([^']*)' \},$/gm)]
    .map(match => ({ name: match[1] ?? match[2]!, code: Number.parseInt(match[3]!, 16), plain: match[4]! }));
  assert.equal(entries.length, 75, 'the scan reads the whole table');
  const code = (name: string) => { const found = entries.find(entry => entry.name === name); assert.ok(found, `${name} exists`); return found!.code; };
  const glyph = (codepoint: number) => String.fromCodePoint(codepoint);
  // team was md-headphones_bluetooth, launch was md-smoking: both now name their meaning.
  assert.equal(glyph(code('team')), glyph(0xf0849), 'team is md-account_group');
  assert.notEqual(glyph(code('team')), glyph(0xf0970), 'team is no longer md-headphones_bluetooth');
  assert.equal(glyph(code('launch')), glyph(0xf14de), 'launch is md-rocket_launch');
  assert.notEqual(glyph(code('launch')), glyph(0xf04b4), 'launch is no longer md-smoking');
  assert.equal(glyph(code('settings')), glyph(0xf08bb), 'settings is md-cog_outline');
  assert.equal(glyph(code('models')), glyph(0xf06a9), 'models is md-robot');
  assert.equal(glyph(code('up')), glyph(0xf005d), 'up is md-arrow_up');
  assert.equal(glyph(code('down')), glyph(0xf0045), 'down is md-arrow_down');
  // Sharing a codepoint is only allowed inside these deliberate synonym families.
  const shared = new Map<number, string[]>();
  for (const entry of entries) shared.set(entry.code, [...shared.get(entry.code) ?? [], entry.name]);
  const duplicates = [...shared].filter(([, names]) => names.length > 1).map(([codepoint, names]) => `U+${codepoint.toString(16).toUpperCase()} ${names.sort().join('/')}`).sort();
  assert.deepEqual(duplicates, [
    'U+F000E agents/profiles', 'U+F012C complete/done/entry', 'U+F0140 fold/group-fold', 'U+F0142 group-unfold/unfold',
    'U+F0154 intervals/phase/status/wait', 'U+F018D answer/send/session-tools/skills/tool', 'U+F01B4 clear/delete/remove',
    'U+F0208 output/read/summary', 'U+F03EB edit/input/instructions/mode/plan', 'U+F0415 loaded/manual/new/spawn',
    'U+F0456 autoresearch/redispatch', 'U+F048B candidates/catalog', 'U+F04DB cancel/stop', 'U+F04E6 retry-active/starting', 'U+F084F count/nolimit', 'U+F0954 running/verify',
  ], 'only the synonym families share a codepoint');
  for (const name of ['team', 'launch', 'settings', 'models', 'up', 'down']) assert.equal(entries.find(entry => entry.name === name)!.plain, '', `${name} stays empty in plain mode`);
});

test('ticket26 the Team panel expands launch rows in place instead of paging text', () => {
  const source = readFileSync(new URL('../src/team/commands/menu.ts', import.meta.url), 'utf8');
  // Exactly one read-only pager call is allowed, and it must render a message body: launch and team-state
  // rows stay in place, never a paged text view.
  const ast = parse(source, { sourceType: 'module', plugins: ['typescript'] });
  const pagers: string[] = [];
  const walk = (node: any) => {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'CallExpression' && node.callee?.type === 'Identifier' && node.callee.name === 'readView') {
      const argument = node.arguments[2];
      const isBody = argument?.type === 'MemberExpression' && argument.object?.name === 'message' && argument.property?.name === 'body';
      pagers.push(isBody ? 'message.body' : source.slice(node.start ?? 0, node.end ?? 0));
    }
    for (const value of Object.values(node)) if (Array.isArray(value)) value.forEach(walk); else if (value && typeof value === 'object' && 'type' in value) walk(value);
  };
  walk(ast.program);
  assert.deepEqual(pagers, ['message.body'], 'the only paged view is an explicit message body');
  // Actual team-scoped expansion is driven by the panel and PTY checks, not literal object spelling.
  assert.doesNotMatch(source, /label: msg\('启动与接管'\)/, 'the old launch-and-takeover root entity is gone');
  for (const mode of ['auto', 'split', 'window', 'desktop', 'background', 'copy']) assert.match(source, new RegExp(`'${mode}'`), mode);
  // Both hosts exist and stay distinguishable.
  assert.match(source, /'tmux 新窗口'/, 'the tmux window names tmux');
  assert.match(source, /'桌面窗口'/, 'the desktop window is its own row');
});

test('ticket03/team-panel nested short menus stay inline instead of creating directory pages', () => {
  const source = readFileSync(new URL('../src/team/commands/menu.ts', import.meta.url), 'utf8'), ast = parse(source, { sourceType: 'module', plugins: ['typescript'] });
  // The old one-level-only product constraint was withdrawn. Nested start modes must now remain inline.
  const inside: string[] = [];
  const walk = (node: any, depth: number) => {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'ObjectProperty' && !node.computed && (node.key.name === 'children' || node.key.value === 'children')) {
      const nested: string[] = [];
      const scan = (child: any) => {
        if (!child || typeof child !== 'object') return;
        if (child.type === 'ObjectProperty' && !child.computed && (child.key.name === 'children' || child.key.value === 'children')) nested.push('children');
        for (const value of Object.values(child)) if (Array.isArray(value)) value.forEach(scan); else if (value && typeof value === 'object' && 'type' in value) scan(value);
      };
      scan(node.value);
      if (nested.length) inside.push(source.slice(node.start ?? 0, node.end ?? 0));
      assert.doesNotMatch(source.slice(node.value.start ?? 0, node.value.end ?? 0), /kind:\s*['"]directory['"]/, 'nested menu actions do not become directory pages');
    }
    for (const value of Object.values(node)) if (Array.isArray(value)) value.forEach(child => walk(child, depth + 1)); else if (value && typeof value === 'object' && 'type' in value) walk(value, depth + 1);
  };
  walk(ast.program, 0);
  assert.ok(inside.length > 0, 'the start-mode group is nested under its owning session');
  const panel = readFileSync(new URL('../src/shared/ui/panel.ts', import.meta.url), 'utf8');
  assert.match(panel, /expandedPath/, 'open menu ancestry is held inline');
  assert.equal(panel.includes('setPage({ id: `${page.id}:${row.id}`'), false, 'entering a nested entity never replaces the page');
});

test('ticket25 the Pi CLI entry is resolved once in shared and never swapped for process.execPath', () => {
  const root = fileURLToPath(new URL('../src/', import.meta.url));
  const files = readdirSync(root, { recursive: true, withFileTypes: true }).filter(entry => entry.isFile() && entry.name.endsWith('.ts'));
  const declarations: string[] = [], packageReaders: string[] = [], bareExecPath: string[] = [];
  for (const entry of files) {
    const file = relative(root, resolve(entry.parentPath, entry.name)).replaceAll('\\', '/');
    const source = readFileSync(resolve(entry.parentPath, entry.name), 'utf8');
    if (/\b(?:function|const|let)\s+resolvePiCli\b/.test(source)) declarations.push(file);
    if (/getPackageDir\(/.test(source)) packageReaders.push(file);
    // `execPath: process.execPath` is Node, not pi: `--team` then dies as an unknown option.
    // The one legitimate pair lives in the resolver itself (`piLaunchTarget`).
    if (file !== 'shared/pi-cli.ts' && /execPath:\s*process\.execPath/.test(source)) bareExecPath.push(file);
  }
  assert.deepEqual(declarations, ['shared/pi-cli.ts'], 'exactly one resolver, in shared');
  assert.deepEqual(packageReaders, ['shared/pi-cli.ts'], 'only the resolver reads the package manifest');
  assert.deepEqual(bareExecPath, [], 'no module hands pi flags to the Node binary');
  for (const file of ['agents/io/process.ts', 'team/commands/register.ts']) {
    assert.match(readFileSync(resolve(root, file), 'utf8'), /from '\.\.\/\.\.\/shared\/pi-cli\.ts'/, `${file} takes the entry point from shared`);
  }
});

test('ticket32 takeover switches the session file instead of only moving ownership', () => {
  const root = fileURLToPath(new URL('../src/', import.meta.url));
  const files = readdirSync(root, { recursive: true, withFileTypes: true }).filter(entry => entry.isFile() && entry.name.endsWith('.ts')).map(entry => relative(root, resolve(entry.parentPath, entry.name)).replaceAll('\\', '/')).sort();
  const callers: string[] = [];
  for (const file of files) {
    const source = readFileSync(resolve(root, file), 'utf8');
    // A real takeover loads the session file; moving `holder.pid` alone is not a takeover.
    if (/\.switchSession\s*\(/.test(source)) callers.push(file);
  }
  assert.deepEqual(callers, ['team/commands/register.ts'], 'exactly one place switches sessions, and it is the team takeover');
  const register = readFileSync(resolve(root, 'team/commands/register.ts'), 'utf8');
  // The order matters: a session file must be located before anything is claimed.
  const at = (needle: string) => { const index = register.indexOf(needle); assert.ok(index >= 0, `register.ts contains ${needle}`); return index; };
  const locate = at('sessionFileFor(target.sessionId, {'), claim = at('claimOwnership(current.teamId, target.sessionId'), close = at('closePanel(ctx)'), swap = at('host.switchSession(');
  assert.ok(locate < claim, 'the session file is located before ownership changes');
  assert.ok(claim < close && close < swap, 'the panel closes between the claim and the switch');
  // `withSession` must be what announces the new member, and cancellation must roll back.
  assert.match(register, /withSession:\s*async next =>/, 'the announcement uses the replaced context');
  assert.match(register, /if \(!switched\) \{\s*await clearHandoff\(target\.sessionId\);\s*await rollback\(\);/, 'a cancelled switch clears its handoff and rolls the ownership back');
  // The runtime channel is bound only inside withSession, i.e. after the host really switched.
  const bind = register.indexOf('bindMemberRuntime(current.teamId, target.sessionId');
  assert.ok(bind > swap && bind < register.indexOf('return \'switched\';'), 'the runtime is bound after the switch, before success is reported');
});
