import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { IsolatedClient } from './fixtures/isolated-client.ts';
import { GOAL_TYPE, type GoalState } from '../src/goal/state.ts';
import { CHECKPOINT_TYPE } from '../src/todos/checkpoints.ts';
import { GOAL_CHECKPOINT_TYPE } from '../src/goal/prompt.ts';

const memory = fileURLToPath(new URL('./fixtures/goal-compaction.ts', import.meta.url));
const latestGoal = (entries: any[]): GoalState => entries.findLast((entry) => entry.type === 'custom' && entry.customType === GOAL_TYPE)?.data;
const messageText = (message: any) => typeof message.content === 'string' ? message.content : (message.content ?? []).filter((part: any) => part.type === 'text').map((part: any) => part.text).join('\n');
function assertFirstRecovery(entries: any[], nopause = false) {
  const compactions = entries.map((entry, index) => ({ entry, index })).filter(({ entry }) => entry.type === 'compaction');
  assert.ok(compactions.length);
  for (const { index } of compactions) {
    const first = entries.slice(index + 1).find((entry) => entry.customType === 'dag-test.context-export');
    assert.ok(first, 'every compaction has a first provider request');
    const messages = first.data.context.messages;
    assert.ok(messages.some((message: any) => messageText(message).includes('The conversation history before this point was compacted')), 'first recovery retains the native/memory summary');
    const contract = messages.findLast((message: any) => messageText(message).startsWith('Goal contract ('));
    assert.ok(contract, 'not merely some later request: the first recovery has the current contract');
    assert.match(messageText(contract), /FINAL-REQUIREMENT/);
    assert.match(messageText(contract), /verify every requirement/);
    assert.match(messageText(contract), /"paused":false/);
    if (nopause) { assert.match(messageText(contract), /"modelPause":"deny"/); assert.match(messageText(contract), /do not ask questions/); }
    assert.ok(messages.every((message: any) => !Object.keys(message.sections ?? {}).some((key) => key.startsWith('dag_workflow'))));
  }
}
async function setup(extraArgs: string[] = [], useMemoryFixture = true, memoryFirst = false) {
  const root = await mkdtemp(join(tmpdir(), 'pi-dag-compact-goal-'));
  await mkdir(join(root, 'agent'), { recursive: true });
  await writeFile(join(root, 'agent', 'settings.json'), JSON.stringify({ compaction: { enabled: true, reserveTokens: 35000, keepRecentTokens: 1 }, retry: { enabled: false } }));
  return IsolatedClient.start(root, 'goal-compaction', useMemoryFixture && !memoryFirst ? [memory] : [], extraArgs, false, memoryFirst ? [memory, fileURLToPath(new URL('../', import.meta.url))] : undefined);
}
async function create(client: IsolatedClient) {
  await client.prompt('TEST CALL todo {"action":"create","subject":"saved open task"}');
  await client.prompt(`TEST CALL goal ${JSON.stringify({ action: 'create', title: '预算测试', maxTurns: 2, description: `${'Complete every original requirement. '.repeat(160)}FINAL-REQUIREMENT` })}`);
}
async function denyPolicy(client: IsolatedClient) {
  const offset = client.records.length;
  const configuring = client.prompt('/goal nopause #1');
  await client.until(() => client.records.slice(offset).some((record) => record.type === 'extension_ui_request' && record.method === 'select'));
  const menu = client.records.slice(offset).find((record) => record.type === 'extension_ui_request' && record.method === 'select')!;
  client.child.stdin.write(`${JSON.stringify({ type: 'extension_ui_response', id: menu.id, value: (menu.options as string[])[1] })}\n`);
  await configuring;
}
async function ended(client: IsolatedClient) {
  await client.until(() => client.records.some((record) => record.method === 'notify' && String(record.message).includes('轮上限')));
  await client.until(() => client.records.filter((record) => record.type === 'agent_settled').length >= 3);
  const entries = await client.entries() as any[];
  const goal = latestGoal(entries);
  assert.equal(goal.run.used, 2, 'exactly two actual automatic rounds consume the allowance');
  assert.equal(goal.run.pendingWake, undefined);
  assert.equal(goal.run.paused, true);
  assert.match(goal.run.reason!, /轮上限/);
  assert.ok(entries.some((entry) => entry.type === 'compaction'));
  const calls = (await readFile(join(client.root, 'goal-compaction-context.jsonl'), 'utf8')).trim().split('\n').map((line) => JSON.parse(line) as any[]);
  assert.ok(calls.some((messages) => messages.some((message) => message.role === 'compactionSummary' && message.summary.startsWith('MEMORY PROJECTION:')) && messages.some((message) => message.customType === CHECKPOINT_TYPE && message.content.includes('saved open task'))), 'the resumed provider context gets both memory-owned summary projection and the workflow state');
  assert.ok(calls.some((messages) => messages.some((message) => message.role === 'compactionSummary') && messages.some((message) => message.customType === GOAL_CHECKPOINT_TYPE && message.content.includes('"paused":false') && message.content.includes('full original objective'))), 'compacted provider context receives the authoritative Goal and execution rules even if its system section is absent');
  assert.ok(calls.some((messages) => messages.some((message) => message.role === 'compactionSummary') && messages.some((message) => message.customType === GOAL_CHECKPOINT_TYPE && message.content.includes('FINAL-REQUIREMENT'))), 'long original requirements survive compaction, independent of the wake reminder');
  return entries;
}

