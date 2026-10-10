import type { AgentRequest, AgentUsage, JobResult } from "./runtime.ts";

/** Native Pi entry type that carries the append-only agent journal. */
export const AGENTS_ENTRY_TYPE = "pi-dag-workflow.agents";

/**
 * One changed job inside a version-2 journal entry. Every changed job carries its full metadata;
 * only the output is encoded as a continuation so a growing job never rewrites its whole text.
 */
export interface AgentJobDelta extends Omit<JobResult, "output" | "observation" | "reason"> {
  /** Full output for a new job or a non-append replacement. */
  output?: string;
  /** Output appended since the previously persisted record; requires `offset`. */
  outputAppend?: string;
  /** Length of the previous output that `outputAppend` continues; validated while folding. */
  offset?: number;
}

/** Version-2 append-only journal payload. */
export interface AgentJournalData {
  version: 2;
  jobs?: AgentJobDelta[];
  removed?: string[];
  nextId?: number;
}

export interface AgentJournalState {
  records: JobResult[];
  nextId: number | undefined;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const corrupt = () => new Error("Unsupported or corrupt agent state");

function nextIdOf(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) throw new Error("Invalid agent nextId");
  return value as number;
}

function sameStrings(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function sameRequests(a: readonly AgentRequest[], b: readonly AgentRequest[]): boolean {
  return a.length === b.length && a.every((value, index) => value.requestId === b[index]!.requestId && value.message === b[index]!.message);
}

function sameUsage(a: AgentUsage | undefined, b: AgentUsage | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  return a.requests === b.requests && a.input === b.input && a.output === b.output && a.estimatedCost === b.estimatedCost;
}

/** Field-by-field equality; output compares by identity so unchanged jobs cost nothing. */
function sameRecord(a: JobResult, b: JobResult): boolean {
  if (a.id !== b.id || a.todoId !== b.todoId || a.profile !== b.profile || a.thinking !== b.thinking || a.status !== b.status) return false;
  if (a.startedAt !== b.startedAt || a.endedAt !== b.endedAt || a.error !== b.error || a.pendingRequests !== b.pendingRequests) return false;
  if (a.label !== b.label || a.reportDelivery !== b.reportDelivery || a.taskReportStale !== b.taskReportStale) return false;
  if (a.reportVersion !== b.reportVersion || a.timedOut !== b.timedOut || a.outputStart !== b.outputStart) return false;
  if (a.dismissed !== b.dismissed || a.resumeFrom !== b.resumeFrom || a.assignment !== b.assignment || a.taskDefinition !== b.taskDefinition) return false;
  if (JSON.stringify(a.failure) !== JSON.stringify(b.failure)) return false;
  if (a.model.provider !== b.model.provider || a.model.id !== b.model.id) return false;
  return a.output === b.output && sameStrings(a.tools, b.tools) && sameRequests(a.requests, b.requests) && sameUsage(a.usage, b.usage);
}

/** Build a delta. Output stays untouched unless the record is new or the text was replaced. */
function deltaOf(record: JobResult, previous: JobResult | undefined): AgentJobDelta {
  const { output, observation: _observation, reason: _reason, ...meta } = record;
  const delta: AgentJobDelta = { ...meta };
  if (!previous) { delta.output = output; return delta; }
  // Resume inputs are immutable for an attempt; do not serialize them on every output delta.
  if (record.assignment === previous.assignment) delete delta.assignment;
  if (record.taskDefinition === previous.taskDefinition) delete delta.taskDefinition;
  if (output === previous.output) return delta;
  if (output.length >= previous.output.length && output.startsWith(previous.output)) {
    delta.offset = previous.output.length;
    delta.outputAppend = output.slice(previous.output.length);
    return delta;
  }
  delta.output = output;
  return delta;
}

/** Apply one decoded delta, rejecting missing bases and mismatched offsets instead of losing data. */
function applyDelta(records: Map<string, JobResult>, raw: unknown): void {
  if (!isObject(raw) || typeof raw.id !== "string") throw corrupt();
  const { id, output, outputAppend, offset, observation: _observation, reason: _reason, ...meta } = raw;
  const previous = records.get(id);
  const savedInputs = previous ? { ...(previous.assignment === undefined ? {} : { assignment: previous.assignment }), ...(previous.taskDefinition === undefined ? {} : { taskDefinition: previous.taskDefinition }) } : {};
  if (output !== undefined) {
    if (typeof output !== "string" || outputAppend !== undefined || offset !== undefined) throw corrupt();
    records.set(id, { ...savedInputs, ...meta, id, output } as unknown as JobResult);
    return;
  }
  if (outputAppend !== undefined) {
    if (typeof outputAppend !== "string" || !Number.isSafeInteger(offset) || (offset as number) < 0) throw new Error("Invalid agent journal output offset");
    if (!previous) throw new Error("Agent journal output delta has no base record");
    if ((offset as number) !== previous.output.length) throw new Error("Agent journal output offset mismatch");
    records.set(id, { ...savedInputs, ...meta, id, output: previous.output + outputAppend } as unknown as JobResult);
    return;
  }
  if (offset !== undefined) throw new Error("Invalid agent journal output offset");
  if (!previous) throw new Error("Agent journal record is missing its initial output");
  records.set(id, { ...savedInputs, ...meta, id, output: previous.output } as unknown as JobResult);
}

/** Fold version-1 full snapshots and version-2 deltas in branch order into the live record set. */
export function foldAgentData(payloads: readonly unknown[]): AgentJournalState {
  let records = new Map<string, JobResult>();
  let nextId: number | undefined;
  // A full snapshot supersedes everything before it, including an explicit user reset.
  // Start at the newest one so old redundant snapshots are neither decoded nor resurrected.
  let start = 0;
  for (let index = payloads.length - 1; index >= 0; index--) {
    const payload = payloads[index];
    if (isObject(payload) && payload.version === 1) { start = index; break; }
  }
  for (let index = start; index < payloads.length; index++) {
    const raw = payloads[index];
    if (raw === undefined) throw corrupt();
    if (!isObject(raw)) throw corrupt();
    if (raw.version === 1) {
      if (!Array.isArray(raw.jobs)) throw corrupt();
      const replaced = new Map<string, JobResult>();
      for (const job of raw.jobs) {
        if (!isObject(job) || typeof job.id !== "string" || job.output !== undefined && typeof job.output !== "string" || replaced.has(job.id)) throw corrupt();
        replaced.set(job.id, { ...job, output: job.output ?? '', requests: Array.isArray(job.requests) ? job.requests : [] } as unknown as JobResult);
      }
      records = replaced;
      nextId = raw.nextId === undefined ? undefined : nextIdOf(raw.nextId);
      continue;
    }
    if (raw.version === 2) {
      if (raw.jobs !== undefined && !Array.isArray(raw.jobs)) throw corrupt();
      if (raw.removed !== undefined && (!Array.isArray(raw.removed) || raw.removed.some((id) => typeof id !== "string"))) throw corrupt();
      for (const id of (raw.removed ?? []) as string[]) records.delete(id);
      for (const delta of (raw.jobs ?? []) as unknown[]) applyDelta(records, delta);
      if (raw.nextId !== undefined) {
        const candidate = nextIdOf(raw.nextId);
        if (nextId !== undefined && candidate < nextId) throw new Error('Agent journal nextId decreased');
        nextId = candidate;
      }
      continue;
    }
    throw new Error(`Unsupported agent journal version: ${String(raw.version)}`);
  }
  return { records: [...records.values()], nextId };
}

/** Fold native branch entries, ignoring every entry that is not the agent journal. */
export function foldAgentEntries(entries: readonly unknown[]): AgentJournalState {
  const payloads: unknown[] = [];
  for (const entry of entries) {
    if (isObject(entry) && entry.type === 'custom' && entry.customType === AGENTS_ENTRY_TYPE) payloads.push(entry.data);
  }
  return foldAgentData(payloads);
}

/**
 * Diffs the live records against the last confirmed append. A prepared payload is published with
 * `confirm` only after the session append succeeded, so a failed write is retried next time.
 */
export class AgentJournal {
  private confirmed = new Map<string, JobResult>();
  private confirmedNextId = 1;
  private pending: { records: readonly JobResult[]; nextId: number } | undefined;

  hydrate(records: readonly JobResult[], nextId: number): void {
    this.confirmed = new Map(records.map((record) => [record.id, record]));
    this.confirmedNextId = nextId;
    this.pending = undefined;
  }

  reset(): void {
    this.confirmed.clear();
    this.confirmedNextId = 1;
    this.pending = undefined;
  }

  /** Current confirmed high-water id; useful for assertions and diagnostics. */
  get nextId(): number { return this.confirmedNextId; }

  prepare(records: readonly JobResult[], nextId: number): AgentJournalData | null {
    const jobs: AgentJobDelta[] = [];
    const present = new Set<string>();
    for (const record of records) {
      present.add(record.id);
      const previous = this.confirmed.get(record.id);
      if (previous && sameRecord(previous, record)) continue;
      jobs.push(deltaOf(record, previous));
    }
    const removed = [...this.confirmed.keys()].filter((id) => !present.has(id));
    if (!jobs.length && !removed.length && nextId === this.confirmedNextId) { this.pending = undefined; return null; }
    this.pending = { records, nextId };
    return { version: 2, jobs, nextId, ...(removed.length ? { removed } : {}) };
  }

  confirm(): void {
    if (!this.pending) return;
    this.confirmed = new Map(this.pending.records.map((record) => [record.id, record]));
    this.confirmedNextId = this.pending.nextId;
    this.pending = undefined;
  }
}
