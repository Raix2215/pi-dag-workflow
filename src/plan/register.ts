import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import type { WorkflowState } from '../todos/state.ts';
import { planViolation } from './policy.ts';
import { completeArguments, type CompletionSpec } from '../shared/completion.ts';
import { chinese, type Translator } from '../shared/i18n.ts';
import { choose, withMenuScope } from '../ui/menu.ts';
import { loadConfig, type WorkflowConfig } from '../shared/config.ts';

interface Hooks { summary?(): boolean; setSummary?(visible: boolean, ctx: ExtensionContext): void; msg?: Translator; state(): WorkflowState; protected(): boolean; commit(next: WorkflowState, ctx: ExtensionContext): void; assertCanEnter(): void; onEnter(ctx: ExtensionContext): void; loadConfig?(): Promise<WorkflowConfig> }
/** Plan's policy is shared with the coordinator, not a second execution runtime. */
export function registerPlan(pi: ExtensionAPI, hooks: Hooks): void {
  const msg = hooks.msg ?? chinese;
  const { commit } = hooks;
  /** Machine-wide extra read-only tools from the config file; session tools are added on top. */
  let configTools: string[] = [];
  let sessionEpoch = 0;
  const advance = () => { sessionEpoch++; };
  pi.on('session_start', advance); pi.on('session_before_tree', advance); pi.on('session_before_switch', advance); pi.on('session_before_fork', advance); pi.on('session_shutdown', advance);
  async function settings(ctx: ExtensionContext) {
    const epoch = sessionEpoch, current = () => epoch === sessionEpoch;
    while (current()) {
      const value = hooks.state();
      const selected = await choose(ctx, msg('Plan 设置'), [
        { id: 'mode', label: value.plan ? msg('退出只读模式') : msg('进入只读模式'), tone: 'warning', ...(ctx.isIdle() ? {} : { disabledReason: msg('主会话仍在运行；请先停止或等待，再切换 Plan') }) },
        { id: 'tools', label: msg('额外只读工具'), value: String(new Set([...configTools, ...value.planTools]).size) },
        { id: 'summary', label: msg('显示摘要'), value: hooks.summary?.() !== false ? msg('开启') : msg('关闭') },
      ], { msg, isCurrent: current, lines: [msg('Plan 只读：允许阅读、搜索和整理任务定义；禁止写入、Shell和派发执行任务。'), msg('退出 Plan 不会自动恢复 Goal；隐藏摘要不改变只读限制。')] });
      if (!current() || selected === undefined) return;
      if (selected === 'summary') hooks.setSummary?.(hooks.summary?.() === false, ctx);
      if (selected === 'mode') {
        if (!ctx.isIdle() || hooks.state().plan !== value.plan) continue;
        if (!value.plan) hooks.assertCanEnter();
        commit({ ...hooks.state(), plan: !value.plan }, ctx); if (!value.plan) hooks.onEnter(ctx);
      }
      if (selected === 'tools') {
        const available = pi.getAllTools().filter((tool) => !['todo', 'goal', 'bash', 'powershell', 'write', 'edit', 'read', 'grep', 'find', 'ls', 'ask_user_question', 'ask-user-question'].includes(tool.name) && !tool.name.startsWith('subagent_'));
        while (current()) {
          const latest = hooks.state(), names = latest.planTools;
          const item = await choose(ctx, msg('额外只读工具'), available.map((tool) => ({ id: tool.name, label: tool.name, value: names.includes(tool.name) || configTools.includes(tool.name) ? msg('允许') : msg('未选择'), ...(latest.plan ? { disabledReason: msg('先退出 Plan 才能修改工具') } : {}) })), { msg, isCurrent: current, searchable: true, lines: [msg('仅选择你信任的只读工具；此设置不会启用工具，也不是操作系统沙箱。')] });
          if (!current() || item === undefined) break;
          if (hooks.state().plan || hooks.state().planTools !== names) continue;
          if (configTools.includes(item)) { ctx.ui.notify(msg('此项来自配置文件，本会话不覆盖它'), 'info'); continue; }
          commit({ ...hooks.state(), planTools: names.includes(item) ? names.filter((name) => name !== item) : [...names, item] }, ctx);
        }
      }
    }
  }
  const loadPlanConfig = async () => {
    try { configTools = (await (hooks.loadConfig?.() ?? loadConfig(msg))).planTools; }
    catch { configTools = []; } // A broken config is reported by the other modules; Plan falls back to built-ins.
  };
  pi.on('session_start', () => loadPlanConfig());
  pi.on('session_tree', () => loadPlanConfig());
  const completion: CompletionSpec = {
    actions: [
      { action: 'start', description: msg('进入只读规划') },
      { action: 'off', description: msg('退出规划，恢复实施') },
      { action: 'status', description: msg('查看当前模式') },
      { action: 'settings', description: msg('打开只读模式设置，不切换模式') },
      { action: 'tools', description: msg('配置额外只读工具：tools 名称1,名称2 或 none') },
      { action: 'help', description: msg('查看命令帮助') },
    ],
  };
  pi.on('tool_call', (event) => { const reason = planViolation(hooks.state(), event.toolName, event.input, msg, configTools); if (reason) return { block: true, reason }; });
  pi.on('user_bash', () => { if (hooks.state().plan) return { result: { output: msg('Plan 只读：请用读取／搜索工具；执行 shell 需先 /plan off。'), exitCode: 1, cancelled: false, truncated: false } }; });
  pi.registerCommand("plan", {
    description: msg("切换只读规划；start/off/status/tools，或直接描述规划需求"),
    getArgumentCompletions: (prefix) => completeArguments(prefix, completion),
    handler: async (args, ctx) => withMenuScope(ctx, async () => {
      try {
        const trimmed = args.trim();
        if (trimmed === 'help') { ctx.ui.notify(msg('/plan start/off/status · tools 名称1,名称2（本会话追加只读工具，机器级默认见配置文件 planTools）；进入前需主会话空闲且子 Agent 已结束／取消。Plan 期间 Goal 保持暂停，恢复需明确 /goal enable。'), 'info'); return; }
        if (trimmed === 'settings') { await settings(ctx); return; }
        if (trimmed === 'show' || trimmed === 'hide') { hooks.setSummary?.(trimmed === 'show', ctx); return; }
        if (trimmed === "status") { ctx.ui.notify(hooks.state().plan ? msg("Plan（只读）：探索和编辑 Todos；实施／完成／委派在退出 Plan 后进行") : msg("Normal：可实施任务"), "info"); return; }
        if (hooks.protected()) throw new Error(msg("工作流状态损坏；先检查或明确 /todos clear 重置"));
        if (trimmed === "tools" || trimmed.startsWith("tools ")) {
          if (hooks.state().plan) throw new Error(msg("先 /plan off，再配置额外只读工具"));
          if (trimmed === "tools") { ctx.ui.notify(msg`额外只读工具 · 配置文件：${configTools.join(",") || "无"} · 本会话：${hooks.state().planTools.join(",") || "无"}。/plan tools 名称1,名称2 追加到本会话；none 清空本会话；机器级默认写在配置文件的 planTools。`, "info"); return; }
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
    }),
  });
}
