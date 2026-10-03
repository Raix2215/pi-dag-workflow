import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Theme } from '@earendil-works/pi-coding-agent';
import { stripTerminalSequences, visibleWidth } from '@earendil-works/pi-tui';
import { emptyState, STATE_TYPE, type Todo, type WorkflowState } from '../src/todos/state.ts';
import { createTranslator } from '../src/shared/i18n.ts';
import { renderTasks, renderDag, type AgentView } from '../src/ui/render.ts';
import { AGENTS_TYPE } from '../src/agents/register.ts';
import { IsolatedClient } from './fixtures/isolated-client.ts';

// ---------------------------------------------------------------------------
// Pure projection: the Todo owns acceptance, the job only records execution
// ---------------------------------------------------------------------------

const task = (id: number, status: Todo['status'], subject = `任务${id}`): Todo => ({ id, subject, status, blockedBy: [] });
const state = (...tasks: Todo[]): WorkflowState => ({ ...emptyState(), tasks, nextId: tasks.length + 1 });
const job = (id: string, todoId: number | undefined, extra: Partial<AgentView> = {}): AgentView => ({ id, profile: 'worker', status: 'completed', ...(todoId === undefined ? {} : { todoId }), ...extra });
const plain = (lines: string[]): string => lines.map(stripTerminalSequences).join('\n');
const list = (current: WorkflowState, jobs: readonly AgentView[], width = 120): string => plain(renderTasks(current, width, { jobs, maxRows: Infinity }));
const graph = (current: WorkflowState, jobs: readonly AgentView[], width = 120): string => plain(renderDag(current, width, undefined, undefined, jobs, { maxLines: 20 }));

test('a completed Todo shows its own state regardless of the job that reported on it', () => {
  const current = state(task(1, 'completed'));
  const terminalJobs = [
    job('a1', 1),
    job('a1', 1, { reportDelivery: 'pending' }),
    job('a1', 1, { reportDelivery: 'delivered' }),
    job('a1', 1, { status: 'failed' }),
    job('a1', 1, { status: 'running', activity: { kind: 'tool', tool: 'read', since: Date.now() - 3000 } }),
  ];
  for (const candidate of terminalJobs) {
    const jobs = [candidate];
    for (const width of [40, 80, 120]) {
      const text = list(current, jobs, width);
      assert.match(text, /\[󰄬 已完成\]/, `${width}: ${text}`);
      assert.doesNotMatch(text, /待交付|待核验|已返回|失败|运行中|思考中/);
      for (const line of renderTasks(current, width, { jobs, maxRows: Infinity })) assert.ok(visibleWidth(line) <= width, `${width}: ${line}`);
    }
    assert.match(graph(current, jobs), /\[󰄬 已完成\]/);
  }
});

test('an unfinished Todo separates pending delivery from pending verification', () => {
  const running = state(task(1, 'in_progress'));
  assert.match(list(running, [job('a1', 1, { reportDelivery: 'pending' })]), /\[󰥔 待交付\]/);
  assert.match(list(running, [job('a1', 1, { reportDelivery: 'delivered' })]), /\[󰥔 待核验\]/);
  assert.match(list(running, [job('a1', 1)]), /\[󰥔 待核验\]/, 'a completed job without a delivery marker still requires verification');
  assert.doesNotMatch(list(running, [job('a1', 1, { reportDelivery: 'pending' })]), /待核验/);
  // A pending Todo with a finished report also waits for verification rather than a fresh return.
  const pending = state(task(1, 'pending'));
  assert.match(list(pending, [job('a1', 1, { reportDelivery: 'delivered' })]), /\[󰥔 待核验\]/);
  assert.match(list(pending, [job('a1', 1, { reportDelivery: 'pending' })]), /\[󰥔 待交付\]/);
});

test('a stale reopened report shows the canonical Todo state, never a fresh acceptance', () => {
  const actions = [
    list(state(task(1, 'pending')), [job('a1', 1, { reportDelivery: 'delivered', taskReportStale: true })]),
    list(state(task(1, 'in_progress')), [job('a1', 1, { reportDelivery: 'pending', taskReportStale: true })]),
    // The stale flag outranks a retained failure label too.
    list(state(task(1, 'in_progress')), [job('a1', 1, { status: 'failed', taskReportStale: true })]),
  ];
  assert.match(actions[0]!, /\[待执行\]/);
  assert.match(actions[1]!, /\[进行中\]/);
  assert.match(actions[2]!, /\[进行中\]/);
  for (const text of actions) assert.doesNotMatch(text, /待交付|待核验|已返回|失败/);
  // A completed Todo still owns the row after a reopen marked its old report stale.
  assert.match(list(state(task(1, 'completed')), [job('a1', 1, { taskReportStale: true })]), /\[󰄬 已完成\]/);
});

