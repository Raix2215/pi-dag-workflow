import assert from 'node:assert/strict';
import { test } from 'node:test';
import { visibleWidth, stripTerminalSequences } from '@earendil-works/pi-tui';
import { dagLayout, type DagLayout } from '../src/dag/layout.ts';
import { dagStructure } from '../src/dag/cache.ts';
import { renderDag } from '../src/ui/render.ts';
import { emptyState, type Todo } from '../src/todos/state.ts';
const task = (id: number, blockedBy: number[] = []): Todo => ({ id, blockedBy, subject: `任务${id}`, status: 'pending' });
const layout = (tasks: Todo[], width = 120) => { const value = dagLayout(dagStructure(tasks), width); assert.ok(value.layout, value.reason ?? 'expected graph layout'); return value.layout; };
function trace(value: DagLayout) {
  const boxes = new Map(value.boxes.map((box) => [box.id, box]));
  for (const route of value.routes) {
    const a = boxes.get(route.from)!; const b = boxes.get(route.to)!;
    const start: [number, number] = [a.left + Math.floor(a.width / 2) - 1, a.top + 4];
    const end: [number, number] = [b.left + Math.floor(b.width / 2) + 1, b.top];
    const cells = new Set(route.points.map(([x, y]) => `${x}:${y}`));
    assert.ok(cells.has(start.join(':'))); assert.ok(cells.has(end.join(':')));
    const visited = new Set<string>(); const queue = [start];
    while (queue.length) {
      const [x, y] = queue.pop()!; const key = `${x}:${y}`;
      if (visited.has(key)) continue; visited.add(key);
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) if (cells.has(`${x + dx!}:${y + dy!}`)) queue.push([x + dx!, y + dy!]);
    }
    assert.ok(visited.has(end.join(':')), `continuous #${route.from} -> #${route.to}`);
  }
}
test('solid fan-out/fan-in draws every Todo once without predecessor text', () => {
  const tasks = [task(1), task(2, [1]), task(3, [1]), task(4, [2, 3])];
  const value = layout(tasks, 80); trace(value);
  assert.deepEqual(value.boxes.map((box) => box.id), [1, 2, 3, 4]);
  assert.equal(value.routes.length, 4); assert.equal(value.crossings, 0);
  const text = renderDag({ ...emptyState(), tasks, nextId: 5 }, 80).join('\n');
  assert.match(text, /┌.*─.*┐/); assert.match(text, /┬/); assert.match(text, /┴/);
  assert.doesNotMatch(text, /<-|前驱/);
  for (const id of [1, 2, 3, 4]) assert.equal((text.match(new RegExp(`#${id}(?!\\d)`, 'g')) ?? []).length, 1);
});
test('skip-layer edges pass through transit lanes without duplicating nodes or drawing false parents', () => {
  const value = layout([task(1), task(2, [1]), task(3, [2]), task(4, [1, 3])]);
  trace(value); assert.equal(value.boxes.length, 4); assert.equal(value.routes.length, 4);
  const oneToFour = value.routes.find((route) => route.from === 1 && route.to === 4)!;
  assert.ok(oneToFour.points.length > value.routes.find((route) => route.from === 3 && route.to === 4)!.points.length);
});
test('unrelated intersections use an explicit crossing glyph and never a merge junction', () => {
  const tasks = [task(1), task(2), task(3, [2]), task(4, [1]), task(5, [3]), task(6, [4])];
  const value = layout(tasks); trace(value);
  assert.ok(value.crossings > 0);
  assert.ok(value.lines.some((line) => line.includes('╳')));
  assert.match(renderDag({ ...emptyState(), tasks, nextId: 7 }, 120).join('\n'), /仅交叉、不汇合/);
});
test('width/resource fallback is explicit and retains complete predecessor identifiers', () => {
  const tasks = [task(1), task(2), task(3, [1, 2])];
  for (const width of [1, 3, 6, 20, 40]) {
    const lines = renderDag({ ...emptyState(), tasks, nextId: 4 }, width);
    for (const line of lines) assert.ok(visibleWidth(line) <= width);
    if (width >= 20) assert.match(lines.join('\n'), /降级/);
    // Degraded DAG reuses the todo path tree: #3 nests under one parent, the other stays as reference.
    if (width === 40) assert.match(lines.join('\n'), /#3<-#(1|2)(?![0-9])/);
  }
  const huge = Array.from({ length: 4096 }, (_, i) => task(i + 1, i ? [i] : []));
  assert.ok(dagLayout(dagStructure(huge), 80).reason);
});
test('deleted rows do not enter the graph; Chinese/controls/long labels cannot damage lines', () => {
  const tasks = [task(1), { ...task(2, [1]), subject: '中文\x1b[31m标题\n多行'.repeat(10), owner: '\x1b]0;bad\x07测试者' }, { ...task(3), status: 'deleted' as const }];
  const text = renderDag({ ...emptyState(), tasks, nextId: 4 }, 80);
  assert.doesNotMatch(text.join('\n'), /#3|\x1b|bad/);
  assert.equal(text.join('\n'), stripTerminalSequences(text.join('\n')));
  for (const line of text) assert.ok(visibleWidth(line) <= 80);
});
test('deterministic generated DAGs keep every edge connected and all node boxes unique', () => {
  let seed = 123;
  const random = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
  let drawn = 0;
  for (let sample = 0; sample < 80; sample++) {
    const tasks = Array.from({ length: 8 }, (_, i) => task(i + 1, Array.from({ length: i }, (_, p) => p + 1).filter(() => random() < 0.15)));
    const result = dagLayout(dagStructure(tasks), 240);
    if (!result.layout) continue;
    drawn++; trace(result.layout);
    assert.equal(new Set(result.layout.boxes.map((box) => box.id)).size, tasks.length);
    for (const line of result.layout.lines) assert.ok(visibleWidth(line) <= 240);
    const graph = renderDag({ ...emptyState(), tasks, nextId: 9 }, 240);
    assert.doesNotMatch(graph.join('\n'), /<-/);
  }
  assert.ok(drawn > 60);
});

test('graph preview is bounded and marked, not a cropped image claimed to be complete', () => {
  const tasks = Array.from({ length: 4096 }, (_, i) => task(i + 1, i ? [i] : []));
  const preview = renderDag({ ...emptyState(), tasks, nextId: 4097 }, 80, undefined, undefined, [], { maxLines: 11 });
  assert.ok(preview.length <= 12); assert.match(preview.join('\n'), /图预览/);
});

test('static routing is cached by topology and width, not runtime activity or theme', () => {
  const structure = dagStructure([task(1), task(2, [1])]);
  assert.equal(dagLayout(structure, 80), dagLayout(structure, 80));
  assert.notEqual(dagLayout(structure, 80), dagLayout(structure, 120));
});
