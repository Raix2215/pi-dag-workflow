import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { renderTasks, renderDag, type AgentView } from '../src/ui/render.ts';
import { emptyState, type WorkflowState } from '../src/todos/state.ts';
import { createTranslator } from '../src/shared/i18n.ts';
import { IsolatedClient } from './fixtures/isolated-client.ts';
import { foldAgentEntries } from '../src/agents/persistence.ts';

const current = (): WorkflowState => ({ ...emptyState(), nextId: 2, tasks: [{ id: 1, subject: 'continue the real work', status: 'in_progress', blockedBy: [] }] });
const timedOut = (): AgentView => ({ id: 'a1', todoId: 1, profile: 'worker', status: 'failed', reportDelivery: 'delivered' });

test('explicit main takeover restores the row owner and status in list/DAG/full/preview filters', () => {
  for (const language of ['zh-CN', 'en'] as const) {
    const msg = createTranslator(language); const state = current(); const failed = timedOut();
    assert.match(renderTasks(state, 120, { jobs: [failed], msg }).join('\n'), /a1 · worker/);
    const stale = { ...failed, taskReportStale: true };
    for (const text of [renderTasks(state, 120, { jobs: [stale], msg }).join('\n'), renderTasks(state, 120, { jobs: [stale], msg, maxRows: Infinity, filter: 'pending' }).join('\n'), renderDag(state, 120, undefined, undefined, [stale], { msg }).join('\n'), renderDag(state, 120, undefined, undefined, [stale], { msg, maxLines: 11, filter: 'pending' }).join('\n')]) {
      assert.match(text, language === 'en' ? /\[Main session\]/ : /\[主会话\]/);
      assert.match(text, language === 'en' ? /\[In progress\]/ : /\[进行中\]/);
      assert.doesNotMatch(text, /a1 · worker|失败|Failed|待核验/);
    }
    const custom = { ...state, tasks: state.tasks.map((task) => ({ ...task, owner: 'reviewer' })) };
    assert.match(renderTasks(custom, 120, { jobs: [stale], msg }).join('\n'), /\[reviewer\]/);
    const fresh = { ...stale, id: 'a2', status: 'running' as const, taskReportStale: false };
    assert.match(renderTasks(state, 120, { jobs: [stale, fresh], msg }).join('\n'), /a2 · worker/);
  }
});

test('a wait observation timeout never transfers an actively running job to the main session', () => {
  const running = { ...timedOut(), status: 'running' as const };
  const text = renderTasks(current(), 120, { jobs: [running] }).join('\n');
  assert.match(text, /a1 · worker/); assert.match(text, /运行中/); assert.doesNotMatch(text, /\[主会话\]/);
});

test('real Pi: deadline failure, report verification, explicit main takeover and redispatch preserve history', { timeout: 30000 }, async (t) => {
  const offline = fileURLToPath(new URL('./fixtures/offline-model.ts', import.meta.url));
  const client = await IsolatedClient.start(undefined, 'task-takeover', [], ['--dag-workflow-test-child-provider', offline]);
  t.after(() => client.close());
  const call = async (name: string, params: object) => {
    const result = await client.prompt(`TEST CALL ${name} ${JSON.stringify(params)}`);
    const end = result.find((event) => event.type === 'tool_execution_end' && event.toolName === name)!;
    assert.equal(end.isError, false, JSON.stringify(end.result)); return (end.result as any).details;
  };
  await call('todo', { action: 'create', subject: 'take over the expired assignment' });
  const spawn = await call('subagent_spawn', { task: 'HOLD-IDLE-ENABLE-CHILD', todoId: 1, timeout: 2 });
  const ended = await call('subagent_wait', { jobId: spawn.jobId, until: 'finish', timeout: 8 });
  assert.equal(ended.status, 'failed'); assert.equal(ended.error, 'Agent deadline exceeded');
  await call('todo', { action: 'update', id: 1, status: 'in_progress' });
  const text = await client.prompt('/todos list pending');
  const display = text.filter((event) => event.method === 'notify').map((event) => event.message).join('\n');
  assert.match(display, /\[主会话\].*\[进行中\]/); assert.doesNotMatch(display, /a1 ·/);
  const records = foldAgentEntries(await client.entries()).records;
  assert.equal(records.find((record) => record.id === spawn.jobId)!.taskReportStale, true);
  assert.equal(records.find((record) => record.id === spawn.jobId)!.error, 'Agent deadline exceeded');
  const newJob = await call('subagent_spawn', { task: 'Fresh short assignment', todoId: 1 });
  assert.notEqual(newJob.jobId, spawn.jobId);
  const after = await client.prompt('/todos list pending');
  assert.match(after.filter((event) => event.method === 'notify').map((event) => event.message).join('\n'), new RegExp(`${newJob.jobId} ·`));
});
