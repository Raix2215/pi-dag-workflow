import { Type, type Static } from "typebox";
import { dagStructure, reuseDagStructure } from "../dag/cache.ts";
import { chinese, type Translator } from "../shared/i18n.ts";

const Status = Type.Union([Type.Literal("pending"), Type.Literal("in_progress"), Type.Literal("completed"), Type.Literal("deleted")]);
export const TodoParamsSchema = Type.Object({
  action: Type.Union([Type.Literal("create"), Type.Literal("update"), Type.Literal("list"), Type.Literal("get"), Type.Literal("delete"), Type.Literal("clear")]),
  id: Type.Optional(Type.Integer({ minimum: 1, description: "Required for update/get/delete" })),
  subject: Type.Optional(Type.String({ description: "Short title; required for create" })),
  description: Type.Optional(Type.String({ description: "Task instructions or evidence" })),
  activeForm: Type.Optional(Type.String({ description: "Current activity label" })),
  status: Type.Optional(Type.Union([Type.Literal("pending"), Type.Literal("in_progress"), Type.Literal("completed"), Type.Literal("deleted")], { description: "Update sets status; list filters status" })),
  blockedBy: Type.Optional(Type.Array(Type.Integer({ minimum: 1 }), { description: "Initial prerequisite ids, create only" })),
  addBlockedBy: Type.Optional(Type.Array(Type.Integer({ minimum: 1 }), { description: "Update: add prerequisites" })),
  removeBlockedBy: Type.Optional(Type.Array(Type.Integer({ minimum: 1 }), { description: "Update: remove prerequisites" })),
  owner: Type.Optional(Type.String()),
  metadata: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  includeDeleted: Type.Optional(Type.Boolean()),
}, { additionalProperties: false });
export type TodoParams = Static<typeof TodoParamsSchema>;
export type TodoStatus = Static<typeof Status>;
export interface Todo {
  id: number;
  subject: string;
  status: TodoStatus;
  blockedBy: number[];
  description?: string;
  activeForm?: string;
  owner?: string;
  metadata?: Record<string, unknown>;
}
export interface WorkflowState {
  version: 1;
  tasks: Todo[];
  nextId: number;
  plan: boolean;
  planTools: string[];
  visible: boolean;
  view: "list" | "dag";
  treeStyle?: "paths" | "flat";
}
export const STATE_TYPE = "pi-dag-workflow.state";
export const emptyState = (): WorkflowState => ({ version: 1, tasks: [], nextId: 1, plan: false, planTools: [], visible: true, view: "list", treeStyle: "paths" });

const fields: Record<string, readonly string[]> = {
  create: ["subject", "description", "activeForm", "owner", "metadata", "blockedBy"],
  update: ["id", "subject", "description", "activeForm", "owner", "metadata", "status", "addBlockedBy", "removeBlockedBy"],
  list: ["status", "includeDeleted"], get: ["id"], delete: ["id"], clear: [],
};
const transitions: Record<TodoStatus, readonly TodoStatus[]> = {
  pending: ["pending", "in_progress", "completed", "deleted"],
  in_progress: ["pending", "in_progress", "completed", "deleted"],
  completed: ["completed", "deleted"], deleted: ["deleted"],
};
export function todoRef(todo: Todo): string {
  return `#${todo.id}${todo.blockedBy.length ? `<-${todo.blockedBy.map((id) => `#${id}`).join(",")}` : ""}`;
}
export const statusLabel: Record<TodoStatus, string> = { pending: "待执行", in_progress: "进行中", completed: "已完成", deleted: "已删除" };
const textFields = ["subject", "description", "activeForm", "owner"] as const;

function validateTask(task: Todo, msg: Translator = chinese): void {
  if (!task.subject.trim() || Array.from(task.subject).length > 60) throw new Error(msg("标题需为 1–60 个字符；详细指示请写 description"));
  for (const field of textFields) {
    const value = task[field];
    if (value !== undefined && (typeof value !== "string" || Buffer.byteLength(value) > 8192)) throw new Error(msg`${field} 需为不超过 8 KiB 的文本`);
  }
  if (!Object.hasOwn(transitions, task.status)) throw new Error(msg("未知任务状态"));
  if (!Array.isArray(task.blockedBy) || task.blockedBy.some((id) => !Number.isSafeInteger(id) || id < 1)) throw new Error(msg("依赖需为有效任务编号"));
  if (task.metadata !== undefined) {
    if (!task.metadata || typeof task.metadata !== "object" || Array.isArray(task.metadata) || Buffer.byteLength(JSON.stringify(task.metadata)) > 8192) throw new Error(msg("metadata 需为不超过 8 KiB 的 JSON 对象"));
  }
}
export function validateState(state: WorkflowState, msg: Translator = chinese): void {
  if (state.version !== 1 || !Array.isArray(state.tasks) || !Number.isSafeInteger(state.nextId) || state.nextId < 1) throw new Error(msg("不支持或损坏的工作流状态"));
  if (typeof state.plan !== "boolean" || typeof state.visible !== "boolean" || !["list", "dag"].includes(state.view)) throw new Error(msg("损坏的模式／视图状态"));
  if (state.treeStyle !== undefined && !["paths", "flat"].includes(state.treeStyle)) throw new Error(msg("损坏的任务树样式"));
  if (!Array.isArray(state.planTools) || state.planTools.some((name) => typeof name !== "string" || !/^[\w-]+$/.test(name))) throw new Error(msg("损坏的 Plan 工具列表"));
  for (const task of state.tasks) {
    validateTask(task, msg);
    if (task.id >= state.nextId) throw new Error(msg("任务计数器不能复用已有编号"));
  }
  dagStructure(state.tasks);
}

