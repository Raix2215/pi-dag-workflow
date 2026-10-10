import { Type, type Static } from "typebox";
import { dagStructure, reuseDagStructure } from "../dag/cache.ts";
import { chinese, type Translator } from "../shared/i18n.ts";
import { expand, nextRun, resetClosure, type Preset, type PresetStore } from "./presets.ts";
import { planTaskCleanup } from './cleanup.ts';

const Status = Type.Enum(['pending', 'in_progress', 'completed', 'failed', 'cancelled', 'deleted'] as const, { type: 'string' });
const Reference = Type.Union([Type.Integer({ minimum: 1 }), Type.String({ pattern: '^@[A-Za-z][A-Za-z0-9_-]{0,31}$' })]);
const BatchOperationSchema = Type.Object({
  action: Type.Enum(['create', 'update'] as const, { type: 'string' }),
  ref: Type.Optional(Type.String({ pattern: '^[A-Za-z][A-Za-z0-9_-]{0,31}$' })),
  id: Type.Optional(Reference),
  subject: Type.Optional(Type.String()), description: Type.Optional(Type.String()),
  activeForm: Type.Optional(Type.String()), owner: Type.Optional(Type.String()),
  metadata: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  status: Type.Optional(Type.Literal('pending')),
  blockedBy: Type.Optional(Type.Array(Reference)),
  addBlockedBy: Type.Optional(Type.Array(Reference)), removeBlockedBy: Type.Optional(Type.Array(Reference)),
}, { additionalProperties: false });
export type TodoBatchOperation = Static<typeof BatchOperationSchema>;
export const TODO_FILTERS = ['full', 'pending', 'completed', 'failed', 'cancelled'] as const;
export type TodoFilter = typeof TODO_FILTERS[number];
export type ClearScope = 'all' | 'completed' | 'closed';
export const TodoParamsSchema = Type.Object({
  action: Type.Enum(['create', 'update', 'list', 'get', 'delete', 'clear', 'apply', 'reset', 'batch', 'presets'] as const, { type: 'string' }),
  operations: Type.Optional(Type.Array(BatchOperationSchema, { minItems: 1, maxItems: 50, description: "batch only: 1–50 pending creates or definition updates. A create may name ref; @ref in ids/dependencies refers only to earlier creates in this batch. Any failure rolls back the entire call." })),
  id: Type.Optional(Type.Integer({ minimum: 1, description: "Required for update/get/delete" })),
  subject: Type.Optional(Type.String({ description: "Short title; required for create" })),
  description: Type.Optional(Type.String({ description: 'Task requirements and necessary context; not a status log. Usually omit on status-only updates.' })),
  activeForm: Type.Optional(Type.String({ description: "Current activity label" })),
  status: Type.Optional(Type.Enum(['pending', 'in_progress', 'completed', 'failed', 'cancelled', 'deleted'] as const, { type: 'string', description: 'Create: pending or in_progress; update after verification; list filters status' })),
  scope: Type.Optional(Type.Enum(['all', 'completed', 'closed'] as const, { type: 'string', description: 'clear only: all (default), completed, or closed (completed/failed/cancelled/deleted); protected records remain' })),
  blockedBy: Type.Optional(Type.Array(Type.Integer({ minimum: 1 }), { description: "Initial prerequisite ids, create only" })),
  addBlockedBy: Type.Optional(Type.Array(Type.Integer({ minimum: 1 }), { description: "Update: add prerequisites" })),
  removeBlockedBy: Type.Optional(Type.Array(Type.Integer({ minimum: 1 }), { description: "Update: remove prerequisites" })),
  owner: Type.Optional(Type.String()),
  metadata: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  includeDeleted: Type.Optional(Type.Boolean()),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200, description: "list only: page size, default 50, maximum 200." })),
  afterId: Type.Optional(Type.Integer({ minimum: 0, description: "list only: exclusive id cursor. Use returned continuation arguments to preserve filters." })),
  ready: Type.Optional(Type.Boolean({ description: "list only: pending tasks whose prerequisites are all completed." })),
  preset: Type.Optional(Type.String({ description: "Fragment name: apply/reset target, or the fragment to describe in full for action presets" })),
  vars: Type.Optional(Type.Record(Type.String(), Type.String(), { description: "apply: values for {placeholders} in the fragment" })),
  run: Type.Optional(Type.Integer({ minimum: 1, description: "reset: instance run, default the newest" })),
  step: Type.Optional(Type.String({ description: "reset: reopen this step and every task that depends on it" })),
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
  filter?: TodoFilter;
}
export const STATE_TYPE = "pi-dag-workflow.state";
export interface TodoPage { total: number; count: number; limit: number; afterId: number; nextAfterId?: number; next?: TodoParams }
export interface TodoRelations { blocks: number[]; unmetPrerequisites: number[] }
export interface TodoResult { state: WorkflowState; text: string; tasks?: Todo[]; page?: TodoPage; relations?: TodoRelations; removedIds?: number[]; refs?: Record<string, number>; operations?: TodoParams[]; presets?: { name: string; description?: string; steps: number }[]; preset?: Preset }
export const emptyState = (): WorkflowState => ({ version: 1, tasks: [], nextId: 1, plan: false, planTools: [], visible: true, view: "list", treeStyle: "paths" });

