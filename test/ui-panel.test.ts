import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { Theme } from '@earendil-works/pi-coding-agent';
import { Editor, CURSOR_MARKER, stripTerminalSequences, visibleWidth } from '@earendil-works/pi-tui';
import { retryWidgetLine } from '../src/workflow/commands/view.ts';
import { createPanel, canDock, canExecute, dock, dottedColumns, fitRow, middleTruncate, panelKeys, valueToneFor, type PanelConfig, type PanelMemory, type PanelRow, type PanelResult } from '../src/shared/ui/panel.ts';
import { createTranslator } from '../src/shared/i18n.ts';
import { modelBudget, modelLabel } from '../src/shared/ui/presentation.ts';
import { renderTasks, renderTaskTree } from '../src/shared/ui/render.ts';
import type { WorkflowState } from '../src/shared/task-types.ts';

// Existing cases retain their coverage with the finalized inline budget contracts.
const names = [
  'U7 frames: inline budget height and complete 1/2/6 module tabs',
  'U7 continuous scrolling clamps and fast-scroll skips non-dockable rows',
  'U7 short and empty collections use natural height without blank row padding',
  'U7 search uses two description slots and restores the pre-search ID after reorder',
  'U1.5 destructive actions keep the expanded list and warn in red on the same row before the second Enter',
  'U1.5 any other key disarms destructive confirmation; the next Enter never executes',
  'U1.6 plain mode removes every Plane-15 glyph from title, rows, info, descriptions, read and search input, including supplied symbols',
  'U1.7 every BMP PUA injection is removed from the entire output, including supplied tab symbols and search input',
  'U1.8 paths truncate in the middle and preserve their beginning and filename tail in rendered rows',
  'U1.9 directories are dockable; heading, disabled and tail rows cannot receive the cursor or execute',
  'U1.10 Escape unwinds read, search, child page, root closure one level at a time while retaining cursor and query',
  'U1.10 vanished search-return IDs dock near the old index, and page refresh preserves surviving IDs',
  'bounds: real frames stay within 24/40/80/120 columns across normal, search, confirm, read and resize states',
  'keys: enabled modules determine Tab hints and compact legends retain Esc',
  'compact English and Chinese key legends use their own locale, including rendered search descriptions',
  'PgUp/PgDn, Home/End and Ctrl-left/right are not consumed as panel navigation',
  'read regression: paragraphs expose their tails and resizing preserves the column anchor',
  '16-column regression: Chinese and English compact footers retain Esc',
  'Tab symbols: Plane-15 defaults, supplied icons and plain omission',
  'U2 switch requests are single-shot and leave current content untouched; readonly rows keep focus without executable Enter hints',
  'Agent labels drop the whole profile/model segment before truncating the retained id and subject',
  'five module projections keep compact geometry and readonly rows cannot execute',
] as const;
const key = { enter: '\r', esc: '\x1b', tab: '\t', shiftTab: '\x1b[Z', up: '\x1b[A', down: '\x1b[B', left: '\x1b[D', right: '\x1b[C' };
const rows = (n: number): PanelRow[] => Array.from({ length: n }, (_, i) => ({ id: `r${i}`, kind: 'action', label: `Row ${i}`, value: String(i), description: `Description ${i}\nSecond ${i}` }));
const identity = (value: string) => value;
function config(overrides: Partial<PanelConfig> = {}): PanelConfig {
  return { id: 'root', title: 'Panel', terminalRows: 30, sections: [{ id: 's0', label: 'Todos', rows: rows(20), lines: ['Status', 'Context'] }],
    createEditor: () => new Editor({ terminal: { rows: 30 }, requestRender() {} } as never, { borderColor: identity, selectList: { selectedPrefix: identity, selectedText: identity, description: identity, scrollInfo: identity, noMatch: identity } }, { paddingX: 0 }), ...overrides };
}
type Panel = ReturnType<typeof createPanel>;
const frame = (panel: Panel, width = 100) => panel.render(width).map(stripTerminalSequences);
const memory = (panel: Panel, page = 'root') => panel.memory.get(`${page}/s0`)!;
const lines = (panel: Panel) => frame(panel).join('\n');
function structure(panel: Panel, width = 100, height = 30) {
  const rendered = frame(panel, width), separators = rendered.flatMap((line, i) => /^─+$/.test(line) ? [i] : []);
  const budget = height <= 10 ? 4 : Math.max(9, height - 6);
  assert.ok(rendered.length <= Math.min(height - 1, budget), `height=${rendered.length} budget=${budget}`);
  assert.equal(separators[0], 1, 'tab bar then a full-width rule');
  assert.ok(separators.length >= 2); assert.ok(separators.length <= 4);
  assert.equal(rendered.length - separators.at(-1)!, 2, 'keys row closes the frame');
  for (const line of rendered) { assert.equal(visibleWidth(line), width); assert.doesNotMatch(line, /[┌┐┤┘]|^│|[├└](?!─)|[\r\n]/u); }
  assert.doesNotMatch(rendered.at(-1)!, /\d+\/\d+|第 .* 页|Page \d/);
  return { rendered, separators };
}

