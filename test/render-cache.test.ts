import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Theme } from '@earendil-works/pi-coding-agent';
import { Lru, snapshotCache } from '../src/ui/render-cache.ts';
import { renderTasks, renderDag, type AgentView } from '../src/ui/render.ts';
import { emptyState } from '../src/todos/state.ts';
import { createTranslator } from '../src/shared/i18n.ts';
import { visibleWidth } from '@earendil-works/pi-tui';

const state = () => ({ ...emptyState(), nextId: 3, tasks: [{ id: 1, subject: 'visible one', status: 'in_progress' as const, blockedBy: [] }, { id: 2, subject: 'visible two', status: 'pending' as const, blockedBy: [1] }] });

test('snapshot variants use bounded LRU and never retain another snapshot value', () => {
  const cache = snapshotCache<number>(2); let made = 0;
  const tasks = {}, other = {};
  const value = (key: string) => cache(tasks, key, () => ++made);
  assert.equal(value('a'), 1); assert.equal(value('b'), 2); assert.equal(value('a'), 1);
  assert.equal(value('c'), 3); assert.equal(value('a'), 1); assert.equal(value('b'), 4);
  assert.equal(cache(other, 'a', () => ++made), 5);
  const lru = new Lru<string>(1); lru.set('a', 'first'); lru.set('b', 'second'); assert.equal(lru.get('a'), undefined);
  const bounded = snapshotCache<number>(2, 2); const snapshots = [{}, {}, {}]; let builds = 0;
  for (const snapshot of snapshots) bounded(snapshot, 'width', () => ++builds);
  assert.equal(bounded(snapshots[0]!, 'width', () => ++builds), 4, 'old retained session snapshots cannot keep all frame variants resident');
});

test('cached rows apply current colors even when the Theme object changes in place', () => {
  const tasks = state(); let prefix = 31;
  const theme = { fg: (_color: string, text: string) => `\x1b[${prefix}m${text}\x1b[39m` } as unknown as Theme;
  const first = renderTasks(tasks, 80, { theme, maxRows: Infinity });
  prefix = 32;
  const changed = renderTasks(tasks, 80, { theme, maxRows: Infinity });
  assert.match(first.join('\n'), /\x1b\[31m/);
  assert.match(changed.join('\n'), /\x1b\[32m/);
  assert.doesNotMatch(changed.join('\n'), /\x1b\[31m/);
  assert.ok(changed.every((line) => visibleWidth(line) <= 80));
});

test('cached live rows use a fresh tool start time and continue across second boundaries', () => {
  const tasks = state(); const original = Date.now; let now = 1000000;
  Date.now = () => now;
  const job: AgentView = { id: 'a1', todoId: 1, profile: 'fixture', status: 'running', activity: { kind: 'tool', tool: 'bash', since: now - 100000 } };
  try {
    assert.match(renderTasks(tasks, 80, { jobs: [job] }).join('\n'), /bash 1m40s/);
    now += 1000;
    assert.match(renderTasks(tasks, 80, { jobs: [job] }).join('\n'), /bash 1m41s/);
    const restarted = { ...job, activity: { ...job.activity!, since: now - 2000 } };
    assert.match(renderTasks(tasks, 80, { jobs: [restarted] }).join('\n'), /bash 2s/);
    const output = { ...job, activity: { kind: 'output' as const } };
    assert.doesNotMatch(renderTasks(tasks, 80, { jobs: [output] }).join('\n'), /bash/);
  } finally { Date.now = original; }
});

test('cached geometry invalidates for title, owner, language, width, status and filter changes', () => {
  const tasks = state(); const english = createTranslator('en');
  renderTasks(tasks, 80, { maxRows: Infinity });
  const changed = { ...tasks, tasks: tasks.tasks.map((task) => task.id === 1 ? { ...task, subject: 'replacement', owner: 'new owner', status: 'failed' as const } : task) };
  const lines = renderTasks(changed, 120, { maxRows: Infinity, msg: english, filter: 'failed' });
  assert.match(lines.join('\n'), /replacement/); assert.match(lines.join('\n'), /new owner/); assert.match(lines.join('\n'), /Failed/);
  assert.doesNotMatch(lines.join('\n'), /visible one|visible two/);
  const jobs: AgentView[] = [{ id: 'a9', profile: 'fixture', status: 'failed', label: 'standalone' }];
  const dag = renderDag(changed, 120, undefined, undefined, jobs, { filter: 'failed', msg: english });
  assert.match(dag.join('\n'), /Standalone/); assert.match(dag.join('\n'), /a9/);
  assert.ok(dag.every((line) => visibleWidth(line) <= 120));
});
