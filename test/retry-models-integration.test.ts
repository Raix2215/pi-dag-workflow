import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { IsolatedClient } from './fixtures/isolated-client.ts';
import { GOAL_TYPE } from '../src/goal/state.ts';
import { RETRY_MESSAGE, RETRY_TYPE } from '../src/retry/state.ts';

async function clientFor(extra: string[] = [], language = 'zh-CN') {
  const root = await mkdtemp(join(tmpdir(), 'dag-model-fallback-')); await mkdir(join(root, 'agent')); await writeFile(join(root, 'agent', 'settings.json'), JSON.stringify({ retry: { enabled: false } }));
  return IsolatedClient.start(root, 'retry-fallback', extra, ['--dag-test-retry-failures', '100', '--dag-test-context-export'], false, undefined, language);
}
async function confirm(client: IsolatedClient, text: string) {
  const mark = client.records.length, running = client.prompt(text); await client.until(() => client.records.slice(mark).some((record) => record.method === 'confirm'));
  const dialog = client.records.slice(mark).find((record) => record.method === 'confirm')!; assert.match(String(dialog.message), /current context|当前上下文/);
  client.child.stdin.write(`${JSON.stringify({ type: 'extension_ui_response', id: dialog.id, confirmed: true })}\n`); await running;
}
async function configure(client: IsolatedClient) { await confirm(client, '/retry models dag-test/reasoned'); await confirm(client, '/retry models after 1'); await client.prompt('/retry when-error 1s'); }
const retryState = (client: IsolatedClient) => client.records.filter((record) => record.type === 'entry_appended' && (record.entry as any)?.customType === RETRY_TYPE).map((record) => (record.entry as any).data).at(-1);
const selected = async (client: IsolatedClient) => ((await client.send('get_state')).data as any).model.id;

for (const language of ['zh-CN', 'en']) test(`actual Pi: fallback switches the session, exhausts candidates and persists no global model default (${language})`, { timeout: 30000 }, async (t) => {
  const client = await clientFor([], language); t.after(() => client.close()); await configure(client); await client.prompt('RETRY-TEST model fallback');
  await client.until(() => client.records.some((record) => record.method === 'notify' && /candidates exhausted|候选已用完/.test(String(record.message))));
  assert.equal(retryState(client).attempts, 2); assert.equal(await selected(client), 'reasoned');
  const entries = await client.entries() as any[]; assert.equal(entries.filter((entry) => entry.customType === RETRY_MESSAGE).length, 2);
  const messages = entries.filter((entry) => entry.type === 'message' && entry.message.role === 'assistant' && entry.message.stopReason === 'error'); assert.deepEqual(messages.map((entry) => entry.message.model), ['scripted', 'scripted', 'reasoned']);
  const { readFile } = await import('node:fs/promises'); const settings = JSON.parse(await readFile(join(client.root, 'agent', 'settings.json'), 'utf8')); assert.equal(settings.defaultModel, undefined); assert.equal(settings.defaultProvider, undefined);
  await client.prompt('/retry off'); assert.equal(await selected(client), 'reasoned', 'ordinary off does not switch back'); assert.equal(client.records.some((record) => record.type === 'extension_error'), false);
});

test('actual Pi: autoresearch does not override candidate exhaustion or restart the failed chain', { timeout: 30000 }, async (t) => {
  const client = await clientFor(); t.after(() => client.close()); await client.prompt('TEST CALL goal {"action":"create","title":"出错暂停测试","maxTurns":1}');
  const mark = client.records.length, configuring = client.prompt('/goal autoresearch #1'); await client.until(() => client.records.slice(mark).some((record) => record.method === 'select'));
  const menu = client.records.slice(mark).find((record) => record.method === 'select')!; client.child.stdin.write(`${JSON.stringify({ type: 'extension_ui_response', id: menu.id, value: (menu.options as string[])[1] })}\n`); await configuring;
  await configure(client); await client.prompt('/goal enable #1'); await client.until(() => client.records.some((record) => record.method === 'notify' && String(record.message).includes('候选已用完')));
  const entries = await client.entries() as any[], goal = entries.findLast((entry) => entry.customType === GOAL_TYPE).data;
  assert.equal(goal.goals[0].autoresearch, true); assert.notEqual(goal.goals[0].status, 'completed'); assert.equal(goal.run.paused, true); assert.equal(goal.run.used, 3); assert.equal(retryState(client).attempts, 2); assert.equal(await selected(client), 'reasoned');
  await client.prompt('/retry status'); assert.equal(retryState(client).attempts, 2); assert.equal(client.records.some((record) => record.type === 'extension_error'), false);
});

test('actual Pi: changing Goal mode during an error wait cancels recovery and leaves an explicit paused state', { timeout: 30000 }, async (t) => {
  const client = await clientFor(); t.after(() => client.close()); await client.prompt('TEST CALL goal {"action":"create","title":"出错暂停测试","maxTurns":6}'); await configure(client);
  await client.prompt('/goal enable #1'); await client.until(() => retryState(client)?.failure !== undefined);
  const before = (await client.entries() as any[]).findLast((entry) => entry.customType === GOAL_TYPE).data;
  const mark = client.records.length, configuring = client.prompt('/goal autoresearch #1'); await client.until(() => client.records.slice(mark).some((record) => record.method === 'select'));
  const menu = client.records.slice(mark).find((record) => record.method === 'select')!; client.child.stdin.write(`${JSON.stringify({ type: 'extension_ui_response', id: menu.id, value: (menu.options as string[])[1] })}\n`); await configuring;
  const entries = await client.entries() as any[], after = entries.findLast((entry) => entry.customType === GOAL_TYPE).data;
  assert.equal(after.goals[0].autoresearch, true); assert.equal(after.run.used, before.run.used); assert.equal(after.run.paused, true, 'scope invalidation must not leave a running Goal with a stranded error hold');
  assert.equal(entries.filter((entry) => entry.customType === RETRY_MESSAGE).length, 0); await client.prompt('/retry off');
});

test('actual Pi: off during a slow model-select observer cancels the request and restores only this session selection', { timeout: 30000 }, async (t) => {
  const delay = new URL('./fixtures/retry-model-delay.ts', import.meta.url).pathname, client = await clientFor([delay]); t.after(() => client.close()); await configure(client); await client.prompt('RETRY-TEST slow switch');
  await client.until(() => client.records.some((record) => record.method === 'notify' && record.message === 'Synthetic slow model selection entered')); await client.prompt('/retry off');
  await client.until(() => client.records.some((record) => record.type === 'response' && record.command === 'prompt') && retryState(client).enabled === false);
  const deadline = Date.now() + 3000; while (await selected(client) !== 'scripted') { assert.ok(Date.now() < deadline); await new Promise((resolve) => setTimeout(resolve, 30)); }
  const entries = await client.entries() as any[]; assert.equal(entries.filter((entry) => entry.customType === RETRY_MESSAGE).length, 1); assert.equal(retryState(client).attempts, 1); assert.equal(retryState(client).enabled, false); assert.equal(client.records.some((record) => record.type === 'extension_error'), false);
});