test(names[0], () => {
  for (const height of [24, 30, 42]) for (const count of [1, 2, 6]) {
    const panel = createPanel(config({ terminalRows: height, sections: Array.from({ length: count }, (_, i) => ({ id: `s${i}`, label: `Module ${i}`, rows: rows(20), lines: ['Info'] })) }));
    const initial = structure(panel, 100, height); panel.handleInput('j'); structure(panel, 100, height);
    if (height === 42) assert.ok(initial.rendered.length > 17, 'a tall terminal is no longer capped at 17 rows');
  }
});
test(names[1], () => {
  const panel = createPanel(config()); panel.handleInput('G'); panel.handleInput('j');
  const layout = structure(panel), capacity = layout.separators[2]! - layout.separators[1]! - 1;
  const upper = { ...memory(panel).upper }; panel.handleInput(key.right); assert.equal(memory(panel).index, capacity + 1);
  assert.deepEqual(memory(panel).upper, upper); assert.match(lines(panel), new RegExp(`> .*Row ${capacity + 1}`)); assert.doesNotMatch(lines(panel), /Row 0\s/);
  panel.handleInput(key.left); assert.equal(memory(panel).index, 1);
  for (let i = 0; i < 20; i++) panel.handleInput(key.right); assert.equal(memory(panel).index, 19);
  panel.handleInput('j'); assert.equal(memory(panel).index, 19);
  panel.handleInput('g'); panel.handleInput(key.right); assert.equal(memory(panel).zone, 'upper');
  const entries = rows(19);
  const skipping = createPanel(config({ sections: [{ id: 's0', label: 'Todos', rows: entries }] }));
  const skip = structure(skipping), size = skip.separators[1]! - skip.separators[0]! - 1;
  entries[size - 1]!.kind = 'heading'; entries[size]!.disabledReason = 'Unavailable';
  skipping.handleInput(key.right); assert.equal(memory(skipping).index, size + 1); assert.equal(memory(skipping).selectedId, `r${size + 1}`);
  const snapshot = entries.map(entry => ({ ...entry })); skipping.render(80); skipping.render(24); assert.deepEqual(entries, snapshot);
});
test(names[2], () => {
  const probe = structure(createPanel(config({ sections: [{ id: 's0', label: 'Todos', rows: rows(20) }] })));
  const size = probe.separators[1]! - probe.separators[0]! - 1; assert.ok(size > 1 && size <= 24, `single-zone capacity ${size}`);
  for (const count of [0, 1, 3, 8, 20]) {
    const panel = createPanel(config({ sections: [{ id: 's0', label: 'Todos', rows: rows(count) }] }));
    const { rendered, separators } = structure(panel);
    assert.equal(separators.length, 3);
    assert.equal(separators[1]! - separators[0]! - 1, Math.max(1, Math.min(size, count)));
    assert.equal(rendered.some(line => line.includes('暂无内容')), count === 0);
    const body = rendered.slice(separators[0]! + 1, separators[1]);
    assert.ok(body.length > 0 && body.every(line => line.trim().length > 0), 'the body is non-empty and blank-free');
  }
});
test(names[3], () => {
  const panel = createPanel(config()); panel.focused = true; panel.handleInput('G'); for (let i = 0; i < 4; i++) panel.handleInput('j');
  structure(panel); panel.handleInput('/'); panel.handleInput('Row 19');
  const result = structure(panel);
  assert.match(result.rendered[result.separators.at(-2)! + 1]!, /搜索：Row 19/); assert.match(lines(panel), /1 项匹配/);
  assert.match(lines(panel), /> .*Row 19/); panel.setPage({ id: 'root', title: 'Panel', sections: [{ id: 's0', label: 'Todos', lines: ['Status', 'Context'], rows: rows(20).reverse() }] }); panel.handleInput(key.esc); assert.equal(memory(panel).selectedId, 'r4'); assert.match(lines(panel), /> .*Row 4/);
});
test(names[4], () => {
  for (const zone of ['upper', 'lower'] as const) {
    const results: PanelResult[] = [], styles: { text: string; fg: string }[] = [];
    const entries: PanelRow[] = [{ id: 'parent', kind: 'entity', label: 'Alpha', children: [{ id: 'delete', kind: 'action', label: '删除会话', destructive: true, confirmation: { title: '删除 Alpha 的会话？', consequences: '会话删除；其他成员和信箱保留。', action: '删除' }, payload: 42 }] }, { id: 'neighbour', kind: 'action', label: 'Neighbour' }];
    const panel = createPanel(config({ theme: { style(text, options) { styles.push({ text, fg: String(options?.fg) }); return text; } }, sections: [{ id: 's0', label: 'Team', rows: zone === 'lower' ? entries : [{ id: 'global', kind: 'action', label: 'Global action' }], ...(zone === 'upper' ? { upper: () => ({ rows: entries }) } : {}) }], onResult: result => results.push(result) }));
    panel.handleInput(key.enter); const before = frame(panel), position = structuredClone(memory(panel));
    panel.handleInput(key.enter); const confirmed = frame(panel).join('\n');
    assert.equal(results.length, 0); assert.equal(frame(panel).length, before.length, 'confirmation does not replace the list layout');
    assert.match(confirmed, /Alpha/); assert.match(confirmed, /Neighbour/, 'neighbouring rows remain visible while armed');
    assert.match(confirmed, /删除 Alpha 的会话/); assert.match(confirmed, /其他成员和信箱保留/); assert.match(confirmed, /再次 Enter 删除/);
    assert.deepEqual(memory(panel), position, 'the expanded ancestry, cursor and viewport stay in place');
    assert.ok(styles.some(style => style.fg === 'error' && style.text.includes('再次 Enter 删除')), 'the action-specific warning is red on the original row');
    panel.handleInput(key.esc); assert.deepEqual(frame(panel), before, 'Esc restores the same expanded list');
    panel.handleInput(key.enter); panel.handleInput(key.enter);
    assert.deepEqual(results, [{ action: 'selected', kind: 'action', id: 'delete', payload: 42 }]);
  }
  for (const height of [6, 8, 10]) {
    const accepted: PanelResult[] = [];
    const small = createPanel(config({ terminalRows: height, sections: [{ id: 's0', label: 'Team', rows: [{ id: 'delete', kind: 'action', label: '删除会话', destructive: true, confirmation: { title: '删除编码成员？', consequences: '保留其他成员。'.repeat(20), action: '删除' } }] }], onResult: result => accepted.push(result) }));
    small.render(24); small.handleInput(key.enter);
    const compact = frame(small, 24);
    assert.ok(compact.length <= height - 1); assert.match(compact.at(-1)!, /Esc/);
    small.handleInput(key.enter); assert.equal(accepted.length, 1, 'the original two-Enter interaction does not require enlarging the window');
  }
});
test(names[5], () => {
  for (const cancel of ['x', 'j', 'k', 'h', 'l', '/', key.tab, key.shiftTab, key.up, key.down, key.left, key.right, '\x7f', key.esc, '\x1b[5~', '\x01', '\x03']) {
    const results: PanelResult[] = [], panel = createPanel(config({ sections: [{ id: 's0', label: 'Todos', rows: [{ id: 'delete', kind: 'action', label: 'Delete', destructive: true }] }], onResult: result => results.push(result) }));
    panel.handleInput(key.enter); panel.handleInput(cancel); assert.doesNotMatch(lines(panel), /待确认/);
    panel.handleInput(key.enter); assert.equal(results.filter(r => r.action === 'selected').length, 0);
  }
});
function injectedFrames(iconStyle: 'plain' | 'nerd-font', glyph: string) {
  const panel = createPanel(config({ iconStyle, title: `Title${glyph}`, symbols: { previous: glyph, next: glyph }, sections: [{ id: 's0', label: `Title${glyph}`, lines: [`Info${glyph}`], rows: [{ id: 'injected', kind: 'action', label: `Row${glyph}`, value: `Value${glyph}`, description: `Description${glyph}\nSecond${glyph}` }, { id: 'disabled', kind: 'action', label: 'Disabled', disabledReason: `Reason${glyph}` }] }] }));
  panel.focused = true; panel.handleInput('G'); const output = [lines(panel)];
  panel.read(`Read title${glyph}`, [`Read body${glyph}`]); output.push(lines(panel));
  panel.handleInput(key.esc); panel.handleInput('/'); panel.handleInput(glyph); output.push(lines(panel));
  return output.join('\n');
}
test(names[6], () => {
  const output = injectedFrames('plain', '\u{f0279}');
  assert.doesNotMatch(output, /[\u{f0000}-\u{ffffd}]/u);
  assert.match(output, /搜索：/); assert.match(output, /Description/); assert.match(output, /Info/); assert.match(output, /Read body/);
  for (const marker of ['Title', 'Row', 'Value', 'Reason', 'Read body']) assert.ok(output.includes(marker), marker);
});
test(names[7], () => {
  const output = injectedFrames('nerd-font', '\ue444');
  assert.doesNotMatch(output, /[\ue000-\uf8ff]/u);
  assert.match(output, /搜索：/); assert.match(output, /Description/); assert.match(output, /Info/); assert.match(output, /Read body/);
  for (const marker of ['Title', 'Row', 'Value', 'Reason', 'Read body']) assert.ok(output.includes(marker), marker);
});
test(names[8], () => {
  const value = '~/extensions/really-long-parent-path/websearch/index.ts';
  for (const width of [24, 32]) { const label = middleTruncate(value, width); assert.ok(label.startsWith('~/')); assert.ok(label.endsWith('index.ts')); assert.match(label, /…/); assert.ok(visibleWidth(label) <= width); }
  const path = '/root/project/' + 'really-long-directory/'.repeat(8) + 'final-report.test.ts';
  for (const width of [24, 40, 80, 120]) {
    const label = middleTruncate(path, width); assert.ok(label.startsWith('/root')); assert.ok(label.endsWith('report.test.ts')); assert.ok(visibleWidth(label) <= width);
    const panel = createPanel(config({ sections: [{ id: 's0', label: 'Todos', rows: [{ id: 'path', kind: 'action', label: path, path: true }] }] }));
    const rendered = frame(panel, width).find(line => line.startsWith('> '))!.trimEnd();
    assert.match(rendered, /^> .*\/r/); assert.match(rendered, /\.test\.ts$/); assert.match(rendered, /…/);
  }
  assert.equal(middleTruncate(path, 0), ''); assert.equal(middleTruncate(path, 1), '…');
});
test(names[9], () => {
  const entries = [{ id: 'c', label: 'Directory', kind: 'directory' }, { id: 'h', label: 'Heading', kind: 'heading' }, { id: 'd', kind: 'action', label: 'Disabled', disabledReason: 'No access' }, { id: 'a', kind: 'action', label: 'Allowed' }, { id: 't', label: 'Tail', kind: 'tail' }] as PanelRow[];
  assert.equal(dock(entries, 0, 1), 0); assert.equal(dock(entries, 4, -1), 3); assert.equal(entries.filter(canDock).length, 2);
  const result: PanelResult[] = [], panel = createPanel(config({ sections: [{ id: 's0', label: 'Todos', rows: entries }], onResult: item => result.push(item) }));
  for (const input of ['j', 'k', key.left, key.right]) panel.handleInput(input); assert.equal(memory(panel).selectedId, 'a'); panel.handleInput(key.enter); assert.equal(result[0]!.id, 'a');
  const blocked = entries.filter(entry => !canDock(entry)), empty: PanelResult[] = [], undockable = createPanel(config({ sections: [{ id: 's0', label: 'Todos', rows: blocked }], onResult: value => empty.push(value) }));
  assert.equal(dock(blocked, 0, 1), -1);
  for (const input of [key.enter, 'j', 'k', key.left, key.right, key.enter]) undockable.handleInput(input);
  assert.equal(memory(undockable).index, -1); assert.equal(memory(undockable).selectedId, undefined); assert.doesNotMatch(lines(undockable), /> /); assert.deepEqual(empty, []);
});
test(names[10], () => {
  const result: PanelResult[] = [], panel = createPanel(config({ onResult: item => result.push(item) }));
  panel.handleInput('G'); panel.handleInput('j'); panel.handleInput('/'); panel.handleInput('Row');
  panel.read('Report', ['Text']); panel.render(100); panel.handleInput(key.esc); assert.equal(result.at(-1)!.payload, 'read');
  panel.setPage({ id: 'child', title: 'Child', sections: [{ id: 's0', label: 'Todos', rows: rows(2) }] }); panel.handleInput(key.esc); assert.equal(result.at(-1)!.action, 'back');
  panel.handleInput(key.esc); panel.handleInput(key.esc); assert.equal(result.at(-1)!.action, 'closed');
});
test(names[11], () => {
  const entries = rows(8), panel = createPanel(config({ sections: [{ id: 's0', label: 'Todos', rows: entries }] }));
  panel.handleInput('j'); panel.handleInput('j'); assert.equal(memory(panel).selectedId, 'r2');
  panel.setPage({ id: 'root', title: 'Root', sections: [{ id: 's0', label: 'Todos', rows: [...entries].reverse() }] }); assert.equal(memory(panel).selectedId, 'r2');
  panel.setPage({ id: 'root', title: 'Root', sections: [{ id: 's0', label: 'Todos', rows: entries.filter(row => row.id !== 'r2') }] }); assert.ok(memory(panel).selectedId); assert.notEqual(memory(panel).selectedId, 'r2');
  const missing = createPanel(config({ sections: [{ id: 's0', label: 'Todos', rows: rows(8) }] }));
  for (let at = 0; at < 3; at++) missing.handleInput('j'); missing.handleInput('/'); missing.handleInput('Row 6');
  const updated = rows(8).filter(row => row.id !== 'r3'); updated[3]!.kind = 'heading';
  missing.setPage({ id: 'root', title: 'Updated', sections: [{ id: 's0', label: 'Todos', rows: updated }] }); missing.handleInput(key.esc);
  assert.equal(memory(missing).selectedId, 'r5'); assert.equal(memory(missing).index, 4); assert.match(lines(missing), /> .*Row 5/);
  missing.setPage({ id: 'root', title: 'Reordered', sections: [{ id: 's0', label: 'Todos', rows: [updated[4]!, ...updated.slice(0, 4), ...updated.slice(5)] }] });
  assert.equal(memory(missing).selectedId, 'r5'); assert.equal(memory(missing).index, 0); assert.match(lines(missing), /> .*Row 5/);
});
test(names[12], () => {
  for (const width of [24, 40, 80, 120]) for (const height of [24, 30]) {
    const panel = createPanel(config({ terminalRows: height })); panel.focused = true; structure(panel, width, height);
    panel.handleInput('/'); panel.handleInput('Row'); structure(panel, width, height); panel.handleInput(key.esc);
    panel.handleInput('G'); panel.input({ title: 'Value', value: 'draft' }); structure(panel, width, height);
    panel.handleInput(key.esc); panel.read('Long', ['body '.repeat(30)]); structure(panel, width, height);
  }
});
test(names[13], () => {
  for (const width of [16, 40, 120]) {
    assert.doesNotMatch(panelKeys(width, true, 1, true), /Tab/); assert.match(panelKeys(width, true, 6, true), /Esc/);
    assert.doesNotMatch(panelKeys(width, false, 6, true), /Enter/); assert.doesNotMatch(panelKeys(width, true, 6, true), /\d+\/\d+/);
  }
});
test(names[14], () => {
  for (const locale of ['zh-CN', 'en'] as const) {
    const panel = createPanel(config({ msg: createTranslator(locale) })); panel.handleInput('/'); panel.handleInput('Status');
    const output = lines(panel); assert.match(output, locale === 'en' ? /Search: Status/ : /搜索：Status/); if (locale === 'en') assert.doesNotMatch(output, /[\u3400-\u9fff]/u);
  }
});
test(names[15], () => {
  const panel = createPanel(config()); const before = lines(panel);
  for (const input of ['\x1b[5~', '\x1b[6~', '\x1b[H', '\x1b[F', '\x1bOH', '\x1bOF', '\x1b[1~', '\x1b[4~', '\x1b[1;5D', '\x1b[1;5C']) { panel.handleInput(input); assert.equal(lines(panel), before); }
});
test(names[16], () => {
  const panel = createPanel(config()); panel.read('Report', ['START' + 'x'.repeat(200) + ' END_SENTINEL']);
  let found = false; for (let n = 0; n < 210; n++) { structure(panel, 56); found ||= frame(panel, 56).join('\n').includes('END_SENTINEL'); panel.handleInput('j'); }
  assert.ok(found); assert.match(frame(panel, 56).join('\n'), /END_SENTINEL/);
  const paragraph = Array.from({ length: 300 }, (_, index) => `c${String(index).padStart(3, '0')}|`).join('');
  panel.read('Resize anchor', ['P'.repeat(121), paragraph, 'FINAL_PARAGRAPH']);
  // The reader body scrolls in the lower zone, so its first line is found rather than assumed at row 2.
  const bodyStart = (width: number) => { const rendered = frame(panel, width); return rendered.findIndex(line => /P{20,}|c\d{3}\|/.test(line)); };
  assert.equal(frame(panel, 56)[bodyStart(56)]!.slice(2), 'P'.repeat(54));
  for (let index = 0; index < 9; index++) { panel.handleInput('j'); frame(panel, 56); }
  assert.equal(frame(panel, 56)[bodyStart(56)]!.slice(2), paragraph.slice(324, 378));
  assert.equal(frame(panel, 32)[bodyStart(32)]!.slice(2), paragraph.slice(300, 330));
  assert.equal(frame(panel, 100)[bodyStart(100)]!.slice(2), paragraph.slice(294, 392));
  assert.equal(frame(panel, 100)[bodyStart(100)]!.slice(2), paragraph.slice(294, 392));
  panel.resize(42); structure(panel, 80, 42);
});
test(names[17], () => { for (const locale of ['zh-CN', 'en'] as const) { const panel = createPanel(config({ msg: createTranslator(locale) })); assert.match(frame(panel, 16).at(-1)!, /Esc/); } });
test(names[18], () => {
  const panel = createPanel(config({ symbols: { previous: '<PREV>', next: '<NEXT>' } })); assert.match(frame(panel, 200)[0]!, /Todos/);
  assert.doesNotMatch(frame(panel, 24).at(-1)!, /<PREV>|<NEXT>/);
  assert.doesNotMatch(frame(createPanel(config({ iconStyle: 'plain' })), 200).at(-1)!, /[\u{f0000}-\u{ffffd}]/u);
});
test(names[19], () => {
  const result: PanelResult[] = [], panel = createPanel(config({ sections: [{ id: 's0', label: 'Todos', rows: rows(2) }, { id: 's1', label: 'Plan', rows: [] }], onResult: item => result.push(item) }));
  const before = lines(panel); panel.handleInput(key.tab); panel.handleInput(key.tab); assert.deepEqual(result, [{ action: 'switch', id: 's1' }]); assert.equal(lines(panel), before);
  const readonly = createPanel(config({ sections: [{ id: 's0', label: 'Plan', rows: rows(5).map(row => ({ ...row, kind: 'readonly' })) }], onResult: item => result.push(item) }));
  readonly.handleInput(key.enter); assert.equal(result.length, 1); assert.doesNotMatch(frame(readonly).at(-1)!, /Enter/);
});
test(names[20], () => {
  const panel = createPanel(config({ sections: [{ id: 's0', label: 'Agents', rows: [{ id: 'a1', kind: 'action', label: 'a1 · actual-running-model-with-a-long-name Short work', compactLabel: 'a1 Short work', value: 'Running' }] }] }));
  assert.match(frame(panel, 120).join('\n'), /a1 · actual-running-model-with-a-long-name Short work/);
  const narrow = frame(panel, 36).find(line => line.startsWith('> '))!; assert.match(narrow, /a1 Short work/); assert.match(narrow, /Running/); assert.doesNotMatch(narrow, /actual-running|a1 ·/);
  assert.equal(modelLabel('gemini-3.8-flash-high', 18), 'gemini-3.8-flash');
  assert.equal(modelLabel('gemini-3.1-pro-preview-thinking-128', 14), 'gemini-3.1-pro');
  assert.equal(modelLabel('claude-haiku-4-5-20251001', 16), 'claude-haiku-4-5');
  assert.equal(modelLabel('ns:model-family-flash', 17), 'model-fa…ly-flash');
  assert.match(modelLabel('ns:model-family-flash', 17, false), /^ns:/);
  assert.equal(modelLabel('reviewbot-model', 6), ''); assert.equal(modelLabel('model-b-flash', 6), 'model');
});
test(names[21], () => {
  for (const label of ['Todos', 'Plan', 'Goal', 'Agents', 'Retry']) {
    const panel = createPanel(config({ sections: [{ id: 's0', label, rows: rows(12).map(row => ({ ...row, ...(label === 'Plan' ? { kind: 'readonly' as const } : {}) })), lines: ['Status', 'Context'] }] }));
    structure(panel); if (label === 'Plan') assert.doesNotMatch(frame(panel).at(-1)!, /Enter/);
  }
});

