import { existsSync } from "node:fs";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { applyTodo, clearTodoRecords, emptyState, newlyReady, restoreState, validateTodoFields, STATE_TYPE, type TodoFilter, type TodoParams, type WorkflowState } from "../todos/state.ts";
import { PresetStore, type Preset } from "../todos/presets.ts";
import { NORMAL_GUIDANCE, PLAN_GUIDANCE } from "../plan/policy.ts";
import { clean, notify, renderDag, renderTasks } from "../ui/render.ts";
import type { registerAgents } from "../agents/register.ts";
import type { registerGoal } from "../goal/register.ts";
import { detailView } from "../ui/detail.ts";
import { noFeatures, type Feature } from './features.ts';
import type { registerCheckpoints } from '../todos/checkpoints.ts';
import { loadConfig, loadLocale, configPaths, type WorkflowConfig } from '../shared/config.ts';
import { createTranslator } from '../shared/i18n.ts';
import { latestBoundJobs, taskFilterStatus } from '../ui/filter.ts';

const WIDGET = "pi-dag-workflow.todos";
export function createWorkflow(pi: ExtensionAPI) {
  const msg = createTranslator(loadLocale());
  const modules = noFeatures();
  const attached = new Set<Feature>();
  const started = new WeakSet<object>();
  const restored = new WeakSet<object>();
  const stopped = new WeakSet<object>();
  let dispose = () => {};
  let state = emptyState();
  let restoreError: string | undefined;
  let warnedEphemeral = false;
  let restoredState: WorkflowState | undefined;
  let restoreEpoch = 0;
  let configPromise: Promise<WorkflowConfig> | undefined;
  const readConfig = () => configPromise ??= loadConfig(msg);
  let branchCache: { manager: ExtensionContext['sessionManager']; leaf: string | null; entries: ReturnType<ExtensionContext['sessionManager']['getBranch']> } | undefined;
  const readBranch = (ctx: ExtensionContext) => {
    const manager = ctx.sessionManager;
    const leaf = typeof manager.getLeafId === 'function' ? manager.getLeafId() : undefined;
    if (leaf !== undefined && branchCache?.manager === manager && branchCache.leaf === leaf) return branchCache.entries;
    const entries = manager.getBranch();
    if (leaf !== undefined) branchCache = { manager, leaf, entries };
    return entries;
  };
  let detailOpen = false;
  let refreshDetail: (() => void) | undefined;
  const userPromptTitles = new Set<string>();
  let agents: ReturnType<typeof registerAgents> | undefined;
  // Task fragments come from one user-level file, reloaded on demand so edits apply without a restart.
  const presetStore = new PresetStore({ path: configPaths().preset });
  let presetList: Preset[] = [];
  async function refreshPresets(): Promise<void> { await presetStore.load(); presetList = presetStore.list(); }
  /** One line like Pi's skill list: names and short descriptions only, never the step bodies. */
  function presetSummary(): string {
    const shown = presetList.slice(0, 8).map((preset) => `${preset.name}${preset.description ? ` (${preset.description})` : ''}`);
    const more = presetList.length > shown.length ? `, +${presetList.length - shown.length} more (/todos presets)` : '';
    return `${shown.join(', ')}${more}`.slice(0, 400);
  }
  const jobs = () => agents?.summaries() ?? [];
  const noTasks: WorkflowState['tasks'] = [];
  const activeState = () => modules.todos ? state : { ...state, tasks: noTasks };
  let lastPaint: { tasks: WorkflowState['tasks']; state: string; jobs: string; ui: ExtensionContext['ui']; theme: ExtensionContext['ui']['theme'] } | undefined;
  let goals: ReturnType<typeof registerGoal> | undefined;
  let checkpoints: ReturnType<typeof registerCheckpoints> | undefined;

  function paint(ctx: ExtensionContext): void {
    if (!modules.ui) return;
    const snapshotJobs = jobs();
    const displayedState = activeState();
    const goalTitle = goals?.title();
    const stateKey = JSON.stringify([state.plan, state.visible, state.view, state.treeStyle, state.filter, goalTitle, restoreError, detailOpen, ctx.mode, ctx.hasUI]);
    const now = Date.now();
    const jobKey = JSON.stringify(snapshotJobs.map((job) => [job.id, job.todoId, job.profile, job.status, job.reportDelivery, job.taskReportStale, job.label, job.activity?.kind, job.activity?.tool, job.activity?.since, job.activity?.kind === 'tool' && job.activity.since !== undefined ? Math.floor((now - job.activity.since) / 1000) : undefined]));
    if (lastPaint?.tasks === displayedState.tasks && lastPaint.state === stateKey && lastPaint.jobs === jobKey && lastPaint.ui === ctx.ui && lastPaint.theme === ctx.ui.theme) return;
    lastPaint = { tasks: displayedState.tasks, state: stateKey, jobs: jobKey, ui: ctx.ui, theme: ctx.ui.theme };
    if (detailOpen) { refreshDetail?.(); return; }
    if (!state.visible && !state.plan || !displayedState.tasks.some((task) => task.status !== "deleted") && !state.plan && !restoreError && !goalTitle && !snapshotJobs.length) {
      ctx.ui.setWidget(WIDGET, undefined);
      return;
    }
    const lines = (width: number) => {
      const rendered = !state.visible && state.plan ? renderTasks(displayedState, width, { maxRows: 0, theme: ctx.ui.theme, jobs: snapshotJobs, goalTitle, msg }) : state.view === "dag" ? renderDag(displayedState, width, ctx.ui.theme, goalTitle, snapshotJobs, { maxLines: 11, msg }) : renderTasks(displayedState, width, { theme: ctx.ui.theme, jobs: snapshotJobs, goalTitle, msg });
      if (restoreError) rendered.push(truncateToWidth(clean(msg`恢复失败：${restoreError}；工作流修改已禁用`), width));
      return rendered;
    };
    if (ctx.mode === "tui") ctx.ui.setWidget(WIDGET, () => {
      let cachedWidth = -1;
      let cachedLines: string[] = [];
      return {
        render(width: number) {
          if (width !== cachedWidth) { cachedLines = lines(width); cachedWidth = width; }
          return cachedLines;
        },
        invalidate() { cachedWidth = -1; },
      };
    });
    else if (ctx.hasUI) ctx.ui.setWidget(WIDGET, lines(80));
  }

  function commit(next: WorkflowState, ctx: ExtensionContext, source: 'tool' | 'command' = 'command'): void {
    if (next === state) return;
    const changedTasks = next.tasks !== state.tasks;
    const changedMode = next.plan !== state.plan;
    let ids: number[] = [];
    if (source === 'command' && changedTasks) {
      const previous = new Map(state.tasks.map((task) => [task.id, task]));
      const nextIds = new Set(next.tasks.map((task) => task.id));
      ids = [...new Set([...next.tasks.filter((task) => previous.get(task.id) !== task).map((task) => task.id), ...state.tasks.filter((task) => !nextIds.has(task.id)).map((task) => task.id)])];
    }
    // Persist first: a failure leaves the in-memory canonical state unchanged.
    pi.appendEntry(STATE_TYPE, next);
    state = next;
    if (source === 'command' && (changedTasks || changedMode)) checkpoints?.changed(ids);
    paint(ctx);
    warnEphemeral(ctx);
  }

  function warnEphemeral(ctx: ExtensionContext): void {
    const sessionFile = ctx.sessionManager.getSessionFile();
    if (!warnedEphemeral && (!sessionFile || !existsSync(sessionFile))) {
      warnedEphemeral = true;
      ctx.ui.notify(msg(sessionFile ? 'Pi 尚未创建会话文件：发送一条消息后，当前工作流状态才会随会话保存。' : '当前为临时会话，退出后工作流状态不保存。'), 'warning');
    }
  }

  function restore(ctx: ExtensionContext): void {
    try {
      restoredState = modules.todos || modules.plan ? restoreState(readBranch(ctx), msg) : emptyState();
      state = !modules.plan && restoredState.plan ? { ...restoredState, plan: false } : restoredState;
      restoreError = undefined;
    } catch (error) {
      state = { ...emptyState(), plan: true };
      restoreError = error instanceof Error ? error.message : String(error);
      notify(ctx, msg`工作流状态恢复失败：${restoreError}。保留原记录，修改已禁用；/todos clear 可明确重置。`, 'error');
    }
    paint(ctx);
  }

  function mutate(params: TodoParams, ctx: ExtensionContext, source: 'tool' | 'command' = 'tool') {
    if (restoreError && params.action !== "list" && params.action !== "get") throw new Error(msg`状态恢复失败，不能修改：${restoreError}`);
    if (params.action === 'clear') {
      validateTodoFields(params, msg);
      const before = state;
      const scope = params.scope ?? 'all';
      const protectedIds = agents?.cleanupProtection(before.tasks) ?? new Set<number>();
      const latest = latestBoundJobs(jobs());
      const outcomes = new Map(before.tasks.filter((task) => task.status !== 'deleted').map((task) => [task.id, taskFilterStatus(task, latest.get(task.id))]));
      const result = clearTodoRecords(before, scope, protectedIds, outcomes, msg);
      commit(result.state, ctx, source);
      const removedJobs = agents?.cleanupRecords(scope, before.tasks, state.tasks) ?? 0;
      return { ...result, text: `${result.text}\n${msg`已清理 ${removedJobs} 个已结束子 Agent 记录；运行及待交付／核验记录保留`}` };
    }
    agents?.assertTodoMutation(params);
    const result = applyTodo(state, params, msg, presetStore);
    const ready = newlyReady(state, result.state);
    commit(result.state, ctx, source);
    agents?.afterTodoMutation(params);
    if (ready.length) {
      const hint = msg`前置已完成，可开始：${ready.slice(0, 5).map((task) => `#${task.id} ${truncateToWidth(clean(task.subject), 24)}`).join('、')}${ready.length > 5 ? msg` 等 ${ready.length} 项` : ''}`;
      result.text += `\n${hint}`;
    }
    return result;
  }

  // Personal extensions may load before project trust, then be filtered out.
  // Every included resource contributes lifecycle hooks; activate only entries
  // whose session_start actually runs, not every factory from the pre-trust pass.
  async function restorePresets(ctx: ExtensionContext): Promise<void> {
    if (!modules.todos) return;
    // One read per lifecycle, only when Todos actually participates after project filtering.
    const epoch = restoreEpoch;
    try { await refreshPresets(); if (epoch === restoreEpoch) paint(ctx); }
    catch (cause) { if (epoch === restoreEpoch) notify(ctx, msg`Todo 片段（preset）配置无效：${cause instanceof Error ? cause.message : String(cause)}`, 'error'); }
  }
  function registerLifecycle(owner: ExtensionAPI, feature: Feature): void {
    owner.on('session_start', async (event, ctx) => {
      if (!started.has(event)) {
        started.add(event); Object.assign(modules, noFeatures()); restoreEpoch++;
        restoredState = undefined; restoreError = undefined; warnedEphemeral = false; branchCache = undefined; configPromise = undefined; lastPaint = undefined;
      }
      modules[feature] = true;
      if (feature === 'todos' || feature === 'plan') {
        if (!restoredState && !restoreError) restore(ctx);
        else if (feature === 'plan' && restoredState && !restoreError) state = restoredState;
      }
      if (feature === 'todos') await restorePresets(ctx);
      paint(ctx);
    });
    owner.on('session_tree', async (event, ctx) => {
      if (restored.has(event)) return;
      restored.add(event); restoreEpoch++; branchCache = undefined; configPromise = undefined; warnedEphemeral = false; lastPaint = undefined;
      restore(ctx); await restorePresets(ctx);
    });
    owner.on('session_shutdown', (event, ctx) => {
      if (stopped.has(event)) return;
      stopped.add(event); dispose(); restoreEpoch++; branchCache = undefined; configPromise = undefined; restoredState = undefined; lastPaint = undefined;
      state = emptyState(); restoreError = undefined;
      if (modules.ui) ctx.ui.setWidget(WIDGET, undefined);
    });
    owner.on('before_agent_start', (event) => {
      if (modules.todos || modules.plan) {
        const base = state.plan ? (modules.todos ? PLAN_GUIDANCE : 'Plan mode: only read, search and ask; no implementation or dispatch. Only the user can exit /plan off.') : (modules.todos ? NORMAL_GUIDANCE : 'Normal mode.');
        event.systemPromptOptions.sections['dag_workflow_mode'] = modules.todos && presetList.length ? `${base} Presets (todo action=apply preset=NAME): ${presetSummary()}.` : base;
      }
    });
  }
  async function show(ctx: ExtensionContext, view: "list" | "dag", selectedFilter?: TodoFilter): Promise<void> {
    const filter = selectedFilter ?? state.filter ?? 'full';
    if (!modules.ui || ctx.mode !== "tui") {
      ctx.ui.notify((view === "dag" ? renderDag(state, 80, undefined, goals?.title(), jobs(), { msg, filter }) : renderTasks(state, 80, { maxRows: Infinity, jobs: jobs(), msg, filter, ...(goals?.title() ? { goalTitle: goals.title() } : {}) })).join('\n') || msg('暂无任务'), "info");
      return;
    }
    detailOpen = true;
    ctx.ui.setWidget(WIDGET, undefined); // The detail view replaces, rather than duplicates, the widget.
    try {
      await ctx.ui.custom<void>((tui, theme, _keys, done) => {
        const panel = detailView((width) => view === "dag" ? renderDag(state, width, theme, goals?.title(), jobs(), { msg, filter }) : renderTasks(state, width, { maxRows: Infinity, theme, jobs: jobs(), goalTitle: goals?.title(), msg, filter }), () => tui.terminal.rows, () => tui.requestRender(), done, theme, msg);
        refreshDetail = () => { panel.invalidate(); tui.requestRender(); };
        return panel;
      });
    } finally { detailOpen = false; refreshDetail = undefined; paint(ctx); }
  }

  return {
    onDispose(off: () => void) { dispose = off; },
    async attach(feature: Feature, owner: ExtensionAPI): Promise<void> {
      if (attached.has(feature)) throw new Error(msg`重复加载工作流模块：${feature}`);
      attached.add(feature);
      registerLifecycle(owner, feature);
      if (feature === 'todos') {
        const [{ registerTodos }, { registerCheckpoints }] = await Promise.all([import('../todos/register.ts'), import('../todos/checkpoints.ts')]);
        checkpoints = registerCheckpoints(owner, { state: activeState, jobs, protected: () => !!restoreError, branch: readBranch });
        registerTodos(owner, { msg, state: () => state, mutate, commit, show, protected: () => !!restoreError,
          presets: () => presetList, refreshPresets,
          userPrompt: async (title, run) => { userPromptTitles.add(title); try { return await run(); } finally { userPromptTitles.delete(title); } },
          reset: (ctx) => { restoreError = undefined; commit(emptyState(), ctx); },
        });
      }
      if (feature === 'plan') {
        const { registerPlan } = await import('../plan/register.ts');
        registerPlan(owner, { msg, state: () => state, commit, protected: () => !!restoreError, loadConfig: readConfig,
          assertCanEnter: () => agents?.assertPlanEntry(), onEnter: (ctx) => goals?.pause(msg('进入 Plan'), ctx),
        });
      }
      if (feature === 'agents') {
        const { registerAgents } = await import('../agents/register.ts');
        agents = registerAgents(owner, { msg, state: activeState, mutate, paint, protected: () => !!restoreError, ui: () => modules.ui, branch: readBranch,
        canWake: () => !modules.goal || (goals?.canWake() ?? false),
        reserveWake: (ctx) => !modules.goal || (goals?.reserveWake(ctx, true) ?? false),
        pauseAuto: (ctx) => { if (modules.goal) goals?.pause(msg('用户暂停自动工作'), ctx); },
        resumeAuto: () => !modules.goal || (goals?.resumeAgentReports() ?? false),
        beforeWake: (ctx) => goals ? goals.beforeWake(ctx) : checkpoints?.beforeWake(ctx),
        compacting: () => goals?.isCompacting() ?? false,
        });
      }
      if (feature === 'goal') {
        const { registerGoal } = await import('../goal/register.ts');
        goals = registerGoal(owner, { msg, state: activeState, jobs, paint, protected: () => !!restoreError, branch: readBranch, loadConfig: readConfig,
        pauseAgents: () => agents?.pauseAutomatic(), resumeAgents: () => agents?.resumeAutomatic(), onSaved: warnEphemeral,
        isUserPrompt: (title) => title !== undefined && userPromptTitles.has(title),
        beforeWake: (ctx) => checkpoints?.beforeWake(ctx),
        });
      }
    },
  };
}
