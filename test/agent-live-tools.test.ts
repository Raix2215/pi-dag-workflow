import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { AgentRuntime } from '../src/agents/runtime.ts';
import { ProfileStore } from '../src/agents/profiles.ts';
import { AgentJournal, foldAgentData } from '../src/agents/persistence.ts';
import { IsolatedClient } from './fixtures/isolated-client.ts';

const model = { provider: 'dag-test', id: 'scripted' };
async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'dag-live-tools-'));
  const profiles = new ProfileStore({ trustedTools: ['bash', 'write', 'edit'], registry: { find: (provider, id) => provider === model.provider && ['scripted', 'reasoned'].includes(id) ? { provider, id, reasoning: id === 'reasoned' } : undefined } });
  const log = join(root, 'child-context.jsonl');
  const runtime = new AgentRuntime({ cwd: root, profiles, getInheritedModel: () => model, getInheritedTools: () => ['read'], testExtensions: [new URL('./fixtures/offline-model.ts', import.meta.url).pathname], ...(process.env.PI_DAG_TEST_CLI ? { testCliPath: process.env.PI_DAG_TEST_CLI } : {}), childEnv: { HOME: root, PI_CODING_AGENT_DIR: join(root, 'agent'), PI_DAG_TEST_CHILD_CONTEXT_LOG: log } });
  return { root, log, profiles, runtime, close: async () => { await runtime.shutdown(); await rm(root, { recursive: true, force: true }); } };
}
async function until(check: () => boolean) {
  const deadline = Date.now() + 10000;
  while (!check()) { if (Date.now() > deadline) throw new Error('Child observation timed out'); await delay(10); }
}

test('real Pi: a temporary environment selects model, thinking and skill without a saved profile', { timeout: 30000 }, async (t) => {
  const h = await setup(); t.after(h.close);
  await writeFile(join(h.root, 'review.md'), 'TEMPORARY-SKILL-CONTENT');
  const job = await h.runtime.spawn({ task: 'TEST SELECTED SKILL', model: { provider: model.provider, id: 'reasoned' }, thinking: 'low', tools: ['read'], skills: ['./review.md'], timeout: 20 });
  const result = await h.runtime.wait(job.id, { until: 'finish', timeout: 15 });
  assert.equal(result.status, 'completed', result.output);
  assert.equal(result.model.id, 'reasoned'); assert.equal(result.thinking, 'low');
  assert.deepEqual(result.skills, [join(h.root, 'review.md')]);
  assert.match(result.output, /TEMPORARY-SKILL-CONTENT/);
  assert.deepEqual(h.profiles.list(), []);
});

test('real Pi: granting tools preserves the same job and question context, and applies before the next request', { timeout: 30000 }, async (t) => {
  const h = await setup(); t.after(h.close);
  const job = await h.runtime.spawn({ task: 'CONTROL QUESTION', tools: ['read'], timeout: 20 });
  await until(() => h.runtime.inspect(job.id)[0]!.phase === 'waiting');
  const requestId = h.runtime.inspect(job.id)[0]!.questions[0]!.requestId;
  await assert.rejects(h.runtime.send({ recipient: job.id, message: 'invalid', tools: ['read', 'write'] }), /interrupt/);
  assert.equal(h.runtime.hasRequest(job.id, requestId), true, 'invalid input must not cancel the question');
  const sent = await h.runtime.send({ recipient: job.id, message: 'CONTROL REDIRECT QUESTION', tools: ['read', 'write'], interrupt: true });
  assert.equal(sent.interrupted, true); assert.deepEqual(sent.tools, ['read', 'write']);
  const result = await h.runtime.wait(job.id, { until: 'finish', timeout: 10 });
  assert.equal(result.status, 'completed', result.output); assert.deepEqual(result.tools, ['read', 'write']);
  assert.equal(await readFile(join(h.root, 'redirect-question.txt'), 'utf8'), 'CONTROL-SELF-DECIDED');
  assert.equal(h.runtime.inspect().length, 1); assert.equal(h.runtime.hasRequest(job.id, requestId), false);
  const contexts = (await readFile(h.log, 'utf8')).trim().split('\n').map((line) => JSON.parse(line)).filter((record) => record.type === 'input').map((record) => record.context);
  const declaredTools = (context: { messages: { role: string; toolsAdded?: { name: string }[]; toolsRemoved?: string[] }[] }) => {
    const names = new Set<string>();
    for (const message of context.messages) if (message.role === 'system') {
      for (const name of message.toolsRemoved ?? []) names.delete(name);
      for (const tool of message.toolsAdded ?? []) names.add(tool.name);
    }
    return [...names].sort();
  };
  assert.deepEqual(declaredTools(contexts[0]), ['read', 'subagent_send']);
  assert.deepEqual(declaredTools(contexts.at(-1)), ['read', 'subagent_send', 'write']);
  assert.doesNotMatch(JSON.stringify(contexts), /pi-dag-child-control:|pi-dag-child-tools:|PI_DAG_AGENT_CONTROL/);
});

