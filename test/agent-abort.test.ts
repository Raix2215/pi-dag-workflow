import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { AgentRuntime, type SpawnOptions } from '../src/agents/runtime.ts';
import { ProfileStore } from '../src/agents/profiles.ts';
import { registerAgents } from '../src/agents/register.ts';
import { emptyState, STATE_TYPE } from '../src/todos/state.ts';
import { IsolatedClient } from './fixtures/isolated-client.ts';
import { foldAgentEntries } from '../src/agents/persistence.ts';
const model = { provider: 'dag-test', id: 'scripted' };
const fixture = fileURLToPath(new URL('./fixtures/m2-rpc-fixture.mjs', import.meta.url));
async function until(check: () => boolean) { const end = Date.now() + 4000; while (!check()) { if (Date.now() > end) throw new Error('Abort fixture not ready'); await delay(5); } }

test('pre-abort reserves no slot; abort during authentication returns promptly without launching a child', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dag-abort-auth-'));
  const runtime = new AgentRuntime({ cwd: root, profiles: new ProfileStore({ registry: { find: () => model } }), getInheritedModel: () => model, testCliPath: fixture, getModelBootstrap: () => new Promise(() => {}) });
  t.after(async () => { await runtime.shutdown(); await rm(root, { recursive: true, force: true }); });
  const pre = new AbortController(); pre.abort();
  await assert.rejects(runtime.spawn({ task: 'HOLD', signal: pre.signal }), /aborted/); assert.equal(runtime.inspect().length, 0);
  const during = new AbortController(); const pending = runtime.spawn({ task: 'HOLD', signal: during.signal });
  const rejected = assert.rejects(pending, /Dispatch aborted/); during.abort(); await rejected;
  assert.equal(runtime.activeCount(), 0); assert.equal(runtime.inspect()[0]!.status, 'cancelled');
});

test('deadline or explicit cancel releases a dispatch stuck in authentication even without a parent abort', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dag-auth-deadline-'));
  const runtime = new AgentRuntime({ cwd: root, profiles: new ProfileStore({ registry: { find: () => model } }), getInheritedModel: () => model, testCliPath: fixture, getModelBootstrap: () => new Promise(() => {}) });
  t.after(async () => { await runtime.shutdown(); await rm(root, { recursive: true, force: true }); });
  const expired = await runtime.spawn({ task: 'HOLD', timeout: 0.03 });
  assert.equal(expired.status, 'failed'); assert.equal(expired.error, 'Agent deadline exceeded'); assert.equal(runtime.activeCount(), 0);
  const pending = runtime.spawn({ task: 'HOLD' }); const id = runtime.inspect().at(-1)!.id;
  await runtime.cancel(id); assert.equal((await pending).status, 'cancelled'); assert.equal(runtime.activeCount(), 0);
});

test('abort during a stalled startup RPC stops the process and releases the slot', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dag-abort-startup-'));
  const runtime = new AgentRuntime({ cwd: root, profiles: new ProfileStore({ registry: { find: () => model } }), getInheritedModel: () => model, testCliPath: fixture, childEnv: { PI_DAG_TEST_STALL_COMMAND: 'set_model' } });
  t.after(async () => { await runtime.shutdown(); await rm(root, { recursive: true, force: true }); });
  const stop = new AbortController(); const pending = runtime.spawn({ task: 'HOLD', signal: stop.signal });
  const rejected = assert.rejects(pending, /Dispatch aborted/);
  await until(() => runtime.inspect()[0]?.activeTools.some((tool) => tool.tool === 'stall:set_model') === true);
  stop.abort(); await rejected; assert.equal(runtime.activeCount(), 0); assert.equal(runtime.inspect()[0]!.status, 'cancelled');
  assert.deepEqual(runtime.inspect()[0]!.activeTools, []);
});

