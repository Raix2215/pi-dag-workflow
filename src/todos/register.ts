import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { Text } from '@earendil-works/pi-tui';
import { statusLabel, TodoParamsSchema, type TodoParams, type WorkflowState } from './state.ts';
import { clean } from '../ui/render.ts';
import { workflowNamespace, sessionMutation } from '../shared/tool-info.ts';
import { completeArguments, type CompletionSpec } from '../shared/completion.ts';
import { chinese, type Translator } from '../shared/i18n.ts';

interface Hooks { msg?: Translator; state(): WorkflowState; protected(): boolean; mutate(params: TodoParams, ctx: ExtensionContext): { state: WorkflowState; text: string }; commit(next: WorkflowState, ctx: ExtensionContext): void; reset(ctx: ExtensionContext): void; show(ctx: ExtensionContext, view: 'list' | 'dag'): Promise<void> }
const asId = (text?: string, msg: Translator = chinese): number => {
  if (!text || !/^#?[1-9]\d*$/.test(text)) throw new Error(msg('请给出任务编号，例如 #2'));
  return Number(text.replace(/^#/, ''));
};
/** Register this resource's tools/commands using the runtime-shared state. */
export function registerTodos(pi: ExtensionAPI, hooks: Hooks): void {
  const { mutate, commit, show } = hooks;
  const msg = hooks.msg ?? chinese;
  const completion: CompletionSpec = {
    actions: [
      { action: 'add', description: msg('新建任务：add 标题 [--after 1,2]') },
      { action: 'start', description: msg('开始任务：start #编号') },
      { action: 'done', description: msg('完成任务：done #编号') },
      { action: 'pending', description: msg('回到待执行：pending #编号') },
      { action: 'delete', description: msg('删除任务：delete #编号') },
      { action: 'edit', description: msg('修改标题：edit #编号 新标题') },
      { action: 'list', description: msg('查看任务列表') },
      { action: 'view', description: msg('切换视图：view list/dag') },
      { action: 'paths', description: msg('按路径树展示') },
      { action: 'flat', description: msg('按平铺展示') },
      { action: 'show', description: msg('显示任务面板') },
      { action: 'hide', description: msg('隐藏任务面板') },
      { action: 'clear', description: msg('清空任务（编号不复用）') },
      { action: 'help', description: msg('查看命令帮助') },
    ],
    subActions: {
      view: [
        { action: 'list', description: msg('列表视图') },
        { action: 'dag', description: msg('依赖图视图') },
      ],
    },
    freeText: ['add'],
    tokens: (action) => {
      if (!['start', 'done', 'pending', 'delete', 'edit'].includes(action)) return null;
      const tasks = hooks.state().tasks;
      const keepCompleted = action === 'delete' || action === 'edit';
      return tasks
        .filter((task) => task.status !== 'deleted' && (keepCompleted || task.status !== 'completed'))
        .map((task) => ({ token: `#${task.id}`, label: `#${task.id} ${task.subject}`, description: msg(statusLabel[task.status]) }));
    },
  };
  pi.registerTool({
    name: "todo", label: "Todos", namespace: workflowNamespace, annotations: sessionMutation,
    description: "Manage the current task list: create/update/list/get/delete/clear. Use blockedBy for prerequisites; set status via update. Check work before completing it; Plan only edits the list.",
    promptSnippet: "Track optional work steps and dependencies in one visible list.",
    parameters: TodoParamsSchema,
    executionMode: "sequential",
    async execute(_id, params, _signal, _update, ctx) {
      try {
        const result = mutate(params, ctx);
        return { content: [{ type: "text", text: result.text }], details: { action: params.action, params, tasks: structuredClone(hooks.state().tasks), nextId: hooks.state().nextId } };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { isError: true, content: [{ type: "text", text: msg`错误：${message}` }], details: { action: params.action, error: message } };
      }
    },
    renderCall(args, theme) { return new Text(theme.fg("toolTitle", `󰄬 todo ${args.action}${args.id ? ` #${args.id}` : ""}${args.subject ? ` ${clean(args.subject)}` : ""}`), 0, 0); },
    renderResult(result, _options, theme) {
      const text = result.content.filter((item) => item.type === "text").map((item) => item.text).join("\n");
      return new Text(theme.fg(result.isError ? "error" : "text", text.split("\n").map(clean).join("\n")), 0, 0);
    },
  });

  pi.registerCommand("todos", {
    description: msg('当前 Todos：查看、编辑与视图切换；也可直接描述需求'),
    getArgumentCompletions: (prefix) => completeArguments(prefix, completion),
    handler: async (args, ctx) => {
      try {
        const trimmed = args.trim();
        const [action, ...parts] = trimmed.split(/\s+/);
        if (action === 'help') { ctx.ui.notify(msg('/todos · add 标题 [--after 1,2] · start/done/pending/delete #编号 · edit #编号 标题 · clear · paths/flat · show/hide · view list/dag；/dag 查看实线图'), 'info'); return; }
        if (!trimmed || action === "list") return await show(ctx, "list");
        if (action === "view") {
          if (!["list", "dag"].includes(parts[0] ?? "") || parts.length !== 1) throw new Error(msg('用法：/todos view list|dag'));
          commit({ ...hooks.state(), visible: true, view: parts[0] as "list" | "dag" }, ctx);
          return;
        }
        if (action === "paths" || action === "flat") {
          if (parts.length) throw new Error(msg('用法：/todos paths 或 /todos flat'));
          commit({ ...hooks.state(), visible: true, treeStyle: action }, ctx);
          return;
        }
        if (action === "show" || action === "hide") { commit({ ...hooks.state(), visible: action === "show" }, ctx); return; }
        if (action === "clear") {
          if (!ctx.hasUI || !await ctx.ui.confirm(msg('清空 Todos？'), msg('这会清空当前清单，不修改项目文件；历史编号不复用。'))) return;
          if (hooks.protected()) hooks.reset(ctx);
          else mutate({ action: "clear" }, ctx);
          ctx.ui.notify(msg('已清空 Todos'), 'info');
          return;
        }
        let params: TodoParams | undefined;
        if (action === "add") {
          const body = trimmed.slice(3).trim();
          const match = /^(.*?)\s+--after\s+(#?\d+(?:,#?\d+)*)$/.exec(body);
          params = { action: "create", subject: match ? match[1]!.trim() : body, ...(match ? { blockedBy: match[2]!.split(',').map((value) => asId(value, msg)) } : {}) };
        } else if (["start", "done", "pending", "delete"].includes(action ?? "")) {
          if (parts.length !== 1) throw new Error(msg`用法：/todos ${action} #编号`);
          params = action === "delete" ? { action: "delete", id: asId(parts[0], msg) } : { action: "update", id: asId(parts[0], msg), status: action === "start" ? "in_progress" : action === "done" ? "completed" : "pending" };
        } else if (action === "edit") params = { action: "update", id: asId(parts[0], msg), subject: parts.slice(1).join(" ") };
        if (params) { ctx.ui.notify(mutate(params, ctx).text, "info"); return; }
        pi.sendUserMessage(msg`请管理当前 Todos：${trimmed}`, ctx.isIdle() ? undefined : { deliverAs: "followUp" });
      } catch (error) { ctx.ui.notify(error instanceof Error ? error.message : String(error), "error"); }
    },
  });
  pi.registerCommand("dag", { description: msg('查看当前 Todos 的依赖图（不创建另一份图）'), handler: async (_args, ctx) => show(ctx, "dag") });
}
