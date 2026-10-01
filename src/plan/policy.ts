import type { WorkflowState } from "../todos/state.ts";
import { chinese, type Translator } from "../shared/i18n.ts";

const READ_TOOLS = new Set(["read", "grep", "find", "ls", "ask_user_question", "ask-user-question"]);
export const NORMAL_GUIDANCE = "Normal mode. Todos are optional; use one current list and blockedBy for dependencies. Start or complete work only after its predecessors are completed. Do not create a separate plan or graph.";
export const PLAN_GUIDANCE = "Plan mode: explore, read, search, ask questions, and shape the current Todo list. Implementation, shell commands, and dispatch resume once the user runs /plan off.";

/** Execution guard, including nested tool calls. Tool declarations stay cache-stable. */
export function planViolation(state: WorkflowState, tool: string, input: unknown, msg: Translator = chinese): string | undefined {
  if (!state.plan) return;
  if (["subagent_inspect", "subagent_wait", "subagent_cancel"].includes(tool)) return;
  if (tool === "goal" && ["list", "get", "disable", "complete", "delete"].includes((input as { action?: string } | null)?.action ?? "")) return;
  if (["write", "edit", "bash", "powershell", "goal"].includes(tool) || tool.startsWith("subagent_")) return msg`Plan 只读：${tool} 需先 /plan off`;
  if (tool === "todo") {
    const params = input as { action?: string; status?: string } | null;
    if (params?.status === "completed" || params?.status === "in_progress") return msg("Plan 只整理 Todos；开始或完成请先 /plan off");
    if (["create", "update", "list", "get", "delete", "clear"].includes(params?.action ?? "")) return;
  }
  if (READ_TOOLS.has(tool) || state.planTools.includes(tool)) return;
  return msg`Plan 只读：请用读取／搜索工具；${tool} 等实施操作需先 /plan off。额外只读工具可由用户通过 /plan tools 配置。`;
}
