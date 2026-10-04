import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { IsolatedClient } from './fixtures/isolated-client.ts';
import { STATE_TYPE } from '../src/todos/state.ts';
import { GOAL_TYPE } from '../src/goal/state.ts';

const offline = fileURLToPath(new URL('./fixtures/offline-model.ts', import.meta.url));
const tools = async (client: IsolatedClient, name: string, params: object) => {
  const result = await client.prompt(`TEST CALL ${name} ${JSON.stringify(params)}`);
  return result.find((event) => event.type === 'tool_execution_end' && event.toolName === name)!;
};
const notifications = (records: any[]) => records.filter((record) => record.method === 'notify').map((record) => String(record.message)).join('\n');

async function answer(client: IsolatedClient, record: any, value: string | boolean) {
  client.child.stdin.write(`${JSON.stringify({ type: 'extension_ui_response', id: record.id, ...(typeof value === 'boolean' ? { confirmed: value } : { value }) })}\n`);
}

test('real Pi: list/dag commands persist filters only for previews and full views do not truncate', { timeout: 30000 }, async (t) => {
  const client = await IsolatedClient.start(); t.after(() => client.close());
  for (let id = 1; id <= 12; id++) {
    await tools(client, 'todo', { action: 'create', subject: `row-${id}` });
    await tools(client, 'todo', { action: 'update', id, status: 'completed' });
  }
  await tools(client, 'todo', { action: 'create', subject: 'failed-row' });
  await client.prompt('/todos failed #13');
  await client.prompt('/todos view dag completed');
  let state = (await client.entries() as any[]).findLast((entry) => entry.customType === STATE_TYPE).data;
  assert.equal(state.view, 'dag'); assert.equal(state.filter, 'completed');
  const full = notifications(await client.prompt('/todos list completed'));
  assert.ok(full.includes('#1 ') && full.includes('#12 ')); assert.doesNotMatch(full, /隐藏 \d+ 项/);
  const failed = notifications(await client.prompt('/dag failed'));
  assert.match(failed, /failed-row/); assert.doesNotMatch(failed, /row-12/);
  state = (await client.entries() as any[]).findLast((entry) => entry.customType === STATE_TYPE).data;
  assert.equal(state.filter, 'completed', 'one-off full views never change the preview filter');
  const before = JSON.stringify(state);
  await client.prompt('/todos view dag invalid'); await client.prompt('/dag failed extra');
  assert.equal(JSON.stringify((await client.entries() as any[]).findLast((entry) => entry.customType === STATE_TYPE).data), before);
});

test('real Pi: cleanup menus do not pause, wake or refill an active Goal and do not stop its child', { timeout: 30000 }, async (t) => {
  const client = await IsolatedClient.start(undefined, 'cleanup-menu-goal', [], ['--dag-workflow-test-child-provider', offline]);
  t.after(() => client.close());
  await tools(client, 'todo', { action: 'create', subject: 'finished history' });
  await tools(client, 'todo', { action: 'update', id: 1, status: 'completed' });
  await tools(client, 'goal', { action: 'create', title: '空闲续跑测试', maxTurns: 6 });
  await client.prompt('/goal enable #1');
  await client.until(() => client.records.filter((record) => record.type === 'agent_settled').length >= 4);
  const before = (await client.entries() as any[]).findLast((entry) => entry.customType === GOAL_TYPE).data;
  assert.equal(before.run.paused, false);
  const offset = client.records.length;
  const clearing = client.prompt('/todos clear');
  await client.until(() => client.records.slice(offset).some((record) => record.method === 'select'));
  const menu = client.records.slice(offset).find((record) => record.method === 'select')!;
  await answer(client, menu, (menu.options as string[])[0]!);
  await client.until(() => client.records.slice(offset).some((record) => record.method === 'confirm'));
  const confirm = client.records.slice(offset).find((record) => record.method === 'confirm')!;
  await answer(client, confirm, true); await clearing;
  const entries = await client.entries() as any[];
  const after = entries.findLast((entry) => entry.customType === GOAL_TYPE).data;
  assert.deepEqual(after.run, before.run);
  assert.equal(entries.findLast((entry) => entry.customType === STATE_TYPE).data.tasks.length, 0);
  assert.equal(client.records.slice(offset).some((record) => record.type === 'agent_start'), false);
  assert.ok(entries.findLast((entry) => entry.customType === 'pi-dag-workflow.agents').data.jobs.some((job: any) => job.status === 'running'));
});

test('real Pi: inspect defaults to short profiles and explicit profiles:true retains instructions', { timeout: 30000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dag-inspection-profile-'));
  await mkdir(join(root, 'agent', 'pi-dag-workflow'), { recursive: true });
  await writeFile(join(root, 'agent', 'pi-dag-workflow', 'pi-dag-workflow-profile.json'), JSON.stringify({ profiles: [{ name: 'probe', thinking: 'off', tools: ['read'], instructions: 'PROFILE-LONG-INSTRUCTIONS '.repeat(30) }] }));
  const client = await IsolatedClient.start(root, 'inspection-profile', [], ['--dag-workflow-test-child-provider', offline]); t.after(() => client.close());
  const short = (await tools(client, 'subagent_inspect', {})).result as any;
  assert.equal(short.details.profiles[0].name, 'probe'); assert.equal(short.details.profiles[0].instructions, undefined);
  assert.equal(short.details.profilePath, undefined);
  const full = (await tools(client, 'subagent_inspect', { profiles: true })).result as any;
  assert.match(full.details.profiles[0].instructions, /PROFILE-LONG-INSTRUCTIONS/);
  const spawned = (await tools(client, 'subagent_spawn', { task: 'HOLD-IDLE-ENABLE-CHILD' })).result as any;
  const info = (await tools(client, 'subagent_inspect', { jobId: spawned.details.jobId })).result as any;
  assert.equal(info.details.profiles, undefined); assert.ok(info.details.jobs[0].lastEventAt > 0);
  assert.ok(info.details.jobs[0].reportVersion >= 0); assert.equal(typeof info.details.jobs[0].hasOutput, 'boolean');
});
