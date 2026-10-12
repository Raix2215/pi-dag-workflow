import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ExtensionContext, Theme } from '@earendil-works/pi-coding-agent';
import { visibleWidth, type TUI } from '@earendil-works/pi-tui';
import { choose, readView, type MenuItem } from '../src/ui/menu.ts';

interface FakeComponent { render(width: number): string[]; handleInput(data: string): void; dispose?(): void }

const theme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
  style: (text: string) => text,
  colors: {},
  appearance: 'dark',
} as unknown as Theme;

function makeContext(mode: 'tui' | 'rpc' | 'print' | 'json', rows = 24) {
  const notices: string[] = [];
  const terminal = { rows };
  let component: FakeComponent | undefined;
  const ctx = {
    mode,
    hasUI: mode !== 'print' && mode !== 'json',
    ui: {
      notify: (message: string) => { notices.push(message); },
      select: async () => undefined,
      input: async () => undefined,
      editor: async () => undefined,
      custom: (factory: (tui: TUI, theme: Theme, kb: unknown, done: (result: unknown) => void) => FakeComponent) =>
        new Promise<unknown>((resolve) => { component = factory({ terminal, requestRender() {} } as unknown as TUI, theme, {}, resolve); }),
    },
  } as unknown as ExtensionContext;
  return { ctx, notices, component: () => component, resize: (rows: number) => { terminal.rows = rows; } };
}

function makeRpc(mode: string | undefined, hasUI: boolean) {
  const notices: string[] = [];
  const calls: string[][] = [];
  let impl: (title: string, options: string[]) => Promise<string | undefined> = async () => undefined;
  const ctx = {
    mode,
    hasUI,
    ui: {
      notify: (message: string) => { notices.push(message); },
      select: (title: string, options: string[]) => { calls.push(options); return impl(title, options); },
      input: async () => undefined,
      custom: () => { throw new Error('custom must not open outside tui'); },
    },
  } as unknown as ExtensionContext;
  return { ctx, notices, calls, setSelect: (fn: typeof impl) => { impl = fn; } };
}

const items = (n: number): MenuItem[] => Array.from({ length: n }, (_, index) => ({ id: `a${index}`, label: `Item ${index}` }));

test('choose paginates, mutates the caller cursor draft and returns the selected id', async () => {
  const fake = makeContext('tui');
  const cursor = { query: '', selectedId: 'a0', page: 0 };
  const pending = choose(fake.ctx, 'Pick', items(10), { searchable: true, cursor });
  const view = fake.component()!;
  assert.equal(view.render(80).length <= 24, true);
  view.handleInput('\x1b[6~'); // PageDown
  assert.ok(view.render(80).some((line) => line.includes('Item 8')));
  assert.equal(cursor.page, 1);
  view.handleInput('\r');
  assert.equal(await pending, 'a8');
  assert.equal(cursor.selectedId, 'a8');
});

test('choose filters through the search input and selects a later page item', async () => {
  const fake = makeContext('tui');
  const cursor: { query?: string } = {};
  const pending = choose(fake.ctx, 'Pick', items(10), { searchable: true, cursor });
  const view = fake.component()!;
  view.handleInput('9');
  view.render(80);
  view.handleInput('\r');
  assert.equal(await pending, 'a9');
  assert.equal(cursor.query, '9');
});

test('choose refuses a disabled item with a reason and cancels on escape', async () => {
  const fake = makeContext('tui');
  const pending = choose(fake.ctx, 'Pick', [
    { id: 'blocked', label: 'Blocked', disabledReason: 'no access' },
    { id: 'fine', label: 'Fine' },
  ]);
  let settled = false;
  void pending.then(() => { settled = true; });
  const view = fake.component()!;
  view.handleInput('\r');
  await Promise.resolve();
  assert.equal(settled, false);
  assert.ok(fake.notices.some((notice) => notice.includes('no access')));
  view.handleInput('\x1b');
  assert.equal(await pending, undefined);
});

test('choose switches to the fixed action zone with Tab', async () => {
  const fake = makeContext('tui');
  const pending = choose(fake.ctx, 'Pick', items(3), { actions: [{ id: 'save', label: 'Save' }] });
  const view = fake.component()!;
  view.handleInput('\t');
  view.handleInput('\r');
  assert.equal(await pending, 'save');
});

test('the list shows the item value and a short terminal keeps the selected value and action visible', async () => {
  const fake = makeContext('tui', 8);
  const pending = choose(fake.ctx, 'Pick', [
    { id: 'a', label: 'Alpha', value: 'root-1' },
    { id: 'b', label: 'Beta', value: 'root-2' },
  ], {
    actions: [
      { id: 'save', label: 'Save the current selection and keep going' },
      { id: 'clear', label: 'Clear everything now' },
    ],
    cursor: { selectedId: 'b' },
  });
  const view = fake.component()!;
  const lines = view.render(80);
  assert.ok(lines.length <= 4, `rendered ${lines.length} lines on a short terminal`);
  assert.ok(lines.every((line) => visibleWidth(line) === 80), 'overlay covers the underlying widget across every row');
  assert.ok(lines.some((line) => line.includes('root-2')), 'selected value is visible');
  view.handleInput('\t');
  const actionLines = view.render(80);
  assert.ok(actionLines.length <= 4);
  assert.ok(actionLines.some((line) => line.includes('Save')), 'selected long action stays visible');
  view.handleInput('\r');
  assert.equal(await pending, 'save');

  const tiny = makeContext('tui', 6);
  const tinyPending = choose(tiny.ctx, 'Pick', [
    { id: 'b', label: 'Beta', value: 'root-2' },
  ], { actions: [{ id: 'save', label: 'Save the current selection and keep going' }], cursor: { selectedId: 'b' } });
  const tinyView = tiny.component()!;
  const tinyLines = tinyView.render(80);
  assert.ok(tinyLines.length <= 2, `rendered ${tinyLines.length} lines on a 6-row terminal`);
  assert.ok(tinyLines.some((line) => line.includes('root-2')), 'selected value survives on a 6-row terminal');
  tinyView.handleInput('\t');
  assert.ok(tinyView.render(80).some((line) => line.includes('Save')), 'selected action survives on a 6-row terminal');
  tinyView.handleInput('\x1b');
  await tinyPending;
});

