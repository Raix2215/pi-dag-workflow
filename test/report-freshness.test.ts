import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { IsolatedClient } from './fixtures/isolated-client.ts';
import { foldAgentEntries, AgentJournal, foldAgentData } from '../src/agents/persistence.ts';
import { fragmentContext } from '../src/agents/context.ts';
import { STATE_TYPE, type WorkflowState } from '../src/todos/state.ts';
import { AgentRuntime } from '../src/agents/runtime.ts';
import { ProfileStore } from '../src/agents/profiles.ts';

const offline = fileURLToPath(new URL('./fixtures/offline-model.ts', import.meta.url));
test('real Pi: redirected or redefined tasks reject old interim evidence, accept a fresh report, and brief only the new scope', { timeout: 30000 }, async (t) => {
  const client = await IsolatedClient.start(undefined, 'report-freshness', [], ['--dag-workflow-test-child-provider', offline]);
  t.after(() => client.close());
  const call = async (name: string, params: object, succeeds = true) => {
    const events = await client.prompt(`TEST CALL ${name} ${JSON.stringify(params)}`);
    const end = events.find((event) => event.type === 'tool_execution_end' && event.toolName === name)!;
    assert.ok(end); assert.equal(Boolean((end.result as any).isError || end.isError), !succeeds, JSON.stringify(end.result));
    return (end.result as any).details;
  };
  await call('todo', { action: 'create', subject: 'original work', metadata: { preset: 'check', run: 1, key: 'first', step: 1 } });
  await call('todo', { action: 'create', subject: 'next step', blockedBy: [1], metadata: { preset: 'check', run: 1, key: 'second', step: 2 } });
  const first = await call('subagent_spawn', { task: 'CONTROL REPORT HOLD', todoId: 1 });
  const report = await call('subagent_wait', { jobId: first.jobId, after: 0, timeout: 8 });
  assert.match(report.output, /CONTROL-PROGRESS/); assert.equal(report.status, 'running');
  await call('subagent_send', { recipient: first.jobId, interrupt: true, message: 'HOLD-IDLE-ENABLE-CHILD' });
  await call('todo', { action: 'update', id: 1, status: 'completed' }, false);
  await call('todo', { action: 'update', id: 1, subject: 'replacement work requires fresh evidence' });
  await call('todo', { action: 'update', id: 1, status: 'completed' }, false);
  const version = (await call('subagent_inspect', { jobId: first.jobId })).jobs[0].reportVersion;
  await call('subagent_send', { recipient: first.jobId, interrupt: true, message: 'CONTROL FRESH REPORT HOLD' });
  const fresh = await call('subagent_wait', { jobId: first.jobId, after: version, timeout: 8 });
  assert.match(fresh.output.slice(fresh.outputStart), /FRESH-CURRENT-PROGRESS/);
  assert.doesNotMatch(fresh.output.slice(fresh.outputStart), /CONTROL-PROGRESS/);
  assert.match(fresh.output, /CONTROL-PROGRESS/, 'history is retained');
  await call('todo', { action: 'update', id: 1, status: 'completed' });
  const entries = await client.entries();
  const state = (entries as any[]).findLast((entry) => entry.customType === STATE_TYPE).data as WorkflowState;
  const jobs = foldAgentEntries(entries).records;
  const brief = fragmentContext(2, state.tasks, jobs)!;
  assert.match(brief, /FRESH-CURRENT-PROGRESS/); assert.doesNotMatch(brief, /CONTROL-PROGRESS/);
  const journal = new AgentJournal(); const data = journal.prepare(jobs, 2)!; journal.confirm();
  assert.equal(foldAgentData([data]).records[0]!.outputStart, fresh.outputStart);
  await call('subagent_cancel', { jobId: first.jobId });
});

for (const field of ['description', 'metadata'] as const) test(`real Pi: redefining ${field} of a queued assignment invalidates its old report without interrupt`, { timeout: 30000 }, async (t) => {
  const client = await IsolatedClient.start(undefined, 'redefined-report', [], ['--dag-workflow-test-child-provider', offline]); t.after(() => client.close());
  const call = async (name: string, params: object) => {
    const events = await client.prompt(`TEST CALL ${name} ${JSON.stringify(params)}`);
    return events.find((event) => event.type === 'tool_execution_end' && event.toolName === name)!.result as any;
  };
  await call('todo', { action: 'create', subject: 'first definition', metadata: { preset: 'check', run: 1, key: 'first', step: 1 } });
  const job = (await call('subagent_spawn', { task: 'CONTROL REPORT HOLD', todoId: 1 })).details.jobId;
  assert.match((await call('subagent_wait', { jobId: job, after: 0, timeout: 8 })).details.output, /CONTROL-PROGRESS/);
  await call('subagent_send', { recipient: job, message: 'HOLD-IDLE-ENABLE-CHILD' });
  const edited = await call('todo', { action: 'update', id: 1, ...(field === 'description' ? { description: 'new inputs need another check' } : { metadata: { preset: 'check', run: 2, key: 'first', step: 1 } }) }); assert.ok(!edited.isError);
  const completed = await call('todo', { action: 'update', id: 1, status: 'completed' }); assert.equal(completed.isError, true);
  await call('subagent_cancel', { jobId: job });
});

test('current output offsets survive restoration and malformed offsets fail atomically', async () => {
  const model = { provider: 'fixture', id: 'model' };
  const runtime = new AgentRuntime({ cwd: process.cwd(), profiles: new ProfileStore({ registry: { find: () => model } }), getInheritedModel: () => model });
  const record = { id: 'a1', profile: 'inherit', model, thinking: 'off' as const, tools: ['read'], status: 'completed' as const, startedAt: 1, pendingRequests: 0, requests: [], output: 'old\ncurrent', outputStart: 4 };
  try {
    await runtime.importSummaries([record]); assert.equal((await runtime.wait('a1', { timeout: 0 })).outputStart, 4);
    for (const outputStart of [-1, 0.5, 100, NaN]) await assert.rejects(runtime.importSummaries([{ ...record, outputStart }]), /output offset/);
    await assert.rejects(runtime.importSummaries([{ ...record, output: '𐐀text', outputStart: 1 }]), /output offset/);
    assert.equal((await runtime.wait('a1', { timeout: 0 })).outputStart, 4);
    const journal = new AgentJournal(); const initial = journal.prepare([record], 2)!; journal.confirm();
    const update = journal.prepare([{ ...record, outputStart: 0 }], 2)!;
    assert.equal(update.jobs![0]!.output, undefined); assert.equal(update.jobs![0]!.outputAppend, undefined);
    assert.equal(foldAgentData([initial, update]).records[0]!.outputStart, 0);
  } finally { await runtime.shutdown(); }
});
