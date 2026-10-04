import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWorkflow } from '../src/workflow/index.ts';
import { FEATURE_NAMES, type Feature } from '../src/workflow/features.ts';
import { emptyState, STATE_TYPE } from '../src/todos/state.ts';
import { PresetStore } from '../src/todos/presets.ts';

async function host(features: readonly Feature[], branch: any[] = [], tui = false) {
  const root = await mkdtemp(join(tmpdir(), 'dag-lifecycle-'));
  const events = new Map<string, Function[]>(), tools = new Map<string, any>();
  let reads = 0, widgets = 0, dataReads = 0, leaf = 1, active: string[] = [];
  let latestWidget: any;
  const entries = branch;
  for (const entry of entries) if (entry.customType === STATE_TYPE) {
    const data = entry.data; Object.defineProperty(entry, 'data', { get() { dataReads++; return data; } });
  }
  const pi: any = { on(name: string, fn: Function) { events.set(name, [...events.get(name) ?? [], fn]); }, registerTool(tool: any) { tools.set(tool.name, tool); }, registerCommand() {}, registerFlag() {}, getFlag() {}, appendEntry(customType: string, data: unknown) { entries.push({ type: 'custom', customType, data }); leaf++; }, getActiveTools: () => [...active], setActiveTools(names: string[]) { active = names; }, sendMessage() {}, sendUserMessage() {} };
  const ctx: any = { mode: tui ? 'tui' : 'rpc', hasUI: true, cwd: root, isIdle: () => false, modelRegistry: { find: () => undefined }, sessionManager: { getBranch() { reads++; return [...entries]; }, getLeafId: () => String(leaf), getSessionFile: () => undefined }, ui: { theme: undefined, notify() {}, setWidget(_id: string, content: unknown) { widgets++; latestWidget = content; } } };
  const workflow = createWorkflow(pi);
  for (const feature of features) await workflow.attach(feature, pi);
  const fire = async (name: string, event: any = {}) => { for (const fn of events.get(name) ?? []) await fn(event, ctx); };
  const call = (name: string, params: object) => tools.get(name).execute('test', params, undefined, undefined, ctx);
  return { ctx, fire, call, widget: () => latestWidget, reads: () => reads, dataReads: () => dataReads, widgets: () => widgets, close: async () => { await fire('session_shutdown'); await rm(root, { recursive: true, force: true }); } };
}

test('all loaded modules share one branch read, one Todo restore and one preset load in either order', async () => {
  const original = PresetStore.prototype.load;
  const previous = process.env.PI_CODING_AGENT_DIR;
  let loads = 0;
  PresetStore.prototype.load = async function () { loads++; return original.call(this); };
  try {
    process.env.PI_CODING_AGENT_DIR = join(tmpdir(), 'fixture-nonexistent-agent-directory');
    for (const features of [FEATURE_NAMES, [...FEATURE_NAMES].reverse()]) {
      loads = 0;
      const state = { ...emptyState(), plan: true, nextId: 2, tasks: [{ id: 1, subject: 'retained task', status: 'pending', blockedBy: [] }] };
      const h = await host(features, [{ type: 'custom', customType: STATE_TYPE, data: state }]);
      try {
        await h.fire('session_start');
        assert.equal(h.reads(), 1); assert.equal(h.dataReads(), 1); assert.equal(loads, 1);
        const blocked = await h.call('todo', { action: 'update', id: 1, status: 'completed' });
        assert.equal(blocked.isError, true, 'the Plan bit survives a later-loaded Plan module');
        await h.fire('session_tree');
        assert.equal(h.reads(), 2); assert.equal(h.dataReads(), 2); assert.equal(loads, 2);
      } finally { await h.close(); }
    }
  } finally {
    PresetStore.prototype.load = original;
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous;
  }
});

test('Goal-only and UI-only never read Todo/preset state or fail on disabled corrupt Todo history', async () => {
  const original = PresetStore.prototype.load; let loads = 0;
  PresetStore.prototype.load = async function () { loads++; return original.call(this); };
  try {
    const h = await host(['goal', 'ui'], [{ type: 'custom', customType: STATE_TYPE, data: { version: 99 } }]);
    try { await h.fire('session_start'); assert.equal(loads, 0); assert.equal(h.dataReads(), 0); assert.equal((await h.call('goal', { action: 'create', title: 'independent' })).isError, undefined); }
    finally { await h.close(); }
    const ui = await host(['ui']);
    try { await ui.fire('session_start'); assert.equal(ui.reads(), 0); assert.equal(loads, 0); }
    finally { await ui.close(); }
  } finally { PresetStore.prototype.load = original; }
});

for (const tui of [false, true]) {
  test(`unchanged Goal run metadata does not re-register its widget; task/title changes still repaint (${tui ? 'tui' : 'rpc'})`, async () => {
    const h = await host(['todos', 'goal', 'ui'], [], tui);
    try {
      await h.fire('session_start');
      await h.call('goal', { action: 'create', title: 'original' });
      await h.fire('input', { source: 'rpc', text: 'enable' });
      await h.call('goal', { action: 'enable', id: 1 });
      const mark = h.widgets();
      for (let i = 0; i < 10; i++) await h.call('goal', { action: 'update', progress: `evidence ${i}`, nextStep: `step ${i}` });
      assert.equal(h.widgets(), mark);
      await h.fire('input', { source: 'rpc', text: 'rename' });
      await h.call('goal', { action: 'update', title: 'changed title' });
      assert.ok(h.widgets() > mark);
      const after = h.widgets();
      await h.call('todo', { action: 'create', subject: 'visible task' });
      assert.ok(h.widgets() > after);
      if (tui) {
        const component = h.widget()();
        const initial = component.render(80);
        let tint = 31;
        h.ctx.ui.theme = { fg: (_color: string, text: string) => `\x1b[${tint}m${text}\x1b[39m` };
        component.invalidate();
        const recolored = component.render(80);
        assert.notDeepEqual(initial, recolored);
        assert.match(recolored.join('\n'), /\x1b\[31m/);
        tint = 32; component.invalidate();
        assert.match(component.render(80).join('\n'), /\x1b\[32m/);
        assert.notDeepEqual(component.render(40), recolored, 'resize does not return old-width cached lines');
      }
    } finally { await h.close(); }
  });
}
