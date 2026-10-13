import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import { stripTerminalSequences, visibleWidth } from '@earendil-works/pi-tui';
import { choose, readView, bindMenuDisplay, menuDisplayOpen, withMenuScope, type MenuItem } from '../src/ui/menu.ts';
import { createTranslator } from '../src/shared/i18n.ts';

const plain = (text: string) => stripTerminalSequences(text);
function host(mode: 'tui' | 'rpc' | 'print' | 'json' | undefined = 'rpc') {
  const calls: { title: string; options: string[]; signal?: AbortSignal }[] = [], notices: string[] = [], styles: { text: string; fg: string; bold: boolean }[] = [];
  if (mode === 'tui') { const stdout = process.stdout as { columns?: number; rows?: number }; stdout.columns = stdout.columns ?? 120; stdout.rows = stdout.rows ?? 40; }
  let select: (title: string, options: string[], signal?: AbortSignal) => Promise<string | undefined> = async () => undefined;
  let input: () => Promise<string | undefined> = async () => undefined;
  const ctx = {
    mode, hasUI: !['print', 'json'].includes(mode ?? ''), sessionManager: {},
    ui: {
      theme: { style: (text: string, options: { fg: string; bold: boolean }) => { styles.push({ text, ...options }); return `${options.bold ? '\x1b[1m' : '\x1b[22m'}\x1b[32m${text}\x1b[0m`; } },
      select: (title: string, options: string[], opts?: { signal?: AbortSignal }) => { calls.push({ title, options, ...(opts?.signal ? { signal: opts.signal } : {}) }); return select(title, options, opts?.signal); },
      input: () => input(), notify: (text: string) => notices.push(text),
      custom: () => { throw new Error('Custom UI must never be used'); },
    },
  } as unknown as ExtensionContext;
  return { ctx, calls, notices, styles, select: (fn: typeof select) => { select = fn; }, input: (fn: typeof input) => { input = fn; } };
}
const items = (n: number): MenuItem[] => Array.from({ length: n }, (_, i) => ({ id: `i${i}`, label: `Item ${i}` }));

test('native paging selects the later item and retains the returned cursor', async () => {
  const h = host(), cursor: { page?: number; selectedId?: string } = {}; let step = 0;
  h.select(async (_title, options) => ++step === 1 ? options.find(value => value === '下一页') : options.find(value => value === 'Item 8'));
  assert.equal(await choose(h.ctx, 'Pick', items(10), { cursor }), 'i8');
  assert.equal(cursor.page, 1); assert.equal(cursor.selectedId, 'i8'); assert.match(h.calls[1]!.title, /2\/2/);
});

test('native search filters records beyond the current page and cancelling search preserves the query', async () => {
  const h = host(), cursor: { query?: string } = {}; let step = 0;
  h.input(async () => 'Item 19'); h.select(async (_title, options) => ++step === 1 ? options.find(value => value === '搜索…') : options.find(value => value === 'Item 19'));
  assert.equal(await choose(h.ctx, 'Search', items(20), { searchable: true, cursor }), 'i19'); assert.equal(cursor.query, 'Item 19');
  step = 0; h.input(async () => undefined); h.select(async (_title, options) => ++step === 1 ? options.find(value => value === '搜索…') : options.find(value => value === 'Item 19'));
  assert.equal(await choose(h.ctx, 'Search', items(20), { searchable: true, cursor }), 'i19'); assert.equal(cursor.query, 'Item 19');
});

test('disabled choices stay visible with a reason and cannot execute', async () => {
  const h = host(); let step = 0;
  h.select(async (_title, options) => ++step === 1 ? options.find(value => value.includes('no access')) : options.find(value => value === 'Allowed'));
  assert.equal(await choose(h.ctx, 'Pick', [{ id: 'blocked', label: 'Blocked', disabledReason: 'no access' }, { id: 'allowed', label: 'Allowed' }]), 'allowed'); assert.equal(h.calls.length, 2);
});

test('native fixed actions preserve their current values and return caller ids', async () => {
  const h = host(); h.select(async (_title, options) => options.find(value => value.startsWith('Save')));
  assert.equal(await choose(h.ctx, 'Pick', items(3), { actions: [{ id: 'save', label: 'Save', value: '2 entries' }] }), 'save');
  assert.ok(h.calls[0]!.options.some(value => value.includes('2 entries')));
});

