import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { AgentRuntime, type AgentNotice } from '../src/agents/runtime.ts';
import { ProfileStore } from '../src/agents/profiles.ts';

const model = { provider: 'dag-test', id: 'scripted' };
const offline = fileURLToPath(new URL('./fixtures/offline-model.ts', import.meta.url));
async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'dag-agent-controls-'));
  const profiles = new ProfileStore({ trustedTools: ['bash', 'write'], registry: { find: () => model } });
  const notices: AgentNotice[] = [];
  const runtime = new AgentRuntime({ cwd: root, profiles, getInheritedModel: () => model, childEnv: { HOME: root, PI_CODING_AGENT_DIR: join(root, 'agent') }, testExtensions: [offline], onNotice: (notice) => notices.push(notice) });
  return { root, runtime, notices, close: async () => { await runtime.shutdown(); await rm(root, { recursive: true, force: true }); } };
}
async function until(check: () => boolean | Promise<boolean>) {
  const deadline = Date.now() + 10000;
  while (!await check()) { if (Date.now() > deadline) throw new Error('Child control observation timed out'); await delay(10); }
}

test('real Pi: interrupt replaces queued directions, preserves the same child context, and aborts its long local tool', { timeout: 30000 }, async (t) => {
  const h = await setup(); t.after(() => h.close());
  const job = await h.runtime.spawn({ task: 'CONTROL LONG CALL', tools: ['bash', 'write'], timeout: 20 });
  await until(() => h.runtime.inspect(job.id)[0]!.activeTools.some((tool) => tool.tool === 'bash'));
  await until(async () => { try { return await readFile(join(h.root, 'original-state.txt'), 'utf8') === 'ORIGINAL-STATE'; } catch { return false; } });
  const info = h.runtime.inspect(job.id)[0]!;
  assert.equal(info.phase, 'tool'); assert.equal(info.hasOutput, false); assert.ok(info.deadlineAt! > info.startedAt);
  const queued = await h.runtime.send({ recipient: job.id, message: 'CONTROL OLD QUEUE' });
  assert.equal(queued.delivery, 'queued'); assert.equal(queued.interrupted, false);
  assert.equal(h.runtime.inspect(job.id)[0]!.pendingMessages, 1);
  const start = Date.now();
  const sent = await h.runtime.send({ recipient: job.id, message: 'CONTROL REDIRECT', interrupt: true });
  assert.equal(sent.interrupted, true); assert.equal(sent.delivery, 'accepted');
  assert.ok(Date.now() - start < 8000, 'redirect must not wait for the original 45s shell');
  const result = await h.runtime.wait(job.id, { timeout: 10, until: 'finish' });
  assert.equal(result.status, 'completed'); assert.match(result.output, /CONTROL-REDIRECT-SUCCESS original-context=true/);
  assert.equal(h.runtime.inspect().length, 1); assert.equal(h.runtime.activeCount(), 0);
  assert.equal(h.notices.some((notice) => notice.kind === 'failed'), false, 'an intentional interruption is not child failure');
  await assert.rejects(readFile(join(h.root, 'old-completed.txt')), { code: 'ENOENT' });
  await assert.rejects(readFile(join(h.root, 'old-direction.txt')), { code: 'ENOENT' });
});

test('a rejected post-interruption direction cannot mark the aborted assignment successful', { timeout: 10000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dag-rejected-direction-'));
  const profiles = new ProfileStore({ registry: { find: () => model } });
  const runtime = new AgentRuntime({ cwd: root, profiles, getInheritedModel: () => model, testCliPath: fileURLToPath(new URL('./fixtures/m2-rpc-fixture.mjs', import.meta.url)) });
  t.after(async () => { await runtime.shutdown(); await rm(root, { recursive: true, force: true }); });
  const job = await runtime.spawn({ task: 'HOLD' });
  await assert.rejects(runtime.send({ recipient: job.id, message: 'HANDLED', interrupt: true }), /without a model run/);
  const result = await runtime.wait(job.id, { until: 'finish', timeout: 2 });
  assert.equal(result.status, 'failed');
});

test('a failed interruption command terminates uncertainty instead of stranding report acceptance', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dag-failed-interrupt-'));
  const runtime = new AgentRuntime({ cwd: root, profiles: new ProfileStore({ registry: { find: () => model } }), getInheritedModel: () => model, testCliPath: fileURLToPath(new URL('./fixtures/m2-rpc-fixture.mjs', import.meta.url)), childEnv: { PI_DAG_TEST_FAIL_COMMAND: 'clear_queue' } });
  t.after(async () => { await runtime.shutdown(); await rm(root, { recursive: true, force: true }); });
  const job = await runtime.spawn({ task: 'HOLD' });
  await assert.rejects(runtime.send({ recipient: job.id, message: 'replacement', interrupt: true }), /fixture clear_queue rejected/);
  assert.equal(runtime.activeCount(), 0); assert.equal(runtime.inspect(job.id)[0]!.status, 'failed');
  assert.equal(runtime.inspect(job.id)[0]!.error, 'Child redirection failed');
});

