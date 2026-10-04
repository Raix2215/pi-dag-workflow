import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { Theme } from '@earendil-works/pi-coding-agent';
import { stripTerminalSequences, visibleWidth } from '@earendil-works/pi-tui';
import { emptyState, type Todo, type TodoFilter, type WorkflowState } from '../src/todos/state.ts';
import { renderTasks, renderDag, type AgentView } from '../src/ui/render.ts';
import { filteredView, latestBoundJobs, taskFilterStatus } from '../src/ui/filter.ts';
import { dagStructure } from '../src/dag/cache.ts';

const task = (id: number, status: Todo['status'], blockedBy: number[] = []): Todo => ({ id, subject: `任务${id}`, status, blockedBy });
const state = (tasks: Todo[], filter?: TodoFilter): WorkflowState => ({ ...emptyState(), tasks, nextId: tasks.length + 1, ...(filter ? { filter } : {}) });
const job = (id: string, extra: Partial<AgentView> = {}): AgentView => ({ id, profile: 'fast', status: 'running', label: `工作 ${id}`, ...extra });
const bound = (id: string, todoId: number, extra: Partial<AgentView> = {}): AgentView => ({ ...job(id), todoId, ...extra });
const plain = (lines: string[]): string => lines.map(stripTerminalSequences).join('\n');
const shownIds = (lines: string[]): number[] => lines.flatMap((line) => {
  const match = /[├└]─ #([0-9]+)/.exec(stripTerminalSequences(line));
  return match ? [Number(match[1])] : [];
});
const standaloneCount = (text: string, count: number): boolean => new RegExp(`Standalone(?: Subagents)? · ${count}\\b`).test(text);

// ---------------------------------------------------------------------------
// Filter selection and the effective status of a Todo row
// ---------------------------------------------------------------------------

test('the full view is the default, and an explicit filter resolves options over state', () => {
  const tasks = [task(1, 'completed'), task(2, 'pending'), task(3, 'in_progress'), task(4, 'failed'), task(5, 'cancelled')];
  const current = state(tasks);
  assert.deepEqual(renderTasks(current, 120), renderTasks({ ...current, filter: 'full' }, 120));
  assert.deepEqual(shownIds(renderTasks(current, 120, { maxRows: Infinity })), [1, 2, 3, 4, 5]);

  const pending = state(tasks, 'pending');
  assert.deepEqual(shownIds(renderTasks(pending, 120, { maxRows: Infinity })), [2, 3]);
  // A per-call filter overrides the persisted view without touching the state.
  assert.deepEqual(shownIds(renderTasks(pending, 120, { maxRows: Infinity, filter: 'completed' })), [1]);
  assert.deepEqual(shownIds(renderTasks(pending, 120, { maxRows: Infinity, filter: 'failed' })), [4]);
  assert.deepEqual(shownIds(renderTasks(pending, 120, { maxRows: Infinity, filter: 'cancelled' })), [5]);
  assert.deepEqual(shownIds(renderTasks(current, 120, { maxRows: Infinity, filter: 'completed' })), [1]);
  // The active scope is visible in the header, so an empty filtered panel explains itself.
  assert.match(plain(renderTasks(pending, 120)), /筛选：未完成/);
  assert.match(plain(renderTasks(current, 120, { filter: 'cancelled' })), /筛选：已取消/);
  assert.doesNotMatch(plain(renderTasks(current, 120)), /筛选/);
});

