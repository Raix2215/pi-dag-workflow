import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { IsolatedClient } from './fixtures/isolated-client.ts';
import { GOAL_TYPE, type GoalState } from '../src/goal/state.ts';

/** Isolated Pi with a scripted provider: no network, no credentials, deterministic failures. */
async function agentRoot(config?: object, retry: object = { enabled: false }): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'pi-dag-retry-'));
  const agent = join(root, 'agent');
  await mkdir(join(agent, 'pi-dag-workflow'), { recursive: true });
  // Most cases isolate Goal recovery; the coexistence cases also enable Pi's recovery layer.
  await writeFile(join(agent, 'settings.json'), JSON.stringify({ retry }));
  if (config) await writeFile(join(agent, 'pi-dag-workflow', 'pi-dag-workflow-config.json'), JSON.stringify(config));
  return root;
}
const states = (client: IsolatedClient) => client.records
  .filter((record) => record.type === 'entry_appended' && (record.entry as { customType?: string } | undefined)?.customType === GOAL_TYPE)
  .map((record) => (record.entry as { data: GoalState }).data);
const latest = (client: IsolatedClient) => states(client).at(-1);
const retries = async (client: IsolatedClient) => (await client.entries()).filter((entry) => (entry as { customType?: string }).customType === 'pi-dag-workflow.goal-retry');
const notifications = (client: IsolatedClient) => client.records.filter((record) => record.method === 'notify').map((record) => String(record.message));
const retryNotifications = (client: IsolatedClient) => notifications(client).filter((line) => line.includes('自动重试')).map((line) => (line.match(/自动重试 (\d+\/\d+)/) ?? [])[1]);
async function create(client: IsolatedClient, title: string) {
  const events = await client.prompt(`TEST CALL goal ${JSON.stringify({ action: 'create', title })}`);
  assert.ok(events.some((event) => event.type === 'tool_execution_end' && event.toolName === 'goal' && !event.isError), JSON.stringify(events.slice(-3)));
  const events2 = await client.prompt(`TEST CALL goal ${JSON.stringify({ action: 'enable', id: 1 })}`);
  assert.ok(events2.some((event) => event.type === 'tool_execution_end' && event.toolName === 'goal' && !event.isError), JSON.stringify(events2.slice(-3)));
}

test('actual Pi: a failing request retries, and the next failure is not swallowed by that retry', { timeout: 60000 }, async (t) => {
  const root = await agentRoot();
  const client = await IsolatedClient.start(root, 'goal-retry-flaky');
  t.after(async () => { await client.close(); await rm(root, { recursive: true, force: true }); });
  await create(client, '出错重试测试');
  // Two scripted failures must each earn a retry turn instead of stopping after the first one.
  // Examine recorded transitions: RPC can deliver retry=2 and the later success in one chunk.
  await client.until(() => states(client).some((state) => state.run.errorRetries === 2), 30000);
  assert.equal(states(client).find((state) => state.run.errorRetries === 2)!.run.paused, false, 'a recoverable failure must not pause the goal');
  // Each retry announces itself; the notifications arrive on the RPC stream beside the state entries.
  await client.until(() => retryNotifications(client).length === 2, 20000);
  assert.deepEqual(retryNotifications(client), ['1/5', '2/5']);
  // The third request succeeds, so the budget is restored for the next failure.
  await client.until(() => latest(client)?.goals[0]?.status === 'completed' && latest(client)?.run.errorRetries === 0, 30000);
  assert.equal((await retries(client)).length, 2);
});

test('actual Pi: native retry recovers first without spending a Goal retry', { timeout: 30000 }, async (t) => {
  const root = await agentRoot(undefined, { enabled: true, maxRetries: 3, baseDelayMs: 1 });
  const client = await IsolatedClient.start(root, 'goal-native-recovery');
  t.after(() => client.close());
  await create(client, '出错重试测试');
  await client.until(() => latest(client)?.goals[0]?.status === 'completed');
  assert.equal(client.records.filter((record) => record.type === 'auto_retry_start').length, 2);
  assert.equal((await retries(client)).length, 0);
  assert.equal(retryNotifications(client).length, 0);
});

