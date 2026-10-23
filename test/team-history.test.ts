import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { appendFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionManager, TreeSelectorComponent, initTheme } from '@earendil-works/pi-coding-agent';
import { stripTerminalSequences, visibleWidth } from '@earendil-works/pi-tui';
import { readHistory, entryBody, displayTree, safeHistoryText } from '../src/team/io/session-history.ts';
import { historyComponent, openMemberHistory } from '../src/team/commands/history.ts';

// Existing history acceptance, migrated to the user's replacement contract. The custom overlay, 4MiB/
// 500-record tail, depth/body clipping, ctrl+e second list and plugin banners were explicitly withdrawn.
// Their old assertions are removed, not retained as a second product. No new fixture/provider/test scope.
const hashOf = async (file: string) => createHash('sha256').update(await readFile(file)).digest('hex');
async function fixture(t: { after(fn: () => unknown): void }) {
  const root = await mkdtemp(join(tmpdir(), 'dag-history-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = join(root, 'session.jsonl');
  const manager = SessionManager.open(file);
  const first = manager.appendMessage({ role: 'user', content: [{ type: 'text', text: 'ROOT-MARKER' }] } as never);
  const a = manager.appendMessage({ role: 'assistant', content: [{ type: 'text', text: 'A-BRANCH-BODY' }] } as never);
  manager.branch(first);
  const b = manager.appendMessage({ role: 'assistant', content: [{ type: 'text', text: `B-BRANCH-BODY\n${'LONG'.repeat(3000)}\nBODY-LAST` }] } as never);
  await appendFile(file, '{"type":"message","id":"partial-');
  return { root, file, first, a, b };
}
const frame = (screen: { render(width: number): string[] }, width = 100) => screen.render(width).map(stripTerminalSequences).join('\n');

test('ticket59a the reader shows every saved branch, leaf and full body without writing', async t => {
  const { file, b } = await fixture(t), before = await hashOf(file);
  const snapshot = await readHistory(file);
  assert.equal(snapshot.state, 'ok'); assert.equal(snapshot.leafId, b);
  assert.equal(snapshot.tree.length, 1); assert.equal(snapshot.tree[0]!.children.length, 2);
  assert.match(snapshot.entries.map(entry => entry.text).join('\n'), /A-BRANCH-BODY/);
  assert.ok(entryBody(snapshot, b)!.includes('LONG'.repeat(3000)));
  assert.match(entryBody(snapshot, b)!, /BODY-LAST/);
  assert.equal(snapshot.skipped, 1);
  assert.equal(await hashOf(file), before);
});

test('ticket59a a missing or invalid session is not created or repaired', async t => {
  const root = await mkdtemp(join(tmpdir(), 'dag-history-missing-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = join(root, 'missing.jsonl');
  assert.equal((await readHistory(file)).state, 'missing');
  await assert.rejects(readFile(file));
  assert.equal((await readHistory(undefined, 'not saved')).reason, 'not saved');
  await writeFile(file, 'null\n'); const before = await hashOf(file);
  assert.equal((await readHistory(file)).state, 'invalid'); assert.equal(await hashOf(file), before);
});

test('ticket59a the screen uses native tree chrome and native search without extra banners', async t => {
  const { file } = await fixture(t); initTheme('dark');
  const snapshot = await readHistory(file);
  let done = 0;
  const screen = historyComponent({ target: { name: 'Helper', sessionId: 's1', file }, snapshot, rows: 40, done: () => done++ });
  const native = new TreeSelectorComponent(displayTree(snapshot.tree), snapshot.leafId, 40, () => {}, () => {}, undefined, undefined, 'default');
  assert.deepEqual(screen.render(100), native.render(100), 'production screen is the native tree, not a lookalike panel');
  assert.match(frame(screen), /Session Tree/);
  assert.doesNotMatch(frame(screen), /只读会话历史|只展示最近|分支树 —/);
  screen.handleInput('R'); native.handleInput('R');
  assert.deepEqual(screen.render(100), native.render(100));
  screen.handleInput('\x1b'); assert.equal(done, 0, 'first Esc clears native search');
  screen.handleInput('\x1b'); assert.equal(done, 1, 'second Esc leaves the tree');
});

test('ticket59a Enter opens the saved body and Esc returns to the same native tree', async t => {
  const { file, b } = await fixture(t), before = await hashOf(file); initTheme('dark');
  const snapshot = await readHistory(file);
  let repaints = 0;
  const screen = historyComponent({ target: { name: 'Helper', sessionId: 's1', file }, snapshot, rows: 24, done() {}, repaint: () => { repaints++; } });
  const tree = screen.treeSelector(); screen.render(80); screen.handleInput('\r');
  assert.ok(repaints > 0, 'opening a body requests a real TUI redraw');
  assert.match(frame(screen, 80), /Session Tree/, 'Enter preserves the history screen identity instead of replacing it with bare text');
  assert.match(frame(screen, 80), /Esc/, 'the body keeps a visible route back to the tree');
  assert.match(frame(screen, 80), /B-BRANCH-BODY/);
  assert.equal(tree.getTreeList().getSelectedNode()!.entry.id, b);
  screen.handleInput('\x1b[F');
  assert.match(frame(screen, 80), /BODY-LAST/);
  screen.handleInput('\x1b');
  assert.equal(screen.treeSelector(), tree); assert.match(frame(screen), /Session Tree/);
  assert.equal(await hashOf(file), before);
});

test('ticket59a saved controls are removed while indentation and tool arguments remain', async t => {
  const { file } = await fixture(t);
  const text = safeHistoryText('    code\n\tmore\x1b]52;c;payload\x07\u009b31mred\x07');
  assert.match(text, /^    code\n\tmore/); assert.doesNotMatch(text, /\x1b|\x07|\u009b/);
  const snapshot = await readHistory(file);
  const copied = displayTree(snapshot.tree);
  assert.equal(copied[0]!.entry.id, snapshot.tree[0]!.entry.id);
  assert.notEqual(copied[0], snapshot.tree[0]);
  const record = { type: 'message', id: 'tool', parentId: null, timestamp: new Date().toISOString(), message: { role: 'assistant', content: [{ type: 'toolCall', name: 'read', arguments: { path: 'ARGUMENT-MARKER' } }] } };
  const hostile = 'VISIBLE-MARKER\x1b]52;c;payload\x07\u009b31mTEXT\x07';
  const leaf = { type: 'message', id: 'leaf', parentId: 'tool', timestamp: new Date().toISOString(), message: { role: 'user', content: hostile } };
  await writeFile(file, [JSON.stringify({ type: 'session', version: 3, id: 's1', cwd: '/tmp' }), JSON.stringify(record), JSON.stringify(leaf)].join('\n') + '\n');
  const guarded = await readHistory(file), before = await hashOf(file);
  assert.match(guarded.entries[0]!.text, /ARGUMENT-MARKER/);
  initTheme('dark');
  const screen = historyComponent({ target: { name: 'safe', sessionId: 's1', file }, snapshot: guarded, rows: 30, done() {} });
  const treeFrame = screen.render(80).join('\n');
  assert.match(treeFrame, /VISIBLE-MARKER/);
  assert.doesNotMatch(treeFrame, /\x1b\]|\x07|[\u0080-\u009f]/, 'saved controls never enter the native renderer');
  screen.handleInput('\r');
  assert.doesNotMatch(screen.render(80).join('\n'), /\x1b\]|\x07|[\u0080-\u009f]/, 'opening the saved body also strips terminal commands');
  assert.equal(await hashOf(file), before);
});

test('ticket59b legacy entries migrate in memory and source bytes remain untouched', async t => {
  const { file } = await fixture(t);
  await writeFile(file, [JSON.stringify({ type: 'session', version: 1, id: 's1', cwd: '/tmp' }), JSON.stringify({ type: 'message', timestamp: 1, message: { role: 'user', content: 'LEGACY-MARKER' } })].join('\n'));
  const before = await hashOf(file), snapshot = await readHistory(file);
  assert.equal(snapshot.state, 'ok'); assert.equal(snapshot.entries.length, 1);
  assert.match(snapshot.entries[0]!.text, /LEGACY-MARKER/); assert.ok(snapshot.entries[0]!.id);
  assert.equal(await hashOf(file), before);
});

test('ticket66 a ten-thousand-deep history remains complete and native-renderable', async t => {
  const { file } = await fixture(t);
  const lines = [JSON.stringify({ type: 'session', version: 3, id: 's1', cwd: '/tmp' })];
  for (let i = 0; i < 10_000; i++) lines.push(JSON.stringify({ type: 'message', id: `n${i}`, parentId: i ? `n${i - 1}` : null, timestamp: new Date().toISOString(), message: { role: 'user', content: `NODE-${i}` } }));
  await writeFile(file, lines.join('\n') + '\n'); const before = await hashOf(file);
  const snapshot = await readHistory(file);
  assert.equal(snapshot.entries.length, 10_000, 'no record window');
  assert.match(snapshot.entries[0]!.text, /NODE-0/); assert.match(snapshot.entries.at(-1)!.text, /NODE-9999/);
  initTheme('dark');
  const screen = historyComponent({ target: { name: 'deep', sessionId: 's1', file }, snapshot, rows: 40, done() {} });
  assert.match(frame(screen), /NODE-9999/);
  assert.equal(await hashOf(file), before);
});

test('ticket66 a file beyond four MiB keeps both its beginning and its complete tail', async t => {
  const { file } = await fixture(t);
  const lines = [JSON.stringify({ type: 'session', version: 3, id: 's1', cwd: '/tmp' })];
  for (let i = 0; i < 600; i++) lines.push(JSON.stringify({ type: 'message', id: `n${i}`, parentId: i ? `n${i - 1}` : null, timestamp: new Date().toISOString(), message: { role: 'user', content: `BODY-${i} ${'x'.repeat(9000)} END-${i}` } }));
  await writeFile(file, lines.join('\n') + '\n'); const snapshot = await readHistory(file);
  assert.equal(snapshot.entries.length, 600); assert.match(snapshot.entries[0]!.text, /BODY-0 /);
  assert.match(snapshot.entries.at(-1)!.text, /END-599$/);
  assert.equal(snapshot.skipped, 0);
});

test('ticket66 cyclic parents and duplicate identities cannot hang native selection', async t => {
  const { file } = await fixture(t);
  await writeFile(file, [JSON.stringify({ type: 'session', version: 3, id: 's1', cwd: '/tmp' }), ...[
    ['a', 'b', 'OLD'], ['b', 'a', 'BRANCH'], ['a', 'b', 'LATEST'],
  ].map(([id, parentId, content]) => JSON.stringify({ type: 'message', id, parentId, timestamp: new Date().toISOString(), message: { role: 'user', content } }))].join('\n') + '\n');
  const snapshot = await readHistory(file); assert.equal(snapshot.entries.length, 2);
  assert.match(entryBody(snapshot, 'a')!, /LATEST/);
  initTheme('dark'); const screen = historyComponent({ target: { name: 'cycle', sessionId: 's1', file }, snapshot, rows: 24, done() {} });
  assert.match(frame(screen), /LATEST/);
});

test('ticket66 deeply nested saved arguments remain complete without recursive copies', async t => {
  const { file } = await fixture(t);
  const header = JSON.stringify({ type: 'session', version: 3, id: 's1', cwd: '/tmp' });
  const value = '['.repeat(5000) + '"DEEP-END"' + ']'.repeat(5000);
  await writeFile(file, header + '\n' + '{"type":"message","id":"deep","parentId":null,"timestamp":"2024-01-01T00:00:00Z","message":{"role":"assistant","content":[{"type":"toolCall","id":"call","name":"custom_probe","arguments":{"nested":' + value + '}}]}}\n' + JSON.stringify({ type: 'message', id: 'result', parentId: 'deep', timestamp: '2024-01-01T00:00:01Z', message: { role: 'toolResult', toolCallId: 'call', toolName: 'custom_probe', content: [{ type: 'text', text: 'RESULT' }], isError: false } }) + '\n');
  const snapshot = await readHistory(file);
  assert.match(snapshot.entries[0]!.text, /DEEP-END/);
  assert.equal(displayTree(snapshot.tree).length, 1);
  initTheme('dark');
  const screen = historyComponent({ target: { name: 'deep arguments', sessionId: 's1', file }, snapshot, rows: 30, done() {} });
  assert.match(frame(screen), /custom_probe/, 'the actual native custom-tool preview must render without recursive stringify overflow');
});

test('ticket66 history mounts native UI without overlay and leaves no source mutation', async t => {
  const { file } = await fixture(t), before = await hashOf(file); initTheme('dark');
  let mounted = false;
  const ctx: any = { hasUI: true, mode: 'tui', sessionManager: {}, ui: { notify() {}, async custom(factory: any, options: unknown) {
    assert.equal(options, undefined, 'neither loading nor the tree is an overlay');
    return new Promise(resolve => {
      let screen: any;
      const done = (value: unknown) => { screen?.dispose?.(); resolve(value); };
      screen = factory({ terminal: { rows: 30 }, requestRender() {} }, { fg: (_color: string, text: string) => text }, {}, done);
      if ('treeSelector' in screen) {
        assert.match(frame(screen), /Session Tree/);
        assert.doesNotMatch(frame(screen), /只展示最近|只读会话历史/);
        screen.handleInput('\x1b'); mounted = true;
      }
    });
  } } };
  await openMemberHistory(ctx, { name: 'Helper', sessionId: 's1', file });
  assert.equal(mounted, true); assert.equal(await hashOf(file), before);
});

test('ticket66 resize preserves selected identity, body end and native width bounds', async t => {
  const { file, b } = await fixture(t); initTheme('dark'); const snapshot = await readHistory(file);
  let rows = 36;
  const screen = historyComponent({ target: { name: 'Helper', sessionId: 's1', file }, snapshot, rows: () => rows, done() {} });
  screen.render(100); rows = 22; const small = screen.render(36);
  assert.equal(screen.treeSelector().getTreeList().getSelectedNode()!.entry.id, b);
  assert.equal(small.every(line => visibleWidth(line) <= 36), true);
  screen.handleInput('\r'); screen.render(36); screen.handleInput('\x1b[F');
  assert.match(frame(screen, 36), /BODY-LAST/);
  rows = 40; assert.match(frame(screen, 100), /BODY-LAST/);
});
