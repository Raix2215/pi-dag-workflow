import { clean } from "../ui/render.ts";
import type { Todo, WorkflowState } from "./state.ts";

/** Job fields the checkpoint uses; structurally compatible with the main agent JobSummary. */
export interface CheckpointJob {
  id: string;
  todoId?: number;
  status: string;
  reportDelivery?: 'pending' | 'delivered';
  label?: string;
  taskReportStale?: boolean;
}

export interface CheckpointSummaryOptions {
  /** Emit a summary even for a brand-new, empty session. */
  forceEmpty?: boolean;
  /** The Todo state could not be read; never imply completion. */
  protectedState?: boolean;
}

const HEADING = "Workflow state checkpoint";
const MAX_UNFINISHED = 12;
const MAX_ACTIVE_JOBS = 8;
const MAX_LABEL = 32;
const ACTIVE_STATUSES = new Set(["starting", "running", "waiting"]);

const segmenter = typeof Intl.Segmenter === "function" ? new Intl.Segmenter(undefined, { granularity: "grapheme" }) : undefined;

/** Unicode-safe clip: at most `limit` graphemes, folding the final slot into an ellipsis when cut. */
function clipLabel(text: string, limit: number = MAX_LABEL): string {
  const value = clean(text);
  const parts = segmenter ? [...segmenter.segment(value)].map((part) => part.segment) : Array.from(value);
  if (parts.length <= limit) return value;
  return `${parts.slice(0, Math.max(0, limit - 1)).join("")}…`;
}

/** Fixed, model-readable closing rules. Never count time or live activity. */
function guidance(): string[] {
  return [
    "Notes: this checkpoint is a baseline snapshot; later tool results take precedence.",
    "A returned report is not an accepted Todo; call subagent_wait only when a report is missing.",
  ];
}

/**
 * Pure, deterministic checkpoint of the Todo DAG plus the Jobs that touch it. The summary is
 * display input for a model request: it names state and open work but never carries child output,
 * descriptions, profiles, models or tools, and identical inputs always produce identical text.
 */
export function checkpointSummary(state: WorkflowState, jobs: readonly CheckpointJob[], options: CheckpointSummaryOptions = {}): string | undefined {
  const lines: string[] = [HEADING];
  const activeJobs = jobs.filter((job) => ACTIVE_STATUSES.has(job.status));

  // Protected state is reported as unknown; no count, Job link, or completion is invented.
  if (options.protectedState) {
    lines.push("state unavailable: Todo state could not be read; no task is implied complete.");
    lines.push(...guidance());
    return lines.join("\n");
  }

  const all = state.tasks;
  const live = all.filter((task) => task.status !== "deleted");
  const unfinished = live.filter((task) => task.status !== "completed");
  const isNewSession = all.length === 0 && state.nextId === 1 && !state.plan && activeJobs.length === 0;
  if (isNewSession && !options.forceEmpty) return undefined;

  const statusById = new Map(all.map((task) => [task.id, task.status]));
  const unfinishedPrereqs = (task: Todo): number[] => task.blockedBy.filter((id) => statusById.get(id) !== "completed");
  const latestByTodo = new Map<number, CheckpointJob>();
  for (const job of jobs) if (job.todoId !== undefined) latestByTodo.set(job.todoId, job);
  const latestJob = (todoId: number): CheckpointJob | undefined => latestByTodo.get(todoId);
  /** A completed, non-stale report is the only thing that marks work as awaiting verification. */
  const returned = (job: CheckpointJob | undefined): boolean => job !== undefined && job.status === "completed" && job.taskReportStale !== true;
  const rank = (task: Todo): number => {
    if (task.status === "in_progress") return returned(latestJob(task.id)) ? 0 : 1;
    return unfinishedPrereqs(task).length === 0 ? 2 : 3;
  };

  const countBy = (status: Todo["status"]): number => live.filter((task) => task.status === status).length;
  const counts: string[] = [];
  const inProgress = countBy("in_progress");
  const pending = countBy("pending");
  const completed = countBy("completed");
  if (inProgress) counts.push(`${inProgress} in_progress`);
  if (pending) counts.push(`${pending} pending`);
  if (completed) counts.push(`${completed} completed`);
  const deleted = all.length - live.length;
  lines.push(counts.length ? `Todos: ${counts.join(", ")} (${live.length} total${deleted ? `, ${deleted} deleted` : ""})` : "Todos: none");
  if (state.plan) lines.push("Plan: on (read-only; tasks cannot start or complete).");

  const ordered = unfinished
    .map((task, index) => ({ task, index, rank: rank(task) }))
    .sort((left, right) => left.rank - right.rank || left.index - right.index)
    .map((entry) => entry.task);
  const shown = ordered.slice(0, MAX_UNFINISHED);

  const taskLine = (task: Todo): string => {
    const job = latestJob(task.id);
    const stateLabel = task.status === "in_progress"
      ? (returned(job) ? job?.reportDelivery === "delivered" ? "in_progress, report returned - verify" : "in_progress, execution ended - inspect report" : "in_progress")
      : unfinishedPrereqs(task).length ? "pending, blocked" : "pending, ready";
    let line = `- #${task.id} [${stateLabel}] ${clipLabel(task.subject)}`;
    if (typeof task.metadata?.preset === "string") {
      const run = typeof task.metadata.run === "number" && Number.isSafeInteger(task.metadata.run) && task.metadata.run > 0 ? ` run ${task.metadata.run}` : "";
      const step = typeof task.metadata.step === "number" && Number.isSafeInteger(task.metadata.step) && task.metadata.step > 0 ? ` step ${task.metadata.step}` : "";
      line += ` (fragment ${clipLabel(task.metadata.preset)}${run}${step})`;
    }
    const prereqs = unfinishedPrereqs(task);
    if (prereqs.length) line += ` (unfinished prerequisites: ${prereqs.map((id) => `#${id}`).join(", ")})`;
    if (job) {
      const delivery = job.reportDelivery ? `, report ${job.reportDelivery}` : "";
      const stale = job.taskReportStale ? " [historical output only]" : "";
      line += ` — latest job ${clean(job.id)}: ${clean(job.status)}${delivery}${stale}`;
    }
    return line;
  };

  if (ordered.length === 0) {
    lines.push("No unfinished Todos.");
  } else {
    lines.push(ordered.length > shown.length ? `Unfinished Todos (${shown.length} of ${ordered.length}):` : "Unfinished Todos:");
    for (const task of shown) lines.push(taskLine(task));
    if (ordered.length > shown.length) lines.push(`Hidden: ${ordered.length - shown.length} more unfinished Todos; use "todo list" or "todo get" for details.`);
  }

  if (activeJobs.length) {
    const listed = activeJobs.slice(0, MAX_ACTIVE_JOBS);
    lines.push(activeJobs.length > listed.length ? `Active Jobs (${listed.length} of ${activeJobs.length}):` : "Active Jobs:");
    for (const job of listed) {
      const label = job.label ? clipLabel(job.label) : "(no label)";
      // An active Job bound to an already completed Todo is still real work and stays visible.
      const boundStatus = job.todoId === undefined ? undefined : statusById.get(job.todoId);
      const bound = job.todoId === undefined ? "standalone" : `todo #${job.todoId}${boundStatus ? ` (${boundStatus})` : ""}`;
      lines.push(`- ${clean(job.id)} [${clean(job.status)}] ${label} — ${bound}`);
    }
    if (activeJobs.length > listed.length) lines.push(`Hidden: ${activeJobs.length - listed.length} more active Jobs; use subagent_inspect for details.`);
  }

  lines.push(...guidance());
  return lines.join("\n");
}
