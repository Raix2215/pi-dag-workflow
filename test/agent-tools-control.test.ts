import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { AgentRuntime } from '../src/agents/runtime.ts';
import { ProfileStore } from '../src/agents/profiles.ts';

async function setup(mode?: string, releaseStalled = false) {
  const root = await mkdtemp(join(tmpdir(), 'dag-tools-control-'));
  const runtime = new AgentRuntime({ cwd: root, profiles: new ProfileStore({ trustedTools: ['write'], registry: { find: () => ({}) } }), getInheritedModel: () => ({ provider: 'fixture', id: 'test' }), getInheritedTools: () => ['read'], testCliPath: new URL('./fixtures/m2-rpc-fixture.mjs', import.meta.url).pathname, ...(mode ? { childEnv: { PI_DAG_TEST_TOOL_UPDATE: mode, ...(releaseStalled ? { PI_DAG_TEST_RELEASE_STALLED: '1' } : {}) } } : {}) });
  const job = await runtime.spawn({ task: 'HOLD', timeout: 10 });
  assert.equal(job.status, 'running');
  return { runtime, job, close: async () => { await runtime.shutdown(); await rm(root, { recursive: true, force: true }); } };
}
for (const mode of ['ignore', 'mismatch']) test(`an ${mode} tool acknowledgment stops uncertainty without claiming a larger tool scope`, async (t) => {
  const h = await setup(mode); t.after(h.close);
  await assert.rejects(h.runtime.send({ recipient: h.job.id, message: 'continue', tools: ['read', 'write'], interrupt: true }), /not confirmed/);
  assert.equal(h.runtime.activeCount(), 0); assert.equal(h.runtime.inspect(h.job.id)[0]!.status, 'failed');
  assert.deepEqual(h.runtime.inspect(h.job.id)[0]!.tools, ['read']);
});

test('cancelling an in-flight update stops the child and never sends the new assignment', async (t) => {
  const h = await setup('stall'); t.after(h.close);
  const controller = new AbortController();
  const send = h.runtime.send({ recipient: h.job.id, message: 'MUST-NOT-EXECUTE', tools: ['read', 'write'], interrupt: true, signal: controller.signal });
  const rejected = assert.rejects(send, /aborted/);
  const deadline = Date.now() + 3000;
  while (!h.runtime.inspect(h.job.id)[0]!.activeTools.some((tool) => tool.tool === 'tools:update')) { if (Date.now() > deadline) throw new Error('Update was not reached'); await delay(5); }
  controller.abort(); await rejected;
  assert.equal(h.runtime.activeCount(), 0); assert.equal(h.runtime.inspect(h.job.id)[0]!.status, 'cancelled');
  assert.deepEqual(h.runtime.inspect(h.job.id)[0]!.tools, ['read']);
  assert.doesNotMatch((await h.runtime.wait(h.job.id)).output, /MUST-NOT-EXECUTE/);
});

test('an older ordinary send cannot release the lock of a concurrent tool update', async (t) => {
  const h = await setup('stall', true); t.after(h.close);
  const controller = new AbortController();
  const old = assert.rejects(h.runtime.send({ recipient: h.job.id, message: 'STALL_DIRECTION' }), /older direction released/);
  const deadline = Date.now() + 3000;
  while (!h.runtime.inspect(h.job.id)[0]!.activeTools.some((tool) => tool.tool === 'stall:prompt')) { if (Date.now() > deadline) throw new Error('Old direction was not reached'); await delay(5); }
  const update = assert.rejects(h.runtime.send({ recipient: h.job.id, message: 'new task', tools: ['read', 'write'], interrupt: true, signal: controller.signal }), /aborted/);
  await old;
  assert.equal(h.runtime.inspect(h.job.id)[0]!.phase, 'redirecting');
  await assert.rejects(h.runtime.send({ recipient: h.job.id, message: 'second update', tools: [], interrupt: true }), /already redirecting/);
  controller.abort(); await update;
  assert.equal(h.runtime.activeCount(), 0);
});

