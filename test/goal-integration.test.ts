import { AGENT_REPORT_MESSAGE, GOAL_CONTINUE_MESSAGE, GOAL_RETRY_MESSAGE, RETRY_REQUEST_MESSAGE, TEAM_MEMBERSHIP_MESSAGE, TEAM_MESSAGE, GOAL_TYPE, type GoalParams, type GoalState, CHECKPOINT_TYPE, GOAL_CHECKPOINT_TYPE } from './fixtures/public-records.ts';
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { IsolatedClient } from "./fixtures/isolated-client.ts";
import { loadPublic } from "./fixtures/public-host.ts";
import type { Feature } from './fixtures/public-records.ts';
import { rm } from "node:fs/promises";

/** Public fallback cadence: the first bounded Goal recovery wake waits one second, then doubles. */
const goalFallbackBackoffMs = 1000;

{
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
  await client.prompt('/goal nopause #1 on');
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
    assert.equal(entries.filter((entry) => entry.customType === GOAL_RETRY_MESSAGE).length, 0);
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
  assert.equal(entries.filter((entry) => entry.customType === GOAL_CONTINUE_MESSAGE).length, 5);
  assert.equal(entries.filter((entry) => entry.customType === GOAL_RETRY_MESSAGE).length, 0);
  assert.ok(entries.filter((entry) => entry.customType === GOAL_CHECKPOINT_TYPE && entry.content.includes('"paused":false')).length >= 3);
});

for (const memoryFirst of [false, true]) test(`real Pi: threshold compaction keeps Goal continuation and checkpoints (memory ${memoryFirst ? 'before' : 'after'} workflow)`, { timeout: 30000 }, async (t) => {
  const client = await setup(['--dag-test-compaction-pressure'], true, memoryFirst); t.after(() => client.close());
  await create(client);
  await client.prompt('/goal enable #1');
  const entries = await ended(client);
  assert.equal(entries.filter((entry) => entry.type === 'compaction').length, 1);
  assert.equal(entries.filter((entry) => entry.customType === GOAL_CONTINUE_MESSAGE).length, 1);
  assert.equal(entries.filter((entry) => entry.customType === CHECKPOINT_TYPE && entry.details?.reason === 'compaction').length, 1);
});

for (const memoryFirst of [false, true]) for (const [reason, flag] of [['threshold', '--dag-test-compaction-pressure'], ['overflow', '--dag-test-overflow']]) test(`first ${reason} recovery preserves nopause and full requirements with memory ${memoryFirst ? 'before' : 'after'} workflow`, { timeout: 30000 }, async (t) => {
  const client = await setup([flag!, '--dag-test-context-export'], true, memoryFirst); t.after(() => client.close());
  await create(client); await denyPolicy(client); await client.prompt('/goal enable #1');
  await client.until(() => client.records.some((record) => record.method === 'notify' && String(record.message).includes('轮上限')));
  const entries = await client.entries() as any[];
  assertFirstRecovery(entries, true);
  assert.equal(latestGoal(entries).run.used, 2);
  assert.equal(entries.filter((entry) => entry.customType === GOAL_CONTINUE_MESSAGE).length, 1);
  assert.equal(entries.filter((entry) => entry.customType === GOAL_RETRY_MESSAGE).length, 0);
});

test('real Pi: native overflow recovery wins over fallback continuation and preserves the budget', { timeout: 30000 }, async (t) => {
  const client = await setup(['--dag-test-overflow']); t.after(() => client.close());
  await create(client);
  await client.prompt('/goal enable #1');
  const entries = await ended(client);
  assert.ok(client.records.some((record) => record.type === 'compaction_start' && record.reason === 'overflow'));
  assert.equal(entries.filter((entry) => entry.customType === GOAL_RETRY_MESSAGE).length, 0, 'Pi recovery finishes before Goal error retries');
  assert.equal(entries.filter((entry) => entry.customType === GOAL_CONTINUE_MESSAGE).length, 1, 'native retry does not schedule a duplicate Goal wake');
});

test('real Pi: slow manual compaction completion resumes an active Goal without another settled event', { timeout: 30000 }, async (t) => {
  const client = await setup(); t.after(() => client.close());
  await create(client);
  await client.prompt('/test-compact-slow-race');
  await client.prompt('/goal enable #1');
  const entries = await ended(client);
  assert.equal(entries.filter((entry) => entry.customType === GOAL_CONTINUE_MESSAGE).length, 1);
  assert.equal(entries.filter((entry) => entry.type === 'compaction').length, 1);
});

test('real Pi: rejected continuation then memory compaction resumes once without losing nextStep', { timeout: 30000 }, async (t) => {
  const client = await setup(); t.after(() => client.close());
  await create(client);
  await client.prompt('/test-compact-race');
  await client.prompt('/goal enable #1');
  const entries = await ended(client);
  assert.equal(entries.filter((entry) => entry.customType === GOAL_CONTINUE_MESSAGE).length, 1, 'only the actually reissued continuation is persisted');
  assert.match(entries.find((entry) => entry.customType === GOAL_CONTINUE_MESSAGE).content, /预算测试下一步/);
  const snapshots = entries.filter((entry) => entry.type === 'custom' && entry.customType === GOAL_TYPE).map((entry) => entry.data as GoalState);
  assert.ok(snapshots.some((state) => state.run.pendingWake && state.run.nextStep === '预算测试下一步'));
  assert.ok(snapshots.some((state) => state.run.used === 1 && !state.run.pendingWake && state.run.nextStep === '预算测试下一步'), 'a discarded draft is refunded while retaining its exact step');
  const count = entries.filter((entry) => entry.customType === GOAL_CONTINUE_MESSAGE).length;
  await delay(120);
  assert.equal((await client.entries() as any[]).filter((entry) => entry.customType === GOAL_CONTINUE_MESSAGE).length, count, 'late timers cannot restart a capped goal');
});
}

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
}

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

test('B0 actual Pi: Todos and Goal recover without loading the Retry feature', { timeout: 20000 }, async (t) => {
  const root = await agentRoot();
  const entries = ['todos', 'goal'].map(name => fileURLToPath(new URL(`../src/${name}/index.ts`, import.meta.url)));
  const client = await IsolatedClient.start(root, 'goal-native-unmounted', [], [], false, entries);
  t.after(async () => { await client.close(); await rm(root, { recursive: true, force: true }); });
  await create(client, '出错重试测试');
  await client.until(() => latest(client)?.goals[0]?.status === 'completed', 15000);
  const branch = await client.entries();
  assert.equal(branch.filter(entry => (entry as any).customType === GOAL_RETRY_MESSAGE).length, 2);
  assert.equal((await retryRequests(client)).length, 0);
  assert.equal(latest(client)!.run.errorRetries, 0);
  assert.equal(client.records.some(record => record.type === 'extension_error'), false);
});
}

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
}

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

test('actual Pi: /retry cannot reset or bypass the Goal round cap', { timeout: 45000 }, async (t) => {
  const root = await agentRoot({ goalMaxTurns: 2 });
  const client = await IsolatedClient.start(root, 'goal-retry-cap');
  t.after(async () => { await client.close(); await rm(root, { recursive: true, force: true }); });
  await client.prompt('/retry when-error 1s count 5');
  const events = await client.prompt(`TEST CALL goal ${JSON.stringify({ action: 'create', title: '出错暂停测试', maxTurns: 2 })}`);
  assert.ok(events.some((event) => event.type === 'tool_execution_end' && event.toolName === 'goal' && !event.isError), JSON.stringify(events.slice(-3)));
  const events2 = await client.prompt(`TEST CALL goal ${JSON.stringify({ action: 'enable', id: 1 })}`);
  assert.ok(events2.some((event) => event.type === 'tool_execution_end' && event.toolName === 'goal' && !event.isError), JSON.stringify(events2.slice(-3)));
  await client.until(() => /上限/.test(latest(client)?.run.reason ?? ''), 35000);
  assert.match(latest(client)!.run.reason!, /上限/);
  assert.ok((latest(client)!.run.used ?? 0) <= 2);
  assert.ok((await retryRequests(client)).length <= 2, 'the Goal cap stops retries before the /retry count');
});
}

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
}

