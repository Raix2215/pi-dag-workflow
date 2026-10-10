import type { WorkflowState } from "../todos/state.ts";
import { chinese, type Translator } from "../shared/i18n.ts";

const READ_TOOLS = new Set(["read", "grep", "find", "ls", "ask_user_question", "ask-user-question"]);
export const NORMAL_GUIDANCE = "Normal mode. Plan multi-step work in the one todo list and keep blockedBy current; start or complete work only after its predecessors are completed. Do not create a separate plan or graph.";
export const PLAN_GUIDANCE = "Plan mode: explore, read, search and ask questions; use todo to create/edit the current list. Do not implement, start/complete tasks, run shell commands or dispatch agents. Only the user can leave Plan with /plan off.";

/**
 * Execution guard, including nested tool calls. Tool declarations stay cache-stable.
 * `configTools` is the machine-wide extra read-only allowlist; the hard guards above it still win,
 * so a configured name can never unlock writes, shell commands, or dispatch.
 */
export function planViolation(state: WorkflowState, tool: string, input: unknown, msg: Translator = chinese, configTools: readonly string[] = []): string | undefined {
  if (!state.plan) return;
  if (["subagent_inspect", "subagent_cancel"].includes(tool)) return;
  if (tool === "goal" && ["list", "get", "disable", "complete", "delete"].includes((input as { action?: string } | null)?.action ?? "")) return;
  if (["write", "edit", "bash", "powershell", "goal"].includes(tool) || tool.startsWith("subagent_")) return msg`Plan 中不允许执行 ${tool}；先 /plan off`;
  if (tool === "todo") {
    const params = input as { action?: string; status?: string; operations?: { action?: string; status?: string }[] } | null;
    if (params?.action === 'batch' && Array.isArray(params.operations)) {
      if (params.operations.every((operation) => operation && (operation.action === 'create' && (operation.status === undefined || operation.status === 'pending') || operation.action === 'update' && operation.status === undefined))) return;
      return msg('Plan 只允许整理 Todos，不允许开始或完成；先 /plan off');
    }
    if (["create", "update"].includes(params?.action ?? "") && (params?.status === "completed" || params?.status === "in_progress")) return msg("Plan 只允许整理 Todos，不允许开始或完成；先 /plan off");
    if (["create", "update", "list", "get", "delete", "clear", "apply", "reset", "presets"].includes(params?.action ?? "")) return;
  }
  if (READ_TOOLS.has(tool) || state.planTools.includes(tool) || configTools.includes(tool)) return;
  return msg`Plan 中不能执行 ${tool}。请用读取／搜索工具，或退出 Plan 后实施。额外只读工具需由用户通过 /plan tools 或配置文件的 planTools 明确配置。`;
}
