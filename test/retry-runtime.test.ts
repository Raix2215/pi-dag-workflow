import { RETRY_MESSAGE, RETRY_TYPE, PLAN_TYPE, GOAL_TYPE } from './fixtures/public-records.ts';
import { retryHost } from './fixtures/retry-public-host.ts';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { IsolatedClient } from './fixtures/isolated-client.ts';
import { GOAL_RETRY_MESSAGE, GOAL_CONTINUE_MESSAGE, RETRY_REQUEST_MESSAGE } from './fixtures/public-records.ts';


const disconnected = 'Error: Codex error: stream error: stream disconnected before completion: stream closed before response.completed';
for (const [shape, stopReason, settled] of [['A', 'error', false], ['B', 'error', true], ['C', 'aborted', null]] as const) test(`U7.1 ${shape}: error text is provider evidence regardless of the settlement flag`, async t => {
  const h = await retryHost(t); await h.cmd('when-error 1s count 2');
  await h.failure(disconnected, settled, stopReason);
  assert.match(await h.status(), /阶段：等待重试/);
  assert.match(await h.status(), /stream disconnected/);
  h.tick(999); await h.flush(); assert.equal(h.sends.filter(item => item.message.customType === RETRY_MESSAGE).length, 0);
  h.tick(1); await h.flush(); assert.equal(h.sends.filter(item => item.message.customType === RETRY_MESSAGE).length, 1);
});

test('U7.1 explicit aborted signal outranks provider text and survives reload/configuration', async t => {
  const h = await retryHost(t); await h.cmd('when-error 1s'); h.ctx.signal = AbortSignal.abort();
  await h.failure(disconnected, false, 'error'); h.tick(10000); await h.flush();
  assert.match(await h.status(), /用户中断/); assert.equal(h.sends.length, 0);
  h.ctx.signal = undefined; await h.fire('session_tree'); await h.cmd('on'); h.tick(10000);
  assert.equal(h.sends.length, 0); assert.ok(h.state().cancelledFailure);
});

for (const stopReason of ['error', 'aborted']) test(`U7.1 empty ${stopReason} outcome stays conservative without a signal`, async t => {
  const h = await retryHost(t); await h.cmd('when-error 1s'); await h.failure('', null, stopReason);
  assert.match(await h.status(), /无法确认是否为用户取消/); h.tick(10000); await h.flush(); assert.equal(h.sends.length, 0);
  await h.fire('session_tree'); await h.cmd('when-error 1s'); h.tick(10000); assert.equal(h.sends.length, 0);
});

test('U7.1 D: on and enabled restoration persist default intervals without overriding explicit policy', async t => {
  const h = await retryHost(t); await h.cmd('on');
  assert.deepEqual(h.state().settings, { intervals: [30000, 120000, 300000, 900000], resumeAfterCompaction: true });
  assert.match(await h.status(), /重试间隔：30s,2m,5m,15m/); assert.match(await h.status(), /不限/);
  await h.failure(disconnected, true); assert.match(await h.status(), /等待重试/);
  h.tick(29999); await h.flush(); assert.equal(h.sends.length, 0); h.tick(1); await h.flush(); assert.equal(h.sends.filter(item => item.message.customType === RETRY_MESSAGE).length, 1);
  assert.doesNotMatch(h.sends[0].message.content, /\p{Script=Han}/u, 'model recovery instructions do not use the Chinese UI translator');
  await h.cmd('when-error 5m count 3'); await h.cmd('off'); await h.cmd('on'); await h.fire('session_tree');
  assert.deepEqual(h.state().settings, { intervals: [300000], count: 3, resumeAfterCompaction: true });
  h.entries.push({ type: 'custom', customType: RETRY_TYPE, data: { version: 1, enabled: true, attempts: 0, skipped: 0 } });
  await h.fire('session_tree'); assert.deepEqual(h.state().settings, { intervals: [30000, 120000, 300000, 900000], resumeAfterCompaction: true });
  assert.equal(h.entries.at(-1).customType, RETRY_TYPE, 'normalized defaults are saved in the branch');
  assert.match(await h.status(), /阶段：等待下一次错误/);
});

for (const mode of ['normal', 'nopause', 'autoresearch']) for (const enabled of [false, true]) test(`U7.1 recovery ownership and accounting: ${mode}, Retry ${enabled ? 'on' : 'off'}`, async t => {
  const h = await retryHost(t, ['goal', 'retry']), goal = () => h.entries.findLast(entry => entry.customType === GOAL_TYPE)!.data;
  h.setIdle(false); await h.call('goal', { action: 'create', title: 'Recovery ownership', maxTurns: 50 });
  if (mode !== 'normal') await h.commands.get('goal').handler(`${mode} #1 on`, h.ctx);
  await h.fire('input', { text: 'Enable recovery test', source: 'rpc' }); await h.call('goal', { action: 'enable', id: 1 }); await h.fire('turn_start'); h.setIdle(true);
  await h.failure(disconnected); h.tick(999); await h.flush(); assert.equal(goal().run.errorRetries ?? 0, 0);
  h.tick(1); await h.flush(); assert.equal(goal().run.errorRetries, 1);
  assert.equal(h.sends.filter(item => item.message.customType === GOAL_RETRY_MESSAGE).length, 1);
  assert.doesNotMatch(h.sends.find(item => item.message.customType === GOAL_RETRY_MESSAGE)!.message.content, /\p{Script=Han}/u, 'Goal recovery guidance is independent of UI locale');
  await h.fire('turn_start');
  if (enabled) { h.setIdle(false); await h.cmd('on'); h.setIdle(true); }
  await h.failure(disconnected, enabled ? true : false);
  if (enabled) {
    assert.equal(goal().run.paused, true); assert.equal(goal().run.errorRetries, 1);
    assert.match(goal().run.reason, /\/retry status.*\/retry off.*\/goal enable/);
    h.tick(30000); await h.flush(); assert.equal(goal().run.errorRetries, 1);
    assert.equal(h.sends.filter(item => item.message.customType === GOAL_RETRY_MESSAGE).length, 1);
    assert.equal(h.sends.filter(item => item.message.customType === RETRY_MESSAGE).length, 1);
    await h.fire('turn_start'); await h.failure(disconnected); const mark = h.sends.length;
    await h.commands.get('goal').handler('enable #1', h.ctx); h.tick(30000); await h.flush();
    assert.equal(h.sends.slice(mark).filter(item => item.message.customType === RETRY_MESSAGE).length, 0, 'explicit Goal enable cancels pending Retry');
  } else {
    for (const [index, delay] of [2000, 4000, 8000, 16000].entries()) {
      h.tick(delay - 1); await h.flush(); assert.equal(goal().run.errorRetries, index + 1);
      h.tick(1); await h.flush(); assert.equal(goal().run.errorRetries, index + 2);
      await h.fire('turn_start'); await h.failure(disconnected);
    }
    assert.equal(goal().run.paused, true); assert.match(goal().run.reason, /重试次数已用完/);
    assert.equal(goal().run.errorRetries, 5); assert.equal(h.sends.filter(item => item.message.customType === RETRY_MESSAGE).length, 0);
  }
});