test('real Pi: unselected registered tools cannot write; removing a tool also prevents the next write', { timeout: 30000 }, async (t) => {
  const h = await setup(); t.after(h.close);
  const denied = await h.runtime.spawn({ task: 'TEST CALL write {"path":"denied.txt","content":"NO"}', tools: ['read'], timeout: 20 });
  const first = await h.runtime.wait(denied.id, { until: 'finish', timeout: 10 });
  assert.equal(first.status, 'completed', first.output);
  await assert.rejects(readFile(join(h.root, 'denied.txt')), { code: 'ENOENT' });
  const job = await h.runtime.spawn({ task: 'CONTROL QUESTION', tools: ['read', 'write'], timeout: 20 });
  await until(() => h.runtime.inspect(job.id)[0]!.phase === 'waiting');
  await h.runtime.send({ recipient: job.id, message: 'TEST CALL write {"path":"revoked.txt","content":"NO"}', tools: ['read'], interrupt: true });
  const result = await h.runtime.wait(job.id, { until: 'finish', timeout: 10 });
  assert.equal(result.status, 'completed', result.output); assert.deepEqual(result.tools, ['read']);
  await assert.rejects(readFile(join(h.root, 'revoked.txt')), { code: 'ENOENT' });
});

test('real Pi: actual configuration survives profile deletion and journal restore, including instructions and empty skills', { timeout: 30000 }, async (t) => {
  const h = await setup(); t.after(h.close);
  await writeFile(join(h.root, 'review.md'), 'SAVED-SKILL');
  h.profiles.set({ name: 'reviewer', model: { provider: model.provider, id: 'reasoned' }, thinking: 'low', tools: ['read'], skills: ['./review.md'], instructions: 'ORIGINAL-PROFILE-GUIDANCE' });
  const old = await h.runtime.spawn({ task: 'CONTROL QUESTION', profile: 'reviewer', timeout: 20 });
  await until(() => h.runtime.inspect(old.id)[0]!.phase === 'waiting');
  const journal = new AgentJournal(); const first = journal.prepare(h.runtime.exportRecords(), h.runtime.nextId())!; journal.confirm();
  await h.runtime.cancel(old.id);
  const second = journal.prepare(h.runtime.exportRecords(), h.runtime.nextId())!;
  const folded = foldAgentData([first, second]);
  h.profiles.delete('reviewer');
  await h.runtime.importSummaries(folded.records, folded.nextId);
  const resumed = await h.runtime.spawn({ task: 'TEST SELECTED SKILL', resumeFrom: old.id, skills: [], timeout: 20 });
  const result = await h.runtime.wait(resumed.id, { until: 'finish', timeout: 10 });
  assert.equal(result.status, 'completed', result.output); assert.equal(result.model.id, 'reasoned'); assert.equal(result.thinking, 'low');
  assert.deepEqual(result.skills, []); assert.doesNotMatch(result.output, /SAVED-SKILL/);
  assert.equal(h.runtime.exportRecords().find((item) => item.id === resumed.id)!.profileInstructions, 'ORIGINAL-PROFILE-GUIDANCE');
  assert.doesNotMatch(JSON.stringify(h.runtime.inspect(resumed.id)), /ORIGINAL-PROFILE-GUIDANCE/);
});

for (const payload of ['{"token":"wrong-token","nonce":"private-nonce","tools":["write"]}', '{malformed-control']) test(`real Pi: rejected private control never reaches the model (${payload.startsWith('{malformed') ? 'malformed' : 'wrong token'})`, { timeout: 30000 }, async (t) => {
  const h = await setup(); t.after(h.close);
  const job = await h.runtime.spawn({ task: 'CONTROL QUESTION', tools: ['read'], timeout: 20 });
  await until(() => h.runtime.inspect(job.id)[0]!.phase === 'waiting');
  await assert.rejects(h.runtime.send({ recipient: job.id, message: 'pi-dag-child-control:' + payload, interrupt: true }), /without a model run/);
  assert.equal(h.runtime.inspect(job.id)[0]!.status, 'failed');
  const contexts = await readFile(h.log, 'utf8');
  assert.doesNotMatch(contexts, /pi-dag-child-control:|wrong-token|private-nonce|malformed-control/);
  assert.deepEqual(h.runtime.inspect(job.id)[0]!.tools, ['read']);
});

