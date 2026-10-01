import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { Text } from '@earendil-works/pi-tui';
import { activates, applyGoal, emptyGoalState, focusedGoal, GOAL_TYPE, GoalParamsSchema, pauseGoal, reserveGoalWake, restoreGoalState, stops, type GoalParams, type GoalState } from './state.ts';
import { configPaths, loadConfig, type WorkflowConfig } from '../shared/config.ts';
import { clean, type AgentView } from '../ui/render.ts';
import { deriveDag } from '../dag/graph.ts';
import type { WorkflowState } from '../todos/state.ts';
import { workflowNamespace, sessionMutation } from '../shared/tool-info.ts';
import { completeArguments, type CompletionSpec } from '../shared/completion.ts';
import { chinese, localizeSavedMessage, type Translator } from '../shared/i18n.ts';

interface Hooks { msg?: Translator; state(): WorkflowState; jobs(): readonly AgentView[]; paint(ctx: ExtensionContext): void; protected(): boolean; pauseAgents(): void; resumeAgents(): void; onSaved?(ctx: ExtensionContext): void }
/** One shared budget for plugin continuations and child-report wakes. No goal dispatcher. */
export function registerGoal(pi: ExtensionAPI, hooks: Hooks) {
  const msg = hooks.msg ?? chinese;
  let state = emptyGoalState();
  let config: WorkflowConfig = { language: 'auto', goalMaxTurns: 32, goalNoProgressLimit: 3, goalErrorRetries: 5 };
  let error: string | undefined;
  let userAuthority = false;
  let automaticRound = false;
  let standaloneReports = true;
  let revision = 0;
  let retryIssued = false;
  let baseline = '';
  let lastProgress = '';
  const workStamp = () => JSON.stringify([revision, hooks.state().tasks.filter((task) => task.status !== 'deleted').map((task) => [task.id, task.status])]);
  const paint = (ctx: ExtensionContext) => hooks.paint(ctx);
  const goalStatusLabel: Record<GoalState['goals'][number]['status'], string> = { active: '活动', paused: '暂停', completed: '已完成', deleted: '已删除' };
  const activatable = new Set(['enable']);
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
      { action: 'config', description: msg('查看配置路径与值') },
      { action: 'reset', description: msg('清除 Goal 状态') },
      { action: 'help', description: msg('查看命令帮助') },
    ],
    freeText: ['new'],
    tokens: (action) => ['enable', 'disable', 'edit', 'complete', 'delete', 'get'].includes(action) ? state.goals
      .filter((goal) => goal.status !== 'deleted' && (!activatable.has(action) || goal.status !== 'completed'))
      .map((goal) => ({ token: `#${goal.id}`, label: `#${goal.id} ${goal.title}`, description: msg(goalStatusLabel[goal.status]) })) : null,
  };
  function commit(next: GoalState, ctx: ExtensionContext) {
    if (next === state) return;
    pi.appendEntry(GOAL_TYPE, next);
    state = next;
    hooks.onSaved?.(ctx);
    paint(ctx);
  }
  function pause(reason: string, ctx: ExtensionContext) {
    if (!focusedGoal(state) || state.run.paused) return;
    commit(pauseGoal(state, reason), ctx);
    hooks.pauseAgents();
    ctx.ui.notify(msg`Goal 已暂停：${reason}；/goal enable 明确恢复`, 'warning');
  }
  const available = () => !error && !hooks.protected() && !hooks.state().plan && (!focusedGoal(state) ? standaloneReports : !state.run.paused && state.run.used < focusedGoal(state)!.maxTurns);
  function reserveWake(ctx: ExtensionContext): boolean {
    if (!available()) return false;
    if (!focusedGoal(state)) return true; // Standalone Agents retain their normal notification behavior.
    const next = reserveGoalWake(state);
    if (!next) return false;
    commit(next, ctx);
    baseline = workStamp(); lastProgress = state.run.progress ?? '';
    userAuthority = false; automaticRound = true;
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
    automaticRound = true;
    ctx.ui.notify(msg`模型出错，自动重试 ${next.run.errorRetries}/${limit}`, 'warning');
    try {
      pi.sendMessage({ customType: 'pi-dag-workflow.goal-retry', content: msg`上一次请求失败（模型出错）。这是 Goal #${goal.id} 的第 ${next.run.errorRetries}/${limit} 次自动重试：继续推进「${clean(goal.title)}」，并按需 goal update progress／nextStep；需要用户时 disable，达成时 complete。`, display: true }, { triggerTurn: true, deliverAs: 'followUp' });
    } catch (cause) { pause(msg`重试失败：${String(cause)}`, ctx); return false; }
    return true;
  }
  const modelErrorPause = () => config.goalErrorRetries > 0 ? msg`模型出错（已重试 ${config.goalErrorRetries} 次）` : msg('模型出错');
  /** One failure can surface at several boundaries; never issue two retries for the same one. */
  function failRun(ctx: ExtensionContext) {
    if (retryIssued) return;
    retryIssued = recoverFromModelError(ctx);
    if (!retryIssued) pause(modelErrorPause(), ctx);
  }
  function continuation(ctx: ExtensionContext, nextStep: string) {
    if (!reserveWake(ctx)) return;
    const goal = focusedGoal(state)!;
    const consumed = { ...state, run: { ...state.run } };
    delete consumed.run.nextStep;
    commit(consumed, ctx); // Never replay a stale action indefinitely.
    return { type: 'custom_message' as const, customType: 'pi-dag-workflow.goal-continue', content: msg`Goal #${goal.id} ${state.run.used}/${goal.maxTurns}: ${clean(nextStep)}。${state.run.used === 1 && goal.description ? msg`要求：${clean(goal.description).slice(0, 1000)}；完整要求可 goal get。` : ''}核验结果；研究可 goal update progress/nextStep，需用户时 disable，达成时 complete。这是工作流续跑，不是用户新授权。`, display: true };
  }
  async function restore(ctx: ExtensionContext) {
    userAuthority = false; automaticRound = false; revision = 0; error = undefined; retryIssued = false;
    try {
      state = restoreGoalState(ctx.sessionManager.getBranch(), msg);
      state = pauseGoal(state, focusedGoal(state) ? msg('会话恢复') : state.run.reason ?? '');
      if (!focusedGoal(state) && !state.run.reason) delete state.run.reason;
      config = await loadConfig(msg);
    } catch (cause) { error = String(cause); state = emptyGoalState(); ctx.ui.notify(msg`Goal／配置恢复失败：${error}；保留历史，/goal reset 明确清除 Goal，配置错误请修复后重载`, 'error'); }
    standaloneReports = !state.run.reason;
    baseline = workStamp(); lastProgress = state.run.progress ?? '';
    paint(ctx);
  }
  pi.on('session_start', (_event, ctx) => restore(ctx));
  pi.on('session_tree', (_event, ctx) => restore(ctx));
  pi.on('session_shutdown', () => { state = emptyGoalState(); userAuthority = false; });
  pi.on('before_agent_start', (event) => {
    retryIssued = false;
    delete event.systemPromptOptions.sections['dag_workflow_goal'];
    const goal = focusedGoal(state);
    if (goal && !hooks.state().plan) event.systemPromptOptions.sections['dag_workflow_goal'] = `Current Goal #${goal.id}: ${clean(goal.title)}${goal.description ? ` — ${clean(goal.description)}` : ''}. ${state.run.paused ? 'Auto-continuation is paused; do not resume without user instruction.' : 'Verify completion. For research without Todos report new progress and concrete nextStep with goal update; use disable when waiting for the user, complete when achieved.'}`;
  });
  pi.on('input', (event) => { if (event.source !== 'extension') { userAuthority = true; automaticRound = false; if (!focusedGoal(state) && !event.text.startsWith('/')) standaloneReports = true; } });
  pi.on('tool_execution_end', (event) => {
    if (event.isError) return;
    if (['write', 'edit'].includes(event.toolName) || event.toolName === 'subagent_spawn' && !(event.result as { isError?: boolean })?.isError) revision++;
  });
  pi.on('ui_prompt_start', (event, ctx) => { if (event.kind !== 'custom') pause(msg('等待用户答复'), ctx); });
  // Pi skips before_settle when an operation is aborted; observe the run/turn too.
  pi.on('turn_end', (event, ctx) => {
    if (event.outcome === 'completed') { if (state.run.errorRetries) commit({ ...state, run: { ...state.run, errorRetries: 0 } }, ctx); return; }
    if (event.outcome === 'aborted') pause(msg('用户中断'), ctx);
    else failRun(ctx);
  });
  pi.on('agent_end', (event, ctx) => {
    const last = event.messages.findLast((message) => message.role === 'assistant');
    if (ctx.signal?.aborted || last?.role === 'assistant' && last.stopReason === 'aborted') pause(msg('用户中断'), ctx);
    else if (last?.role === 'assistant' && last.stopReason === 'error') failRun(ctx);
  });
  pi.on('agent_before_settle', (event, ctx) => {
    if (event.outcome !== 'completed') { if (event.outcome === 'aborted') pause(msg('用户中断'), ctx); else failRun(ctx); return; }
    if (!focusedGoal(state) || state.run.paused || error || hooks.protected() || hooks.state().plan) return;
    if (event.continue) return; // An Agent report already requested and paid for this next request.
    const goal = focusedGoal(state)!;
    if (state.run.used >= goal.maxTurns) { pause(msg`自动续跑达到 ${goal.maxTurns} 轮上限`, ctx); return; }
    const progressed = workStamp() !== baseline || Boolean(state.run.progress?.trim() && state.run.progress !== lastProgress);
    // Only completed automatic rounds count as stalled; user inspections do not refill/consume the budget.
    const stalled = progressed ? 0 : automaticRound ? state.run.stalled + 1 : state.run.stalled;
    commit({ ...state, run: { ...state.run, stalled } }, ctx);
    baseline = workStamp(); lastProgress = state.run.progress ?? '';
    if (stalled >= config.goalNoProgressLimit) { pause(msg`连续 ${stalled} 轮无新进展`, ctx); return; }
    const jobs = hooks.jobs().filter((job) => ['starting', 'running', 'waiting'].includes(job.status));
    const assigned = new Set(jobs.map((job) => job.todoId));
    const tasks = hooks.state().tasks;
    const ready = new Set(deriveDag(tasks).ready);
    const task = tasks.find((task) => !assigned.has(task.id) && (ready.has(task.id) || task.status === 'in_progress'));
    // A checkpoint nextStep can name independent main work even while children run.
    if (state.run.nextStep === '') { pause(msg('等待用户答复'), ctx); return; }
    const initial = state.run.used === 0 && state.run.nextStep === msg`推进目标：${goal.title}`;
    const taskStep = task ? msg`推进并核验 Todo #${task.id}：${task.subject}` : undefined;
    const nextStep = initial && jobs.length ? taskStep : state.run.nextStep?.trim() || taskStep;
    if (!nextStep) {
      if (initial) { const waiting = { ...state, run: { ...state.run } }; delete waiting.run.nextStep; commit(waiting, ctx); }
      if (jobs.length) return; // Wait for real child reports, no polling model calls.
      pause(msg('没有具体下一步，等待用户'), ctx); return;
    }
    const entry = continuation(ctx, nextStep);
    if (entry) return { entries: [entry], continue: true };
  });
  function mutate(params: GoalParams, ctx: ExtensionContext, explicit = false) {
    if ((error || hooks.protected()) && !['list', 'get'].includes(params.action) && !stops(params.action)) throw new Error(error ?? msg('工作流状态受保护'));
    if (hooks.state().plan && !['list', 'get'].includes(params.action) && !stops(params.action)) throw new Error(msg('Plan 只读：Goal 可查看或停用；改动请先 /plan off'));
    const current = focusedGoal(state);
    if (automaticRound && !userAuthority && !explicit && params.action === 'update' && (params.title !== undefined || params.description !== undefined || params.maxTurns !== undefined)) throw new Error(msg('自动续跑修改目标范围／上限前需用户确认；progress/nextStep 不受此限制'));
    if (activates(params.action) && !explicit && !userAuthority && (state.run.paused || params.id !== undefined && params.id !== current?.id)) throw new Error(msg('自动续跑不能自行重置预算／切换目标；请等待用户明确恢复'));
    const result = applyGoal(state, params, config.goalMaxTurns, msg);
    const changedFocus = result.state.focusId !== state.focusId;
    const started = activates(params.action) && result.state !== state;
    commit(result.state, ctx);
    if (started) { userAuthority = false; automaticRound = false; baseline = workStamp(); lastProgress = ''; }
    const stoppingFocus = stops(params.action) && current !== undefined && (params.id ?? current.id) === current.id;
    if (stoppingFocus && !focusedGoal(state)) standaloneReports = false;
    if (changedFocus || stoppingFocus) hooks.pauseAgents(); // Drop old queued notices; output remains in Job records.
    if (started) hooks.resumeAgents();
    if (started && ctx.isIdle()) {
      const entry = continuation(ctx, state.run.nextStep!);
      if (entry) {
        // Full prompt path refreshes before_agent_start (especially after leaving Plan).
        try { pi.sendUserMessage(entry.content); }
        catch (cause) { pause(msg`启动失败：${String(cause)}`, ctx); }
      }
    }
    return result;
  }
  pi.registerTool({ name: 'goal', label: 'Goal', namespace: workflowNamespace, annotations: sessionMutation, description: 'Manage goals create/update/list/get/delete; enable one target, disable or complete after verification. Update progress/nextStep for research; empty nextStep waits for the user. Shared auto budget defaults to 32.', parameters: GoalParamsSchema, executionMode: 'sequential',
    async execute(_id, params, _signal, _update, ctx) {
      try { const result = mutate(params, ctx); return { content: [{ type: 'text', text: result.text }], details: { goalState: structuredClone(state) } }; }
      catch (cause) { return { isError: true, content: [{ type: 'text', text: String(cause) }], details: { error: String(cause) } }; }
    },
    renderCall(args, theme) { return new Text(theme.fg('toolTitle', `󰓾 goal ${clean(args.action ?? '')}${args.id ? ` #${args.id}` : ''}`), 0, 0); },
    renderResult(result, _options, theme) { return new Text(theme.fg(result.isError ? 'error' : 'text', result.content.filter((item) => item.type === 'text').map((item) => item.text.split('\n').map(clean).join('\n')).join('\n')), 0, 0); },
  });
  pi.registerCommand('goal', { description: msg('目标 new/list/enable/disable/complete/delete/edit/get/config/reset，或自然语言'), getArgumentCompletions: (prefix) => completeArguments(prefix, completion), handler: async (args, ctx) => {
    try {
      const [action, ...parts] = args.trim().split(/\s+/);
      if (action === 'help') { ctx.ui.notify(msg('/goal new 标题 · list · enable [ #编号]（省略为当前目标） · disable [ #编号] · complete/delete #编号 · edit #编号 标题 · get #编号 · config · reset；创建不启动，查看不重置预算，停用后需明确 enable 恢复。'), 'info'); return; }
      const id = (value?: string) => { if (value === undefined && state.focusId !== undefined) return state.focusId; if (!value || !/^#?[1-9]\d*$/.test(value)) throw new Error(msg('请给出目标编号')); return Number(value.replace(/^#/, '')); };
      if (!args.trim() || action === 'list') { ctx.ui.notify(`${applyGoal(state, { action: 'list' }, config.goalMaxTurns, msg).text}\n${msg`续跑 ${state.run.used}/${focusedGoal(state)?.maxTurns ?? '-'} · ${state.run.paused ? (state.run.reason ? localizeSavedMessage(state.run.reason, msg) : msg('未启用')) : msg('运行')}${error ? msg`\n错误：${error}` : ''}`}`, 'info'); return; }
      if (action === 'config') { ctx.ui.notify(JSON.stringify({ path: configPaths().config, ...config }), 'info'); return; }
      if (action === 'reset') {
        if (!ctx.hasUI || !await ctx.ui.confirm(msg('清除 Goal 状态？'), msg('保留历史、Todos、Job 和项目文件；自动续跑停止。'))) return;
        hooks.pauseAgents(); commit(emptyGoalState(), ctx); config = await loadConfig(msg); error = undefined; return;
      }
      let params: GoalParams | undefined;
      if (action === 'new') params = { action: 'create', title: parts.join(' ') };
      else if (action === 'edit') params = { action: 'update', id: id(parts[0]), title: parts.slice(1).join(' ') };
      else if (['enable', 'disable', 'complete', 'delete', 'get'].includes(action ?? '')) {
        if (parts.length > 1) throw new Error(msg('此命令只接受一个编号'));
        params = { action: action as GoalParams['action'], id: id(parts[0]) };
      }
      if (params) { ctx.ui.notify(mutate(params, ctx, true).text, 'info'); return; }
      pi.sendUserMessage(msg`请管理当前 Goal：${args}`, ctx.isIdle() ? undefined : { deliverAs: 'followUp' });
    } catch (cause) { ctx.ui.notify(String(cause), 'error'); }
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
    pause: (reason: string, ctx: ExtensionContext) => pause(reason, ctx),
    snapshot: () => structuredClone(state),
  };
}
