import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { Text } from '@earendil-works/pi-tui';
import { CHECKPOINT_RULE } from './checkpoints.ts';
import { TODO_FILTERS, statusLabel, TodoParamsSchema, type ClearScope, type TodoFilter, type TodoParams, type WorkflowState } from './state.ts';
import type { Preset } from './presets.ts';
import { clean, notify } from '../ui/render.ts';
import { workflowNamespace, sessionMutation } from '../shared/tool-info.ts';
import { completeArguments, type CompletionSpec } from '../shared/completion.ts';
import { chinese, type Translator } from '../shared/i18n.ts';

interface Hooks { msg?: Translator; state(): WorkflowState; protected(): boolean; mutate(params: TodoParams, ctx: ExtensionContext, source?: 'tool' | 'command'): { state: WorkflowState; text: string }; commit(next: WorkflowState, ctx: ExtensionContext): void; reset(ctx: ExtensionContext): void; show(ctx: ExtensionContext, view: 'list' | 'dag', filter?: TodoFilter): Promise<void>; userPrompt?<T>(title: string, run: () => Promise<T>): Promise<T>; presets?(): Preset[]; refreshPresets?(): Promise<void> }
const asId = (text?: string, msg: Translator = chinese): number => {
  if (!text || !/^#?[1-9]\d*$/.test(text)) throw new Error(msg('请给出任务编号，例如 #2'));
  return Number(text.replace(/^#/, ''));
};
/** Register this resource's tools/commands using the runtime-shared state. */
export function registerTodos(pi: ExtensionAPI, hooks: Hooks): void {
  const { mutate, commit, show } = hooks;
  const msg = hooks.msg ?? chinese;
  let sessionEpoch = 0;
  let clearPrompt: { epoch: number } | undefined;
  const resetPrompt = () => { sessionEpoch++; clearPrompt = undefined; };
  pi.on('session_start', resetPrompt); pi.on('session_tree', resetPrompt); pi.on('session_shutdown', resetPrompt);
  const completion: CompletionSpec = {
    actions: [
      { action: 'add', description: msg('新建任务：add 标题 [--after 1,2]') },
      { action: 'start', description: msg('开始任务：start #编号') },
      { action: 'done', description: msg('完成任务：done #编号') },
      { action: 'pending', description: msg('回到待执行：pending #编号') },
      { action: 'failed', description: msg('标记失败：failed #编号') },
      { action: 'cancelled', description: msg('标记取消：cancelled #编号') },
      { action: 'delete', description: msg('删除任务：delete #编号') },
      { action: 'edit', description: msg('修改标题：edit #编号 新标题') },
      { action: 'list', description: msg('查看任务列表') },
      { action: 'view', description: msg('切换视图：view list/dag [full/pending/completed/failed/cancelled]') },
      { action: 'paths', description: msg('按路径树展示') },
      { action: 'flat', description: msg('按平铺展示') },
      { action: 'show', description: msg('显示任务面板') },
      { action: 'hide', description: msg('隐藏任务面板') },
      { action: 'clear', description: msg('清理记录：clear completed/closed/all，省略打开菜单') },
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
      clear: [
        { action: 'completed', description: msg('清理已完成记录') },
        { action: 'closed', description: msg('清理已完成／失败／取消记录') },
        { action: 'all', description: msg('清空全部可清理记录') },
      ],
    },
    freeText: ['add'],
    arguments: (tokens, trailing) => {
      if (tokens[0] !== 'view' || !['list', 'dag'].includes(tokens[1] ?? '') || tokens.length < 2 || tokens.length > 3 || tokens.length === 3 && trailing) return null;
      const typed = tokens.length === 3 ? tokens[2]! : '';
      if (tokens.length === 2 && !trailing) return null;
      return TODO_FILTERS.filter((name) => name.startsWith(typed)).map((name) => ({ token: `view ${tokens[1]} ${name}`, label: name }));
    },
    tokens: (action) => {
      if (action === 'list') return TODO_FILTERS.map((name) => ({ token: name, label: name }));
      if (['apply', 'reset'].includes(action)) return (hooks.presets?.() ?? []).map((preset) => ({ token: preset.name, label: preset.name, ...(preset.description ? { description: preset.description } : {}) }));
      if (!['start', 'done', 'pending', 'failed', 'cancelled', 'delete', 'edit'].includes(action)) return null;
      const tasks = hooks.state().tasks;
      const keepCompleted = action === 'delete' || action === 'edit';
      return tasks
        .filter((task) => task.status !== 'deleted' && (keepCompleted || task.status !== 'completed'))
        .map((task) => ({ token: `#${task.id}`, label: `#${task.id} ${task.subject}`, description: msg(statusLabel[task.status]) }));
    },
  };
  pi.registerTool({
    name: "todo", label: "Todos", namespace: workflowNamespace, annotations: sessionMutation,
    description: "Manage one task list: create/update/list/get/delete/clear, apply/reset task fragments. Use blockedBy for prerequisites. Create accepts pending or in_progress; update records completed after verification, failed or cancelled for closed attempts. Failed/cancelled never satisfy dependencies. clear scope completed or closed removes eligible Todo/child history; all clears eligible records. Active work, pending delivery/verification and required dependency anchors remain; files, Goal and session history are unchanged. Check work before completing it; Plan only edits the list.",
    promptSnippet: "Use todo to plan and track multi-step work in one dependency-aware list",
    promptGuidelines: [
      "Use todo for work with three or more steps, when the user lists tasks, or right after new instructions; skip it for single trivial requests.",
      "Keep one list: create a task instead of keeping a second plan. Mark a task in_progress before starting it and completed as soon as its work is verified; at most one task is in_progress per work stream.",
      "Never complete a task whose work is unfinished, failing, or blocked; create a task for the blocker instead.",
      "Express dependencies with blockedBy (#4 blocked by #2 and #3). A task cannot start or complete before its predecessors are completed.",
      CHECKPOINT_RULE,
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
        if (action === 'help') { ctx.ui.notify(msg('/todos · add 标题 [--after 1,2] · start/done/pending/failed/cancelled/delete #编号 · edit #编号 标题 · clear [completed/closed/all] · paths/flat · show/hide · view list/dag [full/pending/completed/failed/cancelled] · list [筛选] · presets · apply 名称 [键=值] · reset 名称 [步骤键]；/dag [筛选] 查看完整图'), 'info'); return; }
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
          notify(ctx, mutate(params, ctx, 'command').text, 'info');
          return;
        }
        const filter = (value?: string): TodoFilter => {
          if (value === undefined) return hooks.state().filter ?? 'full';
          if (!TODO_FILTERS.includes(value as TodoFilter)) throw new Error(msg('筛选只支持 full/pending/completed/failed/cancelled'));
          return value as TodoFilter;
        };
        if (!trimmed || action === "list") {
          if (parts.length > 1) throw new Error(msg('用法：/todos list [筛选]'));
          return await show(ctx, "list", filter(parts[0]));
        }
        if (action === "view") {
          if (!["list", "dag"].includes(parts[0] ?? "") || parts.length < 1 || parts.length > 2) throw new Error(msg('用法：/todos view list|dag [筛选]'));
          commit({ ...hooks.state(), visible: true, view: parts[0] as "list" | "dag", filter: filter(parts[1]) }, ctx);
          return;
        }
        if (action === "paths" || action === "flat") {
          if (parts.length) throw new Error(msg('用法：/todos paths 或 /todos flat'));
          commit({ ...hooks.state(), visible: true, treeStyle: action }, ctx);
          return;
        }
        if (action === "show" || action === "hide") { commit({ ...hooks.state(), visible: action === "show" }, ctx); return; }
        if (action === "clear") {
          if (clearPrompt) throw new Error(msg('清理菜单已打开'));
          const prompt = { epoch: sessionEpoch }; clearPrompt = prompt;
          try {
            if (parts.length > 1) throw new Error(msg('用法：/todos clear [completed/closed/all]'));
            let scope = parts[0] as ClearScope | undefined;
            if (scope !== undefined && !['completed', 'closed', 'all'].includes(scope)) throw new Error(msg('用法：/todos clear [completed/closed/all]'));
            if (!ctx.hasUI) throw new Error(msg('清理菜单需要交互界面；工具可明确指定 scope'));
            const userPrompt = <T>(title: string, run: () => Promise<T>) => hooks.userPrompt ? hooks.userPrompt(title, run) : run();
            if (scope === undefined) {
              const title = msg('清理 Todos 与子 Agent 记录');
              const options = [msg('清理已完成记录'), msg('清理已完成／失败／取消记录'), msg('清空全部可清理记录')];
              const selected = await userPrompt(title, () => ctx.ui.select(title, options));
              if (selected === undefined || prompt.epoch !== sessionEpoch) return;
              scope = (['completed', 'closed', 'all'] as const)[options.indexOf(selected)];
              if (scope === undefined) return;
            }
            const title = msg`确认清理 ${scope} 记录？`;
            if (!await userPrompt(title, () => ctx.ui.confirm(title, msg('保留运行／待交付／待核验和依赖必需记录，不修改文件、Goal或对话历史；编号不复用。')))) return;
            if (prompt.epoch !== sessionEpoch) return;
            if (hooks.protected()) { if (scope !== 'all') throw new Error(msg('状态受保护时只能明确 clear all 重置')); hooks.reset(ctx); }
            else notify(ctx, mutate({ action: "clear", scope }, ctx, 'command').text, 'info');
            return;
          } finally { if (clearPrompt === prompt) clearPrompt = undefined; }
        }
        let params: TodoParams | undefined;
        if (action === "add") {
          const body = trimmed.slice(3).trim();
          const match = /^(.*?)\s+--after\s+(#?\d+(?:,#?\d+)*)$/.exec(body);
          params = { action: "create", subject: match ? match[1]!.trim() : body, ...(match ? { blockedBy: match[2]!.split(',').map((value) => asId(value, msg)) } : {}) };
        } else if (["start", "done", "pending", "failed", "cancelled", "delete"].includes(action ?? "")) {
          if (parts.length !== 1) throw new Error(msg`用法：/todos ${action} #编号`);
          params = action === "delete" ? { action: "delete", id: asId(parts[0], msg) } : { action: "update", id: asId(parts[0], msg), status: action === "start" ? "in_progress" : action === "done" ? "completed" : action === 'failed' ? 'failed' : action === 'cancelled' ? 'cancelled' : "pending" };
        } else if (action === "edit") params = { action: "update", id: asId(parts[0], msg), subject: parts.slice(1).join(" ") };
        if (params) { notify(ctx, mutate(params, ctx, 'command').text, "info"); return; }
        pi.sendUserMessage(msg`请管理当前 Todos：${trimmed}`, ctx.isIdle() ? undefined : { deliverAs: "followUp" });
      } catch (error) { notify(ctx, error instanceof Error ? error.message : String(error), "error"); }
    },
  });
  pi.registerCommand("dag", { description: msg('查看当前 Todos 的依赖图'), getArgumentCompletions: (prefix) => {
    const value = prefix.trim();
    if (TODO_FILTERS.includes(value as TodoFilter)) return null;
    const matches = TODO_FILTERS.filter((name) => name.startsWith(value));
    return matches.length ? matches.map((name) => ({ value: name, label: name })) : null;
  }, handler: async (args, ctx) => {
    const parts = args.trim() ? args.trim().split(/\s+/) : [];
    if (parts.length > 1 || parts[0] !== undefined && !TODO_FILTERS.includes(parts[0] as TodoFilter)) { notify(ctx, msg('用法：/dag [full/pending/completed/failed/cancelled]'), 'error'); return; }
    await show(ctx, 'dag', parts[0] as TodoFilter | undefined);
  } });
}
