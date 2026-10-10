import assert from "node:assert/strict";
import { test } from "node:test";
import { checkpointSummary, type CheckpointJob, type CheckpointSummaryOptions } from "../src/todos/checkpoint-summary.ts";
import { emptyState, type Todo, type WorkflowState } from "../src/todos/state.ts";

const task = (id: number, subject: string, status: Todo["status"] = "pending", blockedBy: number[] = []): Todo => ({ id, subject, status, blockedBy });
const state = (tasks: Todo[], extra: Partial<WorkflowState> = {}): WorkflowState => ({ ...emptyState(), tasks, nextId: Math.max(0, ...tasks.map((item) => item.id)) + 1, ...extra });
const job = (id: string, patch: Partial<CheckpointJob> = {}): CheckpointJob => ({ id, status: "running", ...patch });
const render = (workflow: WorkflowState, jobs: readonly CheckpointJob[] = [], options: CheckpointSummaryOptions = {}): string => {
  const text = checkpointSummary(workflow, jobs, options);
  assert.ok(text, "expected a checkpoint summary");
  return text;
};
const lines = (text: string, prefix: string): string[] => text.split("\n").filter((line) => line.startsWith(prefix));
const todoLines = (text: string): string[] => lines(text, "- #");
const jobLines = (text: string): string[] => text.split("\n").filter((line) => line.startsWith("- ") && !line.startsWith("- #"));
const graphemes = (text: string): string[] => [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text)].map((part) => part.segment);

