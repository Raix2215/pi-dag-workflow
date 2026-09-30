import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import { stripTerminalSequences } from '@earendil-works/pi-tui';
import { IsolatedClient } from './fixtures/isolated-client.ts';
import { STATE_TYPE } from '../src/todos.ts';
import { GOAL_TYPE } from '../src/goals.ts';
import { AGENTS_TYPE } from '../src/agent-tools.ts';
const controls = fileURLToPath(new URL('./fixtures/session-controls.ts', import.meta.url));
const offline = fileURLToPath(new URL('./fixtures/offline-model.ts', import.meta.url));
const start = (root?: string) => IsolatedClient.start(root, 'm4-joint', [controls], ['--dag-workflow-test-child-provider', offline]);
const state = async (client: IsolatedClient, type: string) => (await client.entries() as any[]).findLast((entry) => entry.customType === type)?.data;
async function call(client: IsolatedClient, tool: string, input: object) {
  const records = await client.prompt(`TEST CALL ${tool} ${JSON.stringify(input)}`);
  const event = records.find((record) => record.type === 'tool_execution_end' && record.toolName === tool)!; assert.ok(event);
  return { ...event.result as any, isError: event.isError === true || (event.result as any)?.isError === true };
}

test('actual Pi joint: Plan DAG, blocked dispatch, child files, manual acceptance, Goal and native restart', { timeout: 60000 }, async (t) => {
  let client = await start(); t.after(() => client.close());
  await client.prompt('开始联合验收');
  await client.prompt('/plan start');
  for (const [subject, deps] of [['确认需求', []], ['生成左文件', [1]], ['生成右文件', [1]], ['核验整合', [2, 3]]] as const) await call(client, 'todo', { action: 'create', subject, blockedBy: deps });
  const graph = await client.prompt('/dag');
  const notice = graph.findLast((record) => record.method === 'notify')!;
  assert.match(String(notice.message), /┌.*─.*┐/); assert.doesNotMatch(String(notice.message), /<-/);
  assert.equal((await call(client, 'subagent_spawn', { task: 'not allowed' })).isError, true);
  await client.prompt('/plan off');
  assert.equal((await call(client, 'subagent_spawn', { task: 'blocked', todoId: 2 })).isError, true);
  await call(client, 'todo', { action: 'update', id: 1, status: 'completed' });
  await call(client, 'goal', { action: 'create', title: '联合验收目标', maxTurns: 2 });
  await call(client, 'goal', { action: 'enable', id: 1 });
  await call(client, 'goal', { action: 'pause' });
  const pausedUsed = (await state(client, GOAL_TYPE)).run.used;
  const ids: string[] = [];
  for (const [todoId, path, content] of [[2, 'left.txt', 'LEFT\n'], [3, 'right.txt', 'RIGHT\n']] as const) {
    const result = await call(client, 'subagent_spawn', { task: `TEST CALL write ${JSON.stringify({ path, content })}`, todoId, tools: ['read', 'write'], timeout: 20 });
    assert.equal(result.isError, false); ids.push(result.details.jobId);
  }
  for (const jobId of ids) assert.equal((await call(client, 'subagent_wait', { jobId, timeout: 10 })).details.status, 'completed');
  assert.equal(await readFile(`${client.root}/left.txt`, 'utf8'), 'LEFT\n');
  assert.equal(await readFile(`${client.root}/right.txt`, 'utf8'), 'RIGHT\n');
  const tasks = (await state(client, STATE_TYPE)).tasks;
  assert.equal(tasks[1].status, 'in_progress'); assert.equal(tasks[2].status, 'in_progress', 'child return never completes a Todo');
  assert.equal((await call(client, 'todo', { action: 'update', id: 4, status: 'in_progress' })).isError, true);
  for (const id of [2, 3]) await call(client, 'todo', { action: 'update', id, status: 'completed' });
  await call(client, 'todo', { action: 'update', id: 4, status: 'in_progress' });
  await call(client, 'read', { path: 'left.txt' }); await call(client, 'read', { path: 'right.txt' });
  await call(client, 'todo', { action: 'update', id: 4, status: 'completed' });
  assert.equal((await state(client, GOAL_TYPE)).run.used, pausedUsed, 'explicit user tests do not refill the paused Goal');
  await call(client, 'goal', { action: 'complete' });
  await client.prompt('/todos view dag');
  const widget = client.records.findLast((record) => record.method === 'setWidget' && Array.isArray(record.widgetLines))!;
  const displayed = (widget.widgetLines as string[]).map(stripTerminalSequences).join('\n');
  assert.match(displayed, /图预览/); assert.doesNotMatch(displayed, /<-/);
  const messages = (await client.send('get_messages')).data as any;
  assert.ok(!JSON.stringify(messages).includes('图预览'), 'UI is not model context');
  await client.close(false); client = await start(client.root);
  assert.ok(!client.records.some((record) => record.type === 'agent_start'));
  assert.equal((await state(client, STATE_TYPE)).tasks.filter((task: any) => task.status === 'completed').length, 4);
  assert.equal((await state(client, GOAL_TYPE)).goals[0].status, 'completed');
  assert.equal((await state(client, AGENTS_TYPE)).jobs.length, 2);
});

test('actual Pi long branch: 80 tasks, 60 progress changes and restores keep stable ids and no duplicate graph state', { timeout: 60000 }, async (t) => {
  const client = await start(); t.after(() => client.close());
  await client.prompt('长会话回归');
  for (let i = 1; i <= 80; i++) await client.prompt(`/todos add 节点${i}${i > 1 ? ` --after ${i - 1}` : ''}`);
  for (let i = 1; i <= 30; i++) { await client.prompt(`/todos start ${i}`); await client.prompt(`/todos done ${i}`); }
  const before = await state(client, STATE_TYPE);
  await client.prompt('/test-reload');
  const restored = await state(client, STATE_TYPE);
  assert.deepEqual(restored, before); assert.equal(restored.nextId, 81);
  const graph = await client.prompt('/dag');
  assert.ok(graph.some((record) => record.method === 'notify' && String(record.message).includes('#80')));
  const entries = await client.entries() as any[];
  assert.ok(!entries.some((entry) => /dag[-_.]?(layout|graph|queue)/.test(entry.customType ?? '')), 'DAG never becomes a second persisted state');
  assert.ok(!client.records.some((record) => record.type === 'extension_error'));
});
