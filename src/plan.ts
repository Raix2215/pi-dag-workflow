import type { WorkflowState } from "./todos.ts";

const READ_TOOLS = new Set(["read", "grep", "find", "ls", "ask_user_question", "ask-user-question"]);
export const NORMAL_GUIDANCE = "Normal mode. Todos are optional; use one current list and blockedBy for dependencies. Start or complete work only after its predecessors are completed. Do not create a separate plan or graph.";
export const PLAN_GUIDANCE = "Plan mode: explore, read, search and ask questions; use todo to create/edit the current list. Do not implement, start/complete tasks, run shell commands or dispatch agents. Only the user can leave Plan with /plan off.";

/** Execution guard, including nested tool calls. Tool declarations stay cache-stable. */
export function planViolation(state: WorkflowState, tool: string, input: unknown): string | undefined {
  if (!state.plan) return;
  if (["subagent_inspect", "subagent_wait", "subagent_cancel"].includes(tool)) return;
  if (["write", "edit", "bash", "powershell", "goal"].includes(tool) || tool.startsWith("subagent_")) return `Plan 中不允许执行 ${tool}；先 /plan off`;
  if (tool === "todo") {
    const params = input as { action?: string; status?: string } | null;
    if (params?.status === "completed" || params?.status === "in_progress") return "Plan 只允许整理 Todos，不允许开始或完成；先 /plan off";
    if (["create", "update", "list", "get", "delete", "clear"].includes(params?.action ?? "")) return;
  }
  if (READ_TOOLS.has(tool) || state.planTools.includes(tool)) return;
  return `Plan 中不能执行 ${tool}。请用读取／搜索工具，或退出 Plan 后实施。额外只读工具需由用户通过 /plan tools 明确配置。`;
}
