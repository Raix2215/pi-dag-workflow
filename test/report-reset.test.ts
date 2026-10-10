import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { IsolatedClient } from './fixtures/isolated-client.ts';
import { foldAgentEntries } from '../src/agents/persistence.ts';

const offline = fileURLToPath(new URL('./fixtures/offline-model.ts', import.meta.url));
async function call(client: IsolatedClient, name: string, params: object) {
  const events = await client.prompt(`TEST CALL ${name} ${JSON.stringify(params)}`);
  const event = events.find((item) => item.type === 'tool_execution_end' && item.toolName === name)!;
  assert.ok(event, `${name} must have executed`);
  assert.ok(!event.isError && !(event.result as any).isError, JSON.stringify(event.result));
  return (event.result as any).details;
}
const savedJobs = (entries: any[]) => foldAgentEntries(entries).records as any[];

test('real Pi: fragment reset invalidates every reopened task report and redispatch creates fresh evidence', { timeout: 30000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dag-report-reset-'));
  const dir = join(root, 'agent', 'pi-dag-workflow');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'pi-dag-workflow-preset.json'), JSON.stringify({ presets: [{ name: 'check', steps: [{ key: 'a', subject: 'first check' }, { key: 'b', subject: 'second check', after: ['a'] }] }] }));
  const client = await IsolatedClient.start(root, 'report-reset', [], ['--dag-workflow-test-child-provider', offline]);
  t.after(() => client.close());
  await call(client, 'todo', { action: 'apply', preset: 'check' });
  const ids: string[] = [];
  for (const todoId of [1, 2]) {
    const spawned = await call(client, 'subagent_spawn', { task: 'Offline retained evidence', todoId });
    ids.push(spawned.jobId);
    const result = await call(client, 'subagent_inspect', { jobId: spawned.jobId, output: true });
    assert.equal(result.status, 'completed');
    await call(client, 'todo', { action: 'update', id: todoId, status: 'completed' });
  }
  await call(client, 'todo', { action: 'reset', preset: 'check', step: 'a' });
  const historical = savedJobs(await client.entries() as any[]);
  for (const id of ids) {
    const job = historical.find((job) => job.id === id)!;
    assert.equal(job.taskReportStale, true, 'root and downstream evidence both belong to the prior attempt');
    assert.ok(job.output.length > 0, 'reset does not delete historical output');
  }
  const fresh = await call(client, 'subagent_spawn', { task: 'Fresh offline evidence', todoId: 1 });
  await call(client, 'subagent_inspect', { jobId: fresh.jobId, output: true });
  const jobs = savedJobs(await client.entries() as any[]);
  assert.equal(jobs.find((job) => job.id === fresh.jobId).taskReportStale, undefined);
  assert.equal(jobs.find((job) => job.id === ids[0]).taskReportStale, true);
});