test('U7 tree content is byte-identical to GUI rows with a separate two-column cursor slot', () => {
  const state: WorkflowState = { version: 1, plan: false, planTools: [], visible: true, view: 'list', treeStyle: 'paths', nextId: 4, tasks: [{ id: 1, subject: 'Root', status: 'pending', blockedBy: [] }, { id: 2, subject: 'Child', status: 'in_progress', blockedBy: [1] }, { id: 3, subject: 'Other root', status: 'completed', blockedBy: [] }] };
  for (const width of [40, 64, 92, 120]) {
    const tree = renderTaskTree(state, width - 2, { maxRows: Infinity }), gui = renderTasks(state, width - 2, { maxRows: Infinity });
    assert.deepEqual([tree.title, ...tree.rows.map(row => row.text)], gui);
    const panel = createPanel(config({ sections: [{ id: 's0', label: 'Todos', rows: rows(2), upper: () => ({ title: tree.title, rows: tree.rows.map(row => ({ id: String(row.taskId), kind: 'action' as const, label: row.text, text: row.text })) }) }] }));
    const { rendered } = structure(panel, width);
    assert.deepEqual(rendered.slice(2, 5).map(line => line.slice(2)), gui.slice(1));
    assert.match(rendered.join('\n'), /├─/); assert.match(rendered.join('\n'), /└─/); assert.ok(rendered.some(line => /^ {2,}│/.test(line)));
    assert.match(rendered.join('\n'), /\[主会话\].*\[待执行\]/);
  }
});
test('U7 Input and Editor submit, cancel, preserve drafts and accept navigation characters as text', () => {
  const result: PanelResult[] = [], panel = createPanel(config({ onResult: value => result.push(value) })); panel.focused = true; panel.handleInput('G');
  panel.input({ title: 'Title', value: 'original' }); panel.handleInput('hjkl'); assert.ok(panel.render(100).some(line => line.includes(CURSOR_MARKER))); panel.handleInput(key.enter);
  assert.equal(result.at(-1)!.payload, 'originalhjkl');
  panel.edit({ title: 'Body', value: 'one' }); panel.handleInput('\x1b[13;2u'); panel.handleInput('two'); structure(panel); panel.handleInput(key.enter); assert.equal(result.at(-1)!.payload, 'one\ntwo');
  panel.input({ title: 'Cancel', value: 'kept' }); panel.handleInput('x'); panel.handleInput(key.esc); assert.equal(result.at(-1)!.action, 'back');
  panel.confirm('Confirm', 'Consequences'); panel.handleInput('x'); assert.equal(result.at(-1)!.payload, false);
  panel.confirm('Confirm', 'Consequences'); panel.handleInput(key.enter); assert.equal(result.at(-1)!.payload, true);
});
test('U7 model ladder keeps versions/parameter counts and applies budgets to public model samples', () => {
  const samples = ['gemini-3.8-flash-high', 'gemini-3.1-pro-preview-thinking-128', 'claude-haiku-4-5-20251001', 'claude-opus-4-6-thinking', 'gpt-oss-120b-medium', 'model-b-flash', 'ns:model-family-flash', 'reviewbot-model'];
  for (const width of [40, 64, 92, 120]) for (const sample of samples) { const budget = modelBudget(width), label = modelLabel(sample, budget); assert.ok(visibleWidth(label) <= budget); assert.notEqual(label, '…'); }
  assert.equal(modelBudget(40), 7); assert.equal(modelBudget(120), 18);
  assert.equal(modelLabel('claude-opus-4-6-thinking', 15), 'claude-opus-4-6'); assert.equal(modelLabel('gpt-oss-120b-medium', 12), 'gpt-oss-120b');
  assert.equal(modelLabel('reviewbot-model', 8), ''); assert.equal(modelLabel('reviewbot-model', 4), '');
  assert.match(modelLabel('gemini-3.1-pro-preview-thinking-128', 9), /^.{4}….{4}$/u);
  const expected = [
    ['gemini', 'gemin…flash', 'gemini-3.8-flash', 'gemini-3.8-flash'],
    ['gemini', 'gemin…1-pro', 'gemini-3.1-pro', 'gemini-3.1-pro'],
    ['claude', 'claud…u-4-5', 'claude-haiku-4-5', 'claude-haiku-4-5'],
    ['claude', 'claud…s-4-6', 'claude-opus-4-6', 'claude-opus-4-6'],
    ['gpt', 'gpt-o…-120b', 'gpt-oss-120b', 'gpt-oss-120b'],
    ['model', 'model…flash', 'model-b-flash', 'model-b-flash'],
    ['model', 'model…flash', 'model-fa…y-flash', 'model-family-flash'],
    ['', 'revie…model', 'reviewbot-model', 'reviewbot-model'],
  ];
  samples.forEach((sample, row) => [40, 64, 92, 120].forEach((width, column) => assert.equal(modelLabel(sample, modelBudget(width)), expected[row]![column], `${sample} at ${width}`)));
});

test('U7 value columns align on the left and navigation crosses zones without cross-zone fast scrolling', () => {
  const panel = createPanel(config({ sections: [{ id: 's0', label: 'Todos', lines: ['Upper 0', 'Upper 1', 'Upper 2'], rows: [{ id: 'a', kind: 'action', label: 'Short', value: 'ON' }, { id: 'b', kind: 'action', label: 'Lengthier', value: 'OFF' }] }] }));
  panel.handleInput('j'); panel.handleInput('j'); panel.handleInput('j'); assert.equal(memory(panel).zone, 'lower'); assert.equal(memory(panel).selectedId, 'a');
  panel.handleInput('k'); assert.equal(memory(panel).zone, 'upper'); assert.equal(memory(panel).upper!.index, 2);
  panel.handleInput('g'); assert.equal(memory(panel).upper!.index, 0); panel.handleInput('G'); assert.equal(memory(panel).index, 0);
  const before = { ...memory(panel).upper }; panel.handleInput(key.right); assert.equal(memory(panel).selectedId, 'b'); assert.deepEqual(memory(panel).upper, before);
  for (const width of [40, 64, 92, 120]) {
    const { rendered, separators } = structure(panel, width), lower = rendered.slice(separators[1]! + 1, separators[2]);
    const on = lower.find(line => line.includes('ON'))!, off = lower.find(line => line.includes('OFF'))!;
    assert.equal(on.indexOf('ON'), off.indexOf('OFF')); assert.equal(visibleWidth(on.slice(0, on.indexOf('ON'))), 15);
    assert.doesNotMatch(lower.join('\n'), /\.{2,}/); assert.match(on, /ON {3,}$/);
  }
});

test('U7 accordion expansion is exclusive, leaves lower rows anchored and folds to its parent', () => {
  const results: PanelResult[] = [], entities: PanelRow[] = Array.from({ length: 6 }, (_, index) => ({ id: `entity${index}`, kind: 'entity', label: `Entity ${index}`, text: `├─ #${index + 1} Entity ${index}`, prefix: '│    ', children: [{ id: `entity${index}:edit`, kind: 'action', label: `Edit ${index}` }, { id: `entity${index}:delete`, kind: 'action', label: `Delete ${index}`, destructive: true }] }));
  const panel = createPanel(config({ sections: [{ id: 's0', label: 'Todos', single: false, rows: rows(4), upper: () => ({ rows: entities }) }], onResult: result => results.push(result) }));
  const before = structure(panel, 96), configRows = before.rendered.slice(before.separators[1], before.separators[2]! + 1);
  panel.handleInput(key.enter); const after = structure(panel, 96);
  assert.equal(memory(panel).expandedId, 'entity0'); assert.equal(memory(panel).upper!.selectedId, 'entity0:edit'); assert.deepEqual(results, []);
  // Ticket 12 rebalances the body: the entity zone takes the slack and the config zone keeps a floor,
  // so the parent, its actions and the neighbour all stay visible without starving the config rows.
  assert.equal(after.rendered.length, before.rendered.length + 2, 'the two expanded actions use available height rather than a fixed shell');
  assert.ok(after.separators[2]! - after.separators[1]! >= 3, 'the config zone keeps at least three rows');
  assert.match(after.rendered.slice(after.separators[1]! + 1, after.separators[2]).join('\n'), /Filter|Row 0/, 'config stays readable');
  assert.ok(after.rendered.some(line => /│ +> .*Edit 0/.test(line)));
  assert.ok(after.rendered.some(line => /Entity 1/.test(line)), 'the neighbour stays visible');
  panel.focused = true; panel.input({ title: 'Scoped input', value: 'kept' }); panel.handleInput('hjkl'); assert.ok(panel.render(96).some(line => line.includes(CURSOR_MARKER))); panel.handleInput(key.esc);
  panel.handleInput(key.esc); assert.equal(memory(panel).expandedId, undefined); assert.equal(memory(panel).upper!.selectedId, 'entity0');
  panel.handleInput('j'); panel.handleInput(key.enter); assert.equal(memory(panel).expandedId, 'entity1'); assert.match(frame(panel, 96).join('\n'), /Edit 1/); assert.doesNotMatch(frame(panel, 96).join('\n'), /Edit 0/);
  panel.handleInput(key.esc); assert.equal(memory(panel).upper!.selectedId, 'entity1');
  assert.deepEqual(structure(panel, 96).separators, before.separators, 'folding restores the anchored config rows');
  assert.ok(configRows.length >= 1);
});

test('U7 dual-zone lower entities expand in place and survive rendering the other zone', () => {
  const results: PanelResult[] = [], panel = createPanel(config({ sections: [{ id: 's0', label: 'Team', single: false, upper: () => ({ rows: [{ id: 'upper-entity', kind: 'entity', label: 'Upper', children: [{ id: 'upper-action', kind: 'action', label: 'Upper action' }] }] }), rows: [{ id: 'lower-entity', kind: 'entity', label: 'Lower task', children: [{ id: 'lower-action', kind: 'action', label: 'Legacy return' }] }] }], onResult: result => results.push(result) }));
  panel.handleInput('G'); panel.handleInput(key.enter);
  assert.equal(memory(panel).expandedId, 'lower-entity');
  assert.match(lines(panel), /Legacy return/);
  panel.handleInput('g'); assert.match(lines(panel), /Upper/);
  assert.equal(memory(panel).expandedId, 'lower-entity', 'rendering a zone without the expanded row must not clear it');
  panel.handleInput('G'); assert.match(lines(panel), /Legacy return/);
  panel.handleInput('j'); panel.handleInput(key.enter); assert.deepEqual(results, [{ action: 'selected', kind: 'action', id: 'lower-action' }], 'the lower child action remains executable');
  panel.handleInput('h'); assert.equal(memory(panel).expandedId, undefined, 'the lower accordion folds back to its parent');
});

test('U7 defect A: expanding below the budget grows the panel instead of hiding the parent and its neighbours', () => {
  const entities: PanelRow[] = [0, 1].map(index => ({ id: `entity${index}`, kind: 'entity', label: `Entity ${index}`, text: `├─ #${index + 1} Entity ${index}`, children: [{ id: `entity${index}:edit`, kind: 'action', label: `Edit ${index}` }, { id: `entity${index}:delete`, kind: 'action', label: `Delete ${index}` }] }));
  const panel = createPanel(config({ terminalRows: 30, sections: [{ id: 's0', label: 'Todos', single: false, rows: rows(4), upper: () => ({ rows: entities }) }] }));
  const before = structure(panel, 96);
  panel.handleInput(key.enter); const after = structure(panel, 96);
  assert.equal(memory(panel).expandedId, 'entity0');
  assert.equal(after.rendered.length, before.rendered.length + 2, 'two child rows grow the viewport');
  assert.ok(after.rendered.some(line => /Entity 0/.test(line)) && after.rendered.some(line => /Entity 1/.test(line)), 'parent and neighbour stay visible');
  assert.ok(after.rendered.some(line => /Edit 0/.test(line)) && after.rendered.some(line => /Delete 0/.test(line)), 'expanded children stay visible');
  assert.deepEqual(after.rendered.slice(after.separators[1], after.separators[2]! + 1), before.rendered.slice(before.separators[1], before.separators[2]! + 1), 'lower config stays anchored');
});

