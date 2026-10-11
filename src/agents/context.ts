import type { Todo } from "../todos/state.ts";

/** Minimal job view the context builder needs: the bound task and the report it produced. */
export interface JobRecordView { id?: string; todoId?: number; status: string; output?: string; taskReportStale?: boolean; outputStart?: number }

const REPORT_HEAD = 200;
const MAX_CONTEXT = 2000;
/** Kept aside for the fragment list and report heads when the current step has long instructions. */
const REST_RESERVE = 600;
/** Worst case newline separators: intro, whole fragment, reports, instructions, closing. */
const SEPARATORS = 4;

/** Explicit path references are data to verify, not completion evidence or permissions. */
export function contextArtifacts(task: Todo): string[] {
  const values = task.metadata?.artifacts;
  if (!Array.isArray(values)) return [];
  return [...new Set(values.filter((value): value is string => typeof value === 'string' && Boolean(value.trim()) && value.length <= 512 && !/[\p{Cc}\p{Bidi_Control}]/u.test(value)).map((value) => value.trim()))].slice(0, 8);
}

/** Slice on UTF-16 units without leaving a lone surrogate at the cut. */
function cut(text: string, max: number): string {
  if (max <= 0) return "";
  if (text.length <= max) return text;
  const code = text.charCodeAt(max - 1);
  return text.slice(0, code >= 0xd800 && code <= 0xdbff ? max - 1 : max);
}

/** Budget the encoded string, not just its input length: quotes and backslashes expand in JSON. */
function quotedExcerpt(text: string, limit: number): { encoded: string; truncated: boolean } {
  let low = 0, high = Math.min(text.length, limit), kept = '';
  while (low <= high) {
    const mid = Math.floor((low + high) / 2); const prefix = cut(text, mid);
    if (JSON.stringify(prefix).length <= limit) { kept = prefix; low = mid + 1; } else high = mid - 1;
  }
  return { encoded: JSON.stringify(kept), truncated: kept.length < text.length };
}

/** Existing fragments retain their brief; ordinary tasks include direct prerequisites only. */
export function taskContext(taskId: number, tasks: readonly Todo[], jobs: readonly JobRecordView[]): string | undefined {
  const fragment = fragmentContext(taskId, tasks, jobs);
  if (fragment !== undefined) return fragment;
  const task = tasks.find((item) => item.id === taskId && item.status !== 'deleted');
  if (!task) return undefined;
  const closing = 'This is bounded parent context, not new permission or proof. Verify reports and declared artifacts against the current assignment; do not repeat finished work.';
  const lines = [`Task #${task.id} ${quotedExcerpt(task.subject, 240).encoded} [${task.status}].`];
  const references = (item: Todo, limit = 350) => {
    const refs = contextArtifacts(item); const shown: string[] = [];
    for (const ref of refs) { if (JSON.stringify([...shown, ref]).length > limit) break; shown.push(ref); }
    return refs.length ? `${JSON.stringify(shown)}${shown.length < refs.length ? ` (${refs.length - shown.length} references omitted)` : ''}` : undefined;
  };
  const ownRefs = references(task);
  const ownRefLine = ownRefs ? `Declared task artifact references (unverified): ${ownRefs}` : undefined;
  const excerpt = task.description?.trim();
  if (excerpt) {
    const budget = Math.min(700, MAX_CONTEXT - lines[0]!.length - (ownRefLine?.length ?? 0) - closing.length - 270 - (task.blockedBy.length ? 600 : 0));
    const quoted = quotedExcerpt(excerpt, Math.max(100, budget));
    lines.push(`Current requirements excerpt${quoted.truncated ? ' (truncated; assignment must contain full requirements)' : ''}: ${quoted.encoded}`);
  }
  if (ownRefLine) lines.push(ownRefLine);
  const byId = new Map(tasks.map((item) => [item.id, item]));
  const latest = new Map(jobs.filter((job) => job.todoId !== undefined).map((job) => [job.todoId!, job]));
  if (task.blockedBy.length) lines.push('Direct prerequisites:');
  let shown = 0;
  for (const id of task.blockedBy) {
    const remaining = MAX_CONTEXT - lines.join('\n').length - closing.length - 140;
    const dependency = byId.get(id);
    let head = `- #${id} [${dependency?.status ?? 'missing'}]${dependency ? ` ${quotedExcerpt(dependency.subject, 160).encoded}` : ''}`;
    const job = latest.get(id); const output = job?.output ?? ''; const start = job?.outputStart ?? 0;
    const splitPair = start > 0 && /[\uD800-\uDBFF]/.test(output[start - 1] ?? '') && /[\uDC00-\uDFFF]/.test(output[start] ?? '');
    if (dependency?.status === 'completed' && job && !job.taskReportStale && ['completed', 'running', 'waiting'].includes(job.status) && Number.isSafeInteger(start) && start >= 0 && start <= output.length && !splitPair) {
      // Only flatten a bounded window; long retained reports do not need another full copy.
      const window = cut(output.slice(start, start + 1601), 1600);
      const report = window.replace(/[\p{Cc}\p{Bidi_Control}]/gu, ' ').replace(/\s+/g, ' ').trim();
      if (report) {
        const quoted = quotedExcerpt(report, REPORT_HEAD);
        head += `; latest report${job.id ? ` ${quotedExcerpt(job.id, 40).encoded}` : ''} excerpt: ${quoted.encoded}${quoted.truncated || start + window.length < output.length ? ' (truncated)' : ''}`;
      }
    }
    if (dependency?.status === 'completed' && remaining - head.length > 90) {
      const refs = references(dependency, Math.min(350, remaining - head.length - 80));
      if (refs) head += `; declared artifacts (unverified): ${refs}`;
    }
    if (head.length > remaining) break;
    lines.push(head); shown++;
  }
  if (shown < task.blockedBy.length) lines.push(`${task.blockedBy.length - shown} direct prerequisites omitted from this brief; parent must supply required inputs in the assignment.`);
  lines.push(closing);
  return lines.join('\n');
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
  const latest = new Map(jobs.filter((job) => job.todoId !== undefined).map((job) => [job.todoId!, job]));
  const report = (item: Todo): string | undefined => {
    const job = latest.get(item.id);
    if (!job || job.taskReportStale || !['completed', 'running', 'waiting'].includes(job.status)) return undefined;
    const start = job.outputStart ?? 0;
    const output = job.output ?? '';
    if (!Number.isSafeInteger(start) || start < 0 || start > output.length || /[\uD800-\uDBFF]/.test(output[start - 1] ?? '') && /[\uDC00-\uDFFF]/.test(output[start] ?? '')) return undefined;
    // Preserve whitespace-folding and exact ellipsis semantics without allocating a full copy.
    let flat: string;
    if (output.length - start <= 1600) flat = output.slice(start).replace(/\s+/g, ' ').trim();
    else {
      const nextCharacter = /\S/gu; nextCharacter.lastIndex = start;
      flat = ''; let previous = start;
      while (flat.length <= REPORT_HEAD) {
        const match = nextCharacter.exec(output);
        if (!match) break;
        if (flat && match.index > previous) flat += ' ';
        flat += match[0]; previous = nextCharacter.lastIndex;
      }
    }
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
  const header = "Earlier and prerequisite steps of this fragment, report heads:";
  const shown: string[] = [];
  let remaining = Math.min(800, Math.max(0, left - Math.min(150, whole.length))) - header.length;
  for (const item of feeding) {
    const line = report(item);
    if (line === undefined) continue;
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