test('abort after successful dispatch leaves a stable background child running; aborting a mutating send cancels uncertainty', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dag-abort-send-'));
  const runtime = new AgentRuntime({ cwd: root, profiles: new ProfileStore({ registry: { find: () => model } }), getInheritedModel: () => model, testCliPath: fixture });
  t.after(async () => { await runtime.shutdown(); await rm(root, { recursive: true, force: true }); });
  const oldSignal = new AbortController(); const job = await runtime.spawn({ task: 'HOLD', signal: oldSignal.signal });
  oldSignal.abort(); assert.equal(runtime.activeCount(), 1);
  await assert.rejects(runtime.send({ recipient: job.id, message: 'not sent', signal: oldSignal.signal }), /aborted/);
  assert.equal(runtime.activeCount(), 1);
  const stop = new AbortController(); const send = runtime.send({ recipient: job.id, message: 'STALL_DIRECTION', signal: stop.signal });
  const rejected = assert.rejects(send, /aborted/);
  await until(() => runtime.inspect(job.id)[0]!.activeTools.some((tool) => tool.tool === 'stall:prompt'));
  stop.abort(); await rejected; assert.equal(runtime.activeCount(), 0);
  assert.equal(runtime.inspect(job.id)[0]!.status, 'cancelled'); assert.equal(runtime.inspect(job.id)[0]!.pendingMessages, 0);
});

test('real Pi: parent abort cancels a child stalled during startup and leaves its Todo pending', { timeout: 30000 }, async (t) => {
  const gate = fileURLToPath(new URL('./fixtures/child-startup-gate.ts', import.meta.url));
  const client = await IsolatedClient.start(undefined, 'abort-startup-rpc', [], ['--dag-workflow-test-child-provider', gate]); t.after(() => client.close());
  await client.prompt('TEST CALL todo {"action":"create","subject":"remain pending after abort"}');
  await client.send('prompt', { message: 'TEST CALL subagent_spawn {"task":"must not start","todoId":1}' });
  await client.until(() => client.records.some((event) => event.type === 'entry_appended' && (event.entry as any)?.data?.jobs?.some((job: any) => job.status === 'starting')));
  const start = Date.now(); await client.send('abort'); assert.ok(Date.now() - start < 6000, 'cancel must not wait for the 15s RPC timeout');
  const entries = await client.entries(); const jobs = foldAgentEntries(entries).records;
  assert.equal(jobs[0]!.status, 'cancelled');
  const current = (entries as any[]).findLast((entry) => entry.customType === STATE_TYPE).data;
  assert.equal(current.tasks[0].status, 'pending');
});

test('the tool propagates cancellation and never claims its Todo after an aborted startup', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dag-abort-tool-')); const prior = process.env.PI_CODING_AGENT_DIR; process.env.PI_CODING_AGENT_DIR = root;
  const events = new Map<string, Function[]>(), tools = new Map<string, any>(); let claims = 0;
  const state = { ...emptyState(), nextId: 2, tasks: [{ id: 1, subject: 'remain pending', status: 'pending' as const, blockedBy: [] }] };
  const pi: any = { on(n: string, h: Function) { events.set(n, [...events.get(n) ?? [], h]); }, registerTool(tool: any) { tools.set(tool.name, tool); }, registerFlag() {}, registerCommand() {}, getFlag() {}, appendEntry() {} };
  const ctx: any = { cwd: root, hasUI: false, isIdle: () => false, model, modelRegistry: { find: () => model }, sessionManager: { getBranch: () => [] }, ui: { notify() {} } };
  t.mock.method(AgentRuntime.prototype, 'spawn', async (input: SpawnOptions) => { assert.ok(input.signal); if (input.signal.aborted) throw new Error('Dispatch aborted'); await new Promise<void>((_resolve, reject) => input.signal!.addEventListener('abort', () => reject(new Error('Dispatch aborted')), { once: true })); throw new Error('unreachable'); });
  registerAgents(pi, { state: () => state, mutate() { claims++; }, paint() {}, protected: () => false });
  t.after(async () => { for (const h of events.get('session_shutdown') ?? []) await h({}, ctx); if (prior === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = prior; await rm(root, { recursive: true, force: true }); });
  for (const h of events.get('session_start') ?? []) await h({}, ctx);
  const stop = new AbortController(); const result = tools.get('subagent_spawn').execute('abort', { task: 'HOLD', todoId: 1 }, stop.signal, undefined, ctx);
  await delay(20); stop.abort(); assert.equal((await result).isError, true); assert.equal(claims, 0); assert.equal(state.tasks[0]!.status, 'pending');
});
