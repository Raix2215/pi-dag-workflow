import { existsSync } from "node:fs";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { applyTodo, emptyState, newlyReady, restoreState, STATE_TYPE, type TodoParams, type WorkflowState } from "../todos/state.ts";
import { PresetStore, type Preset } from "../todos/presets.ts";
import { NORMAL_GUIDANCE, PLAN_GUIDANCE } from "../plan/policy.ts";
import { clean, notify, renderDag, renderTasks } from "../ui/render.ts";
import { registerAgents } from "../agents/register.ts";
import { registerGoal } from "../goal/register.ts";
import { detailView } from "../ui/detail.ts";
import { noFeatures, type Feature } from './features.ts';
import { registerTodos } from '../todos/register.ts';
import { registerCheckpoints } from '../todos/checkpoints.ts';
import { registerPlan } from '../plan/register.ts';
import { loadLocale, configPaths } from '../shared/config.ts';
import { createTranslator } from '../shared/i18n.ts';

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
  let detailOpen = false;
  let refreshDetail: (() => void) | undefined;
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
  const activeState = () => modules.todos ? state : { ...state, tasks: [] };
  let goals: ReturnType<typeof registerGoal> | undefined;
  let checkpoints: ReturnType<typeof registerCheckpoints> | undefined;

  function paint(ctx: ExtensionContext): void {
    if (!modules.ui) return;
    if (detailOpen) { refreshDetail?.(); return; }
    const snapshotJobs = jobs();
    const displayedState = activeState();
    const goalTitle = goals?.title();
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
    warnedEphemeral = false;
    // A broken fragment file must not block the workflow: report it and keep the last good list.
    void refreshPresets().then(() => paint(ctx)).catch((error) => notify(ctx, msg`Todo 片段（preset）配置无效：${error instanceof Error ? error.message : String(error)}`, 'error'));
    try {
      state = modules.todos || modules.plan ? restoreState(ctx.sessionManager.getBranch(), msg) : emptyState();
      if (!modules.plan) state = { ...state, plan: false }; // Disabled Plan cannot strand a read-only session.
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
    agents?.assertTodoMutation(params);
    const result = applyTodo(state, params, msg, presetStore);
    const ready = newlyReady(state, result.state);
    commit(result.state, ctx, source);
    agents?.afterTodoMutation(params);
    if (ready.length) {
      const hint = msg`前置已完成，可开始：${ready.slice(0, 5).map((task) => `#${task.id} ${truncateToWidth(clean(task.subject), 24)}`).join('、')}${ready.length > 5 ? msg` 等 ${ready.length} 项` : ''}`;
      result.text += `\n${hint}`;
      notify(ctx, hint, 'info');
    }
    return result;
  }

  // Personal extensions may load before project trust, then be filtered out.
  // Every included resource contributes lifecycle hooks; activate only entries
  // whose session_start actually runs, not every factory from the pre-trust pass.
  function registerLifecycle(owner: ExtensionAPI, feature: Feature): void {
    owner.on('session_start', (event, ctx) => {
      if (!started.has(event)) { started.add(event); Object.assign(modules, noFeatures()); }
      modules[feature] = true;
      restore(ctx);
    });
    owner.on('session_tree', (event, ctx) => { if (!restored.has(event)) { restored.add(event); restore(ctx); } });
    owner.on('session_shutdown', (event, ctx) => {
      if (stopped.has(event)) return;
      stopped.add(event); dispose();
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
  async function show(ctx: ExtensionContext, view: "list" | "dag"): Promise<void> {
    if (!modules.ui || ctx.mode !== "tui") {
      ctx.ui.notify((view === "dag" ? renderDag(state, 80, undefined, goals?.title(), jobs(), { msg }) : renderTasks(state, 80, { maxRows: Infinity, jobs: jobs(), msg, ...(goals?.title() ? { goalTitle: goals.title() } : {}) })).join('\n') || msg('暂无任务'), "info");
      return;
    }
    detailOpen = true;
    ctx.ui.setWidget(WIDGET, undefined); // The detail view replaces, rather than duplicates, the widget.
    try {
      await ctx.ui.custom<void>((tui, theme, _keys, done) => {
        const panel = detailView((width) => view === "dag" ? renderDag(state, width, theme, goals?.title(), jobs(), { msg }) : renderTasks(state, width, { maxRows: Infinity, theme, jobs: jobs(), goalTitle: goals?.title(), msg }), () => tui.terminal.rows, () => tui.requestRender(), done, theme, msg);
        refreshDetail = () => { panel.invalidate(); tui.requestRender(); };
        return panel;
      });
    } finally { detailOpen = false; refreshDetail = undefined; paint(ctx); }
  }

  return {
    onDispose(off: () => void) { dispose = off; },
    attach(feature: Feature, owner: ExtensionAPI): void {
      if (attached.has(feature)) throw new Error(msg`重复加载工作流模块：${feature}`);
      attached.add(feature);
      registerLifecycle(owner, feature);
      if (feature === 'todos') {
        checkpoints = registerCheckpoints(owner, { state: activeState, jobs, protected: () => !!restoreError });
        registerTodos(owner, { msg, state: () => state, mutate, commit, show, protected: () => !!restoreError,
          presets: () => presetList, refreshPresets,
          reset: (ctx) => { restoreError = undefined; commit(emptyState(), ctx); },
        });
      }
      if (feature === 'plan') registerPlan(owner, { msg, state: () => state, commit, protected: () => !!restoreError,
        assertCanEnter: () => agents?.assertPlanEntry(), onEnter: (ctx) => goals?.pause(msg('进入 Plan'), ctx),
      });
      if (feature === 'agents') agents = registerAgents(owner, { msg, state: activeState, mutate, paint, protected: () => !!restoreError, ui: () => modules.ui,
        canWake: () => !modules.goal || (goals?.canWake() ?? false),
        reserveWake: (ctx) => !modules.goal || (goals?.reserveWake(ctx, true) ?? false),
        pauseAuto: (ctx) => { if (modules.goal) goals?.pause(msg('用户暂停自动工作'), ctx); },
        resumeAuto: () => !modules.goal || (goals?.resumeAgentReports() ?? false),
        beforeWake: (ctx) => checkpoints?.beforeWake(ctx),
        compacting: () => goals?.isCompacting() ?? false,
      });
      if (feature === 'goal') goals = registerGoal(owner, { msg, state: activeState, jobs, paint, protected: () => !!restoreError,
        pauseAgents: () => agents?.pauseAutomatic(), resumeAgents: () => agents?.resumeAutomatic(), onSaved: warnEphemeral,
        beforeWake: (ctx) => checkpoints?.beforeWake(ctx),
      });
    },
  };
}