test('U7 upper states use right-aligned dim dotted leaders; single-zone values stay left aligned', () => {
  const panel = createPanel(config({ sections: [{ id: 's0', label: 'Plan', single: false, rows: [{ id: 'summary', kind: 'action', label: 'Summary', value: 'On' }], upper: () => ({ rows: [{ id: 'mode', label: 'Mode', value: 'Normal', kind: 'readonly' }] }) }] }));
  for (const width of [40, 64, 96, 120]) {
    const layout = structure(panel, width), state = layout.rendered[2]!;
    assert.match(state, /Mode \.{3,} \[Normal\]$/); assert.equal(visibleWidth(state), width);
    assert.doesNotMatch(layout.rendered.slice(layout.separators[1]! + 1, layout.separators[2]).join('\n'), /\.{2,}/);
  }
  const single = createPanel(config({ iconStyle: 'plain', sections: [{ id: 's0', label: 'Display', single: true, rows: [{ id: 'a', kind: 'action', label: 'Icon style', value: 'Plain' }, { id: 'b', kind: 'action', label: 'Language', value: 'English' }] }] }));
  const layout = structure(single, 80); assert.equal(layout.separators.length, 3); assert.doesNotMatch(layout.rendered.at(-1)!, /g\/G/, 'single-zone panels have no zone jump');
  assert.equal(layout.rendered[2]!.indexOf('Plain'), layout.rendered[3]!.indexOf('English')); assert.doesNotMatch(layout.rendered.join('\n'), /[\u{f0000}-\u{ffffd}\ue000-\uf8ff]/u);
});

test('U7 D1 expansion reserves dual/single shells before growing entity viewports', () => {
  for (const single of [false, true]) for (const height of [16, 20, 24, 30, 40]) for (const children of [2, 9]) {
    const entities = rows(6).map(row => ({ ...row, kind: 'entity' as const, children: rows(children).map(child => ({ ...child, id: `${row.id}:${child.id}` })) }));
    const panel = createPanel(config({ terminalRows: height, sections: [{ id: 's0', label: 'Agents', single, rows: single ? [] : rows(4), upper: () => ({ rows: entities }) }] }));
    const before = structure(panel, 96, height); panel.handleInput(key.enter); const after = structure(panel, 96, height);
    for (const layout of [before, after]) {
      assert.equal(layout.separators.length, single ? 3 : 4);
      assert.equal(layout.separators.at(-1)! - layout.separators.at(-2)! - 1, 2, 'two permanent hint slots, including blank descriptions');
      if (!single) assert.ok(layout.separators[2]! - layout.separators[1]! - 1 >= 1, 'config viewport keeps a row');
      assert.ok(layout.rendered.some(line => /r0:|Row 0/.test(line)), 'focus remains visible');
    }
    panel.handleInput(key.esc); assert.deepEqual(frame(panel, 96), before.rendered, 'folding restores the whole frame');
  }
  for (const height of [11, 14, 15]) {
    // Distinct lower labels: a same-named upper row must not be able to satisfy the config assertion.
    const settings = rows(4).map((row, index) => ({ ...row, id: `config${index}`, label: `Config ${index}` }));
    const panel = createPanel(config({ terminalRows: height, sections: [{ id: 's0', label: 'Agents', single: false, rows: settings, upper: () => ({ rows: rows(6).map(row => ({ ...row, kind: 'entity' as const, children: rows(2) })) }) }] }));
    for (const expanded of [false, true]) {
      if (expanded) panel.handleInput(key.enter);
      const { rendered, separators } = structure(panel, 96, height);
      // R58: a nine-row budget drops hints (2 -> 1) before any rule, so all four rules stay.
      assert.equal(separators.length, 4, 'nine-row dual-zone budgets keep four rules and lose one hint');
      assert.equal(separators.at(-1)! - separators.at(-2)! - 1, 1, 'one hint slot remains');
      assert.equal(rendered.length, 9);
      assert.ok(rendered.some(line => /Config 0/.test(line)), 'lower config keeps a visible row');
      assert.ok(rendered.some(line => /Row 0/.test(line)), 'upper entity stays visible');
    }
  }
  for (const height of [8, 10]) {
    const panel = createPanel(config({ terminalRows: height })), rendered = frame(panel, 96);
    assert.equal(rendered.filter(line => /^─+$/.test(line)).length, 1);
    assert.equal(rendered.length, 4); assert.match(rendered.at(-1)!, /Esc/);
  }
});

test('U7 bracketed single/double values preserve their semantic tone and final-column overflow marker', () => {
  const styles: { text: string; fg: string }[] = [];
  const theme: Pick<Theme, 'style'> = { style(text, options) { styles.push({ text, fg: String(options.fg) }); return text; } };
  const upper: PanelRow[] = [{ id: 'retry', kind: 'action', label: 'Retry', value: '关闭', valueTone: 'dim' }, { id: 'review', kind: 'action', label: 'review', values: [{ text: 'claude-opus-4-6', tone: 'muted' }, { text: '继承工具', tone: 'muted' }] }, ...rows(5)];
  const panel = createPanel(config({ theme, terminalRows: 14, sections: [{ id: 's0', label: 'Agents', single: false, rows: rows(1), upper: () => ({ rows: upper }) }] }));
  let rendered = frame(panel, 96);
  assert.match(rendered[2]!, /\[关闭\].*[↓↕]$/);
  assert.equal(visibleWidth(rendered[2]!), 96);
  panel.handleInput('j'); rendered = frame(panel, 96);
  assert.match(rendered[2]!, /\[claude-opus-4-6\] \[继承工具\].*[↓↕]$/);
  assert.ok(styles.some(style => style.text === '关闭' && style.fg === 'dim'));
  assert.ok(styles.some(style => style.text === 'claude-opus-4-6' && style.fg === 'muted'));
});

test('U7 value tone inference covers states and respects explicit secondary values', () => {
  for (const [value, tone] of [['开启', 'accent'], ['关闭', 'dim'], ['3 项', 'dim'], ['已完成', 'success'], ['失败', 'error'], ['等待', 'warning'], ['5m, 10m', 'muted']]) assert.equal(valueToneFor(value!), tone);
  for (const explicit of ['accent', 'success', 'warning', 'error', 'muted', 'dim'] as const) {
    const styles: { text: string; fg: string }[] = [];
    const panel = createPanel(config({ theme: { style(text, options) { styles.push({ text, fg: String(options.fg) }); return text; } }, sections: [{ id: 's0', label: 'Agents', single: false, rows: [{ id: 'settings', kind: 'action', label: 'Settings', value: '开启', valueTone: explicit }], upper: () => ({ rows: [{ id: 'state', kind: 'action', label: 'State', value: '开启', valueTone: explicit }, { id: 'parts', kind: 'action', label: 'Parts', values: [{ text: '开启', tone: explicit }] }] }) }] }));
    panel.render(96);
    assert.equal(styles.filter(style => style.text === '开启').length, 3);
    assert.ok(styles.filter(style => style.text === '开启').every(style => style.fg === (explicit === 'dim' ? 'accent' : explicit)));
  }
});

test('U7 subscreen depth guides all content and reading rows; Esc preserves parent focus and scroll', () => {
  const panel = createPanel(config({ id: 'agents:root', sections: [{ id: 's0', label: 'Agents', rows: rows(20) }] }));
  for (let index = 0; index < 12; index++) panel.handleInput('j');
  const parent = frame(panel, 96), saved = { ...memory(panel, 'agents:root') };
  panel.setPage({ id: 'agents:child', title: 'Models', sections: [{ id: 's0', label: 'Agents', single: false, upper: () => ({ rows: rows(2) }), rows: rows(2) }] });
  let rendered = frame(panel, 96);
  assert.match(rendered[0]!, /Agents › Models/);
  assert.ok(rendered.slice(2, -1).filter(line => !/^─+$/.test(line)).every(line => line.startsWith('│ ')));
  panel.setPage({ id: 'agents:grandchild', title: 'Detail', sections: [{ id: 's0', label: 'Agents', rows: rows(2) }] });
  panel.read('Full text', ['Original readable body']); rendered = frame(panel, 96);
  assert.match(rendered[0]!, /Agents › Detail/);
  assert.ok(rendered.slice(2, -1).filter(line => !/^─+$/.test(line)).every(line => line.startsWith('│ │ ')));
  panel.handleInput(key.esc); panel.handleInput(key.esc); assert.match(frame(panel, 96)[0]!, /Agents › Models/);
  panel.handleInput(key.esc); assert.deepEqual(frame(panel, 96), parent);
  assert.deepEqual(memory(panel, 'agents:root'), saved);
});

test('ticket03 kind markers render in the permitted positions and never on tree or readonly rows', () => {
  const panel = createPanel(config({ sections: [{ id: 's0', label: 'Agents', rows: [
    { id: 'entity', label: 'Profile', kind: 'entity', children: [{ id: 'field', label: 'Field', value: 'v', kind: 'readonly' }, { id: 'nested', label: 'Nested entity', kind: 'entity' }] },
    { id: 'input', label: 'Input', value: 'value', kind: 'input' }, { id: 'cycle', label: 'Cycle', value: 'one', choices: ['one', 'two'], kind: 'cycle' },
    { id: 'directory', label: 'Directory', kind: 'directory' }, { id: 'toggle', label: 'Toggle', value: 'on', kind: 'toggle' },
    { id: 'action', label: 'Action', kind: 'action' }, { id: 'readonly', label: 'Readonly', value: 'status', kind: 'readonly' },
  ] }] }));
  let output = frame(panel).join('\n');
  const rowLine = (label: string) => output.split('\n').find(line => line.includes(label))!;
  assert.match(rowLine('Profile'), /\u{f0142}/u); assert.match(rowLine('Input'), /\u{f03eb}/u); assert.match(rowLine('Cycle'), /\u{f0450}/u); assert.doesNotMatch(rowLine('Directory'), /[›…»]/u, 'directory rows carry no tail marker');
  for (const label of ['Input', 'Cycle', 'Directory', 'Toggle', 'Action', 'Readonly']) assert.doesNotMatch(rowLine(label), /\u{f0142}|\u{f0140}/u, `${label} is not an entity`);
  for (const label of ['Profile', 'Cycle', 'Directory', 'Toggle', 'Action', 'Readonly']) assert.doesNotMatch(rowLine(label), /\u{f03eb}/u, `${label} is not an input`);
  for (const label of ['Profile', 'Input', 'Directory', 'Toggle', 'Action', 'Readonly']) assert.doesNotMatch(rowLine(label), /\u{f0450}/u, `${label} is not a cycle`);
  for (const label of ['Profile', 'Input', 'Cycle', 'Toggle', 'Action', 'Readonly']) assert.doesNotMatch(rowLine(label), /[›…»]/u, `${label} is not a directory`);
  panel.handleInput(key.enter); output = frame(panel).join('\n');
  assert.match(output, /\u{f0140} .*Profile/u); assert.doesNotMatch(output, /\u{f0142} .*Profile/u);
  assert.doesNotMatch(rowLine('Field'), /\u{f0142}|\u{f0140}|[›…»]|\u{f0450}|\u{f03eb}/u);
  assert.doesNotMatch(rowLine('Nested entity'), /\u{f0142}|\u{f0140}|▸|▾/u, 'expanded child entities do not repeat an accordion arrow');
  const tree = createPanel(config({ sections: [{ id: 's0', label: 'Todos', single: false, upper: () => ({ rows: [{ id: 'tree', label: 'Task', text: '├─ Task', kind: 'entity', children: [] }] }), rows: [] }] }));
  const treeFrame = frame(tree).join('\n'); assert.match(treeFrame, /├─ Task/u); assert.doesNotMatch(treeFrame, /(?:\u{f0142}|\u{f0140}|▸|▾)\s+Task/u);
  const plain = createPanel(config({ iconStyle: 'plain', sections: [{ id: 's0', label: 'Agents', rows: [
    { id: 'entity', label: 'Profile', kind: 'entity', children: [{ id: 'plain-field', label: 'Model', value: 'Scripted', kind: 'readonly' }] }, { id: 'input', label: 'Input', kind: 'input' },
    { id: 'cycle', label: 'Cycle', kind: 'cycle' }, { id: 'directory', label: 'Directory', kind: 'directory' },
  ] }] }));
  const plainFrame = frame(plain).join('\n');
  for (const glyph of ['▸', '✎', '⟳']) assert.ok(plainFrame.includes(glyph), glyph);
  for (const label of ['Profile', 'Input', 'Cycle', 'Directory']) {
    const line = frame(plain).find(value => value.includes(label))!;
    const expected = label === 'Profile' ? '▸' : label === 'Input' ? '✎' : label === 'Cycle' ? '⟳' : '';
    for (const glyph of ['▸', '✎', '⟳', '›']) assert.equal(line.includes(glyph), glyph === expected, `${label}: ${glyph}`);
  }
  plain.handleInput(key.enter); assert.match(frame(plain).find(line => line.includes('Profile'))!, /▾/);
  assert.doesNotMatch(plainFrame, /[\u{f0000}-\u{ffffd}\ue000-\uf8ff]/u);
});

