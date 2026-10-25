import { randomUUID } from 'node:crypto';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { activates, applyGoal, emptyGoalState, focusedGoal, GOAL_TYPE, goalAutoresearch, goalBudgetSpent, goalLimitLabel, goalModelPause, pauseGoal, releaseGoalWake, reserveGoalWake, restoreGoalState, setGoalAutoresearch, setGoalNolimit, setModelPausePolicy, stops, type Goal, type GoalParams, type GoalState } from './state.ts';
import { defaultConfig, loadConfig, type WorkflowConfig } from '../../shared/config.ts';
import { GOAL_CHECKPOINT_TYPE, goalCheckpoint, goalWakeRules, hasCurrentGoalContract } from './prompt.ts';
import { passiveMessage } from '../../shared/passive-message.ts';
import { clean, notify } from '../../shared/terminal.ts';
import type { AgentView } from '../../shared/agent-view.ts';
import { deriveDag } from '../../shared/dag/graph.ts';
import type { WorkflowState } from '../../shared/task-types.ts';
import { chinese, createTranslator, type Translator } from '../../shared/i18n.ts';
import { GOAL_CONTINUE_MESSAGE, GOAL_RETRY_MESSAGE } from '../../shared/message-types.ts';
import { classifyModelError, goalRetryDelay, type ModelFailure } from './failure.ts';
import { goalIO } from '../io/host.ts';

