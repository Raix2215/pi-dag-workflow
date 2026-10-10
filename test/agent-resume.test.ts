import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { AgentRuntime } from '../src/agents/runtime.ts';
import { ProfileStore } from '../src/agents/profiles.ts';
import { AgentJournal, foldAgentData } from '../src/agents/persistence.ts';
import { agentFailure, safeDiagnostic } from '../src/agents/diagnostics.ts';
import { IsolatedClient } from './fixtures/isolated-client.ts';

const signature = (name: string) => createHash('sha256').update(name).digest('hex');
async function host() {
  const root = await mkdtemp(join(tmpdir(), 'dag-resume-'));
  const model = { provider: 'fixture', id: 'original' };
  const profiles = new ProfileStore({ registry: { find: (provider, id) => provider === 'fixture' ? { provider, id } : undefined }, trustedTools: ['write'] });
  profiles.set({ name: 'fallback', model: { provider: 'fixture', id: 'alternative' }, thinking: 'low', tools: ['read', 'write'] });
  const runtime = new AgentRuntime({ cwd: root, profiles, getInheritedModel: () => model, getInheritedTools: () => ['read'], testCliPath: new URL('./fixtures/m2-rpc-fixture.mjs', import.meta.url).pathname });
  return { runtime, profiles, root, close: async () => { await runtime.shutdown(); await rm(root, { recursive: true, force: true }); } };
}

test('resumeFrom uses a new job on the original Todo; switching profile keeps the old tool scope', async () => {
  const h = await host(); try {
    const old = await h.runtime.spawn({ task: 'HOLD', todoId: 7, taskDefinition: signature('scope') });
    await h.runtime.cancel(old.id);
    assert.equal(h.runtime.inspect(old.id)[0]!.dismissed, true);
    assert.equal(h.runtime.inspect(old.id)[0]!.taskReportStale, true);
    const resumed = await h.runtime.spawn({ resumeFrom: old.id, todoId: 7, taskDefinition: signature('scope'), task: 'Check files before finishing', profile: 'fallback' });
    const result = await h.runtime.wait(resumed.id, { until: 'finish', timeout: 3 });
    assert.notEqual(resumed.id, old.id); assert.equal(resumed.todoId, 7); assert.equal(resumed.resumeFrom, old.id);
    assert.equal(result.model.id, 'alternative'); assert.deepEqual(result.tools, ['read']);
    assert.match(result.output, /Original assignment:\nHOLD/); assert.match(result.output, /Check files before finishing/);
    assert.doesNotMatch(JSON.stringify(h.runtime.inspect()), /Original assignment|Check files before finishing/);
    assert.equal(h.runtime.exportRecords().find((job) => job.id === resumed.id)!.assignment, 'HOLD');
    assert.equal(h.runtime.inspect(old.id)[0]!.status, 'cancelled');
  } finally { await h.close(); }
});

test('resume rejects active work, changed Todo binding and changed definition without consuming IDs', async () => {
  const h = await host(); try {
    const old = await h.runtime.spawn({ task: 'HOLD', todoId: 1, taskDefinition: signature('scope') });
    await assert.rejects(h.runtime.spawn({ task: 'again', todoId: 1, resumeFrom: old.id, taskDefinition: signature('scope') }), /active/);
    await h.runtime.cancel(old.id); const next = h.runtime.nextId();
    await assert.rejects(h.runtime.spawn({ task: 'again', todoId: 2, resumeFrom: old.id, taskDefinition: signature('scope') }), /binding/);
    await assert.rejects(h.runtime.spawn({ task: 'again', todoId: 1, resumeFrom: old.id, taskDefinition: signature('changed') }), /definition changed/);
    assert.equal(h.runtime.nextId(), next);
  } finally { await h.close(); }
});

test('resume inputs survive journal deltas and restoration without reviving the old process', async () => {
  const h = await host(); try {
    const old = await h.runtime.spawn({ task: 'HOLD', todoId: 1, taskDefinition: signature('scope') });
    const journal = new AgentJournal(); const first = journal.prepare(h.runtime.exportRecords(), h.runtime.nextId())!; journal.confirm();
    await h.runtime.cancel(old.id);
    const second = journal.prepare(h.runtime.exportRecords(), h.runtime.nextId())!;
    assert.ok(second.jobs?.every((job) => job.assignment === undefined && job.taskDefinition === undefined), 'immutable inputs are not copied on each delta');
    const folded = foldAgentData([first, second]);
    assert.equal(folded.records[0]!.assignment, 'HOLD'); assert.equal(folded.records[0]!.dismissed, true);
    await h.runtime.importSummaries(folded.records, folded.nextId);
    assert.equal(h.runtime.activeCount(), 0);
    const resumed = await h.runtime.spawn({ task: 'check restored files', todoId: 1, resumeFrom: old.id, taskDefinition: signature('scope') });
    assert.match((await h.runtime.wait(resumed.id, { timeout: 3 })).output, /Original assignment:\nHOLD/);
    assert.equal(h.runtime.exportRecords().length, 2);
  } finally { await h.close(); }
});