test('native TUI preserves identity and semantic state colors, and never uses an overlay', async () => {
  const h = host('tui'); h.select(async (_title, options) => options.find(value => plain(value).includes('#12')));
  assert.equal(await choose(h.ctx, 'Goal', [{ id: '12', label: '#12 Long completed objective', value: '已完成' }, { id: '18', label: '#18 Active objective', value: '活动' }, { id: '20', label: '#20 Waiting objective', value: '暂停' }, { id: '21', label: '#21 Failed objective', value: '失败' }]), '12');
  for (const fg of ['accent', 'muted', 'warning', 'error']) assert.ok(h.styles.some(style => style.fg === fg), fg);
  assert.ok(h.styles.some(style => style.text === '#12' && style.bold), 'identifier is bold');
  assert.ok(h.styles.some(style => style.text === '[已完成]' && style.fg === 'muted'), 'history is dimmed');
  assert.ok(plain(h.calls[0]!.options[0]!).startsWith('#12 [已完成]'), 'status remains before a long title');
});

test('setting values use dim separately from action labels and attention states', async () => {
  const h = host('tui'); h.select(async () => undefined);
  await choose(h.ctx, 'Settings', [{ id: 'research', label: 'Continuous research', value: 'Enabled', valueTone: 'dim' }, { id: 'failed', label: '#1 Failed task', value: '失败' }], { actions: [{ id: 'summary', label: 'Show summary', value: 'Disabled', valueTone: 'dim' }] });
  assert.ok(h.styles.some(style => style.text === 'Enabled' && style.fg === 'dim' && !style.bold));
  assert.ok(h.styles.some(style => style.text === 'Disabled' && style.fg === 'dim' && !style.bold));
  assert.ok(h.styles.some(style => style.text === '[失败]' && style.fg === 'error' && style.bold));
  assert.ok(!h.styles.some(style => style.text === 'Continuous research' && style.fg === 'dim'));
});

test('a directory never embeds long history, requirements or a preview of an unselected record', async () => {
  const h = host('tui'); h.select(async () => undefined);
  await choose(h.ctx, 'Goal', items(20), { searchable: true, lines: () => ['Scope\n' + 'DO NOT INLINE HISTORY '.repeat(200)] });
  assert.doesNotMatch(h.calls[0]!.title, /DO NOT INLINE HISTORY|Scope/); assert.ok(h.calls[0]!.title.split('\n').length === 2);
});

test('a selected action page has at most three short context lines; complete body remains separately viewable', async () => {
  const h = host(); await choose(h.ctx, 'Goal #1', items(3), { lines: ['Status: paused', 'Allowance: 4/32', 'Next action: verify', 'FULL BODY SHOULD NOT BE INLINE'] });
  assert.match(h.calls[0]!.title, /Status: paused/); assert.match(h.calls[0]!.title, /4\/32/); assert.doesNotMatch(h.calls[0]!.title, /FULL BODY/);
});

test('native duplicate labels select the correct stable id', async () => {
  const h = host(); h.select(async (_title, options) => options.find(value => value === 'Same (2)'));
  assert.equal(await choose(h.ctx, 'Pick', [{ id: 'a', label: 'Same' }, { id: 'b', label: 'Same' }]), 'b');
});

test('duplicate-label suffixes cannot collide with a literal label', async () => {
  const h = host(); h.select(async (_title, options) => options[2]);
  assert.equal(await choose(h.ctx, 'Pick', [{ id: 'a', label: 'Same' }, { id: 'b', label: 'Same' }, { id: 'c', label: 'Same (1)' }]), 'c');
  assert.equal(new Set(h.calls[0]!.options).size, h.calls[0]!.options.length);
});

