import type { TodoParams, TodoBatchOperation } from '../../shared/task-schema.ts';
import { TODO_FILTERS, type TodoStatus, type ClearScope, type Todo, type WorkflowState } from "../../shared/task-types.ts";
import { translatedTaskStatusLabels as translatedStatusLabel, WORKFLOW_STATE_TYPE } from '../../shared/state-types.ts';
import { dagStructure, reuseDagStructure } from "../../shared/dag/cache.ts";
import { newRedundantEdges } from "../../shared/dag/graph.ts";
import { chinese, type Translator } from "../../shared/i18n.ts";
import { expand, nextRun, resetClosure, type Preset, type PresetStore } from "./presets.ts";
import { planTaskCleanup } from './cleanup.ts';

export const STATE_TYPE = WORKFLOW_STATE_TYPE;
interface TodoPage { total: number; count: number; limit: number; afterId: number; nextAfterId?: number; next?: TodoParams }
interface TodoRelations { blocks: number[]; unmetPrerequisites: number[] }
/** One bounded read-only answer: current mode plus per-status counts. Deleted is listed separately. */
interface TodoStatusSummary { mode: 'normal' | 'plan'; total: number; counts: Record<Exclude<TodoStatus, 'deleted'>, number>; deleted: number }
export interface TodoResult { state: WorkflowState; text: string; tasks?: Todo[]; page?: TodoPage; relations?: TodoRelations; removedIds?: number[]; refs?: Record<string, number>; operations?: TodoParams[]; presets?: { name: string; description?: string; steps: number }[]; preset?: Preset; status?: TodoStatusSummary }
export const emptyState = (): WorkflowState => ({ version: 1, tasks: [], nextId: 1, plan: false, planTools: [], visible: true, view: "list", treeStyle: "paths" });