test('ticket03 each expansion layer indents its label by exactly three columns', () => {
  const paints: { text: string; fg: string }[] = [];
  // Plain mode removes icon widths so the label start column is the only variable.
  const panel = createPanel(config({ iconStyle: 'plain', theme: { style: (text: string, options: { fg: string }) => { paints.push({ text, fg: options.fg }); return text; } } as never, sections: [{ id: 's0', label: 'Agents', rows: [{ id: 'entity', label: 'Profile', kind: 'entity', children: [
    { id: 'action', label: 'Action', kind: 'action' }, { id: 'field', label: 'Field', value: 'v', kind: 'readonly' },
  ] }] }] }));
  panel.handleInput(key.enter); const output = frame(panel), parent = output.find(line => line.includes('Profile'))!, field = output.find(line => line.includes('Field'))!, action = output.find(line => line.includes('Action'))!;
  assert.match(parent, /▾ .*Profile/u);
  const start = (line: string, label: string) => line.indexOf(label);
  assert.equal(start(field, 'Field') - start(parent, 'Profile'), 3, 'SPEC R59: label start differs by 3 per layer');
  assert.equal(start(action, 'Action') - start(parent, 'Profile'), 3, 'actions of the same entity share one layer');
  assert.equal([...field.slice(0, start(field, 'Field'))].filter(char => char === '│').length, 1);
  const divider = output.filter(line => /^\s*│\s+─+\s*$/.test(line)); assert.equal(divider.length, 1); assert.ok((divider[0]!.match(/─+/)?.[0].length ?? 100) < 100);
  assert.ok(output.indexOf(field) < output.indexOf(divider[0]!) && output.indexOf(divider[0]!) < output.indexOf(action), 'fields precede the divider and actions follow it');
  assert.ok(paints.some(paint => paint.fg === 'dim' && /^─+$/.test(paint.text) && paint.text.length < 100), 'accordion separator uses the dim token');
  const decorated = panel.render(100); assert.ok(decorated.some(line => line.includes('─') && line !== '─'.repeat(100)), 'inner separator does not add a shell rule');
});

function geometryOf(rows: number, info: boolean, width = 100) {
  const entries = info ? [{ label: '目标状态', value: '暂停', line: 0 as const }, { label: '轮次进度', value: '0/5', line: 1 as const }] : [];
  // A three-line description makes each hint slot self-identifying in the plain frame.
  const first = { id: 'goal', label: 'Goal', info: entries, upper: () => ({ rows: [{ id: 'goal', label: 'Focus entity', value: 'Title', description: 'H1\nH2\nH3', kind: 'entity' as const }] }), rows: [{ id: 'setting', label: 'Setting', kind: 'toggle' as const, value: '关闭' }] };
  const sections = ['Goal', 'Plan', 'Todos', 'Agents', 'Retry'].map((label, index) => index ? { id: label.toLowerCase(), label, rows: [] as PanelRow[] } : { ...first, label });
  const panel = createPanel(config({ terminalRows: rows, sections }));
  const output = panel.render(width).map(line => stripTerminalSequences(line)), rules = output.flatMap((line, index) => /^─+$/.test(line) ? [index] : []);
  const tabs = rules[0] ?? 0, hints = output.filter(line => /^H[12]$/.test(line.trim())).length;
  return { panel, output, tabs, rules: rules.length, hints, body: output.length - tabs - rules.length - hints - 1, ruleIndexes: rules };
}

test('ticket03 four terminal heights keep the frozen degradation order', () => {
  // Normal state needs 10 rows without an information band and 12 with one; below that hints drop
  // first, then rules, and the zone separator is the last rule to go.
  const expected = [
    { rows: 30, info: true, tabs: 1, rules: 4, hints: 2, budget: 24 },
    { rows: 30, info: false, tabs: 1, rules: 4, hints: 2, budget: 24 },
    { rows: 17, info: true, tabs: 1, rules: 4, hints: 1, budget: 11 },
    { rows: 17, info: false, tabs: 1, rules: 4, hints: 2, budget: 11 },
    { rows: 14, info: true, tabs: 1, rules: 3, hints: 0, budget: 9 },
    { rows: 14, info: false, tabs: 1, rules: 4, hints: 1, budget: 9 },
    { rows: 10, info: true, tabs: 1, rules: 1, hints: 0, budget: 9 },
    { rows: 10, info: false, tabs: 1, rules: 1, hints: 0, budget: 9 },
  ] as const;
  for (const want of expected) {
    const got = geometryOf(want.rows, want.info);
    assert.equal(got.tabs, want.tabs, `rows=${want.rows} info=${want.info} tabs`);
    assert.equal(got.rules, want.rules, `rows=${want.rows} info=${want.info} rules`);
    assert.equal(got.hints, want.hints, `rows=${want.rows} info=${want.info} hints`);
    assert.ok(got.output.length <= Math.min(want.budget, want.rows - 1), `rows=${want.rows} height=${got.output.length}`);
    assert.ok(got.body >= (want.rows <= 10 ? 1 : want.info ? 4 : 2), `rows=${want.rows} body=${got.body}`);
    assert.ok(got.output.at(-1)!.includes('Esc'), `rows=${want.rows} keeps the keys row`);
    if (want.info) assert.match(got.output.join('\n'), /目标状态/);
  }
  // The order is not just numeric: with one row less than the normal 12-row threshold the hints go
  // first (30→17 rows keeps rules 4), which is what distinguishes this from the rejected order.
  const wide = geometryOf(17, true), narrow = geometryOf(14, true);
  assert.equal(wide.rules, 4); assert.equal(wide.hints, 1);
  assert.equal(narrow.rules, 3); assert.equal(narrow.hints, 0);
});

test('ticket03 narrow tabs keep the zone separator when only two rules fit', () => {
  // 28 columns wraps the tab bar to two lines, so the budget only fits two rules.
  const got = geometryOf(14, true, 28);
  assert.equal(got.tabs, 2); assert.equal(got.rules, 2); assert.equal(got.hints, 0);
  const upper = got.output.findIndex(line => line.includes('Focus entity')), lower = got.output.findIndex(line => line.includes('Setting'));
  assert.ok(upper >= 0 && lower > upper, 'both zones are still visible');
  const between = got.ruleIndexes.filter(index => index > upper && index < lower);
  assert.equal(between.length, 1, 'the rule between the zones survives; afterHints is what was dropped');
  assert.ok(got.output.at(-1)!.includes('Esc'), 'keys row is preserved');
});