test('actual Pi: exhausted native retries settle before each bounded Goal retry', { timeout: 30000 }, async (t) => {
  const root = await agentRoot({ goalErrorRetries: 2 }, { enabled: true, maxRetries: 1, baseDelayMs: 1 });
  const client = await IsolatedClient.start(root, 'goal-native-exhausted');
  t.after(() => client.close());
  await create(client, '出错暂停测试');
  await client.until(() => latest(client)?.run.paused === true);
  assert.equal(client.records.filter((record) => record.type === 'auto_retry_start').length, 3);
  assert.equal((await retries(client)).length, 2);
  assert.deepEqual(retryNotifications(client), ['1/2', '2/2']);
});

test('actual Pi: the default five retries are exhausted before pausing', { timeout: 30000 }, async (t) => {
  const root = await agentRoot();
  const client = await IsolatedClient.start(root, 'goal-default-retries');
  t.after(() => client.close());
  await create(client, '出错暂停测试');
  await client.until(() => latest(client)?.run.paused === true);
  assert.equal(latest(client)!.run.errorRetries, 5);
  assert.match(latest(client)!.run.reason!, /已重试 5 次/);
  assert.deepEqual(retryNotifications(client), ['1/5', '2/5', '3/5', '4/5', '5/5']);
  assert.equal((await retries(client)).length, 5);
});

test('actual Pi: zero configured retries pause on the first error', { timeout: 30000 }, async (t) => {
  const root = await agentRoot({ goalErrorRetries: 0 });
  const client = await IsolatedClient.start(root, 'goal-zero-retries');
  t.after(() => client.close());
  await create(client, '出错暂停测试');
  await client.until(() => latest(client)?.run.paused === true);
  assert.equal(latest(client)!.run.reason, '模型出错');
  assert.equal((await retries(client)).length, 0);
});

for (const childDelay of [0.25, 1.25]) test(`actual Pi: child results still wake a Goal after model recovery (${childDelay}s child)`, { timeout: 30000 }, async (t) => {
  const root = await agentRoot();
  const offline = fileURLToPath(new URL('./fixtures/offline-model.ts', import.meta.url));
  const client = await IsolatedClient.start(root, `goal-report-recovery-${childDelay}`, [], ['--dag-workflow-test-child-provider', offline]);
  t.after(() => client.close());
  const call = async (tool: string, params: object) => {
    const events = await client.prompt(`TEST CALL ${tool} ${JSON.stringify(params)}`);
    const event = events.find((record) => record.type === 'tool_execution_end' && record.toolName === tool)!;
    assert.ok(event && !event.isError, JSON.stringify(event));
    return event.result as any;
  };
  const child = await call('subagent_spawn', { task: `TEST CALL bash ${JSON.stringify({ command: `sleep ${childDelay}; printf RECOVERY-CHILD-RESULT` })}`, tools: ['bash'] });
  await create(client, '报告重试测试');
  await client.prompt('报告重试触发失败');
  await client.until(() => latest(client)?.goals[0]?.status === 'completed', 15000);
  assert.equal((await retries(client)).length, 1);
  const jobs = await call('subagent_inspect', { jobId: child.details.jobId });
  assert.equal(jobs.details.jobs[0].status, 'completed');
  assert.equal(jobs.details.jobs[0].reportDelivery, 'delivered');
});

test('actual Pi: retries stop at the configured limit and pause with the reason', { timeout: 60000 }, async (t) => {
  const root = await agentRoot({ goalErrorRetries: 2 });
  const client = await IsolatedClient.start(root, 'goal-retry-limit');
  t.after(async () => { await client.close(); await rm(root, { recursive: true, force: true }); });
  await create(client, '出错暂停测试');
  await client.until(() => latest(client)?.run.paused === true, 30000);
  const state = latest(client)!;
  assert.equal(state.run.errorRetries, 2);
  assert.match(state.run.reason!, /已重试 2 次/);
  assert.equal((await retries(client)).length, 2, 'exactly the configured budget is spent');
  assert.deepEqual(retryNotifications(client), ['1/2', '2/2']);
});
