import assert from "node:assert/strict";
import { test } from "node:test";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { emptyState, type Todo } from "../src/todos/state.ts";
import { createTranslator, type Translator } from "../src/shared/i18n.ts";
import { renderTasks, type AgentView } from "../src/ui/render.ts";

const task = (id: number, subject = "实现解析器"): Todo => ({ id, subject, status: "pending", blockedBy: [] });
const base = { ...emptyState(), tasks: [task(1)], nextId: 2 };
const free = (id: string, status: AgentView["status"] = "running", extra: Partial<AgentView> = {}): AgentView => ({ id, profile: "fast", status, label: "调研现有实现", ...extra });
const lines = (jobs: readonly AgentView[], width = 80, state = base, translate: Translator | undefined = undefined, maxRows = Infinity) => renderTasks(state, width, { jobs, maxRows, ...(translate ? { msg: translate } : {}) }).map(stripTerminalSequences).join("\n");

test("a job spawned without a Todo gets its own section below the list", () => {
  const rendered = lines([free("a1")]);
  assert.match(rendered, /● \uf0c0 Standalone Subagents · 1/);
  assert.match(rendered, /[├└]─ a1 · fast .*调研现有实现/);
  assert.match(rendered, /\[󰥔 运行中\]/);
});

test("the root mark follows the Todo rule: solid while unfinished work remains", () => {
  assert.match(lines([free("a1")]), /● \uf0c0/);
  assert.match(lines([free("a1", "waiting")]), /● \uf0c0/);
  assert.match(lines([free("a1", "completed", { reportDelivery: "pending" })]), /● \uf0c0/);
  // Only settled jobs are left, so the block reads as closed.
  assert.match(lines([free("a1", "failed")]), /○ \uf0c0/);
  assert.match(lines([free("a1", "cancelled"), free("a2", "interrupted")]), /○ \uf0c0/);
});

test("the section stays away when no unbound job needs attention", () => {
  const bound: AgentView = { id: "a1", todoId: 1, profile: "fast", status: "running", label: "绑定任务" };
  assert.doesNotMatch(lines([]), /Standalone/);
  assert.doesNotMatch(lines([bound]), /Standalone/);
  // A report that already reached the main context no longer explains anything.
  assert.doesNotMatch(lines([free("a1", "completed", { reportDelivery: "delivered" })]), /Standalone/);
});

test("delivered reports stay out while pending handoff, failures and interruptions remain", () => {
  const rendered = lines([
    free("a1", "completed", { reportDelivery: "pending" }),
    free("a2", "failed"),
    free("a3", "interrupted"),
    free("a4", "cancelled"),
    free("a5", "completed", { reportDelivery: "delivered" }),
  ]);
  assert.match(rendered, /● \uf0c0 Standalone Subagents · 4/);
  assert.match(rendered, /\[󰥔 待交付\]/);
  assert.match(rendered, /\[󰅙 失败\]/);
  assert.match(rendered, /\[󰙦 已中断\]/);
  assert.match(rendered, /\[󰓛 已取消\]/);
  assert.doesNotMatch(rendered, /a5/);
});

test("live work is listed before closed jobs and the section is bounded", () => {
  const jobs = [free("a1", "failed"), free("a2"), free("a3"), free("a4"), free("a5"), free("a6", "completed", { reportDelivery: "pending" })];
  // The widget preview bounds the section at four rows; the complete view carries every job.
  const rendered = lines(jobs, 80, base, undefined, 8);
  const positions = ["a2", "a3", "a4", "a5"].map((id) => rendered.indexOf(`─ ${id} `));
  assert.ok(positions.every((index) => index >= 0), `live work fills the section first: ${rendered}`);
  assert.deepEqual(positions, [...positions].sort((left, right) => left - right));
  assert.match(rendered, /● \uf0c0 Standalone Subagents · 6/);
  assert.match(rendered, /└─ … 隐藏 2 项/);
  // The clipped jobs are the closed one and the waiting handoff, never live work.
  assert.doesNotMatch(rendered, /a1 · fast/);
  assert.doesNotMatch(rendered, /a6 · fast/);
  const complete = lines(jobs);
  assert.doesNotMatch(complete, /隐藏/);
  assert.match(complete, /a1 · fast/);
  assert.match(complete, /a6 · fast/);
});

test("an unbound job alone still renders the panel when the task list is empty", () => {
  const rendered = lines([free("a1")], 80, { ...emptyState() });
  assert.match(rendered, /● \uf0c0 Standalone Subagents · 1/);
  assert.doesNotMatch(rendered, /Todo/);
});

test("narrow terminals keep the job and its state and drop the excerpt first", () => {
  const jobs = [free("a1", "running", { activity: { kind: "tool", tool: "list_repository_files", since: Date.now() - 3000 } })];
  const narrow = lines(jobs, 34);
  assert.match(narrow, /a1/);
  assert.match(narrow, /󰆍/);
  assert.doesNotMatch(narrow, /调研现有实现/);
  assert.ok(renderTasks(base, 34, { jobs, maxRows: Infinity }).every((line) => visibleWidth(stripTerminalSequences(line)) <= 34));
});

test("a very narrow terminal keeps the count with the compact title", () => {
  const rendered = lines([free("a1")], 24);
  assert.match(rendered, /● \uf0c0 Standalone · 1/);
  assert.doesNotMatch(rendered, /Standalone Subagents/);
});

test("the section follows the English locale", () => {
  const rendered = lines([free("a1")], 80, base, createTranslator("en"));
  assert.match(rendered, /● \uf0c0 Standalone Subagents · 1/);
  assert.match(rendered, /\[󰥔 Running\]/);
});
