import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { IsolatedClient, type RpcRecord } from './fixtures/isolated-client.ts';

async function menuDriver(client: IsolatedClient) {
  let at = client.records.length;
  const next = async (method: string, title: RegExp) => {
    const matches = (record: RpcRecord) => record.type === 'extension_ui_request' && record.method === method && typeof record.id === 'string';
    await client.until(() => client.records.slice(at).some(matches));
    const index = client.records.findIndex((record, i) => i >= at && matches(record)); const record = client.records[index]!; at = index + 1;
    assert.match(String(record.title), title); return record;
  };
  const answer = (record: RpcRecord, response: object) => { client.child.stdin.write(`${JSON.stringify({ type: 'extension_ui_response', id: record.id, ...response })}\n`); };
  return { next, answer, choose: async (title: RegExp, value?: string) => { const record = await next('select', title); if (value !== undefined) assert.ok((record.options as string[]).includes(value), `${value} in ${JSON.stringify(record.options)}`); answer(record, value === undefined ? { cancelled: true } : { value }); return record; } };
}
const state = (client: IsolatedClient) => client.records.filter((record) => record.type === 'entry_appended' && (record.entry as any)?.customType === 'pi-dag-workflow.retry').map((record) => (record.entry as any).data).at(-1);
const call = async (client: IsolatedClient, name: string, args: object) => {
  const events = await client.prompt(`TEST CALL ${name} ${JSON.stringify(args)}`);
  const result = events.find((record) => record.type === 'tool_execution_end' && record.toolName === name)!;
  assert.ok(result); assert.equal(result.isError, false, JSON.stringify(result.result)); return result.result as any;
};

test('actual Pi RPC: menu back/status/invalid correction/empty count/toggle all preserve navigation', { timeout: 30000 }, async (t) => {
  const client = await IsolatedClient.start(undefined, 'retry-menu-rpc'); t.after(() => client.close());
  await client.prompt('/retry when-error 5m count 3');
  const driver = await menuDriver(client); const opening = client.prompt('/retry');
  await driver.choose(/重试恢复/, '重试设置'); await driver.choose(/^重试设置$/, '返回');
  await driver.choose(/重试恢复/, '查看状态'); await driver.choose(/^查看状态/, '返回');
  await driver.choose(/重试恢复/, '重试设置'); await driver.choose(/^重试设置$/, '修改间隔');
  const first = await driver.next('editor', /错误后等待/); assert.equal(first.prefill, '5m'); driver.answer(first, { value: 'bad interval' });
  const second = await driver.next('editor', /错误后等待/); assert.equal(second.prefill, 'bad interval'); driver.answer(second, { value: '3m,4m' });
  driver.answer(await driver.next('confirm', /确认重试设置/), { confirmed: true });
  await driver.choose(/重试恢复.*3m,4m/, '重试设置'); await driver.choose(/^重试设置$/, '修改次数');
  const count = await driver.next('editor', /每轮最多/); assert.equal(count.prefill, '3'); driver.answer(count, { value: '' });
  driver.answer(await driver.next('confirm', /确认重试设置/), { confirmed: true });
  await driver.choose(/重试恢复/, '关闭自动重试'); await driver.choose(/重试恢复/, '开启自动重试');
  driver.answer(await driver.next('confirm', /确认重试设置/), { confirmed: true });
  await driver.choose(/重试恢复/, '退出菜单'); await opening;
  assert.equal(state(client).enabled, true); assert.equal(state(client).settings.count, undefined); assert.deepEqual(state(client).settings.intervals, [180000, 240000]);
  assert.equal(client.records.some((record) => record.type === 'extension_error'), false);
  assert.equal(client.records.filter((record) => record.type === 'agent_start').length, 0, 'menu interactions never run the model');
});

test('actual Pi RPC: an open menu skips a due retry and closing it does not queue an immediate request', { timeout: 30000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dag-menu-timer-')); await mkdir(join(root, 'agent'));
  await writeFile(join(root, 'agent', 'settings.json'), JSON.stringify({ retry: { enabled: false } }));
  const client = await IsolatedClient.start(root, 'retry-menu-timer', [], ['--dag-test-retry-failures', '100']); t.after(() => client.close());
  await client.prompt('/retry when-error 1s count 1'); await client.prompt('RETRY-TEST menu timing');
  const driver = await menuDriver(client); const opening = client.prompt('/retry');
  const rootDialog = await driver.next('select', /重试恢复/);
  await client.until(() => state(client)?.skipped >= 1, 5000); assert.equal(state(client).attempts, 0);
  driver.answer(rootDialog, { value: '退出菜单' }); await opening;
  assert.equal(state(client).attempts, 0, 'closing the menu does not issue an immediate model request');
  await client.until(() => state(client)?.attempts === 1, 5000); await client.until(() => client.records.filter((record) => record.type === 'agent_settled').length >= 2, 5000);
  await client.prompt('/retry off'); assert.equal(state(client).attempts, 1); assert.equal(state(client).enabled, false);
  const requests = (await client.entries()).filter((entry: any) => entry.customType === 'pi-dag-workflow.retry-request'); assert.equal(requests.length, 1);
});

