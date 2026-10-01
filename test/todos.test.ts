import assert from "node:assert/strict";
import { test } from "node:test";
import { applyTodo, emptyState, restoreState, STATE_TYPE, todoRef, validateState, type TodoParams, type WorkflowState } from "../src/todos/state.ts";
import { planViolation } from "../src/plan/policy.ts";

const apply = (state: WorkflowState, params: TodoParams) => applyTodo(state, params).state;
const create = (state: WorkflowState, subject: string, blockedBy: number[] = []) => apply(state, { action: "create", subject, blockedBy });

test("one canonical list retains stable ids across delete and clear", () => {
  let state = create(emptyState(), "入口");
  state = create(state, "回归");
  state = apply(state, { action: "delete", id: 1 });
  assert.equal(state.tasks[0]!.status, "deleted");
  state = apply(state, { action: "clear" });
  state = create(state, "新工作");
  assert.equal(state.tasks[0]!.id, 3);
});

test("blockedBy only releases work after actual predecessor completion", () => {
  let state = create(emptyState(), "调查");
  state = create(state, "整合", [1]);
  const original = structuredClone(state);
  assert.throws(() => apply(state, { action: "update", id: 2, status: "in_progress" }), /前置未完成/);
  assert.throws(() => apply(state, { action: "update", id: 2, status: "completed" }), /前置未完成/);
  assert.deepEqual(state, original);
  state = apply(state, { action: "update", id: 1, status: "completed" });
  state = apply(state, { action: "update", id: 2, status: "in_progress", activeForm: "正在整合" });
  assert.equal(state.tasks[1]!.activeForm, "正在整合");
});

test("Plan creates and edits the same list but cannot begin or complete work", () => {
  let state = create({ ...emptyState(), plan: true }, "规划步骤");
  state = apply(state, { action: "update", id: 1, subject: "修订步骤" });
  assert.equal(state.tasks[0]!.subject, "修订步骤");
  for (const status of ["in_progress", "completed"] as const) assert.throws(() => apply(state, { action: "update", id: 1, status }), /Plan/);
  state = apply({ ...state, plan: false }, { action: "update", id: 1, status: "completed" });
  assert.equal(state.tasks[0]!.status, "completed");
});

test("dependency changes reject cycles, missing edges and deleting a referenced predecessor atomically", () => {
  const state = create(create(emptyState(), "A"), "B", [1]);
  const frozen = structuredClone(state);
  assert.throws(() => apply(state, { action: "update", id: 1, addBlockedBy: [2] }), /cycle/);
  assert.throws(() => create(state, "C", [99]), /missing/);
  assert.throws(() => apply(state, { action: "delete", id: 1 }), /deleted/);
  assert.deepEqual(state, frozen);
  const updated = apply(state, { action: "update", id: 2, removeBlockedBy: [1] });
  assert.equal(apply(updated, { action: "delete", id: 1 }).tasks[0]!.status, "deleted");
});

test("completed work cannot be silently reopened; metadata null removes keys", () => {
  let state = create(emptyState(), "完成的工作");
  state = apply(state, { action: "update", id: 1, status: "completed", metadata: { evidence: "通过", temp: 1 } });
  assert.throws(() => apply(state, { action: "update", id: 1, status: "pending" }), /返工/);
  state = apply(state, { action: "update", id: 1, metadata: { temp: null } });
  assert.deepEqual(state.tasks[0]!.metadata, { evidence: "通过" });
});

test("read operations and identical updates do not publish extra state", () => {
  const state = create(emptyState(), "任务");
  for (const params of [{ action: "list" }, { action: "get", id: 1 }, { action: "update", id: 1, subject: "任务" }] as TodoParams[]) assert.equal(applyTodo(state, params).state, state);
  assert.match(applyTodo(state, { action: "list" }).text, /#1/);
});

test("titles, instructions, empty updates and action-specific fields are validated", () => {
  const state = create(emptyState(), "A");
  assert.throws(() => create(state, " "), /subject/);
  assert.throws(() => create(state, "中".repeat(61)), /60/);
  assert.throws(() => apply(state, { action: "update", id: 1 }), /修改字段/);
  assert.throws(() => apply(state, { action: "update", id: 1, description: "x".repeat(8193) }), /8 KiB/);
  assert.throws(() => apply(state, { action: "create", subject: "B", status: "completed" }), /不接受/);
  assert.throws(() => apply(state, { action: "update", id: 1, blockedBy: [1] }), /不接受/);
});

test("list filters hide tombstones without changing canonical tasks", () => {
  let state = create(create(emptyState(), "A"), "B");
  state = apply(state, { action: "delete", id: 1 });
  assert.doesNotMatch(applyTodo(state, { action: "list" }).text, /#1/);
  assert.match(applyTodo(state, { action: "list", includeDeleted: true }).text, /#1/);
});

test("metadata cannot mutate caller-owned values or introduce object prototype state", () => {
  const metadata = JSON.parse('{"__proto__":{"bad":true},"value":{"nested":1}}');
  const state = apply(create(emptyState(), "A"), { action: "update", id: 1, metadata });
  metadata.value.nested = 2;
  assert.equal((state.tasks[0]!.metadata!.value as { nested: number }).nested, 1);
  assert.equal(({} as { bad?: boolean }).bad, undefined);
});

test("active branch replay restores a single latest native snapshot and does not rewrite history", () => {
  const first = create(emptyState(), "A");
  const second = create({ ...first, plan: true }, "B", [1]);
  const branch = [{ type: "custom", customType: STATE_TYPE, data: first }, { type: "custom", customType: STATE_TYPE, data: second }];
  assert.deepEqual(restoreState(branch), second);
  assert.deepEqual(restoreState(branch.slice(0, 1)), first);
  assert.deepEqual(restoreState([]), emptyState());
  const restored = restoreState(branch);
  restored.tasks[0]!.subject = "不同分支";
  assert.equal(second.tasks[0]!.subject, "A");
});

test("invalid or future snapshots are not silently replaced by empty work", () => {
  assert.throws(() => restoreState([{ type: "custom", customType: STATE_TYPE, data: { version: 99 } }]));
  assert.throws(() => validateState({ ...create(emptyState(), "A"), nextId: 1 }), /计数器/);
});

test("Plan guard allows explicit read/search/questions and task edits, not implementation", () => {
  const state = { ...emptyState(), plan: true, planTools: ["my_search"] };
  for (const tool of ["read", "grep", "find", "ls", "ask_user_question", "my_search"]) assert.equal(planViolation(state, tool, {}), undefined);
  assert.equal(planViolation(state, "todo", { action: "create", subject: "研究" }), undefined);
  assert.ok(planViolation(state, "todo", { action: "update", status: "completed" }));
  for (const tool of ["write", "edit", "bash", "powershell", "subagent_spawn", "unknown_search"]) assert.ok(planViolation(state, tool, {}));
  assert.equal(planViolation(emptyState(), "write", {}), undefined);
  assert.ok(planViolation({ ...state, planTools: ["write", "subagent_spawn"] }, "write", {}));
  assert.ok(planViolation({ ...state, planTools: ["write", "subagent_spawn"] }, "subagent_spawn", {}));
});

test("Todo reference carries every dependency at the left, with no duplicated edge text", () => {
  assert.equal(todoRef({ id: 4, subject: "整合", status: "pending", blockedBy: [2, 3] }), "#4<-#2,#3");
});