for (const [reason, flag] of [['threshold', '--dag-test-compaction-pressure'], ['overflow', '--dag-test-overflow']]) {
  test(`real Pi without memory extensions: native ${reason} compaction resumes Goal and restores Todo context`, { timeout: 30000 }, async (t) => {
    const client = await setup([flag!, '--dag-test-context-export'], false); t.after(() => client.close());
    await create(client); await client.prompt('/goal enable #1');
    await client.until(() => client.records.some((record) => record.method === 'notify' && String(record.message).includes('轮上限')));
    const entries = await client.entries() as any[];
    const goal = latestGoal(entries);
    assert.equal(goal.run.used, 2);
    assert.equal(goal.run.pendingWake, undefined);
    assert.equal(goal.run.paused, true);
    assert.match(goal.run.reason!, /轮上限/);
    const compactions = entries.filter((entry) => entry.type === 'compaction');
    assert.ok(compactions.length >= 1);
    assert.ok(compactions.every((entry) => entry.fromHook !== true), 'the native Pi summarizer owns compaction; no extension provided a summary');
    assert.ok(client.records.some((record) => record.type === 'compaction_start' && record.reason === reason));
    assert.ok(entries.some((entry) => entry.customType === CHECKPOINT_TYPE && entry.details?.reason === 'compaction' && entry.content.includes('saved open task')));
    assert.equal(entries.filter((entry) => entry.customType === 'pi-dag-workflow.goal-retry').length, 0);
    assertFirstRecovery(entries);
  });
}

test('real Pi: one continuous Goal recovers three separate context overflows without extra wakes or error retries', { timeout: 30000 }, async (t) => {
  const client = await setup(['--dag-test-repeated-overflow'], false); t.after(() => client.close());
  await client.prompt('TEST CALL goal {"action":"create","title":"预算测试","maxTurns":6}');
  await client.prompt('/goal enable #1');
  await client.until(() => client.records.some((record) => record.method === 'notify' && String(record.message).includes('轮上限')));
  const entries = await client.entries() as any[];
  const goal = latestGoal(entries);
  assert.equal(goal.run.used, 6);
  assert.equal(goal.run.paused, true);
  assert.match(goal.run.reason!, /6 轮上限/);
  assert.equal(entries.filter((entry) => entry.type === 'compaction').length, 3);
  assert.equal(entries.filter((entry) => entry.customType === 'pi-dag-workflow.goal-continue').length, 5);
  assert.equal(entries.filter((entry) => entry.customType === 'pi-dag-workflow.goal-retry').length, 0);
  assert.ok(entries.filter((entry) => entry.customType === GOAL_CHECKPOINT_TYPE && entry.content.includes('"paused":false')).length >= 3);
});

