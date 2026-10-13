import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { truncateToWidth } from '@earendil-works/pi-tui';
import type { TodoFilter, TodoParams, WorkflowState } from '../todos/state.ts';
import type { PresetStore, Preset } from '../todos/presets.ts';
import type { registerAgents } from '../agents/register.ts';
import type { registerGoal } from '../goal/register.ts';
import type { registerRetry } from '../retry/register.ts';
import type { registerCheckpoints } from '../todos/checkpoints.ts';
import { PLAN_TYPE, emptyPlanState, restorePlanState } from '../plan/state.ts';
import { emptyViewPreferences, restoreViewPreferences, VIEW_TYPE } from '../ui/preferences.ts';
import { LEGACY_WORKFLOW_TYPE as STATE_TYPE } from '../shared/state-types.ts';
import { passiveMessage } from '../shared/passive-message.ts';
import { clean, notify, renderDag, renderTasks, renderWidget, widgetHeightBudget } from '../ui/render.ts';
import { bindMenuDisplay, menuDisplayOpen, readView } from '../ui/menu.ts';
import { noFeatures, type Feature } from './features.ts';
import { loadConfig, loadLocale, configPaths, type WorkflowConfig } from '../shared/config.ts';
import { createTranslator } from '../shared/i18n.ts';
import { latestBoundJobs, taskFilterStatus } from '../ui/filter.ts';

