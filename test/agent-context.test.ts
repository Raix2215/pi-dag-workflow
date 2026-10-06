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
  assert.match(brief, /Earlier and prerequisite steps of this fragment, report heads:\n- bridge \(done\): connected: true 标签页 8 个 长/);
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

test("failed and cancelled steps read as themselves, never as pending", () => {
  const tasks = [
    step(1, "a", "甲", "failed", 1),
    step(2, "b", "乙", "cancelled", 2),
    step(3, "c", "丙", "in_progress", 3),
    step(4, "d", "丁", "pending", 4),
  ];
  const brief = fragmentContext(3, tasks, [])!;
  assert.match(brief, /Whole fragment: a "甲" \[failed\]; b "乙" \[cancelled\]; c "丙" \[running\]; d "丁" \[pending\]\./);
  assert.match(brief, /you took c "丙" \(running\)\./);
});

test("a stale or failed latest report is never replaced by an older one", () => {
  const tasks = [step(1, "first", "First", "completed", 1), step(2, "second", "Second", "pending", 2)];
  const stale = fragmentContext(2, tasks, [
    { todoId: 1, status: "completed", output: "ancient verified result" },
    { todoId: 1, status: "completed", output: "reopened attempt kept around", taskReportStale: true },
  ])!;
  assert.doesNotMatch(stale, /ancient verified result|reopened attempt kept around/);
  assert.doesNotMatch(stale, /report heads/);
  const failed = fragmentContext(2, tasks, [
    { todoId: 1, status: "completed", output: "old good result" },
    { todoId: 1, status: "failed", output: "second attempt failed" },
  ])!;
  assert.doesNotMatch(failed, /old good result|second attempt failed/);
  assert.doesNotMatch(failed, /report heads/);
});

test("a forward prerequisite above the current id still contributes its result", () => {
  const tasks: Todo[] = [
    { id: 2, subject: "检查", status: "in_progress", blockedBy: [5], metadata: { preset: "browser-check", run: 1, key: "check", step: 1 } },
    { id: 5, subject: "上游", status: "completed", blockedBy: [], metadata: { preset: "browser-check", run: 1, key: "upstream", step: 2 } },
  ];
  const brief = fragmentContext(2, tasks, [{ todoId: 5, status: "completed", output: "upstream evidence" }])!;
  assert.match(brief, /- upstream \(done\): upstream evidence/);
});

test("a prerequisite outside this run is never pulled in from another instance", () => {
  const tasks: Todo[] = [
    { id: 1, subject: "旧轮", status: "completed", blockedBy: [], metadata: { preset: "browser-check", run: 1, key: "old", step: 1 } },
    { id: 6, subject: "本轮", status: "in_progress", blockedBy: [1], metadata: { preset: "browser-check", run: 2, key: "now", step: 1 } },
  ];
  const brief = fragmentContext(6, tasks, [{ todoId: 1, status: "completed", output: "from another run" }])!;
  assert.doesNotMatch(brief, /from another run|旧轮/);
});

test("long fragment titles cannot crowd out the current step's instructions", () => {
  const title = "很长的标题".repeat(20);
  const tasks: Todo[] = [];
  for (let id = 1; id <= 12; id++) tasks.push(step(id, `k${id}`, title, "pending", id));
  const instructions = "按顺序完成本步骤的详细指示：" + "细节".repeat(200);
  tasks[5] = { ...tasks[5]!, description: instructions };
  const brief = fragmentContext(6, tasks, [])!;
  assert.equal(brief.length <= 2000, true);
  assert.match(brief, /This step's instructions: 按顺序完成本步骤的详细指示/);
  const at = brief.indexOf("This step's instructions: ");
  assert.equal(brief.slice(at).length > 400, true);
});

test('redirected report heads use the current output offset, not retained historical output', () => {
  const tasks = [step(1, 'first', 'First', 'completed', 1), step(2, 'second', 'Second', 'pending', 2)];
  const history = 'old assignment failed\n';
  const brief = fragmentContext(2, tasks, [{ todoId: 1, status: 'completed', output: `${history}verified new evidence`, outputStart: history.length }])!;
  assert.match(brief, /verified new evidence/); assert.doesNotMatch(brief, /old assignment failed/);
  assert.doesNotMatch(fragmentContext(2, tasks, [{ todoId: 1, status: 'interrupted', output: 'unfinished old work' }])!, /unfinished old work/);
});

test('maximum-length current titles and fragment lists retain both instructions and prerequisite evidence', () => {
  const tasks = Array.from({ length: 32 }, (_, i) => step(i + 1, `k${i}`, '长'.repeat(8000), 'completed', i + 1));
  tasks[31] = { ...tasks[31]!, status: 'in_progress', blockedBy: [1], description: 'CRITICAL-CURRENT-INSTRUCTION ' + '细节'.repeat(1000) };
  const brief = fragmentContext(32, tasks, [{ todoId: 1, status: 'completed', output: 'VERIFIED-PREREQUISITE ' + '𐐀'.repeat(200) }])!;
  assert.match(brief, /CRITICAL-CURRENT-INSTRUCTION/); assert.match(brief, /VERIFIED-PREREQUISITE/); assert.ok(brief.length <= 2000);
  assert.doesNotMatch(brief, /[\uD800-\uDFFF]/u, 'no lone surrogate survives truncation');
});

test('a tight report budget never skips a direct prerequisite to include a lower-priority short report', () => {
  const tasks = [step(1, 'earlier', 'earlier', 'completed', 1), step(2, 'directA', 'direct A', 'completed', 2), step(3, 'directB', 'direct B', 'completed', 3), { ...step(4, 'current', 'current', 'in_progress', 4), blockedBy: [2, 3], description: 'instructions '.repeat(400) }];
  const brief = fragmentContext(4, tasks, [{ todoId: 1, status: 'completed', output: 'LOW-PRIORITY' }, { todoId: 2, status: 'completed', output: 'DIRECT-A ' + 'a'.repeat(250) }, { todoId: 3, status: 'completed', output: 'DIRECT-B ' + 'b'.repeat(250) }])!;
  assert.match(brief, /DIRECT-A/); assert.doesNotMatch(brief, /LOW-PRIORITY/);
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
