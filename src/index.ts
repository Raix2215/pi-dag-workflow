import { existsSync } from "node:fs";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import { applyTodo, emptyState, restoreState, STATE_TYPE, TodoParamsSchema, type TodoParams, type WorkflowState } from "./todos.ts";
import { NORMAL_GUIDANCE, PLAN_GUIDANCE, planViolation } from "./plan.ts";
import { clean, renderDag, renderTasks } from "./view.ts";
import { registerAgents } from "./agent-tools.ts";

const WIDGET = "pi-dag-workflow.todos";
const asId = (text?: string): number => {
  if (!text || !/^#?[1-9]\d*$/.test(text)) throw new Error("请给出任务编号，例如 #2");
  return Number(text.replace(/^#/, ""));
};

export default function piDagWorkflow(pi: ExtensionAPI): void {
  let state = emptyState();
  let restoreError: string | undefined;
  let warnedEphemeral = false;
  let agents: ReturnType<typeof registerAgents>;

  function paint(ctx: ExtensionContext): void {
    if (!state.visible && !state.plan || !state.tasks.some((task) => task.status !== "deleted") && !state.plan && !restoreError) {
      ctx.ui.setWidget(WIDGET, undefined);
      return;
    }
    const lines = (width: number) => {
      const rendered = !state.visible && state.plan ? renderTasks(state, width, { maxRows: 0, theme: ctx.ui.theme, jobs: agents?.summaries() }) : state.view === "dag" ? renderDag(state, width, ctx.ui.theme, undefined, agents?.summaries()) : renderTasks(state, width, { theme: ctx.ui.theme, jobs: agents?.summaries() });
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
    const sessionFile = ctx.sessionManager.getSessionFile();
    if (!warnedEphemeral && (!sessionFile || !existsSync(sessionFile))) {
      warnedEphemeral = true;
      ctx.ui.notify(sessionFile ? "Pi 尚未创建会话文件：发送一条消息后，当前 Todos／Plan 才会随会话保存。" : "当前为临时会话，退出后 Todos／Plan 不保存。", "warning");
    }
  }

  function restore(ctx: ExtensionContext): void {
    warnedEphemeral = false;
    try {
      state = restoreState(ctx.sessionManager.getBranch());
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
    ctx.ui.setWidget(WIDGET, undefined);
  });
  pi.on("before_agent_start", (event) => {
    event.systemPromptOptions.sections["dag_workflow_mode"] = state.plan ? PLAN_GUIDANCE : NORMAL_GUIDANCE;
  });
  pi.on("tool_call", (event) => {
    const reason = planViolation(state, event.toolName, event.input);
    if (reason) return { block: true, reason };
  });
  pi.on("user_bash", () => {
    if (state.plan) return { result: { output: "Plan 中不执行 shell；请用读取／搜索工具或先 /plan off。", exitCode: 1, cancelled: false, truncated: false } };
  });

  pi.registerTool({
    name: "todo", label: "Todos",
    description: "Manage the current task list: create/update/list/get/delete/clear. Use blockedBy for prerequisites; set status via update. Check work before completing it; Plan only edits the list.",
    promptSnippet: "Track optional work steps and dependencies in one visible list.",
    parameters: TodoParamsSchema,
    executionMode: "sequential",
    async execute(_id, params, _signal, _update, ctx) {
      try {
        const result = mutate(params, ctx);
        return { content: [{ type: "text", text: result.text }], details: { action: params.action, params, tasks: structuredClone(state.tasks), nextId: state.nextId } };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { isError: true, content: [{ type: "text", text: `错误：${message}` }], details: { action: params.action, error: message } };
      }
    },
    renderCall(args, theme) { return new Text(theme.fg("toolTitle", `󰄬 todo ${args.action}${args.id ? ` #${args.id}` : ""}${args.subject ? ` ${clean(args.subject)}` : ""}`), 0, 0); },
    renderResult(result, _options, theme) {
      const text = result.content.filter((item) => item.type === "text").map((item) => item.text).join("\n");
      return new Text(theme.fg(result.isError ? "error" : "text", text.split("\n").map(clean).join("\n")), 0, 0);
    },
  });

  async function show(ctx: ExtensionContext, view: "list" | "dag"): Promise<void> {
    if (ctx.mode !== "tui") {
      ctx.ui.notify((view === "dag" ? renderDag(state, 80, undefined, undefined, agents.summaries()) : renderTasks(state, 80, { maxRows: Infinity, jobs: agents.summaries() })).join("\n") || "暂无任务", "info");
      return;
    }
    ctx.ui.setWidget(WIDGET, undefined); // The detail view replaces, rather than duplicates, the widget.
    try {
      await ctx.ui.custom<void>((_tui, theme, _keys, done) => ({
        render(width) {
          const rows = view === "dag" ? renderDag(state, width, theme, undefined, agents.summaries()) : renderTasks(state, width, { maxRows: Infinity, theme, jobs: agents.summaries() });
          return [...rows, "", truncateToWidth(theme.fg("dim", "Esc 返回 · /todos paths|flat · /todos view list|dag"), width)];
        },
        invalidate() {},
        handleInput(data) { if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) done(); },
      }));
    } finally { paint(ctx); }
  }

  pi.registerCommand("todos", {
    description: "当前 Todos：查看、编辑与视图切换；也可直接描述需求",
    handler: async (args, ctx) => {
      try {
        const trimmed = args.trim();
        const [action, ...parts] = trimmed.split(/\s+/);
        if (!trimmed || action === "list") return await show(ctx, "list");
        if (action === "view") {
          if (!["list", "dag"].includes(parts[0] ?? "") || parts.length !== 1) throw new Error("用法：/todos view list|dag");
          commit({ ...state, visible: true, view: parts[0] as "list" | "dag" }, ctx);
          return;
        }
        if (action === "paths" || action === "flat") {
          if (parts.length) throw new Error("用法：/todos paths 或 /todos flat");
          commit({ ...state, visible: true, treeStyle: action }, ctx);
          return;
        }
        if (action === "show" || action === "hide") { commit({ ...state, visible: action === "show" }, ctx); return; }
        if (action === "clear") {
          if (!ctx.hasUI || !await ctx.ui.confirm("清空 Todos？", "这会清空当前清单，不修改项目文件；历史编号不复用。")) return;
          if (restoreError) { restoreError = undefined; commit(emptyState(), ctx); }
          else mutate({ action: "clear" }, ctx);
          ctx.ui.notify("已清空 Todos", "info");
          return;
        }
        let params: TodoParams | undefined;
        if (action === "add") {
          const body = trimmed.slice(3).trim();
          const match = /^(.*?)\s+--after\s+(#?\d+(?:,#?\d+)*)$/.exec(body);
          params = { action: "create", subject: match ? match[1]!.trim() : body, ...(match ? { blockedBy: match[2]!.split(",").map(asId) } : {}) };
        } else if (["start", "done", "pending", "delete"].includes(action ?? "")) {
          if (parts.length !== 1) throw new Error(`用法：/todos ${action} #编号`);
          params = action === "delete" ? { action: "delete", id: asId(parts[0]) } : { action: "update", id: asId(parts[0]), status: action === "start" ? "in_progress" : action === "done" ? "completed" : "pending" };
        } else if (action === "edit") params = { action: "update", id: asId(parts[0]), subject: parts.slice(1).join(" ") };
        if (params) { ctx.ui.notify(mutate(params, ctx).text, "info"); return; }
        pi.sendUserMessage(`请管理当前 Todos：${trimmed}`, ctx.isIdle() ? undefined : { deliverAs: "followUp" });
      } catch (error) { ctx.ui.notify(error instanceof Error ? error.message : String(error), "error"); }
    },
  });
  pi.registerCommand("dag", { description: "查看当前 Todos 的依赖图（不创建另一份图）", handler: async (_args, ctx) => show(ctx, "dag") });
  pi.registerCommand("plan", {
    description: "切换只读规划；start/off/status/tools，或直接描述规划需求",
    handler: async (args, ctx) => {
      try {
        const trimmed = args.trim();
        if (trimmed === "status") { ctx.ui.notify(state.plan ? "Plan（只读）：只探索和编辑 Todos，不实施／完成／委派" : "Normal：可实施任务", "info"); return; }
        if (restoreError) throw new Error("工作流状态损坏；先检查或明确 /todos clear 重置");
        if (trimmed === "tools" || trimmed.startsWith("tools ")) {
          if (state.plan) throw new Error("先 /plan off，再配置额外只读工具");
          if (trimmed === "tools") { ctx.ui.notify(`额外只读工具：${state.planTools.join(",") || "无"}。/plan tools 名称1,名称2；none 清空。`, "info"); return; }
          const names = trimmed.slice(6).trim() === "none" ? [] : trimmed.slice(6).split(",").map((name) => name.trim());
          const known = new Set(pi.getAllTools().map((tool) => tool.name));
          if (names.some((name) => !known.has(name) || ["todo", "bash", "powershell", "write", "edit"].includes(name) || name.startsWith("subagent_") || name === "goal")) throw new Error("只能明确允许已注册的额外只读工具；不能放行写入／委派工具");
          commit({ ...state, planTools: [...new Set(names)] }, ctx);
          ctx.ui.notify("已保存额外只读工具；这不是操作系统沙箱，请只选择可信读取／搜索工具", "info");
          return;
        }
        const off = trimmed === "off" || trimmed === "exit" || !trimmed && state.plan;
        if (!ctx.isIdle()) throw new Error("主会话仍在运行；请先停止或等待，再切换 Plan");
        if (!off) agents.assertPlanEntry();
        commit({ ...state, plan: !off }, ctx);
        ctx.ui.notify(off ? "已退出 Plan；使用同一份 Todos 继续" : "已进入 Plan（只读）；可探索与编辑 Todos，不实施／完成／委派", "info");
        if (!off && trimmed && trimmed !== "start") pi.sendUserMessage(trimmed);
      } catch (error) { ctx.ui.notify(error instanceof Error ? error.message : String(error), "error"); }
    },
  });
  agents = registerAgents(pi, { state: () => state, mutate, paint, protected: () => !!restoreError });
}
