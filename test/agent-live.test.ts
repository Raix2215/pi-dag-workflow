import assert from "node:assert/strict";
import { test } from "node:test";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { emptyState, type Todo } from "../src/todos.ts";
import { renderTasks, type AgentView } from "../src/view.ts";

const task = (id: number, subject = "实现解析器"): Todo => ({ id, subject, status: "in_progress", blockedBy: [] });
const base = { ...emptyState(), tasks: [task(1)], nextId: 2 };
const job = (activity?: AgentView["activity"], status: AgentView["status"] = "running"): AgentView => ({ id: "a1", todoId: 1, profile: "coding", status, ...(activity ? { activity } : {}) });
const lines = (jobs: readonly AgentView[], width = 80) => renderTasks(base, width, { jobs, maxRows: Infinity }).map(stripTerminalSequences).join("\n");

test("live activity replaces the coarse running label with the child's real current action", () => {
  assert.match(lines([job({ kind: "thinking", since: Date.now() - 4000 })]), /󰧑 思考中/);
  assert.match(lines([job({ kind: "output", since: Date.now() })]), /󰏫 输出中/);
  assert.match(lines([job({ kind: "tool", tool: "bash", since: Date.now() - 3000 })]), /󰆍 bash 3s/);
  assert.doesNotMatch(lines([job({ kind: "tool", tool: "bash", since: Date.now() - 3000 })]), /运行中/);
});

test("tool names are shortened and capped at ten columns with bounded seconds", () => {
  assert.match(lines([job({ kind: "tool", tool: "mcp__github__list_repository_files", since: Date.now() - 200000 })]), /󰆍 list_repo… 99s/);
  assert.match(lines([job({ kind: "tool", tool: "read", since: Date.now() - 500 })]), /󰆍 read/);
});

test("stable statuses never show live activity and restore never fakes one", () => {
  assert.match(lines([job(undefined, "completed")]), /󰄬 已返回/);
  assert.match(lines([job(undefined, "waiting")]), /󰋗 等待回复/);
  assert.match(lines([job(undefined, "interrupted")]), /󰙦 已中断/);
  assert.match(lines([job(undefined, "failed")]), /󰅙 失败/);
  assert.match(lines([job(undefined, "cancelled")]), /󰓛 已取消/);
  assert.match(lines([job(undefined, "starting")]), /󰓦 启动中/);
  assert.match(lines([job({ kind: "thinking" }, "waiting")]), /󰋗 等待回复/);
  assert.doesNotMatch(lines([job({ kind: "thinking" }, "waiting")]), /思考/);
});

test("narrow widths drop the tool detail before the owner column", () => {
  const wide = lines([job({ kind: "tool", tool: "list_repository_files", since: Date.now() - 3000 })], 60);
  assert.match(wide, /a1 · coding/);
  const narrow = lines([job({ kind: "tool", tool: "list_repository_files", since: Date.now() - 3000 })], 34);
  assert.match(narrow, /\[a1 · coding\] \[󰆍\]/);
  assert.doesNotMatch(narrow, /3s|list_repository|已返回/);
  assert.match(narrow, /#1/);
});