test('expiry aborts the native dialog and never commits its draft cursor', async () => {
  const h = host(), cursor = { selectedId: 'keep' }; let current = true;
  h.select(async () => new Promise(() => {}));
  const pending = choose(h.ctx, 'Pick', items(10), { cursor, isCurrent: () => current });
  await new Promise(resolve => setTimeout(resolve, 150)); current = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { assert.equal(await Promise.race([pending, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Expired native dialog did not close')), 2000); })]), undefined); }
  finally { clearTimeout(timer); }
  assert.deepEqual(cursor, { selectedId: 'keep' }); assert.equal(h.calls[0]!.signal?.aborted, true);
});

test('native text reader pages the entire body and is read-only, with restrained bold labels', async () => {
  const h = host('tui'), original = Array.from({ length: 40 }, (_, i) => `Scope line ${i}`).join('\n');
  let step = 0; h.select(async (_title, options) => ++step <= 2 ? options.find(value => value === '下一页') : options.find(value => value === '返回'));
  await readView(h.ctx, 'Full scope', original);
  assert.equal(h.calls.length, 3); assert.ok(h.calls[0]!.options.some(value => plain(value).includes('Scope line 0'))); for (let i = 0; i < 40; i++) assert.ok(h.styles.some(style => style.text === `Scope line ${i}`), `full body line ${i} remains accessible`);
  assert.ok(h.styles.some(style => style.text === 'Scope line 0' && !style.bold), 'ordinary body is not bold');
  assert.equal(h.calls.some(call => call.options.some(value => value.includes('编辑'))), false, 'reader has no editor or save operation');
});

test('reader body fits the native list padding without extra single-character wrapped rows', async () => {
  const h = host('tui'), oldCols = process.stdout.columns, oldRows = process.stdout.rows;
  process.stdout.columns = 52; process.stdout.rows = 22;
  h.select(async () => undefined);
  try {
    await readView(h.ctx, 'Reader', '汉字正文'.repeat(50));
    for (const value of h.calls[0]!.options) assert.ok(visibleWidth(value) <= 48, 'native selector needs two prefix and two outer-padding columns');
  } finally { process.stdout.columns = oldCols; process.stdout.rows = oldRows; }
});

test('native resize preserves the first visible paragraph while re-opening the reader', async () => {
  const h = host('tui'), oldRows = process.stdout.rows; process.stdout.rows = 42;
  let step = 0;
  h.select(async (_title, options, signal) => {
    step++;
    if (step <= 2) return options.find(value => value === '下一页');
    if (step === 3) { process.stdout.rows = 30; return new Promise(resolve => signal!.addEventListener('abort', () => resolve(undefined), { once: true })); }
    return options.find(value => value === '返回');
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([readView(h.ctx, 'Reader', Array.from({ length: 60 }, (_, i) => `Paragraph ${i}`).join('\n')), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Native resize did not reopen')), 2000); })]);
    assert.equal(h.calls.length, 4);
    assert.ok(h.calls[2]!.options.some(value => plain(value).includes('Paragraph 28'))); assert.ok(h.calls[3]!.options.some(value => plain(value).includes('Paragraph 28')));
  } finally { clearTimeout(timer); process.stdout.rows = oldRows; }
});

test('the entire nested command hides our summary once and restores it only at the end', async () => {
  const h = host('tui'), visibility: boolean[] = [];
  bindMenuDisplay(h.ctx, () => visibility.push(menuDisplayOpen(h.ctx)));
  await withMenuScope(h.ctx, async () => {
    h.select(async () => undefined); await choose(h.ctx, 'Directory', items(3));
    assert.equal(menuDisplayOpen(h.ctx), true); await readView(h.ctx, 'Body', 'ordinary line'); assert.equal(menuDisplayOpen(h.ctx), true);
  });
  assert.deepEqual(visibility, [true, false]); assert.equal(menuDisplayOpen(h.ctx), false);
});

test('old scope completion cannot restore widgets after a replacement session binding', async () => {
  const h = host(), old: boolean[] = [], fresh: boolean[] = [];
  bindMenuDisplay(h.ctx, () => old.push(menuDisplayOpen(h.ctx)));
  let finish: () => void = () => {}; const pending = withMenuScope(h.ctx, () => new Promise<void>(resolve => { finish = resolve; }));
  bindMenuDisplay(h.ctx, () => fresh.push(menuDisplayOpen(h.ctx))); finish(); await pending;
  assert.deepEqual(old, [true]); assert.deepEqual(fresh, []);
});

test('RPC/unknown clients use plain native dialogs and print/json never open UI', async () => {
  for (const mode of ['rpc', undefined] as const) { const h = host(mode); h.select(async (_title, options) => options[0]); assert.equal(await choose(h.ctx, 'Pick', items(3)), 'i0'); assert.doesNotMatch(h.calls[0]!.title + h.calls[0]!.options.join(''), /\x1b/); }
  for (const mode of ['print', 'json'] as const) { const h = host(mode); assert.equal(await choose(h.ctx, 'Pick', items(3)), undefined); await readView(h.ctx, 'Body', 'readable'); assert.equal(h.calls.length, 0); assert.deepEqual(h.notices, ['readable']); }
  const h = host(); const controller = new AbortController(); controller.abort(); await readView(h.ctx, 'Body', 'text', { signal: controller.signal }); assert.equal(h.calls.length, 0);
});

test('localized native options remain plain for RPC and semantic colors work in both languages', async () => {
  const h = host('tui'), msg = createTranslator('en'); await choose(h.ctx, 'Goals', [{ id: '1', label: '#1 Scope', value: msg('失败') }], { msg });
  assert.ok(h.styles.some(style => style.fg === 'error')); assert.ok(h.calls[0]!.options.some(value => plain(value) === 'Back'));
});
