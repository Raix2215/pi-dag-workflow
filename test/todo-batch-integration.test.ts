import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { IsolatedClient } from './fixtures/isolated-client.ts';
import { STATE_TYPE } from '../src/todos/state.ts';

async function call(client: IsolatedClient, tool: string, params: object) {
  const events = await client.prompt(`TEST CALL ${tool} ${JSON.stringify(params)}`);
  const event = events.find((item) => item.type === 'tool_execution_end' && item.toolName === tool)!;
  assert.ok(event, `${tool} executed`);
  return { ...(event.result as any), isError: event.isError === true || (event.result as any).isError === true };
}
const snapshots = async (client: IsolatedClient) => (await client.entries() as any[]).filter((entry) => entry.type === 'custom' && entry.customType === STATE_TYPE);

test('actual Pi: atomic batches build 1,000 tasks, pagination/get remain compact, and reload/tree preserve the complete branch', { timeout: 60000 }, async (t) => {
  const helper = fileURLToPath(new URL('./fixtures/session-controls.ts', import.meta.url));
  const client = await IsolatedClient.start(undefined, 'todo-batch-reads', [helper]); t.after(() => client.close());
  for (let group = 0; group < 20; group++) {
    const operations = Array.from({ length: 50 }, (_, i) => ({ action: 'create', ref: `t${i}`, subject: `Task ${group * 50 + i + 1}`, ...(group === 9 && i === 49 ? { description: 'complete task instructions', metadata: { evidence: 'full metadata' } } : {}) }));
    const result = await call(client, 'todo', { action: 'batch', operations });
    assert.equal(result.isError, false); assert.equal(result.details.tasks.length, 50);
  }
  const before = await snapshots(client); assert.equal(before.length, 20, 'one canonical commit per batch');
  const first = await call(client, 'todo', { action: 'list' });
  assert.equal(first.details.tasks.length, 50); assert.equal(first.details.page.total, 1000);
  const ids: number[] = []; let params: any = { action: 'list', limit: 200 };
  while (params) { const page = await call(client, 'todo', params); ids.push(...page.details.tasks.map((task: any) => task.id)); params = page.details.page.next; }
  assert.deepEqual(ids, Array.from({ length: 1000 }, (_, i) => i + 1));
  const get = await call(client, 'todo', { action: 'get', id: 500 });
  assert.equal(get.details.tasks.length, 1); assert.equal(get.details.tasks[0].description, 'complete task instructions');
  assert.equal(get.details.tasks[0].metadata.evidence, 'full metadata');
  await call(client, 'todo', { action: 'update', id: 500, subject: 'Task 500' });
  assert.equal((await snapshots(client)).length, 20, 'reads and no-ops never append another canonical snapshot');
  const bad = await call(client, 'todo', { action: 'batch', operations: [{ action: 'create', subject: 'Must roll back' }, { action: 'update', id: 2000, subject: 'Missing' }] });
  assert.equal(bad.isError, true); assert.equal((await snapshots(client)).length, 20);
  await client.prompt('/plan start');
  const plan = await call(client, 'todo', { action: 'batch', operations: [{ action: 'create', ref: 'a', subject: 'Plan A' }, { action: 'create', subject: 'Plan B', blockedBy: ['@a'] }] });
  assert.equal(plan.isError, false); assert.deepEqual(plan.details.refs, { a: 1001 });
  await client.prompt('/plan off'); await client.prompt('/test-reload');
  assert.equal((await call(client, 'todo', { action: 'list' })).details.page.total, 1002);
  await client.prompt(`/test-tree ${before.at(-1)!.id}`);
  assert.equal((await call(client, 'todo', { action: 'list' })).details.page.total, 1000);
});

test('actual Pi: a batch cannot bypass an active child or partially commit another task', { timeout: 30000 }, async (t) => {
  const offline = fileURLToPath(new URL('./fixtures/offline-model.ts', import.meta.url));
  const client = await IsolatedClient.start(undefined, 'todo-batch-child-guard', [], ['--dag-workflow-test-child-provider', offline]); t.after(() => client.close());
  await call(client, 'todo', { action: 'create', subject: 'Owned task' });
  const child = await call(client, 'subagent_spawn', { todoId: 1, task: 'TEST CALL bash {"command":"sleep 10"}', tools: ['bash'] });
  assert.equal(child.isError, false);
  const before = (await snapshots(client)).at(-1)!.data;
  const operations = [{ action: 'create', subject: 'Would be partial' }, { action: 'update', id: 1, subject: 'Unannounced direction' }];
  const result = await call(client, 'todo', { action: 'batch', operations }); assert.equal(result.isError, true);
  assert.deepEqual((await snapshots(client)).at(-1)!.data, before);
  await call(client, 'subagent_cancel', { jobId: child.details.jobId });
  const allowed = await call(client, 'todo', { action: 'batch', operations }); assert.equal(allowed.isError, false);
  assert.equal(allowed.details.nextId, before.nextId + 1);
});
