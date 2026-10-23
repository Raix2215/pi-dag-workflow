import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Editor, stripTerminalSequences, visibleWidth } from '@earendil-works/pi-tui';
import { createPanel, type PanelConfig } from '../src/shared/ui/panel.ts';

/** R63/R67: a child row has no marker of its own, so its label must still win over the value. */
const values = [{ text: 'anthropic/claude-opus-4-6', tone: 'dim' as const }, { text: '12 工具', tone: 'dim' as const }];
const children = [{ id: 'model', label: '模型', kind: 'readonly' as const, values }];

function panel(single: boolean) {
  const section = { id: 's0', label: 'Agents', rows: single ? [{ id: 'profile', label: 'review', kind: 'entity' as const, children }] : [] };
  const config: PanelConfig = {
    id: 'root', title: 'Agents', terminalRows: 30,
    sections: [single ? section : { ...section, upper: () => ({ rows: [{ id: 'profile', label: 'review', kind: 'entity' as const, children }] }) }],
    createEditor: () => new Editor({ terminal: { rows: 30 }, requestRender() {} } as never, { borderColor: (text: string) => text, selectList: { selectedPrefix: (text: string) => text, selectedText: (text: string) => text, description: (text: string) => text, scrollInfo: (text: string) => text, noMatch: (text: string) => text } }, { paddingX: 0 }),
  };
  const created = createPanel(config);
  created.handleInput('\r');
  return created;
}

test('child rows keep their label at 46/30/24 columns in both zone shapes', () => {
  for (const single of [true, false]) {
    const created = panel(single);
    for (const width of [46, 30, 24]) {
      const rendered = created.render(width).map(line => stripTerminalSequences(line));
      // Match the indented child row itself, never the hint slot that also mentions the label.
      const line = rendered.find(value => /^\s+.*模型/.test(value));
      assert.ok(line, `${single ? 'lower' : 'upper'} width=${width} renders the child row`);
      assert.ok(line!.includes('模型'), `${single ? 'lower' : 'upper'} width=${width} keeps the label: ${line}`);
      assert.ok(visibleWidth(line!) <= width);
    }
  }
});
