import assert from 'node:assert/strict';
import { test } from 'node:test';
import { IsolatedClient } from './fixtures/isolated-client.ts';

async function call(client: IsolatedClient, params: object, expectError = false) {
  const records = await client.prompt(`TEST CALL subagent_inspect ${JSON.stringify(params)}`);
  const end = records.find((record) => record.type === 'tool_execution_end' && record.toolName === 'subagent_inspect')!;
  assert.ok(end);
  assert.equal(end.isError === true || (end.result as any).isError === true, expectError, JSON.stringify(end));
  return (end.result as any).details;
}

test('actual Pi: merged inspection refuses ambiguous output/directory/wait parameters', { timeout: 15000 }, async (t) => {
  const client = await IsolatedClient.start(); t.after(() => client.close());
  for (const params of [{ output: true }, { jobId: 'a1', timeout: 0 }, { jobId: 'a1', after: 0 }, { jobId: 'a1', until: 'finish' }, { jobId: 'a1', output: true, profiles: 'summary' }, { jobId: 'a1', output: true, profile: 'unknown' }]) await call(client, params, true);
  await client.prompt('ordinary input');
  const entries = await client.entries() as any[];
  const declared = entries.flatMap((entry) => entry.message?.toolsAdded ?? []).map((tool) => tool.name);
  assert.equal(declared.filter((name) => name === 'subagent_inspect').length, 1);
  assert.ok(!declared.includes('subagent_wait'), 'no silent model-tool alias');
});

test('actual Pi: short status never returns full output; collection delivers report but does not accept Todo', { timeout: 20000 }, async (t) => {
  const offline = new URL('./fixtures/offline-model.ts', import.meta.url).pathname;
  const client = await IsolatedClient.start(undefined, 'merged-query', [], ['--dag-workflow-test-child-provider', offline]); t.after(() => client.close());
  await client.prompt('TEST CALL todo {"action":"create","subject":"verify actual artifacts"}');
  const spawned = await client.prompt('TEST CALL subagent_spawn {"task":"short assigned work","todoId":1}');
  const id = (spawned.find((record) => record.type === 'tool_execution_end' && record.toolName === 'subagent_spawn')!.result as any).details.jobId;
  const status = await call(client, { jobId: id });
  assert.equal(status.jobs.length, 1); assert.equal(status.output, undefined); assert.equal(status.jobs[0].output, undefined);
  const report = await call(client, { jobId: id, output: true, profiles: false, until: 'finish', timeout: 8 });
  assert.equal(report.status, 'completed'); assert.match(report.output, /离线模拟/);
  assert.equal(report.reportDelivery, 'delivered'); assert.equal(report.todoStatus, 'in_progress');
  assert.equal((await call(client, { jobId: id })).jobs[0].todoStatus, 'in_progress');
});