test('legacy records need a self-contained continuation; short labels are not original instructions', async () => {
  const h = await host(); try {
    await h.runtime.importSummaries([{ id: 'a1', todoId: 3, profile: 'inherit', model: { provider: 'fixture', id: 'original' }, thinking: 'off', tools: ['read'], status: 'interrupted', label: 'misleading label only', startedAt: 1, pendingRequests: 0 }]);
    const resumed = await h.runtime.spawn({ task: 'Full instructions with all requirements', todoId: 3, resumeFrom: 'a1' });
    const result = await h.runtime.wait(resumed.id, { timeout: 3 });
    assert.match(result.output, /Legacy record has no full assignment/);
    assert.doesNotMatch(result.output, /misleading label only/);
    assert.equal(h.runtime.exportRecords().find((job) => job.id === resumed.id)!.assignment, 'Full instructions with all requirements');
  } finally { await h.close(); }
});

test('failure summaries retain bounded root causes; explicit cancel archives even already closed jobs', async () => {
  const h = await host(); try {
    const old = await h.runtime.spawn({ task: 'ERROR', todoId: 1 });
    const failed = await h.runtime.wait(old.id, { timeout: 3 });
    assert.equal(failed.status, 'failed'); assert.match(failed.failure!.reason, /fixture model error/);
    assert.throws(() => h.runtime.prune([old.id]), /undelivered agent report/);
    assert.equal(h.runtime.inspect(old.id).length, 1, 'a refused prune keeps the full record');
    assert.match(h.runtime.inspect(old.id)[0]!.failure!.recovery, /same Todo/);
    await h.runtime.cancel(old.id);
    assert.equal(h.runtime.inspect(old.id)[0]!.status, 'failed', 'history keeps the actual failure outcome');
    assert.equal(h.runtime.inspect(old.id)[0]!.dismissed, true);
    assert.equal(h.runtime.inspect(old.id)[0]!.taskReportStale, true);
    assert.match((await h.runtime.wait(old.id, { timeout: 0 })).output, /partial retained/);
  } finally { await h.close(); }
});

test('diagnostics distinguish quota/auth/transient/unknown and redact credentials without auto retry', () => {
  const token = ['s', 'k', '-'].join('') + 'x'.repeat(28);
  const values = [
    ['429 insufficient_quota: billing limit exhausted', 'quota', false],
    ['429 usage_limit_reached', 'quota', false],
    ['The usage limit has been reached', 'quota', false],
    ['HTTP 503 billing service temporarily unavailable', 'network', true],
    ['401 invalid_api_key', 'auth', false],
    ['ECONNRESET: stream disconnected', 'network', true],
    ['Agent deadline exceeded', 'timeout', true],
    ['provider aborted without a diagnostic', 'unknown', null],
  ] as const;
  for (const [value, kind, retryable] of values) { const result = agentFailure(value); assert.equal(result.kind, kind); assert.equal(result.retryable, retryable); assert.match(result.recovery, /explicit resumeFrom/); }
  const credentialUrl = new URL('https://example.org/a?token=private-token');
  credentialUrl.username = 'user'; credentialUrl.password = 'pass';
  assert.doesNotMatch(safeDiagnostic(`request failed at ${credentialUrl}`), /user:pass|private-token/);
  const input = `Authorization: Bearer ${token}; api_key="private-value" ${credentialUrl}`;
  assert.doesNotMatch(safeDiagnostic('{"token":"example-private","refresh_token":"example-refresh"}'), /example-private|example-refresh/);
  const safe = safeDiagnostic(input);
  assert.doesNotMatch(safe, /private-value|private-token|user:pass|x{28}/);
  assert.match(safe, /redacted/); assert.ok(safeDiagnostic('x'.repeat(10000)).length <= 2048);
  for (const header of ['Authorization: Basic', 'Proxy-Authorization: Basic', 'Authorization: ApiKey', 'Cookie: session=', 'Set-Cookie: session=']) {
    const secret = Buffer.from('example:private-password').toString('base64');
    assert.doesNotMatch(safeDiagnostic(`${header} ${secret}\nHTTP 401 rejected`), new RegExp(secret));
    assert.match(safeDiagnostic(`${header} ${secret}\nHTTP 401 rejected`), /HTTP 401 rejected/);
  }
});