for (const configured of [false, true]) for (const language of ['zh-CN', 'en'] as const) test(`U7.1 quota pause offers executable ${configured ? 'saved' : 'new'} Retry commands (${language})`, async t => {
  const h = await retryHost(t, ['goal', 'retry'], language), goal = () => h.entries.findLast(entry => entry.customType === GOAL_TYPE)!.data;
  if (configured) { await h.cmd('when-error 5m'); await h.cmd('off'); }
  h.setIdle(false); await h.call('goal', { action: 'create', title: 'Quota ownership', maxTurns: 5 });
  await h.fire('input', { text: 'Enable quota test', source: 'rpc' }); await h.call('goal', { action: 'enable', id: 1 }); await h.fire('turn_start'); h.setIdle(true);
  await h.failure('429 insufficient_quota: billing limit exhausted');
  assert.equal(goal().run.paused, true); assert.ok(goal().run.reason.includes(configured ? '/retry on' : '/retry when-error 5m'));
  assert.ok(h.notices.some(text => text.includes('/goal enable')));
  h.tick(1000000); await h.flush(); assert.equal(h.sends.length, 0); assert.equal(goal().run.errorRetries ?? 0, 0);
});

test('U7.4 old branch settings normalize to true and persist exactly once', async t => {
  const h = await retryHost(t);
  h.entries.push({ type: 'custom', customType: RETRY_TYPE, data: { version: 1, enabled: false, attempts: 2, skipped: 3, settings: { intervals: [5000], count: 4 } } });
  const before = h.entries.length; await h.fire('session_tree');
  assert.equal(h.entries.length, before + 1); assert.deepEqual(h.state().settings, { intervals: [5000], count: 4, resumeAfterCompaction: true });
  const normalized = h.entries.length; await h.fire('session_tree'); await h.cmd('status');
  assert.equal(h.entries.length, normalized, 'repeated restore/status does not rewrite normalized settings');
  assert.match(await h.status(), /压缩后自动继续：开启/);
  assert.equal(h.state().enabled, false); assert.equal(h.state().attempts, 2); assert.equal(h.sends.length, 0);
});

for (const resume of [true, false]) test(`U7.4 handed-off compaction ${resume ? 'continues once without replay' : 'stays paused with executable commands'}`, async t => {
  const h = await retryHost(t, ['goal', 'retry']), goal = () => h.entries.findLast(entry => entry.customType === GOAL_TYPE)!.data;
  await h.cmd('when-error 10s');
  if (!resume) { h.answers.push('压缩后自动继续', '退出菜单'); await h.menu(); }
  h.setIdle(false); await h.call('goal', { action: 'create', title: 'Keep approved objective', maxTurns: 5 });
  await h.fire('input', { source: 'rpc', text: 'Enable approved objective' }); await h.call('goal', { action: 'enable', id: 1 });
  h.entries.push({ type: 'message', id: 'unreliable-original', message: { role: 'user', content: 'ORIGINAL_FAILURE_INPUT_DO_NOT_REPLAY' } });
  await h.fire('turn_start'); h.setIdle(true); await h.failure('ECONNRESET');
  assert.equal(goal().run.paused, true); assert.match(goal().run.reason, /已移交自动重试/);
  await h.fire('session_before_compact', { willRetry: false });
  h.entries.push({ type: 'compaction', id: 'new-compacted-context' });
  await h.fire('session_compact', { willRetry: false }); await h.fire('session_compact', { willRetry: false });
  h.tick(1000); await h.flush();
  assert.equal(goal().run.paused, !resume); assert.equal(goal().run.errorRetries ?? 0, 0);
  assert.equal(h.sends.filter(item => item.message.customType === RETRY_MESSAGE).length, 0);
  assert.equal(h.sends.filter(item => item.message.customType === GOAL_RETRY_MESSAGE).length, 0);
  const continued = h.sends.filter(item => item.message.customType === GOAL_CONTINUE_MESSAGE);
  assert.equal(continued.length, resume ? 1 : 0);
  if (resume) { assert.doesNotMatch(continued[0].message.content, /\p{Script=Han}/u, 'generated Goal continuation instructions stay English'); assert.match(continued[0].message.content, /Keep approved objective/); assert.doesNotMatch(continued[0].message.content, /ORIGINAL_FAILURE_INPUT_DO_NOT_REPLAY/); }
  else { assert.match(goal().run.reason, /上下文已压缩.*\/retry on.*\/goal enable/); assert.ok(h.notices.some(text => /\/retry on.*\/goal enable/.test(text))); }
  h.tick(120000); await h.flush(); assert.equal(h.sends.filter(item => item.options?.triggerTurn === true).length, resume ? 1 : 0, 'no old recovery timer or second continuation');
  assert.equal(h.state().settings.resumeAfterCompaction, resume);
});

for (const settledBefore of [true, false]) test(`Retry retains a model failure across compaction (settled before=${settledBefore})`, async t => {
  const h = await retryHost(t); await h.cmd('when-error 1s count 2');
  await h.failure('unknown provider for model missing-model'); h.tick(1000); await h.fire('turn_start');
  assert.equal(h.state().attempts, 1);
  h.entries.push({ type: 'message', id: 'failure-before-compaction', message: { role: 'assistant', stopReason: 'error', errorMessage: 'unknown provider for model missing-model' } });
  if (settledBefore) await h.fire('agent_settled', { aborted: false });
  h.setIdle(false); await h.fire('session_before_compact', { willRetry: false });
  h.tick(10000); await h.flush(); assert.equal(h.sends.length, 1, 'the old timer cannot fire during compaction');
  const compactionEntry = { type: 'compaction', id: 'compacted-failure', summary: 'Context compressed', firstKeptEntryId: 'failure-before-compaction', tokensBefore: 100000 };
  h.entries.push(compactionEntry); h.setIdle(true);
  await h.fire('session_compact', { compactionEntry, willRetry: false });
  await h.fire('agent_settled', { aborted: false });
  h.tick(1000); await h.flush();
  assert.equal(h.sends.filter(item => item.message.customType === RETRY_MESSAGE).length, 2, 'the failed model request must receive one post-compaction retry');
  await h.fire('turn_start'); assert.equal(h.state().attempts, 2, 'compaction does not refill the attempt limit');
  await h.fire('session_compact', { compactionEntry, willRetry: false }); await h.fire('agent_settled', { aborted: false });
  h.tick(120000); await h.flush(); assert.equal(h.sends.length, 2, 'duplicate compaction/settlement does not create another retry');
});

