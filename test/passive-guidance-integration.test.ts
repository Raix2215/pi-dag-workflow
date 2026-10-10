import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { IsolatedClient } from './fixtures/isolated-client.ts';
import { GOAL_CHECKPOINT_TYPE } from '../src/goal/prompt.ts';

const text = (message: any) => typeof message.content === 'string' ? message.content : (message.content ?? []).filter((part: any) => part.type === 'text').map((part: any) => part.text).join('\n');
const exportsOf = (entries: any[]) => entries.filter((entry) => entry.customType === 'dag-test.context-export').map((entry) => entry.data.context.messages);
const systems = (messages: any[]) => messages.filter((message) => message.role === 'system').map(({ timestamp: _timestamp, ...message }) => message);

test('actual Pi: mode changes use passive messages and leave the native system prompt/loadout stable', { timeout: 30000 }, async (t) => {
  const client = await IsolatedClient.start(undefined, 'stable-mode-guidance', [], ['--dag-test-context-export']); t.after(() => client.close());
  await client.prompt('stable Normal one');
  await client.prompt('stable Normal two');
  await client.prompt('/plan start'); await client.prompt('read-only request');
  await client.prompt('/plan off'); await client.prompt('Normal request again');
  const entries = await client.entries() as any[];
  const calls = exportsOf(entries);
  assert.equal(calls.length, 4, 'mode notices themselves never request a model turn');
  for (const call of calls) {
    assert.deepEqual(systems(call), systems(calls[0]!));
    assert.ok(systems(call).every((message) => !Object.keys(message.sections ?? {}).some((key) => key.startsWith('dag_workflow'))));
  }
  const notices = entries.filter((entry) => entry.customType === 'pi-dag-workflow.guidance');
  assert.equal(notices.length, 2);
  assert.match(notices[0].content, /Plan:.*Goal is paused/);
  assert.match(notices[1].content, /Normal:.*Goal stays paused until explicitly enabled/);
  assert.ok(calls[2]!.some((message: any) => text(message) === notices[0].content));
  assert.ok(calls[3]!.some((message: any) => text(message) === notices[1].content));
});

test('actual Pi: progress updates do not repeat full Goal rules; definition and policy changes do', { timeout: 30000 }, async (t) => {
  const offline = new URL('./fixtures/offline-model.ts', import.meta.url).pathname;
  const client = await IsolatedClient.start(undefined, 'stable-goal-contract', [], ['--dag-test-context-export', '--dag-workflow-test-child-provider', offline]); t.after(() => client.close());
  await client.prompt('TEST CALL subagent_spawn {"task":"HOLD-IDLE-ENABLE-CHILD"}');
  const records = await client.prompt('TEST CALL goal {"action":"create","title":"persistent objective","description":"ORIGINAL-TAIL","maxTurns":6}');
  assert.ok(records.some((record) => record.type === 'tool_execution_end' && record.toolName === 'goal'));
  await client.prompt('/goal enable #1');
  const contracts = async () => (await client.entries() as any[]).filter((entry) => entry.customType === GOAL_CHECKPOINT_TYPE && entry.content.startsWith('Goal contract ('));
  const before = await contracts(); assert.equal(before.length, 1);
  for (let index = 1; index <= 3; index++) await client.prompt(`TEST CALL goal ${JSON.stringify({ action: 'update', progress: `verified evidence ${index}` })}`);
  assert.equal((await contracts()).length, 1, 'ordinary progress has no full-rule churn');
  await client.prompt('TEST CALL goal {"action":"update","description":"NEW-ORIGINAL-TAIL"}');
  assert.equal((await contracts()).length, 2);
  assert.match((await contracts()).at(-1).content, /NEW-ORIGINAL-TAIL/);
  const offset = client.records.length;
  const configured = client.prompt('/goal nopause #1');
  await client.until(() => client.records.slice(offset).some((record) => record.type === 'extension_ui_request' && record.method === 'select'));
  const menu = client.records.slice(offset).find((record) => record.type === 'extension_ui_request' && record.method === 'select')!;
  client.child.stdin.write(`${JSON.stringify({ type: 'extension_ui_response', id: menu.id, value: (menu.options as string[])[1] })}\n`);
  await configured;
  assert.equal((await contracts()).length, 2, 'policy command alone does not request a provider turn');
  await client.prompt('inspect current evidence');
  assert.equal((await contracts()).length, 3);
  assert.match((await contracts()).at(-1).content, /"modelPause":"deny"/);
  await client.prompt('/goal disable #1');
});

for (const plan of [true, false]) test(`actual Pi: the first request after native manual compaction knows ${plan ? 'Plan' : 'Normal after Plan'} without a system section`, { timeout: 30000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dag-mode-recovery-'));
  await mkdir(join(root, 'agent'), { recursive: true });
  await writeFile(join(root, 'agent', 'settings.json'), JSON.stringify({ retry: { enabled: false }, compaction: { enabled: false, reserveTokens: 1, keepRecentTokens: 1 } }));
  const client = await IsolatedClient.start(root, 'mode-recovery', [], ['--dag-test-context-export']); t.after(() => client.close());
  await client.prompt('/plan start'); await client.prompt('Plan context');
  if (!plan) { await client.prompt('/plan off'); await client.prompt('Normal context'); }
  await client.send('compact');
  await client.prompt('first recovery request');
  const entries = await client.entries() as any[];
  const at = entries.findLastIndex((entry) => entry.type === 'compaction');
  assert.ok(at >= 0);
  const first = entries.slice(at + 1).find((entry) => entry.customType === 'dag-test.context-export').data.context.messages;
  assert.ok(first.some((message: any) => text(message).startsWith(plan ? 'Plan: read/search/ask' : 'Normal: continue the existing Todo list')));
  assert.ok(first.every((message: any) => !Object.keys(message.sections ?? {}).some((key) => key.startsWith('dag_workflow'))));
});