export interface Hooks { menuOwned?(title: string | undefined, ctx: ExtensionContext): boolean; summary?(): boolean; setSummary?(visible: boolean, ctx: ExtensionContext): void; msg?: Translator; state(): WorkflowState; jobs(): readonly AgentView[]; paint(ctx: ExtensionContext): void; protected(): boolean; pauseAgents(): void; resumeAgents(): void; onSaved?(ctx: ExtensionContext): void; beforeWake?(ctx: ExtensionContext): void; resumeDelayMs?: number; isUserPrompt?(title: string | undefined): boolean; branch?(ctx: ExtensionContext): ReturnType<ExtensionContext['sessionManager']['getBranch']>; loadConfig?(): Promise<WorkflowConfig>; retryEnabled?(): boolean; retryConfigured?(): boolean; retryResumeAfterCompaction?(): boolean; cancelRecovery?(): void; retryStatus?(): unknown }
/** One shared budget for plugin continuations and child-report wakes. No goal dispatcher. */
export function createGoalOwner(pi: ExtensionAPI, hooks: Hooks) {
  const msg = hooks.msg ?? chinese, en = createTranslator('en'), io = goalIO(pi);
  let state = emptyGoalState();
  let config: WorkflowConfig = defaultConfig();
  const checkpoint = passiveMessage(GOAL_CHECKPOINT_TYPE, () => goalCheckpoint(state), hooks.branch);
  // Request-local only: native history stays authoritative. Once needed, keep the same
  // contract at one fixed position even after a normal boundary makes it visible again.
  let contractProjection: { role: 'custom'; customType: string; content: string; display: false; details: { requestLocal: true }; timestamp: number } | undefined;
  const removedTools = new Map<string, number>();
  const noPauseRunning = () => !state.run.paused && !hooks.state().plan && Boolean(focusedGoal(state) && goalModelPause(focusedGoal(state)!) === 'deny');
  const sameGoal = (left: Goal | undefined, right: Goal | undefined) => left === right || Boolean(left && right && left.id === right.id && left.title === right.title && left.description === right.description && left.status === right.status && left.maxTurns === right.maxTurns && left.createdAt === right.createdAt && left.completedAt === right.completedAt && left.modelPause === right.modelPause && left.nolimit === right.nolimit && left.autoresearch === right.autoresearch);
  function syncNoPauseTools() {
    // Remove only currently active tools; restore only tools this controller removed.
    // The tool_call guard also covers nested/codemode calls and later external reactivation.
    if (!io.getActiveTools || !io.setActiveTools) return;
    const active = io.getActiveTools();
    const banned = new Set(noPauseRunning() ? config.goalNoPauseTools : []);
    const restored = [...removedTools].filter(([name]) => !banned.has(name)).sort((a, b) => a[1] - b[1]);
    for (const [name] of restored) removedTools.delete(name);
    active.forEach((name, index) => { if (banned.has(name) && !removedTools.has(name)) removedTools.set(name, index); });
    const next = active.filter((name) => !banned.has(name));
    for (const [name, index] of restored) if (!next.includes(name)) next.splice(Math.min(index, next.length), 0, name);
    if (next.length !== active.length || next.some((name, index) => name !== active[index])) io.setActiveTools(next);
  }
  function beforeWake(ctx: ExtensionContext) {
    hooks.beforeWake?.(ctx);
    checkpoint.beforeWake(ctx, (message) => io.sendMessage(message, { triggerTurn: false }));
  }
  let error: string | undefined;
  let userAuthority = false;
  let automaticRound = false;
  const waitedForChildren = new Set<string>();
  let standaloneReports = true;
  let revision = 0;
  let errorGoalId: number | undefined;
  let retryFailureId: string | undefined;
  let requestGoalId: number | null | undefined;
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
  // One ephemeral readiness projection for the current immutable Todo array, not a queue.
  let readyTasks: WorkflowState['tasks'] | undefined;
  let readyIds = new Set<number>();
  const workStamp = () => {
    const tasks = hooks.state().tasks;
    if (tasks !== stampedTasks) {
      stampedTasks = tasks;
      taskStamp = JSON.stringify(tasks.filter((task) => task.status !== 'deleted').map((task) => [task.id, task.status]));
    }
    return `${revision}:${taskStamp}`;
  };
  let failureCache: { manager: ExtensionContext['sessionManager']; leaf: string | null; failure: ModelFailure | undefined } | undefined;
  const paint = (ctx: ExtensionContext) => hooks.paint(ctx);
  function commit(next: GoalState, ctx: ExtensionContext) {
    if (next === state) return;
    io.appendEntry(GOAL_TYPE, next);
    const previousGoal = focusedGoal(state);
    const previousRun = state.run;
    state = next;
    if (!sameGoal(previousGoal, focusedGoal(state)) || state.run.paused !== previousRun.paused || state.run.reason !== previousRun.reason) checkpoint.mark();
    syncNoPauseTools();
    hooks.onSaved?.(ctx);
    paint(ctx);
  }
  function pause(reason: string, ctx: ExtensionContext, keepRecovery = false) {
    retryFailureId = undefined;
    if (!keepRecovery) { errorGoalId = undefined; hooks.cancelRecovery?.(); } resumeWanted = false; interruptedGoalId = undefined; rejectedWakes = 0;
    if (resumeTimer) clearTimeout(resumeTimer); resumeTimer = undefined;
    commit(releaseGoalWake(state), ctx); stepAck = undefined;
    if (!focusedGoal(state) || state.run.paused) return;
    commit(pauseGoal(state, reason), ctx);
    hooks.pauseAgents();
    notify(ctx, msg`Goal 已暂停：${reason}；/goal enable 明确恢复`, 'warning');
  }
  const available = () => errorGoalId === undefined && !error && !hooks.protected() && !hooks.state().plan && (!focusedGoal(state) ? standaloneReports : !state.run.paused && (!goalBudgetSpent(state, focusedGoal(state)!) || Boolean(state.run.pendingWake)));
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
  /** Enabled /retry owns recovery; otherwise Goal supplies bounded short recovery. */
  function failedRequest(ctx: ExtensionContext, waiting?: boolean) {
    const goal = focusedGoal(state);
    if (!goal || goal.status !== 'active' || requestGoalId === null || requestGoalId !== undefined && requestGoalId !== goal.id || state.run.paused && errorGoalId !== goal.id) return;
    if (goalBudgetSpent(state, goal)) { pause(msg`自动续跑达到 ${goalLimitLabel(goal)} 轮上限`, ctx); return; }
    resumeWanted = false;
    // Cancelling already-owned /retry work must not silently start a second recovery layer.
    if (hooks.retryEnabled?.() === true || waiting === false && errorGoalId === goal.id && retryFailureId === undefined) {
      if (resumeTimer) clearTimeout(resumeTimer); resumeTimer = undefined;
      retryFailureId = undefined; errorGoalId = goal.id;
      pause(msg('模型请求出错，已移交自动重试：/retry status 查看，/retry off 停止，/goal enable 终止等待'), ctx, true);
      return;
    }
    if (state.run.paused) return;
    const failure = lastFailure(ctx);
    if (!failure || retryFailureId === failure.id) return;
    if (resumeTimer) clearTimeout(resumeTimer); resumeTimer = undefined;
    errorGoalId = goal.id;
    const attempts = state.run.errorRetries ?? 0;
    if (failure.kind === 'permanent') { pause(failure.message + '\n' + (hooks.retryConfigured?.() ? msg('使用 /retry on 接管长间隔重试') : msg('使用 /retry when-error 5m 开启长间隔重试')), ctx); return; }
    if (attempts >= config.goalErrorRetries) { pause(msg('本轮重试次数已用完'), ctx); return; }
    const epoch = sessionEpoch;
    retryFailureId = failure.id;
    const recover = () => {
      resumeTimer = undefined;
      if (epoch !== sessionEpoch || state.run.paused || compacting || hooks.state().plan || hooks.protected() || error || focusedGoal(state)?.id !== goal.id || errorGoalId !== goal.id || lastFailure(ctx)?.id !== failure.id) return;
      if (hooks.retryEnabled?.() === true) { retryFailureId = undefined; failedRequest(ctx); return; }
      if (!ctx.isIdle()) { resumeTimer = setTimeout(recover, goalRetryDelay(attempts)); return; }
      if (!prepareErrorRecovery(ctx)) return;
      commit({ ...state, run: { ...state.run, errorRetries: attempts + 1 } }, ctx);
      const content = `Goal #${goal.id} ${state.run.used}/${goalLimitLabel(goal)}: ${clean(goal.title)}. ${en`重试 ${attempts + 1}/${config.goalErrorRetries}。`}\n${goalWakeRules(state, config.goalNoProgressLimit)}`;
      beforeWake(ctx);
      try {
        io.sendMessage({ customType: GOAL_RETRY_MESSAGE, content, display: true, details: { wakeId: state.run.pendingWake!.id } }, { triggerTurn: true, deliverAs: 'followUp' });
      } catch (cause) { pause(msg`启动失败：${String(cause)}`, ctx); }
    };
    resumeTimer = setTimeout(recover, goalRetryDelay(attempts));
  }
  function prepareErrorRecovery(ctx: ExtensionContext): boolean {
    const goal = focusedGoal(state);
    if (error || hooks.protected()) return false;
    if (hooks.state().plan || !goal || requestGoalId === null) { userAuthority = false; automaticRound = true; return true; }
    if (goal.status !== 'active' || state.run.paused && errorGoalId !== goal.id) return false;
    if (errorGoalId !== goal.id) return false;
    if (goalBudgetSpent(state, goal)) { pause(msg`自动续跑达到 ${goalLimitLabel(goal)} 轮上限`, ctx); return false; }
    errorGoalId = undefined;
    if (state.run.paused) { const run = { ...state.run, paused: false }; delete run.reason; commit({ ...state, run }, ctx); }
    hooks.resumeAgents();
    return reserveWake(ctx, true);
  }
  function undoErrorRecovery(ctx: ExtensionContext) {
    commit(releaseGoalWake(state), ctx);
    if (focusedGoal(state)) errorGoalId = focusedGoal(state)!.id;
  }
  /**
   * The newest assistant message, when the run that ended failed. Pi persists one entry per request,
   * so the entry id names exactly one failure and stays stable while the run reports it.
   */
  function lastFailure(ctx: ExtensionContext): ModelFailure | undefined {
    const manager = ctx.sessionManager;
    const leaf = typeof manager.getLeafId === 'function' ? manager.getLeafId() : undefined;
    if (leaf !== undefined && failureCache?.manager === manager && failureCache.leaf === leaf) return failureCache.failure;
    const branch = hooks.branch?.(ctx) ?? manager.getBranch();
    let failure: ModelFailure | undefined;
    for (let index = branch.length - 1; index >= 0; index--) {
      const entry = branch[index];
      // Compaction is a new recovery boundary. Raw branch history still contains the old
      // failed request even when Pi omitted it from the compacted model context. Treating
      // that retired id as the current failure can suppress every later fallback wake.
      if (entry?.type === 'compaction') break;
      if (!entry || entry.type !== 'message' || entry.message.role !== 'assistant') continue;
      const reason = entry.message.stopReason;
      const message = entry.message.errorMessage ?? '';
      failure = reason === 'error' || reason === 'aborted' ? { id: entry.id, stopReason: reason, kind: classifyModelError(message), message } : undefined;
      break;
    }
    if (leaf !== undefined) failureCache = { manager, leaf, failure };
    return failure;
  }
  function observeAbort(ctx: ExtensionContext) {
    // Run-owned signals distinguish a user's stop from provider stopReason:aborted.
    // A signal-less host can still report cancellation before an assistant attempt exists.
    if (ctx.signal?.aborted || ctx.signal === undefined && !lastFailure(ctx)) interrupted(ctx);
  }
  const waitingInstruction = (goal = focusedGoal(state)) => goal && goalModelPause(goal) === 'deny'
    ? 'Resolve the decision autonomously within scope; do not ask the user.' : 'Try safe alternatives and independent work before asking about a verified external blocker.';
  /** User-owned switches: direct, idempotent, and never a start, pause, budget reset or new Goal field. */
  function setAutoresearchControl(id: number, value: boolean | undefined, ctx: ExtensionContext): void {
    if (error || hooks.protected()) throw new Error(error ?? msg('工作流状态受保护'));
    const goal = state.goals.find((item) => item.id === id && !['deleted', 'completed'].includes(item.status));
    if (!goal) throw new Error(msg('找不到未完成目标；请给出 id'));
    const next = value ?? !goalAutoresearch(goal);
    commit(setGoalAutoresearch(state, id, next, msg), ctx);
    notify(ctx, msg`Goal #${id}：${(next ? msg('持续研究') : msg('普通目标'))}`, 'info');
  }
  function setPauseControl(id: number, value: boolean | undefined, ctx: ExtensionContext): void {
    if (error || hooks.protected()) throw new Error(error ?? msg('工作流状态受保护'));
    const goal = state.goals.find((item) => item.id === id && item.status !== 'deleted');
    if (!goal) throw new Error(msg('找不到目标；请给出 id'));
    const next = value ?? goal.modelPause !== 'deny';
    commit(setModelPausePolicy(state, id, next ? 'deny' : 'allow', msg), ctx);
    const forced = goalAutoresearch(goal) ? msg('；当前持续研究禁止模型中断；此设置在普通模式生效') : '';
    notify(ctx, msg`Goal #${id}：${(next ? msg('禁止模型中断') : msg('允许模型中断'))}` + forced, 'info');
  }
  function setLimitControl(id: number, value: boolean | undefined, ctx: ExtensionContext): void {
    if (error || hooks.protected()) throw new Error(error ?? msg('工作流状态受保护'));
    const goal = state.goals.find((item) => item.id === id && item.status !== 'deleted');
    if (!goal) throw new Error(msg('找不到目标；请给出 id'));
    const next = value ?? goal.nolimit !== true;
    commit(setGoalNolimit(state, id, next, msg), ctx);
    const forced = goalAutoresearch(goal) ? msg('；当前持续研究不限轮数；此设置在普通模式生效') : '';
    notify(ctx, msg`Goal #${id}：${(next ? msg('不限续跑轮数') : msg`使用轮数上限（${goal.maxTurns} 轮）`)}` + forced, 'info');
  }
  function continuation(ctx: ExtensionContext, nextStep: string) {
    if (!reserveWake(ctx, true)) return;
    const goal = focusedGoal(state)!;
    const replacesInitial = state.run.pendingWake!.usedBefore === 0 && state.run.nextStep === msg`推进目标：${goal.title}`;
    commit({ ...state, run: { ...state.run, ...(replacesInitial ? { nextStep } : {}), pendingWake: { ...state.run.pendingWake!, nextStep } } }, ctx);
    // The one-shot step is consumed only after the actual request sees its continuation message.
    return { type: 'custom_message' as const, customType: GOAL_CONTINUE_MESSAGE, details: { wakeId: state.run.pendingWake!.id }, content: `Goal #${goal.id} ${state.run.used}/${goalLimitLabel(goal)}: ${clean(goal.title)}. Suggested next action (model note; original objective and permissions take precedence): ${JSON.stringify(clean(nextStep))}\n${goalWakeRules(state, config.goalNoProgressLimit)}\n${en('这是工作流续跑，不是用户新授权。')}`, display: true };
  }
  function interrupted(ctx: ExtensionContext) {
    if (compacting) { compactionInterrupted = true; return; }
    const goal = focusedGoal(state); const wasRunning = !state.run.paused;
    pause(msg('用户中断'), ctx);
    if (goal && wasRunning) interruptedGoalId = goal.id;
  }
  function todoStep(task: WorkflowState['tasks'][number]): string {
    const job = hooks.jobs().findLast((item) => item.todoId === task.id);
    if (job?.status === 'completed' && !job.taskReportStale) return en`核验 Task #${task.id}：${task.subject}；子 Agent ${job.id} 已结束，若报告不在上下文中，用 subagent_inspect output:true 查看；核验后再更新任务。`;
    if (job && ['failed', 'cancelled', 'interrupted'].includes(job.status) && (!job.taskReportStale || job.dismissed)) return en`接续 Task #${task.id}：先用 subagent_inspect output:true 查看 ${job.id} 的诊断并核验产物；范围未变时可 subagent_spawn resumeFrom=${job.id}，必要时查询并换 Profile；不要新建替代 Task 或盲目重放。`;
    return en`推进并核验 Task #${task.id}：${task.subject}`;
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
  function modelNextStep(goal: Goal) {
    const step = state.run.nextStep?.trim();
    return state.run.used === 0 && step === msg`推进目标：${goal.title}` ? en`推进目标：${goal.title}` : step;
  }
  function runnableStep(goal: NonNullable<ReturnType<typeof focusedGoal>>) {
    const jobs = hooks.jobs();
    const active = jobs.filter((job) => ['starting', 'running', 'waiting'].includes(job.status));
    const assigned = new Set(active.map((job) => job.todoId));
    const tasks = hooks.state().tasks;
    if (tasks !== readyTasks) { readyIds = new Set(deriveDag(tasks).ready); readyTasks = tasks; }
    const candidates = tasks.filter((task) => !assigned.has(task.id) && (readyIds.has(task.id) || task.status === 'in_progress'));
    const latest = new Map(jobs.filter((job) => job.todoId !== undefined).map((job) => [job.todoId!, job]));
    const task = candidates.find((task) => task.status === 'in_progress' && latest.get(task.id)?.status === 'completed' && !latest.get(task.id)?.taskReportStale) ?? candidates[0];
    const initial = state.run.used === 0 && state.run.nextStep === msg`推进目标：${goal.title}`;
    const taskStep = task && todoStep(task);
    const question = active.find((job) => job.status === 'waiting');
    const questionStep = question && en`检查子 Agent ${question.id} 的待答复问题（subagent_inspect output:true）；在当前 Goal 范围内答复，${waitingInstruction(goal)}`;
    const attention = !active.length && (goalAutoresearch(goal)
      ? en`检查 Goal #${goal.id} 的研究范围与已有证据（goal get）；核验阶段成果后选择下一项有用研究，不完成整个 Goal，不重复无效尝试。`
      : en`核对 Goal #${goal.id} 的目标、要求与进展（goal get）；继续未达成的当前范围，达成时 complete，${waitingInstruction(goal)}`);
    return { active: active.length, initial, step: questionStep || (initial && active.length ? taskStep : modelNextStep(goal) || taskStep || attention || undefined), taskStep, questionStep };
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
        failedRequest(ctx);
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
      try { io.sendMessage(entry, { triggerTurn: true, deliverAs: 'followUp' }); }
      catch (cause) { pause(msg`启动失败：${String(cause)}`, ctx); }
    }, Math.max(10, hooks.resumeDelayMs ?? 50));
  }
  // Confirmation belongs to a real provider turn, not an uncommitted boundary draft.
  pi.on('turn_start', (_event, ctx) => {
    requestGoalId = !state.run.paused ? focusedGoal(state)?.id ?? null : null;
    // Pi may resume its own overflow retry; that request wins over an idle fallback wake.
    resumeWanted = false;
    if (resumeTimer) clearTimeout(resumeTimer); resumeTimer = undefined;
    const wake = state.run.pendingWake;
    if (!wake) return;
    stepAck = { ...wake, ...(stepAck?.id === wake.id && stepAck.message ? { message: stepAck.message } : {}) };
    commit(releaseGoalWake(state, false), ctx); rejectedWakes = 0; resumeWanted = false; automaticRound = true;
  });
  pi.on('context', (event, ctx) => {
    const recovery = checkpoint.recover(event.messages, ctx, event);
    const result = recovery ? { messages: [...event.messages, { ...recovery, details: { ...recovery.details, requestLocal: true } }] } : undefined;
    const ack = stepAck; stepAck = undefined;
    if (!ack?.nextStep || ack.goalId !== state.focusId || state.run.paused) return result;
    const visible = event.messages.some((message) => {
      if ((message as { details?: { wakeId?: string } }).details?.wakeId === ack.id) return true;
      const content = (message as { content?: unknown }).content;
      const text = typeof content === 'string' ? content : Array.isArray(content) ? content.filter((part) => part?.type === 'text').map((part) => part.text).join('\n') : '';
      return ack.message !== undefined && text === ack.message;
    });
    if (!visible) { stepAck = ack; return result; } // Keep the paid-step receipt, not the filtered message, for a later visible request.
    activeStep = { goalId: ack.goalId, text: ack.nextStep };
    if (state.run.nextStep === ack.nextStep) {
      const next = { ...state, run: { ...state.run } }; delete next.run.nextStep; commit(next, ctx);
    }
    return result;
  });
  // This phase follows every ordinary context/memory transform in both supported hosts.
  // Never edit system/summary/report data or replay history. Coordinate only this Goal's
  // equivalent contracts, including the one-shot ordinary recovery on its very first frame.
  pi.on('context_with_system', (event) => {
    if (error || hooks.protected() || hooks.state().plan || state.run.paused || !focusedGoal(state)) return;
    const current = (message: typeof event.messages[number]) => hasCurrentGoalContract([message], state);
    const sameGoalContract = (message: typeof event.messages[number]) => {
      const { content, customType } = message as { content?: unknown; customType?: string };
      if (customType !== GOAL_CHECKPOINT_TYPE || typeof content !== 'string' || !content.startsWith('Goal contract (')) return false;
      try { return JSON.parse(content.split('\n')[1]!).goal?.id === state.focusId; } catch { return false; }
    };
    if (!contractProjection && event.messages.some(current) && !event.messages.some((message) => current(message) && (message as { details?: { requestLocal?: boolean } }).details?.requestLocal)) return;
    const content = goalCheckpoint(state);
    if (contractProjection?.content !== content) contractProjection = { role: 'custom', customType: GOAL_CHECKPOINT_TYPE, content, display: false, details: { requestLocal: true }, timestamp: Date.now() };
    const messages = event.messages.filter((message) => !sameGoalContract(message));
    const index = messages[0]?.role === 'system' ? 1 : 0;
    return { messages: [...messages.slice(0, index), contractProjection, ...messages.slice(index)] };
  });
  pi.on('session_before_compact', (event, ctx) => {
    // willRetry is Pi's explicit recovery signal. It never arms a prior user-disable or budget pause.
    if (event.willRetry && interruptedGoalId === state.focusId && state.run.paused && state.run.reason === msg('用户中断')) {
      const run = { ...state.run, paused: false }; delete run.reason;
      commit({ ...state, run }, ctx); hooks.resumeAgents(); interruptedGoalId = undefined;
    }
    compacting = true; compactionInterrupted = false;
    compactionGoalId = !state.run.paused || errorGoalId === state.focusId ? focusedGoal(state)?.id : undefined;
    if (compactionGoalId !== undefined) resumeWanted = true;
    if (resumeTimer) clearTimeout(resumeTimer); resumeTimer = undefined;
    commit(releaseGoalWake(state), ctx);
  });
  pi.on('session_compact', (_event, ctx) => {
    compacting = false; contractProjection = undefined;
    if (!lastFailure(ctx)) {
      // Successful compaction retires a handed-off failure too; a user pause clears errorGoalId.
      if (errorGoalId !== undefined && errorGoalId === state.focusId && state.run.paused) {
        if (hooks.retryResumeAfterCompaction?.() === true) {
          const run = { ...state.run, paused: false }; delete run.reason;
          commit({ ...state, run }, ctx); hooks.resumeAgents();
        } else {
          const reason = msg('上下文已压缩，重试已停止：/retry on 重新开启 或 /goal enable 继续');
          resumeWanted = false; commit(pauseGoal(state, reason), ctx); notify(ctx, reason, 'warning');
        }
      }
      errorGoalId = undefined;
    }
    if (focusedGoal(state)) checkpoint.mark(true);
    // Native recovery may skip beforeWake/boundaries. Ordinary recovery is one-shot;
    // final context places it on the same stable baseline as subsequent missing frames.
    if (compactionGoalId === state.focusId && !state.run.paused) {
      const step = activeStep;
      if (compactionInterrupted && step && step.goalId === state.focusId && state.run.nextStep === undefined) commit({ ...state, run: { ...state.run, nextStep: step.text } }, ctx);
      resumeWanted = true; scheduleResume(ctx);
    }
    compactionGoalId = undefined; compactionInterrupted = false;
  });
  pi.on('session_compact_failed', (_event, ctx) => { compacting = false; compactionGoalId = undefined; compactionInterrupted = false; if (resumeWanted) pause(msg('上下文压缩未完成，自动续跑已暂停'), ctx); });
  async function restore(ctx: ExtensionContext) {
    const ownEpoch = ++sessionEpoch; contractProjection = undefined; menuPrompt = undefined; failureCache = undefined; stampedTasks = undefined; readyTasks = undefined; readyIds = new Set();
    userAuthority = false; automaticRound = false; waitedForChildren.clear(); revision = 0; error = undefined;
    errorGoalId = undefined; retryFailureId = undefined;
    if (resumeTimer) clearTimeout(resumeTimer);
    resumeTimer = undefined; compacting = false; resumeWanted = false; stepAck = undefined; activeStep = undefined; rejectedWakes = 0; interruptedGoalId = undefined;
    try {
      state = releaseGoalWake(restoreGoalState(hooks.branch?.(ctx) ?? ctx.sessionManager.getBranch(), msg));
      requestGoalId = focusedGoal(state)?.id ?? null;
      state = pauseGoal(state, focusedGoal(state) ? msg('会话恢复') : state.run.reason ?? '');
      if (!focusedGoal(state) && !state.run.reason) delete state.run.reason;
      const loaded = await (hooks.loadConfig?.() ?? loadConfig(msg));
      if (ownEpoch !== sessionEpoch) return;
      config = loaded;
    } catch (cause) { if (ownEpoch !== sessionEpoch) return; error = String(cause); state = emptyGoalState(); notify(ctx, msg`Goal／配置恢复失败：${error}；保留历史，/goal reset 明确清除 Goal，配置错误请修复后重载`, 'error'); }
    standaloneReports = !state.run.reason;
    checkpoint.reset(Boolean(focusedGoal(state)));
    syncNoPauseTools();
    baseline = workStamp(); lastProgress = state.run.progress ?? '';
    paint(ctx);
  }
  pi.on('session_start', (_event, ctx) => restore(ctx));
  pi.on('session_tree', (_event, ctx) => restore(ctx));
  const stopPendingRetry = (_event: unknown, ctx: ExtensionContext) => {
    errorGoalId = undefined; retryFailureId = undefined; resumeWanted = false; stepAck = undefined; interruptedGoalId = undefined; rejectedWakes = 0;
    if (resumeTimer) clearTimeout(resumeTimer); resumeTimer = undefined;
    commit(releaseGoalWake(state), ctx);
  };
  const beforeNavigation = (event: unknown, ctx: ExtensionContext) => { sessionEpoch++; menuPrompt = undefined; stopPendingRetry(event, ctx); };
  pi.on('session_before_switch', beforeNavigation);
  pi.on('session_before_fork', beforeNavigation);
  pi.on('session_before_tree', beforeNavigation);
  pi.on('session_shutdown', () => { sessionEpoch++; contractProjection = undefined; menuPrompt = undefined; failureCache = undefined; stampedTasks = undefined; readyTasks = undefined; readyIds = new Set(); state = emptyGoalState(); syncNoPauseTools(); checkpoint.reset(); userAuthority = false; errorGoalId = undefined; retryFailureId = undefined; if (resumeTimer) clearTimeout(resumeTimer); resumeTimer = undefined; resumeWanted = false; compacting = false; stepAck = undefined; });
  pi.on('before_agent_start', (event, ctx) => {
    syncNoPauseTools();
    if (noPauseRunning()) event.systemPromptOptions.selectedTools = event.systemPromptOptions.selectedTools.filter((name) => !config.goalNoPauseTools.includes(name));
    const message = checkpoint.take(ctx, event);
    if (message) return { message };
  });
  pi.on('agent_before_settle', (event, ctx) => {
    const message = checkpoint.take(ctx, event);
    if (message) return { entries: [...event.entries, { type: 'custom_message' as const, ...message }] };
  });
  pi.on('input', (event, ctx) => { if (event.source !== 'extension') { errorGoalId = undefined; retryFailureId = undefined; if (resumeTimer) clearTimeout(resumeTimer); resumeTimer = undefined; commit(releaseGoalWake(state), ctx); stepAck = undefined; resumeWanted = false; interruptedGoalId = undefined; rejectedWakes = 0; userAuthority = true; automaticRound = false; if (!focusedGoal(state) && !event.text.startsWith('/')) standaloneReports = true; } });
  pi.on('tool_execution_end', (event) => {
    if (event.isError) return;
    if (event.toolName === 'subagent_inspect') {
      const details = (event.result as { details?: { id?: string; status?: string; timedOut?: boolean } } | undefined)?.details;
      if (details?.id && details.timedOut && ['starting', 'running'].includes(details.status ?? '') && hooks.jobs().some((job) => job.id === details.id && ['starting', 'running'].includes(job.status))) waitedForChildren.add(details.id);
    }
    if (['write', 'edit', 'bash', 'powershell'].includes(event.toolName) || event.toolName === 'subagent_spawn' && !(event.result as { isError?: boolean })?.isError) revision++;
  });
  pi.on('ui_prompt_start', (event, ctx) => {
    if (hooks.menuOwned?.(event.title, ctx) || hooks.isUserPrompt?.(event.title)) return;
    if (event.kind === 'select' && menuPrompt?.title === event.title) return;
    if (event.kind !== 'custom') pause(msg('等待用户答复'), ctx);
  });
  // Pi skips before_settle when an operation is aborted; observe the run/turn too.
  pi.on('turn_end', (event, ctx) => {
    if (event.outcome === 'completed') {
      errorGoalId = undefined; retryFailureId = undefined;
      if (state.run.errorRetries) commit({ ...state, run: { ...state.run, errorRetries: 0 } }, ctx);
      const message = checkpoint.take(ctx, event);
      if (message) return { entries: [...(event.entries ?? []), { type: 'custom_message' as const, ...message }] };
      return;
    }
    if (event.outcome === 'aborted') observeAbort(ctx);
  });
  pi.on('agent_end', (event, ctx) => {
    const last = event.messages.findLast((message) => message.role === 'assistant');
    if (ctx.signal?.aborted) interrupted(ctx);
    else if (last?.role === 'assistant' && last.stopReason === 'aborted') observeAbort(ctx);
  });
  // One failure reports at several boundaries, and Pi drains queued messages inside the same run,
  // so retries are decided once the run settled and Pi's own recovery had its chance.
  pi.on('agent_settled', (event, ctx) => {
    // The low-level signal is already gone during async before-settle handlers. Pi 1.1+
    // reports late user cancellation here; stop before arming either recovery timer.
    // Do not use interrupted(): native recovery must never rearm this final user stop.
    const aborted = event.aborted;
    const failure = lastFailure(ctx);
    const providerFailure = failure?.message.trim();
    if (ctx.signal?.aborted || aborted === true && !providerFailure) { pause(msg('用户中断'), ctx); return; }
    // Older public APIs cannot distinguish a provider abort from a stop after agent_end.
    // Fail closed only after native recovery has settled, without claiming user intent.
    if (!providerFailure && focusedGoal(state) && !state.run.paused && failure) {
      pause(msg('模型中止（旧宿主无法确认取消）'), ctx); return;
    }
    if (state.run.pendingWake) {
      commit(releaseGoalWake(state), ctx); resumeWanted = true;
      if (++rejectedWakes >= 3) { pause(msg('续跑请求未被执行，已暂停：使用 /goal enable 明确恢复'), ctx); return; }
    }
    if (failure && focusedGoal(state) && !compacting && !hooks.state().plan) { failedRequest(ctx); return; }
    // Successful work retains normal Goal continuation; failed requests select one recovery owner.
    if (focusedGoal(state) && !state.run.paused) resumeWanted = true;
    scheduleResume(ctx);
  });
  pi.on('agent_before_settle', (event, ctx) => {
    if (event.outcome !== 'completed') { if (event.outcome === 'aborted') observeAbort(ctx); return; }
    if (errorGoalId !== undefined || compacting || state.run.pendingWake || !focusedGoal(state) || state.run.paused || error || hooks.protected() || hooks.state().plan) return;
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
    if (!explicit && (target && goalAutoresearch(target) && params.action === 'complete' || current && goalAutoresearch(current) && activates(params.action) && target?.id !== current.id)) throw new Error('autoresearch forbids model Goal completion or switching Goals. Verify this milestone and continue useful research within the original scope; only the user may stop or change the mode.');
    if (!explicit && target && goalModelPause(target) === 'deny' && (params.action === 'disable' || params.action === 'delete' || params.action === 'update' && params.nextStep !== undefined && !params.nextStep.trim())) throw new Error(`Goal #${target.id} nopause forbids model disable/delete and empty nextStep. Do not ask the user or stop. Resolve gaps autonomously, inspect evidence and execute a safe alternative within the original scope. Only the user may /goal disable.`);
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
    if (started || explicitWake || stoppingFocus) { errorGoalId = undefined; retryFailureId = undefined; hooks.cancelRecovery?.(); }
    if (stoppingFocus && !focusedGoal(state)) standaloneReports = false;
    if (changedFocus || stoppingFocus) hooks.pauseAgents(); // Drop old queued notices; output remains in Job records.
    if (started || explicitWake) hooks.resumeAgents();
    if ((started || explicitWake) && ctx.isIdle()) {
      if (!available()) { pause(msg`自动续跑达到 ${goalLimitLabel(focusedGoal(state)!)} 轮上限`, ctx); return result; }
      beforeWake(ctx);
      const goal = focusedGoal(state)!;
      const choice = runnableStep(goal);
      const nextStep = choice.questionStep || modelNextStep(goal) || choice.taskStep || en`推进目标：${goal.title}`;
      if (explicitWake && !state.run.nextStep?.trim()) commit({ ...state, run: { ...state.run, nextStep } }, ctx);
      const entry = continuation(ctx, nextStep);
      if (entry) {
        // Full prompt path refreshes before_agent_start (especially after leaving Plan).
        try { stepAck = { ...state.run.pendingWake!, message: entry.content }; io.sendUserMessage(entry.content, { deliverAs: 'followUp' }); }
        catch (cause) { pause(msg`启动失败：${String(cause)}`, ctx); }
      }
    }
    if (params.action === 'get' && hooks.retryStatus) result.text = JSON.stringify({ ...JSON.parse(result.text), retry: hooks.retryStatus() });
    return result;
  }
  pi.on('tool_call', (event) => {
    if (noPauseRunning() && config.goalNoPauseTools.includes(event.toolName)) return { block: true, reason: `Goal nopause forbids ${event.toolName}. Act autonomously: inspect available evidence, make reasonable assumptions within scope, and execute an alternative. Do not ask the user or stop.` };
  });

  return {
    state: () => state, config: () => config, epoch: () => sessionEpoch,
    sameGoal, mutate, setAutoresearchControl, setPauseControl, setLimitControl,
    openMenu(title: string) { if (menuPrompt) throw new Error(msg('Goal 菜单已打开')); const root = { title, epoch: sessionEpoch }; menuPrompt = root; return root; },
    closeMenu(root: object) { if (menuPrompt === root) menuPrompt = undefined; },
    async reset(ctx: ExtensionContext, ownEpoch: number) {
        stopPendingRetry(undefined, ctx); hooks.pauseAgents(); activeStep = undefined;
        userAuthority = false; automaticRound = false; standaloneReports = false; revision = 0;
        commit(emptyGoalState(), ctx); baseline = workStamp(); lastProgress = '';
        const loaded = await (hooks.loadConfig?.() ?? loadConfig(msg));
        if (ownEpoch === sessionEpoch) { config = loaded; error = undefined; }
    },
    title: () => { const goal = focusedGoal(state); return goal ? `#${goal.id} ${goal.title}${goalAutoresearch(goal) ? msg(' · 持续研究') : ''}${state.run.paused ? msg('（暂停）') : ''}` : undefined; },
    canWake: available,
    resumeAgentReports: () => {
      if (focusedGoal(state)) return available(); // Never bypass a paused or exhausted Goal.
      if (error || hooks.protected() || hooks.state().plan) return false;
      standaloneReports = true;
      return true;
    },
    reserveWake,
    beforeWake,
    failedRequest,
    recoveryGoal: () => { const goal = focusedGoal(state); return goal?.status === 'active' && (!state.run.paused || errorGoalId === goal.id) ? goal : undefined; },
    prepareErrorRecovery,
    undoErrorRecovery,
    isCompacting: () => compacting,
    pause: (reason: string, ctx: ExtensionContext) => pause(reason, ctx),
    snapshot: () => structuredClone(state),
  };
}