test('real Pi: redirect cancels an unanswered child question and resumes the same job', { timeout: 30000 }, async (t) => {
  const h = await setup(); t.after(() => h.close());
  const job = await h.runtime.spawn({ task: 'CONTROL QUESTION', tools: ['bash', 'write'], timeout: 20 });
  await until(() => h.runtime.inspect(job.id)[0]!.phase === 'waiting');
  const pending = h.runtime.inspect(job.id)[0]!;
  assert.equal(pending.questions[0]!.message, 'CONTROL decision?');
  assert.ok(pending.reportVersion > 0);
  await assert.rejects(h.runtime.send({ requestId: pending.questions[0]!.requestId, message: 'bad', interrupt: true }), /recipient direction/);
  await h.runtime.send({ recipient: job.id, message: 'CONTROL REDIRECT QUESTION', interrupt: true });
  assert.equal(h.runtime.hasRequest(job.id, pending.questions[0]!.requestId), false);
  const result = await h.runtime.wait(job.id, { timeout: 10, until: 'finish' });
  assert.equal(result.status, 'completed'); assert.match(result.output, /CONTROL-QUESTION-REDIRECTED/);
  assert.equal(await readFile(join(h.root, 'redirect-question.txt'), 'utf8'), 'CONTROL-SELF-DECIDED');
  assert.equal(result.pendingRequests, 0); assert.equal(h.notices.some((notice) => notice.kind === 'failed'), false);
});

test('old tool-batch reports stay historical until a changed queued direction is actually consumed', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dag-report-barrier-'));
  const notices: AgentNotice[] = [];
  const runtime = new AgentRuntime({ cwd: root, profiles: new ProfileStore({ registry: { find: () => model } }), getInheritedModel: () => model, testCliPath: fileURLToPath(new URL('./fixtures/m2-rpc-fixture.mjs', import.meta.url)), onNotice: (notice) => notices.push(notice) });
  t.after(async () => { await runtime.shutdown(); await rm(root, { recursive: true, force: true }); });
  const job = await runtime.spawn({ task: 'HOLD' });
  await runtime.send({ recipient: job.id, message: 'LATE_REPORT_DIRECTION' }); runtime.invalidateReports(job.id);
  await until(() => runtime.inspect(job.id)[0]!.activeTools.some((tool) => tool.tool === 'old-batch-seen'));
  assert.equal(runtime.reports(job.id), 0); assert.equal(notices.length, 0);
  const historical = await runtime.wait(job.id, { timeout: 0 });
  assert.match(historical.output, /Historical report.*OLD-BATCH-REPORT/);
  assert.equal(historical.output.slice(historical.outputStart), '', 'old output cannot masquerade as current evidence');
  await runtime.send({ recipient: job.id, message: 'CONSUME_REPORT_DIRECTION' });
  assert.equal(runtime.reports(job.id), 1); assert.equal(notices[0]!.message, 'NEW-BATCH-REPORT');
  const result = await runtime.wait(job.id, { after: 0 });
  assert.match(result.output.slice(result.outputStart), /NEW-BATCH-REPORT/);
  assert.doesNotMatch(result.output.slice(result.outputStart), /OLD-BATCH-REPORT/);
});

test('real Pi: wait update returns an interim report while finish waits; snapshots and versions remain explicit', { timeout: 30000 }, async (t) => {
  const h = await setup(); t.after(() => h.close());
  const job = await h.runtime.spawn({ task: 'CONTROL REPORT HOLD', tools: ['bash'], timeout: 20 });
  const update = await h.runtime.wait(job.id, { timeout: 10, until: 'update', after: 0 });
  assert.equal(update.reason, 'update'); assert.equal(update.status, 'running');
  assert.match(update.output, /CONTROL-PROGRESS/); assert.ok(update.reportVersion! > 0);
  assert.equal(h.runtime.activeCount(), 1);
  const snapshot = await h.runtime.wait(job.id, { timeout: 0 });
  assert.equal(snapshot.reason, 'snapshot'); assert.equal(snapshot.timedOut, undefined);
  const unchanged = await h.runtime.wait(job.id, { timeout: 0.03, until: 'update', after: update.reportVersion! });
  assert.equal(unchanged.reason, 'timeout'); assert.equal(unchanged.timedOut, true);
  const controller = new AbortController();
  const finish = h.runtime.wait(job.id, { until: 'finish', signal: controller.signal }); controller.abort();
  await assert.rejects(finish, /agent continues/);
  assert.equal(h.runtime.activeCount(), 1);
  await h.runtime.cancel(job.id);
  assert.equal((await h.runtime.wait(job.id)).status, 'cancelled');
});
