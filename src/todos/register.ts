import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { Text } from '@earendil-works/pi-tui';
import { statusLabel, TodoParamsSchema, type TodoParams, type WorkflowState } from './state.ts';
import type { Preset } from './presets.ts';
import { clean, notify } from '../ui/render.ts';
import { workflowNamespace, sessionMutation } from '../shared/tool-info.ts';
import { completeArguments, type CompletionSpec } from '../shared/completion.ts';
import { chinese, type Translator } from '../shared/i18n.ts';

interface Hooks { msg?: Translator; state(): WorkflowState; protected(): boolean; mutate(params: TodoParams, ctx: ExtensionContext): { state: WorkflowState; text: string }; commit(next: WorkflowState, ctx: ExtensionContext): void; reset(ctx: ExtensionContext): void; show(ctx: ExtensionContext, view: 'list' | 'dag'): Promise<void>; presets?(): Preset[]; refreshPresets?(): Promise<void> }
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
      { action: 'presets', description: msg('查看片段预设：presets') },
      { action: 'apply', description: msg('套用片段：apply 名称 [键=值 ...]') },
      { action: 'reset', description: msg('重开片段：reset 名称 [步骤键]') },
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
      if (['apply', 'reset'].includes(action)) return (hooks.presets?.() ?? []).map((preset) => ({ token: preset.name, label: preset.name, ...(preset.description ? { description: preset.description } : {}) }));
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
    description: "Manage the current task list: create/update/list/get/delete/clear, plus apply and reset for reusable task fragments (presets). Use blockedBy for prerequisites; set status via update. Check work before completing it; Plan only edits the list.",
    promptSnippet: "Use todo to plan and track multi-step work in one dependency-aware list",
    promptGuidelines: [
      "Use todo for work with three or more steps, when the user lists tasks, or right after new instructions; skip it for single trivial requests.",
      "Keep one list: create a task instead of keeping a second plan. Mark a task in_progress before starting it and completed as soon as its work is verified; at most one task is in_progress per work stream.",
      "Never complete a task whose work is unfinished, failing, or blocked; create a task for the blocker instead.",
      "Express dependencies with blockedBy (#4 blocked by #2 and #3). A task cannot start or complete before its predecessors are completed.",
    ],
    parameters: TodoParamsSchema,
    executionMode: "sequential",
    async execute(_id, params, _signal, _update, ctx) {
      try {
        if (params.action === 'apply' || params.action === 'reset') await hooks.refreshPresets?.();
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
        if (action === 'help') { ctx.ui.notify(msg('/todos · add 标题 [--after 1,2] · start/done/pending/delete #编号 · edit #编号 标题 · clear · paths/flat · show/hide · view list/dag · presets · apply 名称 [键=值] · reset 名称 [步骤键]；/dag 查看实线图'), 'info'); return; }
        if (action === 'presets') {
          await hooks.refreshPresets?.();
          const list = hooks.presets?.() ?? [];
          ctx.ui.notify(list.length ? list.map((preset) => `${preset.name}${preset.description ? ` — ${preset.description}` : ''}（${preset.steps.length} 步${preset.skill ? `，skill ${preset.skill}` : ''}）`).join('\n') : msg('未配置 Todo 片段：在 ~/.pi/agent/pi-dag-workflow/pi-dag-workflow-preset.json 里定义'), 'info');
          return;
        }
        if (action === 'apply' || action === 'reset') {
          await hooks.refreshPresets?.();
          const name = parts[0];
          if (!name) throw new Error(msg`用法：/todos ${action} 名称${action === 'apply' ? ' [键=值 ...]' : ' [步骤键]'}`);
          let params: TodoParams;
          if (action === 'apply') {
            const vars: Record<string, string> = Object.create(null);
            for (const pair of parts.slice(1)) {
              const at = pair.indexOf('=');
              if (at < 1) throw new Error(msg`变量需要 键=值：${pair}`);
              vars[pair.slice(0, at)] = pair.slice(at + 1);
            }
            params = { action: 'apply', preset: name, ...(Object.keys(vars).length ? { vars } : {}) };
          } else {
            if (parts.length > 2) throw new Error(msg`用法：/todos ${action} 名称${' [步骤键]'}`);
            params = { action: 'reset', preset: name, ...(parts[1] ? { step: parts[1] } : {}) };
          }
          notify(ctx, mutate(params, ctx).text, 'info');
          return;
        }
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
        if (params) { notify(ctx, mutate(params, ctx).text, "info"); return; }
        pi.sendUserMessage(msg`请管理当前 Todos：${trimmed}`, ctx.isIdle() ? undefined : { deliverAs: "followUp" });
      } catch (error) { notify(ctx, error instanceof Error ? error.message : String(error), "error"); }
    },
  });
  pi.registerCommand("dag", { description: msg('查看当前 Todos 的依赖图'), handler: async (_args, ctx) => show(ctx, "dag") });
}
