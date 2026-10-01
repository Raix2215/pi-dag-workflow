import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { Text } from '@earendil-works/pi-tui';
import { activates, applyGoal, emptyGoalState, focusedGoal, GOAL_TYPE, GoalParamsSchema, pauseGoal, reserveGoalWake, restoreGoalState, stops, type GoalParams, type GoalState } from './state.ts';
import { configPaths, loadConfig, type WorkflowConfig } from '../shared/config.ts';
import { clean, type AgentView } from '../ui/render.ts';
import { deriveDag } from '../dag/graph.ts';
import type { WorkflowState } from '../todos/state.ts';

interface Hooks { state(): WorkflowState; jobs(): readonly AgentView[]; paint(ctx: ExtensionContext): void; protected(): boolean; pauseAgents(): void; resumeAgents(): void; onSaved?(ctx: ExtensionContext): void }
/** One shared budget for plugin continuations and child-report wakes. No goal dispatcher. */
export function registerGoal(pi: ExtensionAPI, hooks: Hooks) {
  let state = emptyGoalState();
  let config: WorkflowConfig = { goalMaxTurns: 20, goalNoProgressLimit: 3 };
  let error: string | undefined;
  let userAuthority = false;
  let automaticRound = false;
  let standaloneReports = true;
  let revision = 0;
  let baseline = '';
  let lastProgress = '';
  const workStamp = () => JSON.stringify([revision, hooks.state().tasks.filter((task) => task.status !== 'deleted').map((task) => [task.id, task.status])]);
  const paint = (ctx: ExtensionContext) => hooks.paint(ctx);
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
    ctx.ui.notify(`Goal 已暂停：${reason}；/goal resume 明确恢复`, 'warning');
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
  function continuation(ctx: ExtensionContext, nextStep: string) {
    if (!reserveWake(ctx)) return;
    const goal = focusedGoal(state)!;
    const consumed = { ...state, run: { ...state.run } };
    delete consumed.run.nextStep;
    commit(consumed, ctx); // Never replay a stale action indefinitely.
    return { type: 'custom_message' as const, customType: 'pi-dag-workflow.goal-continue', content: `Goal #${goal.id} ${state.run.used}/${goal.maxTurns}: ${clean(nextStep)}。${state.run.used === 1 && goal.description ? `要求：${clean(goal.description).slice(0, 1000)}；完整要求可 goal get。` : ''}核验结果；研究可 goal update progress/nextStep，需用户时 pause，达成时 complete。这是工作流续跑，不是用户新授权。`, display: true };
  }
  async function restore(ctx: ExtensionContext) {
    userAuthority = false; automaticRound = false; revision = 0; error = undefined;
    try {
      state = restoreGoalState(ctx.sessionManager.getBranch());
      state = pauseGoal(state, focusedGoal(state) ? '会话恢复' : state.run.reason ?? '');
      if (!focusedGoal(state) && !state.run.reason) delete state.run.reason;
      config = await loadConfig();
    } catch (cause) { error = String(cause); state = emptyGoalState(); ctx.ui.notify(`Goal／配置恢复失败：${error}；保留历史，/goal reset 明确清除 Goal，配置错误请修复后重载`, 'error'); }
    standaloneReports = !state.run.reason;
    baseline = workStamp(); lastProgress = state.run.progress ?? '';
    paint(ctx);
  }
  pi.on('session_start', (_event, ctx) => restore(ctx));
  pi.on('session_tree', (_event, ctx) => restore(ctx));
  pi.on('session_shutdown', () => { state = emptyGoalState(); userAuthority = false; });
  pi.on('before_agent_start', (event) => {
    delete event.systemPromptOptions.sections['dag_workflow_goal'];
    const goal = focusedGoal(state);
    if (goal && !hooks.state().plan) event.systemPromptOptions.sections['dag_workflow_goal'] = `Current Goal #${goal.id}: ${clean(goal.title)}${goal.description ? ` — ${clean(goal.description)}` : ''}. ${state.run.paused ? 'Auto-continuation is paused; do not resume without user instruction.' : 'Verify completion. For research without Todos report new progress and concrete nextStep with goal update; use pause when waiting for the user, complete when achieved.'}`;
  });
  pi.on('input', (event) => { if (event.source !== 'extension') { userAuthority = true; automaticRound = false; if (!focusedGoal(state) && !event.text.startsWith('/')) standaloneReports = true; } });
  pi.on('tool_execution_end', (event) => {
    if (event.isError) return;
    if (['write', 'edit'].includes(event.toolName) || event.toolName === 'subagent_spawn' && !(event.result as { isError?: boolean })?.isError) revision++;
  });
  pi.on('ui_prompt_start', (event, ctx) => { if (event.kind !== 'custom') pause('等待用户答复', ctx); });
  // Pi skips before_settle when an operation is aborted; observe the run/turn too.
  pi.on('turn_end', (event, ctx) => { if (event.outcome !== 'completed') pause(event.outcome === 'aborted' ? '用户中断' : '模型出错', ctx); });
  pi.on('agent_end', (event, ctx) => {
    const last = event.messages.findLast((message) => message.role === 'assistant');
    if (ctx.signal?.aborted || last?.role === 'assistant' && last.stopReason === 'aborted') pause('用户中断', ctx);
    else if (last?.role === 'assistant' && last.stopReason === 'error') pause('模型出错', ctx);
  });
  pi.on('agent_before_settle', (event, ctx) => {
    if (event.outcome !== 'completed') { pause(event.outcome === 'aborted' ? '用户中断' : '模型出错', ctx); return; }
    if (!focusedGoal(state) || state.run.paused || error || hooks.protected() || hooks.state().plan) return;
    if (event.continue) return; // An Agent report already requested and paid for this next request.
    const goal = focusedGoal(state)!;
    if (state.run.used >= goal.maxTurns) { pause(`自动续跑达到 ${goal.maxTurns} 轮上限`, ctx); return; }
    const progressed = workStamp() !== baseline || Boolean(state.run.progress?.trim() && state.run.progress !== lastProgress);
    // Only completed automatic rounds count as stalled; user inspections do not refill/consume the budget.
    const stalled = progressed ? 0 : automaticRound ? state.run.stalled + 1 : state.run.stalled;
    commit({ ...state, run: { ...state.run, stalled } }, ctx);
    baseline = workStamp(); lastProgress = state.run.progress ?? '';
    if (stalled >= config.goalNoProgressLimit) { pause(`连续 ${stalled} 轮无新进展`, ctx); return; }
    const jobs = hooks.jobs().filter((job) => ['starting', 'running', 'waiting'].includes(job.status));
    const assigned = new Set(jobs.map((job) => job.todoId));
    const tasks = hooks.state().tasks;
    const ready = new Set(deriveDag(tasks).ready);
    const task = tasks.find((task) => !assigned.has(task.id) && (ready.has(task.id) || task.status === 'in_progress'));
    // A checkpoint nextStep can name independent main work even while children run.
    if (state.run.nextStep === '') { pause('等待用户答复', ctx); return; }
    const initial = state.run.used === 0 && state.run.nextStep === `推进目标：${goal.title}`;
    const nextStep = initial && jobs.length ? (task ? `推进并核验 Todo #${task.id}：${task.subject}` : undefined) : state.run.nextStep?.trim() || (task ? `推进并核验 Todo #${task.id}：${task.subject}` : undefined);
    if (!nextStep) {
      if (initial) { const waiting = { ...state, run: { ...state.run } }; delete waiting.run.nextStep; commit(waiting, ctx); }
      if (jobs.length) return; // Wait for real child reports, no polling model calls.
      pause('没有具体下一步，等待用户', ctx); return;
    }
    const entry = continuation(ctx, nextStep);
    if (entry) return { entries: [entry], continue: true };
  });
  function mutate(params: GoalParams, ctx: ExtensionContext, explicit = false) {
    if ((error || hooks.protected()) && !['list', 'get'].includes(params.action) && !stops(params.action)) throw new Error(error ?? '工作流状态受保护');
    if (hooks.state().plan && !['list', 'get'].includes(params.action) && !stops(params.action)) throw new Error('Plan 只查看／停用 Goal；先 /plan off');
    const current = focusedGoal(state);
    if (automaticRound && !userAuthority && params.action === 'update' && (params.title !== undefined || params.description !== undefined || params.maxTurns !== undefined)) throw new Error('自动续跑修改目标范围／上限前需用户确认；progress/nextStep 不受此限制');
    if (activates(params.action) && !explicit && !userAuthority && (state.run.paused || params.id !== undefined && params.id !== current?.id)) throw new Error('自动续跑不能自行重置预算／切换目标；请等待用户明确恢复');
    const result = applyGoal(state, params, config.goalMaxTurns);
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
        catch (cause) { pause(`启动失败：${String(cause)}`, ctx); }
      }
    }
    return result;
  }
  pi.registerTool({ name: 'goal', label: 'Goal', description: 'Manage goals create/update/list/get/delete; enable/focus/switch/resume one target, disable/pause or complete after verification. Update progress/nextStep for research; empty nextStep waits for the user. Shared auto budget defaults to 20.', parameters: GoalParamsSchema, executionMode: 'sequential',
    async execute(_id, params, _signal, _update, ctx) {
      try { const result = mutate(params, ctx); return { content: [{ type: 'text', text: result.text }], details: { goalState: structuredClone(state) } }; }
      catch (cause) { return { isError: true, content: [{ type: 'text', text: String(cause) }], details: { error: String(cause) } }; }
    },
    renderCall(args, theme) { return new Text(theme.fg('toolTitle', `󰓾 goal ${clean(args.action ?? '')}${args.id ? ` #${args.id}` : ''}`), 0, 0); },
    renderResult(result, _options, theme) { return new Text(theme.fg(result.isError ? 'error' : 'text', result.content.filter((item) => item.type === 'text').map((item) => item.text.split('\n').map(clean).join('\n')).join('\n')), 0, 0); },
  });
  pi.registerCommand('goal', { description: '目标 list/new/enable/resume/off/switch/edit/complete/delete/reset/config，或自然语言', handler: async (args, ctx) => {
    try {
      const [action, ...parts] = args.trim().split(/\s+/);
      if (action === 'help') { ctx.ui.notify('/goal list/status · new 标题 · enable/focus/switch #编号 · resume/off（当前焦点） · edit #编号 标题 · complete/delete #编号 · config · reset；创建不启动，查看不重置预算，暂停后需明确恢复。', 'info'); return; }
      const id = (value?: string) => { if (value === undefined && state.focusId !== undefined) return state.focusId; if (!value || !/^#?[1-9]\d*$/.test(value)) throw new Error('请给出目标编号'); return Number(value.replace(/^#/, '')); };
      if (!args.trim() || action === 'list' || action === 'status') { ctx.ui.notify(`${applyGoal(state, { action: 'list' }).text}\n续跑 ${state.run.used}/${focusedGoal(state)?.maxTurns ?? '-'} · ${state.run.paused ? state.run.reason || '未启用' : '运行'}${error ? `\n错误：${error}` : ''}`, 'info'); return; }
      if (action === 'config') { ctx.ui.notify(JSON.stringify({ path: configPaths().config, ...config }), 'info'); return; }
      if (action === 'reset') {
        if (!ctx.hasUI || !await ctx.ui.confirm('清除 Goal 状态？', '保留历史、Todos、Job 和项目文件；自动续跑停止。')) return;
        hooks.pauseAgents(); commit(emptyGoalState(), ctx); config = await loadConfig(); error = undefined; return;
      }
      let params: GoalParams | undefined;
      if (action === 'new' || action === 'create') params = { action: 'create', title: parts.join(' ') };
      else if (action === 'edit') params = { action: 'update', id: id(parts[0]), title: parts.slice(1).join(' ') };
      else {
        const mapped = action === 'off' ? 'disable' : action === 'on' ? 'enable' : action === 'done' ? 'complete' : action === 'del' ? 'delete' : action;
        if (['enable', 'resume', 'focus', 'switch', 'disable', 'pause', 'complete', 'delete', 'get'].includes(mapped ?? '')) { if (parts.length > 1) throw new Error('此命令只接受一个编号'); params = { action: mapped as GoalParams['action'], id: id(parts[0]) }; }
      }
      if (params) { ctx.ui.notify(mutate(params, ctx, true).text, 'info'); return; }
      pi.sendUserMessage(`请管理当前 Goal：${args}`, ctx.isIdle() ? undefined : { deliverAs: 'followUp' });
    } catch (cause) { ctx.ui.notify(String(cause), 'error'); }
  } });
  return {
    title: () => { const goal = focusedGoal(state); return goal ? `#${goal.id} ${goal.title}${state.run.paused ? '（暂停）' : ''}` : undefined; },
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