const fields: Record<string, readonly string[]> = {
  create: ["subject", "description", "activeForm", "owner", "metadata", "blockedBy", "status"],
  update: ["id", "subject", "description", "activeForm", "owner", "metadata", "status", "addBlockedBy", "removeBlockedBy"],
  list: ["status", "includeDeleted", "limit", "afterId", "ready"], get: ["id"], delete: ["id"], clear: ['scope'],
  apply: ["preset", "vars"], reset: ["preset", "run", "step"], presets: ["preset"],
  batch: ['operations'],
};
const transitions: Record<TodoStatus, readonly TodoStatus[]> = {
  pending: ["pending", "in_progress", "completed", "failed", "cancelled", "deleted"],
  in_progress: ["pending", "in_progress", "completed", "failed", "cancelled", "deleted"],
  failed: ["pending", "in_progress", "completed", "failed", "cancelled", "deleted"],
  cancelled: ["pending", "in_progress", "completed", "failed", "cancelled", "deleted"],
  completed: ["completed", "deleted"], deleted: ["deleted"],
};
export function todoRef(todo: Todo): string {
  return `#${todo.id}${todo.blockedBy.length ? `<-${todo.blockedBy.map((id) => `#${id}`).join(",")}` : ""}`;
}
export const statusLabel: Record<TodoStatus, string> = { pending: "待执行", in_progress: "进行中", completed: "已完成", failed: "失败", cancelled: "已取消", deleted: "已删除" };
const textFields = ["subject", "description", "activeForm", "owner"] as const;

function validateTask(task: Todo, msg: Translator = chinese): void {
  if (!task || typeof task.subject !== "string" || !task.subject.trim() || Array.from(task.subject).length > 60) throw new Error(msg("标题需为 1–60 个字符；详细指示请写 description"));
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
  if (!state || state.version !== 1 || !Array.isArray(state.tasks) || !Number.isSafeInteger(state.nextId) || state.nextId < 1) throw new Error(msg("不支持或损坏的工作流状态"));
  if (typeof state.plan !== "boolean" || typeof state.visible !== "boolean" || !["list", "dag"].includes(state.view)) throw new Error(msg("损坏的模式／视图状态"));
  if (state.treeStyle !== undefined && !["paths", "flat"].includes(state.treeStyle)) throw new Error(msg("损坏的任务树样式"));
  if (state.filter !== undefined && !TODO_FILTERS.includes(state.filter)) throw new Error(msg('损坏的任务过滤器'));
  if (!Array.isArray(state.planTools) || state.planTools.some((name) => typeof name !== "string" || !/^[\w-]+$/.test(name))) throw new Error(msg("损坏的 Plan 工具列表"));
  for (const task of state.tasks) {
    validateTask(task, msg);
    if (task.id >= state.nextId) throw new Error(msg("任务计数器不能复用已有编号"));
  }
  dagStructure(state.tasks);
}

/** Pure task cleanup. The runtime coordinator supplies job protections/outcomes and prunes jobs. */
export function clearTodoRecords(state: WorkflowState, scope: ClearScope = 'all', protectedIds: ReadonlySet<number> = new Set(), outcomes?: ReadonlyMap<number, string>, msg: Translator = chinese) {
  const result = planTaskCleanup(state.tasks, scope, protectedIds, outcomes);
  if (!result.removedIds.length) return { state, text: msg`没有可清理任务；保留 ${result.keptIds.length} 项（运行／待核验／依赖必需）`, ...result };
  const next = { ...state, tasks: result.tasks };
  validateState(next, msg);
  return { state: next, text: msg`已清理 ${result.removedIds.length} 项（${scope}）；保留 ${result.keptIds.length} 项，编号不复用`, ...result };
}