for (const memoryFirst of [false, true]) test(`real Pi: threshold compaction keeps Goal continuation and checkpoints (memory ${memoryFirst ? 'before' : 'after'} workflow)`, { timeout: 30000 }, async (t) => {
  const client = await setup(['--dag-test-compaction-pressure'], true, memoryFirst); t.after(() => client.close());
  await create(client);
  await client.prompt('/goal enable #1');
  const entries = await ended(client);
  assert.equal(entries.filter((entry) => entry.type === 'compaction').length, 1);
  assert.equal(entries.filter((entry) => entry.customType === 'pi-dag-workflow.goal-continue').length, 1);
  assert.equal(entries.filter((entry) => entry.customType === CHECKPOINT_TYPE && entry.details?.reason === 'compaction').length, 1);
});

for (const memoryFirst of [false, true]) for (const [reason, flag] of [['threshold', '--dag-test-compaction-pressure'], ['overflow', '--dag-test-overflow']]) test(`first ${reason} recovery preserves nopause and full requirements with memory ${memoryFirst ? 'before' : 'after'} workflow`, { timeout: 30000 }, async (t) => {
  const client = await setup([flag!, '--dag-test-context-export'], true, memoryFirst); t.after(() => client.close());
  await create(client); await denyPolicy(client); await client.prompt('/goal enable #1');
  await client.until(() => client.records.some((record) => record.method === 'notify' && String(record.message).includes('轮上限')));
  const entries = await client.entries() as any[];
  assertFirstRecovery(entries, true);
  assert.equal(latestGoal(entries).run.used, 2);
  assert.equal(entries.filter((entry) => entry.customType === 'pi-dag-workflow.goal-continue').length, 1);
  assert.equal(entries.filter((entry) => entry.customType === 'pi-dag-workflow.goal-retry').length, 0);
});

test('real Pi: native overflow recovery wins over fallback continuation and preserves the budget', { timeout: 30000 }, async (t) => {
  const client = await setup(['--dag-test-overflow']); t.after(() => client.close());
  await create(client);
  await client.prompt('/goal enable #1');
  const entries = await ended(client);
  assert.ok(client.records.some((record) => record.type === 'compaction_start' && record.reason === 'overflow'));
  assert.equal(entries.filter((entry) => entry.customType === 'pi-dag-workflow.goal-retry').length, 0, 'Pi recovery finishes before Goal error retries');
  assert.equal(entries.filter((entry) => entry.customType === 'pi-dag-workflow.goal-continue').length, 1, 'native retry does not schedule a duplicate Goal wake');
});

test('real Pi: slow manual compaction completion resumes an active Goal without another settled event', { timeout: 30000 }, async (t) => {
  const client = await setup(); t.after(() => client.close());
  await create(client);
  await client.prompt('/test-compact-slow-race');
  await client.prompt('/goal enable #1');
  const entries = await ended(client);
  assert.equal(entries.filter((entry) => entry.customType === 'pi-dag-workflow.goal-continue').length, 1);
  assert.equal(entries.filter((entry) => entry.type === 'compaction').length, 1);
});

test('real Pi: rejected continuation then memory compaction resumes once without losing nextStep', { timeout: 30000 }, async (t) => {
  const client = await setup(); t.after(() => client.close());
  await create(client);
  await client.prompt('/test-compact-race');
  await client.prompt('/goal enable #1');
  const entries = await ended(client);
  assert.equal(entries.filter((entry) => entry.customType === 'pi-dag-workflow.goal-continue').length, 1, 'only the actually reissued continuation is persisted');
  assert.match(entries.find((entry) => entry.customType === 'pi-dag-workflow.goal-continue').content, /预算测试下一步/);
  const snapshots = entries.filter((entry) => entry.type === 'custom' && entry.customType === GOAL_TYPE).map((entry) => entry.data as GoalState);
  assert.ok(snapshots.some((state) => state.run.pendingWake && state.run.nextStep === '预算测试下一步'));
  assert.ok(snapshots.some((state) => state.run.used === 1 && !state.run.pendingWake && state.run.nextStep === '预算测试下一步'), 'a discarded draft is refunded while retaining its exact step');
  const count = entries.filter((entry) => entry.customType === 'pi-dag-workflow.goal-continue').length;
  await delay(120);
  assert.equal((await client.entries() as any[]).filter((entry) => entry.customType === 'pi-dag-workflow.goal-continue').length, count, 'late timers cannot restart a capped goal');
});
