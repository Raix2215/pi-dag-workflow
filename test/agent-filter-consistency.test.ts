import assert from 'node:assert/strict';
import { test } from 'node:test';
import { stripTerminalSequences } from '@earendil-works/pi-tui';
import { renderTasks, renderDag, renderWidget, type AgentView } from '../src/ui/render.ts';
import { filteredView, latestBoundJobs, taskFilterStatus } from '../src/ui/filter.ts';
import { clearTodoRecords, emptyState, statusLabel, type Todo, type WorkflowState } from '../src/todos/state.ts';
import { createTranslator } from '../src/shared/i18n.ts';

const msg = createTranslator('zh-CN');
const plain = (lines: string[]): string => lines.map(stripTerminalSequences).join('\n');
const task = (id: number, status: Todo['status'] = 'in_progress'): Todo => ({ id, subject: `任务${id}`, status, blockedBy: [] });
const state = (tasks: Todo[], treeStyle?: WorkflowState['treeStyle']): WorkflowState => ({ ...emptyState(), tasks, nextId: tasks.length + 1, ...(treeStyle ? { treeStyle } : {}) });
const bound = (id: string, todoId: number, extra: Partial<AgentView> = {}): AgentView => ({ id, todoId, profile: 'worker', status: 'running', ...extra });
const stale = (id: string, todoId: number, extra: Partial<AgentView> = {}): AgentView => bound(id, todoId, { taskReportStale: true, ...extra });
const dismissed = (id: string, todoId: number, status: AgentView['status'] = 'cancelled'): AgentView => stale(id, todoId, { status, dismissed: true });
const shownIds = (lines: string[]): number[] => lines.flatMap((line) => {
  const match = /[├└]─ #([0-9]+)/.exec(stripTerminalSequences(line));
  return match ? [Number(match[1])] : [];
});

// ---------------------------------------------------------------------------
// The projection rule: the newest bound attempt speaks, and a stale newest
// attempt silences the row instead of reviving an older failure.
// ---------------------------------------------------------------------------

test('latestBoundJobs takes the newest attempt and drops it when stale, never falling back', () => {
  const olderFailed = bound('a1', 1, { status: 'failed' });
  const newerStaleFailed = stale('a2', 1, { status: 'failed' });
  const latest = latestBoundJobs([olderFailed, newerStaleFailed]);
  assert.equal(latest.get(1), undefined, 'a stale newer attempt wins and then removes the entry');
  assert.equal(taskFilterStatus(task(1), latest.get(1)), 'pending');

  // Runtime order decides: the last bound job is the newest, whatever its staleness.
  assert.equal(latestBoundJobs([newerStaleFailed, olderFailed]).get(1)!.id, 'a1');
  // A stale-only Todo has no speaking attempt.
  assert.equal(latestBoundJobs([stale('a9', 9, { status: 'failed' })]).get(9), undefined);
  // Unbound jobs never enter the map, and older stale attempts do not leak through.
  const unbound: AgentView = { id: 'a1', profile: 'worker', status: 'failed' };
  assert.equal(latestBoundJobs([unbound]).size, 0);
  assert.equal(latestBoundJobs([stale('a1', 1), stale('a2', 1)]).size, 0);
});

