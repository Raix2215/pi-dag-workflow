import assert from 'node:assert/strict';
import { test } from 'node:test';
import { stripTerminalSequences } from '@earendil-works/pi-tui';
import { renderTasks, renderDag, renderWidget, type AgentView } from '../src/ui/render.ts';
import { filteredView } from '../src/ui/filter.ts';
import { emptyState, statusLabel, type Todo, type WorkflowState } from '../src/todos/state.ts';
import { createTranslator } from '../src/shared/i18n.ts';

const plain = (lines: string[]): string => lines.map(stripTerminalSequences).join('\n');
const task = (id: number, status: Todo['status'] = 'in_progress'): Todo => ({ id, subject: `任务${id}`, status, blockedBy: [] });
const state = (tasks: Todo[]): WorkflowState => ({ ...emptyState(), tasks, nextId: tasks.length + 1 });
const bound = (id: string, todoId: number, extra: Partial<AgentView> = {}): AgentView => ({ id, todoId, profile: 'worker', status: 'running', ...extra });
const dismissed = (id: string, todoId: number, status: AgentView['status'] = 'cancelled'): AgentView => ({ ...bound(id, todoId, { status }), taskReportStale: true, dismissed: true });
const escape = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// ---------------------------------------------------------------------------
// Explicit cancellation vs. an unhandled failure / explicit main takeover
// ---------------------------------------------------------------------------

test('an explicitly dismissed attempt shows the main session and a resumable hint in list, DAG, widget and pending filter', () => {
  const current = state([task(1)]);
  const attempt = dismissed('a1', 1);
  const msg = createTranslator('zh-CN');
  const ready = new RegExp(`\\[${escape(msg('可接续'))}\\]`);
  const texts = [
    renderTasks(current, 120, { jobs: [attempt], msg }),
    renderTasks(current, 120, { jobs: [attempt], msg, maxRows: Infinity, filter: 'pending' }),
    renderDag(current, 120, undefined, undefined, [attempt], { msg }),
    renderDag(current, 120, undefined, undefined, [attempt], { msg, maxLines: 12, filter: 'pending' }),
    renderWidget(current, 120, 14, { jobs: [attempt], msg }),
  ].map(plain);
  for (const text of texts) {
    assert.match(text, /\[主会话\]/);
    assert.match(text, ready);
    assert.doesNotMatch(text, /a1 · worker/);
  }
  assert.equal(filteredView(current.tasks, 'full', [attempt]).resumableIds.has(1), true);
});

test('an unhandled failure keeps the original job and error instead of a resumable hint', () => {
  const current = state([task(1)]);
  const failed = bound('a1', 1, { status: 'failed', reportDelivery: 'delivered' });
  const text = plain(renderTasks(current, 120, { jobs: [failed] }));
  assert.match(text, /a1 · worker/);
  assert.match(text, /失败/);
  assert.doesNotMatch(text, /可接续|主会话/);
  assert.equal(filteredView(current.tasks, 'full', [failed]).resumableIds.has(1), false);
});

test('an explicit main takeover of a plain failure stays on the normal main-session row', () => {
  const current = state([task(1)]);
  const staleFailed = { ...bound('a1', 1, { status: 'failed', reportDelivery: 'delivered' }), taskReportStale: true };
  const text = plain(renderTasks(current, 120, { jobs: [staleFailed] }));
  assert.match(text, /\[主会话\]/);
  assert.match(text, new RegExp(`\\[${escape(statusLabel.in_progress)}\\]`));
  assert.doesNotMatch(text, /可接续/);
});

// ---------------------------------------------------------------------------
// Attempt ordering and native acceptance precedence
// ---------------------------------------------------------------------------

test('a newer valid attempt outranks an older dismissed one', () => {
  const current = state([task(1)]);
  const older = dismissed('a1', 1);
  const fresh = bound('a2', 1, { status: 'running', taskReportStale: false });
  const text = plain(renderTasks(current, 120, { jobs: [older, fresh] }));
  assert.match(text, /a2 · worker/);
  assert.match(text, /运行中/);
  assert.doesNotMatch(text, /可接续/);
  const view = filteredView(current.tasks, 'full', [older, fresh]);
  assert.equal(view.resumableIds.has(1), false);
});

test('a native failed/cancelled/completed Todo is never made resumable by a dismissed attempt', () => {
  const attempt = dismissed('a1', 1);
  for (const status of ['failed', 'cancelled', 'completed'] as const) {
    const current = state([task(1, status)]);
    const text = plain(renderTasks(current, 120, { jobs: [attempt], maxRows: Infinity, filter: status }));
    assert.match(text, new RegExp(escape(statusLabel[status])));
    assert.doesNotMatch(text, /可接续/);
    assert.equal(filteredView(current.tasks, status, [attempt]).resumableIds.has(1), false);
  }
});

test('a dismissed cancellation keeps the Todo pending instead of turning it into a native cancellation', () => {
  const current = state([task(1)]);
  const attempt = dismissed('a1', 1, 'cancelled');
  const pending = filteredView(current.tasks, 'pending', [attempt]);
  assert.equal(pending.effective.get(1), 'pending');
  assert.equal(pending.resumableIds.has(1), true);
  assert.equal(filteredView(current.tasks, 'cancelled', [attempt]).effective.has(1), false);
});

// ---------------------------------------------------------------------------
// Standalone dismissal visibility
// ---------------------------------------------------------------------------

test('a dismissed standalone job is hidden in full but visible under explicit result filters', () => {
  const current = state([task(1, 'completed')]);
  for (const filter of ['failed', 'cancelled', 'completed'] as const) {
    const gone: AgentView = { id: 'a9', profile: 'worker', status: filter, dismissed: true, taskReportStale: true };
    assert.doesNotMatch(plain(renderTasks(current, 120, { jobs: [gone] })), /Standalone/, `${filter} hidden in full`);
    assert.equal(filteredView(current.tasks, 'full', [gone]).standaloneIds.has('a9'), false);
    assert.equal(filteredView(current.tasks, filter, [gone]).standaloneIds.has('a9'), true);
    const text = plain(renderTasks(current, 120, { jobs: [gone], filter }));
    assert.match(text, /Standalone/);
    assert.match(text, /a9/);
  }
  // A non-dismissed closed job still explains itself in the default full view.
  const open: AgentView = { id: 'a9', profile: 'worker', status: 'failed' };
  assert.match(plain(renderTasks(current, 120, { jobs: [open] })), /Standalone/);
});