{
const cleanups = new Set<() => Promise<unknown>>();
afterEach(async () => { await Promise.all([...cleanups].map((cleanup) => cleanup())); cleanups.clear(); });

/** Public-surface host: assembles the extension entrypoints and reads native Goal records. */
async function publicHost(features: readonly Feature[] = ['todos', 'plan', 'agents', 'goal', 'retry'], leafAware = false) {
  const handlers = new Map<string, Function[]>();
  const tools = new Map<string, any>(); const commands = new Map<string, any>();
  let idle = false;
  const entries: any[] = []; const notifications: string[] = []; const wakes: any[] = []; const passive: any[] = [];
  let messageSeq = 0; let branchReads = 0;
  const ctx: any = { cwd: '/tmp', mode: 'rpc', hasUI: true, isIdle: () => idle, sessionManager: { getBranch: () => { branchReads++; return entries; }, getSessionFile: () => fileURLToPath(new URL('../package.json', import.meta.url)), ...(leafAware ? { getLeafId: () => String(entries.length) } : {}) }, ui: { notify: (text: string) => notifications.push(text), confirm: async () => true, setWidget() {}, setStatus() {} }, modelRegistry: { find: () => undefined, getAvailable: () => [] } };
  const pi: any = {
    on(name: string, handler: Function) { handlers.set(name, [...handlers.get(name) ?? [], handler]); return () => {}; },
    registerTool(tool: any) { tools.set(tool.name, tool); }, registerCommand(name: string, cmd: any) { commands.set(name, cmd); },
    registerFlag() {}, getFlag() {},
    appendEntry(customType: string, data: any) { entries.push({ type: 'custom', customType, data: structuredClone(data) }); },
    sendMessage(message: any, options: any) { (options?.triggerTurn === false ? passive : wakes).push({ message, options }); },
    sendUserMessage(message: string) { wakes.push({ message, options: { source: 'extension' } }); },
    getActiveTools: () => [] as string[], setActiveTools() {}, getAllTools: () => [],
  };
  await loadPublic(pi, features, 'zh-CN');
  const fire = async (name: string, event: any = {}) => {
    if (name === 'turn_end' || name === 'agent_before_settle') event.entries ??= [];
    let result: any;
    for (const handler of handlers.get(name) ?? []) {
      const next = await handler(event, ctx);
      if (next) { result = { ...result, ...next }; if (next.entries) event.entries = next.entries; if (next.continue !== undefined) event.continue = next.continue; }
    }
    if (name === 'before_agent_start' && result?.message) entries.push({ type: 'custom_message', ...result.message });
    return result;
  };
  cleanups.add(() => fire('session_shutdown'));
  await fire('session_start');
  const call = async (params: GoalParams) => tools.get('goal').execute('test', params, undefined, undefined, ctx);
  const propose = (event: any = {}) => fire('agent_before_settle', { outcome: 'completed', continue: false, entries: [], ...event });
  const startTurn = async (messages: any[] = []) => { await fire('turn_start'); await fire('context', { messages }); };
  const settle = async (event: any = {}) => {
    const result = await propose(event);
    if (result?.continue) {
      entries.push(...result.entries.filter((entry: any) => entry.type === 'custom_message'));
      await startTurn(result.entries.map((entry: any) => ({ role: 'custom', ...entry })));
    }
    return result?.continue ? result : undefined;
  };
  const enable = async (maxTurns = 20) => { await call({ action: 'create', title: '研究', maxTurns }); await fire('input', { source: 'rpc', text: '启用目标' }); assert.ok(!(await call({ action: 'enable', id: 1 })).isError); };
  const message = (stopReason: string, errorMessage = stopReason === 'error' ? 'stream error' : undefined) => { entries.push({ type: 'message', id: `m${++messageSeq}`, parentId: null, message: { role: 'assistant', stopReason, errorMessage } }); };
  const settled = async () => { await fire('agent_settled', { aborted: false }); await new Promise((resolve) => setTimeout(resolve, 0)); };
  const retries = () => wakes.filter((wake) => wake.message?.customType === GOAL_RETRY_MESSAGE).length;
  const state = () => entries.findLast((entry) => entry.type === 'custom' && entry.customType === GOAL_TYPE)?.data as GoalState;
  return { ctx, fire, call, settle, propose, startTurn, enable, settled, message, retries, state, entries, notifications, wakes, passive, branchReads: () => branchReads, setIdle(value: boolean) { idle = value; }, commands, tools };
}

/** Real offline-child host: public entrypoints, native records and an OS child-process transport. */
async function childHost() {
  const { protocolHost } = await import('./fixtures/agents-protocol-host.ts');
  const h = await protocolHost({ features: ['todos', 'agents', 'goal'], idle: false, language: 'zh-CN' });
  const goal = (params: GoalParams) => h.call('goal', params) as Promise<any>;
  const goalState = () => h.entries.findLast((entry) => entry.customType === GOAL_TYPE)?.data as GoalState;
  const startTurn = async (entries: any[] = []) => { await h.emit('turn_start'); await h.emit('context', { messages: entries.map((entry) => ({ role: 'custom', ...entry })) }); };
  const settle = async () => {
    const result: any = await h.emit('agent_before_settle', { outcome: 'completed', continue: false, entries: [] });
    if (!result?.continue) return undefined;
    await startTurn(result.entries);
    return result;
  };
  const enable = async (maxTurns = 20) => { await goal({ action: 'create', title: '研究', maxTurns }); await h.emit('input', { source: 'rpc', text: '启用目标' }); await goal({ action: 'enable', id: 1 }); };
  const spawn = (task: string, extra: object = {}) => h.call('subagent_spawn', { task, tools: ['read', 'bash'], ...extra }) as Promise<any>;
  const waitFor = async (predicate: (job: any) => boolean, jobId: string, timeoutMs = 20000) => {
    const deadline = Date.now() + timeoutMs;
    let job = await h.call('subagent_inspect', { jobId, output: true, until: 'update', timeout: 5 });
    while (!predicate(job) && Date.now() < deadline) job = await h.call('subagent_inspect', { jobId, output: true, until: 'update', timeout: 5 });
    return job;
  };
  return Object.assign(h, { goal, goalState, settle, enable, spawn, waitFor, startTurn });
}

test('B0: Goal retries a transient request with advanced Retry disabled', async (t) => {
  const h = await publicHost(); await h.enable(); h.setIdle(true);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  await h.startTurn(); h.message('error', 'ECONNRESET');
  await h.fire('turn_end', { outcome: 'error' });
  await h.fire('agent_settled', { aborted: false });
  assert.equal(h.state().run.paused, false, 'a transient failure must not require /retry');
  assert.equal(h.retries(), 0, 'no recovery before the backoff');
  // Bounded recovery waits one public backoff interval before its first fallback wake.
  t.mock.timers.tick(goalFallbackBackoffMs - 1);
  assert.equal(h.retries(), 0);
  t.mock.timers.tick(1);
  assert.equal(h.retries(), 1);
  assert.equal(h.state().run.errorRetries, 1);
});

test('B0: an unmounted Retry hook uses the same bounded Goal recovery', async (t) => {
  const h = await publicHost(['todos', 'plan', 'agents', 'goal']); await h.enable(); h.setIdle(true);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  await h.startTurn(); h.message('error', 'HTTP 503 overloaded');
  await h.fire('agent_settled', { aborted: false });
  assert.equal(h.state().run.paused, false);
  t.mock.timers.tick(1000);
  assert.equal(h.retries(), 1);
  assert.equal(h.state().run.errorRetries, 1);
  assert.equal(h.state().run.used, 1);
  await h.startTurn();
  assert.equal((await h.call({ action: 'update', title: 'unauthorized expansion' })).isError, true);
});

test('B0: busy recovery and duplicate settlement do not spend additional attempts', async (t) => {
  const h = await publicHost(); await h.enable();
  t.mock.timers.enable({ apis: ['setTimeout'] });
  await h.startTurn(); h.message('error', 'timeout');
  await h.fire('agent_settled', { aborted: false });
  t.mock.timers.tick(500);
  await h.fire('agent_settled', { aborted: false });
  t.mock.timers.tick(500);
  assert.equal(h.retries(), 0);
  assert.equal(h.state().run.errorRetries ?? 0, 0);
  h.setIdle(true); t.mock.timers.tick(1000);
  assert.equal(h.retries(), 1);
  assert.equal(h.state().run.errorRetries, 1);
});

test('B0: successful completion resets the native failure streak, request admission does not', async (t) => {
  const h = await publicHost(); await h.enable(); h.setIdle(true);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  await h.startTurn(); h.message('error', 'fetch failed');
  await h.fire('agent_settled', { aborted: false }); t.mock.timers.tick(1000);
  await h.startTurn(); assert.equal(h.state().run.errorRetries, 1);
  h.message('stop'); await h.fire('turn_end', { outcome: 'completed' });
  assert.equal(h.state().run.errorRetries, 0);
  h.message('error', 'fetch failed'); await h.fire('agent_settled', { aborted: false });
  t.mock.timers.tick(999); assert.equal(h.retries(), 1);
  t.mock.timers.tick(1); assert.equal(h.retries(), 2);
  assert.equal(h.state().run.errorRetries, 1);
});

test('B0: native retry cancellation protects user input, Plan, navigation, shutdown, and Goal stop', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  for (const event of ['input', 'session_before_switch', 'session_before_fork', 'session_before_tree', 'session_tree', 'session_shutdown', 'disable', 'plan', 'abort']) {
    const h = await publicHost(); await h.enable(); h.setIdle(true);
    await h.startTurn(); h.message('error', 'ECONNRESET'); await h.fire('agent_settled', { aborted: false });
    if (event === 'disable') await h.commands.get('goal').handler('disable', h.ctx);
    else if (event === 'plan') await h.commands.get('plan').handler('start', h.ctx);
    else if (event === 'abort') { h.ctx.signal = AbortSignal.abort(); await h.fire('agent_settled', { aborted: true }); }
    else await h.fire(event, { source: 'rpc', text: 'user owns the next action' });
    t.mock.timers.tick(60000);
    assert.equal(h.retries(), 0, event);
    assert.equal(h.state().run.errorRetries ?? 0, 0, event);
    await h.fire('session_shutdown');
  }
});

