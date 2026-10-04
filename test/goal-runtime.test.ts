import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { registerGoal } from '../src/goal/register.ts';
import { emptyState, type Todo } from '../src/todos/state.ts';
import { GOAL_TYPE, type GoalParams } from '../src/goal/state.ts';

const cleanups = new Set<() => Promise<unknown>>();
afterEach(async () => { await Promise.all([...cleanups].map((cleanup) => cleanup())); cleanups.clear(); });

function host(retryDelayMs = 0, leafAware = false) {
  const events = new Map<string, Function[]>();
  const tools = new Map<string, any>(); const commands = new Map<string, any>();
  let workflow = emptyState(); let jobs: any[] = []; let protectedState = false; let idle = false;
  const entries: any[] = []; const notifications: string[] = []; const wakes: any[] = []; const passive: any[] = [];
  let messageSeq = 0; let branchReads = 0;
  const ctx: any = { cwd: '/tmp', mode: 'rpc', hasUI: true, isIdle: () => idle, sessionManager: { getBranch: () => { branchReads++; return entries; }, ...(leafAware ? { getLeafId: () => String(entries.length) } : {}) }, ui: { notify: (text: string) => notifications.push(text), confirm: async () => true } };
  const pi: any = { on(name: string, handler: Function) { events.set(name, [...events.get(name) ?? [], handler]); return () => {}; }, registerTool(tool: any) { tools.set(tool.name, tool); }, registerCommand(name: string, cmd: any) { commands.set(name, cmd); }, appendEntry(customType: string, data: any) { entries.push({ type: 'custom', customType, data: structuredClone(data) }); }, sendMessage(message: any, options: any) { (options?.triggerTurn === false ? passive : wakes).push({ message, options }); }, sendUserMessage(message: string) { wakes.push({ message, options: { source: 'extension' } }); } };
  const controller = registerGoal(pi, { state: () => workflow, jobs: () => jobs, paint() {}, protected: () => protectedState, pauseAgents() {}, resumeAgents() {}, retryDelayMs, resumeDelayMs: 0 });
  const fire = async (name: string, event: any = {}) => { let result: any; for (const handler of events.get(name) ?? []) result = await handler(event, ctx) ?? result; return result; };
  cleanups.add(() => fire('session_shutdown'));
  const call = async (params: GoalParams) => tools.get('goal').execute('test', params, undefined, undefined, ctx);
  const propose = (event: any = {}) => fire('agent_before_settle', { outcome: 'completed', continue: false, entries: [], ...event });
  const startTurn = async (messages: any[] = []) => { await fire('turn_start'); await fire('context', { messages }); };
  const settle = async (event: any = {}) => {
    const result = await propose(event);
    if (result?.continue) await startTurn(result.entries.map((entry: any) => ({ role: 'custom', ...entry })));
    return result;
  };
  const enable = async (maxTurns = 20) => { await call({ action: 'create', title: '研究', maxTurns }); await fire('input', { source: 'rpc', text: '启用目标' }); assert.ok(!(await call({ action: 'enable', id: 1 })).isError); };
  const message = (stopReason: string) => { entries.push({ type: 'message', id: `m${++messageSeq}`, parentId: null, message: { role: 'assistant', stopReason, errorMessage: stopReason === 'error' ? 'stream error' : undefined } }); };
  // A settled run schedules its retry on a timer; drain it before asserting.
  const settled = async () => { await fire('agent_settled'); await new Promise((resolve) => setTimeout(resolve, 0)); };
  const retries = () => wakes.filter((wake) => wake.message?.customType === 'pi-dag-workflow.goal-retry').length;
  return { ctx, controller, fire, call, settle, propose, startTurn, enable, settled, message, retries, entries, notifications, wakes, passive, branchReads: () => branchReads, setPlan(value: boolean) { workflow = { ...workflow, plan: value }; }, setJobs(value: any[]) { jobs = value; }, setIdle(value: boolean) { idle = value; }, setProtected(value: boolean) { protectedState = value; }, setTasks(tasks: Todo[]) { workflow = { ...workflow, tasks, nextId: Math.max(0, ...tasks.map((task) => task.id)) + 1 }; }, commands };
}

