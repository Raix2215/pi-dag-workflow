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
  // Native retry stays off unless a case explicitly exercises Pi's own recovery layer.
  await writeFile(join(agent, 'settings.json'), JSON.stringify({ retry }));
  if (config) await writeFile(join(agent, 'pi-dag-workflow', 'pi-dag-workflow-config.json'), JSON.stringify(config));
  return root;
}
const states = (client: IsolatedClient) => client.records
  .filter((record) => record.type === 'entry_appended' && (record.entry as { customType?: string } | undefined)?.customType === GOAL_TYPE)
  .map((record) => (record.entry as { data: GoalState }).data);
const latest = (client: IsolatedClient) => states(client).at(-1);
/** /retry requests are ordinary custom messages; the Goal state no longer counts them. */
const retryRequests = async (client: IsolatedClient) => (await client.entries()).filter((entry) => (entry as { customType?: string }).customType === 'pi-dag-workflow.retry-request');
const retryStates = (client: IsolatedClient) => client.records
  .filter((record) => record.type === 'entry_appended' && (record.entry as { customType?: string } | undefined)?.customType === 'pi-dag-workflow.retry')
  .map((record) => (record.entry as { data: { enabled: boolean; attempts: number; skipped: number; settings?: { count?: number } } }).data);
const retryState = (client: IsolatedClient) => retryStates(client).at(-1);
async function create(client: IsolatedClient, title: string) {
  const events = await client.prompt(`TEST CALL goal ${JSON.stringify({ action: 'create', title })}`);
  assert.ok(events.some((event) => event.type === 'tool_execution_end' && event.toolName === 'goal' && !event.isError), JSON.stringify(events.slice(-3)));
  const events2 = await client.prompt(`TEST CALL goal ${JSON.stringify({ action: 'enable', id: 1 })}`);
  assert.ok(events2.some((event) => event.type === 'tool_execution_end' && event.toolName === 'goal' && !event.isError), JSON.stringify(events2.slice(-3)));
}

test('actual Pi: /retry defaults off, so the first failure pauses instead of retrying', { timeout: 30000 }, async (t) => {
  const client = await IsolatedClient.start(await agentRoot(), 'goal-retry-off'); t.after(() => client.close());
  await create(client, '出错暂停测试');
  await client.until(() => latest(client)?.run.paused === true, 25000);
  assert.match(latest(client)!.run.reason!, /\/retry/);
  assert.equal((await retryRequests(client)).length, 0);
  // The retired Goal counter must not grow again; /retry owns the attempt count.
  assert.equal(latest(client)!.run.errorRetries ?? 0, 0);
});

test('actual Pi: an explicit /retry recovers, then restores the budget after success', { timeout: 45000 }, async (t) => {
  const root = await agentRoot();
  const client = await IsolatedClient.start(root, 'goal-retry-configured');
  t.after(async () => { await client.close(); await rm(root, { recursive: true, force: true }); });
  await client.prompt('/retry when-error 1s count 2');
  await create(client, '出错重试测试');
  // Two scripted failures each earn one /retry request; the third request completes the Goal.
  await client.until(() => latest(client)?.goals[0]?.status === 'completed', 35000);
  assert.equal((await retryRequests(client)).length, 2);
  assert.equal(latest(client)!.run.errorRetries ?? 0, 0, 'a successful recovery clears the Goal compatibility counter');
  assert.ok((latest(client)!.run.used ?? 0) >= 3, 'recovery consumes Goal rounds instead of bypassing the cap');
  assert.equal(retryState(client)?.enabled, true, 'success keeps /retry enabled for the next failure');
  assert.equal(retryState(client)?.attempts, 0, 'success resets the attempt count');
  assert.equal(retryState(client)?.settings?.count, 2);
});

for (const [title, marker] of [['永久故障测试', 'quota'], ['认证故障测试', 'auth']] as const) test(`actual Pi: a ${marker} error is retried up to count, then the Goal pauses`, { timeout: 45000 }, async (t) => {
  const client = await IsolatedClient.start(await agentRoot(), `goal-${marker}-retry`); t.after(() => client.close());
  await client.prompt('/retry when-error 1s count 2');
  await create(client, title);
  await client.until(() => latest(client)?.run.paused === true, 35000);
  assert.match(latest(client)!.run.reason!, /\/retry/);
  assert.equal((await retryRequests(client)).length, 2, 'every configured attempt is a real retry request');
  assert.equal(retryState(client)?.attempts, 2);
  assert.equal(retryState(client)?.settings?.count, 2);
});

test('actual Pi: turning /retry off during a failed Goal leaves it paused without a hidden retry', { timeout: 30000 }, async (t) => {
  const client = await IsolatedClient.start(await agentRoot(), 'goal-retry-off-during-wait'); t.after(() => client.close());
  await client.prompt('/retry when-error 1s count 3'); await create(client, '出错暂停测试');
  await client.prompt('/retry off'); await client.until(() => latest(client)?.run.paused === true);
  await new Promise((resolve) => setTimeout(resolve, 1200));
  assert.equal((await retryRequests(client)).length, 0);
  assert.equal(latest(client)!.run.paused, true); assert.equal(retryState(client)?.enabled, false);
});