test('startup crashes include sanitized stderr in their failure report', async () => {
  const h = await host(); let broken: AgentRuntime | undefined;
  try {
    const path = join(h.root, 'broken-cli.mjs');
    await writeFile(path, `process.stderr.write('startup configuration rejected; password=private-value'); process.exit(2);`);
    broken = new AgentRuntime({ cwd: h.root, profiles: h.profiles, getInheritedModel: () => ({ provider: 'fixture', id: 'original' }), testCliPath: path });
    const job = await broken.spawn({ task: 'work' });
    const result = await broken.wait(job.id, { timeout: 3 });
    assert.equal(result.status, 'failed'); assert.match(result.output, /startup configuration rejected/);
    assert.doesNotMatch(JSON.stringify(result), /private-value/); assert.equal(broken.activeCount(), 0);
  } finally { await broken?.shutdown(); await h.close(); }
});


test('actual offline Pi: cancel then switch profile and resume the same Todo without replacing it', { timeout: 30000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dag-resume-integration-'));
  await mkdir(join(root, 'agent', 'pi-dag-workflow'), { recursive: true });
  await writeFile(join(root, 'agent', 'pi-dag-workflow', 'pi-dag-workflow-profile.json'), JSON.stringify({ profiles: [
    { name: 'worker', model: { provider: 'dag-test', id: 'scripted' }, thinking: 'off', tools: ['read'] },
    { name: 'fallback', model: { provider: 'dag-test', id: 'reasoned' }, thinking: 'off', tools: ['read', 'write'] },
  ] }));
  const offline = new URL('./fixtures/offline-model.ts', import.meta.url).pathname;
  const client = await IsolatedClient.start(root, 'same-todo-resume', [], ['--dag-workflow-test-child-provider', offline]);
  t.after(() => client.close());
  const call = async (name: string, params: object, expectError = false) => {
    const events = await client.prompt(`TEST CALL ${name} ${JSON.stringify(params)}`);
    const result = events.find((event) => event.type === 'tool_execution_end' && event.toolName === name)!;
    assert.ok(result); assert.equal(result.isError === true || (result.result as any).isError === true, expectError, JSON.stringify(result));
    return (result.result as any).details;
  };
  await call('todo', { action: 'create', subject: 'Original work', description: 'Verify every original requirement' });
  const old = await call('subagent_spawn', { task: 'HOLD-IDLE-ENABLE-CHILD', todoId: 1, profile: 'worker' });
  await call('subagent_cancel', { jobId: old.jobId });
  const cancelledView = await client.prompt('/todos list pending');
  const viewText = (events: any[]) => events.filter((event) => event.method === 'notify').map((event) => event.message).join('\n');
  assert.match(viewText(cancelledView), /主会话.*可接续/);
  assert.doesNotMatch(viewText(cancelledView), new RegExp(`${old.jobId} ·`));
  await call('todo', { action: 'update', id: 1, status: 'in_progress' });
  assert.doesNotMatch(viewText(await client.prompt('/todos list pending')), /可接续/);
  const chosen = await call('subagent_inspect', { profile: 'fallback' }); assert.equal(chosen.profile.name, 'fallback');
  const resumed = await call('subagent_spawn', { resumeFrom: old.jobId, profile: 'fallback', task: 'TEST CALL subagent_send {"message":"Partial files inspected; remaining requirements verified"}' });
  assert.equal(resumed.todoId, 1); assert.equal(resumed.resumeFrom, old.jobId); assert.notEqual(resumed.jobId, old.jobId);
  const result = await call('subagent_inspect', { jobId: resumed.jobId, output: true, until: 'finish', timeout: 10 });
  assert.equal(result.status, 'completed'); assert.deepEqual(result.tools, ['read']); assert.equal(result.model.id, 'reasoned');
  assert.match(result.output, /remaining requirements verified/);
  const entries = await client.entries() as any[];
  const taskState = entries.findLast((entry) => entry.customType === 'pi-dag-workflow.state').data;
  assert.equal(taskState.tasks.length, 1); assert.equal(taskState.tasks[0].status, 'in_progress');
  await call('todo', { action: 'update', id: 1, description: 'Different required end state' });
  await call('subagent_spawn', { resumeFrom: resumed.jobId, task: 'Do not silently use the old scope' }, true);
  assert.equal((await call('todo', { action: 'list' })).page.total, 1);
});