const fields: Record<string, readonly string[]> = {
  create: ["subject", "description", "activeForm", "owner", "metadata", "blockedBy", "status"],
  update: ["id", "subject", "description", "activeForm", "owner", "metadata", "status", "addBlockedBy", "removeBlockedBy"],
  list: ["status", "includeDeleted", "limit", "afterId", "ready"], get: ["id"], delete: ["id"], clear: ['scope'],
  apply: ["preset", "vars"], reset: ["preset", "run", "step"], presets: ["preset"], status: [],
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
export const statusLabel: Record<TodoStatus, string> = translatedStatusLabel(chinese);
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

/** The scope as the user named it; the enum key never reaches a message. */
const scopeText = (scope: ClearScope, msg: Translator): string => scope === 'completed' ? msg('已完成记录') : scope === 'closed' ? msg('已完成／失败／取消记录') : msg('全部可清理记录');

/** Pure task cleanup. The runtime coordinator supplies job protections/outcomes and prunes jobs. */
export function clearTodoRecords(state: WorkflowState, scope: ClearScope = 'all', protectedIds: ReadonlySet<number> = new Set(), outcomes?: ReadonlyMap<number, string>, msg: Translator = chinese) {
  const result = planTaskCleanup(state.tasks, scope, protectedIds, outcomes);
  if (!result.removedIds.length) return { state, text: msg`没有可清理任务；保留 ${result.keptIds.length} 项（运行／待核验／依赖必需）`, ...result };
  const next = { ...state, tasks: result.tasks };
  validateState(next, msg);
  return { state: next, text: msg`已清理 ${result.removedIds.length} 项（${scopeText(scope, msg)}）；保留 ${result.keptIds.length} 项，编号不复用`, ...result };
}

/** Read-only summary from the canonical list; it never adds persisted state or renumbers tasks. */
function todoStatusSummary(state: WorkflowState): TodoStatusSummary {
  const counts: Record<Exclude<TodoStatus, 'deleted'>, number> = { pending: 0, in_progress: 0, completed: 0, failed: 0, cancelled: 0 };
  let deleted = 0;
  for (const task of state.tasks) if (task.status === 'deleted') deleted++; else counts[task.status]++;
  return { mode: state.plan ? 'plan' : 'normal', total: state.tasks.length - deleted, counts, deleted };
}

export function validateTodoFields(params: TodoParams, msg: Translator = chinese): void {
  const allowed = fields[params.action];
  if (!allowed) throw new Error(msg("未知 Task 操作"));
  for (const key of Object.keys(params)) if (key !== "action" && !allowed.includes(key)) throw new Error(msg`${params.action} 不接受字段 ${key}`);
}

/** A definition change must not add an edge that an unfinished path already implies. */
function guardRedundancy(before: WorkflowState, after: WorkflowState, msg: Translator = chinese): void {
  if (before.tasks === after.tasks) return;
  const redundant = newRedundantEdges(before.tasks, after.tasks);
  if (!redundant.length) return;
  const shown = redundant.slice(0, 3).map((edge) => `#${edge.to}<-#${edge.from}（已有 #${[edge.from, ...edge.via, edge.to].join(' -> #')}）`).join('；');
  throw new Error(msg`冗余依赖：${shown}；blockedBy 只放不可缺少的前置产物（排期、同文件、祖先履历不算），本次写入已拒绝`);
}

/** Atomic pure mutation: errors never modify the current state. */
export function applyTodo(state: WorkflowState, params: TodoParams, msg: Translator = chinese, presets?: PresetStore): TodoResult {
  validateTodoFields(params, msg);
  // Batch judges the whole final definition once: an intermediate triangle is not a write.
  if (params.action === 'batch') return applyBatch(state, params.operations, msg);
  const result = applyDefinition(state, params, msg, presets);
  guardRedundancy(state, result.state, msg);
  return result;
}

function applyDefinition(state: WorkflowState, params: TodoParams, msg: Translator = chinese, presets?: PresetStore): TodoResult {
  if (params.action === 'status') { const status = todoStatusSummary(state); return { state, status, text: JSON.stringify(status, null, 2) }; }
  if (params.action === 'presets') {
    // Read-only discovery: compact directory summaries, or one full definition.
    if (params.preset !== undefined) {
      const preset = presets?.get(params.preset);
      if (!preset) throw new Error(msg`未找到片段 ${params.preset}`);
      return { state, preset, text: JSON.stringify(preset, null, 2) };
    }
    const directory = presets?.list().map((item) => ({ name: item.name, ...(item.description ? { description: item.description } : {}), steps: item.steps.length })) ?? [];
    return { state, presets: directory, text: directory.length ? JSON.stringify(directory, null, 2) : msg('未配置 Task 片段：在 ~/.pi/agent/pi-dag-workflow/pi-dag-workflow-preset.json 里定义') };
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
    const text = tasks.length ? `${header}\n${tasks.map((task) => `${todoRef(task)} [${translatedStatusLabel(msg)[task.status]}] ${task.subject}`).join("\n")}` : `${header}\n${msg('暂无任务')}`;
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
    const order = dagStructure(tasks).order;
    const unfinished = task.blockedBy.filter((id) => tasks[order.get(id)!]?.status !== "completed");
    // A prerequisite that no longer exists can never complete: name the fix instead of listing it as pending.
    const gone = unfinished.filter((id) => { const value = tasks[order.get(id)!]; return !value || value.status === "deleted"; });
    if (gone.length) throw new Error(msg`前置任务已删除或不存在：${gone.map((id) => `#${id}`).join(",")}；这条依赖无法满足，用 removeBlockedBy 去掉它，或重建 #${task.id}`);
    if (unfinished.length) throw new Error(msg`前置未完成：${unfinished.map((id) => `#${id}`).join(",")}；不能开始或完成 #${task.id}`);
  }
  if (JSON.stringify(task) === JSON.stringify(current)) return { state, tasks: [current!], text: msg`#${task.id} 无变化` };
  return { state: next, tasks: [task], text: msg`${params.action === "create" ? msg("已创建") : msg("已更新")} #${task.id}：${task.subject} [${translatedStatusLabel(msg)[task.status]}]` };
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
      const result = applyDefinition(draft, concrete, msg);
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
  guardRedundancy(state, draft, msg);
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
  if (before.tasks === after.tasks) return [];
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
