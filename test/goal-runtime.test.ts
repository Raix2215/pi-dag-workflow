import { GOAL_TYPE, type GoalState } from './fixtures/public-records.ts';
import assert from "node:assert/strict";
import { test } from "node:test";

import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { IsolatedClient } from "./fixtures/isolated-client.ts";
import { GOAL_RETRY_MESSAGE, RETRY_REQUEST_MESSAGE } from './fixtures/public-records.ts';


{
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
const retryRequests = async (client: IsolatedClient) => (await client.entries()).filter((entry) => (entry as { customType?: string }).customType === RETRY_REQUEST_MESSAGE);
async function create(client: IsolatedClient, title: string) {
  const events = await client.prompt(`TEST CALL goal ${JSON.stringify({ action: 'create', title })}`);
  assert.ok(events.some((event) => event.type === 'tool_execution_end' && event.toolName === 'goal' && !event.isError), JSON.stringify(events.slice(-3)));
  const events2 = await client.prompt(`TEST CALL goal ${JSON.stringify({ action: 'enable', id: 1 })}`);
  assert.ok(events2.some((event) => event.type === 'tool_execution_end' && event.toolName === 'goal' && !event.isError), JSON.stringify(events2.slice(-3)));
}

test('actual Pi: /retry defaults off, so the first failure pauses instead of retrying', { timeout: 45000 }, async (t) => {
  const client = await IsolatedClient.start(await agentRoot(), 'goal-retry-off'); t.after(() => client.close());
  await create(client, '出错暂停测试');
  await client.until(() => latest(client)?.run.paused === true, 40000);
  assert.match(latest(client)!.run.reason!, /次数已用完/);
  assert.equal((await retryRequests(client)).length, 0);
  assert.equal(latest(client)!.run.errorRetries, 5);
  assert.equal((await client.entries()).filter(entry => (entry as any).customType === GOAL_RETRY_MESSAGE).length, 5);
});
}
