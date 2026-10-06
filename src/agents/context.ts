import type { Todo } from "../todos/state.ts";

/** Minimal job view the context builder needs: the bound task and the report it produced. */
export interface JobRecordView { todoId?: number; status: string; output?: string; taskReportStale?: boolean; outputStart?: number }

const REPORT_HEAD = 200;
const MAX_CONTEXT = 2000;
/** Kept aside for the fragment list and report heads when the current step has long instructions. */
const REST_RESERVE = 600;
/** Worst case newline separators: intro, whole fragment, reports, instructions, closing. */
const SEPARATORS = 4;

/** Slice on UTF-16 units without leaving a lone surrogate at the cut. */
function cut(text: string, max: number): string {
  if (max <= 0) return "";
  if (text.length <= max) return text;
  const code = text.charCodeAt(max - 1);
  return text.slice(0, code >= 0xd800 && code <= 0xdbff ? max - 1 : max);
}

/**
 * Optional brief for a child that took one step of a task fragment. It answers the two questions
 * such a child otherwise has to rediscover: where it sits in the workflow, and what the earlier
 * and prerequisite steps already found. Only the same fragment instance contributes, so nothing
 * else about the session leaks; every report is truncated to its head.
 */
export function fragmentContext(taskId: number, tasks: readonly Todo[], jobs: readonly JobRecordView[]): string | undefined {
  const task = tasks.find((item) => item.id === taskId);
  const preset = task?.metadata?.preset;
  const run = task?.metadata?.run;
  if (!task || typeof preset !== "string" || typeof run !== "number") return undefined;
  const instance = tasks.filter((item) => item.metadata?.preset === preset && item.metadata.run === run && item.status !== "deleted");
  const byId = new Map(instance.map((item) => [item.id, item]));
  const position = typeof task.metadata?.step === "number" ? task.metadata.step : undefined;
  const key = (item: Todo): string => cut(String(item.metadata?.key ?? `#${item.id}`), 48);
  const label = (item: Todo): string => `${key(item)} "${cut(item.subject, 120)}"`;
  // completed/in_progress get short tags; every other state keeps its own name instead of reading as pending.
  const state = (item: Todo): string => item.status === "completed" ? "done" : item.status === "in_progress" ? "running" : item.status;
  const ordinal = (item: Todo): number => typeof item.metadata?.step === "number" ? item.metadata.step : item.id;

  // Real prerequisites: the transitive blockedBy closure, but only inside this fragment instance,
  // so a forward prerequisite (id above the current step) still counts and nothing crosses a run.
  const closure = new Set<number>();
  const pending = [...task.blockedBy];
  while (pending.length) {
    const id = pending.pop()!;
    if (closure.has(id)) continue;
    const dependency = byId.get(id);
    if (!dependency) continue;
    closure.add(id);
    pending.push(...dependency.blockedBy);
  }
  const mine = ordinal(task);
  const direct = new Set(task.blockedBy);
  const feeding = instance
    .filter((item) => item.id !== task.id && (ordinal(item) < mine || closure.has(item.id)))
    .sort((a, b) => Number(direct.has(b.id)) - Number(direct.has(a.id)) || Number(closure.has(b.id)) - Number(closure.has(a.id)) || ordinal(a) - ordinal(b) || a.id - b.id);

  // Only the current latest job may speak for a step. A stale or failed/cancelled latest is not
  // evidence and never falls back to an older attempt's output.
  const report = (item: Todo): string | undefined => {
    const job = jobs.findLast((record) => record.todoId === item.id);
    if (!job || job.taskReportStale || !['completed', 'running', 'waiting'].includes(job.status)) return undefined;
    const start = job.outputStart ?? 0;
    if (!Number.isSafeInteger(start) || start < 0 || start > (job.output?.length ?? 0)) return undefined;
    const flat = job.output?.slice(start).replace(/\s+/g, " ").trim();
    if (!flat) return undefined;
    return `- ${key(item)} (${state(item)}): ${cut(flat, REPORT_HEAD)}${flat.length > REPORT_HEAD ? "…" : ""}`;
  };

  const intro = cut(`Task fragment ${cut(preset, 48)} run ${run}${position === undefined ? "" : `, step ${position} of ${instance.length}`}: you took ${label(task)} (${state(task)}).`, 300);
  const whole = `Whole fragment: ${instance.map((item) => `${label(item)} [${state(item)}]`).join("; ")}.`;
  const instructions = task.description?.trim() ? `This step's instructions: ${task.description}` : undefined;
  const closing = "Steps that still depend on others stay for the parent to dispatch; finish what you can and report what is blocked.";

  // The current step's instructions outrank the fragment list and report heads: the other sections
  // are truncated against whatever budget is left after them.
  const budget = Math.max(0, MAX_CONTEXT - intro.length - closing.length - SEPARATORS);
  const instructionLine = instructions ? cut(instructions, Math.max(0, budget - REST_RESERVE)) : undefined;
  const left = budget - (instructionLine?.length ?? 0);
  const heads = feeding.map(report).filter((line): line is string => line !== undefined);
  const header = "Earlier and prerequisite steps of this fragment, report heads:";
  const shown: string[] = [];
  let remaining = Math.min(800, Math.max(0, left - Math.min(150, whole.length))) - header.length;
  for (const line of heads) {
    if (remaining < line.length + 1) break;
    shown.push(line); remaining -= line.length + 1;
  }
  const reports = shown.length ? `${header}\n${shown.join("\n")}` : '';
  const wholeBudget = left - reports.length;
  const wholeLine = whole.length <= wholeBudget ? whole : `${cut(whole, Math.max(0, wholeBudget - 1))}…`;
  const lines = [intro];
  if (wholeLine) lines.push(wholeLine);
  if (reports) lines.push(reports);
  if (instructionLine) lines.push(instructionLine);
  lines.push(closing);
  return cut(lines.join("\n"), MAX_CONTEXT);
}