test('B0: advanced Retry retains priority and exhausted Goal allowance never arms native retry', async (t) => {
  const h = await publicHost(); await h.enable(1); h.setIdle(true);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  await h.startTurn(); await h.commands.get('retry').handler('when-error 1h', h.ctx); h.message('error', 'ECONNRESET');
  await h.fire('agent_settled', { aborted: false }); t.mock.timers.tick(60000);
  assert.equal(h.retries(), 0, 'advanced Retry owns recovery while armed');
  assert.equal(h.state().run.paused, true, 'Goal is paused while Retry owns recovery');
  assert.match(h.state().run.reason!, /\/retry status.*\/retry off.*\/goal enable/);
  // Turning advanced Retry off is a real user stop: there is no side-effect-free public switch.
  await h.commands.get('retry').handler('off', h.ctx);
  await h.fire('agent_settled', { aborted: false }); t.mock.timers.tick(1000);
  assert.equal(h.state().run.paused, true, 'the user stop keeps the Goal stopped');
  assert.equal(h.retries(), 0, 'no stale automatic wake survives the user stop');
  // Explicit authorization plus a new failure proves Goal's own bounded fallback while Retry is off.
  h.setIdle(false);
  await h.fire('input', { source: 'rpc', text: '继续当前范围' });
  await h.call({ action: 'enable', id: 1 });
  h.setIdle(true);
  await h.startTurn(); h.message('error', 'ECONNRESET');
  await h.fire('agent_settled', { aborted: false }); t.mock.timers.tick(1000);
  assert.equal(h.retries(), 1, 'disabled Retry leaves Goal its own bounded fallback');
  await h.startTurn(); h.message('error', 'ECONNRESET');
  await h.fire('agent_settled', { aborted: false }); t.mock.timers.tick(60000);
  assert.equal(h.state().run.paused, true);
  assert.match(h.state().run.reason!, /上限/);
});

test('ordinary input without a Goal never reads session history; leaf-aware failure cache invalidates on changes', async () => {
  const empty = await publicHost(['todos', 'plan', 'goal']);
  const baselineReads = empty.branchReads();
  for (let i = 0; i < 30; i++) await empty.fire('input', { source: 'rpc', text: 'ordinary work' });
  assert.equal(empty.branchReads(), baselineReads, 'ordinary input never reads session history');
  const h = await publicHost(undefined, true); await h.enable(); await h.commands.get('retry').handler('when-error 1h', h.ctx);
  await h.fire('input', { source: 'rpc', text: 'same leaf' });
  const reads = h.branchReads();
  for (let i = 0; i < 10; i++) await h.fire('input', { source: 'rpc', text: 'same leaf' });
  assert.equal(h.branchReads(), reads);
  await h.startTurn(); h.message('error'); h.setIdle(true); await h.settled();
  assert.equal(h.retries(), 0, 'Goal does not create its own recovery timer');
  assert.ok(h.branchReads() > reads, 'a new leaf is not served from the old cache');
  await h.fire('session_before_compact', { willRetry: false });
  h.entries.push({ type: 'compaction', id: 'changed-boundary' });
  await h.fire('session_compact', { willRetry: false });
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(h.retries(), 0);
  assert.equal(h.wakes.some((wake) => wake.message?.customType === GOAL_CONTINUE_MESSAGE), true);
});

test('run-only Goal updates do not append redundant checkpoints; goal-definition changes still do', async () => {
  const h = await publicHost(); await h.enable();
  const start = () => h.fire('before_agent_start', { systemPromptOptions: { sections: {}, selectedTools: [] } });
  assert.ok((await start())?.message);
  await h.propose();
  await h.call({ action: 'update', progress: 'new evidence', nextStep: 'run actual test' });
  assert.equal(await start(), undefined);
  await h.fire('input', { source: 'rpc', text: 'rename authorized' });
  await h.call({ action: 'update', title: 'updated objective' });
  assert.match((await start()).message.content, /updated objective/);
});

