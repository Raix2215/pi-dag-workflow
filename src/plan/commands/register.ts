import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import type { WorkflowState } from "../../shared/task-types.ts";
import { planViolation } from '../domain/policy.ts';
import { completeArguments, type CompletionSpec } from '../../shared/completion.ts';
import { chinese, type Translator } from '../../shared/i18n.ts';
import { withMenuScope, choose, panelOptions, type MenuCursor, type MenuItem, type PanelNavigation } from '../../shared/ui/menu.ts';
import { loadConfig, parseToolList, writeConfig, type WorkflowConfig } from '../../shared/config.ts';
import { glyph } from '../../shared/ui/symbols.ts';

interface Hooks { panel?: PanelNavigation; summary?(): boolean; setSummary?(visible: boolean, ctx: ExtensionContext): void; msg?: Translator; state(): WorkflowState; protected(): boolean; commit(next: WorkflowState, ctx: ExtensionContext): void; assertCanEnter(): void; onEnter(ctx: ExtensionContext): void; loadConfig?(): Promise<WorkflowConfig> }
/** Plan's policy is shared with the coordinator, not a second execution runtime. */
export function registerPlan(pi: ExtensionAPI, hooks: Hooks): void {
  const msg = hooks.msg ?? chinese;
  const { commit } = hooks;
  /** Machine-wide extra read-only tools from the config file; session tools are added on top. */
  let configTools: string[] = [];
  let sessionEpoch = 0;
  const advance = () => { sessionEpoch++; };
  pi.on('session_start', advance); pi.on('session_before_tree', advance); pi.on('session_before_switch', advance); pi.on('session_before_fork', advance); pi.on('session_shutdown', advance);
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
      { action: 'settings', description: msg('查看只读模式设置，不切换模式') },
      { action: 'tools', description: msg('配置额外只读工具：tools 名称1,名称2 或 none') },
      { action: 'help', description: msg('查看命令帮助') },
    ],
  };
  pi.on('tool_call', (event) => { const reason = planViolation(hooks.state(), event.toolName, event.input, msg, configTools); if (reason) return { block: true, reason }; });
  pi.on('user_bash', () => { if (hooks.state().plan) return { result: { output: msg('Plan 只读：请用读取／搜索工具；执行 shell 需先 /plan off。'), exitCode: 1, cancelled: false, truncated: false } }; });
  async function planMenu(ctx: ExtensionContext) {
    const epoch = sessionEpoch, cursor: MenuCursor = {};
    while (epoch === sessionEpoch && !hooks.panel?.requested()) {
    const restriction = msg('Plan 只读：允许阅读、搜索和整理任务定义；禁止写入、Shell和派发执行任务。');
    const buildTools = (): MenuItem[] => {
      const value = hooks.state();
      return [
      { id: 'config-tools-edit', kind: 'input' as const, label: msg('编辑配置文件只读工具'), icon: glyph('edit'), value: configTools.join(', ') || msg('无'), input: { title: msg('工具名，逗号分隔；留空清除'), value: configTools.join(','), validate: (text: string) => parseToolList(text) === undefined ? msg('工具名需为非空且不重复；逗号分隔') : undefined }, run: async (text: unknown) => { const names = parseToolList(String(text)); if (!names) return; try { if (hooks.state().plan) throw new Error(msg('先退出 Plan，再修改可信只读工具清单。')); const known = new Set(pi.getAllTools().map(tool => tool.name)); if (names.some(name => !known.has(name) || ['todo', 'bash', 'powershell', 'write', 'edit', 'goal'].includes(name) || name.startsWith('subagent_'))) throw new Error(msg('只能选择已注册的可信只读工具，不能放行写入或派发。')); await writeConfig({ planTools: names }, msg); configTools = names; ctx.ui.notify(msg`已保存 ${names.length} 个只读工具`, 'info'); } catch (cause) { ctx.ui.notify(cause instanceof Error ? cause.message : String(cause), 'error'); } }, ...(value.plan ? { disabledReason: msg('先退出 Plan，再修改可信只读工具清单。') } : {}), description: msg('配置文件里的额外只读工具：这里直接显示名单，按 Enter 修改。') + '\n' + msg('保存后在本会话下次进入 Plan 时使用；不放行写入或派发。') },
      { id: 'session-tools', kind: 'readonly', icon: glyph('config-tools'), label: msg('本会话追加只读工具'), value: value.planTools.length ? msg`${value.planTools.length} 项` : msg('无'), description: msg('仅本会话追加的只读工具，不会放行写入或派发。') + '\n' + (value.planTools.join(', ') || msg('无')) },
      ];
    };
    const selected = await choose(ctx, 'Plan', buildTools, { msg, cursor, refreshInterval: 1000, panel: { ...panelOptions(hooks.panel, { id: 'plan', label: 'Plan' }, 'plan:root'), single: false, upper: () => {
      const value = hooks.state(), protectedState = hooks.protected(), idle = ctx.isIdle();
      let condition = msg('可进入（主会话空闲且无活动子 Agent）');
      if (protectedState) condition = msg('工作流状态损坏；保持只读保护');
      else if (!idle) condition = msg('主会话仍在运行；请先停止或等待，再切换 Plan');
      else { try { hooks.assertCanEnter(); } catch (cause) { condition = cause instanceof Error ? cause.message : String(cause); } }
      const mode = value.plan ? msg('Plan 只读') : msg('普通');
      return { rows: [
      { id: 'mode', label: msg('模式'), kind: 'toggle', checked: value.plan, run: (value: unknown) => command(value === true ? 'start' : 'off', ctx), icon: glyph('edit'), value: mode, description: msg('允许阅读、搜索和整理任务定义；进入 Plan 前需主会话空闲、子 Agent 已结束。') + '\n' + msg('退出 Plan 不会自动恢复 Goal。'), ...(protectedState || !idle || !value.plan && condition !== msg('可进入（主会话空闲且无活动子 Agent）') ? { disabledReason: condition } : {}) },
      { id: 'restrictions', label: msg('只读限制'), icon: glyph('restrictions'), value: msg('写入/Shell/派发 禁用'), description: restriction, kind: 'readonly' },
      { id: 'entry', label: msg('进入条件'), icon: glyph('complete'), value: condition, description: condition + '\n' + msg('退出 Plan 不会自动恢复 Goal。'), kind: 'readonly' },
      ] };
    } }, isCurrent: () => epoch === sessionEpoch && !hooks.panel?.requested() });
    if (epoch !== sessionEpoch || selected === undefined) return;
    if (cursor.handled) continue;
    }
  }
  const command = async (args: string, ctx: ExtensionContext) => withMenuScope(ctx, async () => {
      try {
        const trimmed = args.trim();
        if (!trimmed && ctx.mode === 'tui') { await planMenu(ctx); return; }
        if (trimmed === 'help') { ctx.ui.notify(msg('/plan start/off/status · settings（查看设置）· tools 名称1,名称2（本会话追加只读工具，机器级默认见配置文件 planTools）；进入前需主会话空闲且子 Agent 已结束／取消。Plan 期间 Goal 保持暂停，恢复需明确 /goal enable。'), 'info'); return; }
        if (trimmed === 'settings') { const value = hooks.state(); ctx.ui.notify([msg`Plan 设置 · 模式：${value.plan ? msg('Plan 只读') : msg('普通')}`, msg`额外只读工具（配置文件）：${configTools.join(',') || msg('无')}`, msg`额外只读工具（本会话）：${value.planTools.join(',') || msg('无')}`, msg('Plan 只读：允许阅读、搜索和整理任务定义；禁止写入、Shell和派发执行任务。'), msg('退出 Plan 不会自动恢复 Goal；隐藏摘要不改变只读限制。')].join('\n'), 'info'); return; }
        if (trimmed === 'show' || trimmed === 'hide') { hooks.setSummary?.(trimmed === 'show', ctx); return; }
        if (trimmed === "status") { ctx.ui.notify(hooks.state().plan ? msg("Plan（只读）：探索和编辑 Todos；实施／完成／委派在退出 Plan 后进行") : msg("普通模式：允许实施，仍受其他权限限制。"), "info"); return; }
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
        // Repeating a mode change is not a transition: say the state instead of claiming a fresh one.
        if (hooks.state().plan === !off) { ctx.ui.notify(off ? msg('当前已是普通模式（Plan 未开启）') : msg('已在 Plan（只读）中：重复进入没有改变状态'), 'info'); return; }
        if (!ctx.isIdle()) throw new Error(msg("主会话仍在运行；请先停止或等待，再切换 Plan"));
        if (!off) hooks.assertCanEnter();
        commit({ ...hooks.state(), plan: !off }, ctx);
        if (!off) hooks.onEnter(ctx);
        ctx.ui.notify(off ? msg("已退出 Plan；使用同一份 Todos 继续") : msg("已进入 Plan（只读）；可探索与编辑 Todos，实施／完成／委派待退出后继续"), "info");
        if (!off && trimmed && trimmed !== "start" && trimmed !== 'on') pi.sendUserMessage(trimmed, { deliverAs: 'followUp' });
      } catch (error) { ctx.ui.notify(error instanceof Error ? error.message : String(error), "error"); }
    });
  hooks.panel?.register(ctx => command('', ctx));
  pi.registerCommand('plan', { description: msg('切换只读规划；start/off/status/settings/tools，或直接描述规划需求'), getArgumentCompletions: prefix => completeArguments(prefix, completion), handler: async (args, ctx) => {
    if (!args.trim() && ctx.mode === 'tui' && hooks.panel) { await hooks.panel.open(ctx); return; }
    await command(args, ctx);
  } });
}