test('live and failure labels stay for unfinished non-stale jobs', () => {
  const current = state(task(1, 'in_progress'));
  assert.match(list(current, [job('a1', 1, { status: 'starting' })]), /\[󰓦 启动中\]/);
  assert.match(list(current, [job('a1', 1, { status: 'running' })]), /\[󰥔 运行中\]/);
  assert.match(list(current, [job('a1', 1, { status: 'waiting' })]), /\[󰋗 等待回复\]/);
  assert.match(list(current, [job('a1', 1, { status: 'running', activity: { kind: 'thinking', since: Date.now() - 1000 } })]), /󰧑 思考中/);
  assert.match(list(current, [job('a1', 1, { status: 'failed' })]), /\[󰅙 失败\]/);
  assert.match(list(current, [job('a1', 1, { status: 'cancelled' })]), /\[󰓛 已取消\]/);
  assert.match(list(current, [job('a1', 1, { status: 'interrupted' })]), /\[󰙦 已中断\]/);
});

test('unbound jobs keep the original returned and delivery semantics', () => {
  const current = state(task(1, 'pending'));
  assert.match(list(current, [job('a1', undefined, { reportDelivery: 'pending' })]), /\[󰥔 待交付\]/);
  assert.match(list(current, [job('a1', undefined, { status: 'running' })]), /\[󰥔 运行中\]/);
  assert.match(list(current, [job('a1', undefined, { status: 'failed' })]), /\[󰅙 失败\]/);
  // A delivered unbound report has nothing left to carry, exactly as before.
  assert.doesNotMatch(list(current, [job('a1', undefined, { reportDelivery: 'delivered' })]), /Standalone/);
});

test('the acceptance projection is identical in the list, widget and full DAG previews', () => {
  const current = state(task(1, 'completed'), task(2, 'in_progress'));
  const jobs = [job('a1', 1), job('a2', 2, { reportDelivery: 'pending' })];
  for (const width of [24, 40, 80, 120]) {
    for (const line of renderTasks(current, width, { jobs, maxRows: Infinity })) assert.ok(visibleWidth(line) <= width, `${width}: ${line}`);
    for (const line of renderDag(current, width, undefined, undefined, jobs, { maxLines: 20 })) assert.ok(visibleWidth(line) <= width, `${width}: ${line}`);
  }
  const text = list(current, jobs);
  assert.match(text, /\[󰄬 已完成\]/);
  assert.match(text, /\[󰥔 待交付\]/);
  const preview = graph(current, jobs);
  assert.match(preview, /\[󰄬 已完成\]/);
  assert.match(preview, /\[󰥔 待交付\]/);
  // The Nerd Font row icons survive the new projection.
  assert.match(text, /[✓◐]/);
});

test('the handoff stages keep the warning tint, completion keeps success, stale keeps the Todo tint', () => {
  const builtin = JSON.parse(readFileSync(new URL('../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/dark.json', import.meta.url), 'utf8'));
  const tokens = Object.keys(builtin.colors);
  const foreground = Object.fromEntries(tokens.map((token) => [token, token === 'warning' ? '#ffcc00' : '#cccccc']));
  const background = Object.fromEntries(tokens.map((token) => [token, '#222222']));
  const theme = new Theme(foreground as never, background as never, 'truecolor');
  const render = (current: WorkflowState, jobs: readonly AgentView[]): string => renderTasks(current, 120, { jobs, maxRows: Infinity, theme }).join('\n');
  const running = state(task(1, 'in_progress'));
  assert.ok(render(running, [job('a1', 1, { reportDelivery: 'pending' })]).includes(theme.fg('warning', '[󰥔 待交付]')));
  assert.ok(render(running, [job('a1', 1, { reportDelivery: 'delivered' })]).includes(theme.fg('warning', '[󰥔 待核验]')));
  assert.ok(render(state(task(1, 'completed')), [job('a1', 1)]).includes(theme.fg('success', '[󰄬 已完成]')));
  assert.ok(render(running, [job('a1', 1, { reportDelivery: 'delivered', taskReportStale: true })]).includes(theme.fg('accent', '[进行中]')));
});

test('a bound live tool name still shortens to ten columns', () => {
  const current = state(task(1, 'in_progress'));
  const live = plain(renderTasks(current, 120, { jobs: [job('a1', 1, { status: 'running', activity: { kind: 'tool', tool: 'mcp__github__list_repository_files', since: Date.now() - 3000 } })], maxRows: Infinity }));
  assert.match(live, /󰆍 list_repo… 3s/);
});