test('Retry compaction recovery respects its setting, native recovery and intervening input', async t => {
  const h = await retryHost(t); await h.cmd('when-error 1s count 2');
  let serial = 0;
  const compact = async (willRetry = false, interrupted = false) => {
    await h.fire('session_before_compact', { willRetry });
    if (interrupted) await h.fire('input', { source: 'rpc', text: 'New user work' });
    const compactionEntry = { type: 'compaction', id: `guarded-compaction-${++serial}` };
    h.entries.push(compactionEntry); await h.fire('session_compact', { compactionEntry, willRetry });
    await h.fire('agent_settled', { aborted: false }); h.tick(2000); await h.flush();
  };
  h.answers.push('压缩后自动继续', '退出菜单'); await h.menu();
  assert.equal(h.state().settings.resumeAfterCompaction, false);
  await h.failure(); await compact(); assert.equal(h.sends.length, 0, 'saved compaction continuation off stays off');
  h.answers.push('压缩后自动继续', '退出菜单'); await h.menu();
  assert.equal(h.state().settings.resumeAfterCompaction, true);
  await h.failure(); await compact(true); assert.equal(h.sends.length, 0, 'Pi native recovery owns its next request');
  await h.failure(); await compact(false, true); assert.equal(h.sends.length, 0, 'new user input invalidates the captured failure');
});

for (const resume of [true, false]) for (const during of [false, true]) for (const willRetry of [false, true]) test(`U7.4 user pause survives compaction: setting=${resume}, during=${during}, willRetry=${willRetry}`, async t => {
  const h = await retryHost(t, ['goal', 'retry']), goal = () => h.entries.findLast(entry => entry.customType === GOAL_TYPE)!.data;
  await h.cmd('when-error 10s'); if (!resume) { h.answers.push('压缩后自动继续', '退出菜单'); await h.menu(); }
  h.setIdle(false); await h.call('goal', { action: 'create', title: 'User owns pause', maxTurns: 5 }); await h.fire('input', { source: 'rpc', text: 'Enable' }); await h.call('goal', { action: 'enable', id: 1 }); await h.fire('turn_start'); h.setIdle(true);
  await h.failure('stream disconnected'); assert.match(goal().run.reason, /已移交自动重试/);
  if (during) await h.fire('session_before_compact', { willRetry });
  await h.commands.get('goal').handler('disable #1', h.ctx);
  const paused = structuredClone(goal());
  if (!during) await h.fire('session_before_compact', { willRetry });
  h.entries.push({ type: 'compaction', id: 'after-user-pause' }); await h.fire('session_compact', { willRetry }); h.tick(120000); await h.flush();
  assert.equal(goal().run.paused, true); assert.equal(goal().run.reason, paused.run.reason); assert.equal(goal().run.used, paused.run.used);
  assert.equal(h.sends.length, 0, 'no continuation or recovery may undo the user pause');
});

for (const language of ['zh-CN', 'en'] as const) test(`ticket01 Retry start-failure reason provides inspect/stop commands (${language})`, async t => {
  const h = await retryHost(t, ['retry'], language); await h.cmd('when-error 1s'); await h.failure('provider failed');
  h.silentSend(); h.tick(1000); await h.fire('agent_settled', { aborted: false });
  const status = await h.status(); assert.match(status, /\/retry status/); assert.match(status, /\/retry off/);
  assert.doesNotMatch(status, /请(?:检查|查看|设置|确认)|check the settings|check the model or extension error/i);
  if (language === 'en') assert.doesNotMatch(status, /\p{Script=Han}/u);
});

for (const language of ['zh-CN', 'en'] as const) test(`ticket01 rejected Goal continuation provides the explicit resume command (${language})`, async t => {
  const h = await retryHost(t, ['goal'], language), goal = () => h.entries.findLast(entry => entry.customType === GOAL_TYPE)!.data;
  h.setIdle(false); await h.call('goal', { action: 'create', title: 'Rejected continuation copy', maxTurns: 5 });
  await h.fire('input', { source: 'rpc', text: 'Enable' }); await h.call('goal', { action: 'enable', id: 1 });
  h.setIdle(true);
  for (let attempt = 0; attempt < 3; attempt++) { await h.fire('agent_before_settle', { outcome: 'completed', continue: false, entries: [] }); await h.fire('agent_settled', { aborted: false }); }
  assert.equal(goal().run.paused, true); assert.match(goal().run.reason, /\/goal enable/);
  assert.doesNotMatch(goal().run.reason, /请(?:检查|查看|设置|确认)|check the settings|check compaction or extensions/i);
  if (language === 'en') assert.doesNotMatch(goal().run.reason, /\p{Script=Han}/u);
});

test('U7 Retry widget paints armed immediately and a retained factory reads live retry state every frame', async t => {
  const h = await retryHost(t), widgets: any[] = [];
  h.ctx.mode = 'tui'; h.ctx.ui.theme = { style: (text: string) => text };
  h.ctx.ui.setWidget = (_id: string, value: unknown) => widgets.push(value);
  await h.cmd('on'); assert.deepEqual(h.state().settings, { intervals: [30000, 120000, 300000, 900000], resumeAfterCompaction: true }, 'on saves the default schedule without a count');
  await h.cmd('when-error 5m count 3'); await h.cmd('off'); await h.cmd('on');
  const saved = structuredClone(h.state()); await h.cmd('on'); assert.deepEqual(h.state(), saved, 'repeated on is idempotent');
  const factory = widgets.findLast(value => typeof value === 'function');
  assert.equal(typeof factory, 'function', 'empty Todo/Goal state must not hide armed Retry');
  const component = factory({ terminal: { rows: 30 } });
  assert.match(component.render(100).join('\n'), /Retry \[[^\]]*待命\] · .*5m · .*3 · .*默认/, 'armed reads as standing by, with the schedule, the limit and the model');
  assert.equal(h.requests.length, 0, 'enabling the widget opens no panel or dialog');
  await h.failure();
  assert.match(component.render(100).join('\n'), /300s/, 'the retained component must not retain its armed paint snapshot');
  const paints = widgets.length; h.tick(1000); await h.flush();
  assert.ok(widgets.length > paints, 'countdown schedules a paint while the terminal is otherwise idle');
  assert.match(component.render(100).join('\n'), /299s/);
  await h.cmd('off'); assert.doesNotMatch(component.render(100).join('\n'), /Retry/);
  const stopped = widgets.length; h.tick(1000); await h.flush(); assert.equal(widgets.length, stopped, 'off retires the countdown painter');
  await h.fire('session_shutdown');
});

