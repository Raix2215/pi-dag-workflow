import { existsSync } from "node:fs";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { applyTodo, emptyState, restoreState, STATE_TYPE, type TodoParams, type WorkflowState } from "../todos/state.ts";
import { NORMAL_GUIDANCE, PLAN_GUIDANCE } from "../plan/policy.ts";
import { renderDag, renderTasks } from "../ui/render.ts";
import { registerAgents } from "../agents/index.ts";
import { registerGoal } from "../goal/index.ts";
import { detailView } from "../ui/detail.ts";
import type { Modules } from '../shared/config.ts';
import { registerTodos } from '../todos/index.ts';
import { registerPlan } from '../plan/index.ts';

const WIDGET = "pi-dag-workflow.todos";
export function registerWorkflow(pi: ExtensionAPI, modules: Modules): void {
  let state = emptyState();
  let restoreError: string | undefined;
  let warnedEphemeral = false;
  let detailOpen = false;
  let refreshDetail: (() => void) | undefined;
  let agents: ReturnType<typeof registerAgents> | undefined;
  const jobs = () => agents?.summaries() ?? [];
  const activeState = () => modules.todos ? state : { ...state, tasks: [] };
  let goals: ReturnType<typeof registerGoal> | undefined;

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
      const rendered = !state.visible && state.plan ? renderTasks(displayedState, width, { maxRows: 0, theme: ctx.ui.theme, jobs: snapshotJobs, goalTitle }) : state.view === "dag" ? renderDag(displayedState, width, ctx.ui.theme, goalTitle, snapshotJobs, { maxLines: 11 }) : renderTasks(displayedState, width, { theme: ctx.ui.theme, jobs: snapshotJobs, goalTitle });
      if (restoreError) rendered.push(truncateToWidth(`恢复失败：${restoreError}；工作流修改已禁用`, width));
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

  function commit(next: WorkflowState, ctx: ExtensionContext): void {
    if (next === state) return;
    // Persist first: a failure leaves the in-memory canonical state unchanged.
    pi.appendEntry(STATE_TYPE, next);
    state = next;
    paint(ctx);
    warnEphemeral(ctx);
  }

  function warnEphemeral(ctx: ExtensionContext): void {
    const sessionFile = ctx.sessionManager.getSessionFile();
    if (!warnedEphemeral && (!sessionFile || !existsSync(sessionFile))) {
      warnedEphemeral = true;
      ctx.ui.notify(sessionFile ? "Pi 尚未创建会话文件：发送一条消息后，当前工作流状态才会随会话保存。" : "当前为临时会话，退出后工作流状态不保存。", "warning");
    }
  }

  function restore(ctx: ExtensionContext): void {
    warnedEphemeral = false;
    try {
      state = modules.todos || modules.plan ? restoreState(ctx.sessionManager.getBranch()) : emptyState();
      if (!modules.plan) state = { ...state, plan: false }; // Disabled Plan cannot strand a read-only session.
      restoreError = undefined;
    } catch (error) {
      state = { ...emptyState(), plan: true };
      restoreError = error instanceof Error ? error.message : String(error);
      ctx.ui.notify(`工作流状态恢复失败：${restoreError}。保留原记录，修改已禁用；/todos clear 可明确重置。`, "error");
    }
    paint(ctx);
  }

  function mutate(params: TodoParams, ctx: ExtensionContext) {
    if (restoreError && params.action !== "list" && params.action !== "get") throw new Error(`状态恢复失败，不能修改：${restoreError}`);
    agents?.assertTodoMutation(params);
    const result = applyTodo(state, params);
    commit(result.state, ctx);
    agents?.afterTodoMutation(params);
    return result;
  }

  pi.on("session_start", (_event, ctx) => restore(ctx));
  pi.on("session_tree", (_event, ctx) => restore(ctx));
  pi.on("session_shutdown", (_event, ctx) => {
    state = emptyState();
    restoreError = undefined;
    if (modules.ui) ctx.ui.setWidget(WIDGET, undefined);
  });
  pi.on("before_agent_start", (event) => {
    if (modules.todos || modules.plan) event.systemPromptOptions.sections["dag_workflow_mode"] = state.plan ? (modules.todos ? PLAN_GUIDANCE : 'Plan mode: only read, search and ask; no implementation or dispatch. Only the user can exit /plan off.') : (modules.todos ? NORMAL_GUIDANCE : 'Normal mode.');
  });
  async function show(ctx: ExtensionContext, view: "list" | "dag"): Promise<void> {
    if (!modules.ui || ctx.mode !== "tui") {
      ctx.ui.notify((view === "dag" ? renderDag(state, 80, undefined, goals?.title(), jobs()) : renderTasks(state, 80, { maxRows: Infinity, jobs: jobs(), ...(goals?.title() ? { goalTitle: goals.title() } : {}) })).join("\n") || "暂无任务", "info");
      return;
    }
    detailOpen = true;
    ctx.ui.setWidget(WIDGET, undefined); // The detail view replaces, rather than duplicates, the widget.
    try {
      await ctx.ui.custom<void>((tui, theme, _keys, done) => {
        const panel = detailView((width) => view === "dag" ? renderDag(state, width, theme, goals?.title(), jobs()) : renderTasks(state, width, { maxRows: Infinity, theme, jobs: jobs(), goalTitle: goals?.title() }), () => tui.terminal.rows, () => tui.requestRender(), done, theme);
        refreshDetail = () => { panel.invalidate(); tui.requestRender(); };
        return panel;
      });
    } finally { detailOpen = false; refreshDetail = undefined; paint(ctx); }
  }

  if (modules.todos) registerTodos(pi, { state: () => state, mutate, commit, show, protected: () => !!restoreError,
    reset: (ctx) => { restoreError = undefined; commit(emptyState(), ctx); },
  });
  if (modules.plan) registerPlan(pi, { state: () => state, commit, protected: () => !!restoreError,
    assertCanEnter: () => agents?.assertPlanEntry(), onEnter: (ctx) => goals?.pause('进入 Plan', ctx),
  });
  if (modules.agents) agents = registerAgents(pi, { state: activeState, mutate, paint, protected: () => !!restoreError, ui: modules.ui,
    canWake: () => goals?.canWake() ?? !modules.goal,
    reserveWake: (ctx) => goals?.reserveWake(ctx) ?? !modules.goal,
    pauseAuto: (ctx) => goals?.pause("用户暂停自动工作", ctx),
    resumeAuto: () => goals?.resumeAgentReports() ?? !modules.goal,
  });
  if (modules.goal) goals = registerGoal(pi, { state: activeState, jobs, paint, protected: () => !!restoreError,
    pauseAgents: () => agents?.pauseAutomatic(), resumeAgents: () => agents?.resumeAutomatic(), onSaved: warnEphemeral,
  });
}