test('canonical acceptance wins, then only the newest non-stale child job may report a failure', () => {
  // A verified completed Todo is never dragged back by a later failed job.
  const completed = state([task(1, 'completed')]);
  assert.deepEqual(shownIds(renderTasks(completed, 120, { maxRows: Infinity, filter: 'completed', jobs: [bound('a1', 1, { status: 'failed' })] })), [1]);
  assert.deepEqual(shownIds(renderTasks(completed, 120, { maxRows: Infinity, filter: 'failed', jobs: [bound('a1', 1, { status: 'failed' })] })), []);

  // An unfinished Todo takes the failure or cancellation of its newest job.
  const inProgress = state([task(1, 'in_progress')]);
  const failed = plain(renderTasks(inProgress, 120, { maxRows: Infinity, filter: 'failed', jobs: [bound('a1', 1, { status: 'failed' })] }));
  assert.match(failed, /#1/);
  assert.match(failed, /✗/);
  assert.match(failed, /\[󰅙 失败\]/);
  assert.match(plain(renderTasks(inProgress, 120, { maxRows: Infinity, filter: 'cancelled', jobs: [bound('a1', 1, { status: 'cancelled' })] })), /\[󰓛 已取消\]/);
  assert.match(plain(renderTasks(inProgress, 120, { maxRows: Infinity, filter: 'cancelled', jobs: [bound('a1', 1, { status: 'interrupted' })] })), /\[󰙦 已中断\]/);

  // The newest job decides: a fresh attempt outranks an older failure, and the order is runtime order.
  const tasks = [task(7, 'in_progress')];
  assert.deepEqual(shownIds(renderTasks(state(tasks), 120, { maxRows: Infinity, filter: 'pending', jobs: [bound('a1', 7, { status: 'failed' }), bound('a2', 7, { status: 'running' })] })), [7]);
  assert.deepEqual(shownIds(renderTasks(state(tasks), 120, { maxRows: Infinity, filter: 'failed', jobs: [bound('a1', 7, { status: 'failed' }), bound('a2', 7, { status: 'running' })] })), []);
  assert.deepEqual(shownIds(renderTasks(state(tasks), 120, { maxRows: Infinity, filter: 'failed', jobs: [bound('a2', 7, { status: 'running' }), bound('a1', 7, { status: 'failed' })] })), [7]);
  // A stale report belongs to a previous attempt and cannot relabel the current one.
  assert.deepEqual(shownIds(renderTasks(state(tasks), 120, { maxRows: Infinity, filter: 'failed', jobs: [bound('a1', 7, { status: 'running' }), bound('a2', 7, { status: 'failed', taskReportStale: true })] })), []);
  assert.deepEqual(shownIds(renderTasks(state(tasks), 120, { maxRows: Infinity, filter: 'pending', jobs: [bound('a2', 7, { status: 'failed', taskReportStale: true })] })), [7]);
});

test('a child that finished execution does not complete the Todo; it waits for acceptance', () => {
  const pending = state([task(1, 'pending'), task(2, 'in_progress')]);
  const jobs = [bound('a1', 1, { status: 'completed', reportDelivery: 'pending' }), bound('a2', 2, { status: 'completed' })];
  const text = plain(renderTasks(pending, 120, { maxRows: Infinity, jobs }));
  assert.match(text, /\[󰥔 待交付\]/);
  assert.match(text, /\[󰥔 待核验\]/);
  // Both stay pending work; neither reaches the completed filter.
  assert.deepEqual(shownIds(renderTasks(pending, 120, { maxRows: Infinity, filter: 'pending', jobs })), [1, 2]);
  assert.deepEqual(shownIds(renderTasks(pending, 120, { maxRows: Infinity, filter: 'completed', jobs })), []);
});

test('native failed and cancelled Todos keep Nerd Font icons and semantic theme colors', () => {
  const builtin = JSON.parse(readFileSync(new URL('../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/dark.json', import.meta.url), 'utf8'));
  const tokens = Object.keys(builtin.colors);
  const foreground = Object.fromEntries(tokens.map((token) => [token, '#cccccc']));
  const background = Object.fromEntries(tokens.map((token) => [token, '#222222']));
  const theme = new Theme(foreground as never, background as never, 'truecolor');
  const current = state([task(1, 'failed'), task(2, 'cancelled')]);
  const text = renderTasks(current, 120, { theme, maxRows: Infinity }).join('\n');
  assert.ok(text.includes(theme.fg('error', '✗')), 'failed rows use the error color');
  assert.ok(text.includes(theme.fg('dim', '⊘')), 'cancelled rows use the dim color');
  assert.ok(text.includes(theme.fg('muted', '[失败]')));
  assert.ok(text.includes(theme.fg('muted', '[已取消]')));
  // A job failure on an unfinished Todo reads the same way, from the agent palette.
  const fromJob = renderTasks(state([task(3, 'in_progress')]), 120, { theme, maxRows: Infinity, jobs: [bound('a1', 3, { status: 'failed' })] }).join('\n');
  assert.ok(fromJob.includes(theme.fg('error', '✗')));
  assert.ok(fromJob.includes(theme.fg('error', '[󰅙 失败]')));
});

// ---------------------------------------------------------------------------
// Standalone section membership per filter
// ---------------------------------------------------------------------------

test('the Standalone section follows the filter while full keeps the delivered-report auto-hide', () => {
  const jobs = [
    bound('b1', 1, { status: 'running' }),
    job('a1', { status: 'running' }),
    job('a2', { status: 'completed', reportDelivery: 'pending' }),
    job('a3', { status: 'completed', reportDelivery: 'delivered' }),
    job('a4', { status: 'failed' }),
    job('a5', { status: 'cancelled' }),
    job('a6', { status: 'interrupted' }),
  ];
  const current = state([task(1, 'in_progress')]);
  const full = plain(renderTasks(current, 120, { maxRows: Infinity, jobs }));
  assert.ok(standaloneCount(full, 5), full);
  assert.match(full, /a1 · fast/);
  assert.doesNotMatch(full, /a3 · fast/);

  const pending = plain(renderTasks(current, 120, { maxRows: Infinity, filter: 'pending', jobs }));
  assert.ok(standaloneCount(pending, 2), pending);
  assert.match(pending, /a1 · fast/);
  assert.match(pending, /a2 · fast/);
  assert.doesNotMatch(pending, /a3|a4|a5|a6/);

  // The completed scope shows delivered history, not the delivered auto-hide of the full view.
  const completed = plain(renderTasks(current, 120, { maxRows: Infinity, filter: 'completed', jobs }));
  assert.ok(standaloneCount(completed, 2), completed);
  assert.match(completed, /a2 · fast/);
  assert.match(completed, /a3 · fast/);
  assert.doesNotMatch(completed, /a1|a4|a5|a6/);

  const failed = plain(renderTasks(current, 120, { maxRows: Infinity, filter: 'failed', jobs }));
  assert.ok(standaloneCount(failed, 1), failed);
  assert.match(failed, /a4 · fast/);
  assert.doesNotMatch(failed, /a1|a2|a3|a5|a6/);

  // Cancellation covers both the cancelled and the interrupted terminal states.
  const cancelled = plain(renderTasks(current, 120, { maxRows: Infinity, filter: 'cancelled', jobs }));
  assert.ok(standaloneCount(cancelled, 2), cancelled);
  assert.match(cancelled, /a5 · fast/);
  assert.match(cancelled, /a6 · fast/);
  assert.doesNotMatch(cancelled, /a1|a2|a3|a4/);
});

// ---------------------------------------------------------------------------
// DAG paths and hidden prerequisites
// ---------------------------------------------------------------------------

test('every DAG path appends the Standalone section exactly once', () => {
  const jobs = [job('a1')];
  const tasks = [task(1, 'pending'), task(2, 'pending', [1])];
  // Normal solid graph.
  const graph = plain(renderDag(state(tasks), 120, undefined, undefined, jobs));
  assert.doesNotMatch(graph, /降级/);
  assert.equal((graph.match(/Standalone/g) ?? []).length, 1);
  // Degraded list (width below the graph minimum).
  const fallback = plain(renderDag(state(tasks), 20, undefined, undefined, jobs));
  assert.match(fallback, /降级/);
  assert.match(fallback, /#2<-#1/);
  assert.equal((fallback.match(/Standalone/g) ?? []).length, 1);
  // No Todo at all: the section is the whole panel.
  const lone = plain(renderDag(state([]), 120, undefined, undefined, jobs));
  assert.match(lone, /Standalone/);
  assert.doesNotMatch(lone, /Todo/);
  assert.equal((lone.match(/Standalone/g) ?? []).length, 1);
  // A bound job reports on its row and never doubles into the section.
  const boundGraph = plain(renderDag(state(tasks), 120, undefined, undefined, [bound('b1', 1, { status: 'running' })]));
  assert.doesNotMatch(boundGraph, /Standalone/);
});

test('a filtered DAG never reports a missing prerequisite and keeps the external reference', () => {
  const tasks = [task(1, 'completed'), task(2, 'pending', [1]), task(3, 'pending', [2])];
  const current = state(tasks);
  const before = structuredClone(tasks);
  const graph = plain(renderDag(current, 120, undefined, undefined, [], { filter: 'pending' }));
  assert.doesNotMatch(graph, /降级|missing|未知|缺失/);
  // #1 is hidden by the filter, so the box names it instead of drawing a false edge.
  assert.match(graph, /#2<-#1/);
  const fallback = plain(renderDag(current, 20, undefined, undefined, [], { filter: 'pending' }));
  assert.match(fallback, /降级/);
  assert.match(fallback, /#2<-#1/);
  assert.doesNotMatch(shownIds(fallback.split('\n')).join(','), /(^|,)1(,|$)/);
  // The full view still draws a real edge and never falls back to predecessor text.
  const full = plain(renderDag(current, 120));
  assert.doesNotMatch(full, /<-/);
  // Filtering is display-only: the canonical tasks and their blockedBy lists never change.
  assert.deepEqual(tasks, before);
  assert.deepEqual(current.tasks, before);
});

test('long external references stay inside graph boxes and remain complete below the full graph', () => {
  const parents = Array.from({ length: 10 }, (_, index) => ({ id: index + 1, subject: `parent ${index}`, status: 'completed' as const, blockedBy: [] }));
  const state = { ...emptyState(), nextId: 12, tasks: [...parents, { id: 11, subject: 'failed child', status: 'failed' as const, blockedBy: parents.map((task) => task.id) }] };
  const lines = renderDag(state, 80, undefined, undefined, [], { filter: 'failed' });
  assert.ok(lines.every((line) => visibleWidth(line) <= 80));
  const reference = '#11<-' + parents.map((task) => `#${task.id}`).join(',');
  assert.ok(lines.join('\n').includes(reference));
  const titleLine = lines.find((line) => line.includes('✗'))!;
  assert.ok(titleLine.trimEnd().endsWith('│'), 'truncated prefix cannot overwrite the graph border');
});

test('taskFilterStatus gives cleanup the same verdict the view shows', () => {
  const one = (status: AgentView['status'], extra: Partial<AgentView> = {}): AgentView => ({ id: 'a1', profile: 'fast', status, ...extra });
  // Unfinished work never counts as closed, whatever its child is doing.
  assert.equal(taskFilterStatus(task(1, 'pending')), 'pending');
  assert.equal(taskFilterStatus(task(1, 'in_progress'), one('starting')), 'pending');
  assert.equal(taskFilterStatus(task(1, 'in_progress'), one('running')), 'pending');
  assert.equal(taskFilterStatus(task(1, 'in_progress'), one('waiting')), 'pending');
  assert.equal(taskFilterStatus(task(1, 'in_progress'), one('completed', { reportDelivery: 'pending' })), 'pending');
  assert.equal(taskFilterStatus(task(1, 'in_progress'), one('completed')), 'pending');
  // Only a failure or cancellation from the newest non-stale job closes it as failed/cancelled.
  assert.equal(taskFilterStatus(task(1, 'in_progress'), one('failed')), 'failed');
  assert.equal(taskFilterStatus(task(1, 'in_progress'), one('cancelled')), 'cancelled');
  assert.equal(taskFilterStatus(task(1, 'in_progress'), one('interrupted')), 'cancelled');
  // Verified native states outrank any job.
  assert.equal(taskFilterStatus(task(1, 'completed'), one('failed')), 'completed');
  assert.equal(taskFilterStatus(task(1, 'failed'), one('completed')), 'failed');
  assert.equal(taskFilterStatus(task(1, 'cancelled'), one('running')), 'cancelled');
  // Cleanup passes the latest bound job, and a stale report is not one.
  const jobs = [
    bound('a1', 1, { status: 'failed' }),
    bound('a2', 1, { status: 'running' }),
    bound('a3', 2, { status: 'failed', taskReportStale: true }),
  ];
  const latest = latestBoundJobs(jobs);
  assert.equal(latest.get(1)!.id, 'a2');
  assert.equal(latest.get(2), undefined);
  assert.equal(taskFilterStatus(task(1, 'in_progress'), latest.get(1)), 'pending');
});

test('the filter projection is cached per immutable snapshot', () => {
  const tasks = [task(1, 'completed'), task(2, 'pending', [1]), task(3, 'in_progress')];
  const jobs = [bound('a1', 3, { status: 'failed' })];
  const first = filteredView(tasks, 'full', jobs);
  const second = filteredView(tasks, 'full', [{ ...jobs[0]! }]);
  assert.equal(first, second, 'an unchanged snapshot and job statuses reuse the projection');
  assert.equal(first.dagTasks, second.dagTasks);
  assert.equal(dagStructure(first.dagTasks), dagStructure(second.dagTasks), 'the DAG structure is reused too');
  assert.equal(first.effective.get(3), 'failed');
  // A changed job status produces a new projection instead of a stale one.
  const changed = filteredView(tasks, 'full', [bound('a1', 3, { status: 'cancelled' })]);
  assert.notEqual(first, changed);
  assert.equal(changed.effective.get(3), 'cancelled');
});

// ---------------------------------------------------------------------------
// Preview budgets
// ---------------------------------------------------------------------------

test('preview budgets hold: 8 Todo rows, 4 standalone rows and an 11-line graph', () => {
  const tasks = Array.from({ length: 12 }, (_, index) => task(index + 1, 'pending'));
  const jobs = Array.from({ length: 6 }, (_, index) => job(`a${index + 1}`, { status: 'running' }));
  const current = state(tasks);
  const preview = plain(renderTasks(current, 120, { jobs }));
  assert.equal(shownIds(preview.split('\n')).length, 8);
  assert.match(preview, /隐藏 4 项/);
  assert.ok(standaloneCount(preview, 6), preview);
  assert.match(preview, /隐藏 2 项/);
  // Complete views carry every standalone row they show.
  const list = plain(renderTasks(current, 120, { jobs, maxRows: Infinity }));
  assert.doesNotMatch(list, /隐藏/);
  for (const id of ['a1', 'a6']) assert.match(list, new RegExp(`${id} · fast`));

  const chain = Array.from({ length: 20 }, (_, index) => task(index + 1, 'pending', index ? [index] : []));
  const dagPreview = plain(renderDag(state(chain), 120, undefined, undefined, jobs, { maxLines: 11 })).split('\n');
  const standaloneAt = dagPreview.findIndex((line) => line.includes('Standalone'));
  assert.ok(standaloneAt > 0 && standaloneAt <= 12, `graph keeps its own budget: ${standaloneAt}`);
  assert.match(dagPreview.slice(0, standaloneAt).join('\n'), /图预览/);
  assert.match(dagPreview.slice(standaloneAt).join('\n'), /隐藏 2 项/);
  const dagFull = plain(renderDag(state(chain), 120, undefined, undefined, jobs)).split('\n');
  const fullAt = dagFull.findIndex((line) => line.includes('Standalone'));
  assert.doesNotMatch(dagFull.slice(fullAt).join('\n'), /隐藏/);
  for (const id of ['a1', 'a6']) assert.match(dagFull.slice(fullAt).join('\n'), new RegExp(`${id} · fast`));
});

test('filtered rows stay inside narrow and wide terminals in both views', () => {
  const tasks = [task(1, 'failed'), task(2, 'cancelled'), task(3, 'pending', [1]), task(4, 'in_progress', [2])];
  const jobs = [bound('a1', 4, { status: 'running', activity: { kind: 'tool', tool: 'read', since: Date.now() - 3000 } }), job('a9', { status: 'failed' })];
  for (const filter of ['full', 'pending', 'completed', 'failed', 'cancelled'] as const) {
    for (const width of [20, 40, 80, 120]) {
      for (const line of renderTasks(state(tasks), width, { jobs, maxRows: Infinity, filter })) assert.ok(visibleWidth(line) <= width, `${filter}/${width}: ${line}`);
      for (const line of renderDag(state(tasks), width, undefined, undefined, jobs, { filter })) assert.ok(visibleWidth(line) <= width, `${filter}/${width}: ${line}`);
    }
  }
});
