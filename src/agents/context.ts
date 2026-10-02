import type { Todo } from "../todos/state.ts";

/** Minimal job view the context builder needs: the bound task and the report it produced. */
export interface JobRecordView { todoId?: number; status: string; output?: string }

const REPORT_HEAD = 200;
const MAX_CONTEXT = 2000;

/**
 * Optional brief for a child that took one step of a task fragment. It answers the two questions
 * such a child otherwise has to rediscover: where it sits in the workflow, and what the earlier
 * steps already found. Only the same fragment instance contributes, so nothing else about the
 * session leaks; every report is truncated to its head.
 */
export function fragmentContext(taskId: number, tasks: readonly Todo[], jobs: readonly JobRecordView[]): string | undefined {
  const task = tasks.find((item) => item.id === taskId);
  const preset = task?.metadata?.preset;
  const run = task?.metadata?.run;
  if (!task || typeof preset !== "string" || typeof run !== "number") return undefined;
  const instance = tasks.filter((item) => item.metadata?.preset === preset && item.metadata.run === run && item.status !== "deleted");
  const position = typeof task.metadata?.step === "number" ? task.metadata.step : undefined;
  const label = (item: Todo): string => `${item.metadata?.key ?? `#${item.id}`} "${item.subject}"`;
  const state = (item: Todo): string => item.status === "completed" ? "done" : item.status === "in_progress" ? "running" : "pending";
  const lines = [
    `Task fragment ${preset} run ${run}${position === undefined ? "" : `, step ${position} of ${instance.length}`}: you took ${label(task)} (${state(task)}).`,
    `Whole fragment: ${instance.map((item) => `${label(item)} [${state(item)}]`).join("; ")}.`,
  ];
  const earlier = instance.filter((item) => item.id < task.id);
  const reports = earlier.flatMap((item) => {
    const job = jobs.find((record) => record.todoId === item.id);
    const head = job?.output?.replace(/\s+/g, " ").trim().slice(0, REPORT_HEAD);
    return head ? [`- ${item.metadata?.key ?? `#${item.id}`} (${state(item)}): ${head}${(job?.output?.length ?? 0) > REPORT_HEAD ? "…" : ""}`] : [];
  });
  if (reports.length) lines.push(`Earlier steps of this fragment, report heads:\n${reports.join("\n")}`);
  if (task.description) lines.push(`This step's instructions: ${task.description}`);
  lines.push("Steps that still depend on others stay for the parent to dispatch; finish what you can and report what is blocked.");
  return lines.join("\n").slice(0, MAX_CONTEXT);
}