// DP2: actual host startup semantics, with deterministic public-API gates.
{
const controls = fileURLToPath(new URL('./fixtures/session-controls.ts', import.meta.url));
const observations = (client: IsolatedClient) => client.records.filter(record => record.type === 'entry_appended' && (record.entry as any)?.customType === 'dag-test.start-semantics').map(record => (record.entry as any).data);
async function root() {
  const home = await mkdtemp(join(tmpdir(), 'dag-dp2-'));
  await mkdir(join(home, 'agent'), { recursive: true });
  await writeFile(join(home, 'agent/settings.json'), JSON.stringify({ retry: { enabled: false } }));
  return home;
}
const errors = (client: IsolatedClient) => client.records.filter(record => record.type === 'extension_error');

test('DP2 actual Pi: custom startup retains parent rules, Todo checkpoint and Plan guidance', { timeout: 15000 }, async (t) => {
  const client = await IsolatedClient.start(await root(), 'custom-hooks', [controls]); t.after(() => client.close());
  await client.prompt('/todos add DP2 custom task');
  await client.prompt('/plan start');
  await client.prompt('/test-start-mode observe');
  await client.prompt('/test-custom-run DP2 custom run');
  await client.until(() => observations(client).some(item => item.stage === 'settled'));
  const before = observations(client).filter(item => item.stage === 'before');
  assert.equal(before.length, 1);
  assert.equal(before[0].messageType, 'custom'); assert.equal(before[0].hasPrompt, false); assert.equal(before[0].idle, false);
  assert.equal(before[0].guidelines.filter((line: string) => line.startsWith('Delegate only independent')).length, 1);
  const context = observations(client).find(item => item.stage === 'context').messages;
  assert.ok(context.some((item: any) => item.customType === 'pi-dag-workflow.checkpoint' && JSON.stringify(item.content).includes('DP2 custom task')));
  assert.equal(context.some((item: any) => item.customType === 'pi-dag-workflow.goal-checkpoint' && item.content.startsWith('Goal contract (')), false, 'custom startup cannot invent an active Goal');
  assert.ok(context.some((item: any) => item.customType === 'pi-dag-workflow.guidance' && item.content.startsWith('Plan:')));
  assert.deepEqual(errors(client), []);
});

test('DP2 actual Pi: custom child startup reapplies selected tools, safety and assignment guidance', { timeout: 15000 }, async (t) => {
  const home = await root(), log = join(home, 'child-start.jsonl');
  const fixture = fileURLToPath(new URL('./fixtures/retry-child-custom.ts', import.meta.url));
  const capture = fileURLToPath(new URL('./fixtures/child-guidance-log.ts', import.meta.url));
  const offline = fileURLToPath(new URL('./fixtures/offline-model.ts', import.meta.url));
  await mkdir(join(home, 'agent/pi-dag-workflow'), { recursive: true });
  await writeFile(join(home, 'agent/pi-dag-workflow/pi-dag-workflow-profile.json'), JSON.stringify({ profiles: [{ name: 'dp2', tools: ['read'], instructions: 'DP2 selected assignment', childExtensions: [fixture] }] }));
  const client = await IsolatedClient.start(home, 'custom-child', [capture], ['--dag-workflow-test-child-provider', offline, '--dag-test-child-guidance-log', log]); t.after(() => client.close());
  const events = await client.prompt('TEST CALL subagent_spawn {"task":"DP2 custom child task","profile":"dp2"}');
  const spawned = events.find((event) => event.type === 'tool_execution_end' && event.toolName === 'subagent_spawn')!;
  assert.equal(spawned.isError === true, false, JSON.stringify(spawned.result));
  const jobId = (spawned.result as any).details.jobId;
  const completed = await client.prompt(`TEST CALL subagent_inspect ${JSON.stringify({ jobId, until: 'finish', timeout: 10 })}`);
  assert.equal(completed.find((event) => event.toolName === 'subagent_inspect')?.isError === true, false);
  const observed = (await readFile(log, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
  const before = observed.find((item) => item.type === 'child-start' && item.messageType === 'custom');
  assert.equal(before?.messageType, 'custom'); assert.equal(before?.idle, false);
  assert.deepEqual([...before.tools].sort(), ['read', 'subagent_send']);
  assert.match(before.childSafety, /one-tier child agent/);
  const context = observed.filter((item) => item.type === 'child-context').flatMap((item) => item.messages);
  assert.ok(context.some((item: any) => item.customType === 'pi-dag-child.assignment-guidance' && JSON.stringify(item).includes('DP2 selected assignment')));
  assert.deepEqual(errors(client), []);
});

for (const [name, command] of [['todos', '/todos investigate DP2'], ['goal', '/goal investigate DP2'], ['agents', '/agents investigate DP2'], ['plan', '/plan investigate DP2'], ['goal-enable', '/goal enable #1']] as const) {
  test(`DP2 actual Pi: ${name} forwarding survives a competing startup during async input`, { timeout: 15000 }, async (t) => {
    const home = await root();
    if (name === 'goal-enable') {
      await mkdir(join(home, 'agent/pi-dag-workflow'), { recursive: true });
      await writeFile(join(home, 'agent/pi-dag-workflow/pi-dag-workflow-config.json'), JSON.stringify({ goalNoPauseTools: ['write'] }));
    }
    const client = await IsolatedClient.start(home, `input-race-${name}`, [controls]);
    t.after(async () => { try { await client.prompt('/test-start-release'); } finally { await client.close(); } });
    if (name === 'goal-enable') { await client.prompt('/goal new 完成测试'); await client.prompt('/goal nopause #1 on'); }
    await client.prompt('/test-start-mode race');
    await client.prompt(command);
    await client.until(() => observations(client).some(item => item.stage === 'input-held'));
    await client.prompt('/test-custom-run DP2 competing run');
    await client.until(() => observations(client).some(item => item.stage === 'before'));
    assert.equal(observations(client).find(item => item.stage === 'before').idle, false);
    await client.prompt('/test-input-release');
    const state = (await client.send('get_state')).data as any;
    assert.deepEqual(errors(client), [], 'forwarding must not reject with Agent is already processing');
    assert.equal(state.pendingMessageCount, 1, 'the original message is queued once into the starting run');
    await client.prompt('/test-start-release');
    await client.until(() => observations(client).some(item => item.stage === 'settled'));
    if (name === 'goal-enable') {
      const before = observations(client).find(item => item.stage === 'before');
      assert.equal(before.messageType, 'custom'); assert.equal(before.activeTools.includes('write'), false);
      const context = observations(client).find(item => item.stage === 'context').messages;
      assert.ok(context.some((item: any) => item.customType === 'pi-dag-workflow.goal-checkpoint' && item.content.includes('完成测试') && item.content.includes('nopause')));
    }
    assert.deepEqual(errors(client), []);
  });
}

test('DP2 actual Pi: Retry deadline during custom startup preserves failures and recovers once', { timeout: 20000 }, async (t) => {
  const entry = fileURLToPath(new URL('../src/retry/index.ts', import.meta.url));
  const client = await IsolatedClient.start(await root(), 'retry-start-overlap', [controls], ['--dag-test-retry-failures', '2'], false, [entry]);
  t.after(async () => { try { await client.prompt('/test-start-release'); } finally { await client.close(); } });
  const states = () => client.records.filter(record => record.type === 'entry_appended' && (record.entry as any)?.customType === RETRY_TYPE).map(record => (record.entry as any).data);
  await client.prompt('/retry when-error 1s count 1'); await client.prompt('RETRY-TEST first failure');
  const firstFailure = states().at(-1).failure.id;
  await client.prompt('/test-start-mode hold'); await client.prompt('/test-custom-run RETRY-TEST overlapping startup');
  await client.until(() => observations(client).some(item => item.stage === 'before'));
  await client.until(() => states().some(state => state.skipped === 1));
  assert.equal(states().at(-1).attempts, 0); assert.equal(states().at(-1).failure.id, firstFailure);
  assert.equal((await client.entries() as any[]).filter(entry => entry.customType === RETRY_MESSAGE).length, 0);
  await client.prompt('/test-start-release');
  await client.until(() => states().some(state => state.attempts === 1));
  await client.until(() => states().at(-1).attempts === 0);
  const entries = await client.entries() as any[];
  assert.equal(entries.filter(entry => entry.customType === RETRY_MESSAGE).length, 1);
  assert.equal(new Set(states().map(state => state.failure?.id).filter(Boolean)).size, 2, 'both real failures remain observed');
  assert.equal(client.records.filter(record => record.type === 'turn_start').length, 3, 'two failures and one recovery, no duplicate starts');
  assert.deepEqual(errors(client), []);
});

for (const cancel of [true, false]) test(`DP2 actual Pi: settled aborted distinguishes late ${cancel ? 'user cancellation' : 'normal completion'} in both locales`, { timeout: 20000 }, async (t) => {
  for (const language of ['zh-CN', 'en']) {
    const client = await IsolatedClient.start(await root(), `settled-${language}-${cancel}`, [controls], [], false, undefined, language); t.after(() => client.close());
    await client.prompt('/goal new 预算测试');
    await client.prompt('TEST CALL goal {"action":"update","id":1,"maxTurns":2}');
    await client.prompt('/retry when-error 1s count 1');
    await client.prompt('/test-start-mode settle');
    await client.prompt('/goal enable #1');
    await client.until(() => observations(client).some(item => item.stage === 'settling'));
    const observed = observations(client).find(item => item.stage === 'settling');
    assert.equal(observed.outcome, 'completed'); assert.equal(observed.signal, null, 'low-level signal cannot identify this late cancellation');
    if (cancel) { await client.send('clear_queue'); await client.send('abort'); }
    await client.until(() => observations(client).some(item => item.stage === 'settled'));
    assert.equal(observations(client).find(item => item.stage === 'settled').aborted, cancel);
    const entries = await client.entries() as any[];
    const state = entries.findLast(entry => entry.customType === 'pi-dag-workflow.goal').data;
    assert.equal(entries.findLast(entry => entry.type === 'message' && entry.message.role === 'assistant').message.stopReason, 'stop', 'both paths have a successful assistant; only final aborted distinguishes the late stop');
    assert.equal(state.run.paused, true); assert.equal(state.run.pendingWake, undefined);
    if (cancel) assert.equal(state.run.reason, language === 'en' ? 'User interrupted' : '用户中断');
    else assert.match(state.run.reason, language === 'en' ? /limit/ : /轮上限/);
    const status = await client.prompt('/retry status');
    const summary = status.filter(record => record.method === 'notify').map(record => record.message).join('\n');
    const cancellation = language === 'en' ? 'Cannot rule out user cancellation; do not retry automatically' : '无法确认是否为用户取消，不自动重试';
    assert.equal(summary.includes(cancellation), cancel, 'Retry uses final aborted evidence even after a successful assistant message');
    assert.equal(entries.filter(entry => entry.customType === RETRY_MESSAGE).length, 0);
    assert.deepEqual(errors(client), []);
    await client.close();
  }
});
}

// retry-runtime.test.ts
{
/** Map a scripted id/label onto the real display option (label plus current value). */
function displayChoice(options: readonly string[], wanted: string): string {
  const norm = (text: string) => text.replace(/\s+/g, ' ').trim();
  const target = norm(wanted);
  const exact = options.find((option) => option === wanted || norm(option) === target);
  if (exact) return exact;
  const prefixed = options.find((option) => norm(option).startsWith(`${target} `));
  if (prefixed) return prefixed;
  throw new Error(`no display option for ${JSON.stringify(wanted)} in ${JSON.stringify(options)}`);
}

const wakes = (h: Awaited<ReturnType<typeof retryHost>>) => h.sends.filter((item) => item.message.customType === RETRY_MESSAGE);
const intervals = (h: Awaited<ReturnType<typeof retryHost>>) => h.state()?.settings?.intervals?.map((ms: number) => `${ms / 1000}s`).join(',');

test('default off does not retry errors and status is read-only', async (t) => {
  const h = await retryHost(t); await h.failure(); h.tick(100000);
  assert.equal(wakes(h).length, 0); assert.equal((h.state()?.enabled ?? false), false);
  const mark = h.entries.length; await h.cmd('status');
  assert.equal(h.entries.length, mark); assert.equal(wakes(h).length, 0);
  assert.equal((h.state()?.enabled ?? false), false);
  const statusText = h.notices.at(-1)!; assert.match(statusText, /自动重试：关闭/); assert.ok(!statusText.trim().startsWith('{'));
  for (const cmd of ['now', 'after 1s', 'every 1s', 'cancel', 'when-error 1s count 0', 'off extra', 'status extra']) await h.cmd(cmd);
  assert.equal(wakes(h).length, 0); assert.equal(h.entries.length, mark);
});

for (const mode of ['normal', 'plan'] as const) test(`enabled recovery waits for a settled failure in ${mode}, never exits its mode`, async (t) => {
  const h = await retryHost(t, mode === 'plan' ? ['plan', 'retry'] : ['retry']); if (mode === 'plan') await h.commands.get('plan').handler('start', h.ctx); await h.cmd('when-error 1s count 2');
  h.tick(10000); assert.equal(wakes(h).length, 0, 'no error means no timer or polling model');
  await h.failure(); h.tick(999); assert.equal(wakes(h).length, 0);
  h.tick(1); assert.equal(wakes(h).length, 1); assert.equal((h.state()?.attempts ?? 0), 0, 'send is not a real turn');
  await h.fire('turn_start'); assert.equal((h.state()?.attempts ?? 0), 1);
  assert.equal(((await h.status()).includes('Plan 只读') ? 'plan' : 'normal'), mode); assert.equal(wakes(h)[0].message.customType, RETRY_MESSAGE);
  assert.match(wakes(h)[0].message.content, /not new user authorization/);
});

test('finite retries cycle intervals and subsequent failures do not refill the count', async (t) => {
  const h = await retryHost(t); await h.cmd('when-error 1s,2s,3s count 5'); await h.failure();
  for (const [index, delay] of [1000, 2000, 3000, 1000, 2000].entries()) {
    h.tick(delay - 1); assert.equal(wakes(h).length, index);
    h.tick(1); await h.fire('turn_start'); assert.equal((h.state()?.attempts ?? 0), index + 1);
    await h.failure();
  }
  assert.match(await h.status(), /阶段：已耗尽/);
  h.tick(100000); await h.fire('agent_settled', { aborted: false }); h.tick(100000);
  assert.equal(wakes(h).length, 5); assert.equal((h.state()?.attempts ?? 0), 5);
});

test('omitting count repeats the sequence beyond its length; success resets for a later error', async (t) => {
  const h = await retryHost(t); await h.cmd('when-error 1s,2s'); await h.failure();
  for (let i = 0; i < 7; i++) { h.tick(i % 2 ? 2000 : 1000); await h.fire('turn_start'); await h.failure(); }
  assert.equal(wakes(h).length, 7); assert.equal((h.state()?.settings?.count ?? null), null);
  await h.success(); h.tick(50000);
  assert.equal(wakes(h).length, 7); assert.equal((h.state()?.attempts ?? 0), 0); assert.equal((h.state()?.enabled ?? false), true);
  await h.failure(); h.tick(1000); assert.equal(wakes(h).length, 8, 'a new error starts at the first interval');
});

for (const kind of ['busy', 'pending', 'menu'] as const) test(`busy deadline skips without count/sequence advancement (${kind})`, async (t) => {
  const h = await retryHost(t); await h.cmd('when-error 1s,5s count 2'); await h.failure();
  if (kind === 'busy') h.setIdle(false);
  if (kind === 'pending') h.setPending(true);
  if (kind === 'menu') await h.fire('ui_prompt_start', { title: 'user input' });
  h.tick(1000); assert.equal(wakes(h).length, 0); assert.equal((h.state()?.attempts ?? 0), 0); assert.equal((h.state()?.skipped ?? 0), 1);
  h.setIdle(true); h.setPending(false); await h.fire('ui_prompt_end', { title: 'user input' });
  h.tick(999); assert.equal(wakes(h).length, 0, 'becoming idle is not a queued wake');
  h.tick(1); assert.equal(wakes(h).length, 1); await h.fire('turn_start');
  await h.failure(); h.tick(4999); assert.equal(wakes(h).length, 1); h.tick(1); assert.equal(wakes(h).length, 2);
});

test('enabling starts an existing error, but never overlaps a still-running native request', async (t) => {
  const h = await retryHost(t); await h.failure(); h.setIdle(false); await h.cmd('when-error 1s'); h.tick(10000);
  assert.equal(wakes(h).length, 0);
  h.setIdle(true); await h.fire('agent_settled', { aborted: false }); h.tick(1000); assert.equal(wakes(h).length, 1);
});

test('off cancels the timer, retains settings and does not restore work', async (t) => {
  const h = await retryHost(t); await h.cmd('when-error 1s'); await h.failure(); await h.cmd('off'); h.tick(10000);
  assert.equal(wakes(h).length, 0); assert.equal((h.state()?.enabled ?? false), false); assert.equal(intervals(h), '1s');
});

for (const event of ['input', 'session_before_tree', 'session_before_switch', 'session_before_fork', 'session_shutdown', 'session_before_compact'] as const) test(`pending timer cannot execute after ${event}`, async (t) => {
  const h = await retryHost(t); await h.cmd('when-error 1s'); await h.failure();
  await h.fire(event, { source: 'rpc', text: 'new work' }); h.tick(10000);
  assert.equal(wakes(h).length, 0);
});

test('a scope change invalidates old recovery before any request or preparation', async (t) => {
  const h = await retryHost(t, ['plan', 'retry']); await h.cmd('when-error 1s'); await h.failure();
  await h.commands.get('plan').handler('start', h.ctx); h.tick(1000);
  assert.equal(wakes(h).length, 0); assert.match(await h.status(), /旧计时已取消|模式已改变|Plan 只读/);
});

test('user cancellation is remembered across reload and explicit configuration cannot revive it', async (t) => {
  const h = await retryHost(t); await h.cmd('when-error 1s'); await h.failure('', null, 'aborted'); await h.fire('agent_settled', { aborted: true });
  h.tick(1000); assert.equal(wakes(h).length, 0);
  await h.fire('session_tree'); assert.match(await h.status(), /自动重试：开启/);
  assert.match(await h.status(), /阶段：等待下一次错误/);
  await h.cmd('when-error 1s'); h.tick(1000); assert.equal(wakes(h).length, 0);
  await h.failure('fresh genuine error'); h.tick(1000); assert.equal(wakes(h).length, 1);
});

test('reopening the branch cannot retry a failure whose saved work was completed or replaced', async (t) => {
  const h = await retryHost(t, ['plan', 'retry']); await h.cmd('when-error 1s'); await h.failure();
  await h.commands.get('plan').handler('start', h.ctx); await h.fire('session_tree');
  await h.cmd('when-error 1s'); h.tick(10000);
  assert.equal(wakes(h).length, 0); assert.equal((await h.status()).includes('等待重试'), false);
});

test('provider abort recovers only with nonempty error evidence', async (t) => {
  for (const evidence of [false, true]) {
    const h = await retryHost(t); await h.cmd('when-error 1s'); await h.failure(evidence ? 'provider stream disconnected' : '', null, 'aborted'); h.tick(1000);
    assert.equal(wakes(h).length, evidence ? 1 : 0);
  }
});

test('quota, auth and unknown errors all use the user rule', async (t) => {
  for (const error of ['429 insufficient_quota', '401 invalid_api_key', '402 payment required', 'unexpected failure']) {
    const h = await retryHost(t); await h.cmd('when-error 1s count 1'); await h.failure(error); h.tick(1000); assert.equal(wakes(h).length, 1, error);
  }
});

test('blocked work, failed sends and failed persistence issue no model request', async (t) => {
  const blocked = await retryHost(t, ['plan', 'retry']); await blocked.cmd('when-error 1s'); await blocked.failure(); await blocked.commands.get('plan').handler('start', blocked.ctx); blocked.tick(1000); assert.equal(wakes(blocked).length, 0);
  const failed = await retryHost(t); await failed.cmd('when-error 1s'); await failed.failure(); failed.failSend(); failed.tick(1000); assert.equal(wakes(failed).length, 0); assert.equal((failed.state()?.attempts ?? 0), 0); assert.match(await failed.status(), /无法发送重试请求/);
  const broken = await retryHost(t); await broken.cmd('when-error 1s'); await broken.failure(); broken.setIdle(false); broken.failWrite(); assert.doesNotThrow(() => broken.tick(1000)); assert.equal(wakes(broken).length, 0); assert.match(await broken.status(), /自动重试：关闭/); assert.ok(broken.notices.some((notice) => notice.includes('write failed')));
});

test('bad saved records remain protected and never get overwritten by status/off/configure', async (t) => {
  const h = await retryHost(t); h.entries.push({ type: 'custom', customType: RETRY_TYPE, data: { version: 99 } });
  await h.fire('session_tree'); const mark = h.entries.length;
  await h.cmd('status'); await h.cmd('off'); await h.cmd('when-error 1s'); h.tick(10000);
  assert.equal(h.entries.length, mark); assert.equal(wakes(h).length, 0); assert.match(await h.status(), /重试记录损坏/);
});

test('a command deferred by slow settled handlers is a busy skip, not a queued model request', async (t) => {
  const h = await retryHost(t); await h.cmd('when-error 1s count 2'); await h.failure(); h.deferCommands(); h.tick(1000);
  assert.equal(wakes(h).length, 0); assert.equal((await h.status()).includes('等待重试'), true);
  h.drainCommands(); assert.equal(wakes(h).length, 0); assert.equal((h.state()?.skipped ?? 0), 1); assert.equal((h.state()?.attempts ?? 0), 0);
  h.tick(999); assert.equal(wakes(h).length, 0); h.tick(1); assert.equal(wakes(h).length, 1);
});

test('off invalidates a deferred command before it can issue a model request', async (t) => {
  const h = await retryHost(t); await h.cmd('when-error 1s'); await h.failure(); h.deferCommands(); h.tick(1000);
  await h.cmd('off'); h.drainCommands(); h.tick(10000);
  assert.equal(wakes(h).length, 0); assert.equal((await h.status()).includes('等待重试'), false);
});

test('an async start failure reported at settlement clears pending without spending an attempt', async (t) => {
  const h = await retryHost(t); await h.cmd('when-error 1s count 2'); await h.failure(); h.silentSend(); h.tick(1000);
  assert.match(await h.status(), /阶段：重试启动中/); await h.fire('agent_settled', { aborted: false });
  assert.match(await h.status(), /阶段：启动失败/); assert.equal((h.state()?.attempts ?? 0), 0); assert.equal((await h.status()).includes('等待重试'), false); assert.equal(wakes(h).length, 0);
  h.tick(10000); assert.equal(wakes(h).length, 0);
});

test('a start failure with no settlement is detected locally without a model polling loop', async (t) => {
  const h = await retryHost(t); await h.cmd('when-error 1s'); await h.failure(); h.silentSend(); h.tick(1000); h.tick(1000);
  assert.match(await h.status(), /阶段：启动失败/); assert.equal((await h.status()).includes('等待重试'), false); assert.equal(wakes(h).length, 0); assert.equal((h.state()?.attempts ?? 0), 0);
});

test('menu changes retain a known provider abort and its timer', async (t) => {
  const h = await retryHost(t); await h.cmd('when-error 1s,2s count 3'); await h.failure('provider disconnected', false, 'aborted'); h.tick(1000); await h.fire('turn_start'); await h.failure('provider disconnected again', false, 'aborted');
  const choices = ['重试间隔', '退出菜单'];
  h.ctx.ui.select = async (_title: string, options: string[]) => { const want = choices.shift(); return want === undefined ? undefined : displayChoice(options, want); }; h.ctx.ui.editor = async () => '2s'; h.ctx.ui.confirm = async () => true;
  await h.cmd(''); assert.equal((h.state()?.attempts ?? 0), 1); assert.match(await h.status(), /阶段：等待重试/);
  h.tick(2000); assert.equal(wakes(h).length, 2);
});

test('a command prefix is not a retry command and cannot keep an old timer alive', async (t) => {
  const h = await retryHost(t); await h.cmd('when-error 1s'); await h.failure();
  await h.fire('input', { source: 'rpc', text: '/retry-other new work' }); h.tick(1000);
  assert.equal(wakes(h).length, 0);
});

test('editing a running policy through the menu preserves the actual attempt count', async (t) => {
  const h = await retryHost(t); await h.cmd('when-error 1s count 3'); await h.failure(); h.tick(1000); await h.fire('turn_start'); await h.failure();
  const choices = ['重试间隔', '退出菜单'];
  h.ctx.ui.select = async (_title: string, options: string[]) => { const want = choices.shift(); return want === undefined ? undefined : displayChoice(options, want); };
  h.ctx.ui.editor = async () => '2s'; h.ctx.ui.confirm = async () => true;
  await h.cmd(''); assert.equal((h.state()?.attempts ?? 0), 1); assert.equal(intervals(h), '2s');
  h.tick(1999); assert.equal(wakes(h).length, 1); h.tick(1); await h.fire('turn_start'); assert.equal((h.state()?.attempts ?? 0), 2);
});

test('repeated settled events do not reset or extend a pending interval', async (t) => {
  const h = await retryHost(t); await h.cmd('when-error 1s'); await h.failure(); h.tick(400);
  await h.fire('agent_settled', { aborted: false }); h.tick(600);
  assert.equal(wakes(h).length, 1);
});

test('an early timer after a backward clock change keeps its original due time', async (t) => {
  const h = await retryHost(t); await h.cmd('when-error 1s count 1'); h.tick(2000); await h.failure();
  t.mock.timers.setTime(1000); assert.equal(wakes(h).length, 0); assert.match(await h.status(), /阶段：等待重试/);
  h.tick(1999); assert.equal(wakes(h).length, 0); h.tick(1); assert.equal(wakes(h).length, 1);
});

test('long intervals use multiple bounded timers rather than an immediate Node overflow', async (t) => {
  const h = await retryHost(t); await h.cmd('when-error 1000h count 1'); await h.failure();
  h.tick(2147483647); assert.equal(wakes(h).length, 0); assert.equal((h.state()?.attempts ?? 0), 0);
  h.tick(3600000000 - 2147483647 - 1); assert.equal(wakes(h).length, 0); h.tick(1); assert.equal(wakes(h).length, 1);
});

test('menus are cancellable, user-only and settings are committed only after confirmation', async (t) => {
  const h = await retryHost(t); const mark = h.entries.length;
  await h.cmd(''); assert.equal(h.entries.length, mark);
  let choices = ['重试间隔'];
  h.ctx.ui.select = async (_title: string, options: string[]) => { const wanted = choices.shift(); return wanted === undefined ? undefined : displayChoice(options, wanted); };
  h.ctx.ui.editor = async () => '1s,2s'; h.ctx.ui.confirm = async () => false;
  await h.cmd(''); assert.equal(h.entries.length, mark); assert.equal((h.state()?.enabled ?? false), false);
  choices = ['重试间隔', '自动重试', '退出菜单']; h.ctx.ui.confirm = async () => true;
  await h.cmd(''); assert.equal((h.state()?.enabled ?? false), true); assert.equal(intervals(h), '1s,2s'); assert.equal(wakes(h).length, 0);
  assert.equal(h.commands.get('retry').getArgumentCompletions('now'), null); assert.equal(h.commands.get('retry').getArgumentCompletions('when-error '), null);
  assert.deepEqual(h.commands.get('retry').getArgumentCompletions('').map((item: any) => item.value), ['when-error', 'on', 'off', 'status', 'models']);
});
}

// retry-integration.test.ts
{
/** Offline session-level /retry: no Goal module involvement, no network or credentials. */
async function agentRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'pi-dag-retry-session-'));
  await mkdir(join(root, 'agent'), { recursive: true });
  await writeFile(join(root, 'agent', 'settings.json'), JSON.stringify({ retry: { enabled: false } }));
  return root;
}
const start = (root: string, session: string, failures: number) => IsolatedClient.start(root, session, [], ['--dag-test-retry-failures', String(failures)]);
const retryRequests = async (client: IsolatedClient) => (await client.entries()).filter((entry) => (entry as { customType?: string }).customType === RETRY_REQUEST_MESSAGE);
const retryStates = (client: IsolatedClient) => client.records
  .filter((record) => record.type === 'entry_appended' && (record.entry as { customType?: string } | undefined)?.customType === 'pi-dag-workflow.retry')
  .map((record) => (record.entry as { data: { enabled: boolean; attempts: number; skipped: number; settings?: { count?: number } } }).data);