const WIDGET = 'pi-dag-workflow.todos';
/** A runtime-owned rendezvous, not a store for every feature's persisted state. */
export function createWorkflow(initialApi: ExtensionAPI) {
  const msg = createTranslator(loadLocale());
  const modules = noFeatures(), attached = new Set<Feature>();
  const owners = new Map<Feature, ExtensionAPI>();
  const started = new WeakSet<object>(), restored = new WeakSet<object>(), stopped = new WeakSet<object>();
  let dispose = () => {};
  const emptyState = (): WorkflowState => ({ version: 1, tasks: [], nextId: 1, plan: false, planTools: [], visible: true, view: 'list', treeStyle: 'paths' });
  let tasks = emptyState(), plan = emptyPlanState(), preferences = emptyViewPreferences();
  let legacyPlanFields: { plan?: unknown; planTools?: unknown } = {};
  let todoError: string | undefined, planError: string | undefined;
  let todoApi: typeof import('../todos/state.ts') | undefined, presets: PresetStore | undefined;
  let presetList: Preset[] = [];
  let generation = 0, warnedEphemeral = false;
  let branchCache: { manager: ExtensionContext['sessionManager']; leaf: string | null; entries: ReturnType<ExtensionContext['sessionManager']['getBranch']> } | undefined;
  const readBranch = (ctx: ExtensionContext) => {
    const manager = ctx.sessionManager, leaf = typeof manager.getLeafId === 'function' ? manager.getLeafId() : undefined;
    if (leaf !== undefined && branchCache?.manager === manager && branchCache.leaf === leaf) return branchCache.entries;
    const entries = manager.getBranch();
    if (leaf !== undefined) branchCache = { manager, leaf, entries };
    return entries;
  };
  // Only a surviving resource may carry an idle message after project filtering/reload.
  const api = () => [...owners.values()][0] ?? initialApi;
  const configs = new Map<string, Promise<WorkflowConfig>>();
  const readConfig = (domain: 'goal' | 'plan') => { const loaded = configs.get(domain) ?? loadConfig(msg, domain); configs.set(domain, loaded); return loaded; };
  let agents: ReturnType<typeof registerAgents> | undefined, goals: ReturnType<typeof registerGoal> | undefined, retry: ReturnType<typeof registerRetry> | undefined;
  let checkpoints: ReturnType<typeof registerCheckpoints> | undefined;
  const activeAgents = () => modules.agents ? agents : undefined;
  const activeGoal = () => modules.goal ? goals : undefined;
  const activeRetry = () => modules.retry ? retry : undefined;
  const jobs = () => activeAgents()?.summaries() ?? [];
  const noTasks: WorkflowState['tasks'] = [];
  // This read-only projection is the cross-feature contract; each feature restores its own record.
  const state = (): WorkflowState => ({ ...tasks, tasks: modules.todos && !todoError ? tasks.tasks : noTasks, plan: modules.plan && plan.enabled, planTools: modules.plan ? plan.tools : [] });
  const visible = (feature: Feature) => modules[feature] && (feature === 'todos' ? tasks.visible : preferences.visible[feature] !== false);
  const retryScope = () => { const goal = activeGoal()?.recoveryGoal(); return createHash('sha256').update(JSON.stringify([state().plan, goal ? [goal.id, goal.title, goal.description, goal.status, goal.modelPause, goal.autoresearch] : null])).digest('hex'); };
  let unbindMenu: (() => void) | undefined;
  const userPrompts = new Set<string>();
  let lastPaint: { tasks: WorkflowState['tasks']; key: string; ui: ExtensionContext['ui']; theme: ExtensionContext['ui']['theme'] } | undefined;
  let planNotice = false;
  const guidance = passiveMessage('pi-dag-workflow.guidance', () => planNotice && modules.plan ? state().plan
    ? `Plan: read/search/ask${modules.todos ? ' and edit Todo definitions' : ''} only. No implementation, shell, task start/complete or dispatch; only the user may /plan off.${modules.goal ? ' Goal is paused.' : ''}`
    : `Normal:${modules.todos ? ' continue the existing Todo list.' : ' implementation is available.'}${modules.goal ? ' Goal stays paused until explicitly enabled.' : ''}` : undefined, readBranch, () => { planNotice = false; });

  function paint(ctx: ExtensionContext) {
    if (!ctx.hasUI || !Object.values(modules).some(Boolean)) return;
    if (menuDisplayOpen(ctx)) { lastPaint = undefined; ctx.ui.setWidget(WIDGET, undefined); return; }
    const snapshotJobs = visible('agents') ? jobs() : [];
    const projected = { ...state(), tasks: visible('todos') ? state().tasks : noTasks, plan: visible('plan') && state().plan };
    const goalTitle = visible('goal') ? activeGoal()?.title() : undefined;
    const recovery = visible('retry') ? activeRetry()?.snapshot() : undefined;
    const retryLine = recovery?.enabled && recovery.phase !== 'armed' ? msg`重试 · ${recovery.phase} · ${recovery.attempts}/${recovery.count ?? msg('不限')}` : undefined;
    const now = Date.now();
    const jobKey = snapshotJobs.map((job) => [job.id, job.todoId, job.status, job.reportDelivery, job.taskReportStale, job.dismissed, job.label, job.activity?.kind, job.activity?.tool, job.activity?.since, job.activity?.since ? Math.floor((now - job.activity.since) / 1000) : undefined]);
    const key = JSON.stringify([modules, projected.plan, tasks.visible, preferences, tasks.view, tasks.treeStyle, tasks.filter, goalTitle, retryLine, todoError, planError, jobKey]);
    if (lastPaint?.tasks === projected.tasks && lastPaint.key === key && lastPaint.ui === ctx.ui && lastPaint.theme === ctx.ui.theme) return;
    lastPaint = { tasks: projected.tasks, key, ui: ctx.ui, theme: ctx.ui.theme };
    if (!projected.tasks.some((task) => task.status !== 'deleted') && !projected.plan && !todoError && !planError && !goalTitle && !snapshotJobs.length && !retryLine) { ctx.ui.setWidget(WIDGET, undefined); return; }
    const lines = (width: number, rows = 36) => {
      const error = todoError ?? planError, budget = widgetHeightBudget(rows);
      const result = renderWidget(projected, width, Math.max(0, budget - (error ? 1 : 0) - (retryLine ? 1 : 0)), { ...(!visible('todos') ? { maxRows: 0 } : {}), theme: ctx.ui.theme, jobs: snapshotJobs, goalTitle, msg });
      if (retryLine) result.push(truncateToWidth(clean(retryLine), width));
      if (error) result.push(truncateToWidth(clean(msg`恢复失败：${error}；受影响功能保持保护`), width));
      return result.slice(0, budget);
    };
    if (ctx.mode === 'tui') ctx.ui.setWidget(WIDGET, (tui) => {
      let width = -1, rows = -1, rendered: string[] = [];
      return { render(next: number) { const height = tui?.terminal?.rows ?? 36; if (width !== next || rows !== height) { rendered = lines(next, height); width = next; rows = height; } return rendered; }, invalidate() { width = -1; } };
    }); else ctx.ui.setWidget(WIDGET, lines(80));
  }
  function warnEphemeral(ctx: ExtensionContext) {
    const file = ctx.sessionManager.getSessionFile();
    if (!warnedEphemeral && (!file || !existsSync(file))) { warnedEphemeral = true; ctx.ui.notify(msg(file ? 'Pi 尚未创建会话文件：发送一条消息后，当前工作流状态才会随会话保存。' : '当前为临时会话，退出后工作流状态不保存。'), 'warning'); }
  }
  function commit(next: WorkflowState, ctx: ExtensionContext, source: 'tool' | 'command' = 'command') {
    if (todoError) throw new Error(msg`状态恢复失败，不能修改：${todoError}`);
    if (next.tasks === tasks.tasks && next.nextId === tasks.nextId && next.visible === tasks.visible && next.view === tasks.view && next.treeStyle === tasks.treeStyle && next.filter === tasks.filter) return;
    const changed = next.tasks !== tasks.tasks;
    const before = tasks;
    // Until a dedicated Plan entry exists, its migration source is this legacy record.
    // Todo writes must preserve those unrelated fields, including protected bad data.
    api().appendEntry(STATE_TYPE, { ...next, plan: legacyPlanFields.plan ?? false, planTools: legacyPlanFields.planTools ?? [] });
    tasks = { ...next, plan: false, planTools: [] };
    if (source === 'command' && changed) {
      const previous = new Map(before.tasks.map((task) => [task.id, task]));
      checkpoints?.changed([...new Set([...next.tasks.filter((task) => previous.get(task.id) !== task).map((task) => task.id), ...before.tasks.filter((task) => !next.tasks.some((item) => item.id === task.id)).map((task) => task.id)])]);
    }
    paint(ctx); warnEphemeral(ctx);
  }
  function commitPlan(next: WorkflowState, ctx: ExtensionContext) {
    if (planError) throw new Error(planError);
    if (next.plan === plan.enabled && next.planTools === plan.tools) return;
    const changedMode = next.plan !== plan.enabled;
    const value = { version: 1 as const, enabled: next.plan, tools: [...next.planTools] };
    api().appendEntry(PLAN_TYPE, value); plan = value;
    if (changedMode) { activeRetry()?.cancel(msg('模式已改变，旧计时已取消')); planNotice = true; guidance.mark(); checkpoints?.changed(); }
    paint(ctx); warnEphemeral(ctx);
  }
  function setSummary(feature: Feature, show: boolean, ctx: ExtensionContext) {
    if (feature === 'todos') { commit({ ...tasks, visible: show }, ctx); return; }
    if ((preferences.visible[feature] !== false) === show) return;
    const next = { ...preferences, visible: { ...preferences.visible, [feature]: show } };
    api().appendEntry(VIEW_TYPE, next); preferences = next; paint(ctx);
  }
  function restoreTodo(ctx: ExtensionContext) {
    legacyPlanFields = {};
    try {
      const saved = readBranch(ctx).findLast((item) => item.type === 'custom' && item.customType === STATE_TYPE);
      const legacy = saved?.type === 'custom' ? structuredClone(saved.data as WorkflowState) : todoApi!.restoreState(readBranch(ctx), msg);
      legacyPlanFields = { plan: legacy?.plan, planTools: legacy?.planTools };
      const value = { ...legacy, plan: false, planTools: [] };
      todoApi!.validateState(value, msg); tasks = value; todoError = undefined;
    } catch (cause) { tasks = emptyState(); todoError = String(cause); notify(ctx, msg`工作流状态恢复失败：${todoError}。保留原记录，修改已禁用；/todos clear 可明确重置。`, 'error'); }
  }
  function restorePlan(ctx: ExtensionContext) {
    try { plan = restorePlanState(readBranch(ctx), msg); planError = undefined; }
    catch (cause) { plan = { ...emptyPlanState(), enabled: true }; planError = String(cause); notify(ctx, msg('Plan 状态不可读，保持只读保护；/plan settings 可查看'), 'error'); }
    planNotice = plan.enabled || readBranch(ctx).some((entry) => entry.type === 'custom' && entry.customType === PLAN_TYPE);
    guidance.reset(planNotice);
  }
  async function refreshPresets() { if (presets) { await presets.load(); presetList = presets.list(); } }
  async function restorePresets(ctx: ExtensionContext) { const own = generation; try { await refreshPresets(); if (own === generation) paint(ctx); } catch (cause) { if (own === generation) notify(ctx, msg`Todo 片段（preset）配置无效：${String(cause)}`, 'error'); } }
  function mutate(params: TodoParams, ctx: ExtensionContext, source: 'tool' | 'command' = 'tool') {
    if (!modules.todos) throw new Error(msg('未启用 Todos，不能使用任务关联'));
    if (todoError && !['list', 'get', 'status', 'presets'].includes(params.action)) throw new Error(msg`状态恢复失败，不能修改：${todoError}`);
    if (params.action === 'clear') {
      todoApi!.validateTodoFields(params, msg);
      const before = state(), scope = params.scope ?? 'all';
      const latest = latestBoundJobs(jobs());
      const outcomes = new Map(before.tasks.filter((task) => task.status !== 'deleted').map((task) => [task.id, taskFilterStatus(task, latest.get(task.id))]));
      const result = todoApi!.clearTodoRecords(before, scope, activeAgents()?.cleanupProtection(before.tasks) ?? new Set(), outcomes, msg);
      commit(result.state, ctx, source);
      const removed = activeAgents()?.cleanupRecords(scope, before.tasks, tasks.tasks) ?? 0;
      return { ...result, text: `${result.text}\n${msg`已清理 ${removed} 个已结束子 Agent 记录；运行及待交付／核验记录保留`}` };
    }
    if (params.action !== 'batch') activeAgents()?.assertTodoMutation(params);
    const before = state(), result = todoApi!.applyTodo(before, params, msg, presets);
    // Read-only projections must not write back a protected state's empty task view.
    // No-op mutations still run job-ownership guards and explicit main takeover.
    if (['list', 'get', 'status', 'presets'].includes(params.action)) return result;
    if (result.operations) for (const operation of result.operations) activeAgents()?.assertTodoMutation(operation);
    const ready = todoApi!.newlyReady(before, result.state); commit(result.state, ctx, source);
    if (result.operations) {
      const updates = new Map<number, TodoParams>();
      for (const operation of result.operations) if (operation.action === 'update' && operation.id !== undefined) { const previous = updates.get(operation.id); updates.set(operation.id, { ...previous, ...operation, addBlockedBy: [...previous?.addBlockedBy ?? [], ...operation.addBlockedBy ?? []], removeBlockedBy: [...previous?.removeBlockedBy ?? [], ...operation.removeBlockedBy ?? []] }); }
      for (const operation of updates.values()) activeAgents()?.afterTodoMutation(operation, before);
    } else activeAgents()?.afterTodoMutation(params, before);
    if (ready.length) {
      const names = ready.slice(0, 5).map((task) => `#${task.id} ${truncateToWidth(clean(task.subject), 24)}`).join('、');
      result.text += `\n${msg`前置已完成，可开始：${names}${ready.length > 5 ? msg` 等 ${ready.length} 项` : ''}`}`;
    }
    return result;
  }
  async function show(ctx: ExtensionContext, view: 'list' | 'dag', filter?: TodoFilter) {
    const selection = filter ?? tasks.filter ?? 'full';
    const lines = (width: number) => view === 'dag' ? renderDag(state(), width, ctx.ui.theme, activeGoal()?.title(), jobs(), { msg, filter: selection }) : renderTasks(state(), width, { maxRows: Infinity, theme: ctx.ui.theme, jobs: jobs(), goalTitle: activeGoal()?.title(), msg, filter: selection });
    const own = generation;
    await readView(ctx, view === 'dag' ? 'DAG' : msg('任务清单'), lines(Math.max(16, (process.stdout.columns ?? 80) - 4) - 2).join('\n') || msg('暂无任务'), { msg, isCurrent: () => own === generation });
  }
  function lifecycle(owner: ExtensionAPI, feature: Feature) {
    owner.on('session_start', async (event, ctx) => {
      if (!started.has(event)) { started.add(event); Object.assign(modules, noFeatures()); owners.clear(); generation++; branchCache = undefined; configs.clear(); warnedEphemeral = false; lastPaint = undefined; tasks = emptyState(); plan = emptyPlanState(); todoError = undefined; planError = undefined; guidance.reset(); preferences = emptyViewPreferences(); }
      modules[feature] = true; owners.set(feature, owner);
      if (!unbindMenu) unbindMenu = bindMenuDisplay(ctx, () => { lastPaint = undefined; paint(ctx); });
      if (feature === 'todos') { restoreTodo(ctx); await restorePresets(ctx); }
      if (feature === 'plan') restorePlan(ctx);
      try { preferences = restoreViewPreferences(readBranch(ctx)); } catch { preferences = emptyViewPreferences(); }
      paint(ctx);
    });
    owner.on('session_tree', async (event, ctx) => {
      if (restored.has(event)) return; restored.add(event); generation++; branchCache = undefined; configs.clear(); lastPaint = undefined;
      if (modules.todos) restoreTodo(ctx); if (modules.plan) restorePlan(ctx);
      try { preferences = restoreViewPreferences(readBranch(ctx)); } catch { preferences = emptyViewPreferences(); }
      if (modules.todos) await restorePresets(ctx); paint(ctx);
    });
    owner.on('session_shutdown', (event, ctx) => {
      if (stopped.has(event)) return; stopped.add(event); generation++; unbindMenu?.(); unbindMenu = undefined; dispose(); owners.clear();
      tasks = emptyState(); plan = emptyPlanState(); preferences = emptyViewPreferences(); todoError = undefined; planError = undefined; guidance.reset(); lastPaint = undefined;
      if (ctx.hasUI) ctx.ui.setWidget(WIDGET, undefined);
    });
    if (feature !== 'plan') return;
    owner.on('before_agent_start', (event, ctx) => { const message = guidance.take(ctx, event); if (message) return { message }; });
    owner.on('turn_end', (event, ctx) => { const message = guidance.take(ctx, event); if (message) return { entries: [...event.entries, { type: 'custom_message' as const, ...message }] }; });
    owner.on('agent_before_settle', (event, ctx) => { const message = guidance.take(ctx, event); if (message) return { entries: [...event.entries, { type: 'custom_message' as const, ...message }] }; });
    owner.on('session_compact', (_event, ctx) => { if (modules.plan && (plan.enabled || readBranch(ctx).some((entry) => entry.type === 'custom' && entry.customType === PLAN_TYPE))) { planNotice = true; guidance.mark(true); } });
    owner.on('context', (event, ctx) => { const message = guidance.recover(event.messages, ctx, event); if (message) return { messages: [...event.messages, message] }; });
  }
  return {
    onDispose(off: () => void) { dispose = off; },
    async attach(feature: Feature | 'ui', owner: ExtensionAPI) {
      if (feature === 'ui') return;
      if (attached.has(feature)) throw new Error(msg`重复加载工作流模块：${feature}`);
      attached.add(feature); lifecycle(owner, feature);
      if (feature === 'todos') {
        const [toolModule, checkpointModule, values, presetModule] = await Promise.all([import('../todos/register.ts'), import('../todos/checkpoints.ts'), import('../todos/state.ts'), import('../todos/presets.ts')]);
        todoApi = values; presets = new presetModule.PresetStore({ path: configPaths().preset });
        checkpoints = checkpointModule.registerCheckpoints(owner, { state, jobs, protected: () => !!todoError, branch: readBranch });
        toolModule.registerTodos(owner, { msg, state, mutate, commit, show, jobs, protected: () => !!todoError,
          previewClear: (scope) => { const current = state(), latest = latestBoundJobs(jobs()); const outcomes = new Map(current.tasks.filter((task) => task.status !== 'deleted').map((task) => [task.id, taskFilterStatus(task, latest.get(task.id))])); const preview = todoApi!.clearTodoRecords(current, scope, activeAgents()?.cleanupProtection(current.tasks) ?? new Set(), outcomes, msg); return `${msg`预计清理 ${preview.removedIds.length} 项，保留 ${preview.keptIds.length} 项`}\n${msg('运行、待交付、待核验和依赖必需记录保留；不修改文件、Goal或对话历史。')}`; }, presets: () => presetList, refreshPresets,
          retryStatus: () => activeRetry()?.snapshot(), userPrompt: async (title, run) => { userPrompts.add(title); try { return await run(); } finally { userPrompts.delete(title); } },
          reset: (ctx) => { todoError = undefined; commit(emptyState(), ctx); } });
      }
      if (feature === 'plan') {
        const { registerPlan } = await import('../plan/register.ts');
        registerPlan(owner, { msg, state, commit: commitPlan, protected: () => !!planError, loadConfig: () => readConfig('plan'), assertCanEnter: () => activeAgents()?.assertPlanEntry(), onEnter: (ctx) => activeGoal()?.pause(msg('进入 Plan'), ctx), summary: () => visible('plan'), setSummary: (show, ctx) => setSummary('plan', show, ctx) });
      }
      if (feature === 'agents') {
        const { registerAgents } = await import('../agents/register.ts');
        agents = registerAgents(owner, { msg, state, mutate, paint,
          userPrompt: async (title, run) => { userPrompts.add(title); try { return await run(); } finally { userPrompts.delete(title); } }, protected: () => !!planError, ui: () => visible('agents'), branch: readBranch,
          summary: () => visible('agents'), setSummary: (show, ctx) => setSummary('agents', show, ctx),
          holdingRecovery: () => activeRetry()?.pending() ?? false,
          canWake: () => !activeRetry()?.pending() && (!modules.goal || (activeGoal()?.canWake() ?? false)),
          reserveWake: (ctx) => !activeRetry()?.pending() && (!modules.goal || (activeGoal()?.reserveWake(ctx, true) ?? false)),
          pauseAuto: (ctx) => activeGoal()?.pause(msg('用户暂停自动工作'), ctx), resumeAuto: () => !modules.goal || (activeGoal()?.resumeAgentReports() ?? false),
          beforeWake: (ctx) => { if (activeGoal()) activeGoal()!.beforeWake(ctx); else { checkpoints?.beforeWake(ctx); guidance.beforeWake(ctx, (message) => api().sendMessage(message, { triggerTurn: false })); } },
          compacting: () => activeGoal()?.isCompacting() ?? false });
      }
      if (feature === 'goal') {
        const { registerGoal } = await import('../goal/register.ts');
        goals = registerGoal(owner, { msg, state, jobs, paint, protected: () => !!planError, branch: readBranch, loadConfig: () => readConfig('goal'),
          pauseAgents: () => activeAgents()?.pauseAutomatic(), resumeAgents: () => activeAgents()?.resumeAutomatic(), onSaved: (ctx) => { activeRetry()?.refreshScope(ctx); warnEphemeral(ctx); },
          summary: () => visible('goal'), setSummary: (show, ctx) => setSummary('goal', show, ctx),
          retryEnabled: () => activeRetry()?.snapshot().enabled ?? false, cancelRecovery: () => activeRetry()?.cancel(), retryStatus: () => activeRetry()?.snapshot(),
          isUserPrompt: (title) => title !== undefined && (userPrompts.has(title) || activeRetry()?.isPrompt(title) === true),
          beforeWake: (ctx) => { checkpoints?.beforeWake(ctx); guidance.beforeWake(ctx, (message) => api().sendMessage(message, { triggerTurn: false })); } });
      }
      if (feature === 'retry') {
        const { registerRetry } = await import('../retry/register.ts');
        retry = registerRetry(owner, { msg, branch: readBranch, scope: retryScope, mode: () => state().plan ? 'plan' : activeGoal()?.recoveryGoal() ? 'goal' : 'normal', protected: () => !!planError,
          failed: (ctx, waiting) => activeGoal()?.failedRequest(ctx, waiting), prepare: (ctx) => activeGoal()?.prepareErrorRecovery(ctx) ?? true, undoPrepare: (ctx) => activeGoal()?.undoErrorRecovery(ctx),
          beforeRetry: (ctx) => { if (activeGoal()) activeGoal()!.beforeWake(ctx); else { checkpoints?.beforeWake(ctx); guidance.beforeWake(ctx, (message) => owner.sendMessage(message, { triggerTurn: false })); } },
          onChanged: paint, summary: () => visible('retry'), setSummary: (show, ctx) => setSummary('retry', show, ctx) });
        owner.on('session_start', (_event, ctx) => retry?.restore(ctx)); owner.on('session_tree', (_event, ctx) => retry?.restore(ctx));
      }
    },
  };
}
