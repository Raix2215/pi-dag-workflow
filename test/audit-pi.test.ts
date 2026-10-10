import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { IsolatedClient } from './fixtures/isolated-client.ts';
import { GOAL_TYPE } from '../src/goal/state.ts';
const controls = fileURLToPath(new URL('./fixtures/session-controls.ts', import.meta.url));
const offline = fileURLToPath(new URL('./fixtures/offline-model.ts', import.meta.url));
const start = () => IsolatedClient.start(undefined, 'audit-pi', [controls], ['--dag-workflow-test-child-provider', offline]);
async function call(client: IsolatedClient, name: string, params: object) {
  const events = await client.prompt(`TEST CALL ${name} ${JSON.stringify(params)}`);
  const event = events.find((record) => record.type === 'tool_execution_end' && record.toolName === name)!; assert.ok(event);
  return { ...(event.result as any), isError: event.isError === true || (event.result as any)?.isError === true };
}
test('actual Pi: cancelling tree navigation stops live children but does not strand the current runtime', { timeout: 30000 }, async (t) => {
  const client = await start(); t.after(() => client.close());
  await client.prompt('/todos add 原任务');
  const target = (await client.entries()).find((entry: any) => entry.customType === 'pi-dag-workflow.state') as any;
  const job = await call(client, 'subagent_spawn', { task: 'TEST CALL subagent_send {"message":"保持等待","question":true}', todoId: 1 });
  await call(client, 'subagent_inspect', { jobId: job.details.jobId, output: true, timeout: 10 });
  await client.prompt('/test-cancel-tree'); await client.prompt(`/test-tree ${target.id}`);
  const summary = await call(client, 'subagent_inspect', {});
  assert.equal(summary.details.jobs[0].status, 'interrupted');
  const next = await call(client, 'subagent_spawn', { task: '只读检查', todoId: 1 });
  assert.equal(next.isError, false);
  assert.equal((await call(client, 'subagent_inspect', { jobId: next.details.jobId, output: true, timeout: 10 })).details.status, 'completed');
});
test('actual Pi: Profile saves at the requested user path; malformed Goal history needs confirmed reset', { timeout: 30000 }, async (t) => {
  const client = await start(); t.after(() => client.close());
  await client.prompt('/agents profile user dag-test/scripted off read');
  const file = join(client.root, 'agent', 'pi-dag-workflow', 'pi-dag-workflow-profile.json');
  assert.equal(JSON.parse(await readFile(file, 'utf8')).profiles[0].name, 'user');
  await call(client, 'goal', { action: 'create', title: '保留历史' });
  await client.prompt('/test-goal-corrupt'); await client.prompt('/test-reload');
  assert.equal((await call(client, 'goal', { action: 'create', title: '禁止覆盖' })).isError, true);
  const reset = client.prompt('/goal reset');
  await client.until(() => client.records.some((record) => record.method === 'confirm' && record.title === '清除 Goal 状态？'));
  const request = client.records.findLast((record) => record.method === 'confirm')!;
  client.child.stdin.write(`${JSON.stringify({ type: 'extension_ui_response', id: request.id, confirmed: true })}\n`);
  await reset;
  assert.equal((await call(client, 'goal', { action: 'create', title: '明确重置后可工作' })).isError, false);
  const snapshots = (await client.entries() as any[]).filter((entry) => entry.customType === GOAL_TYPE);
  assert.ok(snapshots.some((entry) => entry.data.version === 99), 'corrupt history is never erased');
  assert.equal(snapshots.at(-1).data.goals[0].title, '明确重置后可工作');
});