test('a confirmation may follow the command response without rejecting a successful update', async (t) => {
  const h = await setup('delayed-ack'); t.after(h.close);
  const result = await h.runtime.send({ recipient: h.job.id, message: 'finished', tools: ['read', 'write'], interrupt: true });
  assert.deepEqual(result.tools, ['read', 'write']); assert.equal((await h.runtime.wait(h.job.id)).status, 'completed');
});

for (const mode of ['reject-check', 'stall-check']) test(`${mode} leaves the old child and permissions intact with an actionable preflight diagnosis`, async (t) => {
  const h = await setup(mode); t.after(h.close);
  await assert.rejects(h.runtime.send({ recipient: h.job.id, message: 'not delivered', tools: ['read', 'write'], interrupt: true }), (cause: any) => {
    assert.equal(cause.details.stage, 'preflight'); assert.equal(cause.details.status, 'running');
    assert.equal(cause.details.queueCleared, false); assert.equal(cause.details.interrupted, false);
    assert.equal(cause.details.toolsApplied, false); assert.equal(cause.details.directionDelivery, 'not_sent');
    assert.match(cause.message, mode === 'reject-check' ? /unavailable: write/ : /confirmation timed out/); return true;
  });
  assert.equal(h.runtime.activeCount(), 1); assert.deepEqual(h.runtime.inspect(h.job.id)[0]!.tools, ['read']);
});

test('post-interruption refusal reports stopped state, concrete cause and the undelivered direction', async (t) => {
  const h = await setup('reject-apply'); t.after(h.close);
  await assert.rejects(h.runtime.send({ recipient: h.job.id, message: 'not delivered', tools: ['read', 'write'], interrupt: true }), (cause: any) => {
    assert.equal(cause.details.jobId, h.job.id); assert.equal(cause.details.stage, 'apply_tools');
    assert.equal(cause.details.status, 'failed'); assert.equal(cause.details.interrupted, true);
    assert.equal(cause.details.queueCleared, true); assert.equal(cause.details.questionsCleared, true);
    assert.equal(cause.details.toolsApplied, null); assert.equal(cause.details.directionDelivery, 'not_sent');
    assert.deepEqual(cause.details.currentTools, ['read']); assert.match(cause.message, /refused application: write/); return true;
  });
  assert.equal(h.runtime.activeCount(), 0);
});

test('an ordinary direction failure does not claim unrelated interruption or permission changes', async (t) => {
  const h = await setup(); t.after(h.close);
  await assert.rejects(h.runtime.send({ recipient: h.job.id, message: 'HANDLED' }), (cause: any) => {
    assert.equal(cause.details.stage, 'deliver_direction'); assert.equal(cause.details.directionDelivery, 'not_sent');
    for (const field of ['interrupted', 'queueCleared', 'questionsCleared', 'toolsApplied', 'requestedTools']) assert.equal(Object.hasOwn(cause.details, field), false, field);
    return true;
  });
  assert.equal(h.runtime.activeCount(), 1);
});

test('invalid tools do not interrupt or invalidate current work, and empty tools can be confirmed', async (t) => {
  const h = await setup(); t.after(h.close);
  await assert.rejects(h.runtime.send({ recipient: h.job.id, message: 'bad', tools: ['unsupported'], interrupt: true }), /not trusted or supported/);
  assert.equal(h.runtime.inspect(h.job.id)[0]!.status, 'running');
  assert.equal(h.runtime.inspect(h.job.id)[0]!.taskReportStale, undefined);
  const sent = await h.runtime.send({ recipient: h.job.id, message: 'finished', tools: [], interrupt: true });
  assert.deepEqual(sent.tools, []); assert.deepEqual(h.runtime.inspect(h.job.id)[0]!.tools, []);
  assert.equal((await h.runtime.wait(h.job.id)).status, 'completed');
});