test('English acceptance labels stay Han-free once the catalog carries them', () => {
  const en = createTranslator('en');
  const current = state({ ...task(1, 'in_progress'), subject: 'work item' });
  for (const jobs of [[job('a1', 1, { reportDelivery: 'pending' })], [job('a1', 1, { reportDelivery: 'delivered' })], [job('a1', 1, { taskReportStale: true })], [job('a1', 1, { status: 'running' })]]) {
    const text = plain(renderTasks(current, 120, { jobs, maxRows: Infinity, msg: en }));
    assert.doesNotMatch(text, /\p{Script=Han}/u, text);
  }
  const completed = state({ ...task(1, 'completed'), subject: 'work item' });
  assert.match(plain(renderTasks(completed, 120, { jobs: [job('a1', 1)], maxRows: Infinity, msg: en })), /Completed/);
});

// ---------------------------------------------------------------------------
// Real isolated Pi session: the runtime projection follows a real Todo update
// ---------------------------------------------------------------------------

const offline = fileURLToPath(new URL('./fixtures/offline-model.ts', import.meta.url));
const start = () => IsolatedClient.start(undefined, 'task-acceptance', [], ['--dag-workflow-test-child-provider', offline]);
async function call(client: IsolatedClient, name: string, args: unknown) {
  const events = await client.prompt(`TEST CALL ${name} ${JSON.stringify(args)}`);
  const event = events.find((item) => item.type === 'tool_execution_end' && item.toolName === name);
  assert.ok(event, `expected ${name}`);
  return event.result as { isError?: boolean; details: Record<string, any>; content: { text: string }[] };
}
const lastWidget = (client: IsolatedClient): string => {
  const record = client.records.findLast((item) => item.method === 'setWidget' && Array.isArray(item.widgetLines));
  return ((record?.widgetLines as string[] | undefined) ?? []).map(stripTerminalSequences).join('\n');
};
const todoState = (entries: unknown[]): WorkflowState => (entries as { customType?: string; data?: WorkflowState }[]).findLast((entry) => entry.customType === STATE_TYPE)!.data!;

test('actual Pi: completing the Todo flips the bound label while the execution status stays completed', { timeout: 30000 }, async (t) => {
  const client = await start();
  t.after(() => client.close());
  await client.prompt('开始任务验收投影');
  await client.prompt('/todos add 实现验收状态');
  const spawned = await call(client, 'subagent_spawn', { task: '完成只读验收', todoId: 1 });
  assert.ok(!spawned.isError, JSON.stringify(spawned));
  const jobId = spawned.details.jobId as string;
  assert.equal(spawned.details.todoStatus, 'in_progress');

  const waited = await call(client, 'subagent_wait', { jobId, timeout: 10 });
  assert.equal(waited.details.status, 'completed');
  assert.equal(waited.details.todoStatus, 'in_progress');
  // The report reached this context, so the bound row waits for verification.
  await client.until(() => lastWidget(client).includes('待核验'));

  let inspected = await call(client, 'subagent_inspect', { jobId });
  assert.equal(inspected.details.jobs[0].status, 'completed');
  assert.equal(inspected.details.jobs[0].todoStatus, 'in_progress');

  const updated = await call(client, 'todo', { action: 'update', id: 1, status: 'completed' });
  assert.ok(!updated.isError, JSON.stringify(updated));
  await client.until(() => lastWidget(client).includes('已完成'));

  inspected = await call(client, 'subagent_inspect', { jobId });
  assert.equal(inspected.details.jobs[0].status, 'completed', 'the execution state machine is unchanged');
  assert.equal(inspected.details.jobs[0].todoStatus, 'completed');
  const reread = await call(client, 'subagent_wait', { jobId, timeout: 0 });
  assert.equal(reread.details.status, 'completed');
  assert.equal(reread.details.todoStatus, 'completed');
  assert.equal(todoState(await client.entries()).tasks[0]!.status, 'completed');
  // The projection is display-only: persisted Agent state never gains a todoStatus field.
  const persisted = (await client.entries()).findLast((entry) => (entry as { customType?: string }).customType === AGENTS_TYPE) as { data: { jobs: Record<string, unknown>[] } };
  assert.ok(persisted.data.jobs.length > 0);
  for (const record of persisted.data.jobs) assert.ok(!Object.hasOwn(record, 'todoStatus'), JSON.stringify(record));
});

test('actual Pi: an unbound job keeps returned/delivery semantics without a todoStatus field', { timeout: 30000 }, async (t) => {
  const client = await start();
  t.after(() => client.close());
  await client.prompt('开始无绑定验收');
  const spawned = await call(client, 'subagent_spawn', { task: '完成无绑定只读验收' });
  assert.ok(!spawned.isError, JSON.stringify(spawned));
  const jobId = spawned.details.jobId as string;
  const waited = await call(client, 'subagent_wait', { jobId, timeout: 10 });
  assert.equal(waited.details.status, 'completed');
  assert.equal(waited.details.todoStatus, undefined, 'an unbound job never invents a Todo status');
  const inspected = await call(client, 'subagent_inspect', { jobId });
  assert.equal(inspected.details.jobs[0].todoStatus, undefined);
});
