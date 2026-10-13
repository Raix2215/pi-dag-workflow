import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentRuntime } from '../src/agents/runtime.ts';
import { ProfileStore } from '../src/agents/profiles.ts';

async function setup(hidden = false) {
  const root = await mkdtemp(join(tmpdir(), 'dag-update-preflight-'));
  const extension = join(root, 'hidden-write.ts');
  if (hidden) await writeFile(extension, `export default function(pi) { pi.registerTool({ name: 'write', label: 'Test unavailable tool', description: 'Test only', exposure: 'hidden', parameters: { type: 'object', properties: {} }, async execute() { throw Error('must not execute'); } }); }`);
  const runtime = new AgentRuntime({ cwd: root, profiles: new ProfileStore({ trustedTools: ['write', 'bash'], registry: { find: () => ({ reasoning: false }) } }), getInheritedModel: () => ({ provider: 'dag-test', id: 'scripted' }), getInheritedTools: () => ['read', 'ffgrep', 'recall'], testCliPath: process.env.PI_DAG_TEST_CLI ?? new URL('../node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js', import.meta.url).pathname, testExtensions: [new URL('./fixtures/offline-model.ts', import.meta.url).pathname, ...hidden ? [extension] : []], childEnv: { HOME: root, PI_CODING_AGENT_DIR: join(root, 'agent') } });
  return { root, runtime, close: async () => { await runtime.shutdown(); await rm(root, { recursive: true, force: true }); } };
}

test('real Pi: unavailable child tool is rejected before interruption, preserving the question and queued direction', { timeout: 30000 }, async (t) => {
  const h = await setup(true); t.after(h.close);
  const job = await h.runtime.spawn({ task: 'CONTROL QUESTION', tools: ['read'], timeout: 20 });
  const waiting = await h.runtime.wait(job.id, { timeout: 10, after: 0 });
  assert.equal(waiting.status, 'waiting'); const question = waiting.requests[0]!;
  await h.runtime.send({ recipient: job.id, message: 'Queued original direction' });
  const before = h.runtime.inspect(job.id)[0]!;
  await assert.rejects(h.runtime.send({ recipient: job.id, tools: ['read', 'write'], interrupt: true, message: 'MUST-NOT-DELIVER' }), (cause: any) => {
    assert.match(cause.message, /unavailable.*write/i);
    assert.equal(cause.details.stage, 'preflight'); assert.equal(cause.details.status, 'waiting');
    assert.equal(cause.details.interrupted, false); assert.equal(cause.details.queueCleared, false);
    assert.equal(cause.details.questionsCleared, false); assert.equal(cause.details.directionDelivery, 'not_sent');
    return true;
  });
  const after = h.runtime.inspect(job.id)[0]!;
  assert.equal(after.status, 'waiting'); assert.equal(after.questions[0]!.requestId, question.requestId);
  assert.equal(after.pendingMessages, before.pendingMessages); assert.deepEqual(after.tools, ['read']);
  assert.equal(after.taskReportStale, undefined); assert.equal(h.runtime.activeCount(), 1);
  await h.runtime.send({ requestId: question.requestId, message: 'Answer original question' });
  const result = await h.runtime.wait(job.id, { until: 'finish', timeout: 10 });
  assert.equal(result.status, 'completed'); assert.doesNotMatch(result.output, /MUST-NOT-DELIVER/);
});

test('tool boundaries are self-describing and inherited omissions are reported only when used', async (t) => {
  const h = await setup(); t.after(h.close);
  const store = new ProfileStore({ registry: { find: () => ({}) }, trustedTools: ['write'] });
  assert.throws(() => store.validateTools(['ffgrep']), /Allowed: read, grep, find, ls, write; up to 8/);
  const job = await h.runtime.spawn({ task: 'Short inherited assignment', timeout: 20 });
  assert.deepEqual(job.ignoredInheritedTools, ['ffgrep', 'recall']);
  const explicit = await h.runtime.spawn({ task: 'Short explicit assignment', tools: ['read'], timeout: 20 });
  assert.equal(explicit.ignoredInheritedTools, undefined);
});