test("ranks returned verification, in_progress, ready and blocked Todos stably", () => {
  const workflow = state([
    task(1, "blocked work", "pending", [2]),
    task(2, "ready work"),
    task(3, "running work", "in_progress"),
    task(4, "returned work", "in_progress"),
    task(5, "another ready"),
  ]);
  const jobs = [
    job("job-3", { todoId: 3, status: "running" }),
    job("job-4", { todoId: 4, status: "completed", reportDelivery: "pending" }),
  ];
  const text = render(workflow, jobs);
  assert.equal(text.split("\n")[0], "Workflow state checkpoint");
  assert.deepEqual(todoLines(text).map((line) => line.slice(0, 4)), ["- #4", "- #3", "- #2", "- #5", "- #1"]);
  assert.match(todoLines(text)[0]!, /\[in_progress, execution ended - inspect report\] returned work/);
  assert.match(todoLines(text)[2]!, /\[pending, ready\] ready work/);
  assert.match(todoLines(text)[4]!, /\[pending, blocked\] blocked work \(unfinished prerequisites: #2\)/);
});

test("lists at most twelve unfinished Todos and points at the list tools", () => {
  const workflow = state(Array.from({ length: 15 }, (_, index) => task(index + 1, `work ${index + 1}`)));
  const text = render(workflow);
  assert.equal(todoLines(text).length, 12);
  assert.match(text, /Unfinished Todos \(12 of 15\):/);
  assert.match(text, /Hidden: 3 more unfinished Todos; use "todo list" or "todo get" for details\./);
});

test("counts live Todos only and says No unfinished Todos when only history remains", () => {
  const text = render(state([task(1, "done", "completed"), task(2, "gone", "deleted"), task(3, "later", "completed")]));
  assert.match(text, /Todos: 2 completed \(2 total, 1 deleted\)/);
  assert.match(text, /No unfinished Todos\./);
  assert.doesNotMatch(text, /Unfinished Todos:/);
});

test("clips titles and labels to 32 unicode characters without breaking a grapheme", () => {
  const subject = "👨‍👩‍👧".repeat(40) + "TAIL";
  const text = render(state([task(1, subject, "in_progress")]));
  const line = todoLines(text)[0]!;
  const title = line.slice(line.indexOf("] ") + 2).split(" — ")[0]!;
  assert.equal(graphemes(title).length, 32);
  assert.ok(title.endsWith("…"));
  assert.ok(!text.includes("TAIL"));
});

test("clips Job labels to 32 unicode characters", () => {
  const text = render(state([task(1, "work", "in_progress")]), [job("job-1", { todoId: 1, status: "running", label: "x".repeat(50) })]);
  const line = jobLines(text)[0]!;
  const shown = line.slice(line.indexOf("] ") + 2, line.indexOf(" — "));
  assert.equal(graphemes(shown).length, 32);
  assert.ok(shown.endsWith("…"));
});

test("shows only the single latest Job bound to a Todo", () => {
  const workflow = state([task(1, "work", "in_progress")]);
  const jobs = [
    job("job-old", { todoId: 1, status: "failed" }),
    job("job-new", { todoId: 1, status: "completed", reportDelivery: "delivered" }),
  ];
  const line = todoLines(render(workflow, jobs))[0]!;
  assert.match(line, /latest job job-new: completed, report delivered/);
  assert.doesNotMatch(line, /job-old/);
});

test("a delivered completed report calls for verification and never implies task acceptance", () => {
  const text = render(state([task(1, "work", "in_progress")]), [job("job-1", { todoId: 1, status: "completed", reportDelivery: "delivered" })]);
  assert.match(text, /\[in_progress, report returned - verify\]/);
  assert.doesNotMatch(text, /No unfinished Todos/);
});

test("marks a stale completed report as historical output only", () => {
  const workflow = state([task(1, "work", "in_progress")]);
  const jobs = [job("job-stale", { todoId: 1, status: "completed", reportDelivery: "delivered", taskReportStale: true })];
  const line = todoLines(render(workflow, jobs))[0]!;
  assert.match(line, /\[in_progress\] work/);
  assert.doesNotMatch(line, /verify/);
  assert.match(line, /latest job job-stale: completed, report delivered \[historical output only\]/);
});

test("lists active Jobs bound to completed Todos and standalone Jobs", () => {
  const workflow = state([task(1, "done", "completed")]);
  const jobs = [
    job("job-bound", { todoId: 1, status: "running", label: "verify build" }),
    job("job-free", { status: "waiting", label: "research" }),
    job("job-done", { todoId: 1, status: "completed", reportDelivery: "delivered" }),
  ];
  const text = render(workflow, jobs);
  assert.match(text, /No unfinished Todos\./);
  assert.match(text, /Active Jobs:/);
  assert.match(text, /- job-bound \[running\] verify build — todo #1 \(completed\)/);
  assert.match(text, /- job-free \[waiting\] research — standalone/);
  assert.doesNotMatch(text, /job-done/);
});

test("lists at most eight active Jobs", () => {
  const jobs = Array.from({ length: 11 }, (_, index) => job(`job-${index + 1}`, { status: "running", label: `w${index + 1}` }));
  const text = render(state([task(1, "work", "in_progress")]), jobs);
  assert.equal(jobLines(text).length, 8);
  assert.match(text, /Active Jobs \(8 of 11\):/);
  assert.match(text, /Hidden: 3 more active Jobs; use subagent_inspect for details\./);
});

test("returns undefined for a brand-new empty session unless forceEmpty is set", () => {
  assert.equal(checkpointSummary(emptyState(), []), undefined);
  const text = render(emptyState(), [], { forceEmpty: true });
  assert.equal(text.split("\n")[0], "Workflow state checkpoint");
  assert.match(text, /No unfinished Todos\./);
  assert.match(text, /use subagent_inspect output:true only when a report is missing/);
});

test("reports Plan mode and still returns a summary for an otherwise empty session", () => {
  const text = render({ ...emptyState(), plan: true });
  assert.match(text, /Plan: on \(read-only; tasks cannot start or complete\)\./);
  assert.match(text, /No unfinished Todos\./);
});

test("protected state is reported as unavailable and never implies completion", () => {
  const workflow = state([task(1, "secret task", "completed")]);
  const text = render(workflow, [job("job-run", { todoId: 1, status: "running" })], { protectedState: true });
  assert.match(text, /state unavailable/);
  assert.doesNotMatch(text, /completed/);
  assert.doesNotMatch(text, /secret task/);
  assert.doesNotMatch(text, /job-run/);
  assert.doesNotMatch(text, /Todos:/);
});

test("identical data yields an identical string with no time or activity state", () => {
  const build = () => ({
    workflow: state([task(1, "a", "in_progress"), task(2, "b", "pending", [1])]),
    jobs: [job("job-a", { todoId: 1, status: "running", label: "work" })],
  });
  const first = build();
  const second = build();
  const one = checkpointSummary(first.workflow, first.jobs);
  const two = checkpointSummary(second.workflow, second.jobs);
  assert.equal(one, two);
  assert.doesNotMatch(one!, /\b\d+s\b/);
});

test("ignores live activity and other non-summary Job fields", () => {
  const workflow = state([task(1, "work", "in_progress")]);
  const base = job("job-1", { todoId: 1, status: "running", label: "label" });
  const noisy = { ...base, activity: { kind: "tool", tool: "bash", since: 123 } } as unknown as CheckpointJob;
  assert.equal(checkpointSummary(workflow, [base]), checkpointSummary(workflow, [noisy]));
});

test("never copies descriptions, output, profiles, models or tools", () => {
  const workflow = state([{ ...task(1, "public title", "in_progress"), description: "SECRET-DESCRIPTION" }]);
  const rich = {
    id: "job-1", todoId: 1, status: "running", label: "public label",
    output: "SECRET-OUTPUT", profile: "SECRET-PROFILE", model: "SECRET-MODEL", tools: ["SECRET-TOOL"],
  } as unknown as CheckpointJob;
  const text = render(workflow, [rich]);
  assert.match(text, /public title/);
  assert.match(text, /public label/);
  for (const secret of ["SECRET-DESCRIPTION", "SECRET-OUTPUT", "SECRET-PROFILE", "SECRET-MODEL", "SECRET-TOOL"]) {
    assert.doesNotMatch(text, new RegExp(secret));
  }
});

test("strips terminal controls and bidi marks from titles and labels", () => {
  const workflow = state([task(1, "bad\u001b[31m title\u202e", "in_progress")]);
  const text = render(workflow, [job("job-1", { todoId: 1, status: "running", label: "lab\u009b31mel\u200f" })]);
  for (const control of ["\u001b", "\u202e", "\u200f", "\u009b"]) assert.ok(!text.includes(control), `unexpected ${JSON.stringify(control)}`);
});