test('mock host: shared Agent/Goal wakes consume one allowance, never reset on status/input/read', async (t) => {
  const h = await childHost(); t.after(() => h.close());
  await h.enable(2);
  const child = await h.spawn('CONTROL REPORT HOLD');
  await h.waitFor((job) => ['starting', 'running'].includes(job.status), child.jobId);
  h.options.idle = true;
  await h.call('subagent_send', { recipient: child.jobId, interrupt: true, message: 'Complete the read-only report' });
  const deadline = Date.now() + 10000;
  while (!h.sent.some((item) => item.message.customType === AGENT_REPORT_MESSAGE)) { if (Date.now() > deadline) throw new Error('child report did not arrive'); await delay(10); }
  assert.equal(h.goalState().run.used, 1, 'the child-report wake reserves one shared round');
  await h.emit('turn_start');
  const next = await h.settle();
  assert.equal(h.goalState().run.used, 2);
  assert.equal(next?.continue, true, 'the Goal wake shares the same allowance');
  await h.emit('turn_start');
  await h.emit('input', { source: 'rpc', text: '查看状态' }); await h.goal({ action: 'list' });
  assert.equal(h.goalState().run.used, 2);
  assert.equal(await h.settle(), undefined);
  assert.match(h.goalState().run.reason!, /上限/);
  const pausedState = h.goalState();
  await h.goal({ action: 'enable', id: 1 }); // User explicitly enables after the input, so this is a resume.
  assert.equal(pausedState.run.used, 2);
});
test('mock host: Goal pauses on error by default without its own retry timer', async (t) => {
  // B0 replaces immediate pause with bounded recovery; retain the historical case name.
  const h = await publicHost(); await h.enable(); h.setIdle(true);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  await h.startTurn(); h.message('error');
  await h.fire('turn_end', { outcome: 'error' });
  await h.fire('agent_before_settle', { outcome: 'error', continue: false });
  assert.equal(h.retries(), 0);
  await h.fire('agent_settled', { aborted: false });
  assert.equal(h.state().run.paused, false);
  assert.equal(h.state().run.errorRetries, undefined);
  t.mock.timers.tick(999); assert.equal(h.retries(), 0);
  t.mock.timers.tick(1); assert.equal(h.retries(), 1);
  assert.equal(h.state().run.errorRetries, 1);
});

test('mock host: repeated failures do not revive the old five-attempt Goal recovery', async (t) => {
  const h = await publicHost(); await h.enable(); h.setIdle(true);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  for (let index = 0; index < 5; index++) {
    await h.startTurn(); h.message('error');
    await h.fire('agent_settled', { aborted: false });
    assert.equal(h.state().run.paused, false);
    t.mock.timers.tick(goalFallbackBackoffMs * 2 ** index - 1); assert.equal(h.retries(), index);
    t.mock.timers.tick(1); assert.equal(h.retries(), index + 1);
    assert.equal(h.state().run.errorRetries, index + 1);
  }
  await h.startTurn(); h.message('error'); await h.fire('agent_settled', { aborted: false });
  assert.equal(h.state().run.paused, true);
  assert.equal(h.state().run.errorRetries, 5);
  assert.match(h.state().run.reason!, /次数已用完/);
  t.mock.timers.tick(30000); assert.equal(h.retries(), 5);
});

test('Goal recovery reservations use remaining allowance, refund unstarted work, and never create timers', async () => {
  const h = await publicHost(); await h.enable(3);
  assert.equal(h.state().run.paused, false);
  const reserved = await h.propose();
  assert.equal(reserved?.continue, true);
  assert.ok(h.state().run.pendingWake, 'the provisional continuation holds one refundable reservation');
  assert.equal(h.state().run.used, 1);
  await h.fire('agent_settled', { aborted: false });
  assert.equal(h.state().run.used, 0, 'an unstarted request is refundable');
  assert.equal(h.state().run.pendingWake, undefined, 'the refund releases the reservation');
  const again = await h.propose();
  assert.equal(again?.continue, true);
  await h.startTurn(again.entries);
  assert.equal(h.state().run.used, 1);
  assert.equal(h.state().run.pendingWake, undefined);
  assert.equal((await h.call({ action: 'update', title: 'expanded without user input' })).isError, true);
  await h.fire('turn_end', { outcome: 'completed' });
  assert.equal(h.retries(), 0, 'the shared retry component, not Goal, sends recovery messages');
});

test('mock host: a user abort never retries', async () => {
  const h = await publicHost(); await h.enable(); h.setIdle(true);
  await h.fire('turn_end', { outcome: 'aborted' });
  assert.equal(h.state().run.paused, true);
  assert.match(h.state().run.reason!, /用户中断/);
  h.message('aborted');
  await h.fire('agent_end', { messages: [{ role: 'assistant', stopReason: 'aborted' }] });
  await h.settled();
  assert.equal(h.retries(), 0);
});

test('provider abort without a user stop still requires an explicit retry setting', async (t) => {
  const h = await publicHost(); await h.enable(); h.setIdle(true);
  h.ctx.signal = new AbortController().signal;
  await h.startTurn(); h.message('aborted', 'connection reset while reading stream');
  await h.fire('turn_end', { outcome: 'aborted' });
  await h.fire('agent_end', { messages: [h.entries.at(-1).message] });
  await h.fire('agent_before_settle', { outcome: 'aborted', continue: false });
  assert.equal(h.state().run.paused, false);
  assert.equal(h.retries(), 0, 'native recovery gets the first opportunity');
  t.mock.timers.enable({ apis: ['setTimeout'] });
  await h.fire('agent_settled', { aborted: false }); await h.fire('agent_settled', { aborted: false });
  assert.equal(h.retries(), 0);
  assert.equal(h.state().run.paused, false);
  t.mock.timers.tick(1000); assert.equal(h.retries(), 1);
});

test('a real user signal abort takes priority over recoverable provider text', async () => {
  const h = await publicHost(); await h.enable(); h.setIdle(true);
  const abort = new AbortController(); h.ctx.signal = abort.signal; abort.abort();
  h.message('aborted', 'connection reset');
  await h.fire('agent_end', { messages: [h.entries.at(-1).message] });
  await h.settled();
  assert.equal(h.state().run.paused, true);
  assert.match(h.state().run.reason!, /用户中断/);
  assert.equal(h.retries(), 0);
});

test('explicit permanent failures pause without queuing a Goal retry', async () => {
  for (const error of ['429 insufficient_quota: billing limit exhausted', '401 invalid_api_key', '403 permission_denied']) {
    const h = await publicHost(); await h.enable(); h.setIdle(true);
    await h.startTurn(); h.message('error', error); await h.settled();
    assert.equal(h.state().run.paused, true, error);
    assert.equal(h.retries(), 0, error);
    assert.equal(h.state().run.errorRetries ?? 0, 0, 'no retry is spent');
  }
});