test('actual Pi RPC: off wins over an already pending first-enable confirmation', { timeout: 30000 }, async (t) => {
  const client = await IsolatedClient.start(undefined, 'retry-menu-off-wins'); t.after(() => client.close());
  const driver = await menuDriver(client), opening = client.prompt('/retry');
  await driver.choose(/重试恢复/, '开启自动重试'); driver.answer(await driver.next('editor', /错误后等待/), { value: '1s' });
  const old = await driver.next('confirm', /确认重试设置/); await client.prompt('/retry off'); driver.answer(old, { confirmed: true });
  await driver.choose(/重试恢复/, '退出菜单'); await opening;
  const status = (await call(client, 'todo', { action: 'status' })).details.status.retry;
  assert.equal(status.enabled, false); assert.equal(status.intervals, undefined); assert.equal(status.attempts, 0);
  assert.equal(client.records.some((record) => record.type === 'extension_error'), false);
});

test('actual Pi RPC: reload discards an old pending confirmation and permits a fresh menu', { timeout: 30000 }, async (t) => {
  const controls = fileURLToPath(new URL('./fixtures/session-controls.ts', import.meta.url));
  const client = await IsolatedClient.start(undefined, 'retry-menu-reload', [controls]); t.after(() => client.close());
  await client.prompt('/retry when-error 5m count 2');
  const driver = await menuDriver(client); const opening = client.prompt('/retry');
  await driver.choose(/重试恢复/, '重试设置'); await driver.choose(/^重试设置$/, '修改间隔');
  driver.answer(await driver.next('editor', /错误后等待/), { value: '2s' }); const old = await driver.next('confirm', /确认重试设置/);
  await client.prompt('/test-reload'); driver.answer(old, { confirmed: true }); await opening;
  const status = (await call(client, 'todo', { action: 'status' })).details.status.retry;
  assert.equal(status.intervals, '5m'); assert.equal(status.enabled, false);
  const fresh = await menuDriver(client); const menu = client.prompt('/retry'); await fresh.choose(/重试恢复/, '退出菜单'); await menu;
  assert.equal(client.records.some((record) => record.type === 'extension_error'), false);
});

test('actual Pi RPC: retry dialogs do not pause a Goal; foreign dialogs do pause it in either load order', { timeout: 30000 }, async () => {
  const fixture = fileURLToPath(new URL('./fixtures/retry-menu-dialog.ts', import.meta.url));
  const root = fileURLToPath(new URL('../', import.meta.url));
  for (const order of [['todos', 'goal'], ['goal', 'todos']]) {
    const client = await IsolatedClient.start(undefined, `retry-menu-goal-${order[0]}`, [fixture], [], false, order.map((feature) => `${root}src/${feature}/index.ts`));
    try {
      await call(client, 'goal', { action: 'create', title: 'Synthetic menu Goal', maxTurns: 1 });
      await client.prompt('/retry when-error 3m count 1');
      const driver = await menuDriver(client); const opening = client.prompt('/retry');
      await driver.choose(/重试恢复/, '重试设置'); await driver.choose(/^重试设置$/, '修改间隔');
      driver.answer(await driver.next('editor', /错误后等待/), { value: '4m' }); driver.answer(await driver.next('confirm', /确认重试设置/), { confirmed: true });
      await driver.choose(/重试恢复/, '退出菜单'); await opening;
      const noPause = client.records.filter((record) => record.method === 'notify').every((record) => !String(record.message).includes('等待用户答复')); assert.ok(noPause);
      const foreign = await menuDriver(client); const work = client.prompt('TEST CALL test_goal_dialog {}');
      foreign.answer(await foreign.next('input', /^Foreign dialog$/), { value: 'done' }); await work;
      const paused = client.records.filter((record) => record.method === 'notify').some((record) => String(record.message).includes('等待用户答复')); assert.ok(paused, order.join(','));
      assert.equal(client.records.some((record) => record.type === 'extension_error'), false);
    } finally { await client.close(); }
  }
});