test('real Pi: restoring a snapshot and temporary dispatch do not depend on unrelated broken Profiles', { timeout: 30000 }, async (t) => {
  const offline = new URL('./fixtures/offline-model.ts', import.meta.url).pathname;
  const client = await IsolatedClient.start(undefined, 'snapshot-broken-profile', [], ['--dag-workflow-test-child-provider', offline]);
  t.after(() => client.close());
  const call = async (name: string, params: object, expectError = false) => {
    const events = await client.prompt(`TEST CALL ${name} ${JSON.stringify(params)}`);
    const end = events.find((event) => event.type === 'tool_execution_end' && event.toolName === name)!;
    assert.ok(end); assert.equal(Boolean(end.isError || (end.result as any).isError), expectError, JSON.stringify(end.result));
    return (end.result as any).details;
  };
  const original = await call('subagent_spawn', { task: 'Original snapshot', tools: ['read'], skills: [] });
  await call('subagent_inspect', { jobId: original.jobId, output: true, until: 'finish', timeout: 10 });
  await mkdir(join(client.root, 'agent/pi-dag-workflow'), { recursive: true });
  await writeFile(join(client.root, 'agent/pi-dag-workflow/pi-dag-workflow-profile.json'), JSON.stringify({ profiles: [{ name: 'unrelated', model: { provider: 'unknown', id: 'removed' } }] }));
  const state = (await client.send('get_state')).data as { sessionFile: string };
  await client.send('switch_session', { sessionPath: state.sessionFile });
  const resumed = await call('subagent_spawn', { resumeFrom: original.jobId, task: 'Check saved snapshot' });
  const result = await call('subagent_inspect', { jobId: resumed.jobId, output: true, until: 'finish', timeout: 10 });
  assert.equal(result.status, 'completed'); assert.deepEqual(result.tools, ['read']);
  const temporary = await call('subagent_spawn', { task: 'Temporary work', tools: [], skills: [] });
  assert.deepEqual(temporary.tools, []);
  await call('subagent_inspect', { profile: 'unrelated' }, true);
});

test('real Pi workflow: temporary dispatch, parent-approved live tools, report verification and Todo completion', { timeout: 30000 }, async (t) => {
  const offline = new URL('./fixtures/offline-model.ts', import.meta.url).pathname;
  const client = await IsolatedClient.start(undefined, 'temporary-child-workflow', [], ['--dag-workflow-test-child-provider', offline]);
  t.after(() => client.close());
  await writeFile(join(client.root, 'review.md'), 'WORKFLOW-SKILL');
  const call = async (name: string, params: object) => {
    const events = await client.prompt(`TEST CALL ${name} ${JSON.stringify(params)}`);
    const end = events.find((event) => event.type === 'tool_execution_end' && event.toolName === name)!;
    assert.ok(end); assert.ok(!end.isError && !(end.result as any).isError, JSON.stringify(end.result));
    return (end.result as any).details;
  };
  const models = await call('subagent_inspect', { models: true, query: 'reasoned' });
  assert.equal(models.total, 1);
  await call('todo', { action: 'create', subject: 'Temporary child work', description: 'Produce and verify the requested artifact' });
  const spawned = await call('subagent_spawn', { todoId: 1, task: 'CONTROL QUESTION', model: { provider: models.models[0].provider, id: models.models[0].id }, thinking: 'low', tools: ['read'], skills: ['./review.md'] });
  assert.equal(spawned.model.id, 'reasoned'); assert.deepEqual(spawned.tools, ['read']); assert.deepEqual(spawned.skills, [join(client.root, 'review.md')]);
  const question = await call('subagent_inspect', { jobId: spawned.jobId, output: true, until: 'update', timeout: 10 });
  assert.equal(question.status, 'waiting'); assert.equal(question.questions?.length ?? question.requests.length, 1);
  const sent = await call('subagent_send', { recipient: spawned.jobId, interrupt: true, tools: ['read', 'write'], message: 'CONTROL REDIRECT QUESTION' });
  assert.deepEqual(sent.tools, ['read', 'write']);
  const result = await call('subagent_inspect', { jobId: spawned.jobId, output: true, until: 'finish', timeout: 10 });
  assert.equal(result.status, 'completed'); assert.equal(result.todoStatus, 'in_progress');
  assert.deepEqual(result.tools, ['read', 'write']); assert.equal(result.model.id, 'reasoned');
  assert.equal(await readFile(join(client.root, 'redirect-question.txt'), 'utf8'), 'CONTROL-SELF-DECIDED');
  await call('todo', { action: 'update', id: 1, status: 'completed' });
  assert.equal((await call('todo', { action: 'get', id: 1 })).tasks[0].status, 'completed');
  assert.equal((await call('subagent_inspect', {})).jobs.length, 1);
  const parent = (await client.send('get_state')).data as { model: { id: string }; thinkingLevel: string };
  assert.equal(parent.model.id, 'scripted'); assert.equal(parent.thinkingLevel, 'off');
});
