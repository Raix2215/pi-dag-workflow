import { randomUUID } from 'node:crypto';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { Text } from '@earendil-works/pi-tui';
import { activates, applyGoal, emptyGoalState, focusedGoal, GOAL_TYPE, GoalParamsSchema, goalBudgetSpent, goalLimitLabel, goalNolimit, pauseGoal, releaseGoalWake, reserveGoalWake, restoreGoalState, setGoalNolimit, setModelPausePolicy, stops, type Goal, type GoalParams, type GoalState } from './state.ts';
import { configPaths, defaultConfig, loadConfig, type WorkflowConfig } from '../shared/config.ts';
import { GOAL_CHECKPOINT_TYPE, goalCheckpoint, goalRules, goalWakeRules } from './prompt.ts';
import { clean, notify, type AgentView } from '../ui/render.ts';
import { deriveDag } from '../dag/graph.ts';
import type { WorkflowState } from '../todos/state.ts';
import { workflowNamespace, sessionMutation } from '../shared/tool-info.ts';
import { completeArguments, type CompletionSpec } from '../shared/completion.ts';
import { chinese, localizeSavedMessage, type Translator } from '../shared/i18n.ts';

interface Hooks { msg?: Translator; state(): WorkflowState; jobs(): readonly AgentView[]; paint(ctx: ExtensionContext): void; protected(): boolean; pauseAgents(): void; resumeAgents(): void; onSaved?(ctx: ExtensionContext): void; retryDelayMs?: number; beforeWake?(ctx: ExtensionContext): void; resumeDelayMs?: number; isUserPrompt?(title: string | undefined): boolean; branch?(ctx: ExtensionContext): ReturnType<ExtensionContext['sessionManager']['getBranch']>; loadConfig?(): Promise<WorkflowConfig> }
/** One shared budget for plugin continuations and child-report wakes. No goal dispatcher. */
export function registerGoal(pi: ExtensionAPI, hooks: Hooks) {
  const msg = hooks.msg ?? chinese;
  let state = emptyGoalState();
  let config: WorkflowConfig = defaultConfig();
  let checkpointPending = false;
  let lastCheckpoint: string | undefined;
  const removedTools = new Map<string, number>();
  const noPauseRunning = () => !state.run.paused && !hooks.state().plan && focusedGoal(state)?.modelPause === 'deny';
  const sameGoal = (left: Goal | undefined, right: Goal | undefined) => left === right || Boolean(left && right && left.id === right.id && left.title === right.title && left.description === right.description && left.status === right.status && left.maxTurns === right.maxTurns && left.createdAt === right.createdAt && left.completedAt === right.completedAt && left.modelPause === right.modelPause && left.nolimit === right.nolimit);
  function syncNoPauseTools() {
    // Remove only currently active tools; restore only tools this controller removed.
    // The tool_call guard also covers nested/codemode calls and later external reactivation.
    if (!pi.getActiveTools || !pi.setActiveTools) return;
    const active = pi.getActiveTools();
    const banned = new Set(noPauseRunning() ? config.goalNoPauseTools : []);
    const restored = [...removedTools].filter(([name]) => !banned.has(name)).sort((a, b) => a[1] - b[1]);
    for (const [name] of restored) removedTools.delete(name);
    active.forEach((name, index) => { if (banned.has(name) && !removedTools.has(name)) removedTools.set(name, index); });
    const next = active.filter((name) => !banned.has(name));
    for (const [name, index] of restored) if (!next.includes(name)) next.splice(Math.min(index, next.length), 0, name);
    if (next.length !== active.length || next.some((name, index) => name !== active[index])) pi.setActiveTools(next);
  }
  function makeCheckpoint() {
    if (!checkpointPending) return;
    checkpointPending = false;
    const content = goalCheckpoint(state);
    if (content === lastCheckpoint) return;
    lastCheckpoint = content;
    return { customType: GOAL_CHECKPOINT_TYPE, content, display: false };
  }
  function beforeWake(ctx: ExtensionContext) {
    hooks.beforeWake?.(ctx);
    const message = makeCheckpoint();
    if (message) pi.sendMessage(message, { triggerTurn: false });
  }
  let error: string | undefined;
  let userAuthority = false;
  let automaticRound = false;
  const waitedForChildren = new Set<string>();
  let standaloneReports = true;
  let revision = 0;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let retriedFailure: string | undefined;
  let baseline = '';
  let lastProgress = '';
  let compacting = false;
  let resumeWanted = false;
  let resumeTimer: ReturnType<typeof setTimeout> | undefined;
  let rejectedWakes = 0;
  let stepAck: { id: string; goalId: number; nextStep?: string; message?: string } | undefined;
  let activeStep: { goalId: number; text: string } | undefined;
  let compactionInterrupted = false;
  let compactionGoalId: number | undefined;
  let interruptedGoalId: number | undefined;
  let sessionEpoch = 0;
  let menuPrompt: { title: string; epoch: number } | undefined;
  let stampedTasks: WorkflowState['tasks'] | undefined;
  let taskStamp = '';
  const workStamp = () => {
    const tasks = hooks.state().tasks;
    if (tasks !== stampedTasks) {
      stampedTasks = tasks;
      taskStamp = JSON.stringify(tasks.filter((task) => task.status !== 'deleted').map((task) => [task.id, task.status]));
    }
    return `${revision}:${taskStamp}`;
  };
  let failureCache: { manager: ExtensionContext['sessionManager']; leaf: string | null; failure: string | undefined } | undefined;
  const paint = (ctx: ExtensionContext) => hooks.paint(ctx);
  const goalStatusLabel: Record<GoalState['goals'][number]['status'], string> = { active: '活动', paused: '暂停', completed: '已完成', deleted: '已删除' };
  const activatable = new Set(['enable', 'nopause', 'nolimit']);
  const completion: CompletionSpec = {
    actions: [
      { action: 'new', description: msg('创建目标（不启动）：new 标题') },
      { action: 'list', description: msg('查看目标与预算') },
      { action: 'enable', description: msg('启用并推进目标：enable [ #编号]') },
      { action: 'disable', description: msg('停用或暂停目标：disable [ #编号]') },
      { action: 'complete', description: msg('标记完成：complete #编号') },
      { action: 'delete', description: msg('删除目标：delete #编号') },
      { action: 'edit', description: msg('修改标题：edit #编号 新标题') },
      { action: 'get', description: msg('查看目标详情：get #编号') },
      { action: 'nopause', description: msg('切换运行中是否允许模型中断：nopause [ #编号]') },
      { action: 'nolimit', description: msg('切换续跑轮数上限：nolimit [ #编号]（当前目标可省略编号）') },
      { action: 'config', description: msg('查看配置路径与值') },
      { action: 'reset', description: msg('清除 Goal 状态') },
      { action: 'help', description: msg('查看命令帮助') },
    ],
    freeText: ['new'],
    tokens: (action) => ['enable', 'disable', 'edit', 'complete', 'delete', 'get', 'nopause', 'nolimit'].includes(action) ? state.goals
      .filter((goal) => goal.status !== 'deleted' && (!activatable.has(action) || goal.status !== 'completed'))
      .map((goal) => ({ token: `#${goal.id}`, label: `#${goal.id} ${goal.title}`, description: msg(goalStatusLabel[goal.status]) })) : null,
  };
  function commit(next: GoalState, ctx: ExtensionContext) {
    if (next === state) return;
    pi.appendEntry(GOAL_TYPE, next);
    const previousGoal = focusedGoal(state);
    const previousRun = state.run;
    state = next;
    if (!sameGoal(previousGoal, focusedGoal(state)) || state.run.paused !== previousRun.paused || state.run.reason !== previousRun.reason) checkpointPending = true;
    syncNoPauseTools();
    hooks.onSaved?.(ctx);
    paint(ctx);
  }
  function cancelRetry(ctx: ExtensionContext) {
    if (retryTimer) clearTimeout(retryTimer);
    retryTimer = undefined;
    retriedFailure = focusedGoal(state) ? lastFailure(ctx) : undefined; // Ordinary input without a Goal needs no history scan.
  }
  function pause(reason: string, ctx: ExtensionContext) {
    cancelRetry(ctx); resumeWanted = false; interruptedGoalId = undefined; rejectedWakes = 0;
    if (resumeTimer) clearTimeout(resumeTimer); resumeTimer = undefined;
    commit(releaseGoalWake(state), ctx); stepAck = undefined;
    if (!focusedGoal(state) || state.run.paused) return;
    commit(pauseGoal(state, reason), ctx);
    hooks.pauseAgents();
    notify(ctx, msg`Goal 已暂停：${reason}；/goal enable 明确恢复`, 'warning');
  }
  const available = () => !error && !hooks.protected() && !hooks.state().plan && (!focusedGoal(state) ? standaloneReports : !state.run.paused && (!goalBudgetSpent(state, focusedGoal(state)!) || Boolean(state.run.pendingWake)));
  function reserveWake(ctx: ExtensionContext, provisional = false): boolean {
    if (!available()) return false;
    if (provisional && state.run.pendingWake) return true; // Sibling entries share one upcoming model turn.
    if (!focusedGoal(state)) return true; // Standalone Agents retain their normal notification behavior.
    const next = reserveGoalWake(state);
    if (!next) return false;
    const reserved = provisional ? { ...next, run: { ...next.run, pendingWake: { id: randomUUID(), goalId: focusedGoal(state)!.id, usedBefore: state.run.used } } } : next;
    commit(reserved, ctx);
    baseline = workStamp(); lastProgress = state.run.progress ?? '';
    userAuthority = false; waitedForChildren.clear();
    if (!provisional) automaticRound = true;
    return true;
  }
  /**
   * Automatic recovery for a failed model request: the goal stays active and one bounded retry
   * turn is queued instead of pausing on the first error. Only one retry is issued per failure.
   */
  function recoverFromModelError(ctx: ExtensionContext): boolean {
    const goal = focusedGoal(state);
    const limit = config.goalErrorRetries;
    const attempts = state.run.errorRetries ?? 0;
    if (!goal || state.run.paused || limit <= 0 || attempts >= limit) return false;
    if (error || hooks.protected() || hooks.state().plan) return false;
    const next = { ...state, run: { ...state.run, errorRetries: attempts + 1 } };
    commit(next, ctx);
    userAuthority = false; automaticRound = true; waitedForChildren.clear();
    notify(ctx, msg`模型出错，自动重试 ${next.run.errorRetries}/${limit}`, 'warning');
    try {
      beforeWake(ctx);
      pi.sendMessage({ customType: 'pi-dag-workflow.goal-retry', content: `${msg`上一次请求失败（模型出错）。这是 Goal #${goal.id} 的第 ${next.run.errorRetries}/${limit} 次自动重试：继续推进「${clean(goal.title)}」。`} ${goalWakeRules(state, config.goalNoProgressLimit)}`, display: true }, { triggerTurn: true, deliverAs: 'followUp' });
    } catch (cause) { pause(msg`重试失败：${String(cause)}`, ctx); return false; }
    return true;
  }
  const modelErrorPause = () => config.goalErrorRetries > 0 ? msg`模型出错（已重试 ${config.goalErrorRetries} 次）` : msg('模型出错');
  /**
   * The newest assistant message, when the run that ended failed. Pi persists one entry per request,
   * so the entry id names exactly one failure and stays stable while the run reports it.
   */
  function lastFailure(ctx: ExtensionContext): string | undefined {
    const manager = ctx.sessionManager;
    const leaf = typeof manager.getLeafId === 'function' ? manager.getLeafId() : undefined;
    if (leaf !== undefined && failureCache?.manager === manager && failureCache.leaf === leaf) return failureCache.failure;
    const branch = hooks.branch?.(ctx) ?? manager.getBranch();
    let failure: string | undefined;
    for (let index = branch.length - 1; index >= 0; index--) {
      const entry = branch[index];
      // Compaction is a new recovery boundary. Raw branch history still contains the old
      // failed request even when Pi omitted it from the compacted model context. Treating
      // that retired id as the current failure can suppress every later fallback wake.
      if (entry?.type === 'compaction') break;
      if (!entry || entry.type !== 'message' || entry.message.role !== 'assistant') continue;
      failure = entry.message.stopReason === 'error' ? entry.id : undefined;
      break;
    }
    if (leaf !== undefined) failureCache = { manager, leaf, failure };
    return failure;
  }
  /** Answer a failure Pi gave up on with one bounded retry turn; pause once the budget is spent. */
  function recoverFailure(ctx: ExtensionContext, failure: string, goalId: number) {
    retryTimer = undefined;
    if (!ctx.isIdle() || compacting || hooks.protected() || hooks.state().plan || state.run.paused || focusedGoal(state)?.id !== goalId) return;
    if (lastFailure(ctx) !== failure || failure === retriedFailure) return;
    retriedFailure = failure;
    if (!recoverFromModelError(ctx)) pause(modelErrorPause(), ctx);
  }
  const waitingInstruction = (goal = focusedGoal(state)) => goal?.modelPause === 'deny'
    ? 'Resolve the decision autonomously within scope; do not ask the user.' : 'Try safe alternatives and independent work before asking about a verified external blocker.';
  async function noPauseMenu(id: number, ctx: ExtensionContext) {
    if (error || hooks.protected()) throw new Error(error ?? msg('工作流状态受保护'));
    const goal = state.goals.find((item) => item.id === id && item.status !== 'deleted');
    if (!goal) throw new Error(msg('找不到目标；请给出 id'));
    if (!ctx.hasUI) throw new Error(msg('Goal 菜单需要交互界面'));
    if (menuPrompt) throw new Error(msg('Goal 菜单已打开'));
    const allow = msg('允许模型中断'); const deny = msg('禁止模型中断');
    const prompt = { title: msg`Goal #${goal.id} · 运行中模型中断（当前：${goal.modelPause === 'deny' ? msg('禁止') : msg('允许')}）`, epoch: sessionEpoch };
    menuPrompt = prompt;
    let selected: string | undefined;
    try { selected = await ctx.ui.select(prompt.title, goal.modelPause === 'deny' ? [deny, allow] : [allow, deny]); }
    finally { if (menuPrompt === prompt) menuPrompt = undefined; }
    if (selected === undefined || prompt.epoch !== sessionEpoch) return;
    const policy = selected === deny ? 'deny' : selected === allow ? 'allow' : undefined;
    if (!policy) return;
    commit(setModelPausePolicy(state, id, policy, msg), ctx);
    notify(ctx, msg`Goal #${id}：${selected}`, 'info');
  }
  /** Passive user-owned switch. It never starts, pauses, clears `used`, or drops a pending wake. */
  async function noLimitMenu(id: number, ctx: ExtensionContext) {
    if (error || hooks.protected()) throw new Error(error ?? msg('工作流状态受保护'));
    const goal = state.goals.find((item) => item.id === id && item.status !== 'deleted');
    if (!goal) throw new Error(msg('找不到目标；请给出 id'));
    if (!ctx.hasUI) throw new Error(msg('Goal 菜单需要交互界面'));
    if (menuPrompt) throw new Error(msg('Goal 菜单已打开'));
    const limited = msg`使用轮数上限（${goal.maxTurns} 轮）`; const unlimited = msg('不限续跑轮数');
    const prompt = { title: msg`Goal #${goal.id} · 续跑轮数（当前：${goalLimitLabel(goal)}）`, epoch: sessionEpoch };
    menuPrompt = prompt;
    let selected: string | undefined;
    try { selected = await ctx.ui.select(prompt.title, goalNolimit(goal) ? [unlimited, limited] : [limited, unlimited]); }
    finally { if (menuPrompt === prompt) menuPrompt = undefined; }
    if (selected === undefined || prompt.epoch !== sessionEpoch) return;
    const nolimit = selected === unlimited ? true : selected === limited ? false : undefined;
    if (nolimit === undefined) return;
    commit(setGoalNolimit(state, id, nolimit, msg), ctx);
    notify(ctx, msg`Goal #${id}：${selected}`, 'info');
  }
  function continuation(ctx: ExtensionContext, nextStep: string) {
    if (!reserveWake(ctx, true)) return;
    const goal = focusedGoal(state)!;
    const replacesInitial = state.run.pendingWake!.usedBefore === 0 && state.run.nextStep === msg`推进目标：${goal.title}`;
    commit({ ...state, run: { ...state.run, ...(replacesInitial ? { nextStep } : {}), pendingWake: { ...state.run.pendingWake!, nextStep } } }, ctx);
    // The one-shot step is consumed only after the actual request sees its continuation message.
    return { type: 'custom_message' as const, customType: 'pi-dag-workflow.goal-continue', details: { wakeId: state.run.pendingWake!.id }, content: `Goal #${goal.id} ${state.run.used}/${goalLimitLabel(goal)}: ${clean(goal.title)}. Suggested next action (model note; original objective and permissions take precedence): ${JSON.stringify(clean(nextStep))}\n${goalWakeRules(state, config.goalNoProgressLimit)}\n${msg('这是工作流续跑，不是用户新授权。')}`, display: true };
  }
  function interrupted(ctx: ExtensionContext) {
    if (compacting) { compactionInterrupted = true; return; }
    const goal = focusedGoal(state); const wasRunning = !state.run.paused;
    pause(msg('用户中断'), ctx);
    if (goal && wasRunning) interruptedGoalId = goal.id;
  }
  function todoStep(task: WorkflowState['tasks'][number]): string {
    const job = hooks.jobs().findLast((item) => item.todoId === task.id);
    if (job?.status === 'completed' && !job.taskReportStale) return msg`核验 Todo #${task.id}：${task.subject}；子 Agent ${job.id} 已结束，若报告不在上下文中，用 subagent_wait 查看；核验后再更新任务。`;
    return msg`推进并核验 Todo #${task.id}：${task.subject}`;
  }
  function assessProgress(ctx: ExtensionContext): boolean {
    const progressed = workStamp() !== baseline || Boolean(state.run.progress?.trim() && state.run.progress !== lastProgress);
    // Count a completed automatic round once, including an idle fallback after a skipped boundary.
    const waiting = hooks.jobs().some((job) => waitedForChildren.has(job.id) && ['starting', 'running'].includes(job.status));
    waitedForChildren.clear();
    const stalled = progressed ? 0 : automaticRound && !waiting ? state.run.stalled + 1 : state.run.stalled;
    automaticRound = false;
    if (stalled !== state.run.stalled) commit({ ...state, run: { ...state.run, stalled } }, ctx);
    baseline = workStamp(); lastProgress = state.run.progress ?? '';
    // One replan round precedes the regular safety pause. nopause keeps trying under the
    // finite wake/error budgets; text-only stopping attempts must not silently stop the Goal.
    if (stalled > config.goalNoProgressLimit && !noPauseRunning()) { pause(msg`连续 ${stalled} 轮无新进展`, ctx); return false; }
    return true;
  }
  function runnableStep(goal: NonNullable<ReturnType<typeof focusedGoal>>) {
    const jobs = hooks.jobs();
    const active = jobs.filter((job) => ['starting', 'running', 'waiting'].includes(job.status));
    const assigned = new Set(active.map((job) => job.todoId));
    const ready = new Set(deriveDag(hooks.state().tasks).ready);
    const candidates = hooks.state().tasks.filter((task) => !assigned.has(task.id) && (ready.has(task.id) || task.status === 'in_progress'));
    const latest = new Map(jobs.filter((job) => job.todoId !== undefined).map((job) => [job.todoId!, job]));
    const task = candidates.find((task) => task.status === 'in_progress' && latest.get(task.id)?.status === 'completed' && !latest.get(task.id)?.taskReportStale) ?? candidates[0];
    const initial = state.run.used === 0 && state.run.nextStep === msg`推进目标：${goal.title}`;
    const taskStep = task && todoStep(task);
    const question = active.find((job) => job.status === 'waiting');
    const questionStep = question && msg`检查子 Agent ${question.id} 的待答复问题（subagent_wait）；在当前 Goal 范围内答复，${waitingInstruction(goal)}`;
    const attention = !active.length && msg`核对 Goal #${goal.id} 的目标、要求与进展（goal get）；继续未达成的当前范围，达成时 complete，${waitingInstruction(goal)}`;
    return { active: active.length, initial, step: questionStep || (initial && active.length ? taskStep : state.run.nextStep?.trim() || taskStep || attention || undefined), taskStep, questionStep };
  }
  function scheduleResume(ctx: ExtensionContext) {
    if (!resumeWanted || resumeTimer || compacting || state.run.paused || !focusedGoal(state)) return;
    resumeTimer = setTimeout(() => {
      resumeTimer = undefined;
      if (!resumeWanted || compacting || state.run.paused || state.run.pendingWake || !focusedGoal(state)) return;
      // session_compact is emitted before the host clears its busy flag. Other completion
      // handlers can outlast this timer, with no later agent_settled event to retry it.
      if (!ctx.isIdle()) { scheduleResume(ctx); return; }
      const goal = focusedGoal(state)!;
      if (error || hooks.protected() || hooks.state().plan) return;
      const failure = lastFailure(ctx);
      if (failure) {
        // Error retries have their own limit and must also recover the last paid wake.
        if (failure !== retriedFailure && !retryTimer) retryTimer = setTimeout(() => recoverFailure(ctx, failure, goal.id), hooks.retryDelayMs ?? 1000);
        return;
      }
      if (goalBudgetSpent(state, goal)) { pause(msg`自动续跑达到 ${goalLimitLabel(goal)} 轮上限`, ctx); return; }
      if (!available()) return;
      if (automaticRound && !assessProgress(ctx)) return;
      const { step } = runnableStep(goal);
      if (!step) return; // Running children, rather than a missing model-authored checkpoint, defer work.
      beforeWake(ctx);
      const entry = continuation(ctx, step);
      if (!entry) return;
      resumeWanted = false;
      try { pi.sendMessage(entry, { triggerTurn: true, deliverAs: 'followUp' }); }
      catch (cause) { pause(msg`启动失败：${String(cause)}`, ctx); }
    }, Math.max(10, hooks.resumeDelayMs ?? 50));
  }
  // Confirmation belongs to a real provider turn, not an uncommitted boundary draft.
  pi.on('turn_start', (_event, ctx) => {
    // Pi may resume its own overflow retry; that request wins over an idle fallback wake.
    resumeWanted = false;
    if (resumeTimer) clearTimeout(resumeTimer); resumeTimer = undefined;
    const wake = state.run.pendingWake;
    if (!wake) return;
    stepAck = { ...wake, ...(stepAck?.id === wake.id && stepAck.message ? { message: stepAck.message } : {}) };
    commit(releaseGoalWake(state, false), ctx); rejectedWakes = 0; resumeWanted = false; automaticRound = true;
  });
  pi.on('context', (event, ctx) => {
    const ack = stepAck; stepAck = undefined;
    if (!ack?.nextStep || ack.goalId !== state.focusId || state.run.paused) return;
    const visible = event.messages.some((message) => {
      if ((message as { details?: { wakeId?: string } }).details?.wakeId === ack.id) return true;
      const content = (message as { content?: unknown }).content;
      const text = typeof content === 'string' ? content : Array.isArray(content) ? content.filter((part) => part?.type === 'text').map((part) => part.text).join('\n') : '';
      return ack.message !== undefined && text === ack.message;
    });
    if (!visible) return; // A memory transform removed the step: retain it for a later request.
    activeStep = { goalId: ack.goalId, text: ack.nextStep };
    if (state.run.nextStep === ack.nextStep) {
      const next = { ...state, run: { ...state.run } }; delete next.run.nextStep; commit(next, ctx);
    }
  });
  pi.on('session_before_compact', (event, ctx) => {
    // willRetry is Pi's explicit recovery signal. It never arms a prior user-disable or budget pause.
    if (event.willRetry && interruptedGoalId === state.focusId && state.run.paused && state.run.reason === msg('用户中断')) {
      const run = { ...state.run, paused: false }; delete run.reason;
      commit({ ...state, run }, ctx); hooks.resumeAgents(); interruptedGoalId = undefined;
    }
    compacting = true; compactionInterrupted = false;
    compactionGoalId = !state.run.paused ? focusedGoal(state)?.id : undefined;
    if (compactionGoalId !== undefined) resumeWanted = true;
    if (resumeTimer) clearTimeout(resumeTimer); resumeTimer = undefined;
    if (retryTimer) clearTimeout(retryTimer); retryTimer = undefined;
    commit(releaseGoalWake(state), ctx);
  });
  pi.on('session_compact', (_event, ctx) => {
    compacting = false;
    if (focusedGoal(state)) { checkpointPending = true; lastCheckpoint = undefined; }
    // Native recovery can issue its next request before another start/boundary hook.
    const checkpoint = makeCheckpoint();
    if (checkpoint) pi.sendMessage(checkpoint, { triggerTurn: false });
    if (compactionGoalId === state.focusId && !state.run.paused) {
      const step = activeStep;
      if (compactionInterrupted && step && step.goalId === state.focusId && state.run.nextStep === undefined) commit({ ...state, run: { ...state.run, nextStep: step.text } }, ctx);
      resumeWanted = true; scheduleResume(ctx);
    }
    compactionGoalId = undefined; compactionInterrupted = false;
  });
  pi.on('session_compact_failed', (_event, ctx) => { compacting = false; compactionGoalId = undefined; compactionInterrupted = false; if (resumeWanted) pause(msg('上下文压缩未完成，自动续跑已暂停'), ctx); });
  async function restore(ctx: ExtensionContext) {
    sessionEpoch++; menuPrompt = undefined; failureCache = undefined; stampedTasks = undefined;
    userAuthority = false; automaticRound = false; waitedForChildren.clear(); revision = 0; error = undefined;
    if (retryTimer) clearTimeout(retryTimer);
    retryTimer = undefined; retriedFailure = undefined;
    if (resumeTimer) clearTimeout(resumeTimer);
    resumeTimer = undefined; compacting = false; resumeWanted = false; stepAck = undefined; activeStep = undefined; rejectedWakes = 0; interruptedGoalId = undefined;
    try {
      state = releaseGoalWake(restoreGoalState(hooks.branch?.(ctx) ?? ctx.sessionManager.getBranch(), msg));
      state = pauseGoal(state, focusedGoal(state) ? msg('会话恢复') : state.run.reason ?? '');
      if (!focusedGoal(state) && !state.run.reason) delete state.run.reason;
      config = await (hooks.loadConfig?.() ?? loadConfig(msg));
    } catch (cause) { error = String(cause); state = emptyGoalState(); notify(ctx, msg`Goal／配置恢复失败：${error}；保留历史，/goal reset 明确清除 Goal，配置错误请修复后重载`, 'error'); }
    standaloneReports = !state.run.reason;
    checkpointPending = Boolean(focusedGoal(state)); lastCheckpoint = undefined;
    syncNoPauseTools();
    baseline = workStamp(); lastProgress = state.run.progress ?? '';
    paint(ctx);
  }
  pi.on('session_start', (_event, ctx) => restore(ctx));
  pi.on('session_tree', (_event, ctx) => restore(ctx));
  const stopPendingRetry = (_event: unknown, ctx: ExtensionContext) => {
    cancelRetry(ctx); resumeWanted = false; stepAck = undefined; interruptedGoalId = undefined; rejectedWakes = 0;
    if (resumeTimer) clearTimeout(resumeTimer); resumeTimer = undefined;
    commit(releaseGoalWake(state), ctx);
  };
  pi.on('session_before_switch', stopPendingRetry);
  pi.on('session_before_fork', stopPendingRetry);
  pi.on('session_before_tree', stopPendingRetry);
  pi.on('session_shutdown', () => { sessionEpoch++; menuPrompt = undefined; failureCache = undefined; stampedTasks = undefined; state = emptyGoalState(); syncNoPauseTools(); checkpointPending = false; lastCheckpoint = undefined; userAuthority = false; if (retryTimer) clearTimeout(retryTimer); retryTimer = undefined; if (resumeTimer) clearTimeout(resumeTimer); resumeTimer = undefined; resumeWanted = false; compacting = false; stepAck = undefined; });
  pi.on('before_agent_start', (event) => {
    delete event.systemPromptOptions.sections['dag_workflow_goal'];
    const goal = focusedGoal(state);
    syncNoPauseTools();
    if (noPauseRunning()) event.systemPromptOptions.selectedTools = event.systemPromptOptions.selectedTools.filter((name) => !config.goalNoPauseTools.includes(name));
    if (goal && !hooks.state().plan) event.systemPromptOptions.sections['dag_workflow_goal'] = `Current Goal #${goal.id}: ${clean(goal.title)}. ${goalRules(state)}`;
    const message = makeCheckpoint();
    if (message) return { message };
  });
  pi.on('input', (event, ctx) => { if (event.source !== 'extension') { cancelRetry(ctx); commit(releaseGoalWake(state), ctx); stepAck = undefined; resumeWanted = false; interruptedGoalId = undefined; rejectedWakes = 0; userAuthority = true; automaticRound = false; if (!focusedGoal(state) && !event.text.startsWith('/')) standaloneReports = true; } });
  pi.on('tool_execution_end', (event) => {
    if (event.isError) return;
    if (event.toolName === 'subagent_wait') {
      const details = (event.result as { details?: { id?: string; status?: string; timedOut?: boolean } } | undefined)?.details;
      if (details?.id && details.timedOut && ['starting', 'running'].includes(details.status ?? '') && hooks.jobs().some((job) => job.id === details.id && ['starting', 'running'].includes(job.status))) waitedForChildren.add(details.id);
    }
    if (['write', 'edit', 'bash', 'powershell'].includes(event.toolName) || event.toolName === 'subagent_spawn' && !(event.result as { isError?: boolean })?.isError) revision++;
  });
  pi.on('ui_prompt_start', (event, ctx) => {
    if (hooks.isUserPrompt?.(event.title)) return;
    if (event.kind === 'select' && menuPrompt?.title === event.title) return;
    if (event.kind !== 'custom') pause(msg('等待用户答复'), ctx);
  });
  // Pi skips before_settle when an operation is aborted; observe the run/turn too.
  pi.on('turn_end', (event, ctx) => {
    if (event.outcome === 'completed') {
      if (state.run.errorRetries) commit({ ...state, run: { ...state.run, errorRetries: 0 } }, ctx);
      const checkpoint = makeCheckpoint();
      if (checkpoint) return { entries: [...(event.entries ?? []), { type: 'custom_message' as const, ...checkpoint }] };
      return;
    }
    if (event.outcome === 'aborted') interrupted(ctx);
  });
  pi.on('agent_end', (event, ctx) => {
    const last = event.messages.findLast((message) => message.role === 'assistant');
    if (ctx.signal?.aborted || last?.role === 'assistant' && last.stopReason === 'aborted') interrupted(ctx);
  });
  // One failure reports at several boundaries, and Pi drains queued messages inside the same run,
  // so retries are decided once the run settled and Pi's own recovery had its chance.
  pi.on('agent_settled', (_event, ctx) => {
    if (state.run.pendingWake) {
      commit(releaseGoalWake(state), ctx); resumeWanted = true;
      if (++rejectedWakes >= 3) { pause(msg('续跑请求未被执行，请检查压缩或扩展后明确恢复'), ctx); return; }
    }
    // A settled active Goal must either have a runnable next action, await real children,
    // recover an error, or visibly pause. This also covers hosts/extensions skipping before-settle.
    if (focusedGoal(state) && !state.run.paused) resumeWanted = true;
    scheduleResume(ctx);
    if (compacting || hooks.protected() || hooks.state().plan || !focusedGoal(state) || state.run.paused) return;
    const failure = lastFailure(ctx);
    if (!failure || failure === retriedFailure) return;
    const goalId = focusedGoal(state)!.id;
    if (retryTimer) clearTimeout(retryTimer); // A new settled failure replaces the stale delayed work.
    retryTimer = setTimeout(() => recoverFailure(ctx, failure, goalId), hooks.retryDelayMs ?? 1000);
  });
  pi.on('agent_before_settle', (event, ctx) => {
    if (event.outcome !== 'completed') { if (event.outcome === 'aborted') interrupted(ctx); return; }
    if (compacting || state.run.pendingWake || !focusedGoal(state) || state.run.paused || error || hooks.protected() || hooks.state().plan) return;
    if (event.continue) return; // An Agent report already requested and paid for this next request.
    const goal = focusedGoal(state)!;
    if (goalBudgetSpent(state, goal)) { pause(msg`自动续跑达到 ${goalLimitLabel(goal)} 轮上限`, ctx); return; }
    if (!assessProgress(ctx)) return;
    // A checkpoint nextStep can name independent main work even while children run.
    const { initial, step: nextStep } = runnableStep(goal);
    if (!nextStep) {
      if (initial) { const waiting = { ...state, run: { ...state.run } }; delete waiting.run.nextStep; commit(waiting, ctx); }
      return; // Wait for real child reports, no polling model calls.
    }
    const entry = continuation(ctx, nextStep);
    if (entry) return { entries: [...(event.entries ?? []), entry], continue: true };
  });
  function mutate(params: GoalParams, ctx: ExtensionContext, explicit = false) {
    if ((error || hooks.protected()) && !['list', 'get'].includes(params.action) && !stops(params.action)) throw new Error(error ?? msg('工作流状态受保护'));
    if (hooks.state().plan && !['list', 'get'].includes(params.action) && !stops(params.action)) throw new Error(msg('Plan 只读：Goal 可查看或停用；改动请先 /plan off'));
    const current = focusedGoal(state);
    const target = state.goals.find((goal) => goal.id === (params.id ?? state.focusId));
    if (!explicit && target?.modelPause === 'deny' && (params.action === 'disable' || params.action === 'delete' || params.action === 'update' && params.nextStep !== undefined && !params.nextStep.trim())) throw new Error(`Goal #${target.id} nopause forbids model disable/delete and empty nextStep. Do not ask the user or stop. Resolve gaps autonomously, inspect evidence and execute a safe alternative within the original scope. Only the user may /goal disable.`);
    if (automaticRound && !userAuthority && !explicit && params.action === 'update' && (params.title !== undefined || params.description !== undefined || params.maxTurns !== undefined)) throw new Error(msg('自动续跑修改目标范围／上限前需用户确认；progress/nextStep 不受此限制'));
    if (activates(params.action) && !explicit && !userAuthority && (state.run.paused || params.id !== undefined && params.id !== current?.id)) throw new Error(msg('自动续跑不能自行重置预算／切换目标；请等待用户明确恢复'));
    const result = applyGoal(state, params, config.goalMaxTurns, msg);
    const changedFocus = result.state.focusId !== state.focusId;
    const started = activates(params.action) && result.state !== state;
    // An active goal can be idle while waiting for children or after a dropped continuation.
    // Explicit enable takes it forward with the remaining allowance, without re-enabling/refilling it.
    const explicitWake = explicit && activates(params.action) && !started && ctx.isIdle() && !compacting && !state.run.pendingWake;
    if (started || explicitWake || stops(params.action) && current?.id === (params.id ?? current?.id)) {
      result.state = releaseGoalWake(result.state); stepAck = undefined; activeStep = undefined; resumeWanted = false; interruptedGoalId = undefined; rejectedWakes = 0;
      if (resumeTimer) clearTimeout(resumeTimer); resumeTimer = undefined;
    }
    commit(result.state, ctx);
    if (started) { userAuthority = false; automaticRound = false; waitedForChildren.clear(); baseline = workStamp(); lastProgress = ''; }
    const stoppingFocus = stops(params.action) && current !== undefined && (params.id ?? current.id) === current.id;
    if (started || explicitWake || stoppingFocus) cancelRetry(ctx);
    if (stoppingFocus && !focusedGoal(state)) standaloneReports = false;
    if (changedFocus || stoppingFocus) hooks.pauseAgents(); // Drop old queued notices; output remains in Job records.
    if (started || explicitWake) hooks.resumeAgents();
    if ((started || explicitWake) && ctx.isIdle()) {
      if (!available()) { pause(msg`自动续跑达到 ${goalLimitLabel(focusedGoal(state)!)} 轮上限`, ctx); return result; }
      beforeWake(ctx);
      const goal = focusedGoal(state)!;
      const choice = runnableStep(goal);
      const nextStep = choice.questionStep || state.run.nextStep?.trim() || choice.taskStep || msg`推进目标：${goal.title}`;
      if (explicitWake && !state.run.nextStep?.trim()) commit({ ...state, run: { ...state.run, nextStep } }, ctx);
      const entry = continuation(ctx, nextStep);
      if (entry) {
        // Full prompt path refreshes before_agent_start (especially after leaving Plan).
        try { stepAck = { ...state.run.pendingWake!, message: entry.content }; pi.sendUserMessage(entry.content); }
        catch (cause) { pause(msg`启动失败：${String(cause)}`, ctx); }
      }
    }
    return result;
  }
  pi.on('tool_call', (event) => {
    if (noPauseRunning() && config.goalNoPauseTools.includes(event.toolName)) return { block: true, reason: `Goal nopause forbids ${event.toolName}. Act autonomously: inspect available evidence, make reasonable assumptions within scope, and execute an alternative. Do not ask the user or stop.` };
  });
  pi.registerTool({ name: 'goal', label: 'Goal', namespace: workflowNamespace, annotations: sessionMutation, description: 'Manage goals create/update/list/get/delete; enable one target, complete only after verifying every original requirement. Update progress with new evidence and nextStep with a concrete action; notes cannot narrow the objective. Difficulty, failed attempts or uncertainty do not justify stopping. Try safe alternatives before disable for a verified external blocker. User nopause forbids model disable/delete, empty nextStep, user questions and waiting for clarification; act autonomously within existing permissions. Shared auto budget defaults to 32; the user nolimit menu removes its continuation-turn cap without resetting usage.',
    promptSnippet: 'Use goal to track an objective and continue it across turns',
    promptGuidelines: [
      'Create a goal only when the user asks for autonomous multi-turn work or progress tracking; ordinary tasks belong in the todo list. Enable one at a time, and complete it only after verifying the objective.',
      'While a Goal is enabled, pursue its full original objective across turns; a final answer, failed attempt, uncertainty, or completed Todo list does not stop it. Inspect evidence, try alternatives, and verify all requirements before complete. Under nopause, never ask the user, request routine confirmation, or hand work back; resolve gaps autonomously within scope. Wait for real running children, answer their questions yourself, and continue independent work.',
    ], parameters: GoalParamsSchema, executionMode: 'sequential',
    async execute(_id, params, _signal, _update, ctx) {
      try { const result = mutate(params, ctx); return { content: [{ type: 'text', text: result.text }], details: { goalState: structuredClone(state) } }; }
      catch (cause) { return { isError: true, content: [{ type: 'text', text: String(cause) }], details: { error: String(cause) } }; }
    },
    renderCall(args, theme) { return new Text(theme.fg('toolTitle', `󰓾 goal ${clean(args.action ?? '')}${args.id ? ` #${args.id}` : ''}`), 0, 0); },
    renderResult(result, _options, theme) { return new Text(theme.fg(result.isError ? 'error' : 'text', result.content.filter((item) => item.type === 'text').map((item) => item.text.split('\n').map(clean).join('\n')).join('\n')), 0, 0); },
  });
  pi.registerCommand('goal', { description: msg('目标 new/list/enable/disable/complete/delete/edit/get/nopause/nolimit/config/reset，或自然语言'), getArgumentCompletions: (prefix) => completeArguments(prefix, completion), handler: async (args, ctx) => {
    try {
      const [action, ...parts] = args.trim().split(/\s+/);
      if (action === 'help') { ctx.ui.notify(msg('/goal new 标题 · list · enable [ #编号]（省略为当前目标） · disable [ #编号] · complete/delete #编号 · edit #编号 标题 · get #编号 · nopause [ #编号] · nolimit [ #编号] · config · reset；创建不启动，查看不重置预算，停用后需明确 enable 恢复。'), 'info'); return; }
      const id = (value?: string) => { if (value === undefined && state.focusId !== undefined) return state.focusId; if (!value || !/^#?[1-9]\d*$/.test(value)) throw new Error(msg('请给出目标编号')); return Number(value.replace(/^#/, '')); };
      if (!args.trim() || action === 'list') { notify(ctx, `${applyGoal(state, { action: 'list' }, config.goalMaxTurns, msg).text}\n${msg`续跑 ${state.run.used}/${focusedGoal(state) ? goalLimitLabel(focusedGoal(state)!) : '-'} · ${state.run.paused ? (state.run.reason ? localizeSavedMessage(state.run.reason, msg) : msg('未启用')) : msg('运行')}${error ? msg`\n错误：${error}` : ''}`}`, 'info'); return; }
      if (action === 'nopause') {
        if (parts.length > 1) throw new Error(msg('此命令只接受一个编号'));
        await noPauseMenu(id(parts[0]), ctx); return;
      }
      if (action === 'nolimit') {
        if (parts.length > 1) throw new Error(msg('此命令只接受一个编号'));
        await noLimitMenu(id(parts[0]), ctx); return;
      }
      if (action === 'config') { notify(ctx, JSON.stringify({ path: configPaths().config, ...config }), 'info'); return; }
      if (action === 'reset') {
        if (!ctx.hasUI || !await ctx.ui.confirm(msg('清除 Goal 状态？'), msg('保留历史、Todos、Job 和项目文件；自动续跑停止。'))) return;
        stopPendingRetry(undefined, ctx); hooks.pauseAgents(); activeStep = undefined;
        userAuthority = false; automaticRound = false; standaloneReports = false; revision = 0;
        commit(emptyGoalState(), ctx); baseline = workStamp(); lastProgress = '';
        config = await loadConfig(msg); error = undefined; return;
      }
      let params: GoalParams | undefined;
      if (action === 'new') params = { action: 'create', title: parts.join(' ') };
      else if (action === 'edit') params = { action: 'update', id: id(parts[0]), title: parts.slice(1).join(' ') };
      else if (['enable', 'disable', 'complete', 'delete', 'get'].includes(action ?? '')) {
        if (parts.length > 1) throw new Error(msg('此命令只接受一个编号'));
        params = { action: action as GoalParams['action'], id: id(parts[0]) };
      }
      if (params) { notify(ctx, mutate(params, ctx, true).text, 'info'); return; }
      pi.sendUserMessage(msg`请管理当前 Goal：${args}`, ctx.isIdle() ? undefined : { deliverAs: 'followUp' });
    } catch (cause) { notify(ctx, String(cause), 'error'); }
  } });
  return {
    title: () => { const goal = focusedGoal(state); return goal ? `#${goal.id} ${goal.title}${state.run.paused ? msg('（暂停）') : ''}` : undefined; },
    canWake: available,
    resumeAgentReports: () => {
      if (focusedGoal(state)) return available(); // Never bypass a paused or exhausted Goal.
      if (error || hooks.protected() || hooks.state().plan) return false;
      standaloneReports = true;
      return true;
    },
    reserveWake,
    beforeWake,
    isCompacting: () => compacting,
    pause: (reason: string, ctx: ExtensionContext) => pause(reason, ctx),
    snapshot: () => structuredClone(state),
  };
}