const retryState = (client: IsolatedClient) => retryStates(client).at(-1);
const planState = (client: IsolatedClient) => client.records
  .filter((record) => record.type === 'entry_appended' && (record.entry as { customType?: string } | undefined)?.customType === PLAN_TYPE)
  .map((record) => (record.entry as { data: { enabled?: boolean } }).data).at(-1);

test('actual Pi: Retry-only recovers ordinary work without loading other features', { timeout: 30000 }, async (t) => {
  const root = await agentRoot();
  const retryEntry = fileURLToPath(new URL('../src/retry/index.ts', import.meta.url));
  const client = await IsolatedClient.start(root, 'retry-normal', [], ['--dag-test-retry-failures', '2'], false, [retryEntry]); t.after(async () => { await client.close(); await rm(root, { recursive: true, force: true }); });
  assert.deepEqual(((await client.send('get_commands')).data as any).commands.map((command: any) => command.name).sort(), ['dag-display', 'retry']);
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
  assert.equal(planState(client)?.enabled, true, 'recovery keeps Plan read-only');
});

test('actual Pi: retry status is readable without granting a model edit parameter or running a request', { timeout: 30000 }, async (t) => {
  const root = await agentRoot(); const client = await start(root, 'retry-read-status', 0); t.after(() => client.close());
  await client.prompt('/retry when-error 3m,4m count 3');
  const notifications = await client.prompt('/retry status');
  assert.equal(notifications.some((record) => record.type === 'agent_start'), false);
  const summary = String(notifications.findLast((record) => record.method === 'notify')?.message ?? '');
  assert.match(summary, /自动重试：开启/); assert.match(summary, /重试间隔：3m,4m/); assert.ok(!summary.trim().startsWith('{'));
  const events = await client.prompt('TEST CALL todo {"action":"status"}');
  const result = events.find((record) => record.type === 'tool_execution_end' && record.toolName === 'todo')!.result as any;
  const status = (result.details as { status: { retry: { enabled: boolean; intervals: string; count: number; mode: string } } }).status.retry;
  assert.equal(status.enabled, true); assert.equal(status.intervals, '3m,4m'); assert.equal(status.count, 3);
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
  const summary = String(result.findLast((record) => record.method === 'notify')!.message);
  assert.match(summary, /自动重试：开启/); assert.match(summary, /重试间隔：1s/);
  assert.match(summary, /阶段：等待下一次错误/); assert.match(summary, /0\/3/); assert.ok(!summary.trim().startsWith('{'));
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
}