test('ordinary input without a Goal never reads session history; leaf-aware failure cache invalidates on changes', async () => {
  const empty = host();
  for (let i = 0; i < 30; i++) await empty.fire('input', { source: 'rpc', text: 'ordinary work' });
  assert.equal(empty.branchReads(), 0);
  const h = host(0, true); await h.enable();
  await h.fire('input', { source: 'rpc', text: 'same leaf' });
  const reads = h.branchReads();
  for (let i = 0; i < 10; i++) await h.fire('input', { source: 'rpc', text: 'same leaf' });
  assert.equal(h.branchReads(), reads);
  h.message('error'); h.setIdle(true); await h.settled();
  assert.equal(h.retries(), 1);
  assert.ok(h.branchReads() > reads, 'a new leaf is not served from the old cache');
  await h.fire('session_before_compact', { willRetry: false });
  h.entries.push({ type: 'compaction', id: 'changed-boundary' });
  await h.fire('session_compact', { willRetry: false });
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(h.retries(), 1);
  assert.equal(h.wakes.some((wake) => wake.message?.customType === 'pi-dag-workflow.goal-continue'), true);
});

test('run-only Goal updates do not append redundant checkpoints; goal-definition changes still do', async () => {
  const h = host(); await h.enable();
  const start = () => h.fire('before_agent_start', { systemPromptOptions: { sections: {}, selectedTools: [] } });
  assert.ok((await start())?.message);
  h.controller.reserveWake(h.ctx);
  await h.call({ action: 'update', progress: 'new evidence', nextStep: 'run actual test' });
  assert.equal(await start(), undefined);
  await h.fire('input', { source: 'rpc', text: 'rename authorized' });
  await h.call({ action: 'update', title: 'updated objective' });
  assert.match((await start()).message.content, /updated objective/);
});

test('mock host: shared Agent/Goal wakes consume one allowance, never reset on status/input/read', async () => {
  const h = host(); await h.enable(2);
  assert.equal(h.controller.reserveWake(h.ctx), true); // child-result wake
  assert.equal(h.controller.reserveWake(h.ctx), true); // Goal wake
  assert.equal(h.controller.reserveWake(h.ctx), false);
  await h.fire('input', { source: 'rpc', text: '查看状态' }); await h.call({ action: 'list' });
  assert.equal(h.controller.snapshot().run.used, 2);
  assert.equal(await h.settle(), undefined);
  assert.match(h.controller.snapshot().run.reason!, /上限/);
  const state = h.controller.snapshot();
  await h.call({ action: 'enable', id: 1 }); // User explicitly enables after the input, so this is a resume.
  assert.equal(state.run.used, 2);
});
test('mock host: a model error retries automatically and keeps the goal active', async () => {
  const h = host(); await h.enable(); h.setIdle(true);
  assert.equal(h.controller.snapshot().run.errorRetries, undefined);
  // One failure reports at turn_end, agent_end and agent_before_settle: it must retry once, and only
  // after the run settled, so Pi can finish its own recovery attempt first.
  h.message('error');
  await h.fire('turn_end', { outcome: 'error' });
  await h.fire('agent_before_settle', { outcome: 'error', continue: false });
  assert.equal(h.retries(), 0, 'an unsettled run has not failed out yet');
  await h.settled();
  const state = h.controller.snapshot();
  assert.equal(state.run.paused, false, 'a recoverable error must not pause the goal');
  assert.equal(state.run.errorRetries, 1);
  assert.equal(h.retries(), 1, 'the same failure must not queue two retries');
  assert.equal(h.notifications.filter((line) => line.includes('自动重试')).length, 1);
});

test('mock host: each failure earns its own retry while the budget lasts', async () => {
  const h = host(); await h.enable(); h.setIdle(true);
  // Two failures inside one run stay one retry: the newest failed request names the failure.
  h.message('error'); h.message('error');
  await h.settled();
  assert.equal(h.retries(), 1);
  assert.equal(h.controller.snapshot().run.errorRetries, 1);
  // The retry turn failing again is a new failure, so the next retry follows.
  h.message('error');
  await h.settled();
  assert.equal(h.retries(), 2, 'a later failure is never swallowed by the previous retry');
  assert.equal(h.controller.snapshot().run.errorRetries, 2);
  // A settled run that ends on success never retries.
  h.message('stop');
  await h.settled();
  assert.equal(h.retries(), 2);
});