test('mock host: Plan, restore and abort pause persistently; only explicit enable can rearm', async () => {
  const h = await publicHost(); await h.enable(); h.setIdle(true);
  await h.commands.get('plan').handler('start', h.ctx);
  h.setIdle(false);
  assert.equal((await h.call({ action: 'create', title: '不应创建' })).isError, true);
  assert.equal((await h.call({ action: 'list' })).isError, undefined);
  await h.commands.get('plan').handler('off', h.ctx); await h.fire('input', { source: 'rpc', text: '查看信息' });
  assert.equal(await h.settle(), undefined);
  await h.fire('session_tree');
  assert.equal(h.state().run.paused, true);
  await h.fire('input', { source: 'rpc', text: '恢复目标' }); await h.call({ action: 'enable' });
  await h.settle({ outcome: 'aborted' });
  assert.equal(h.state().run.paused, true);
  assert.equal(await h.settle(), undefined, 'a stopped goal never wakes another turn');
});
test('regular Goal tolerates eight no-progress rounds, replans once, then safely pauses', async () => {
  const h = await publicHost(); await h.enable();
  await h.call({ action: 'update', progress: '发现 API 边界', nextStep: '阅读 SDK 示例' });
  assert.equal((await h.settle()).continue, true);
  for (let i = 1; i <= 9; i++) {
    await h.call({ action: 'update', progress: '发现 API 边界', nextStep: '阅读 SDK 示例' });
    const result = await h.settle();
    if (i <= 8) {
      assert.equal(result.continue, true);
      if (i === 8) assert.match(result.entries.at(-1).content, /execute a different feasible approach now/);
    } else assert.notEqual(result?.continue, true, 'passive status metadata is not a continuation');
  }
  assert.match(h.state().run.reason!, /无新进展/);
  assert.equal(h.state().run.used, 9);
});
test('mock host: read-only calls/text do not count as progress; waiting children cause no polling', async (t) => {
  const h = await childHost(); t.after(() => h.close());
  await h.enable();
  const child = await h.spawn('CONTROL REPORT HOLD');
  await h.waitFor((job) => ['starting', 'running'].includes(job.status), child.jobId);
  assert.equal(await h.settle(), undefined);
  assert.equal(h.goalState().run.used, 0);
  assert.equal(h.goalState().run.paused, false);
  await h.call('subagent_send', { recipient: child.jobId, interrupt: true, message: 'Complete the read-only report' });
  await h.waitFor((job) => ['completed', 'failed', 'cancelled', 'interrupted'].includes(job.status), child.jobId);
  await h.goal({ action: 'update', nextStep: '' });
  assert.equal((await h.settle())?.continue, true, 'clearing a note does not request a user wait');
  assert.equal(h.goalState().run.paused, false);
});
test('mock host: failed tools and ordinary reads cannot masquerade as progress', async () => {
  const h = await publicHost(); await h.enable();
  await h.settle();
  await h.fire('tool_execution_end', { toolName: 'read', isError: false });
  await h.fire('tool_execution_end', { toolName: 'write', isError: true });
  await h.call({ action: 'update', nextStep: '下一步' }); await h.settle();
  assert.equal(h.state().run.stalled, 1);
  await h.fire('tool_execution_end', { toolName: 'edit', isError: false });
  await h.call({ action: 'update', nextStep: '下一步' }); await h.settle();
  assert.equal(h.state().run.stalled, 0);
});
test('mock host: native proposed continuation is not double charged; corrupt history stays protected', async () => {
  const h = await publicHost(); await h.enable();
  assert.equal((await h.propose())?.continue, true, 'a public continuation reserves the next paid request');
  assert.equal(await h.settle({ continue: true }), undefined);
  assert.equal(h.state().run.used, 1);
  h.entries.push({ type: 'custom', customType: GOAL_TYPE, data: { version: 99 } });
  await h.fire('session_tree');
  assert.equal((await h.call({ action: 'create', title: '不覆盖历史' })).isError, true);
  assert.equal(h.entries.at(-1).data.version, 99);
});
test('mock host: explicit idle enable reserves and starts once; unknown extra args cannot start work', async () => {
  const h = await publicHost(); await h.enable(); await h.commands.get('goal').handler('disable', h.ctx); h.setIdle(true);
  await h.commands.get('goal').handler('enable extra arguments', h.ctx);
  assert.equal(h.wakes.length, 0);
  await h.commands.get('goal').handler('enable', h.ctx);
  assert.equal(h.wakes.length, 1);
  assert.equal(h.state().run.used, 1);
  assert.match(h.wakes[0].message, /Goal #1[\s\S]*not new user authorization/);
});

test('a failed last paid wake stops at the Goal allowance without extra retries', async () => {
  const h = await publicHost(); await h.enable(1); await h.settle();
  assert.equal(h.state().run.used, 1);
  await h.commands.get('retry').handler('when-error 1h', h.ctx); h.setIdle(true);
  await h.startTurn(); h.message('error'); await h.settled();
  assert.equal(h.retries(), 0);
  assert.equal(h.state().run.paused, true);
  assert.equal(h.state().run.used, 1);
  assert.match(h.state().run.reason!, /上限/);
  assert.equal(await h.settle(), undefined, 'the stopped goal never arms another retry');
});

test('Goal leaves repeated settled failures to the shared retry component', async () => {
  const h = await publicHost(); await h.enable(); await h.commands.get('retry').handler('when-error 1h', h.ctx); h.setIdle(true);
  await h.startTurn(); h.message('error'); await h.settled(); h.message('error'); await h.settled();
  assert.equal(h.retries(), 0);
  assert.equal(h.state().run.errorRetries, undefined);
  assert.equal(await h.settle(), undefined, 'the shared retry component owns recovery');
});

test('mock host: a pending retry belongs to the failed goal, not a newly enabled goal', async () => {
  const h = await publicHost(); await h.enable(); h.setIdle(true);
  await h.startTurn(); h.message('error'); await h.fire('agent_settled');
  await h.call({ action: 'create', title: '第二个目标' });
  await h.commands.get('goal').handler('disable #1', h.ctx);
  await h.commands.get('goal').handler('enable #2', h.ctx);
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(h.retries(), 0, 'the failed request must not be retried for another goal');
  assert.equal(h.state().run.errorRetries, undefined);
});

test('mock host: user input and cancelled navigation retire pending retries', async () => {
  for (const event of ['input', 'session_before_tree', 'session_before_fork', 'session_before_switch']) {
    const h = await publicHost(); await h.enable(); h.setIdle(true);
    await h.startTurn(); h.message('error'); await h.fire('agent_settled');
    await h.fire(event, { source: 'rpc', text: '我来处理' });
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.equal(h.retries(), 0, `${event} takes ownership away from the pending retry`);
  }
});

test('mock host: a user dialog or aborted turn cancels a retry that has not fired', async () => {
  for (const [event, detail] of [['ui_prompt_start', { kind: 'input' }], ['turn_end', { outcome: 'aborted' }]] as const) {
    const h = await publicHost(); await h.enable(); h.setIdle(true);
    await h.startTurn(); h.message('error'); await h.fire('agent_settled');
    if (event === 'turn_end') h.ctx.signal = AbortSignal.abort();
    await h.fire(event, detail);
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.equal(h.retries(), 0);
    assert.equal(h.state().run.paused, true);
  }
});

test('mock host: an automatic retry does not inherit scope-changing authority from user input', async (t) => {
  const h = await publicHost(); await h.enable(); h.setIdle(true);
  await h.fire('input', { source: 'rpc', text: '继续当前范围' });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  await h.startTurn(); h.message('error');
  await h.fire('agent_settled', { aborted: false });
  t.mock.timers.tick(1000);
  assert.equal(h.retries(), 1, 'the automatic Goal recovery is the public equivalent of the retired internal reservation');
  await h.startTurn();
  assert.equal((await h.call({ action: 'update', title: '扩大范围' })).isError, true);
});

test('mock host: Goal reset stops automatic child-report wakes', async () => {
  const h = await publicHost(); await h.enable();
  await h.commands.get('goal').handler('reset', h.ctx);
  assert.equal(await h.settle(), undefined, 'no automatic work after reset');
  assert.deepEqual(h.state().goals, []);
});

test('mock host: explicit goal edit is user-authorized after an automatic round, without refilling budget', async () => {
  const h = await publicHost(); h.setIdle(true); await h.enable(2);
  await h.startTurn([]); // the first automatic round is an admitted paid request
  assert.equal(h.state().run.used, 1);
  assert.equal((await h.call({ action: 'update', title: 'model expanded scope' })).isError, true);
  await h.commands.get('goal').handler('edit #1 User revised title', h.ctx);
  assert.equal(h.state().goals[0]!.title, 'User revised title');
  assert.equal(h.state().run.used, 1);
  assert.equal((await h.call({ action: 'update', maxTurns: 200 })).isError, true);
});

test('continuation drafts preserve prior entries and consume nextStep only on a visible request', async () => {
  const h = await publicHost(); await h.enable(3);
  await h.call({ action: 'update', nextStep: 'verify saved step' });
  const prior = { type: 'custom_message', customType: 'memory-test', content: 'memory baseline', display: false };
  const draft = await h.propose({ entries: [prior] });
  assert.equal(draft.entries[0], prior);
  assert.equal(h.state().run.nextStep, 'verify saved step');
  assert.ok(h.state().run.pendingWake);
  await h.startTurn(draft.entries.map((entry: any) => ({ role: 'custom', ...entry })));
  assert.equal(h.state().run.used, 1);
  assert.equal(h.state().run.pendingWake, undefined);
  assert.equal(h.state().run.nextStep, undefined);
});

test('a filtered continuation retains nextStep and does not restore filtered messages', async () => {
  const h = await publicHost(); await h.enable(3);
  await h.call({ action: 'update', nextStep: 'saved after filter' });
  const draft = await h.propose(); await h.startTurn([]);
  assert.equal(h.state().run.nextStep, 'saved after filter');
  assert.equal(h.state().run.used, 1, 'a real turn still consumes the budget');
  assert.equal(h.wakes.length, 0, 'the workflow never bypasses a context filter');
  await h.fire('context', { messages: draft.entries.map((entry: any) => ({ role: 'custom', ...entry })) });
  assert.equal(h.state().run.nextStep, undefined, 'a later request that really sees the paid step acknowledges it once');
});

test('provisional report and Goal requests share one reservation and rejected drafts refund it', async (t) => {
  const h = await childHost(); t.after(() => h.close());
  await h.enable(3);
  const child = await h.spawn('CONTROL REPORT HOLD');
  await h.waitFor((job) => ['starting', 'running'].includes(job.status), child.jobId);
  h.options.idle = true;
  await h.call('subagent_send', { recipient: child.jobId, interrupt: true, message: 'Complete the read-only report' });
  const deadline = Date.now() + 10000;
  while (!h.sent.some((item) => item.message.customType === AGENT_REPORT_MESSAGE)) { if (Date.now() > deadline) throw new Error('child report did not arrive'); await delay(10); }
  assert.equal(h.goalState().run.used, 1, 'the child report reserves one shared round');
  assert.equal(Boolean(h.goalState().run.pendingWake), true);
  assert.notEqual((await h.emit('agent_before_settle', { outcome: 'completed', continue: true, entries: [] }))?.continue, true, 'do not request another continuation');
  assert.equal(h.goalState().run.used, 1, 'the shared reservation is not charged twice');
  await h.emit('agent_settled', { aborted: false });
  assert.equal(h.goalState().run.used, 0);
  assert.equal(h.goalState().run.pendingWake, undefined);
  assert.match(h.goalState().run.nextStep!, /推进目标/);
});

test('repeated rejected drafts stop without spending confirmed turns or counting false stalls', async () => {
  const h = await publicHost(); h.setIdle(true); await h.enable(4);
  await h.startTurn([]); // one actual, confirmed round
  for (let index = 0; index < 3; index++) {
    await h.propose(); await h.fire('agent_settled');
  }
  assert.equal(h.state().run.used, 1, 'refunds never refill a confirmed round');
  assert.equal(h.state().run.stalled, 1, 'three discarded proposals are not three completed rounds');
  assert.equal(h.state().run.paused, true);
  assert.match(h.state().run.reason!, /未被执行/);
});

test('explicit enable wakes an active idle goal once without refilling or changing the target', async () => {
  const h = await publicHost(); await h.enable(4);
  await h.settle(); // First actual round consumed the initial nextStep.
  assert.equal(h.state().run.used, 1);
  h.setIdle(true);
  await h.commands.get('goal').handler('enable #1', h.ctx);
  assert.equal(h.wakes.length, 1);
  assert.match(h.wakes[0].message, /Goal #1 2\/4.*Advance goal/);
  assert.equal(h.state().run.used, 2);
  await h.commands.get('goal').handler('enable #1', h.ctx);
  assert.equal(h.wakes.length, 1, 'an already proposed wake is not sent twice');
  await h.startTurn([{ role: 'user', content: h.wakes[0].message }]);
  h.setIdle(false);
  await h.commands.get('goal').handler('enable #1', h.ctx);
  assert.equal(h.wakes.length, 1, 'a running parent needs no extra wake');
});

test('an explicit re-enable starts a fresh rejection counter without stale automatic pauses', async () => {
  const h = await publicHost(); await h.enable(4);
  for (let index = 0; index < 2; index++) { await h.propose(); await h.fire('agent_settled'); }
  await h.commands.get('goal').handler('disable', h.ctx);
  await h.commands.get('goal').handler('enable', h.ctx);
  await h.propose(); await h.fire('agent_settled');
  assert.equal(h.state().run.paused, false);
  assert.equal(h.state().run.used, 0);
  await h.fire('session_shutdown');
});

test('successful compaction reissues an unstarted step once with its original budget', async () => {
  const h = await publicHost(); await h.enable(3);
  await h.call({ action: 'update', nextStep: 'resume exact step' });
  await h.propose();
  await h.fire('session_before_compact', { reason: 'threshold', willRetry: false });
  assert.equal(h.state().run.used, 0);
  assert.equal(h.state().run.nextStep, 'resume exact step');
  h.setIdle(true);
  await h.fire('session_compact', { reason: 'threshold', willRetry: false });
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(h.wakes.length, 1);
  assert.match(h.wakes[0].message.content, /resume exact step/);
  await h.startTurn([h.wakes[0].message]);
  assert.equal(h.state().run.used, 1);
  assert.equal(h.state().run.nextStep, undefined);
  await h.fire('agent_settled'); await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(h.wakes.filter((wake) => wake.message.content?.includes('resume exact step')).length, 1, 'the consumed action must not be replayed');
  assert.match(h.wakes[1].message.content, /Goal #1.*goal get/, 'a subsequent settled round can reassess the still-active objective');
  await h.fire('session_shutdown');
});

test('manual compaction resumes after slow completion handlers release host idle, without another settled event', async () => {
  const h = await publicHost(); await h.enable(3);
  await h.call({ action: 'update', nextStep: 'resume after slow compaction tail' });
  await h.fire('session_before_compact', { reason: 'manual', willRetry: false });
  await h.fire('session_compact', { reason: 'manual', willRetry: false });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(h.wakes.length, 0, 'session_compact fires before the host becomes idle');
  h.setIdle(true);
  await new Promise((resolve) => setTimeout(resolve, 80));
  try {
    assert.equal(h.wakes.length, 1, 'a missed idle check must retain and retry the wake intent');
    assert.match(h.wakes[0].message.content, /resume after slow compaction tail/);
    assert.equal(h.state().run.used, 1);
  } finally { await h.fire('session_shutdown'); }
});

test('user disable during a slow compaction completion cancels the deferred wake and restores no execution', async () => {
  const h = await publicHost(); await h.enable(3);
  await h.fire('session_before_compact', { reason: 'manual', willRetry: false });
  await h.fire('session_compact', { reason: 'manual', willRetry: false });
  await new Promise((resolve) => setTimeout(resolve, 20));
  await h.commands.get('goal').handler('disable', h.ctx);
  h.setIdle(true);
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(h.wakes.length, 0);
  assert.equal(h.state().run.paused, true);
  assert.equal(h.state().run.used, 0);
});

test('successful shell work prevents a false no-progress pause when no Todo or progress text changes', async () => {
  const h = await publicHost(); await h.enable(6); await h.settle();
  await h.fire('tool_execution_end', { toolName: 'bash', isError: false });
  await h.propose();
  assert.equal(h.state().run.stalled, 0, 'shell tests and edits are actual work, not a text-only turn');
  await h.fire('session_shutdown');
});

test('a pre-compaction error cannot strand an active Goal waiting for shared recovery', async () => {
  const h = await publicHost(); await h.enable(4); await h.commands.get('retry').handler('when-error 1h', h.ctx); h.setIdle(true);
  await h.startTurn(); h.message('error'); await h.settled();
  assert.equal(h.retries(), 0);
  await h.fire('session_before_compact', { reason: 'manual', willRetry: false });
  h.entries.push({ type: 'compaction', id: 'compact-after-retired-failure' });
  await h.fire('session_compact', { reason: 'manual', willRetry: false });
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(h.state().run.paused, false);
  assert.equal(h.retries(), 0, 'Goal never creates an error timer of its own');
  assert.equal(h.wakes.filter((wake) => wake.message?.customType === GOAL_CONTINUE_MESSAGE).length, 1, 'the retained retry id must not suppress continuation forever');
});

test('a post-compaction error still waits for shared recovery and user pauses stay stopped', async () => {
  const h = await publicHost(); await h.enable(4); await h.commands.get('retry').handler('when-error 1h', h.ctx); h.setIdle(true);
  await h.startTurn(); h.message('error');
  await h.fire('session_before_compact', { reason: 'overflow', willRetry: true });
  h.entries.push({ type: 'compaction', id: 'successful-overflow-boundary' });
  await h.fire('session_compact', { reason: 'overflow', willRetry: true });
  h.message('error'); // This is a new failed request after the successful compaction.
  await h.settled();
  assert.equal(h.retries(), 0);
  assert.equal(h.state().run.errorRetries, undefined);
  assert.equal(await h.settle(), undefined, 'the shared retry component holds recovery');
  await h.commands.get('goal').handler('disable', h.ctx);
  await h.fire('agent_settled');
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(h.state().run.paused, true);
  assert.equal(h.retries(), 0);
});

test('native overflow retry takes priority over an idle fallback wake after compaction', async () => {
  const h = await publicHost(); await h.enable(3);
  await h.fire('session_before_compact', { reason: 'overflow', willRetry: true });
  h.setIdle(true);
  await h.fire('session_compact', { reason: 'overflow', willRetry: true });
  await h.startTurn([]); // Pi natively resumed; no Goal reservation exists.
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(h.wakes.length, 0);
  assert.equal(h.state().run.used, 0);
});

test('failed compaction and a user abort during compaction remain stopped', async () => {
  for (const aborted of [false, true]) {
    const h = await publicHost(); await h.enable(3);
    await h.call({ action: 'update', nextStep: 'kept on failure' }); await h.propose();
    await h.fire('session_before_compact', { reason: 'threshold', willRetry: false });
    await h.fire('session_compact_failed', { aborted });
    h.setIdle(true); await h.fire('agent_settled'); await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(h.state().run.paused, true);
    assert.equal(h.state().run.used, 0);
    assert.equal(h.state().run.nextStep, 'kept on failure');
    assert.equal(h.wakes.length, 0);
  }
});

test('compaction never rearms user-disable, dialogs, Plan, restore or exhausted budget', async () => {
  for (const kind of ['disable', 'dialog', 'plan', 'restore', 'budget']) {
    const h = await publicHost();
    await h.enable(kind === 'budget' ? 1 : 3);
    if (kind === 'budget') { await h.propose(); await h.startTurn([]); } // a confirmed paid round with no refundable draft
    if (kind === 'disable') await h.call({ action: 'disable' });
    else if (kind === 'dialog') await h.fire('ui_prompt_start', { kind: 'input' });
    else if (kind === 'plan') { h.setIdle(true); await h.commands.get('plan').handler('start', h.ctx); h.setIdle(false); }
    else if (kind === 'restore') await h.fire('session_tree');
    const used = h.state().run.used;
    await h.fire('session_before_compact', { reason: 'overflow', willRetry: true });
    await h.fire('session_compact', { reason: 'overflow', willRetry: true });
    h.setIdle(true); await h.fire('agent_settled'); await new Promise((resolve) => setTimeout(resolve, 80));
    assert.equal((await h.call({ action: 'list' })).details.goalState.run.paused, true, kind);
    assert.equal(h.state().run.used, used, kind);
    assert.equal(h.wakes.length, 0, kind);
  }
});

test('a settled active Goal uses the idle fallback if the before-settle continuation path was skipped', async () => {
  const h = await publicHost(); await h.enable(4); await h.settle();
  await h.call({ action: 'update', progress: 'first stage verified', nextStep: 'second stage exact action' });
  h.setIdle(true); await h.fire('agent_settled');
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(h.wakes.length, 1);
  assert.match(h.wakes[0].message.content, /second stage exact action/);
  assert.equal(h.state().run.used, 2);
  assert.equal(h.state().run.stalled, 0);
  await h.startTurn([h.wakes[0].message]);
  await h.commands.get('goal').handler('disable', h.ctx);
  await h.fire('agent_settled'); await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(h.wakes.length, 1, 'a stopped goal never enters the fallback');
});

test('idle fallback waits for real children without polling and resumes the objective when none remain', async (t) => {
  const h = await childHost(); t.after(() => h.close());
  await h.enable(4); await h.settle();
  const child = await h.spawn('CONTROL REPORT HOLD');
  await h.waitFor((job) => ['starting', 'running'].includes(job.status), child.jobId);
  h.options.idle = true;
  await h.emit('agent_settled', { aborted: false });
  await delay(120);
  assert.equal(h.sent.filter((item) => item.message.customType === GOAL_CONTINUE_MESSAGE).length, 0);
  assert.equal(h.goalState().run.paused, false);
  h.options.idle = false;
  await h.call('subagent_send', { recipient: child.jobId, interrupt: true, message: 'Complete the read-only report' });
  await h.waitFor((job) => ['completed', 'failed', 'cancelled', 'interrupted'].includes(job.status), child.jobId);
  h.options.idle = true;
  await h.emit('agent_settled', { aborted: false });
  await delay(120);
  const wakes = h.sent.filter((item) => item.message.customType === GOAL_CONTINUE_MESSAGE);
  assert.equal(wakes.length, 1);
  assert.equal(h.goalState().run.paused, false);
  assert.match(wakes[0].message.content, /Goal #1.*goal get/);
});

test('an enabled Goal continues its objective when Todos are done and the model omits nextStep', async () => {
  const h = await publicHost(); await h.enable(6); await h.settle();
  const todo = (params: object) => h.tools.get('todo').execute('test', params, undefined, undefined, h.ctx);
  await todo({ action: 'create', subject: 'finished phase' });
  await todo({ action: 'update', id: 1, status: 'completed' });
  await h.call({ action: 'update', progress: 'phase verified, objective still pending' });
  h.message('stop');
  const next = await h.propose();
  assert.equal(next?.continue, true, 'a normal final answer is not a Goal disable or completion');
  assert.match(next.entries.at(-1).content, /Goal #1.*goal get/);
  assert.equal(h.state().run.paused, false);
  assert.equal(h.state().run.used, 2);
  assert.equal(h.state().focusId, 1);
  await h.startTurn(next.entries);
  await h.fire('session_shutdown');
});

test('a child waiting for an answer gets a Goal decision instead of an indefinite child wait', async (t) => {
  const h = await childHost(); t.after(() => h.close());
  await h.enable(6); await h.settle();
  const child = await h.spawn('CONTROL QUESTION');
  await h.waitFor((job) => job.status === 'waiting', child.jobId);
  const next = await h.settle();
  assert.equal(next?.continue, true);
  assert.match(next.entries.at(-1).content, /Inspect child a1.*subagent_inspect/);
  await h.startTurn(next.entries);
});

test('a substituted initial question consumes the placeholder and then verifies the returned Todo', async (t) => {
  const h = await childHost(); t.after(() => h.close());
  const todo = (params: object) => h.call('todo', params) as Promise<any>;
  await h.enable(6);
  await todo({ action: 'create', subject: 'returned work' });
  await todo({ action: 'update', id: 1, status: 'in_progress' });
  const child = await h.spawn('CONTROL QUESTION', { todoId: 1 });
  await h.waitFor((job) => job.status === 'waiting', child.jobId);
  const question = await h.settle();
  assert.match(question.entries.at(-1).content, /Inspect child a1.*subagent_inspect/);
  await h.startTurn(question.entries);
  assert.equal(h.goalState().run.nextStep, undefined, 'the initial generic placeholder is not replayed after a substituted step');
  await h.call('subagent_send', { recipient: child.jobId, interrupt: true, message: 'Complete the read-only work' });
  await h.waitFor((job) => job.status === 'completed', child.jobId);
  const returned = await h.settle();
  assert.match(returned.entries.at(-1).content, /Verify Task #1/);
  await h.startTurn(returned.entries);
});

test('a pending question has priority but preserves the saved independent next step', async (t) => {
  const h = await childHost(); t.after(() => h.close());
  await h.enable(6); await h.settle();
  await h.goal({ action: 'update', nextStep: 'saved independent action' });
  const child = await h.spawn('CONTROL QUESTION');
  await h.waitFor((job) => job.status === 'waiting', child.jobId);
  const question = await h.settle();
  assert.match(question.entries.at(-1).content, /Inspect child a1.*subagent_inspect/);
  await h.startTurn(question.entries);
  assert.equal(h.goalState().run.nextStep, 'saved independent action');
  await h.call('subagent_send', { recipient: child.jobId, interrupt: true, message: 'Complete the read-only work' });
  await h.waitFor((job) => job.status === 'completed', child.jobId);
  const next = await h.settle();
  assert.match(next.entries.at(-1).content, /saved independent action/);
  await h.startTurn(next.entries);
});

test('the wait timeout exemption belongs only to the child that was actually waited on', async (t) => {
  const h = await childHost(); t.after(() => h.close());
  await h.enable(6); await h.settle();
  const a1 = await h.spawn('CONTROL REPORT HOLD');
  const a2 = await h.spawn('CONTROL REPORT HOLD');
  await h.waitFor((job) => ['starting', 'running'].includes(job.status), a1.jobId);
  await h.waitFor((job) => ['starting', 'running'].includes(job.status), a2.jobId);
  await h.emit('tool_execution_end', { toolName: 'subagent_inspect', isError: false, result: { details: { id: a1.jobId, status: 'running', timedOut: true } } });
  await h.call('subagent_send', { recipient: a1.jobId, interrupt: true, message: 'Complete the read-only report' });
  await h.waitFor((job) => ['completed', 'failed', 'cancelled', 'interrupted'].includes(job.status), a1.jobId);
  assert.notEqual((await h.settle())?.continue, true);
  assert.equal(h.goalState().run.stalled, 1, 'an unrelated running child cannot suppress a counted round');
});

test('real child wait timeouts are not stalled automatic work and results still permit continuation', async (t) => {
  const h = await childHost(); t.after(() => h.close());
  await h.enable(10); await h.settle();
  const child = await h.spawn('CONTROL REPORT HOLD');
  await h.waitFor((job) => ['starting', 'running'].includes(job.status), child.jobId);
  for (let index = 0; index < 4; index++) {
    await h.emit('tool_execution_end', { toolName: 'subagent_inspect', isError: false, result: { details: { id: child.jobId, status: 'running', timedOut: true } } });
    assert.notEqual((await h.settle())?.continue, true, 'passive metadata must not poll a model while the child runs');
    assert.equal(h.goalState().run.paused, false);
    assert.equal(h.goalState().run.stalled, 0, 'an acknowledged wait is not an unproductive execution attempt');
  }
  await h.call('subagent_send', { recipient: child.jobId, interrupt: true, message: 'Complete the read-only report' });
  await h.waitFor((job) => ['completed', 'failed', 'cancelled', 'interrupted'].includes(job.status), child.jobId);
  const next = await h.settle();
  assert.equal(next?.continue, true, 'the completed child reopens the objective decision');
  await h.startTurn(next.entries);
});

test('completed non-stale child work is selected for verification instead of redispatch', async (t) => {
  const h = await childHost(); t.after(() => h.close());
  const todo = (params: object) => h.call('todo', params) as Promise<any>;
  await h.enable();
  await todo({ action: 'create', subject: 'ready task' });
  await todo({ action: 'create', subject: 'returned task' });
  await todo({ action: 'update', id: 2, status: 'in_progress' });
  const child = await h.spawn('TEST CALL bash {"command":"printf CHILD-DONE"}', { todoId: 2 });
  await h.waitFor((job) => job.status === 'completed', child.jobId);
  await h.goal({ action: 'update', nextStep: ' ' });
  const proposal = await h.settle();
  assert.match(proposal.entries.at(-1).content, /Verify Task #2.*subagent_inspect/);
  await h.startTurn(proposal.entries);
  await todo({ action: 'update', id: 2, description: 'revised after the report' });
  const stale = await h.settle();
  assert.match(stale.entries.at(-1).content, /Advance and verify Task #1/);
});
}

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

test('actual Pi: native retry recovers first without spending a /retry attempt', { timeout: 30000 }, async (t) => {
  const root = await agentRoot(undefined, { enabled: true, maxRetries: 3, baseDelayMs: 1 });
  const client = await IsolatedClient.start(root, 'goal-native-recovery'); t.after(() => client.close());
  await create(client, '出错重试测试');
  await client.until(() => latest(client)?.goals[0]?.status === 'completed');
  assert.equal(client.records.filter((record) => record.type === 'auto_retry_start').length, 2);
  assert.equal((await retryRequests(client)).length, 0);
});
}

test('ticket15 the six message types carry their new dot-segmented keys', async () => {
  const { readFileSync, readdirSync } = await import('node:fs');
  const { resolve } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const expected: [string, string][] = [
    [AGENT_REPORT_MESSAGE, 'pi-dag-workflow.agents.report'],
    [GOAL_RETRY_MESSAGE, 'pi-dag-workflow.goal.retry'],
    [GOAL_CONTINUE_MESSAGE, 'pi-dag-workflow.goal.continue'],
    [RETRY_REQUEST_MESSAGE, 'pi-dag-workflow.retry.request'],
    [TEAM_MESSAGE, 'pi-dag-workflow.team.message'],
    [TEAM_MEMBERSHIP_MESSAGE, 'pi-dag-workflow.team.membership'],
  ];
  for (const [constant, value] of expected) assert.equal(constant, value, `${value} keeps its key`);
  // The legacy keys are gone from every source file, not just from the ones a flow happens to hit.
  const src = fileURLToPath(new URL('../src/', import.meta.url));
  const legacy = ['pi-dag-workflow.agent-report', 'pi-dag-workflow.goal-retry', 'pi-dag-workflow.goal-continue', 'pi-dag-workflow.retry-request', 'team-message', 'team-membership'];
  for (const file of (readdirSync(src, { recursive: true }) as string[]).filter(name => name.endsWith('.ts'))) {
    const text = readFileSync(resolve(src, file), 'utf8');
    for (const key of legacy) assert.equal(text.includes(key), false, `${file} still carries ${key}`);
  }
  // And the persisted state keys are untouched.
  for (const key of ['pi-dag-workflow.state', 'pi-dag-workflow.goal-checkpoint', 'pi-dag-workflow.team-pointer']) {
    const found = (readdirSync(src, { recursive: true }) as string[]).some(file => file.endsWith('.ts') && readFileSync(resolve(src, file), 'utf8').includes(key));
    assert.ok(found, `${key} is still a state key`);
  }
});
