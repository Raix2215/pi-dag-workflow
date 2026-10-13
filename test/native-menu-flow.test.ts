import assert from 'node:assert/strict';
import { test } from 'node:test';
import { IsolatedClient, type RpcRecord } from './fixtures/isolated-client.ts';

const widgetKey = 'pi-dag-workflow.todos';
async function call(client: IsolatedClient, name: string, args: object) {
  const events = await client.prompt(`TEST CALL ${name} ${JSON.stringify(args)}`);
  const record = events.find(event => event.type === 'tool_execution_end' && event.toolName === name)!;
  assert.ok(record); assert.equal(record.isError, false); return (record.result as any).details;
}
function driver(client: IsolatedClient) {
  let at = client.records.length;
  return async (word?: string) => {
    await client.until(() => client.records.slice(at).some(record => record.method === 'select'));
    const index = client.records.findIndex((record, i) => i >= at && record.method === 'select'); const record = client.records[index]!; at = index + 1;
    if (word !== undefined) { const value = (record.options as string[]).find(value => value.includes(word)); assert.ok(value, word); client.child.stdin.write(JSON.stringify({ type: 'extension_ui_response', id: record.id, value }) + '\n'); }
    else client.child.stdin.write(JSON.stringify({ type: 'extension_ui_response', id: record.id, cancelled: true }) + '\n');
    return record;
  };
}
const latestWidget = (client: IsolatedClient): RpcRecord | undefined => client.records.filter(record => record.method === 'setWidget' && record.widgetKey === widgetKey).at(-1);

test('native Goal menu withdraws all own preview across nested pages and restores it without a state mutation', async t => {
  const client = await IsolatedClient.start(); t.after(() => client.close());
  const scope = ('Historical verification scope: ' + 'preserve complete requirements and evidence. '.repeat(50)).trim();
  await call(client, 'todo', { action: 'create', subject: 'Actual preview must not remain in the menu' });
  await call(client, 'goal', { action: 'create', title: 'Historical objective', description: scope });
  await call(client, 'goal', { action: 'complete', id: 1 });
  const requests = client.records.filter(record => record.type === 'agent_start').length;
  const choose = driver(client), opening = client.prompt('/goal');
  const directory = await choose('Historical objective');
  assert.doesNotMatch(String(directory.title), /Historical verification scope|preserve complete requirements/);
  assert.equal(latestWidget(client)?.widgetLines, undefined);
  const action = await choose('查看范围与进展'); assert.doesNotMatch(String(action.title), /Historical verification scope/);
  await client.until(() => client.records.some(record => record.method === 'notify' && String(record.message).includes(scope)));
  assert.equal(latestWidget(client)?.widgetLines, undefined, 'reading selected complete content remains within the same command scope');
  await choose(); assert.equal(latestWidget(client)?.widgetLines, undefined, 'back to directory does not restore preview yet');
  await choose(); await opening;
  assert.ok(JSON.stringify(latestWidget(client)?.widgetLines).includes('Actual preview must not remain'));
  const restored = await call(client, 'goal', { action: 'get', id: 1 }); assert.equal(restored.goalState.goals[0].description, scope); assert.equal(restored.goalState.goals[0].status, 'completed');
  assert.equal(client.records.filter(record => record.type === 'agent_start').length, requests + 1, 'only explicit final tool verification ran the scripted provider');
});

test('native standard settings protect Plan state and restore preview after Escape', async t => {
  const client = await IsolatedClient.start(); t.after(() => client.close());
  await call(client, 'todo', { action: 'create', subject: 'Preview after native Plan settings' });
  const choose = driver(client), opening = client.prompt('/plan settings'); const menu = await choose(); await opening;
  assert.match(String(menu.title), /Plan 设置/); assert.ok(JSON.stringify(latestWidget(client)?.widgetLines).includes('Preview after native Plan settings'));
  assert.equal((await call(client, 'todo', { action: 'status' })).status.mode, 'normal');
});
