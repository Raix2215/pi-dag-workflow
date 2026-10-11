import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { IsolatedClient } from './fixtures/isolated-client.ts';
import { STATE_TYPE, type WorkflowState } from '../src/todos/state.ts';

/** Offline session-level /retry: no Goal module involvement, no network or credentials. */
async function agentRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'pi-dag-retry-session-'));
  await mkdir(join(root, 'agent'), { recursive: true });
  await writeFile(join(root, 'agent', 'settings.json'), JSON.stringify({ retry: { enabled: false } }));
  return root;
}
const start = (root: string, session: string, failures: number) => IsolatedClient.start(root, session, [], ['--dag-test-retry-failures', String(failures)]);
const retryRequests = async (client: IsolatedClient) => (await client.entries()).filter((entry) => (entry as { customType?: string }).customType === 'pi-dag-workflow.retry-request');
const retryStates = (client: IsolatedClient) => client.records
  .filter((record) => record.type === 'entry_appended' && (record.entry as { customType?: string } | undefined)?.customType === 'pi-dag-workflow.retry')
  .map((record) => (record.entry as { data: { enabled: boolean; attempts: number; skipped: number; settings?: { count?: number } } }).data);
const retryState = (client: IsolatedClient) => retryStates(client).at(-1);
const workflow = (client: IsolatedClient) => client.records
  .filter((record) => record.type === 'entry_appended' && (record.entry as { customType?: string } | undefined)?.customType === STATE_TYPE)
  .map((record) => (record.entry as { data: WorkflowState }).data).at(-1);

test('actual Pi: /retry recovers ordinary work without any Goal', { timeout: 30000 }, async (t) => {
  const root = await agentRoot();
  const client = await start(root, 'retry-normal', 2); t.after(async () => { await client.close(); await rm(root, { recursive: true, force: true }); });
  await client.prompt('/retry when-error 1s count 2');
  await client.prompt('RETRY-TEST normal');
  await client.until(() => retryStates(client).some((state) => state.attempts === 2), 20000);
  await client.until(() => retryState(client)?.attempts === 0, 20000);
  assert.equal((await retryRequests(client)).length, 2);
  assert.equal(retryState(client)?.enabled, true, 'success keeps the session setting on');
  assert.equal(retryState(client)?.settings?.count, 2);
});

test('actual Pi: /retry recovers in Plan mode without unlocking its read-only policy', { timeout: 30000 }, async (t) => {
  const root = await agentRoot();
  const client = await start(root, 'retry-plan', 1); t.after(async () => { await client.close(); await rm(root, { recursive: true, force: true }); });
  await client.prompt('/plan start');
  await client.prompt('/retry when-error 1s count 1');
  await client.prompt('RETRY-TEST plan');
  await client.until(() => retryStates(client).some((state) => state.attempts === 1), 20000);
  await client.until(() => retryState(client)?.attempts === 0, 20000);
  assert.equal((await retryRequests(client)).length, 1);
  assert.equal(workflow(client)?.plan, true, 'recovery keeps Plan read-only');
});

test('actual Pi: retry status is readable without granting a model edit parameter or running a request', { timeout: 30000 }, async (t) => {
  const root = await agentRoot(); const client = await start(root, 'retry-read-status', 0); t.after(() => client.close());
  await client.prompt('/retry when-error 3m,4m count 3');
  const notifications = await client.prompt('/retry status');
  assert.equal(notifications.some((record) => record.type === 'agent_start'), false);
  const events = await client.prompt('TEST CALL todo {"action":"status"}');
  const result = events.find((record) => record.type === 'tool_execution_end' && record.toolName === 'todo')!.result as any;
  const status = JSON.parse(result.content[0].text);
  assert.equal(status.retry.enabled, true); assert.equal(status.retry.intervals, '3m,4m'); assert.equal(status.retry.count, 3);
  assert.equal(status.mode, 'normal'); assert.equal('tasks' in result.details, false);
  const mark = retryStates(client).length;
  await client.prompt('TEST CALL todo {"action":"status","intervals":"1s"}');
  assert.equal(retryStates(client).length, mark, 'rejected extra arguments cannot change the policy');
});

test('actual Pi: reload cancels pending recovery and retains settings in the branch', { timeout: 30000 }, async (t) => {
  const root = await agentRoot();
  const controls = fileURLToPath(new URL('./fixtures/session-controls.ts', import.meta.url));
  const client = await IsolatedClient.start(root, 'retry-reload', [controls], ['--dag-test-retry-failures', '100']); t.after(() => client.close());
  await client.prompt('/retry when-error 1s count 3'); await client.prompt('RETRY-TEST reload');
  await client.prompt('/test-reload'); await new Promise((resolve) => setTimeout(resolve, 1200));
  assert.equal((await retryRequests(client)).length, 0);
  const result = await client.prompt('/retry status');
  const status = JSON.parse(String(result.findLast((record) => record.method === 'notify')!.message));
  assert.equal(status.enabled, false); assert.equal(status.intervals, '1s'); assert.equal(status.count, 3);
  assert.equal(client.records.some((record) => record.type === 'extension_error'), false);
});

test('actual Pi: slow settled callbacks cannot queue a retry ahead of user off', { timeout: 30000 }, async (t) => {
  const root = await agentRoot();
  const observer = fileURLToPath(new URL('./fixtures/retry-slow-settled.ts', import.meta.url));
  const client = await IsolatedClient.start(root, 'retry-slow-settled', [observer], ['--dag-test-retry-failures', '100']); t.after(() => client.close());
  await client.prompt('/retry when-error 1s count 3');
  await client.send('prompt', { message: 'RETRY-TEST slow settled' });
  const observations = () => client.records.filter((record) => record.type === 'entry_appended' && (record.entry as any)?.customType === 'dag-test.slow-settled').map((record) => (record.entry as any).data);
  await client.until(() => observations().some((item) => item.stage === 'waiting'));
  assert.equal(observations()[0].idle, true, 'this is the gap ordinary idle tests miss');
  await new Promise((resolve) => setTimeout(resolve, 1200));
  await client.send('prompt', { message: '/retry off' });
  await client.until(() => retryState(client)?.enabled === false);
  await new Promise((resolve) => setTimeout(resolve, 1200));
  assert.equal((await retryRequests(client)).length, 0, 'the deferred command may skip, but never queues a model request');
  assert.equal(retryStates(client).some((state) => state.skipped === 1), true);
  assert.equal(retryStates(client).some((state) => state.attempts > 0), false);
  assert.equal(client.records.some((record) => record.type === 'extension_error'), false);
});

test('actual Pi: /retry off cancels an unbounded pending recovery', { timeout: 30000 }, async (t) => {
  const root = await agentRoot();
  const client = await start(root, 'retry-cancel', 100); t.after(async () => { await client.close(); await rm(root, { recursive: true, force: true }); });
  await client.prompt('/retry when-error 1s');
  await client.prompt('RETRY-TEST cancel'); // The failure settles and one retry is pending on the 1s timer.
  await client.prompt('/retry off');
  await new Promise((resolve) => setTimeout(resolve, 1600));
  assert.equal((await retryRequests(client)).length, 0, 'no retry may fire after off');
  assert.equal(retryState(client)?.enabled, false);
  assert.equal(retryState(client)?.settings?.count, undefined, 'the interval list stays persisted for the next enable');
});
