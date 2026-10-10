import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { visibleWidth } from '@earendil-works/pi-tui';
import { createWorkflow } from '../src/workflow/index.ts';
import { emptyState, STATE_TYPE } from '../src/todos/state.ts';
import { widgetHeightBudget } from '../src/ui/render.ts';

test('restored standalone handoff survives /todos hide -> /plan start at nine terminal rows', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dag-widget-hidden-plan-'));
  const prior = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = join(root, 'agent');
  const events = new Map<string, Function[]>();
  const commands = new Map<string, any>();
  const tools = new Map<string, any>();
  let leaf = 1;
  let widget: any;
  const entries: any[] = [
    { type: 'custom', customType: STATE_TYPE, data: { ...emptyState(), nextId: 2, tasks: [{ id: 1, subject: 'Todo should stay hidden', status: 'pending', blockedBy: [] }] } },
    { type: 'custom', customType: 'pi-dag-workflow.agents', data: { version: 1, nextId: 2, jobs: [{
      id: 'a1', profile: 'fixture', model: { provider: 'fixture', id: 'offline' }, thinking: 'off', tools: ['read'],
      status: 'completed', startedAt: 1, endedAt: 2, pendingRequests: 0, reportDelivery: 'pending', output: 'ready to deliver', requests: [],
    }] } },
  ];
  const notifications: { text: string; type: string }[] = [];
  const pi: any = {
    on(name: string, fn: Function) { events.set(name, [...events.get(name) ?? [], fn]); },
    registerCommand(name: string, command: any) { commands.set(name, command); },
    registerTool(tool: any) { tools.set(tool.name, tool); },
    registerFlag() {}, getFlag() {}, getActiveTools: () => ['read'], getAllTools: () => [...tools.values()],
    appendEntry(customType: string, data: any) { entries.push({ type: 'custom', customType, data }); leaf++; },
    sendMessage() { throw Error('unexpected wake'); }, sendUserMessage() { throw Error('unexpected model request'); },
  };
  const ctx: any = {
    mode: 'tui', hasUI: true, cwd: root, isIdle: () => true, modelRegistry: { find: () => undefined },
    sessionManager: { getBranch: () => [...entries], getLeafId: () => String(leaf), getSessionFile: () => undefined },
    ui: { theme: undefined, notify(text: string, type: string) { notifications.push({ text, type }); }, setWidget(_key: string, value: any) { widget = value; } },
  };
  const fire = async (name: string) => {
    const event = {};
    for (const fn of events.get(name) ?? []) await fn(event, ctx);
  };
  try {
    const workflow = createWorkflow(pi);
    for (const feature of ['todos', 'plan', 'agents', 'ui'] as const) await workflow.attach(feature, pi);
    await fire('session_start');
    await commands.get('todos').handler('hide', ctx);
    await commands.get('plan').handler('start', ctx);
    assert.ok(entries.at(-1).data.plan && !entries.at(-1).data.visible);
    assert.ok(!notifications.some((notification) => notification.type === 'error'), JSON.stringify(notifications));
    assert.equal(typeof widget, 'function');
    const terminal = { rows: 9 };
    const component = widget({ terminal });
    for (const rows of [9, 12, 24, 9]) {
      terminal.rows = rows;
      const lines: string[] = component.render(100);
      assert.ok(lines.length <= widgetHeightBudget(rows));
      assert.ok(lines.every((line) => visibleWidth(line) <= 100));
      assert.match(lines.join('\n'), /a1/);
      assert.match(lines.join('\n'), /待交付|Pending delivery/);
      assert.doesNotMatch(lines.join('\n'), /Todo should stay hidden/);
    }
  } finally {
    await fire('session_shutdown');
    if (prior === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = prior;
    await rm(root, { recursive: true, force: true });
  }
});