test('resize keeps the highlighted record while short pages recompute', async () => {
  const fake = makeContext('tui', 40), cursor = { selectedId: 'a24', page: 3 };
  const pending = choose(fake.ctx, 'Pick', items(40), { searchable: true, cursor });
  const view = fake.component()!; view.render(80);
  fake.resize(14);
  assert.ok(view.render(40).some((line) => line.includes('Item 24')), 'resize does not silently change the selected record');
  view.handleInput('\r'); assert.equal(await pending, 'a24');
});

test('the detail lines function re-evaluates for the current selection', async () => {
  const fake = makeContext('tui');
  const pending = choose(fake.ctx, 'Pick', items(3), {
    lines: (item) => [`detail for ${item.label}`],
  });
  const view = fake.component()!;
  assert.ok(view.render(80).some((line) => line.includes('detail for Item 0')));
  view.handleInput('\x1b[B'); // Down
  assert.ok(view.render(80).some((line) => line.includes('detail for Item 1')));
  view.handleInput('\x1b');
  await pending;
});

test('RPC duplicate labels on one page resolve to the right id', async () => {
  const fake = makeRpc('rpc', true);
  fake.setSelect(async (_title, options) => options.find((option) => option.startsWith('Same (2)')) ?? options[0]);
  const cursor: { selectedId?: string } = {};
  const result = await choose(fake.ctx, 'Pick', [
    { id: 'a', label: 'Same' },
    { id: 'b', label: 'Same' },
    { id: 'c', label: 'Other' },
  ], { cursor });
  assert.equal(result, 'b');
  assert.equal(cursor.selectedId, 'b');
});

test('RPC cross-page navigation selects the same label on the target page', async () => {
  const fake = makeRpc('rpc', true);
  let step = 0;
  fake.setSelect(async (_title, options) => {
    step += 1;
    if (step === 1) return options.find((option) => option === '下一页');
    return options.find((option) => option === 'Same');
  });
  const list: MenuItem[] = Array.from({ length: 9 }, (_, index) => ({ id: `a${index}`, label: `Item ${index}` }));
  list[0] = { id: 'a0', label: 'Same' };
  list[1] = { id: 'a1', label: 'Same' };
  list[8] = { id: 'a8', label: 'Same' };
  assert.equal(await choose(fake.ctx, 'Pick', list), 'a8');
});

test('expiry during a pending RPC select does not commit the cursor or return an id', async () => {
  const fake = makeRpc('rpc', true);
  let current = true;
  fake.setSelect(() => new Promise(() => {}));
  const cursor: { selectedId?: string; page?: number } = { selectedId: 'keep' };
  const pending = choose(fake.ctx, 'Pick', items(10), { cursor, isCurrent: () => current });
  await new Promise((resolve) => setTimeout(resolve, 250));
  current = false;
  // A fake select has no live RPC pipe. Keep a bounded deadline referenced while
  // the unref'ed expiry poll resolves, and fail if the dialog never closes.
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error('Expired menu did not close')), 2000); });
  try {
    assert.equal(await Promise.race([pending, deadline]), undefined);
    assert.deepEqual(cursor, { selectedId: 'keep' });
  } finally { clearTimeout(timer); }
});

test('an unknown mode with hasUI falls back to RPC while print and json stay closed', async () => {
  const unknown = makeRpc(undefined, true);
  unknown.setSelect(async (_title, options) => options.find((option) => option.startsWith('Item 1')));
  assert.equal(await choose(unknown.ctx, 'Pick', items(3)), 'a1');

  const print = makeRpc('print', false);
  assert.equal(await choose(print.ctx, 'Pick', items(3)), undefined);
  assert.equal(print.calls.length, 0);

  const json = makeRpc('json', true);
  assert.equal(await choose(json.ctx, 'Pick', items(3)), undefined);
  assert.equal(json.calls.length, 0);
});

test('readView renders a scrollable TUI screen and resolves on escape', async () => {
  const fake = makeContext('tui');
  const pending = readView(fake.ctx, 'Details', 'hello\nworld');
  const view = fake.component()!;
  assert.ok(view.render(40).some((line) => line.includes('hello')));
  assert.ok(view.render(40).every((line) => visibleWidth(line) === 40), 'short detail lines cover the underlying widget');
  view.handleInput('\x1b');
  await pending;
});

test('non-TUI modes never open a custom screen and leave state untouched', async () => {
  const print = makeContext('print');
  const cursor = { query: 'kept', page: 2 };
  assert.equal(await choose(print.ctx, 'Pick', items(3), { cursor }), undefined);
  assert.deepEqual(cursor, { query: 'kept', page: 2 });
  assert.equal(print.component(), undefined);
  await readView(print.ctx, 'Details', 'line one\nline two');
  assert.ok(print.notices.some((notice) => notice.includes('line one')));

  const json = makeContext('json');
  assert.equal(await choose(json.ctx, 'Pick', items(3)), undefined);
});

test('an already aborted signal resolves readView without touching the UI', async () => {
  const fake = makeContext('print');
  const controller = new AbortController();
  controller.abort();
  await readView(fake.ctx, 'Details', 'text', { signal: controller.signal });
  assert.equal(fake.notices.length, 0);
});