test('an older failed attempt cannot report through a newer dismissed attempt in any view or filter', () => {
  const current = state([task(1)]);
  const jobs = [bound('a1', 1, { status: 'failed', reportDelivery: 'delivered' }), dismissed('a2', 1, 'cancelled')];
  const view = filteredView(current.tasks, 'full', jobs);
  assert.equal(view.effective.get(1), 'pending', 'the stale newer attempt keeps the row pending');
  assert.equal(view.resumableIds.has(1), true, 'the dismissed newest attempt makes the row resumable');
  assert.equal(latestBoundJobs(jobs).get(1), undefined);

  for (const style of ['paths', 'flat'] as const) {
    const panel = state([task(1)], style);
    const full = plain(renderTasks(panel, 120, { jobs, maxRows: Infinity }));
    assert.match(full, /\[主会话\]/, `${style} full keeps the main-session row`);
    assert.match(full, /\[可接续\]/, `${style} full offers resume`);
    assert.doesNotMatch(full, /a1 · worker|失败/, `${style} full never revives the old failure`);

    const failed = plain(renderTasks(panel, 120, { jobs, maxRows: Infinity, filter: 'failed' }));
    assert.deepEqual(shownIds(failed.split('\n')), [], `${style} failed filter hides the row`);
    const pending = plain(renderTasks(panel, 120, { jobs, maxRows: Infinity, filter: 'pending' }));
    assert.deepEqual(shownIds(pending.split('\n')), [1], `${style} pending filter keeps the row`);
    assert.match(pending, /\[可接续\]/);
    const cancelled = plain(renderTasks(panel, 120, { jobs, maxRows: Infinity, filter: 'cancelled' }));
    assert.deepEqual(shownIds(cancelled.split('\n')), [], `${style} cancelled filter hides the row`);
    const completed = plain(renderTasks(panel, 120, { jobs, maxRows: Infinity, filter: 'completed' }));
    assert.deepEqual(shownIds(completed.split('\n')), [], `${style} completed filter hides the row`);
  }

  const dag = plain(renderDag(current, 120, undefined, undefined, jobs, { maxLines: Infinity }));
  assert.match(dag, /\[主会话\]/);
  assert.match(dag, /\[可接续\]/);
  assert.doesNotMatch(dag, /失败/);
  const dagFailed = plain(renderDag(current, 120, undefined, undefined, jobs, { maxLines: Infinity, filter: 'failed' }));
  assert.doesNotMatch(dagFailed, /#1\b.*失败/s);

  const widget = plain(renderWidget(current, 120, 20, { jobs }));
  assert.match(widget, /\[主会话\]/);
  assert.match(widget, /\[可接续\]/);
  assert.doesNotMatch(widget, /失败/);
});

test('a main takeover (stale but not dismissed) stays a plain pending row without a resume hint', () => {
  const current = state([task(1)]);
  const jobs = [bound('a1', 1, { status: 'failed', reportDelivery: 'delivered' }), stale('a2', 1, { status: 'failed' })];
  const view = filteredView(current.tasks, 'full', jobs);
  assert.equal(view.effective.get(1), 'pending');
  assert.equal(view.resumableIds.has(1), false);
  assert.equal(latestBoundJobs(jobs).get(1), undefined);
  for (const style of ['paths', 'flat'] as const) {
    const text = plain(renderTasks(state([task(1)], style), 120, { jobs, maxRows: Infinity }));
    assert.match(text, /\[主会话\]/, `${style} main session owns the row`);
    assert.match(text, new RegExp(`\\[${statusLabel.in_progress}\\]`), `${style} keeps the canonical state`);
    assert.doesNotMatch(text, /可接续|a1 · worker|失败/, `${style} no resume and no stale failure`);
  }
});

test('a newer live attempt outranks an older failure and needs no resume', () => {
  const current = state([task(1)]);
  const jobs = [bound('a1', 1, { status: 'failed' }), bound('a2', 1, { status: 'running' })];
  assert.equal(filteredView(current.tasks, 'full', jobs).effective.get(1), 'pending');
  assert.equal(filteredView(current.tasks, 'full', jobs).resumableIds.has(1), false);
  assert.equal(latestBoundJobs(jobs).get(1)!.id, 'a2');
  const text = plain(renderTasks(current, 120, { jobs, maxRows: Infinity }));
  assert.match(text, /a2 · worker/);
  assert.doesNotMatch(text, /失败/);
});

test('the newest non-dismissed cancellation decides the cancelled filter; dismissal turns it back to pending', () => {
  const current = state([task(1)]);
  const cancelled = [bound('a1', 1, { status: 'cancelled' })];
  assert.equal(filteredView(current.tasks, 'cancelled', cancelled).effective.get(1), 'cancelled');
  assert.deepEqual(shownIds(renderTasks(current, 120, { jobs: cancelled, maxRows: Infinity, filter: 'cancelled' }).map(stripTerminalSequences)), [1]);
  assert.deepEqual(shownIds(renderTasks(current, 120, { jobs: cancelled, maxRows: Infinity, filter: 'pending' }).map(stripTerminalSequences)), []);

  // The same cancellation, now explicitly dismissed, is pending work with a resume hint.
  const dismissedCancel = [bound('a1', 1, { status: 'failed' }), dismissed('a2', 1, 'cancelled')];
  assert.equal(filteredView(current.tasks, 'cancelled', dismissedCancel).effective.has(1), false);
  assert.equal(filteredView(current.tasks, 'cancelled', dismissedCancel).resumableIds.has(1), true);
});

test('native terminal Todo states outrank any attempt and are never made resumable', () => {
  for (const status of ['failed', 'cancelled', 'completed'] as const) {
    const current = state([task(1, status)]);
    const jobs = [bound('a1', 1, { status: 'failed' }), dismissed('a2', 1, 'cancelled')];
    assert.equal(filteredView(current.tasks, status, jobs).effective.get(1), status);
    assert.equal(filteredView(current.tasks, status, jobs).resumableIds.has(1), false);
    assert.equal(taskFilterStatus(task(1, status), latestBoundJobs(jobs).get(1)), status);
    for (const filter of ['full', 'pending', 'completed', 'failed', 'cancelled'] as const) {
      const ids = shownIds(renderTasks(current, 120, { jobs, maxRows: Infinity, filter }).map(stripTerminalSequences));
      const expected = filter === 'full' || filter === status ? [1] : [];
      assert.deepEqual(ids, expected, `${status} under ${filter}`);
    }
  }
});

test('a dismissed newest attempt of any terminal status keeps the row pending and resumable', () => {
  const current = state([task(1)]);
  for (const status of ['failed', 'cancelled', 'interrupted'] as const) {
    const jobs = [bound('a1', 1, { status: 'failed' }), dismissed('a2', 1, status)];
    const view = filteredView(current.tasks, 'full', jobs);
    assert.equal(view.effective.get(1), 'pending', `${status}: newest dismissal is pending`);
    assert.equal(view.resumableIds.has(1), true, `${status}: newest dismissal is resumable`);
    for (const filter of ['failed', 'cancelled'] as const) {
      assert.equal(filteredView(current.tasks, filter, jobs).effective.has(1), false, `${status} hidden from ${filter}`);
    }
  }
});

test('a pending-delivery success stays pending work and never becomes resumable', () => {
  const current = state([task(1)]);
  const jobs = [bound('a1', 1, { status: 'completed', reportDelivery: 'pending' })];
  const view = filteredView(current.tasks, 'full', jobs);
  assert.equal(view.effective.get(1), 'pending');
  assert.equal(view.resumableIds.has(1), false);
  assert.equal(latestBoundJobs(jobs).get(1)!.id, 'a1');
  const pending = plain(renderTasks(current, 120, { jobs, maxRows: Infinity, filter: 'pending' }));
  assert.deepEqual(shownIds(pending.split('\n')), [1]);
  assert.match(pending, /待交付/);
  assert.doesNotMatch(pending, /可接续/);
  assert.deepEqual(shownIds(renderTasks(current, 120, { jobs, maxRows: Infinity, filter: 'completed' }).map(stripTerminalSequences)), [], 'delivery still waits before the completed filter');
});

// ---------------------------------------------------------------------------
// Cleanup shares the exact projection the views use.
// ---------------------------------------------------------------------------

test('clear cleanup consumes latestBoundJobs so a stale newer attempt keeps the task in closed scope', () => {
  const current = state([task(1)]);
  const jobs = [bound('a1', 1, { status: 'failed', reportDelivery: 'delivered' }), dismissed('a2', 1, 'cancelled')];
  const latest = latestBoundJobs(jobs);
  const outcomes = new Map(current.tasks.map((item) => [item.id, taskFilterStatus(item, latest.get(item.id))]));
  assert.equal(outcomes.get(1), 'pending');
  const closed = clearTodoRecords(current, 'closed', new Set(), outcomes, msg);
  assert.deepEqual(closed.state.tasks.map((item) => item.id), [1], 'pending work is not cleaned by the closed scope');
  assert.equal(closed.removedIds.length, 0);

  // The buggy fallback to the older failure would have classified it failed and removed it.
  const buggy = new Map([[1, 'failed']]);
  const removed = clearTodoRecords(current, 'closed', new Set(), buggy, msg);
  assert.deepEqual(removed.state.tasks.map((item) => item.id), []);
});

// ---------------------------------------------------------------------------
// Standalone dismissal + legacy stale jobs stay compatible.
// ---------------------------------------------------------------------------

test('dismissed standalone history hides in full, stays in result filters and leaves pending alone', () => {
  const current = state([task(1, 'completed')]);
  for (const filter of ['failed', 'cancelled', 'completed'] as const) {
    const gone: AgentView = { id: 'a9', profile: 'worker', status: filter, dismissed: true, taskReportStale: true };
    assert.equal(filteredView(current.tasks, 'full', [gone]).standaloneIds.has('a9'), false);
    assert.equal(filteredView(current.tasks, filter, [gone]).standaloneIds.has('a9'), true);
    assert.equal(filteredView(current.tasks, 'pending', [gone]).standaloneIds.has('a9'), false);
    assert.match(plain(renderTasks(current, 120, { jobs: [gone], filter })), /a9/);
    assert.doesNotMatch(plain(renderTasks(current, 120, { jobs: [gone] })), /a9/);
  }
  // A pending-delivery success is unfinished work even if the terminal filter would list it.
  const delivery: AgentView = { id: 'a8', profile: 'worker', status: 'completed', reportDelivery: 'pending' };
  assert.equal(filteredView(current.tasks, 'full', [delivery]).standaloneIds.has('a8'), true);
  assert.equal(filteredView(current.tasks, 'pending', [delivery]).standaloneIds.has('a8'), true);
});

test('legacy stale job records without a dismissal marker project cleanly instead of erroring', () => {
  const current = state([task(1), task(2, 'in_progress')]);
  // Legacy persisted shape: only the stale flag plus an unknown Todo id, no dismissed field.
  const legacy = [
    { id: 'old1', todoId: 1, profile: 'worker', status: 'failed', taskReportStale: true } as AgentView,
    { id: 'old2', todoId: 99, profile: 'worker', status: 'failed', taskReportStale: true } as AgentView,
    { id: 'old3', todoId: 2, profile: 'worker', status: 'running' } as AgentView,
  ];
  const latest = latestBoundJobs(legacy);
  assert.equal(latest.get(1), undefined);
  assert.equal(latest.get(99), undefined);
  assert.equal(latest.get(2)!.id, 'old3');
  const view = filteredView(current.tasks, 'full', legacy);
  assert.equal(view.effective.get(1), 'pending');
  assert.equal(view.effective.get(2), 'pending');
  assert.equal(view.resumableIds.size, 0);
  assert.doesNotThrow(() => renderTasks(current, 120, { jobs: legacy, maxRows: Infinity }));
  assert.doesNotThrow(() => renderDag(current, 120, undefined, undefined, legacy));
  assert.doesNotThrow(() => renderWidget(current, 120, 16, { jobs: legacy }));
});