export function validateTodoFields(params: TodoParams, msg: Translator = chinese): void {
  const allowed = fields[params.action];
  if (!allowed) throw new Error(msg("未知 Todo 操作"));
  for (const key of Object.keys(params)) if (key !== "action" && !allowed.includes(key)) throw new Error(msg`${params.action} 不接受字段 ${key}`);
}

/** Atomic pure mutation: errors never modify the current state. */
export function applyTodo(state: WorkflowState, params: TodoParams, msg: Translator = chinese, presets?: PresetStore): TodoResult {
  validateTodoFields(params, msg);
  if (params.action === 'batch') return applyBatch(state, params.operations, msg);
  if (params.action === 'presets') {
    // Read-only discovery: compact directory summaries, or one full definition.
    if (params.preset !== undefined) {
      const preset = presets?.get(params.preset);
      if (!preset) throw new Error(msg`未找到片段 ${params.preset}`);
      return { state, preset, text: JSON.stringify(preset, null, 2) };
    }
    const directory = presets?.list().map((item) => ({ name: item.name, ...(item.description ? { description: item.description } : {}), steps: item.steps.length })) ?? [];
    return { state, presets: directory, text: directory.length ? JSON.stringify(directory, null, 2) : msg('未配置 Todo 片段：在 ~/.pi/agent/pi-dag-workflow/pi-dag-workflow-preset.json 里定义') };
  }
  if (params.action === "apply" || params.action === "reset") {
    const name = params.preset ?? "";
    if (!presets || !name) throw new Error(msg("apply/reset 需要 preset，且需配置片段文件"));
    if (params.action === "apply") {
      const preset = presets.get(name);
      if (!preset) throw new Error(msg`未找到片段 ${name}`);
      const { tasks: created, ids } = expand(preset, nextRun(state.tasks, name), state.nextId, params.vars);
      for (const task of created) validateTask(task, msg);
      const tasks = [...state.tasks, ...created];
      if (!reuseDagStructure(state.tasks, tasks)) dagStructure(tasks);
      const map = [...ids].map(([key, id]) => `${key}=#${id}`).join(", ");
      const hint = preset.skill ? msg`；执行前建议加载 skill：${preset.skill}` : "";
      return { state: { ...state, tasks, nextId: state.nextId + created.length }, tasks: created, text: msg`已创建片段 ${name} 第 ${nextRun(state.tasks, name)} 轮（${created.length} 项）：${map}${hint}` };
    }
    const ids = resetClosure(state.tasks, name, params.step, params.run);
    if (!ids.length) throw new Error(params.step ? msg`片段 ${name} 中没有步骤 ${params.step}` : msg`没有可重置的片段 ${name}`);
    const reopened = new Set(ids);
    const tasks = state.tasks.map((task) => {
      if (!reopened.has(task.id)) return task;
      const { activeForm: _dropped, ...rest } = task;
      return { ...rest, status: "pending" as const };
    });
    if (!reuseDagStructure(state.tasks, tasks)) dagStructure(tasks);
    return { state: { ...state, tasks }, tasks: tasks.filter((task) => reopened.has(task.id)), text: msg`已重置片段 ${name} 的 ${ids.length} 项为待执行：${ids.map((id) => `#${id}`).join(", ")}` };
  }
  if (params.action === "list") {
    const limit = params.limit ?? 50; const afterId = params.afterId ?? 0;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200 || !Number.isSafeInteger(afterId) || afterId < 0) throw new Error(msg('分页参数无效：limit 为 1–200，afterId 为非负整数'));
    if (params.ready && params.status !== undefined && params.status !== 'pending') throw new Error(msg('ready 只支持 pending 任务'));
    const statuses = params.ready ? new Map(state.tasks.map((task) => [task.id, task.status])) : undefined;
    const matched = state.tasks.filter((task) => (params.includeDeleted || task.status !== "deleted") && (!params.status || task.status === params.status) && (!statuses || task.status === 'pending' && task.blockedBy.every((id) => statuses.get(id) === 'completed'))).sort((a, b) => a.id - b.id);
    const remaining = matched.filter((task) => task.id > afterId);
    const tasks = remaining.slice(0, limit);
    const page: TodoPage = { total: matched.length, count: tasks.length, limit, afterId, ...(remaining.length > limit ? { nextAfterId: tasks.at(-1)!.id } : {}) };
    if (page.nextAfterId !== undefined) page.next = { action: 'list', afterId: page.nextAfterId, limit, ...(params.status ? { status: params.status } : {}), ...(params.includeDeleted ? { includeDeleted: true } : {}), ...(params.ready ? { ready: true } : {}) };
    const header = msg`本页 ${tasks.length} / 共 ${matched.length} 项`;
    const text = tasks.length ? `${header}\n${tasks.map((task) => `${todoRef(task)} [${msg(statusLabel[task.status])}] ${task.subject}`).join("\n")}` : `${header}\n${msg('暂无任务')}`;
    return { state, tasks, page, text: page.next ? `${text}\n${msg`继续读取：${JSON.stringify(page.next)}`}` : text };
  }
  const current = params.id === undefined ? undefined : state.tasks.find((task) => task.id === params.id);
  if (["get", "update", "delete"].includes(params.action) && !current) throw new Error(msg`找不到任务 #${params.id ?? "?"}`);
  if (params.action === "get") {
    const status = new Map(state.tasks.map((task) => [task.id, task.status]));
    const relations = { blocks: state.tasks.filter((task) => task.status !== 'deleted' && task.blockedBy.includes(current!.id)).map((task) => task.id).sort((a, b) => a - b), unmetPrerequisites: current!.blockedBy.filter((id) => status.get(id) !== 'completed') };
    return { state, tasks: [current!], relations, text: JSON.stringify({ ...current, ...relations }, null, 2) };
  }
  if (state.plan && params.status && ["in_progress", "completed"].includes(params.status)) throw new Error(msg("Plan 只允许整理任务，不允许开始或完成；先 /plan off"));
  if (params.action === "clear") return clearTodoRecords(state, params.scope ?? 'all', new Set(), undefined, msg);
  let task: Todo;
  if (params.action === "create") {
    if (!params.subject?.trim()) throw new Error(msg("create 需要 subject"));
    if (!Number.isSafeInteger(state.nextId + 1)) throw new Error(msg("任务计数器不能复用已有编号"));
    if (params.status !== undefined && !['pending', 'in_progress'].includes(params.status)) throw new Error(msg('create 的 status 只支持 pending 或 in_progress；核验完成后用 update 设置 completed'));
    task = { id: state.nextId, subject: params.subject.trim(), status: params.status ?? "pending", blockedBy: [...new Set(params.blockedBy ?? [])] };
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
  if (JSON.stringify(task) === JSON.stringify(current)) return { state, tasks: [current!], text: msg`#${task.id} 无变化` };
  return { state: next, tasks: [task], text: msg`${params.action === "create" ? msg("已创建") : msg("已更新")} #${task.id}：${task.subject} [${msg(statusLabel[task.status])}]` };
}

/** Resolve a small sequential transaction in memory; the coordinator commits only its final state. */
function applyBatch(state: WorkflowState, operations: TodoBatchOperation[] | undefined, msg: Translator): TodoResult {
  if (!Array.isArray(operations) || !operations.length || operations.length > 50) throw new Error(msg('batch 需要 1–50 个定义操作'));
  let draft = state;
  const refs = new Map<string, number>(); const resolved: TodoParams[] = []; const touched = new Set<number>();
  const resolve = (value: number | string): number => {
    if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return value;
    if (typeof value !== 'string' || !/^@[A-Za-z][A-Za-z0-9_-]{0,31}$/.test(value) || !refs.has(value.slice(1))) throw new Error(msg`未知 batch 引用：${String(value)}`);
    return refs.get(value.slice(1))!;
  };
  for (const [index, operation] of operations.entries()) {
    try {
      if (!operation || !['create', 'update'].includes(operation.action)) throw new Error(msg('batch 仅支持 create pending 和 update 定义'));
      const allowed = operation.action === 'create' ? [...fields.create!, 'ref'] : fields.update!.filter((key) => key !== 'status' && key !== 'owner');
      for (const key of Object.keys(operation)) if (key !== 'action' && !allowed.includes(key)) throw new Error(msg`batch ${operation.action} 不接受字段 ${key}`);
      if (operation.status !== undefined && operation.status !== 'pending') throw new Error(msg('batch 仅支持 create pending 和 update 定义'));
      if (operation.ref !== undefined && (!/^[A-Za-z][A-Za-z0-9_-]{0,31}$/.test(operation.ref) || refs.has(operation.ref))) throw new Error(msg`无效或重复 batch ref：${operation.ref}`);
      const { ref, ...input } = operation;
      const concrete: TodoParams = { ...input, ...(input.id === undefined ? {} : { id: resolve(input.id) }), ...Object.fromEntries(['blockedBy', 'addBlockedBy', 'removeBlockedBy'].filter((key) => input[key as keyof typeof input] !== undefined).map((key) => {
        const values = input[key as 'blockedBy' | 'addBlockedBy' | 'removeBlockedBy'];
        if (!Array.isArray(values)) throw new Error(msg('依赖需为有效任务编号'));
        return [key, values.map(resolve)];
      })) } as TodoParams;
      const result = applyTodo(draft, concrete, msg);
      const id = concrete.action === 'create' ? result.tasks![0]!.id : concrete.id!;
      if (ref !== undefined) refs.set(ref, id);
      touched.add(id); resolved.push(concrete); draft = result.state;
    } catch (cause) { throw new Error(msg`batch 第 ${index + 1} 项失败：${cause instanceof Error ? cause.message : String(cause)}`); }
  }
  // Reversible definition edits that return to the original values are a real no-op.
  const before = new Map(state.tasks.map((task) => [task.id, task]));
  const tasks = draft.tasks.map((task) => touched.has(task.id) && JSON.stringify(task) === JSON.stringify(before.get(task.id)) ? before.get(task.id)! : task);
  if (draft.nextId === state.nextId && tasks.every((task, index) => task === state.tasks[index])) draft = state;
  else if (tasks.some((task, index) => task !== draft.tasks[index])) draft = { ...draft, tasks };
  return { state: draft, tasks: draft.tasks.filter((task) => touched.has(task.id)), refs: Object.fromEntries(refs), operations: resolved, text: msg`已原子处理 ${operations.length} 个定义操作：${[...touched].map((id) => `#${id}`).join(', ')}${refs.size ? `\n${JSON.stringify(Object.fromEntries(refs))}` : ''}` };
}

/**
 * Only walk the active branch; never replay abandoned branches or model summaries.
 * A list left by rpiv-todo (same tool name, same result shape) is read only when this
 * plugin has no snapshot of its own on the branch, so an existing session keeps its tasks.
 */
/**
 * Pending tasks that were blocked before the change and are ready after it. Used for the
 * "prerequisites are done" hint; it never starts anything on its own.
 */
export function newlyReady(before: WorkflowState, after: WorkflowState): Todo[] {
  const was = new Map(before.tasks.map((task) => [task.id, task.status]));
  if (!after.tasks.some((task) => task.status === "completed" && was.get(task.id) !== "completed")) return [];
  const now = new Map(after.tasks.map((task) => [task.id, task.status]));
  return after.tasks.filter((task) => task.status === "pending" && task.blockedBy.length > 0 && task.blockedBy.every((id) => now.get(id) === "completed") && !task.blockedBy.every((id) => was.get(id) === "completed"));
}

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
      const message = entry.message as { role?: string; toolName?: string; details?: { version?: number; tasks?: unknown; nextId?: unknown } };
      const details = message.details;
      if (message.role === "toolResult" && message.toolName === "todo" && details && (details.version === undefined || details.version === 1) && Array.isArray(details.tasks) && Number.isSafeInteger(details.nextId)) rpiv = details;
    }
  }
  if (rpiv) {
    const data = structuredClone(rpiv) as { tasks: Todo[]; nextId: number };
    const state = { ...emptyState(), tasks: data.tasks.map((task) => ({ ...task, blockedBy: task.blockedBy ?? [] })), nextId: data.nextId };
    // Another plugin's data must never break session restore: keep it only when it validates.
    try { validateState(state, msg); return state; } catch { return emptyState(); }
  }
  return emptyState();
}
