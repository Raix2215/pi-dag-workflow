import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { IsolatedClient } from './fixtures/isolated-client.ts';
import { GOAL_TYPE, type GoalState } from '../src/goal/state.ts';

/** Isolated Pi with a scripted provider: no network, no credentials, deterministic failures. */
async function agentRoot(config?: object): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'pi-dag-retry-'));
  const agent = join(root, 'agent');
  await mkdir(join(agent, 'pi-dag-workflow'), { recursive: true });
  // Pi's own auto-retry is exercised elsewhere; these tests isolate the plugin's recovery layer.
  await writeFile(join(agent, 'settings.json'), JSON.stringify({ retry: { enabled: false } }));
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
  await client.until(() => latest(client)?.run.errorRetries === 2, 30000);
  assert.equal(latest(client)!.run.paused, false, 'a recoverable failure must not pause the goal');
  // Each retry announces itself; the notifications arrive on the RPC stream beside the state entries.
  await client.until(() => retryNotifications(client).length === 2, 20000);
  assert.deepEqual(retryNotifications(client), ['1/5', '2/5']);
  // The third request succeeds, so the budget is restored for the next failure.
  await client.until(() => latest(client)?.run.errorRetries === 0, 30000);
  assert.equal(latest(client)!.run.paused, false);
  assert.equal((await retries(client)).length, 2);
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