test('mock host: retries stop at the configured limit and a successful turn clears the counter', async () => {
  const h = host(); await h.enable(); h.setIdle(true);
  for (let attempt = 1; attempt <= 5; attempt++) {
    h.message('error');
    await h.settled();
    assert.equal(h.controller.snapshot().run.paused, false, `attempt ${attempt} stays active`);
    assert.equal(h.controller.snapshot().run.errorRetries, attempt);
  }
  h.message('error');
  await h.settled();
  const exhausted = h.controller.snapshot();
  assert.equal(exhausted.run.paused, true, 'the sixth failure pauses');
  assert.match(exhausted.run.reason!, /已重试 5 次/);
  assert.equal(h.retries(), 5);

  // A completed turn resets the budget for the next failure.
  const fresh = host(); await fresh.enable(); fresh.setIdle(true);
  fresh.message('error');
  await fresh.settled();
  assert.equal(fresh.controller.snapshot().run.errorRetries, 1);
  await fresh.fire('turn_end', { outcome: 'completed' });
  assert.equal(fresh.controller.snapshot().run.errorRetries, 0);
  fresh.message('error');
  await fresh.settled();
  assert.equal(fresh.controller.snapshot().run.errorRetries, 1, 'a successful turn restores the full budget');
});

test('mock host: a user abort never retries', async () => {
  const h = host(); await h.enable(); h.setIdle(true);
  await h.fire('turn_end', { outcome: 'aborted' });
  assert.equal(h.controller.snapshot().run.paused, true);
  assert.match(h.controller.snapshot().run.reason!, /用户中断/);
  h.message('aborted');
  await h.fire('agent_end', { messages: [{ role: 'assistant', stopReason: 'aborted' }] });
  await h.settled();
  assert.equal(h.retries(), 0);
});

