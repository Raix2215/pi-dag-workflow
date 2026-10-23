import { STATE_TYPE, retainedJobs } from './fixtures/public-records.ts';
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { IsolatedClient } from "./fixtures/isolated-client.ts";
import { protocolHost } from './fixtures/agents-protocol-host.ts';

const activeJobs = (host: any) => host.jobs().filter((job: any) => ['starting', 'running', 'waiting'].includes(job.status)).length;
const saved = (host: any) => host.jobs();
import { readFile } from "node:fs/promises";
{
const fixture = fileURLToPath(new URL('./fixtures/m2-rpc-fixture.mjs', import.meta.url));
async function setup(mode?: string, releaseStalled = false) {
  delete process.env.PI_DAG_TEST_TOOL_UPDATE; delete process.env.PI_DAG_TEST_RELEASE_STALLED;
  if (mode) process.env.PI_DAG_TEST_TOOL_UPDATE = mode;
  if (releaseStalled) process.env.PI_DAG_TEST_RELEASE_STALLED = '1';
  const host = await protocolHost({ cli: fixture });
  const job = await host.call('subagent_spawn', { task: 'HOLD', tools: ['read'] });
  return { host, jobId: job.jobId, close: async () => { await host.close(); delete process.env.PI_DAG_TEST_TOOL_UPDATE; delete process.env.PI_DAG_TEST_RELEASE_STALLED; } };
}
const jobOf = async (h: any, id: string) => (await h.host.call('subagent_inspect', { jobId: id })).jobs[0];
const send = (h: any, params: object, signal?: AbortSignal) => h.host.tools.get('subagent_send').execute('send', { recipient: h.jobId, ...params }, signal, undefined, h.host.ctx);

for (const mode of ['ignore', 'mismatch']) test(`an ${mode} tool acknowledgment stops uncertainty without claiming a larger tool scope`, async (t) => {
  const h = await setup(mode); t.after(h.close);
  const failed = await send(h, { message: 'continue', tools: ['read', 'write'], interrupt: true });
  assert.equal(failed.isError, true);
  assert.match(failed.content[0].text, /not confirmed/);
  assert.equal(activeJobs(h.host), 0); assert.equal((await jobOf(h, h.jobId)).status, 'failed');
  assert.deepEqual((await jobOf(h, h.jobId)).tools, ['read']);
});
test('cancelling an in-flight update stops the child and never sends the new assignment', async (t) => {
  const h = await setup('stall'); t.after(h.close);
  const controller = new AbortController();
  const pending = send(h, { message: 'MUST-NOT-EXECUTE', tools: ['read', 'write'], interrupt: true }, controller.signal);
  const deadline = Date.now() + 3000;
  while (!(await jobOf(h, h.jobId)).activeTools.some((tool: any) => tool.tool === 'tools:update')) { if (Date.now() > deadline) throw new Error('Update was not reached'); await delay(5); }
  controller.abort();
  const aborted = await pending;
  assert.equal(aborted.isError, true); assert.match(aborted.content[0].text, /aborted/);
  assert.equal(activeJobs(h.host), 0); assert.equal((await jobOf(h, h.jobId)).status, 'cancelled');
  assert.deepEqual((await jobOf(h, h.jobId)).tools, ['read']);
  assert.doesNotMatch((await h.host.call('subagent_inspect', { jobId: h.jobId, output: true, until: 'finish', timeout: 2 })).output, /MUST-NOT-EXECUTE/);
});
test('an older ordinary send cannot release the lock of a concurrent tool update', async (t) => {
  const h = await setup('stall', true); t.after(h.close);
  const controller = new AbortController();
  const old = send(h, { message: 'STALL_DIRECTION' });
  const deadline = Date.now() + 3000;
  while (!(await jobOf(h, h.jobId)).activeTools.some((tool: any) => tool.tool === 'stall:prompt')) { if (Date.now() > deadline) throw new Error('Old direction was not reached'); await delay(5); }
  const update = send(h, { message: 'new task', tools: ['read', 'write'], interrupt: true }, controller.signal);
  const oldResult = await old;
  assert.equal(oldResult.isError, true); assert.match(oldResult.content[0].text, /older direction released/);
  assert.equal((await jobOf(h, h.jobId)).phase, 'redirecting');
  assert.equal((await send(h, { message: 'second update', tools: [], interrupt: true })).isError, true);
  controller.abort(); const updateResult = await update; assert.equal(updateResult.isError, true);
  assert.equal(activeJobs(h.host), 0);
});
test('a confirmation may follow the command response without rejecting a successful update', async (t) => {
  const h = await setup('delayed-ack'); t.after(h.close);
  const result = await send(h, { message: 'finished', tools: ['read', 'write'], interrupt: true });
  assert.equal(result.isError, undefined, JSON.stringify(result));
  assert.deepEqual(result.details.tools, ['read', 'write']); assert.equal((await h.host.call('subagent_inspect', { jobId: h.jobId, output: true, until: 'finish', timeout: 2 })).status, 'completed');
});
for (const mode of ['reject-check', 'stall-check']) test(`${mode} leaves the old child and permissions intact with an actionable preflight diagnosis`, async (t) => {
  const h = await setup(mode); t.after(h.close);
  const failed = await send(h, { message: 'not delivered', tools: ['read', 'write'], interrupt: true });
  assert.equal(failed.isError, true);
  assert.equal(failed.details.stage, 'preflight'); assert.equal(failed.details.status, 'running');
  assert.equal(failed.details.queueCleared, false); assert.equal(failed.details.interrupted, false);
  assert.equal(failed.details.toolsApplied, false); assert.equal(failed.details.directionDelivery, 'not_sent');
  assert.match(failed.content[0].text, mode === 'reject-check' ? /unavailable: write/ : /confirmation timed out/);
  assert.equal(activeJobs(h.host), 1); assert.deepEqual((await jobOf(h, h.jobId)).tools, ['read']);
});
test('post-interruption refusal reports stopped state, concrete cause and the undelivered direction', async (t) => {
  const h = await setup('reject-apply'); t.after(h.close);
  const failed = await send(h, { message: 'not delivered', tools: ['read', 'write'], interrupt: true });
  assert.equal(failed.isError, true);
  assert.equal(failed.details.jobId, h.jobId); assert.equal(failed.details.stage, 'apply_tools');
  assert.equal(failed.details.status, 'failed'); assert.equal(failed.details.interrupted, true);
  assert.equal(failed.details.queueCleared, true); assert.equal(failed.details.questionsCleared, true);
  assert.equal(failed.details.toolsApplied, null); assert.equal(failed.details.directionDelivery, 'not_sent');
  assert.deepEqual(failed.details.currentTools, ['read']);
  assert.match(failed.content[0].text, /refused application: write/);
  assert.equal(activeJobs(h.host), 0);
  assert.deepEqual((await jobOf(h, h.jobId)).tools, ['read']);
});
test('an ordinary direction failure does not claim unrelated interruption or permission changes', async (t) => {
  const h = await setup(); t.after(h.close);
  const failed = await send(h, { message: 'HANDLED' });
  assert.equal(failed.isError, true);
  assert.equal(failed.details.stage, 'deliver_direction'); assert.equal(failed.details.directionDelivery, 'not_sent');
  for (const field of ['interrupted', 'queueCleared', 'questionsCleared', 'toolsApplied', 'requestedTools']) assert.equal(Object.hasOwn(failed.details, field), false, field);
  assert.equal(activeJobs(h.host), 1);
});
test('invalid tools do not interrupt or invalidate current work, and empty tools can be confirmed', async (t) => {
  const h = await setup(); t.after(h.close);
  const bad = await send(h, { message: 'bad', tools: ['unsupported'], interrupt: true });
  assert.equal(bad.isError, true); assert.match(bad.content[0].text, /not trusted or supported/);
  assert.equal((await jobOf(h, h.jobId)).status, 'running');
  assert.equal((await jobOf(h, h.jobId)).taskReportStale, undefined);
  const sent = await send(h, { message: 'finished', tools: [], interrupt: true });
  assert.equal(sent.isError, undefined, JSON.stringify(sent));
  assert.deepEqual(sent.details.tools, []); assert.deepEqual((await jobOf(h, h.jobId)).tools, []);
  assert.equal((await h.host.call('subagent_inspect', { jobId: h.jobId, output: true, until: 'finish', timeout: 2 })).status, 'completed');
});
}
{
const offline = fileURLToPath(new URL('./fixtures/offline-model.ts', import.meta.url));
test('real Pi: redirected or redefined tasks reject old interim evidence, accept a fresh report, and brief only the new scope', { timeout: 30000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dag-report-freshness-'));
  const log = join(root, 'child-context.jsonl');
  const capture = fileURLToPath(new URL('./fixtures/child-guidance-log.ts', import.meta.url));
  const client = await IsolatedClient.start(root, 'report-freshness', [capture], ['--dag-workflow-test-child-provider', offline, '--dag-test-child-guidance-log', log]);
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
  const report = await call('subagent_inspect', { jobId: first.jobId, output: true, after: 0, timeout: 8 });
  assert.match(report.output, /CONTROL-PROGRESS/); assert.equal(report.status, 'running');
  await call('subagent_send', { recipient: first.jobId, interrupt: true, message: 'HOLD-IDLE-ENABLE-CHILD' });
  await call('todo', { action: 'update', id: 1, status: 'completed' }, false);
  await call('todo', { action: 'update', id: 1, subject: 'replacement work requires fresh evidence' });
  await call('todo', { action: 'update', id: 1, status: 'completed' }, false);
  const version = (await call('subagent_inspect', { jobId: first.jobId })).jobs[0].reportVersion;
  await call('subagent_send', { recipient: first.jobId, interrupt: true, message: 'CONTROL FRESH REPORT HOLD' });
  const fresh = await call('subagent_inspect', { jobId: first.jobId, output: true, after: version, timeout: 8 });
  assert.match(fresh.output.slice(fresh.outputStart), /FRESH-CURRENT-PROGRESS/);
  assert.doesNotMatch(fresh.output.slice(fresh.outputStart), /CONTROL-PROGRESS/);
  assert.match(fresh.output, /CONTROL-PROGRESS/, 'history is retained');
  await call('todo', { action: 'update', id: 1, status: 'completed' });
  const entries = await client.entries();
  const state = (entries as any[]).findLast((entry) => entry.customType === STATE_TYPE).data;
  assert.equal(state.tasks[0]!.status, 'completed');
  const jobs = retainedJobs(entries).records;
  assert.equal(jobs.find(job => job.id === first.jobId)!.outputStart, fresh.outputStart);
  const priorInputs = (await readFile(log, 'utf8')).trim().split('\n').length;
  const consumer = await call('subagent_spawn', { task: 'Inspect current fragment context', todoId: 2, context: true });
  await call('subagent_inspect', { jobId: consumer.jobId, output: true, until: 'finish', timeout: 8 });
  const observed = (await readFile(log, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  const brief = JSON.stringify(observed.slice(priorInputs));
  assert.match(brief, /FRESH-CURRENT-PROGRESS/); assert.doesNotMatch(brief, /CONTROL-PROGRESS/);
  await call('subagent_cancel', { jobId: first.jobId });
});

for (const mode of ['single', 'batch'] as const) for (const field of ['description', 'metadata'] as const) test(`real Pi: ${mode} redefining ${field} of a queued assignment invalidates its old report without interrupt`, { timeout: 30000 }, async (t) => {
  const client = await IsolatedClient.start(undefined, 'redefined-report', [], ['--dag-workflow-test-child-provider', offline]); t.after(() => client.close());
  const call = async (name: string, params: object) => {
    const events = await client.prompt(`TEST CALL ${name} ${JSON.stringify(params)}`);
    return events.find((event) => event.type === 'tool_execution_end' && event.toolName === name)!.result as any;
  };
  await call('todo', { action: 'create', subject: 'first definition', metadata: { preset: 'check', run: 1, key: 'first', step: 1 } });
  const job = (await call('subagent_spawn', { task: 'CONTROL REPORT HOLD', todoId: 1 })).details.jobId;
  assert.match((await call('subagent_inspect', { jobId: job, output: true, after: 0, timeout: 8 })).details.output, /CONTROL-PROGRESS/);
  await call('subagent_send', { recipient: job, message: 'HOLD-IDLE-ENABLE-CHILD' });
  const update = { action: 'update', id: 1, ...(field === 'description' ? { description: 'new inputs need another check' } : { metadata: { preset: 'check', run: 2, key: 'first', step: 1 } }) };
  const edited = await call('todo', mode === 'single' ? update : { action: 'batch', operations: [update, { action: 'update', id: 1, activeForm: 'checking the new scope' }] }); assert.ok(!edited.isError);
  const completed = await call('todo', { action: 'update', id: 1, status: 'completed' }); assert.equal(completed.isError, true);
  await call('subagent_cancel', { jobId: job });
});
}

{
const fixture = fileURLToPath(new URL('./fixtures/m2-rpc-fixture.mjs', import.meta.url));
test('current output offsets survive restoration and malformed offsets fail atomically', async (t) => {
  const hosts: any[] = [];
  const open = async () => { const host = await protocolHost({ cli: fixture }); hosts.push(host); return host; };
  t.after(async () => { while (hosts.length) await hosts.pop().close(); });
  const record = { id: 'a1', profile: 'inherit', model: { provider: 'fixture', id: 'model' }, thinking: 'off', tools: ['read'], status: 'completed', startedAt: 1, pendingRequests: 0, requests: [], output: 'old\ncurrent', outputStart: 4 };
  const valid = await open();
  await valid.restore([record]);
  assert.equal((await valid.call('subagent_inspect', { jobId: 'a1', output: true, timeout: 0 })).outputStart, 4);
  for (const outputStart of [-1, 0.5, 100, NaN]) {
    const host = await open();
    await host.restore([record]);
    await host.restore([{ ...record, outputStart } as never]);
    const rejected = await host.execute('subagent_inspect', { jobId: 'a1', output: true, timeout: 0 });
    assert.equal(rejected.isError, true, 'a malformed offset protects the selected branch');
    assert.match(rejected.content[0].text, /output offset/);
    await host.restore([record]);
    assert.equal((await host.call('subagent_inspect', { jobId: 'a1', output: true, timeout: 0 })).outputStart, 4, 'the unmodified valid record remains recoverable');
  }
  const surrogate = await open();
  await surrogate.restore([record]);
  await surrogate.restore([{ ...record, output: '𐐀text', outputStart: 1 }]);
  const rejected = await surrogate.execute('subagent_inspect', { jobId: 'a1', output: true, timeout: 0 });
  assert.equal(rejected.isError, true, 'an offset into a surrogate pair is rejected');
  assert.match(rejected.content[0].text, /output offset/);
});
}

{
test('B2.1: real Pi fails and closes when a later activation cannot enforce the selection', { timeout: 25000 }, async (t) => {
  const extension = fileURLToPath(new URL('./fixtures/selection-fault.ts', import.meta.url));
  const host = await protocolHost({ tools: () => [
    { name: 'read', sourceInfo: { path: 'builtin:read' } },
    { name: 'write', sourceInfo: { path: 'builtin:write' } },
    { name: 'selection_fault', sourceInfo: { path: extension } },
  ] });
  t.after(() => host.close());
  await writeFile(join(host.directory, 'pi-dag-workflow-profile.json'), JSON.stringify({ profiles: [{ name: 'fault', childExtensions: [extension] }] }));
  const job = await host.call('subagent_spawn', { profile: 'fault', task: 'CONTROL QUESTION', tools: ['read', 'selection_fault'], timeout: 15 });
  const waiting = await host.call('subagent_inspect', { jobId: job.jobId, output: true, until: 'finish', timeout: 5 });
  assert.equal(waiting.status, 'waiting'); assert.equal(waiting.requests.length, 1);
  await writeFile(join(host.root, 'selection-fault-armed'), 'arm');
  await Promise.allSettled([host.execute('subagent_send', { recipient: job.jobId, interrupt: true, message: 'CONTROL QUESTION' })]);
  const result = await host.call('subagent_inspect', { jobId: job.jobId, output: true, until: 'finish', timeout: 5 });
  assert.equal(result.status, 'failed');
  assert.match(result.output, /Child tool selection is not enforceable: Error: Child tool update did not apply/);
  assert.match(result.failure!.reason, /Child tool selection is not enforceable: Error: Child tool update did not apply/);
  assert.equal(activeJobs(host), 0);
});
}

{
const offline = fileURLToPath(new URL('./fixtures/offline-model.ts', import.meta.url));
const capture = fileURLToPath(new URL('./fixtures/child-guidance-log.ts', import.meta.url));
async function start(session: string) {
  const root = await mkdtemp(join(tmpdir(), 'dag-guidance-'));
  const log = join(root, 'child-context.jsonl');
  const client = await IsolatedClient.start(root, session, [capture], ['--dag-workflow-test-child-provider', offline, '--dag-test-child-guidance-log', log]);
  const call = async (name: string, args: object) => {
    const events = await client.prompt(`TEST CALL ${name} ${JSON.stringify(args)}`);
    const event = events.find((item) => item.type === 'tool_execution_end' && item.toolName === name)!;
    assert.ok(event, `${name} executed`);
    return { ...(event.result as any), isError: event.isError === true || (event.result as any).isError === true };
  };
  const logs = async () => (await readFile(log, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
  const finish = async (jobId: string) => { const result = await call('subagent_inspect', { jobId, output: true, until: 'finish', timeout: 10 }); assert.equal(result.isError, false, JSON.stringify(result)); assert.equal(result.details.status, 'completed'); return result.details; };
  return { client, call, logs, finish, root };
}
const text = (message: any) => typeof message.content === 'string' ? message.content : message.content?.filter((item: any) => item.type === 'text').map((item: any) => item.text).join('\n') ?? '';
const inputContains = (entry: any, marker: string) => entry.type === 'input' && entry.context.messages.some((message: any) => text(message).includes(marker));
test('actual Pi: context:true gives an ordinary Todo its current direct report without parent history', { timeout: 40000 }, async (t) => {
  const h = await start('ordinary-context'); t.after(() => h.client.close());
  await h.client.prompt('PARENT-HISTORY-MUST-NOT-LEAK');
  await writeFile(join(h.root, 'artifact.json'), '{"evidence":"VERIFIED-DIRECT-RESULT"}');
  await h.call('todo', { action: 'create', subject: 'Producer', metadata: { artifacts: ['artifact.json'] } });
  const producer = await h.call('subagent_spawn', { task: 'TEST CALL read {"path":"artifact.json"}', todoId: 1, tools: ['read'] });
  assert.equal(producer.isError, false); await h.finish(producer.details.jobId);
  await h.call('todo', { action: 'update', id: 1, status: 'completed' });
  await h.call('todo', { action: 'create', subject: 'Consumer', description: 'CURRENT-CONSUMER-REQUIREMENT', blockedBy: [1] });
  const consumer = await h.call('subagent_spawn', { task: 'Ordinary brief probe', todoId: 2, tools: ['read'], context: true });
  assert.equal(consumer.isError, false); await h.finish(consumer.details.jobId);
  const first = (await h.logs()).find((entry) => inputContains(entry, 'Task #2'));
  assert.ok(first, 'the ordinary task brief actually reaches a separate Pi child');
  const combined = first.context.messages.map(text).join('\n');
  assert.match(combined, /CURRENT-CONSUMER-REQUIREMENT/); assert.match(combined, /#1 \[completed\].*VERIFIED-DIRECT-RESULT/);
  assert.match(combined, /artifact\.json/); assert.doesNotMatch(combined, /PARENT-HISTORY-MUST-NOT-LEAK/);
  assert.doesNotMatch(JSON.stringify(first.context.messages.filter((item: any) => item.role === 'system')), /CURRENT-CONSUMER-REQUIREMENT|VERIFIED-DIRECT-RESULT/);
  await h.call('todo', { action: 'create', subject: 'No context', description: 'UNSELECTED-CONTEXT', blockedBy: [1] });
  const plain = await h.call('subagent_spawn', { task: 'No context probe', todoId: 3, tools: ['read'] }); await h.finish(plain.details.jobId);
  const plainInput = (await h.logs()).find((entry) => inputContains(entry, 'No context probe'));
  assert.doesNotMatch(plainInput.context.messages.map(text).join('\n'), /UNSELECTED-CONTEXT|Task #3|VERIFIED-DIRECT-RESULT/);
});
test('actual Pi: changing artifact references makes old evidence stale but preserves the current declared path', { timeout: 30000 }, async (t) => {
  const h = await start('context-artifact-freshness'); t.after(() => h.client.close());
  await writeFile(join(h.root, 'old.json'), 'OLD-REPORT-MARKER');
  await h.call('todo', { action: 'create', subject: 'Producer', metadata: { artifacts: ['old.json'] } });
  const producer = await h.call('subagent_spawn', { task: 'TEST CALL read {"path":"old.json"}', todoId: 1, tools: ['read'] }); await h.finish(producer.details.jobId);
  await h.call('todo', { action: 'update', id: 1, status: 'completed' });
  await h.call('todo', { action: 'update', id: 1, metadata: { artifacts: ['current.json'] } });
  const inspected = await h.call('subagent_inspect', { jobId: producer.details.jobId });
  assert.equal(inspected.details.jobs[0].taskReportStale, true);
  await h.call('todo', { action: 'create', subject: 'Consumer', blockedBy: [1] });
  const consumer = await h.call('subagent_spawn', { task: 'Freshness probe', todoId: 2, tools: ['read'], context: true }); await h.finish(consumer.details.jobId);
  const first = (await h.logs()).find((entry) => inputContains(entry, 'Task #2'));
  const combined = first.context.messages.map(text).join('\n');
  assert.match(combined, /current\.json/); assert.doesNotMatch(combined, /OLD-REPORT-MARKER|old\.json/);
});
test('actual Pi: Profile.skills delivers only selected file entries and reads bodies through the existing tool', { timeout: 40000 }, async (t) => {
  const h = await start('profile-skill-guidance'); t.after(() => h.client.close());
  const profileDir = join(h.root, 'agent', 'pi-dag-workflow'); await mkdir(profileDir, { recursive: true });
  await mkdir(join(h.root, 'skills', 'selected'), { recursive: true }); await mkdir(join(h.root, 'skills', 'unselected'));
  const selected = join(h.root, 'skills', 'selected', 'SKILL.md');
  await writeFile(selected, '---\nname: selected\ndescription: Local selected skill\nallowed-tools: bash write\n---\nSELECTED-BODY-ONLY-AFTER-READ\n');
  await writeFile(join(h.root, 'skills', 'unselected', 'SKILL.md'), '# UNSELECTED-BODY\n');
  await writeFile(join(profileDir, 'pi-dag-workflow-profile.json'), JSON.stringify({ profiles: [{ name: 'reader', tools: ['read'], skills: ['skills/selected/SKILL.md'], instructions: 'Work only on the assigned input.' }, { name: 'plain', tools: ['read'] }, { name: 'missing', tools: ['read'], skills: ['missing.md'] }] }));
  const directory = await h.call('subagent_inspect', { profiles: 'summary' });
  assert.deepEqual(directory.details.profiles[0].skills, ['skills/selected/SKILL.md']);
  assert.doesNotMatch(JSON.stringify(directory.content), /SELECTED-BODY|instructions/);
  await h.client.prompt('/agents profile reader dag-test/scripted off read');
  const saved = JSON.parse(await readFile(join(profileDir, 'pi-dag-workflow-profile.json'), 'utf8'));
  assert.deepEqual(saved.profiles.find((item: any) => item.name === 'reader').skills, ['skills/selected/SKILL.md']);
  const child = await h.call('subagent_spawn', { task: 'TEST SELECTED SKILL', profile: 'reader' }); assert.equal(child.isError, false);
  const result = await h.finish(child.details.jobId);
  assert.deepEqual(result.tools, ['read']); assert.match(result.output, /SELECTED-BODY-ONLY-AFTER-READ/);
  const requests = (await h.logs()).filter((entry) => inputContains(entry, 'TEST SELECTED SKILL'));
  assert.ok(requests.length >= 2); const first = requests[0];
  const initial = first.context.messages.map(text).join('\n');
  assert.match(initial, /Selected local skill file entries/); assert.ok(initial.includes(selected));
  assert.doesNotMatch(initial, /SELECTED-BODY-ONLY-AFTER-READ|UNSELECTED-BODY/);
  assert.doesNotMatch(JSON.stringify(first.context.messages.filter((message: any) => message.role === 'system')), /skills\/selected\/SKILL\.md|Selected local skill file entries/);
  assert.ok(requests.slice(1).some((entry) => entry.context.messages.map(text).join('\n').includes('SELECTED-BODY-ONLY-AFTER-READ')));
  const plain = await h.call('subagent_spawn', { task: 'Unselected profile probe', profile: 'plain' }); await h.finish(plain.details.jobId);
  const plainInput = (await h.logs()).find((entry) => inputContains(entry, 'Unselected profile probe'));
  assert.doesNotMatch(plainInput.context.messages.map(text).join('\n'), /Selected local skill file entries|skills\/selected|SELECTED-BODY/);
  await h.call('todo', { action: 'create', subject: 'Pending skill validation' });
  const rejected = await h.call('subagent_spawn', { task: 'Invalid skill probe', profile: 'missing', todoId: 1 }); assert.equal(rejected.isError, true);
  assert.equal(rejected.details.todoStatus, 'pending');
  assert.equal((await h.call('todo', { action: 'get', id: 1 })).details.tasks[0].status, 'pending');
  const widened = await h.call('subagent_spawn', { task: 'No read tool probe', profile: 'reader', tools: [], todoId: 1 }); assert.equal(widened.isError, true);
  assert.equal(widened.details.todoStatus, 'pending');
  const captured = JSON.stringify(await h.logs());
  assert.doesNotMatch(captured, /Invalid skill probe|No read tool probe/);
});
}
{
const fixture = fileURLToPath(new URL('./fixtures/m2-rpc-fixture.mjs', import.meta.url));
const model = { provider: 'dag-test', id: 'scripted' };
test('runtime captures live parent settings and adjusts only implicit thinking to supported levels', async (t) => {
  let thinking = 'high'; let tools = ['read', 'write', 'custom_search'];
  const host = await protocolHost({ cli: fixture, thinking: () => thinking, activeTools: () => tools });
  t.after(() => host.close());
  host.ctx.modelRegistry.find = (provider: string, id: string) => ({ provider, id, reasoning: true });
  const first = await host.call('subagent_spawn', { task: 'HOLD', profile: 'inherit' });
  assert.equal((await host.call('subagent_inspect', { jobId: first.jobId })).jobs[0].profile, 'inherit');
  assert.equal(first.thinking, 'low'); assert.deepEqual(first.tools, ['read', 'write']);
  thinking = 'off'; tools = ['read']; host.ctx.model = { provider: 'dag-test', id: 'alternate' };
  const second = await host.call('subagent_spawn', { task: 'HOLD' });
  assert.equal(second.model.id, 'alternate'); assert.equal(second.thinking, 'off'); assert.deepEqual(second.tools, ['read']);
  const original = (await host.call('subagent_inspect', { jobId: first.jobId })).jobs[0];
  assert.equal(original.model.id, 'scripted'); assert.equal(original.thinking, 'low');
  await host.profiles([{ name: 'explicit', model, thinking: 'high' }]);
  const rejected = await host.execute('subagent_spawn', { task: 'HOLD', profile: 'explicit' });
  assert.equal(rejected.details.status, 'failed');
  assert.match(rejected.content[0].text, /Thinking level high is unsupported/);
});
test('real Pi: default and explicit inherit can implement with active parent built-ins; profiles override them', { timeout: 30000 }, async (t) => {
  const offline = fileURLToPath(new URL('./fixtures/offline-model.ts', import.meta.url));
  const client = await IsolatedClient.start(undefined, 'inherit-config', [], ['--dag-workflow-test-child-provider', offline]);
  t.after(() => client.close());
  const call = async (name: string, params: object) => {
    const events = await client.prompt(`TEST CALL ${name} ${JSON.stringify(params)}`);
    const end = events.find((event) => event.type === 'tool_execution_end' && event.toolName === name)!;
    assert.ok(end); assert.ok(!end.isError && !(end.result as any).isError, JSON.stringify(end.result));
    return (end.result as any).details;
  };
  await client.send('set_model', { provider: 'dag-test', modelId: 'reasoned' });
  await client.send('set_thinking_level', { level: 'high' });
  const captured = await call('subagent_spawn', { task: 'INHERIT SETTINGS SNAPSHOT' });
  const actual = await call('subagent_inspect', { jobId: captured.jobId, output: true, until: 'finish', timeout: 8 });
  assert.deepEqual(JSON.parse(actual.output.trim()), { model: 'reasoned', thinking: 'high' });
  assert.equal(actual.thinking, 'high');
  const spawn = await call('subagent_spawn', { task: 'TEST CALL write {"path":"inherited-write.txt","content":"implemented"}', profile: 'inherit' });
  const result = await call('subagent_inspect', { jobId: spawn.jobId, output: true, until: 'finish', timeout: 8 });
  assert.equal(result.profile, 'inherit'); assert.equal(result.thinking, 'high'); assert.ok(result.tools.includes('write'));
  assert.ok(!result.tools.includes('todo') && !result.tools.includes('subagent_spawn'));
  assert.equal(await readFile(join(client.root, 'inherited-write.txt'), 'utf8'), 'implemented');
  const dir = join(client.root, 'agent/pi-dag-workflow'); await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'pi-dag-workflow-profile.json'), JSON.stringify({ profiles: [{ name: 'reader', thinking: 'off', tools: ['read'] }] }));
  const named = await call('subagent_spawn', { task: 'short read-only assignment', profile: 'reader' });
  const reader = await call('subagent_inspect', { jobId: named.jobId, output: true, until: 'finish', timeout: 8 });
  assert.deepEqual(reader.tools, ['read']);
  const inspect = await call('subagent_inspect', {});
  assert.equal(inspect.jobs[0].profile, 'inherit'); assert.equal(inspect.jobs[2].profile, 'reader');
  assert.equal(reader.thinking, 'off');
  assert.ok(client.records.some((event) => event.method === 'setWidget' && (event.widgetLines as string[] | undefined)?.some((line) => line.includes('· reasoned'))));
});
}
{
const jobOf = async (host: any, id: string) => (await host.call('subagent_inspect', { jobId: id })).jobs[0];
async function until(check: () => boolean | Promise<boolean>) { const deadline = Date.now() + 10000; while (!await check()) { if (Date.now() > deadline) throw new Error('Child control observation timed out'); await delay(10); } }

test('real Pi: interrupt replaces queued directions, preserves the same child context, and aborts its long local tool', { timeout: 30000 }, async (t) => {
  const host = await protocolHost(); t.after(() => host.close());
  const job = await host.call('subagent_spawn', { task: 'CONTROL LONG CALL', tools: ['bash', 'write'], timeout: 20 });
  await until(async () => ((await jobOf(host, job.jobId)).activeTools ?? []).some((tool: any) => tool.tool === 'bash'));
  await until(async () => { try { return await readFile(join(host.root, 'original-state.txt'), 'utf8') === 'ORIGINAL-STATE'; } catch { return false; } });
  const info = await jobOf(host, job.jobId);
  assert.equal(info.phase, 'tool'); assert.equal(info.hasOutput, false); assert.ok(info.deadlineAt! > info.startedAt);
  const queued = await host.call('subagent_send', { recipient: job.jobId, message: 'CONTROL OLD QUEUE' });
  assert.equal(queued.delivery, 'queued'); assert.equal(queued.interrupted, false);
  assert.equal((await jobOf(host, job.jobId)).pendingMessages, 1);
  const start = Date.now();
  const sent = await host.call('subagent_send', { recipient: job.jobId, message: 'CONTROL REDIRECT', interrupt: true });
  assert.equal(sent.interrupted, true); assert.equal(sent.delivery, 'accepted');
  assert.ok(Date.now() - start < 8000, 'redirect must not wait for the original 45s shell');
  const result = await host.call('subagent_inspect', { jobId: job.jobId, output: true, until: 'finish', timeout: 10 });
  assert.equal(result.status, 'completed'); assert.match(result.output, /CONTROL-REDIRECT-SUCCESS original-context=true/);
  assert.equal((await jobOf(host, job.jobId)).status, 'completed'); assert.equal(activeJobs(host), 0);
  await assert.rejects(readFile(join(host.root, 'old-completed.txt')), { code: 'ENOENT' });
  await assert.rejects(readFile(join(host.root, 'old-direction.txt')), { code: 'ENOENT' });
});
test('a rejected post-interruption direction cannot mark the aborted assignment successful', { timeout: 15000 }, async (t) => {
  const fixture = fileURLToPath(new URL('./fixtures/m2-rpc-fixture.mjs', import.meta.url));
  const host = await protocolHost({ cli: fixture }); t.after(() => host.close());
  const job = await host.call('subagent_spawn', { task: 'HOLD' });
  const failed = await host.execute('subagent_send', { recipient: job.jobId, message: 'HANDLED', interrupt: true });
  assert.equal(failed.isError, true); assert.match(failed.content[0].text, /without a model run/);
  assert.equal((await host.call('subagent_inspect', { jobId: job.jobId, output: true, until: 'finish', timeout: 2 })).status, 'failed');
});
test('a failed interruption command terminates uncertainty instead of stranding report acceptance', { timeout: 15000 }, async (t) => {
  const fixture = fileURLToPath(new URL('./fixtures/m2-rpc-fixture.mjs', import.meta.url));
  process.env.PI_DAG_TEST_FAIL_COMMAND = 'clear_queue';
  const host = await protocolHost({ cli: fixture }); t.after(async () => { await host.close(); delete process.env.PI_DAG_TEST_FAIL_COMMAND; });
  const job = await host.call('subagent_spawn', { task: 'HOLD' });
  const failed = await host.execute('subagent_send', { recipient: job.jobId, message: 'replacement', interrupt: true });
  assert.equal(failed.isError, true); assert.match(failed.content[0].text, /fixture clear_queue rejected/);
  assert.equal(activeJobs(host), 0); assert.equal((await jobOf(host, job.jobId)).status, 'failed');
  assert.equal((await jobOf(host, job.jobId)).error, 'Child redirection failed');
});
test('real Pi: redirect cancels an unanswered child question and resumes the same job', { timeout: 30000 }, async (t) => {
  const host = await protocolHost(); t.after(() => host.close());
  const job = await host.call('subagent_spawn', { task: 'CONTROL QUESTION', tools: ['bash', 'write'], timeout: 20 });
  await until(async () => (await jobOf(host, job.jobId)).phase === 'waiting');
  const pending = await jobOf(host, job.jobId);
  assert.equal(pending.questions[0]!.message, 'CONTROL decision?');
  assert.ok(pending.reportVersion > 0);
  const bad = await host.execute('subagent_send', { requestId: pending.questions[0]!.requestId, message: 'bad', interrupt: true });
  assert.equal(bad.isError, true);
  await host.call('subagent_send', { recipient: job.jobId, message: 'CONTROL REDIRECT QUESTION', interrupt: true });
  assert.equal((await host.execute('subagent_send', { requestId: pending.questions[0]!.requestId, message: 'late answer' })).isError, true);
  const result = await host.call('subagent_inspect', { jobId: job.jobId, output: true, until: 'finish', timeout: 10 });
  assert.equal(result.status, 'completed'); assert.match(result.output, /CONTROL-QUESTION-REDIRECTED/);
  assert.equal(await readFile(join(host.root, 'redirect-question.txt'), 'utf8'), 'CONTROL-SELF-DECIDED');
  assert.equal(result.pendingRequests, 0);
});
test('old tool-batch reports stay historical until a changed queued direction is actually consumed', { timeout: 20000 }, async (t) => {
  const fixture = fileURLToPath(new URL('./fixtures/m2-rpc-fixture.mjs', import.meta.url));
  const host = await protocolHost({ cli: fixture, features: ['todos', 'agents'] }); t.after(() => host.close());
  await host.call('todo', { action: 'create', subject: 'Original report scope' });
  const job = await host.call('subagent_spawn', { task: 'HOLD', todoId: 1 });
  await host.call('subagent_send', { recipient: job.jobId, message: 'LATE_REPORT_DIRECTION' });
  await host.call('todo', { action: 'update', id: 1, description: 'Changed report scope' });
  await until(async () => ((await jobOf(host, job.jobId)).activeTools ?? []).some((tool: any) => tool.tool === 'old-batch-seen'));
  const historical = await host.call('subagent_inspect', { jobId: job.jobId, output: true, timeout: 0 });
  assert.equal(historical.reportVersion, 0, 'the old batch is not a new report');
  assert.equal((await host.execute('todo', { action: 'update', id: 1, status: 'completed' })).isError, true);
  assert.match(historical.output, /Historical report.*OLD-BATCH-REPORT/);
  assert.equal(historical.output.slice(historical.outputStart), '', 'old output cannot masquerade as current evidence');
  await host.call('subagent_send', { recipient: job.jobId, message: 'CONSUME_REPORT_DIRECTION' });
  const result = await host.call('subagent_inspect', { jobId: job.jobId, output: true, timeout: 0 });
  assert.equal(result.reportVersion, 1);
  assert.equal((await host.execute('todo', { action: 'update', id: 1, status: 'completed' })).isError, undefined);
  assert.match(result.output.slice(result.outputStart), /NEW-BATCH-REPORT/);
  assert.doesNotMatch(result.output.slice(result.outputStart), /OLD-BATCH-REPORT/);
});
test('real Pi: wait update returns an interim report while finish waits; snapshots and versions remain explicit', { timeout: 30000 }, async (t) => {
  const host = await protocolHost(); t.after(() => host.close());
  const job = await host.call('subagent_spawn', { task: 'CONTROL REPORT HOLD', tools: ['bash'], timeout: 20 });
  const version = (await jobOf(host, job.jobId)).reportVersion;
  const update = await host.call('subagent_inspect', { jobId: job.jobId, output: true, timeout: 10, until: 'update', after: version });
  assert.equal(update.reason, 'update'); assert.equal(update.status, 'running');
  assert.match(update.output, /CONTROL-PROGRESS/); assert.ok(update.reportVersion! > 0);
  assert.equal(activeJobs(host), 1);
  const snapshot = await host.call('subagent_inspect', { jobId: job.jobId, output: true, timeout: 0 });
  assert.equal(snapshot.reason, 'snapshot'); assert.equal(snapshot.timedOut, undefined);
  const unchanged = await host.call('subagent_inspect', { jobId: job.jobId, output: true, timeout: 0.03, until: 'update', after: update.reportVersion! });
  assert.equal(unchanged.reason, 'timeout'); assert.equal(unchanged.timedOut, true);
  const controller = new AbortController();
  const finish = host.tools.get('subagent_inspect').execute('abort-observation', { jobId: job.jobId, output: true, until: 'finish' }, controller.signal, undefined, host.ctx);
  controller.abort();
  const aborted = await finish;
  assert.equal(aborted.isError, true);
  assert.match(aborted.content[0].text, /agent continues/);
  assert.equal(activeJobs(host), 1, 'cancelling observation must not cancel the child');
  await host.call('subagent_cancel', { jobId: job.jobId });
  assert.equal((await host.call('subagent_inspect', { jobId: job.jobId, output: true, timeout: 0 })).status, 'cancelled');
});
}
{
const fixture = fileURLToPath(new URL('./fixtures/m2-rpc-fixture.mjs', import.meta.url));
async function until(check: () => boolean | Promise<boolean>) { const end = Date.now() + 4000; while (!await check()) { if (Date.now() > end) throw new Error('Abort fixture not ready'); await delay(5); } }
const jobOf = async (host: any, id: string) => (await host.call('subagent_inspect', { jobId: id })).jobs[0];
async function authHost(features: any[] = ['agents']) { const host = await protocolHost({ features, childProvider: false }); host.ctx.modelRegistry.getApiKeyAndHeaders = () => new Promise(() => {}); return host; }

test('pre-abort reserves no slot; abort during authentication returns promptly without launching a child', async (t) => {
  const host = await authHost(); t.after(() => host.close());
  const spawnTool = host.tools.get('subagent_spawn');
  const pre = new AbortController(); pre.abort();
  const preResult = await spawnTool.execute('pre', { task: 'HOLD' }, pre.signal, undefined, host.ctx);
  assert.equal(preResult.isError, true); assert.equal(saved(host).length, 0);
  const during = new AbortController();
  const pending = spawnTool.execute('during', { task: 'HOLD' }, during.signal, undefined, host.ctx);
  await until(() => saved(host).length === 1);
  during.abort(); const result = await pending;
  assert.equal(result.isError, true); assert.match(result.content[0].text, /aborted/);
  assert.equal(activeJobs(host), 0);
});
test('deadline or explicit cancel releases a dispatch stuck in authentication even without a parent abort', async (t) => {
  const host = await authHost(); t.after(() => host.close());
  let authCalls = 0;
  host.ctx.modelRegistry.getApiKeyAndHeaders = () => { authCalls++; return new Promise(() => {}); };
  const expired = await host.execute('subagent_spawn', { task: 'HOLD', timeout: 0.05 });
  assert.equal(expired.details.status, 'failed');
  assert.equal(expired.details.error, 'Agent deadline exceeded');
  assert.equal(activeJobs(host), 0);
  assert.equal(authCalls, 1, 'the deadline actually interrupted authentication');
  const pending = host.execute('subagent_spawn', { task: 'HOLD' });
  await until(() => authCalls === 2);
  const id = saved(host).at(-1).id;
  await host.call('subagent_cancel', { jobId: id });
  assert.equal((await pending).details.status, 'cancelled');
  assert.equal(activeJobs(host), 0);
});
test('abort during a stalled startup RPC stops the process and releases the slot', async (t) => {
  process.env.PI_DAG_TEST_STALL_COMMAND = 'set_model';
  const host = await protocolHost({ cli: fixture }); t.after(async () => { await host.close(); delete process.env.PI_DAG_TEST_STALL_COMMAND; });
  const stop = new AbortController();
  const pending = host.tools.get('subagent_spawn').execute('stall', { task: 'HOLD' }, stop.signal, undefined, host.ctx);
  await until(async () => { const first = saved(host)[0]; return Boolean(first) && ((await jobOf(host, first.id)).activeTools ?? []).some((tool: any) => tool.tool === 'stall:set_model'); });
  stop.abort(); const result = await pending;
  assert.equal(result.isError, true); assert.equal(activeJobs(host), 0);
  const stopped = await jobOf(host, saved(host)[0].id);
  assert.equal(stopped.status, 'cancelled'); assert.deepEqual(stopped.activeTools, []);
});
test('abort after successful dispatch leaves a stable background child running; aborting a mutating send cancels uncertainty', async (t) => {
  const host = await protocolHost({ cli: fixture }); t.after(() => host.close());
  const oldSignal = new AbortController();
  const job = await host.tools.get('subagent_spawn').execute('spawn', { task: 'HOLD' }, oldSignal.signal, undefined, host.ctx);
  oldSignal.abort(); assert.equal(activeJobs(host), 1);
  const notSent = await host.tools.get('subagent_send').execute('send', { recipient: job.details.jobId, message: 'not sent' }, oldSignal.signal, undefined, host.ctx);
  assert.equal(notSent.isError, true); assert.equal(activeJobs(host), 1);
  const stop = new AbortController();
  const send = host.tools.get('subagent_send').execute('stall', { recipient: job.details.jobId, message: 'STALL_DIRECTION' }, stop.signal, undefined, host.ctx);
  await until(async () => ((await jobOf(host, job.details.jobId)).activeTools ?? []).some((tool: any) => tool.tool === 'stall:prompt'));
  stop.abort(); const result = await send;
  assert.equal(result.isError, true); assert.equal(activeJobs(host), 0);
  const cancelled = await jobOf(host, job.details.jobId);
  assert.equal(cancelled.status, 'cancelled'); assert.equal(cancelled.pendingMessages, 0);
});
test('real Pi: parent abort cancels a child stalled during startup and leaves its Todo pending', { timeout: 30000 }, async (t) => {
  const gate = fileURLToPath(new URL('./fixtures/child-startup-gate.ts', import.meta.url));
  const client = await IsolatedClient.start(undefined, 'abort-startup-rpc', [], ['--dag-workflow-test-child-provider', gate]); t.after(() => client.close());
  await client.prompt('TEST CALL todo {"action":"create","subject":"remain pending after abort"}');
  await client.send('prompt', { message: 'TEST CALL subagent_spawn {"task":"must not start","todoId":1}' });
  await client.until(() => client.records.some((event) => event.type === 'entry_appended' && (event.entry as any)?.data?.jobs?.some((job: any) => job.status === 'starting')));
  const start = Date.now(); await client.send('abort'); assert.ok(Date.now() - start < 6000, 'cancel must not wait for the 15s RPC timeout');
  const entries = await client.entries(); const jobs = retainedJobs(entries).records;
  assert.equal(jobs[0]!.status, 'cancelled');
  const current = (entries as any[]).findLast((entry) => entry.customType === STATE_TYPE).data;
  assert.equal(current.tasks[0].status, 'pending');
});
test('the tool propagates cancellation and never claims its Todo after an aborted startup', async (t) => {
  const host = await authHost(['todos', 'agents']); t.after(() => host.close());
  await host.call('todo', { action: 'create', subject: 'remain pending' });
  const stop = new AbortController();
  const result = host.tools.get('subagent_spawn').execute('abort', { task: 'HOLD', todoId: 1 }, stop.signal, undefined, host.ctx);
  await delay(20); stop.abort();
  assert.equal((await result).isError, true);
  assert.equal((await host.call('todo', { action: 'get', id: 1 })).tasks[0].status, 'pending');
  assert.equal(saved(host).some((item: any) => item.status === 'cancelled'), true);
  assert.equal(activeJobs(host), 0);
});
}
{
test('tool activity repaints past 99 seconds and stops its timer on completion and shutdown', async (t) => {
  const fixture = fileURLToPath(new URL('./fixtures/m2-rpc-fixture.mjs', import.meta.url));
  const host = await protocolHost({ cli: fixture }); t.after(() => host.close());
  host.ctx.hasUI = true; host.ctx.mode = 'tui';
  let paints = 0;
  host.ctx.ui.setWidget = () => { paints++; };
  const job = await host.call('subagent_spawn', { task: 'ACTIVITY' });
  await delay(400);
  assert.ok(paints > 0, 'live activity repaints the widget while a tool runs');
  await host.call('subagent_inspect', { jobId: job.jobId, output: true, until: 'finish', timeout: 5 });
  const afterRun = paints; const persisted = saved(host).length; await delay(1200);
  assert.equal(paints, afterRun, 'completion stops the periodic activity refresh');
  assert.equal(saved(host).some((item: any) => 'activity' in item || 'since' in item), false, 'activity is never persisted');
  assert.equal(saved(host).length, persisted, 'clock ticks never append workflow or model state');
});
}