test('actual Pi: native retry recovers first without spending a /retry attempt', { timeout: 30000 }, async (t) => {
  const root = await agentRoot(undefined, { enabled: true, maxRetries: 3, baseDelayMs: 1 });
  const client = await IsolatedClient.start(root, 'goal-native-recovery'); t.after(() => client.close());
  await create(client, '出错重试测试');
  await client.until(() => latest(client)?.goals[0]?.status === 'completed');
  assert.equal(client.records.filter((record) => record.type === 'auto_retry_start').length, 2);
  assert.equal((await retryRequests(client)).length, 0);
});

test('actual Pi: turning /retry off while native recovery runs does not pause the Goal', { timeout: 30000 }, async (t) => {
  const root = await agentRoot(undefined, { enabled: true, maxRetries: 3, baseDelayMs: 300 });
  const client = await IsolatedClient.start(root, 'goal-retry-off-native'); t.after(() => client.close());
  await client.prompt('/retry when-error 1s count 3');
  await client.prompt('TEST CALL goal {"action":"create","title":"出错重试测试"}');
  await client.prompt('/goal enable #1');
  await client.until(() => client.records.some((record) => record.type === 'auto_retry_start'));
  await client.prompt('/retry off');
  await client.until(() => latest(client)?.goals[0]?.status === 'completed');
  assert.equal((await retryRequests(client)).length, 0);
  assert.equal(states(client).some((state) => state.run.reason?.includes('/retry')), false, 'off does not cancel Pi native recovery');
});

test('actual Pi: bounded /retry runs only after native retries are exhausted', { timeout: 60000 }, async (t) => {
  const root = await agentRoot(undefined, { enabled: true, maxRetries: 1, baseDelayMs: 1 });
  const client = await IsolatedClient.start(root, 'goal-native-exhausted');
  t.after(async () => { await client.close(); await rm(root, { recursive: true, force: true }); });
  await client.prompt('/retry when-error 1s count 2');
  await create(client, '出错暂停测试');
  await client.until(() => latest(client)?.run.paused === true, 45000);
  // Each plugin retry is itself eligible for one native retry before the next plugin wait.
  assert.equal(client.records.filter((record) => record.type === 'auto_retry_start').length, 3);
  assert.equal((await retryRequests(client)).length, 2);
  assert.match(latest(client)!.run.reason!, /\/retry/);
});

test('actual Pi: reopened /retry cannot restart a Goal completed after its failed request', { timeout: 30000 }, async (t) => {
  const root = await agentRoot(); let client = await IsolatedClient.start(root, 'goal-retry-completed-reopen'); t.after(() => client.close());
  await create(client, '出错暂停测试'); await client.until(() => latest(client)?.run.paused === true);
  await client.prompt('/goal complete #1'); await client.close(false);
  client = await IsolatedClient.start(root, 'goal-retry-completed-reopen');
  await client.prompt('/retry when-error 1s count 1'); await new Promise((resolve) => setTimeout(resolve, 1200));
  assert.equal((await retryRequests(client)).length, 0);
});

test('actual Pi: /retry cannot reset or bypass the Goal round cap', { timeout: 45000 }, async (t) => {
  const root = await agentRoot({ goalMaxTurns: 2 });
  const client = await IsolatedClient.start(root, 'goal-retry-cap');
  t.after(async () => { await client.close(); await rm(root, { recursive: true, force: true }); });
  await client.prompt('/retry when-error 1s count 5');
  const events = await client.prompt(`TEST CALL goal ${JSON.stringify({ action: 'create', title: '出错暂停测试', maxTurns: 2 })}`);
  assert.ok(events.some((event) => event.type === 'tool_execution_end' && event.toolName === 'goal' && !event.isError), JSON.stringify(events.slice(-3)));
  const events2 = await client.prompt(`TEST CALL goal ${JSON.stringify({ action: 'enable', id: 1 })}`);
  assert.ok(events2.some((event) => event.type === 'tool_execution_end' && event.toolName === 'goal' && !event.isError), JSON.stringify(events2.slice(-3)));
  await client.until(() => latest(client)?.run.paused === true, 35000);
  assert.match(latest(client)!.run.reason!, /上限/);
  assert.ok((latest(client)!.run.used ?? 0) <= 2);
  assert.ok((await retryRequests(client)).length <= 2, 'the Goal cap stops retries before the /retry count');
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
  await client.prompt('/retry when-error 1s count 1');
  await create(client, '报告重试测试');
  await client.prompt('报告重试触发失败');
  await client.until(() => latest(client)?.goals[0]?.status === 'completed', 20000);
  assert.equal((await retryRequests(client)).length, 1);
  const jobs = await call('subagent_inspect', { jobId: child.details.jobId });
  assert.equal(jobs.details.jobs[0].status, 'completed');
  assert.equal(jobs.details.jobs[0].reportDelivery, 'delivered');
});
