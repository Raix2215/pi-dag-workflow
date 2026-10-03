import assert from "node:assert/strict";
import { test } from "node:test";
import { fragmentContext } from "../src/agents/context.ts";
import { takeChildContext } from "../src/agents/child.ts";
import { claimedBy } from "../src/agents/register.ts";
import type { Todo } from "../src/todos/state.ts";

const step = (id: number, key: string, subject: string, status: Todo["status"], position: number, run = 1): Todo => ({ id, subject, status, blockedBy: [], metadata: { preset: "browser-check", run, key, step: position } });

test("a fragment brief names the step, lists the whole fragment and heads of earlier reports", () => {
  const tasks = [
    step(1, "bridge", "确认桥接在线", "completed", 1),
    step(2, "open", "打开页面", "in_progress", 2),
    step(3, "report", "报告截图", "pending", 3),
    { id: 9, subject: "无关任务", status: "completed" as const, blockedBy: [] },
  ];
  const brief = fragmentContext(2, tasks, [{ todoId: 1, status: "completed", output: "  connected: true\n标签页 8 个  " + "长".repeat(260) }])!;
  assert.match(brief, /Task fragment browser-check run 1, step 2 of 3: you took open "打开页面" \(running\)\./);
  assert.match(brief, /Whole fragment: bridge "确认桥接在线" \[done\]; open "打开页面" \[running\]; report "报告截图" \[pending\]\./);
  assert.match(brief, /Earlier steps of this fragment, report heads:\n- bridge \(done\): connected: true 标签页 8 个 长/);
  assert.match(brief, /…/);
  assert.match(brief, /Steps that still depend on others stay for the parent to dispatch/);
  assert.equal(brief.length <= 2000, true);
  // Only a fragment task gets a brief, another instance never leaks in, and unrelated tasks never appear.
  assert.equal(fragmentContext(9, tasks, []), undefined);
  assert.equal(fragmentContext(4, tasks, []), undefined);
  assert.doesNotMatch(fragmentContext(1, tasks, [])!, /无关任务/);
});

test("a later run only briefs its own instance and keeps step numbering per run", () => {
  const tasks = [step(1, "bridge", "第一轮", "completed", 1, 1), step(4, "bridge", "第二轮", "in_progress", 1, 2), step(5, "open", "第二轮第二步", "pending", 2, 2)];
  const brief = fragmentContext(4, tasks, [])!;
  assert.match(brief, /run 2, step 1 of 2/);
  assert.match(brief, /第二轮/);
  assert.doesNotMatch(brief, /第一轮/);
});

test("a redispatched prerequisite contributes its latest report instead of a failed attempt", () => {
  const tasks = [step(1, "first", "First", "completed", 1), step(2, "second", "Second", "pending", 2)];
  const brief = fragmentContext(2, tasks, [
    { todoId: 1, status: "failed", output: "obsolete partial output" },
    { todoId: 1, status: "completed", output: "verified replacement result" },
  ])!;
  assert.match(brief, /verified replacement result/);
  assert.doesNotMatch(brief, /obsolete partial/);
});

test("the child reads the brief once and removes it from its environment", () => {
  const env: NodeJS.ProcessEnv = { PI_DAG_AGENT_CONTEXT: "Fragment brief" };
  assert.equal(takeChildContext(env), "Fragment brief");
  assert.equal("PI_DAG_AGENT_CONTEXT" in env, false);
  assert.equal(takeChildContext({}), undefined);
  assert.equal(takeChildContext({ PI_DAG_AGENT_CONTEXT: "  " }), undefined);
});

test("a child that already reported no longer blocks completing its task", () => {
  const job = { id: "a1", todoId: 5 };
  const none = new Set<string>();
  assert.equal(claimedBy(job, { action: "update", id: 5, status: "completed" }, { adjusted: none, reported: true }), false);
  assert.equal(claimedBy(job, { action: "update", id: 5, status: "completed" }, { adjusted: none, reported: false }), true);
  // Every other change still waits for the child: reopening, editing, deleting, clearing.
  assert.equal(claimedBy(job, { action: "update", id: 5, status: "pending" }, { adjusted: none, reported: true }), true);
  assert.equal(claimedBy(job, { action: "update", id: 5, subject: "改名" }, { adjusted: none, reported: true }), true);
  assert.equal(claimedBy(job, { action: "update", id: 5, status: "completed", subject: "改名" }, { adjusted: none, reported: true }), true, 'completion cannot smuggle a content edit past the guard');
  assert.equal(claimedBy(job, { action: "update", id: 5, status: "completed", addBlockedBy: [3] }, { adjusted: none, reported: true }), true);
  assert.equal(claimedBy(job, { action: "update", id: 5, subject: "改名" }, { adjusted: new Set(["a1"]), reported: false }), false);
  assert.equal(claimedBy(job, { action: "delete", id: 5 }, { adjusted: none, reported: true }), true);
  assert.equal(claimedBy(job, { action: "clear" }, { adjusted: none, reported: true }), true);
  // Read-only actions never reach this guard, but the predicate stays conservative if they do.
  assert.equal(claimedBy(job, { action: "list" }, { adjusted: none, reported: false }), true);
});