/** Atomic pure mutation: errors never modify the current state. */
export function applyTodo(state: WorkflowState, params: TodoParams, msg: Translator = chinese): { state: WorkflowState; text: string } {
  const allowed = fields[params.action];
  if (!allowed) throw new Error(msg("未知 Todo 操作"));
  for (const key of Object.keys(params)) if (key !== "action" && !allowed.includes(key)) throw new Error(msg`${params.action} 不接受字段 ${key}`);
  if (params.action === "list") {
    const tasks = state.tasks.filter((task) => (params.includeDeleted || task.status !== "deleted") && (!params.status || task.status === params.status));
    return { state, text: tasks.length ? tasks.map((task) => `${todoRef(task)} [${msg(statusLabel[task.status])}] ${task.subject}`).join("\n") : msg("暂无任务") };
  }
  const current = params.id === undefined ? undefined : state.tasks.find((task) => task.id === params.id);
  if (["get", "update", "delete"].includes(params.action) && !current) throw new Error(msg`找不到任务 #${params.id ?? "?"}`);
  if (params.action === "get") return { state, text: JSON.stringify(current, null, 2) };
  if (state.plan && params.status && ["in_progress", "completed"].includes(params.status)) throw new Error(msg("Plan 只允许整理任务，不允许开始或完成；先 /plan off"));
  if (params.action === "clear") {
    if (!state.tasks.length) return { state, text: msg("暂无任务") };
    return { state: { ...state, tasks: [] }, text: msg`已清空 ${state.tasks.length} 项，编号不复用` };
  }
  let task: Todo;
  if (params.action === "create") {
    if (!params.subject?.trim()) throw new Error(msg("create 需要 subject"));
    task = { id: state.nextId, subject: params.subject.trim(), status: "pending", blockedBy: [...new Set(params.blockedBy ?? [])] };
  } else {
    task = { ...current!, blockedBy: [...current!.blockedBy] };
    if (task.status === "deleted") throw new Error(msg`任务 #${task.id} 已删除`);
    if (params.action === "delete") task.status = "deleted";
    if (params.action === "update") {
      if (Object.keys(params).every((key) => key === "action" || key === "id")) throw new Error(msg("update 需要至少一个修改字段"));
      if (params.status) {
        if (!transitions[task.status].includes(params.status)) throw new Error(msg`不允许 ${task.status} → ${params.status}；返工请新建任务`);
        task.status = params.status;
      }
      const removed = new Set(params.removeBlockedBy ?? []);
      task.blockedBy = [...new Set([...task.blockedBy, ...params.addBlockedBy ?? []])].filter((id) => !removed.has(id));
    }
  }
  for (const field of textFields) if (params[field] !== undefined) task[field] = params[field]!;
  if (params.metadata !== undefined) {
    const merged = new Map(Object.entries(task.metadata ?? {}));
    for (const [key, value] of Object.entries(params.metadata)) value === null ? merged.delete(key) : merged.set(key, value);
    if (merged.size) task.metadata = structuredClone(Object.fromEntries(merged)); else delete task.metadata;
  }
  validateTask(task, msg);
  const tasks = params.action === "create" ? [...state.tasks, task] : state.tasks.map((item) => item.id === task.id ? task : item);
  const next = { ...state, tasks, nextId: state.nextId + (params.action === "create" ? 1 : 0) };
  if (!reuseDagStructure(state.tasks, tasks)) dagStructure(tasks); // delete safety, dangling dependencies, cycles
  if (["in_progress", "completed"].includes(task.status)) {
    const unfinished = task.blockedBy.filter((id) => tasks.find((item) => item.id === id)?.status !== "completed");
    if (unfinished.length) throw new Error(msg`前置未完成：${unfinished.map((id) => `#${id}`).join(",")}；不能开始或完成 #${task.id}`);
  }
  if (JSON.stringify(task) === JSON.stringify(current)) return { state, text: msg`#${task.id} 无变化` };
  return { state: next, text: msg`${params.action === "create" ? msg("已创建") : msg("已更新")} #${task.id}：${task.subject} [${msg(statusLabel[task.status])}]` };
}

/**
 * Only walk the active branch; never replay abandoned branches or model summaries.
 * A list left by rpiv-todo (same tool name, same result shape) is read only when this
 * plugin has no snapshot of its own on the branch, so an existing session keeps its tasks.
 */
export function restoreState(branch: readonly { type: string; customType?: string; data?: unknown; message?: unknown }[], msg: Translator = chinese): WorkflowState {
  let rpiv: unknown;
  for (let index = branch.length - 1; index >= 0; index--) {
    const entry = branch[index]!;
    if (entry.type === "custom" && entry.customType === STATE_TYPE) {
      const state = structuredClone(entry.data) as WorkflowState;
      validateState(state, msg);
      return state;
    }
    if (rpiv === undefined && entry.type === "message" && entry.message && typeof entry.message === "object") {
      const message = entry.message as { role?: string; toolName?: string; details?: { tasks?: unknown; nextId?: unknown } };
      if (message.role === "toolResult" && message.toolName === "todo" && Array.isArray(message.details?.tasks) && Number.isSafeInteger(message.details?.nextId)) rpiv = message.details;
    }
  }
  if (rpiv) {
    const data = structuredClone(rpiv) as { tasks: Todo[]; nextId: number };
    const state = { ...emptyState(), tasks: data.tasks.map((task) => ({ ...task, blockedBy: task.blockedBy ?? [] })), nextId: data.nextId };
    validateState(state, msg);
    return state;
  }
  return emptyState();
}
