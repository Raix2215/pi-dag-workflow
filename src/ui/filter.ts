import type { AgentView } from './render.ts';
import type { Todo, TodoFilter } from '../todos/state.ts';

/**
 * View and cleanup status of one Todo with its child job. The canonical Todo owns acceptance:
 * `completed` wins outright, and a native `failed`/`cancelled` is never overridden by a job.
 * `pending` covers an untouched Todo and one whose child finished but is not accepted yet.
 */
export type TaskFilterStatus = 'pending' | 'completed' | 'failed' | 'cancelled';

/** Read-only projection for one filter. It never mutates, reorders or copies the canonical tasks. */
export interface TaskView {
  readonly filter: TodoFilter;
  /** Visible tasks in canonical creation order; every blockedBy list stays exactly as stored. */
  readonly tasks: readonly Todo[];
  /** Filter status per visible task id. */
  readonly effective: ReadonlyMap<number, TaskFilterStatus>;
  /** Prerequisites the filter hid, per visible task id; the views keep them as left references. */
  readonly external: ReadonlyMap<number, readonly number[]>;
  /** Graph input: the canonical array in the full view, otherwise copies with no hidden edge. */
  readonly dagTasks: readonly Todo[];
  /** Ids of the unbound jobs this filter shows; live fields are re-read from each frame's jobs. */
  readonly standaloneIds: ReadonlySet<string>;
  /**
   * Unfinished Todos whose newest bound attempt was explicitly dismissed. The row stays owned
   * by the main session and offers a resume hint; native terminal Todo states never use it.
   */
  readonly resumableIds: ReadonlySet<number>;
}

const ACTIVE = new Set<AgentView['status']>(['starting', 'running']);

/**
 * Newest bound job per Todo id, in runtime order: a later entry is a newer attempt. The newest
 * attempt owns the row even when its report went stale, and a stale newest attempt then removes
 * the entry instead of falling back to an older one, so a retired/historical report can never
 * resurrect the verdict of a superseded attempt. Shared with cleanup so nobody re-derives
 * "the latest report that still counts".
 */
export function latestBoundJobs(jobs: readonly AgentView[]): Map<number, AgentView> {
  const latest = new Map<number, AgentView>();
  for (const job of jobs) if (job.todoId !== undefined) latest.set(job.todoId, job);
  for (const [todoId, job] of latest) if (job.taskReportStale) latest.delete(todoId);
  return latest;
}

/**
 * Pure verdict for one Todo and its newest non-stale bound job: nothing is mutated and no state is
 * consulted. Only an unfinished Todo can take a failure or cancellation from its job; a completed
 * child still waits for acceptance, so it reports `pending`.
 */
export function taskFilterStatus(task: Todo, latestJob?: AgentView): TaskFilterStatus {
  if (task.status === 'completed' || task.status === 'failed' || task.status === 'cancelled') return task.status;
  if (latestJob?.status === 'failed') return 'failed';
  if (latestJob?.status === 'cancelled' || latestJob?.status === 'interrupted') return 'cancelled';
  return 'pending';
}

function matches(filter: TodoFilter, status: TaskFilterStatus): boolean {
  if (filter === 'full') return true;
  return status === filter;
}

/** Membership for the Standalone section; `full` keeps the original auto-hide of delivered reports. */
function standalone(filter: TodoFilter, job: AgentView): boolean {
  if (job.todoId !== undefined) return false;
  // An explicit dismissal silences the row only in the default view; result filters still find it.
  if (filter === 'full') return !job.dismissed && (job.status !== 'completed' || job.reportDelivery === 'pending');
  if (filter === 'pending') return ACTIVE.has(job.status) || job.status === 'waiting' || (job.status === 'completed' && job.reportDelivery === 'pending');
  if (filter === 'completed') return job.status === 'completed';
  if (filter === 'failed') return job.status === 'failed';
  return job.status === 'cancelled' || job.status === 'interrupted';
}

/**
 * Change key over the fields the projection reads. Live activity and elapsed time stay out, so a
 * per-second redraw reuses the cached view and the DAG layout it already paid for.
 */
function jobSignature(jobs: readonly AgentView[]): string {
  let signature = '';
  for (const job of jobs) {
    signature += `${job.id}\u0001${job.todoId ?? ''}\u0001${job.status}\u0001${job.reportDelivery ?? ''}\u0001${job.taskReportStale ? 1 : 0}\u0001${job.dismissed ? 1 : 0}\u0002`;
  }
  return signature;
}

function buildView(tasks: readonly Todo[], filter: TodoFilter, jobs: readonly AgentView[]): TaskView {
  const latest = latestBoundJobs(jobs);
  // The newest attempt regardless of staleness: a stale/dismissed record still owns the row
  // until a later attempt replaces it, so an older dismissal can never mask a fresh job.
  const attempts = new Map<number, AgentView>();
  for (const job of jobs) if (job.todoId !== undefined) attempts.set(job.todoId, job);
  const resumableIds = new Set<number>();
  for (const task of tasks) {
    if (task.status !== 'pending' && task.status !== 'in_progress') continue;
    if (attempts.get(task.id)?.dismissed) resumableIds.add(task.id);
  }
  const effective = new Map<number, TaskFilterStatus>();
  const visible: Todo[] = [];
  for (const task of tasks) {
    if (task.status === 'deleted') continue;
    const status = taskFilterStatus(task, latest.get(task.id));
    if (!matches(filter, status)) continue;
    effective.set(task.id, status);
    visible.push(task);
  }

  const external = new Map<number, readonly number[]>();
  let dagTasks: readonly Todo[] = tasks;
  if (filter !== 'full') {
    const ids = new Set(visible.map((task) => task.id));
    // deriveDag rejects an edge to a task outside its input, so hidden prerequisites become a
    // left-hand reference instead of a missing node or an implied edge.
    dagTasks = visible.map((task) => {
      const hidden = task.blockedBy.filter((id) => !ids.has(id));
      if (!hidden.length) return task;
      external.set(task.id, hidden);
      return { ...task, blockedBy: task.blockedBy.filter((id) => ids.has(id)) };
    });
  }

  const standaloneIds = new Set(jobs.filter((job) => standalone(filter, job)).map((job) => job.id));
  return { filter, tasks: visible, effective, external, dagTasks, standaloneIds, resumableIds };
}

const views = new WeakMap<readonly Todo[], Map<string, TaskView>>();
const MAX_VIEWS = 8;

/**
 * O(tasks + jobs + edges) once per change, O(1) afterwards: the memo is keyed by the canonical
 * task array identity, so repeated redraws of one immutable snapshot reuse the same projection
 * (and the DAG structure and layout cached from it).
 */
export function filteredView(tasks: readonly Todo[], filter: TodoFilter, jobs: readonly AgentView[]): TaskView {
  const key = `${filter}\u0000${jobSignature(jobs)}`;
  let entries = views.get(tasks);
  if (!entries) { entries = new Map(); views.set(tasks, entries); }
  const cached = entries.get(key);
  if (cached) return cached;
  const view = buildView(tasks, filter, jobs);
  entries.set(key, view);
  if (entries.size > MAX_VIEWS) entries.delete(entries.keys().next().value!);
  return view;
}