test('ticket03 a third information line is capped instead of overflowing the budget', () => {
  const info = [{ label: 'A', value: '1', line: 0 as const }, { label: 'B', value: '2', line: 1 as const }, { label: 'C', value: '3', line: 2 as unknown as 0 }];
  for (const rows of [10, 12, 14, 17, 30]) for (const width of [24, 40, 100]) {
    const panel = createPanel(config({ terminalRows: rows, sections: [{ id: 's0', label: 'Goal', info, upper: () => ({ rows: [{ id: 'goal', label: 'Focus entity', kind: 'entity' }] }), rows: [{ id: 'setting', label: 'Setting', kind: 'toggle' }] }] }));
    const output = panel.render(width).map(line => stripTerminalSequences(line)), budget = Math.max(9, rows - 6);
    assert.ok(output.length <= Math.min(budget, rows - 1), `rows=${rows} width=${width} height=${output.length}`);
    assert.ok(output.filter(line => /^[ABC](?: · [ABC])?\s+\.+\s+\[/.test(line.trim())).length <= 2, `rows=${rows} width=${width} caps the band at two rows`);
  }
});

test('ticket03 English information band uses the localized separator', () => {
  const en = createTranslator('en'), panel = createPanel(config({ msg: en, sections: [{ id: 's0', label: 'Goal', info: [{ label: 'Status', value: 'Paused', line: 0 as const }], upper: () => ({ rows: [{ id: 'goal', label: 'Focus entity', kind: 'entity' }] }), rows: [{ id: 'setting', label: 'Setting', kind: 'toggle' }] }] }));
  const output = frame(panel).join('\n');
  assert.match(output, /Status\s+\.+\s+\[Paused\]/); assert.doesNotMatch(output, /：/u);
});

test('ticket08 the information band is a dockable readonly row that only writes the hint', () => {
  const results: PanelResult[] = [];
  const panel = createPanel(config({ terminalRows: 30, onResult: result => results.push(result), sections: [{ id: 's0', label: 'Goal', single: false, info: [
    { label: '目标状态', value: '暂停', line: 0 as const }, { label: '轮次进度', value: '0/5', line: 1 as const }, { label: '异常重试', value: '0/5', line: 1 as const },
  ], upper: () => ({ rows: [{ id: 'goal', kind: 'entity' as const, label: '当前目标', value: '#1 研究目标', description: 'H1' }] }), rows: [{ id: 'setting', kind: 'toggle' as const, label: 'Setting', value: '关闭' }] }] }));
  const band = frame(panel).filter(line => /目标状态|轮次进度/.test(line));
  // The band is rows('upper') now: two `line` groups, dotted leaders, bracketed values.
  assert.equal(band.length, 2, 'one band row per line group, never three');
  assert.match(band[0]!, /^  目标状态\s+\.+\s+\[暂停\]/, 'the unselected band row sits in the cursor gutter');
  assert.match(band[1]!, /^  轮次进度 · 异常重试\s+\.+\s+\[0\/5\] \[0\/5\]/);
  // A fresh panel starts on the first real row; `k` docks onto the band like any other row.
  assert.match(lines(panel), /> .*当前目标/);
  panel.handleInput('k'); panel.handleInput('k');
  const docked = frame(panel).find(line => /目标状态/.test(line))!;
  assert.match(docked, /^> 目标状态/, 'the band takes the cursor through j/k');
  assert.match(lines(panel), /只读字段「目标状态」：暂停/);
  panel.handleInput(key.enter);
  assert.deepEqual(results, [], 'Enter on a band row writes the hint and never executes');
  // Column alignment: the band shares the entity label gutter, offset only by the entity's own chevron.
  const entity = frame(panel).find(line => /当前目标/.test(line))!;
  assert.equal(docked.indexOf('目标状态'), 2, 'the band label starts right after the cursor gutter');
  assert.ok(entity.indexOf('当前目标') > 2, 'entity rows keep their own chevron and icon in front of the label');
  assert.match(entity, /当前目标\s+\.+\s+\[#1 研究目标\]/, 'entity rows keep the same dotted column shape');
});

test('ticket08 the reader is a page: breadcrumb, scroll hint, bounded offset and a live upper zone', () => {
  const panel = createPanel(config({ terminalRows: 24, sections: [{ id: 's0', label: 'Todos', single: false, upper: () => ({ rows: rows(3) }), rows: [{ id: 'setting', kind: 'toggle' as const, label: 'Setting', value: '关闭' }] }] }));
  panel.read('Body', Array.from({ length: 40 }, (_, index) => `Line ${index}`));
  const output = frame(panel), rules = output.flatMap((line, index) => /^─+$/.test(line) ? [index] : []);
  assert.match(output[0]!, /Todos › Body/, 'the reader carries a breadcrumb');
  assert.match(output.at(-1)!, /j\/k 滚动 · Esc 返回/); assert.doesNotMatch(output.join('\n'), /Enter 执行/);
  assert.ok(output.slice(rules[0]! + 1, rules[1]!).some(line => /Row 0/.test(line)), 'the upper zone and its divider survive the reader');
  assert.ok(output.some(line => /Line 0/.test(line)));
  // `j` at the last line is a no-op, and `j`+`k` at the end step back exactly one line.
  for (let index = 0; index < 60; index++) panel.handleInput('j');
  const ended = frame(panel); assert.equal(ended.length, output.length, 'reaching the end never grows the panel');
  assert.match(ended.join('\n'), /Line 39/);
  const height = ended.length; panel.handleInput('j'); assert.equal(frame(panel).length, height);
  assert.equal(frame(panel).join('\n'), ended.join('\n'), 'j at the end does not move');
  panel.handleInput('j'); panel.handleInput('k');
  assert.match(frame(panel).join('\n'), /Line 38/, 'k after the end steps back one line, not past the overshoot');
});

test('ticket08 g jumps to the upper first row and G to the lower first row', () => {
  const panel = createPanel(config({ sections: [{ id: 's0', label: 'Todos', single: false, upper: () => ({ rows: [{ id: 'u0', kind: 'action' as const, label: 'Upper 0' }, { id: 'u1', kind: 'action' as const, label: 'Upper 1' }] }), rows: [{ id: 'l0', kind: 'action' as const, label: 'Lower 0' }, { id: 'l1', kind: 'action' as const, label: 'Lower 1' }] }] }));
  panel.handleInput('G'); assert.match(lines(panel), /> .*Lower 0/, 'G is the lower zone start');
  panel.handleInput('j'); assert.match(lines(panel), /> .*Lower 1/);
  panel.handleInput('g'); assert.match(lines(panel), /> .*Upper 0/, 'g is the upper zone start');
});

test('ticket08 one memory map restores cursor, group folds, expansion and search across panel instances', () => {
  const memory = new Map<string, PanelMemory>();
  const build = () => createPanel(config({ memory, terminalRows: 30, sections: [{ id: 's0', label: 'Todos', single: false, upper: () => ({ rows: [
    { id: 'group', kind: 'heading' as const, collapsible: true, groupCount: 1, label: 'Group' },
    { id: 'task', kind: 'entity' as const, label: 'Task', value: 'v', children: [{ id: 'task/read', kind: 'action' as const, label: 'Read' }] },
  ] }), rows: [{ id: 'setting', kind: 'toggle' as const, label: 'Setting', value: '关闭' }] }] }));
  const first = build();
  first.handleInput('j'); first.handleInput('l');
  assert.match(lines(first), /> .*Read/);
  const second = build();
  assert.match(lines(second), /> .*Read/, 'the cursor is restored by a new panel instance');
  assert.match(lines(second), /Task/, 'the expansion is restored');
  second.handleInput('h'); const third = build();
  assert.match(lines(third), /> .*Task/); assert.doesNotMatch(lines(third), /Read/, 'collapsing the expansion is remembered');
  third.handleInput('h'); const fourth = build();
  assert.doesNotMatch(fourth.render(100).map(stripTerminalSequences).join('\n'), /Task/, 'the collapsed group stays collapsed');
  fourth.handleInput('/'); fourth.handleInput('Task');
  assert.match(lines(build()), /搜索：Task/, 'an interrupted search resumes with its query');
});

test('ticket12 the body split keeps a floor on both zones so neither collapses', () => {
  // The ticket's own case: body 9, entity side needs 5, config side needs 5.
  const sheet = (expanded: boolean) => {
    const entities: PanelRow[] = [0, 1, 2, 3, 4].map(index => ({ id: `e${index}`, kind: 'entity' as const, label: `Entity ${index}`, ...(expanded && index === 0 ? { children: [{ id: 'e0/a', kind: 'action' as const, label: 'Act A' }, { id: 'e0/b', kind: 'action' as const, label: 'Act B' }] } : {}) }));
    const panel = createPanel(config({ terminalRows: 23, sections: [{ id: 's0', label: 'Todos', single: false, rows: rows(5), upper: () => ({ rows: entities }) }] }));
    if (expanded) panel.handleInput(key.enter);
    const rendered = frame(panel, 96), rules = rendered.flatMap((line, index) => /^─+$/.test(line) ? [index] : []);
    // rules[0] closes the tab bar, rules[1] splits the zones, rules[2] sits above the hints.
    return { upper: rules[1]! - rules[0]! - 1, lower: rules[2]! - rules[1]! - 1, rendered, body: rules[2]! - rules[0]! - 2 };
  };
  const plainSplit = sheet(false), expandedSplit = sheet(true);
  assert.equal(plainSplit.body, 9, 'the body under test is nine rows');
  // body 9 with equal needs: 上 5／下 4 or 上 6／下 3, never 上 8／下 1.
  assert.ok(plainSplit.lower >= 3, `plain config zone keeps at least three rows (got ${plainSplit.lower})`);
  assert.ok(plainSplit.upper >= 5, `plain entity zone keeps its five rows (got ${plainSplit.upper})`);
  // Expansion must never take the config zone down to a single row (body - 1 was the defect).
  assert.ok(expandedSplit.lower >= 3, `expanded config zone keeps at least three rows (got ${expandedSplit.lower})`);
  assert.ok(expandedSplit.upper > plainSplit.upper, 'expansion still grows the entity zone');
  assert.match(expandedSplit.rendered.join('\n'), /Act A/, 'the expanded actions stay visible');
});

test('ticket12 a team-like frame (band plus two headings) still shows a member row', () => {
  // Mirrors /team: one band row, 团队 heading + team row, 成员 heading + member rows, five config rows.
  const upper = () => ({ rows: [
    { id: 'band:0', kind: 'readonly' as const, band: true, label: '团队目标', values: [{ text: '0/0', tone: 'dim' as const }] },
    { id: 'group:teams', kind: 'heading' as const, collapsible: true, groupCount: 1, label: '团队' },
    { id: 'team:t1', kind: 'entity' as const, label: 'Codex', value: '当前' },
    { id: 'group:members', kind: 'heading' as const, collapsible: true, groupCount: 1, label: '成员' },
    { id: 'member:1', kind: 'entity' as const, label: 'member-1', values: [{ text: '终端', tone: 'muted' as const }] },
  ] } as never);
  const panel = createPanel(config({ terminalRows: 30, sections: [{ id: 's0', label: 'Team', single: false, upper, rows: rows(5) }] }));
  const rendered = frame(panel, 96).join('\n');
  assert.match(rendered, /member-1/, 'the member row is on screen without scrolling');
  assert.match(rendered, /Codex/); assert.match(rendered, /团队目标/);
});

test('ticket12 the key legend names Tab as a module switch in both languages', async () => {
  const { createTranslator } = await import('../src/shared/i18n.ts');
  for (const [locale, word] of [['zh-CN', 'Tab 换模块'], ['en', 'Tab Module']] as const) {
    const legend = panelKeys(120, true, 6, true, createTranslator(locale));
    assert.ok(legend.includes(word), `${locale} legend: ${legend}`);
    assert.doesNotMatch(legend, /换区|Section/, locale);
  }
});

test('ticket14 the leading icon survives on every row and a duplicated tail marker yields to it', async () => {
  const { SYMBOLS, glyph } = await import('../src/shared/ui/symbols.ts');
  const pencil = String.fromCodePoint(0xf03eb), all = Object.keys(SYMBOLS) as (keyof typeof SYMBOLS)[];
  // Engine text sanitisation strips BMP private-use glyphs, so the table must not declare any
  // (ticket 17 moved `group` off U+F0C0 and the architecture scan enforces it table-wide).
  const renderable = (name: keyof typeof SYMBOLS) => !/[\ue000-\uf8ff]/u.test(glyph(name));
  assert.deepEqual(all.filter(name => !renderable(name)), [], 'every symbol renders');
  const names = all.filter(renderable);
  // One row per symbol, each with the id suffixes that also feed the fallback lookup.
  const rowsFor = (suffix: string): PanelRow[] => names.map(name => ({ id: `row-${name}:${suffix}`, kind: 'input' as const, label: `Label ${name}`, icon: glyph(name) }));
  // One row per page so nothing scrolls out: the sweep must see every row it renders.
  const lines: string[] = [];
  for (const row of [...rowsFor('edit'), ...rowsFor('value')]) {
    const panel = createPanel(config({ iconStyle: 'nerd-font', sections: [{ id: 's0', label: 'Panel', rows: [row] }] }));
    // Only the row itself starts with its icon; the hint slot repeats the label without one.
    lines.push(...frame(panel, 96).filter(line => line.includes('Label ') && /^[> ] ?\p{Co}/u.test(line)));
  }
  assert.equal(lines.length, names.length * 2, 'every row rendered');
  for (const line of lines) {
    const body = line.replace(/^[> ] ?/, '');
    // The row starts with its icon, never with the label text and never with a blank.
    assert.doesNotMatch(body, /^\s/, `row starts with an icon: ${line}`);
    assert.doesNotMatch(body, /^Label/, `the label is not pushed to the start: ${line}`);
    assert.equal(([...line].filter(char => char === pencil).length) <= 1, true, `one pencil at most: ${line}`);
  }
  // A row whose icon IS the pencil keeps the leading pencil and loses the tail one.
  const pencilRow = lines.find(line => line.includes('Label input') || line.includes('Label edit'))!;
  assert.equal([...pencilRow].filter(char => char === pencil).length, 1, `exactly one pencil: ${pencilRow}`);
  // The two module rows the report names keep their pencil at the front.
  for (const label of ['编辑团队目标', '编辑配置文件只读工具']) {
    const one = createPanel(config({ iconStyle: 'nerd-font', sections: [{ id: 's0', label: 'Panel', rows: [{ id: 'r', kind: 'input' as const, label, icon: glyph('edit') }] }] }));
    const line = frame(one, 96).find(value => value.includes(label))!;
    // The row may carry the cursor gutter (`> `) or not; either way the pencil comes first.
    assert.match(line, new RegExp(`^[> ]{2}${pencil} ${label}`), `${label} starts with its pencil: ${line}`);
    assert.equal([...line].filter(char => char === pencil).length, 1, `${label} shows one pencil`);
  }
  // band and heading rows stay icon-free by design.
  const decorative = createPanel(config({ iconStyle: 'nerd-font', sections: [{ id: 's0', label: 'Panel', info: [{ label: 'Band', value: 'v', line: 0 as const }], upper: () => ({ rows: [{ id: 'group', kind: 'heading' as const, collapsible: true, groupCount: 1, label: 'Group' }] }), rows: [] as PanelRow[] }] }));
  const decorativeLines = frame(decorative, 96);
  assert.ok(decorativeLines.some(line => line.includes('Band')) && decorativeLines.some(line => line.includes('Group')), 'both rows render');
});

test('ticket03 a narrow input row keeps its label before its value', () => {
  // R63: the frozen priority is value → label → marker, so the value gives way first.
  const panel = createPanel(config({ sections: [{ id: 's0', label: 'Retry', rows: [
    { id: 'intervals', label: '错误后等待多久', value: '未设置间隔', kind: 'input' }, { id: 'toggle', label: '自动重试', value: '关闭', kind: 'toggle' },
  ] }] }));
  const narrow = frame(panel, 28).find(line => line.includes('错误后等待多久'))!;
  assert.ok(narrow.includes('错误后等待多久'), 'label intact at 28 columns');
  assert.ok(!narrow.includes('未设置间隔'), 'value shrinks before the label');
  assert.ok(narrow.includes('\u{f03eb}') && visibleWidth(narrow) <= 28);
  const wide = frame(panel, 32).find(line => line.includes('未设置间隔'))!;
  assert.ok(wide.includes('\u{f03eb}') && visibleWidth(wide) <= 32, 'the whole value returns once it fits');
});

test('ticket03 marker rows keep a readable label at widths 40 and 30', () => {
  for (const width of [40, 30]) {
    const panel = createPanel(config({ sections: [{ id: 's0', label: 'Agents', rows: [
      { id: 'review', label: 'review', icon: '\u{f000e}', kind: 'entity', values: [{ text: 'anthropic/claude-opus-4-6', tone: 'muted' }, { text: '12 工具', tone: 'muted' }] },
    ] }] }));
    const line = frame(panel, width).find(value => value.includes('review') || value.includes('revi'))!;
    assert.ok(line.includes('review'), `width=${width} keeps the whole label: ${line}`);
    assert.ok(line.includes('\u{f000e}'), `width=${width} keeps the icon`);
    assert.ok(visibleWidth(line) <= width);
  }
  // The value is middle-truncated, so both ends stay visible instead of losing the tail.
  const split = dottedColumns('review', '[anthropic/claude-opus-4-6] [12 工具]', 40);
  assert.equal(split.left, 'review');
  assert.ok(split.right.startsWith('['), 'head kept');
  assert.ok(split.right.endsWith(']'), `tail kept: ${split.right}`);
  assert.ok(split.right.includes('…'));
  for (const width of [40, 30, 24]) {
    const { left } = dottedColumns('review', '[anthropic/claude-opus-4-6] [12 工具]', width);
    assert.equal(left, 'review', `width=${width} keeps the whole label`);
  }
});

test('ticket03 a 12-column input row keeps its icon, a label prefix and the marker', () => {
  const make = (width: number) => {
    const panel = createPanel(config({ sections: [{ id: 's0', label: 'Retry', rows: [{ id: 'intervals', label: '重试间隔', value: '未设置间隔', kind: 'input', icon: '\u{f0154}' }] }] }));
    const line = frame(panel, width).find(value => /重试|未设置/.test(value))!;
    assert.ok(visibleWidth(line) <= width, `width=${width}`);
    return line.trimEnd();
  };
  const w12 = make(12), w14 = make(14), w16 = make(16);
  assert.match(w12, /^> \u{f0154} 重试… \u{f03eb}$/u, 'value shrinks first, then the label, and only then the marker');
  assert.ok(!w12.includes('未设置间隔'));
  assert.ok(w14.includes('重试间隔') && w14.includes('\u{f03eb}'), 'width=14 keeps the whole label and the marker');
  assert.ok(w16.includes('重试间隔') && w16.includes('\u{f03eb}') && w16.includes('…'), 'width=16 starts to show the value');
  for (const [width, line] of [[12, w12], [14, w14], [16, w16]] as const) assert.ok(/[\u{f0154}]/u.test(line), `width=${width} keeps the icon`);
});

test('ticket03 an expanded child row keeps its label at width 46', () => {
  const panel = createPanel(config({ sections: [{ id: 's0', label: 'Agents', rows: [{ id: 'profile', label: 'review', kind: 'entity', children: [{ id: 'field', label: '模型', value: 'claude-opus-4-6', kind: 'readonly', icon: '\u{f0626}' }] }] }] }));
  panel.handleInput(key.enter);
  for (const width of [46, 60, 120]) {
    const line = frame(panel, width).find(value => /模型|…/.test(value))!;
    assert.ok(line.includes('模型'), `width=${width} keeps the child label: ${line}`);
    assert.ok(line.includes('\u{f0626}'), `width=${width} keeps the child icon`);
    assert.ok(visibleWidth(line) <= width);
  }
  assert.match(frame(panel, 120).find(line => line.includes('模型'))!, /\[claude-opus-4-6\]/u, 'width=120 shows the whole value');
});

type Paint = { text: string; fg: string };

function paintingTheme(paints: Paint[], underlines: string[]) {
  return { style: (text: string, options: { fg: string }) => { paints.push({ text, fg: options.fg }); return text; }, underline: (text: string) => { underlines.push(text); return text; } };
}

test('ticket04 editing paints only the edited row with accent and underlines its input', () => {
  const paints: Paint[] = [], underlines: string[] = [];
  const panel = createPanel(config({ theme: paintingTheme(paints, underlines) as never, sections: [{ id: 's0', label: 'Retry', rows: [
    { id: 'interval', label: '重试间隔', value: '30s', kind: 'input' }, { id: 'other', label: '其它设置', value: '开启', kind: 'toggle' },
  ] }] }));
  panel.render(100); paints.length = 0; underlines.length = 0;
  panel.handleInput(key.enter); frame(panel);
  assert.ok(paints.some(paint => paint.text.includes('重试间隔') && paint.fg === 'accent'), 'edited label turns accent');
  assert.ok(paints.some(paint => paint.fg === 'accent' && paint.text.includes('30s')), 'input area turns accent');
  assert.ok(underlines.some(text => text.includes('30s')), 'input area is underlined');
  const untouched = paints.filter(paint => paint.text.includes('其它设置'));
  assert.ok(untouched.length > 0 && untouched.every(paint => paint.fg !== 'accent'), 'other rows keep their tone');
  paints.length = 0; underlines.length = 0; panel.handleInput(key.esc); frame(panel);
  assert.ok(paints.some(paint => paint.text.includes('重试间隔') && paint.fg === 'text'), 'label returns to normal after cancel');
  assert.equal(underlines.length, 0, 'no underline after leaving the editor');
  const typed = paints.filter(paint => paint.text.includes('30s'));
  assert.ok(typed.every(paint => paint.fg !== 'accent'), 'the value returns to its normal tone');
});

test('ticket04 the upper zone edit branch paints accent and underline too', () => {
  const paints: Paint[] = [], underlines: string[] = [];
  const panel = createPanel(config({ theme: paintingTheme(paints, underlines) as never, sections: [{ id: 's0', label: 'Agents', single: false, rows: [
    { id: 'setting', label: '其它设置', value: '开启', kind: 'toggle' },
  ], upper: () => ({ rows: [{ id: 'field', label: '模型', value: 'claude', kind: 'input' }] }) }] }));
  panel.handleInput('g'); panel.handleInput(key.enter); frame(panel);
  assert.ok(paints.some(paint => paint.text.includes('模型') && paint.fg === 'accent'), 'upper edited label turns accent');
  assert.ok(underlines.some(text => text.includes('claude')), 'upper input area is underlined');
  const untouched = paints.filter(paint => paint.text.includes('其它设置'));
  assert.ok(untouched.length > 0 && untouched.every(paint => paint.fg !== 'accent'), 'lower rows keep their tone');
});

test('ticket04 destructive input rows edit in the error tone', () => {
  const paints: Paint[] = [], underlines: string[] = [];
  const panel = createPanel(config({ theme: paintingTheme(paints, underlines) as never, sections: [{ id: 's0', label: 'Agents', rows: [
    { id: 'delete', label: '删除 Profile', value: 'review', kind: 'input', destructive: true },
  ] }] }));
  panel.handleInput(key.enter); panel.handleInput(key.enter); frame(panel);
  assert.ok(paints.some(paint => paint.text.includes('删除 Profile') && paint.fg === 'error'), 'destructive rows use error');
  assert.ok(paints.every(paint => !paint.text.includes('删除 Profile') || paint.fg !== 'accent'), 'not accent');
  assert.ok(underlines.some(text => text.includes('review')));
});

test('ticket04 a rejected validate keeps the draft, the editor and an actionable reason', () => {
  const results: PanelResult[] = [];
  const panel = createPanel(config({ sections: [{ id: 's0', label: 'Retry', rows: [{
    id: 'interval', label: '重试间隔', value: '', kind: 'input',
    input: { title: '重试间隔', value: '', validate: value => /^\d+[smh]$/.test(value.trim()) ? undefined : '填写 30s、2m 或 1h 形式的间隔' },
  }] }], onResult: result => results.push(result) }));
  panel.handleInput(key.enter); panel.handleInput(key.enter);
  const rejected = frame(panel).join('\n');
  assert.equal(results.length, 0, 'nothing is emitted while the reason stands');
  assert.match(rejected, /填写 30s、2m 或 1h 形式的间隔/);
  assert.equal(memory(panel).selectedId, 'interval');
  panel.handleInput('x');
  assert.doesNotMatch(lines(panel), /填写 30s、2m 或 1h 形式的间隔/, 'typing clears the stale reason');
  panel.handleInput(key.enter);
  assert.equal(results.length, 0, 'the invalid draft is still not submitted');
  assert.match(lines(panel), /填写 30s、2m 或 1h 形式的间隔/);
  panel.handleInput('\x01'); panel.handleInput('\x0b'); panel.handleInput('5m'); panel.handleInput(key.enter);
  assert.deepEqual(results, [{ action: 'selected', kind: 'input', id: 'interval', payload: '5m' }], 'a valid draft submits and closes the editor');
});

test('ticket04 one allocation rule covers values[], plain values and child rows', () => {
  // label first, then the value, and the marker only if a readable label still fits.
  assert.deepEqual(fitRow(10, 10, 2, 10), { label: 8, value: 0, marker: 2 });
  assert.deepEqual(fitRow(10, 10, 2, 5), { label: 5, value: 0, marker: 0 }, 'the marker yields before the label drops below readability');
  assert.deepEqual(fitRow(4, 35, 0, 32), { label: 4, value: 27, marker: 0 });
  assert.deepEqual(fitRow(6, 35, 0, 37), { label: 6, value: 30, marker: 0 });
  // dottedColumns is the same rule with a three-column leader reserve, for every data shape.
  for (const width of [46, 30, 24]) assert.equal(dottedColumns('review', '[anthropic/claude-opus-4-6] [12 工具]', width).left, 'review');
  // Expanded child rows (both zone shapes) are covered by test/ui-child-floor.test.ts, which also
  // runs against the pre-fix commit; this test stays on the allocation rule itself.
});

test('ticket03 readonly labels use muted and values use dim regardless of inferred state tone', () => {
  const paints: { text: string; fg: string }[] = [];
  const panel = createPanel(config({ theme: { style: (text: string, options: { fg: string }) => { paints.push({ text, fg: options.fg }); return text; } } as never, sections: [{ id: 's0', label: 'Plan', rows: [{ id: 'field', label: 'Read field', value: 'Enabled', valueTone: 'accent', kind: 'readonly' }] }] }));
  panel.render(100);
  assert.ok(paints.some(paint => paint.text.includes('Read field') && paint.fg === 'muted'));
  assert.ok(paints.some(paint => paint.text === 'Enabled' && paint.fg === 'dim'));
});

test('ticket03 readonly hints show value and first distinct description within exactly two rows', () => {
  const render = (value: string | undefined, description: string | undefined) => {
    const panel = createPanel(config({ sections: [{ id: 's0', label: 'Plan', rows: [{ id: 'entry', label: '进入条件', kind: 'readonly', ...(value === undefined ? {} : { value }), ...(description === undefined ? {} : { description }) }] }] }));
    panel.handleInput(key.enter); return { panel, output: frame(panel) };
  };
  const same = render('可进入', '可进入\n退出 Plan 不会自动恢复 Goal。\n另一条说明');
  const hints = same.output.slice(-4, -2).map(stripTerminalSequences);
  assert.equal(hints.length, 2); assert.equal(hints[0]!.trimEnd(), '只读字段「进入条件」：可进入'); assert.equal(hints[1]!.trimEnd(), '退出 Plan 不会自动恢复 Goal。…');
  const withoutValue = render(undefined, ''); const fallback = withoutValue.output.slice(-4, -2).map(stripTerminalSequences);
  assert.equal(fallback[0]!.trimEnd(), '只读字段「进入条件」'); assert.equal(fallback[1]!.trimEnd(), '只读信息，不更改会话状态。');
  const english = createPanel(config({ msg: createTranslator('en'), sections: [{ id: 's0', label: 'Plan', rows: [{ id: 'entry', label: 'Entry condition', value: 'Ready', description: 'Ready\nPlan must be exited first.', kind: 'readonly' }] }] }));
  english.handleInput(key.enter); const hintsEnglish = frame(english).slice(-4, -2).map(stripTerminalSequences);
  assert.equal(hintsEnglish[0]!.trimEnd(), 'Read-only field “Entry condition”: Ready'); assert.equal(hintsEnglish[1]!.trimEnd(), 'Plan must be exited first.');
});

test('ticket03 a row whose own icon equals its kind marker renders that marker once', () => {
  const panel = createPanel(config({ sections: [{ id: 's0', label: 'Todos', rows: [
    { id: 'edit', label: 'Edit requirements', kind: 'input', icon: '\u{f03eb}' }, { id: 'intervals', label: 'Interval', kind: 'input', icon: '\u{f0154}' },
  ] }] }));
  const [edit, intervals] = frame(panel).filter(line => /Edit requirements|Interval/.test(line));
  assert.equal([...edit!].filter(char => char === '\u{f03eb}').length, 1, 'the palette pencil is not printed twice');
  assert.equal([...intervals!].filter(char => char === '\u{f03eb}').length, 1);
  assert.ok(intervals!.includes('\u{f0154}'), 'a different leading icon is preserved');
});

test('ticket03 heading tail and readonly rows cannot execute', () => {
  const results: PanelResult[] = [], panel = createPanel(config({ sections: [{ id: 's0', label: 'Agents', rows: [
    { id: 'heading', label: 'Heading', kind: 'heading' }, { id: 'tail', label: 'Tail', kind: 'tail' }, { id: 'readonly', label: 'Readonly', kind: 'readonly' },
  ] }], onResult: result => results.push(result) }));
  assert.equal(canDock(panel.row('heading')!), false); assert.equal(canDock(panel.row('tail')!), false); assert.equal(canDock(panel.row('readonly')!), true);
  for (const id of ['heading', 'tail', 'readonly']) assert.equal(canExecute(panel.row(id)!), false, `${id} is not executable`);
  panel.handleInput(key.enter); assert.deepEqual(results, []);
});

test('ticket02 seven kinds have one engine-owned Enter contract', () => {
  const results: PanelResult[] = [], make = (row: PanelRow) => createPanel(config({ sections: [{ id: 's0', label: 'Agents', rows: [row] }], onResult: result => results.push(result) }));
  const entity = make({ id: 'identity', label: 'Identity', kind: 'entity', children: [{ id: 'child', label: 'Child', kind: 'action' }] });
  entity.handleInput(key.enter); assert.equal(memory(entity).expandedId, 'identity'); assert.equal(memory(entity).selectedId, 'child'); assert.equal(results.length, 0);
  entity.handleInput(key.esc); assert.equal(memory(entity).selectedId, 'identity'); assert.equal(memory(entity).expandedId, undefined);
  const readonly = make({ id: 'field', label: 'Field', kind: 'readonly', description: 'Field explanation' }); readonly.handleInput(key.enter);
  assert.equal(results.length, 0); assert.match(frame(readonly).join('\n'), /只读字段「Field」/); assert.match(frame(readonly).join('\n'), /Field explanation/);
  for (const kind of ['toggle', 'cycle', 'input', 'directory', 'action'] as const) {
    const panel = make({ id: kind, label: kind, kind, checked: false, choices: ['first', 'second'], value: 'first' });
    panel.handleInput(key.enter);
    if (kind === 'input') { assert.equal(results.length, 2); panel.handleInput(key.esc); assert.equal(results.length, 2, 'cancel returns to the row, not the parent page'); panel.handleInput(key.enter); panel.handleInput('!'); panel.handleInput(key.enter); }
    const result = results.at(-1)!; assert.equal(result.kind, kind); assert.equal(result.id, kind);
    if (kind === 'toggle') assert.equal(result.payload, true);
    if (kind === 'cycle') assert.equal(result.payload, 'second');
    if (kind === 'input') assert.equal(result.payload, 'first!');
  }
  const plainAction = make({ id: 'action-parent', label: 'Action', kind: 'action', children: [{ id: 'not-an-entity-child', label: 'Ignored', kind: 'action' }] });
  plainAction.handleInput(key.enter); assert.equal(results.at(-1)!.id, 'action-parent'); assert.equal(memory(plainAction).expandedId, undefined, 'children do not override kind');
});

test('ticket66 nested accordion state is cleared when its parent changes or disappears', () => {
  const parent = (id: string): PanelRow => ({ id, label: id, kind: 'entity', children: [{ id: 'shared-inbox', label: `${id} inbox`, kind: 'entity', children: [{ id: `${id}/leaf`, label: `${id} message`, kind: 'action' }] }] });
  const results: PanelResult[] = [];
  const panel = createPanel(config({ id: 'nested-cleanup', sections: [{ id: 's0', label: 'Team', rows: [parent('first'), parent('second')] }], onResult: result => results.push(result) }));
  frame(panel); panel.handleInput(key.enter); panel.handleInput('l'); frame(panel);
  assert.equal(memory(panel, 'nested-cleanup').nestedId, 'shared-inbox');
  panel.handleInput(key.down); panel.handleInput(key.enter); frame(panel);
  assert.equal(memory(panel, 'nested-cleanup').expandedId, 'second');
  assert.equal(memory(panel, 'nested-cleanup').nestedId, undefined, 'a different parent does not retain a hidden nested level');
  panel.handleInput(key.esc); frame(panel);
  assert.equal(memory(panel, 'nested-cleanup').expandedId, undefined, 'one Esc closes the new parent immediately');
  panel.handleInput(key.enter); panel.handleInput('l'); frame(panel);
  assert.equal(memory(panel, 'nested-cleanup').nestedId, 'shared-inbox');
  panel.handleInput(key.up); panel.handleInput(key.up); panel.handleInput(key.enter); frame(panel);
  assert.equal(memory(panel, 'nested-cleanup').expandedId, undefined);
  assert.equal(memory(panel, 'nested-cleanup').nestedId, undefined, 'activating the open parent closes all of its nested state');
  panel.handleInput(key.enter); panel.handleInput('l'); frame(panel);
  assert.equal(memory(panel, 'nested-cleanup').nestedId, 'shared-inbox');
  panel.handleInput('/'); panel.handleInput('zzzz'); frame(panel);
  assert.equal(memory(panel, 'nested-cleanup').expandedId, undefined);
  assert.equal(memory(panel, 'nested-cleanup').nestedId, undefined, 'filtering away the parent also clears its child state');
  panel.handleInput(key.esc); panel.handleInput(key.esc);
  assert.equal(results.at(-1)?.action, 'closed', 'Esc is not consumed by an invisible nested level');
});

test('ticket02 a second accordion layer opens inline and Esc restores one level at a time', () => {
  const panel = createPanel(config({ id: 'agents:root', sections: [{ id: 's0', label: 'Agents', rows: [{ id: 'profiles', label: 'Profiles', kind: 'directory' }] }] }));
  panel.setPage({ id: 'agents:profiles', title: 'Profile', sections: [{ id: 's0', label: 'Agents', rows: [{ id: 'profile', label: 'Profile', kind: 'entity', children: [{ id: 'nested', label: 'Nested collection', kind: 'entity', children: [{ id: 'leaf', label: 'Leaf', kind: 'readonly' }] }] }] }] });
  panel.handleInput(key.enter); assert.equal(memory(panel, 'agents:profiles').expandedId, 'profile');
  // The child entity opens in place: the parent row and the page title stay exactly where they were.
  panel.handleInput(key.enter);
  assert.match(frame(panel)[0]!, /Agents › Profile/, 'the page title does not change for a second-level entity');
  const inline = frame(panel).join('\n');
  assert.match(inline, /Profile/, 'the parent is still on screen');
  assert.match(inline, /Nested collection/, 'the child entity is listed inside it');
  assert.match(inline, /Leaf/, 'and its own rows are expanded right there');
  assert.equal(memory(panel, 'agents:profiles').nestedId, 'nested');
  // Esc peels one layer: the nested rows close, the parent stays open.
  panel.handleInput(key.esc);
  assert.match(frame(panel).join('\n'), /Nested collection/);
  assert.doesNotMatch(frame(panel).join('\n'), /Leaf/);
  assert.equal(memory(panel, 'agents:profiles').expandedId, 'profile', 'the parent is still expanded');
  panel.handleInput(key.esc); assert.equal(memory(panel, 'agents:profiles').expandedId, undefined);
});

test('U7 real Theme styles title, dividers and destructive warnings while GUI content glyphs survive unchanged', () => {
  const builtin = JSON.parse(readFileSync(new URL('../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/dark.json', import.meta.url), 'utf8'));
  const colors = Object.fromEntries(Object.keys(builtin.colors).map(token => [token, '#808080'])), theme = new Theme(colors as never, colors as never, 'truecolor');
  const panel = createPanel(config({ theme, sections: [{ id: 's0', label: 'Todos', rows: [{ id: 'delete', kind: 'action', label: 'Delete', destructive: true }], upper: () => ({ rows: [{ id: 'gui', label: 'GUI', text: '\u{f0279} ├─ GUI', kind: 'readonly' }] }) }] }));
  const output = panel.render(100);
  assert.ok(output[0]!.includes(theme.style('\u{f0279} Todos', { fg: 'accent', bold: true })));
  assert.ok(output[1]!.includes(theme.style('─'.repeat(100), { fg: 'dim', bold: false })));
  const legend = stripTerminalSequences(output.at(-1)!).trim();
  assert.equal(output.at(-1), ' ' + theme.style(legend, { fg: 'dim', bold: false }) + ' '.repeat(99 - visibleWidth(legend)), 'the entire legend has only dim styling, with a neutral gutter');
  assert.match(stripTerminalSequences(output[2]!), /\u{f0279} ├─ GUI/u);
  panel.handleInput('G'); panel.handleInput(key.enter);
  const armed = panel.render(100);
  assert.ok(armed.some(line => line.includes(theme.style('待确认 · 再次 Enter Delete · Esc 取消', { fg: 'error', bold: false }))));
  assert.ok(armed.some(line => stripTerminalSequences(line).includes('GUI')), 'confirmation keeps the upper list visible');
});

test('ticket04b h/l walk the hierarchy while g/G jump zones and directory rows carry no tail marker', () => {
  const upper = () => ({ rows: [
    { id: 'a', kind: 'entity' as const, label: 'Alpha', children: [{ id: 'a/one', kind: 'action' as const, label: 'Alpha action' }] },
    { id: 'b', kind: 'entity' as const, label: 'Beta', children: [{ id: 'b/inner', kind: 'entity' as const, label: 'Beta inner', children: [{ id: 'b/inner/leaf', kind: 'action' as const, label: 'Beta leaf' }] }] },
  ] });
  const panel = createPanel(config({ sections: [{ id: 's0', label: 'Todos', rows: [{ id: 'low', kind: 'action' as const, label: 'Lower' }], upper }] }));
  const text = () => lines(panel);
  // g/G take over the old h/l zone jumps.
  panel.handleInput('G'); assert.match(text(), /> .*Lower/);
  panel.handleInput('g'); assert.match(text(), /> .*Alpha/);
  // l expands the entity, h collapses it, and h/l never change zones on the way.
  panel.handleInput('l'); assert.ok(text().includes('Alpha action'));
  assert.match(text(), /> .*Alpha/);
  // Expanding docks the cursor on the first child; k returns to the parent so the guard actually runs.
  panel.handleInput('k'); assert.match(text(), /> .*Alpha/);
  panel.handleInput('l'); assert.ok(text().includes('Alpha action'), 'l never collapses an expanded entity');
  panel.handleInput('h'); assert.equal(text().includes('Alpha action'), false);
  assert.match(text(), /> .*Alpha/);
  assert.equal(memory(panel).zone, 'upper');
  // l opens the second in-place layer without leaving the page, and h closes just that layer.
  panel.handleInput('j'); panel.handleInput('l'); panel.handleInput('l');
  assert.match(frame(panel)[0]!, /Todos/, 'the second in-place layer keeps the same page');
  assert.match(text(), /Beta leaf/, 'the child entity\'s rows are expanded in place');
  panel.handleInput('h'); assert.doesNotMatch(text(), /Beta leaf/, 'h closes only the nested layer');
  assert.match(text(), /Beta inner/, 'the parent entity is still expanded');
  panel.handleInput('h'); assert.doesNotMatch(text(), /Beta inner/, 'a second h closes the parent');
  // A directory row has no tail marker; the hint slot says Enter opens the sub-page.
  const directory = createPanel(config({ sections: [{ id: 's0', label: 'Agents', rows: [], upper: () => ({ rows: [{ id: 'models', kind: 'directory' as const, label: 'Model catalog', description: 'Enter 进入' }] }) }] }));
  const rendered = lines(directory);
  const modelRow = rendered.split('\n').find(line => line.includes('Model catalog'))!;
  assert.doesNotMatch(modelRow, /[›…»]\s*$/, 'directory rows never carry a tail marker');
});

test('ticket04b collapsible groups fold on h/Enter, default closed when empty, and remember their state', () => {
  const upper = () => ({ rows: [
    { id: 'group:jobs', kind: 'heading' as const, label: 'Job', collapsible: true, groupCount: 1 },
    { id: 'j1', kind: 'entity' as const, label: 'Job one' },
    { id: 'group:profiles', kind: 'heading' as const, label: 'Profile', collapsible: true, groupCount: 0 },
    { id: 'p1', kind: 'entity' as const, label: 'Profile one' },
  ] });
  const opened = createPanel(config({ sections: [{ id: 's0', label: 'Agents', rows: [{ id: 'low', kind: 'action' as const, label: 'Lower' }], upper }] }));
  const text = () => lines(opened);
  assert.ok(text().includes('Job one'), 'a group with content is expanded by default');
  assert.equal(text().includes('Profile one'), false, 'an empty group is folded by default');
  opened.handleInput('g'); assert.match(text(), /> .*Job/);
  opened.handleInput('h');
  assert.equal(text().includes('Job one'), false, 'h folds the group');
  assert.equal(memory(opened).groups?.['group:jobs'], true, 'the fold state lives in the panel memory');
  opened.handleInput('l'); assert.ok(text().includes('Job one'), 'l unfolds the group');
  opened.handleInput('l'); assert.ok(text().includes('Job one'), 'a second l never collapses an unfolded group');
  opened.handleInput('h'); assert.equal(text().includes('Job one'), false, 'h collapses the group');
  opened.handleInput('l');
  const reopened = createPanel(config({ terminalRows: 30, memory: new Map([['root/s0', memory(opened)]]) , sections: [{ id: 's0', label: 'Agents', rows: [{ id: 'low', kind: 'action' as const, label: 'Lower' }], upper }] }));
  assert.ok(!lines(reopened).includes('Profile one'), 'a rebuilt panel restores the remembered fold state');
});

test('ticket05 plain mode renders no private-use glyphs in panel, menu rows or the widget', () => {
  const privateUse = /[\ue000-\uf8ff]|[\u{f0000}-\u{ffffd}]/u;
  const panel = createPanel(config({ iconStyle: 'plain', sections: [{ id: 's0', label: 'Todos', single: false, rows: [
    { id: 'graph', kind: 'directory', label: 'Graph' }, { id: 'clear', kind: 'action', label: 'Clear', destructive: true }, { id: 'toggle', kind: 'toggle', label: 'Toggle', checked: true },
  ], upper: () => ({ rows: [
    { id: 'group:a', kind: 'heading', label: 'Group', collapsible: true, groupCount: 1 },
    { id: 'entity', kind: 'entity', label: 'Entity', children: [{ id: 'entity/edit', kind: 'input', label: 'Edit', input: { title: 'Edit' } }] },
    { id: 'cycle', kind: 'cycle', label: 'Cycle', choices: ['a', 'b'], value: 'a' },
  ] }) }] }));
  for (const width of [40, 80, 120]) for (const line of frame(panel, width)) assert.doesNotMatch(line, privateUse);
  const widget = retryWidgetLine({ enabled: true, phase: 'armed', attempts: 1, count: 3, intervals: '5m' }, 1_000, undefined, 'plain');
  assert.ok(widget && widget.includes('Retry'));
  assert.doesNotMatch(widget!, privateUse);
  const nerdWidget = retryWidgetLine({ enabled: true, phase: 'armed', attempts: 1, count: 3, intervals: '5m' }, 1_000);
  assert.match(nerdWidget!, privateUse, 'the same table keeps the Nerd Font rendering');
});
