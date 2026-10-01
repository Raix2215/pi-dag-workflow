import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import type { WorkflowState } from '../todos/state.ts';
import { planViolation } from './policy.ts';
import { completeArguments, type CompletionSpec } from '../shared/completion.ts';
import { chinese, type Translator } from '../shared/i18n.ts';

interface Hooks { msg?: Translator; state(): WorkflowState; protected(): boolean; commit(next: WorkflowState, ctx: ExtensionContext): void; assertCanEnter(): void; onEnter(ctx: ExtensionContext): void }
/** Plan's policy is shared with the coordinator, not a second execution runtime. */
export function registerPlan(pi: ExtensionAPI, hooks: Hooks): void {
  const msg = hooks.msg ?? chinese;
  const { commit } = hooks;
  const completion: CompletionSpec = {
    actions: [
      { action: 'start', description: msg('进入只读规划') },
      { action: 'off', description: msg('退出规划，恢复实施') },
      { action: 'status', description: msg('查看当前模式') },
      { action: 'tools', description: msg('配置额外只读工具：tools 名称1,名称2 或 none') },
      { action: 'help', description: msg('查看命令帮助') },
    ],
  };
  pi.on('tool_call', (event) => { const reason = planViolation(hooks.state(), event.toolName, event.input, msg); if (reason) return { block: true, reason }; });
  pi.on('user_bash', () => { if (hooks.state().plan) return { result: { output: msg('Plan 只读：请用读取／搜索工具；执行 shell 需先 /plan off。'), exitCode: 1, cancelled: false, truncated: false } }; });
  pi.registerCommand("plan", {
    description: msg("切换只读规划；start/off/status/tools，或直接描述规划需求"),
    getArgumentCompletions: (prefix) => completeArguments(prefix, completion),
    handler: async (args, ctx) => {
      try {
        const trimmed = args.trim();
        if (trimmed === 'help') { ctx.ui.notify(msg('/plan start/off/status · tools 名称1,名称2（只读可信工具）；进入前需主会话空闲且子 Agent 已结束／取消。Plan 期间 Goal 保持暂停，恢复需明确 /goal enable。'), 'info'); return; }
        if (trimmed === "status") { ctx.ui.notify(hooks.state().plan ? msg("Plan（只读）：探索和编辑 Todos；实施／完成／委派在退出 Plan 后进行") : msg("Normal：可实施任务"), "info"); return; }
        if (hooks.protected()) throw new Error(msg("工作流状态损坏；先检查或明确 /todos clear 重置"));
        if (trimmed === "tools" || trimmed.startsWith("tools ")) {
          if (hooks.state().plan) throw new Error(msg("先 /plan off，再配置额外只读工具"));
          if (trimmed === "tools") { ctx.ui.notify(msg`额外只读工具：${hooks.state().planTools.join(",") || "无"}。/plan tools 名称1,名称2；none 清空。`, "info"); return; }
          const names = trimmed.slice(6).trim() === "none" ? [] : trimmed.slice(6).split(",").map((name) => name.trim());
          const known = new Set(pi.getAllTools().map((tool) => tool.name));
          if (names.some((name) => !known.has(name) || ["todo", "bash", "powershell", "write", "edit"].includes(name) || name.startsWith("subagent_") || name === "goal")) throw new Error(msg("只能明确允许已注册的额外只读工具；不能放行写入／委派工具"));
          commit({ ...hooks.state(), planTools: [...new Set(names)] }, ctx);
          ctx.ui.notify(msg("已保存额外只读工具；Plan 只拦截已注册的写入／Shell 工具，请只选择可信读取／搜索工具"), "info");
          return;
        }
        const off = trimmed === "off" || !trimmed && hooks.state().plan;
        if (!ctx.isIdle()) throw new Error(msg("主会话仍在运行；请先停止或等待，再切换 Plan"));
        if (!off) hooks.assertCanEnter();
        commit({ ...hooks.state(), plan: !off }, ctx);
        if (!off) hooks.onEnter(ctx);
        ctx.ui.notify(off ? msg("已退出 Plan；使用同一份 Todos 继续") : msg("已进入 Plan（只读）；可探索与编辑 Todos，实施／完成／委派待退出后继续"), "info");
        if (!off && trimmed && trimmed !== "start") pi.sendUserMessage(trimmed);
      } catch (error) { ctx.ui.notify(error instanceof Error ? error.message : String(error), "error"); }
    },
  });
}
