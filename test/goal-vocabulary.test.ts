import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Value } from 'typebox/value';
import { registerGoal } from '../src/goal/register.ts';
import { emptyState } from '../src/todos/state.ts';
import { GoalParamsSchema, type GoalParams } from '../src/goal/state.ts';

function host() {
  const tools = new Map<string, any>(); const commands = new Map<string, any>();
  const notifications: string[] = []; const wakes: any[] = []; const entries: any[] = [];
  let workflow = emptyState();
  const ctx: any = { cwd: '/tmp', mode: 'rpc', hasUI: true, isIdle: () => true, sessionManager: { getBranch: () => entries }, ui: { notify: (text: string, level: string) => notifications.push(`${level}:${text}`), confirm: async () => true } };
  const pi: any = { on() { return () => {}; }, registerTool(tool: any) { tools.set(tool.name, tool); }, registerCommand(name: string, cmd: any) { commands.set(name, cmd); }, appendEntry(customType: string, data: any) { entries.push({ type: 'custom', customType, data: structuredClone(data) }); }, sendMessage(message: any, options: any) { wakes.push({ message, options }); }, sendUserMessage(message: string) { wakes.push({ message, options: { source: 'extension' } }); } };
  const controller = registerGoal(pi, { state: () => workflow, jobs: () => [], paint() {}, protected: () => false, pauseAgents() {}, resumeAgents() {} });
  const call = async (params: GoalParams) => tools.get('goal').execute('test', params, undefined, undefined, ctx);
  const command = (text: string) => commands.get('goal').handler(text, ctx);
  return { controller, call, command, notifications, wakes, entries };
}

const NON_ACTIONS = ['focus', 'switch', 'resume', 'pause', 'on', 'off', 'done', 'del', 'create', 'status'];

test('Goal commands keep no alias layer: unlisted words go to the model as natural language', async () => {
  const h = host();
  for (const word of NON_ACTIONS) {
    h.notifications.length = 0; h.wakes.length = 0;
    await h.command(`${word} #1`);
    assert.equal(h.wakes.length, 1, `${word} is not a command action, so it is forwarded`);
    assert.match(String(h.wakes[0]!.message), /^请管理当前 Goal：/);
    assert.equal(h.notifications.length, 0, `${word} must not print a compatibility hint`);
  }
});

test('the Goal tool schema exposes one literal per operation', () => {
  for (const action of ['create', 'update', 'list', 'get', 'delete', 'enable', 'disable', 'complete']) {
    assert.equal(Value.Check(GoalParamsSchema, { action, title: 'x' }), true, action);
  }
  // `create` is the tool's own action name; the command word for it is `new`.
  for (const action of NON_ACTIONS.filter((word) => word !== 'create')) assert.equal(Value.Check(GoalParamsSchema, { action }), false, action);
});

test('canonical Goal commands act without aliases', async () => {
  const h = host();
  await h.call({ action: 'create', title: 'A' });
  await h.call({ action: 'create', title: 'B' });
  await h.command('enable #2');
  assert.equal(h.controller.snapshot().focusId, 2);
  await h.command('disable');
  assert.equal(h.controller.snapshot().run.paused, true);
  assert.equal(h.controller.snapshot().run.reason, '已停用');
  await h.command('enable');
  assert.equal(h.controller.snapshot().run.paused, false);
  assert.equal(h.controller.snapshot().focusId, 2, 'omitting the id re-enables the current focus');
  await h.command('complete #2');
  assert.equal(h.controller.snapshot().goals[1]!.status, 'completed');
  assert.equal(h.controller.snapshot().focusId, undefined);
  // The command list is the vocabulary: two ids on a single-id action are rejected.
  for (const text of ['enable #1 #2', 'disable #1 #2']) {
    h.notifications.length = 0; h.wakes.length = 0;
    await h.command(text);
    const notice = h.notifications.at(-1) ?? '';
    assert.ok(notice.startsWith('error:') && notice.includes('此命令只接受一个编号'), `${text}: ${notice}`);
    assert.equal(h.wakes.length, 0, text);
  }
});
