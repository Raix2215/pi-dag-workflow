import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { renderTasks, renderDag } from '../src/ui/render.ts';
import { emptyState, applyTodo, newlyReady, type Todo } from '../src/todos/state.ts';
import { dagStructure } from '../src/dag/cache.ts';
import { resetClosure } from '../src/todos/presets.ts';
import { dagLayout } from '../src/dag/layout.ts';
const report: Record<string, unknown> = { note: 'Local Node microbenchmark, not a terminal or provider latency promise', node: process.version };
function measure(fn: () => void, samples = 50) {
  for (let i = 0; i < 5; i++) fn();
  const times: number[] = [];
  for (let i = 0; i < samples; i++) { const start = performance.now(); fn(); times.push(performance.now() - start); }
  times.sort((a, b) => a - b);
  return { samples, medianMs: times[Math.floor(samples / 2)], p95Ms: times[Math.floor(samples * 0.95)], maxMs: times.at(-1) };
}
for (const count of [100, 1000, 4096]) {
  const tasks: Todo[] = Array.from({ length: count }, (_, i) => ({ id: i + 1, subject: `节点${i + 1}`, status: 'pending', blockedBy: i ? [i] : [] }));
  let state = { ...emptyState(), tasks, nextId: count + 1 };
  const before = dagStructure(tasks);
  state = applyTodo(state, { action: 'update', id: 1, owner: '测试执行者' }).state;
  assert.equal(dagStructure(state.tasks), before);
  const firstLayout = dagLayout(before, 80);
  assert.equal(dagLayout(dagStructure(state.tasks), 80), firstLayout);
  const resetTasks = tasks.map((task, index) => index === 0 ? { ...task, metadata: { preset: 'benchmark', run: 1, key: 'root' } } : task).reverse();
  assert.equal(resetClosure(resetTasks, 'benchmark').length, count);
  const done = { ...state, tasks: state.tasks.map((task) => task.id === 1 ? { ...task, status: 'completed' as const } : task) };
  assert.deepEqual(newlyReady(state, done).map((task) => task.id), [2]);
  report[`tasks${count}`] = { resetClosure: measure(() => { resetClosure(resetTasks, 'benchmark'); }), completionHints: measure(() => { newlyReady(state, done); }), list: measure(() => { renderTasks(state, 80); }), dagFull: measure(() => { renderDag(state, 80); }), dagPreview: measure(() => { renderDag(state, 80, undefined, undefined, [], { maxLines: 11 }); }), reusedTopology: true, reusedRouting: true, fallback: firstLayout.reason };
}
const dir = fileURLToPath(new URL('../../docs/evidence/m4/', import.meta.url));
await mkdir(dir, { recursive: true }); await writeFile(`${dir}performance-summary.json`, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