test('mock host: Plan, restore and abort pause persistently; only explicit enable can rearm', async () => {
  const h = host(); await h.enable();
  h.controller.pause('进入 Plan', h.ctx); h.setPlan(true);
  assert.equal((await h.call({ action: 'create', title: '不应创建' })).isError, true);
  assert.equal((await h.call({ action: 'list' })).isError, undefined);
  h.setPlan(false); await h.fire('input', { source: 'rpc', text: '查看信息' });
  assert.equal(await h.settle(), undefined);
  await h.fire('session_tree');
  assert.equal(h.controller.snapshot().run.paused, true);
  await h.fire('input', { source: 'rpc', text: '恢复目标' }); await h.call({ action: 'enable' });
  await h.settle({ outcome: 'aborted' });
  assert.equal(h.controller.snapshot().run.paused, true);
  assert.equal(h.controller.canWake(), false);
});
test('regular Goal tolerates eight no-progress rounds, replans once, then safely pauses', async () => {
  const h = host(); await h.enable();
  await h.call({ action: 'update', progress: '发现 API 边界', nextStep: '阅读 SDK 示例' });
  assert.equal((await h.settle()).continue, true);
  for (let i = 1; i <= 9; i++) {
    await h.call({ action: 'update', progress: '发现 API 边界', nextStep: '阅读 SDK 示例' });
    const result = await h.settle();
    if (i <= 8) {
      assert.equal(result.continue, true);
      if (i === 8) assert.match(result.entries.at(-1).content, /choose a different feasible approach/);
    } else assert.equal(result, undefined);
  }
  assert.match(h.controller.snapshot().run.reason!, /无新进展/);
  assert.equal(h.controller.snapshot().run.used, 9);
});
test('mock host: read-only calls/text do not count as progress; waiting children cause no polling', async () => {
  const h = host(); await h.enable();
  h.setJobs([{ id: 'a1', status: 'running' }]);
  assert.equal(await h.settle(), undefined);
  assert.equal(h.controller.snapshot().run.used, 0);
  assert.equal(h.controller.snapshot().run.paused, false);
  h.setJobs([]); await h.settle();
  await h.call({ action: 'update', nextStep: '' });
  assert.equal((await h.settle()).continue, true, 'clearing a note does not request a user wait');
  assert.equal(h.controller.snapshot().run.paused, false);
});
test('mock host: failed tools and ordinary reads cannot masquerade as progress', async () => {
  const h = host(); await h.enable();
  await h.settle();
  await h.fire('tool_execution_end', { toolName: 'read', isError: false });
  await h.fire('tool_execution_end', { toolName: 'write', isError: true });
  await h.call({ action: 'update', nextStep: '下一步' }); await h.settle();
  assert.equal(h.controller.snapshot().run.stalled, 1);
  await h.fire('tool_execution_end', { toolName: 'edit', isError: false });
  await h.call({ action: 'update', nextStep: '下一步' }); await h.settle();
  assert.equal(h.controller.snapshot().run.stalled, 0);
});
test('mock host: native proposed continuation is not double charged; corrupt history stays protected', async () => {
  const h = host(); await h.enable();
  assert.equal(h.controller.reserveWake(h.ctx), true);
  assert.equal(await h.settle({ continue: true }), undefined);
  assert.equal(h.controller.snapshot().run.used, 1);
  h.entries.push({ type: 'custom', customType: GOAL_TYPE, data: { version: 99 } });
  await h.fire('session_tree');
  assert.equal((await h.call({ action: 'create', title: '不覆盖历史' })).isError, true);
  assert.equal(h.entries.at(-1).data.version, 99);
});
test('mock host: explicit idle enable reserves and starts once; unknown extra args cannot start work', async () => {
  const h = host(); await h.enable(); h.controller.pause('暂停', h.ctx); h.setIdle(true);
  await h.commands.get('goal').handler('enable extra arguments', h.ctx);
  assert.equal(h.wakes.length, 0);
  await h.commands.get('goal').handler('enable', h.ctx);
  assert.equal(h.wakes.length, 1);
  assert.equal(h.controller.snapshot().run.used, 1);
  assert.match(h.wakes[0].message, /Goal #1[\s\S]*不是用户新授权/);
});

test('the last paid wake still receives its independent error retries before the allowance pause', async () => {
  const h = host(30); await h.enable(1); await h.settle();
  assert.equal(h.controller.snapshot().run.used, 1);
  h.setIdle(true); h.message('error'); await h.fire('agent_settled');
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(h.retries(), 1, 'idle fallback cannot preempt error recovery with a budget pause');
  assert.equal(h.controller.snapshot().run.paused, false);
  assert.equal(h.controller.snapshot().run.used, 1, 'error retries do not consume a second wake');
  h.message('stop'); await h.fire('agent_settled');
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(h.controller.snapshot().run.paused, true);
  assert.match(h.controller.snapshot().run.reason!, /上限/);
});

test('mock host: a newer settled failure during the delay replaces the pending retry', async () => {
  const h = host(30); await h.enable(); h.setIdle(true);
  h.message('error'); await h.fire('agent_settled');
  h.message('error'); await h.fire('agent_settled');
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(h.retries(), 1, 'one retry must address the newest failure instead of silently dropping both');
  assert.equal(h.controller.snapshot().run.errorRetries, 1);
});

test('mock host: a pending retry belongs to the failed goal, not a newly enabled goal', async () => {
  const h = host(30); await h.enable(); h.setIdle(true);
  h.message('error'); await h.fire('agent_settled');
  await h.call({ action: 'create', title: '第二个目标' });
  await h.commands.get('goal').handler('disable #1', h.ctx);
  await h.commands.get('goal').handler('enable #2', h.ctx);
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(h.retries(), 0, 'the failed request must not be retried for another goal');
  assert.equal(h.controller.snapshot().run.errorRetries, undefined);
});

test('mock host: user input and cancelled navigation retire pending retries', async () => {
  for (const event of ['input', 'session_before_tree', 'session_before_fork', 'session_before_switch']) {
    const h = host(30); await h.enable(); h.setIdle(true);
    h.message('error'); await h.fire('agent_settled');
    await h.fire(event, { source: 'rpc', text: '我来处理' });
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.equal(h.retries(), 0, `${event} takes ownership away from the pending retry`);
  }
});

test('mock host: a user dialog or aborted turn cancels a retry that has not fired', async () => {
  for (const [event, detail] of [['ui_prompt_start', { kind: 'input' }], ['turn_end', { outcome: 'aborted' }]] as const) {
    const h = host(30); await h.enable(); h.setIdle(true);
    h.message('error'); await h.fire('agent_settled');
    await h.fire(event, detail);
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.equal(h.retries(), 0);
    assert.equal(h.controller.snapshot().run.paused, true);
  }
});

test('mock host: an automatic retry does not inherit scope-changing authority from user input', async () => {
  const h = host(); await h.enable(); h.setIdle(true);
  await h.fire('input', { source: 'rpc', text: '继续当前范围' });
  h.message('error'); await h.settled();
  assert.equal((await h.call({ action: 'update', title: '扩大范围' })).isError, true);
});

test('mock host: Goal reset stops automatic child-report wakes', async () => {
  const h = host(); await h.enable();
  await h.commands.get('goal').handler('reset', h.ctx);
  assert.equal(h.controller.canWake(), false);
  assert.deepEqual(h.controller.snapshot().goals, []);
});

test('mock host: explicit goal edit is user-authorized after an automatic round, without refilling budget', async () => {
  const h = host(); await h.enable(2);
  assert.equal(h.controller.reserveWake(h.ctx), true);
  assert.equal((await h.call({ action: 'update', title: 'model expanded scope' })).isError, true);
  await h.commands.get('goal').handler('edit #1 User revised title', h.ctx);
  assert.equal(h.controller.snapshot().goals[0]!.title, 'User revised title');
  assert.equal(h.controller.snapshot().run.used, 1);
  assert.equal((await h.call({ action: 'update', maxTurns: 200 })).isError, true);
});

test('continuation drafts preserve prior entries and consume nextStep only on a visible request', async () => {
  const h = host(); await h.enable(3);
  await h.call({ action: 'update', nextStep: 'verify saved step' });
  const prior = { type: 'custom_message', customType: 'memory-test', content: 'memory baseline', display: false };
  const draft = await h.propose({ entries: [prior] });
  assert.equal(draft.entries[0], prior);
  assert.equal(h.controller.snapshot().run.nextStep, 'verify saved step');
  assert.ok(h.controller.snapshot().run.pendingWake);
  await h.startTurn(draft.entries.map((entry: any) => ({ role: 'custom', ...entry })));
  assert.equal(h.controller.snapshot().run.used, 1);
  assert.equal(h.controller.snapshot().run.pendingWake, undefined);
  assert.equal(h.controller.snapshot().run.nextStep, undefined);
});

test('a filtered continuation retains nextStep and does not restore filtered messages', async () => {
  const h = host(); await h.enable(3);
  await h.call({ action: 'update', nextStep: 'saved after filter' });
  await h.propose(); await h.startTurn([]);
  assert.equal(h.controller.snapshot().run.nextStep, 'saved after filter');
  assert.equal(h.controller.snapshot().run.used, 1, 'a real turn still consumes the budget');
  assert.equal(h.wakes.length, 0, 'the workflow never bypasses a context filter');
});

test('provisional report and Goal requests share one reservation and rejected drafts refund it', async () => {
  const h = host(); await h.enable(3);
  assert.equal(h.controller.reserveWake(h.ctx, true), true);
  assert.equal(h.controller.reserveWake(h.ctx, true), true);
  assert.equal(h.controller.snapshot().run.used, 1);
  assert.equal(await h.propose({ continue: true }), undefined);
  await h.fire('agent_settled');
  assert.equal(h.controller.snapshot().run.used, 0);
  assert.equal(h.controller.snapshot().run.pendingWake, undefined);
  assert.match(h.controller.snapshot().run.nextStep!, /推进目标/);
  await h.fire('session_shutdown');
});

test('repeated rejected drafts stop without spending confirmed turns or counting false stalls', async () => {
  const h = host(); await h.enable(4);
  h.controller.reserveWake(h.ctx); // one actual, confirmed round
  for (let index = 0; index < 3; index++) {
    await h.propose(); await h.fire('agent_settled');
  }
  assert.equal(h.controller.snapshot().run.used, 1, 'refunds never refill a confirmed round');
  assert.equal(h.controller.snapshot().run.stalled, 1, 'three discarded proposals are not three completed rounds');
  assert.equal(h.controller.snapshot().run.paused, true);
  assert.match(h.controller.snapshot().run.reason!, /未被执行/);
});

test('explicit enable wakes an active idle goal once without refilling or changing the target', async () => {
  const h = host(); await h.enable(4);
  await h.settle(); // First actual round consumed the initial nextStep.
  assert.equal(h.controller.snapshot().run.used, 1);
  h.setIdle(true);
  await h.commands.get('goal').handler('enable #1', h.ctx);
  assert.equal(h.wakes.length, 1);
  assert.match(h.wakes[0].message, /Goal #1 2\/4.*推进目标/);
  assert.equal(h.controller.snapshot().run.used, 2);
  await h.commands.get('goal').handler('enable #1', h.ctx);
  assert.equal(h.wakes.length, 1, 'an already proposed wake is not sent twice');
  await h.startTurn([{ role: 'user', content: h.wakes[0].message }]);
  h.setIdle(false);
  await h.commands.get('goal').handler('enable #1', h.ctx);
  assert.equal(h.wakes.length, 1, 'a running parent needs no extra wake');
});

test('an explicit re-enable starts a fresh rejection counter without stale automatic pauses', async () => {
  const h = host(); await h.enable(4);
  for (let index = 0; index < 2; index++) { await h.propose(); await h.fire('agent_settled'); }
  await h.commands.get('goal').handler('disable', h.ctx);
  await h.commands.get('goal').handler('enable', h.ctx);
  await h.propose(); await h.fire('agent_settled');
  assert.equal(h.controller.snapshot().run.paused, false);
  assert.equal(h.controller.snapshot().run.used, 0);
  await h.fire('session_shutdown');
});

test('successful compaction reissues an unstarted step once with its original budget', async () => {
  const h = host(); await h.enable(3);
  await h.call({ action: 'update', nextStep: 'resume exact step' });
  await h.propose();
  await h.fire('session_before_compact', { reason: 'threshold', willRetry: false });
  assert.equal(h.controller.snapshot().run.used, 0);
  assert.equal(h.controller.snapshot().run.nextStep, 'resume exact step');
  h.setIdle(true);
  await h.fire('session_compact', { reason: 'threshold', willRetry: false });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(h.wakes.length, 1);
  assert.match(h.wakes[0].message.content, /resume exact step/);
  await h.startTurn([h.wakes[0].message]);
  assert.equal(h.controller.snapshot().run.used, 1);
  assert.equal(h.controller.snapshot().run.nextStep, undefined);
  await h.fire('agent_settled'); await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(h.wakes.filter((wake) => wake.message.content?.includes('resume exact step')).length, 1, 'the consumed action must not be replayed');
  assert.match(h.wakes[1].message.content, /Goal #1.*goal get/, 'a subsequent settled round can reassess the still-active objective');
  await h.fire('session_shutdown');
});

test('manual compaction resumes after slow completion handlers release host idle, without another settled event', async () => {
  const h = host(); await h.enable(3);
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
    assert.equal(h.controller.snapshot().run.used, 1);
  } finally { await h.fire('session_shutdown'); }
});

test('user disable during a slow compaction completion cancels the deferred wake and restores no execution', async () => {
  const h = host(); await h.enable(3);
  await h.fire('session_before_compact', { reason: 'manual', willRetry: false });
  await h.fire('session_compact', { reason: 'manual', willRetry: false });
  await new Promise((resolve) => setTimeout(resolve, 20));
  await h.commands.get('goal').handler('disable', h.ctx);
  h.setIdle(true);
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(h.wakes.length, 0);
  assert.equal(h.controller.snapshot().run.paused, true);
  assert.equal(h.controller.snapshot().run.used, 0);
});

test('successful shell work prevents a false no-progress pause when no Todo or progress text changes', async () => {
  const h = host(); await h.enable(6); await h.settle();
  await h.fire('tool_execution_end', { toolName: 'bash', isError: false });
  await h.propose();
  assert.equal(h.controller.snapshot().run.stalled, 0, 'shell tests and edits are actual work, not a text-only turn');
  await h.fire('session_shutdown');
});

test('a retired pre-compaction error cannot strand an active Goal after successful compaction', async () => {
  const h = host(); await h.enable(4); h.setIdle(true);
  h.message('error'); await h.settled();
  assert.equal(h.retries(), 1);
  await h.fire('session_before_compact', { reason: 'manual', willRetry: false });
  h.entries.push({ type: 'compaction', id: 'compact-after-retired-failure' });
  await h.fire('session_compact', { reason: 'manual', willRetry: false });
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(h.controller.snapshot().run.paused, false);
  assert.equal(h.retries(), 1, 'an error from before the successful compaction is not a new failed request');
  assert.equal(h.wakes.filter((wake) => wake.message?.customType === 'pi-dag-workflow.goal-continue').length, 1, 'the retained retry id must not suppress continuation forever');
});

test('a post-compaction error still gets a bounded retry and user/budget pauses stay stopped', async () => {
  const h = host(); await h.enable(4); h.setIdle(true);
  h.message('error');
  await h.fire('session_before_compact', { reason: 'overflow', willRetry: true });
  h.entries.push({ type: 'compaction', id: 'successful-overflow-boundary' });
  await h.fire('session_compact', { reason: 'overflow', willRetry: true });
  h.message('error'); // This is a new failed request after the successful compaction.
  await h.settled();
  assert.equal(h.retries(), 1);
  assert.equal(h.controller.snapshot().run.errorRetries, 1);
  await h.commands.get('goal').handler('disable', h.ctx);
  await h.fire('agent_settled');
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(h.controller.snapshot().run.paused, true);
  assert.equal(h.retries(), 1);
});

test('native overflow retry takes priority over an idle fallback wake after compaction', async () => {
  const h = host(); await h.enable(3);
  await h.fire('session_before_compact', { reason: 'overflow', willRetry: true });
  h.setIdle(true);
  await h.fire('session_compact', { reason: 'overflow', willRetry: true });
  await h.startTurn([]); // Pi natively resumed; no Goal reservation exists.
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(h.wakes.length, 0);
  assert.equal(h.controller.snapshot().run.used, 0);
});

test('failed compaction and a user abort during compaction remain stopped', async () => {
  for (const aborted of [false, true]) {
    const h = host(); await h.enable(3);
    await h.call({ action: 'update', nextStep: 'kept on failure' }); await h.propose();
    await h.fire('session_before_compact', { reason: 'threshold', willRetry: false });
    await h.fire('session_compact_failed', { aborted });
    h.setIdle(true); await h.fire('agent_settled'); await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(h.controller.snapshot().run.paused, true);
    assert.equal(h.controller.snapshot().run.used, 0);
    assert.equal(h.controller.snapshot().run.nextStep, 'kept on failure');
    assert.equal(h.wakes.length, 0);
  }
});

test('compaction never rearms user-disable, dialogs, Plan, restore or exhausted budget', async () => {
  for (const kind of ['disable', 'dialog', 'plan', 'restore', 'budget']) {
    const h = host(); await h.enable(kind === 'budget' ? 1 : 3);
    if (kind === 'disable') await h.call({ action: 'disable' });
    else if (kind === 'dialog') await h.fire('ui_prompt_start', { kind: 'input' });
    else if (kind === 'plan') { h.controller.pause('进入 Plan', h.ctx); h.setPlan(true); }
    else if (kind === 'restore') await h.fire('session_tree');
    else { h.controller.reserveWake(h.ctx); await h.propose(); }
    const used = h.controller.snapshot().run.used;
    await h.fire('session_before_compact', { reason: 'overflow', willRetry: true });
    await h.fire('session_compact', { reason: 'overflow', willRetry: true });
    h.setIdle(true); await h.fire('agent_settled'); await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(h.controller.snapshot().run.paused, true, kind);
    assert.equal(h.controller.snapshot().run.used, used, kind);
    assert.equal(h.wakes.length, 0, kind);
  }
});

test('a settled active Goal uses the idle fallback if the before-settle continuation path was skipped', async () => {
  const h = host(); await h.enable(4); await h.settle();
  await h.call({ action: 'update', progress: 'first stage verified', nextStep: 'second stage exact action' });
  h.setIdle(true); await h.fire('agent_settled');
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(h.wakes.length, 1);
  assert.match(h.wakes[0].message.content, /second stage exact action/);
  assert.equal(h.controller.snapshot().run.used, 2);
  assert.equal(h.controller.snapshot().run.stalled, 0);
  await h.startTurn([h.wakes[0].message]);
  h.controller.pause('user stop', h.ctx);
  await h.fire('agent_settled'); await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(h.wakes.length, 1, 'a stopped goal never enters the fallback');
});

test('idle fallback waits for real children without polling and resumes the objective when none remain', async () => {
  const h = host(); await h.enable(4); await h.settle();
  h.setJobs([{ id: 'a1', status: 'running' }]); h.setIdle(true);
  await h.fire('agent_settled'); await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(h.wakes.length, 0); assert.equal(h.controller.snapshot().run.paused, false);
  h.setJobs([]);
  await h.fire('agent_settled'); await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(h.wakes.length, 1); assert.equal(h.controller.snapshot().run.paused, false);
  assert.match(h.wakes[0].message.content, /Goal #1.*goal get/);
  await h.fire('session_shutdown');
});

test('an enabled Goal continues its objective when Todos are done and the model omits nextStep', async () => {
  const h = host(); await h.enable(6); await h.settle();
  h.setTasks([{ id: 1, subject: 'finished phase', status: 'completed', blockedBy: [] }]);
  await h.call({ action: 'update', progress: 'phase verified, objective still pending' });
  h.message('stop');
  const next = await h.propose();
  assert.equal(next?.continue, true, 'a normal final answer is not a Goal disable or completion');
  assert.match(next.entries.at(-1).content, /Goal #1.*goal get/);
  assert.equal(h.controller.snapshot().run.paused, false);
  assert.equal(h.controller.snapshot().run.used, 2);
  assert.equal(h.controller.snapshot().focusId, 1);
  await h.startTurn(next.entries);
  await h.fire('session_shutdown');
});

test('a child waiting for an answer gets a Goal decision instead of an indefinite child wait', async () => {
  const h = host(); await h.enable(6); await h.settle();
  h.setJobs([{ id: 'a1', status: 'waiting' }]);
  const next = await h.propose();
  assert.equal(next?.continue, true);
  assert.match(next.entries.at(-1).content, /子 Agent a1.*subagent_wait/);
  await h.startTurn(next.entries); await h.fire('session_shutdown');
});

test('a substituted initial question consumes the placeholder and then verifies the returned Todo', async () => {
  const h = host(); await h.enable(6);
  h.setTasks([{ id: 1, subject: 'returned work', status: 'in_progress', blockedBy: [] }]);
  h.setJobs([{ id: 'a1', todoId: 1, status: 'waiting' }]);
  const question = await h.propose();
  assert.match(question.entries.at(-1).content, /子 Agent a1.*subagent_wait/);
  await h.startTurn(question.entries);
  assert.equal(h.controller.snapshot().run.nextStep, undefined, 'the initial generic placeholder is not replayed after a substituted step');
  h.setJobs([{ id: 'a1', todoId: 1, status: 'completed', reportDelivery: 'delivered' }]);
  const returned = await h.propose();
  assert.match(returned.entries.at(-1).content, /核验 Todo #1/);
  await h.startTurn(returned.entries); await h.fire('session_shutdown');
});

test('a pending question has priority but preserves the saved independent next step', async () => {
  const h = host(); await h.enable(6); await h.settle();
  await h.call({ action: 'update', nextStep: 'saved independent action' });
  h.setJobs([{ id: 'a1', status: 'waiting' }]);
  const question = await h.propose();
  assert.match(question.entries.at(-1).content, /子 Agent a1.*subagent_wait/);
  await h.startTurn(question.entries);
  assert.equal(h.controller.snapshot().run.nextStep, 'saved independent action');
  h.setJobs([{ id: 'a1', status: 'running' }]);
  const next = await h.propose();
  assert.match(next.entries.at(-1).content, /saved independent action/);
  await h.startTurn(next.entries); await h.fire('session_shutdown');
});

test('the wait timeout exemption belongs only to the child that was actually waited on', async () => {
  const h = host(); await h.enable(6); await h.settle();
  h.setJobs([{ id: 'a1', status: 'running' }, { id: 'a2', status: 'running' }]);
  await h.fire('tool_execution_end', { toolName: 'subagent_wait', isError: false, result: { details: { id: 'a1', status: 'running', timedOut: true } } });
  h.setJobs([{ id: 'a1', status: 'completed' }, { id: 'a2', status: 'running' }]);
  assert.equal(await h.propose(), undefined);
  assert.equal(h.controller.snapshot().run.stalled, 1, 'an unrelated running child cannot suppress a counted round');
  await h.fire('session_shutdown');
});

test('real child wait timeouts are not stalled automatic work and results still permit continuation', async () => {
  const h = host(); await h.enable(10); await h.settle();
  h.setJobs([{ id: 'a1', status: 'running' }]);
  for (let index = 0; index < 4; index++) {
    if (index) { h.controller.reserveWake(h.ctx); await h.startTurn([]); }
    await h.fire('tool_execution_end', { toolName: 'subagent_wait', isError: false, result: { details: { id: 'a1', status: 'running', timedOut: true } } });
    assert.equal(await h.propose(), undefined, 'waiting must not poll a model while the child runs');
    assert.equal(h.controller.snapshot().run.paused, false);
    assert.equal(h.controller.snapshot().run.stalled, 0, 'an acknowledged wait is not an unproductive execution attempt');
  }
  h.setJobs([{ id: 'a1', status: 'completed', reportDelivery: 'delivered' }]);
  const next = await h.propose();
  assert.equal(next?.continue, true, 'the completed child reopens the objective decision');
  await h.startTurn(next.entries); await h.fire('session_shutdown');
});

test('completed non-stale child work is selected for verification instead of redispatch', async () => {
  const h = host(); await h.enable();
  h.setTasks([{ id: 1, subject: 'ready task', status: 'pending', blockedBy: [] }, { id: 2, subject: 'returned task', status: 'in_progress', blockedBy: [] }]);
  h.setJobs([{ id: 'a2', todoId: 2, status: 'completed', reportDelivery: 'delivered' }]);
  await h.call({ action: 'update', nextStep: ' ' });
  const proposal = await h.propose();
  assert.match(proposal.entries.at(-1).content, /核验 Todo #2.*subagent_wait/);
  await h.startTurn(proposal.entries);
  h.setJobs([{ id: 'a2', todoId: 2, status: 'completed', taskReportStale: true }]);
  const stale = await h.propose();
  assert.match(stale.entries.at(-1).content, /推进并核验 Todo #1/);
  await h.fire('session_shutdown');
});
