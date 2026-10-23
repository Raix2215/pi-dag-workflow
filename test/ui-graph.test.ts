import assert from 'node:assert/strict';
import { test } from 'node:test';
import { visibleWidth, stripTerminalSequences } from '@earendil-works/pi-tui';
import { dagLayout, type DagLayout } from '../src/shared/dag/layout.ts';
import { dagStructure } from '../src/shared/dag/cache.ts';
import { renderDag } from '../src/shared/ui/render.ts';
import { emptyState } from "../src/todos/domain/state.ts";
import type { Todo } from "../src/shared/task-types.ts";
import { deriveDag } from '../src/shared/dag/graph.ts';
import { applyTodo, newlyReady } from '../src/todos/domain/state.ts';

// Pure readiness calculation, moved from flow-persistence.test.ts.
test('unchanged Todo snapshots need no readiness scan while real completions still unlock work', () => {
  let reads = 0; const tasks: Todo[] = [{ id: 1, subject: 'Probe', get status() { reads++; return 'pending' as const; }, blockedBy: [] }];
  const state = { ...emptyState(), tasks, nextId: 2 }; assert.deepEqual(newlyReady(state, { ...state, plan: true }), []); assert.equal(reads, 0);
  const before = { ...emptyState(), tasks: [{ id: 1, subject: 'First', status: 'pending' as const, blockedBy: [] }, { id: 2, subject: 'Last', status: 'pending' as const, blockedBy: [1] }], nextId: 3 };
  const after = { ...before, tasks: before.tasks.map((task) => task.id === 1 ? { ...task, status: 'completed' as const } : task) };
  assert.deepEqual(newlyReady(before, after).map((task) => task.id), [2]);
});
import type { DependencyTask } from "../src/shared/dag/graph.ts";

// dag-layout.test.ts
{
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
    if (width === 40) assert.match(lines.join('\n'), /#3<-#1,#2/);
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
}

// graph-cache.test.ts
{
test('status/title/owner/progress mutations reuse topology while ready state remains fresh', () => {
  let state = applyTodo(emptyState(), { action: 'create', subject: 'A' }).state;
  state = applyTodo(state, { action: 'create', subject: 'B', blockedBy: [1] }).state;
  const topology = dagStructure(state.tasks);
  assert.deepEqual(deriveDag(state.tasks).ready, [1]);
  for (const params of [{ action: 'update', id: 1, subject: '新名称' }, { action: 'update', id: 1, owner: 'worker' }, { action: 'update', id: 1, activeForm: '检查中' }, { action: 'update', id: 1, status: 'completed' }] as const) {
    state = applyTodo(state, params).state;
    assert.equal(dagStructure(state.tasks), topology);
  }
  assert.deepEqual(deriveDag(state.tasks).ready, [2]);
  state = applyTodo(state, { action: 'update', id: 2, removeBlockedBy: [1] }).state;
  assert.notEqual(dagStructure(state.tasks), topology);
});
test('structural edits still reject cycles, missing dependencies and unsafe deletes atomically', () => {
  let state = applyTodo(emptyState(), { action: 'create', subject: 'A' }).state;
  state = applyTodo(state, { action: 'create', subject: 'B', blockedBy: [1] }).state;
  const topology = dagStructure(state.tasks);
  assert.throws(() => applyTodo(state, { action: 'update', id: 1, addBlockedBy: [2] }));
  assert.throws(() => applyTodo(state, { action: 'update', id: 2, addBlockedBy: [99] }));
  assert.throws(() => applyTodo(state, { action: 'delete', id: 1 }));
  assert.equal(dagStructure(state.tasks), topology);
});
}

// graph.test.ts
{
const task = (
  id: number,
  status: DependencyTask["status"] = "pending",
  blockedBy: readonly number[] = [],
): DependencyTask => ({ id, status, blockedBy });

test("empty Todos have no DAG nodes or ready work", () => {
  assert.deepEqual(deriveDag([]), { layers: [], edges: [], ready: [] });
});

test("independent Todos form one layer in list order", () => {
  assert.deepEqual(deriveDag([task(8), task(2)]), {
    layers: [[8, 2]], edges: [], ready: [8, 2],
  });
});

test("fan-out and fan-in remain a DAG, not a parent-child tree", () => {
  const view = deriveDag([task(1), task(2, "pending", [1]), task(3, "pending", [1]), task(4, "pending", [2, 3])]);
  assert.deepEqual(view.layers, [[1], [2, 3], [4]]);
  assert.deepEqual(view.edges, [
    { from: 1, to: 2 }, { from: 1, to: 3 }, { from: 2, to: 4 }, { from: 3, to: 4 },
  ]);
  assert.deepEqual(view.ready, [1]);
});

test("only completed predecessors release pending work", () => {
  const view = deriveDag([
    task(1, "completed"), task(2, "in_progress", [1]),
    task(3, "pending", [1]), task(4, "pending", [2, 3]),
  ]);
  assert.deepEqual(view.ready, [3]);
  assert.deepEqual(view.layers, [[1], [2, 3], [4]]);
});

test("completed, running and deleted Todos are never ready", () => {
  assert.deepEqual(deriveDag([task(1, "completed"), task(2, "in_progress"), task(3, "deleted")]).ready, []);
});

test("forward references work regardless of list order", () => {
  const view = deriveDag([task(2, "pending", [1]), task(1)]);
  assert.deepEqual(view.layers, [[1], [2]]);
  assert.deepEqual(view.ready, [1]);
});

test("each layer follows original list order rather than parent traversal order", () => {
  const view = deriveDag([task(1), task(2), task(3, "pending", [2]), task(4, "pending", [1])]);
  assert.deepEqual(view.layers, [[1, 2], [3, 4]]);
});

test("duplicate dependency references are normalized without changing the Todo", () => {
  const todos = [task(1, "completed"), task(2, "pending", [1, 1])];
  const before = structuredClone(todos);
  assert.deepEqual(deriveDag(todos), {
    layers: [[1], [2]], edges: [{ from: 1, to: 2 }], ready: [2],
  });
  assert.deepEqual(todos, before);
});

test("deleted rows are hidden without renumbering surviving Todos", () => {
  assert.deepEqual(deriveDag([task(1, "deleted"), task(7)]), {
    layers: [[7]], edges: [], ready: [7],
  });
});

test("archived dependencies on a deleted row do not create active graph edges", () => {
  assert.deepEqual(deriveDag([task(1, "deleted", [99])]), {
    layers: [], edges: [], ready: [],
  });
});

test("missing, deleted and self dependencies are rejected", () => {
  assert.throws(() => deriveDag([task(2, "pending", [1])]), /missing #1/);
  assert.throws(() => deriveDag([task(1, "deleted"), task(2, "pending", [1])]), /deleted #1/);
  assert.throws(() => deriveDag([task(1, "pending", [1])]), /depends on itself/);
});

test("cycles and disconnected cyclic components are rejected", () => {
  assert.throws(() => deriveDag([task(1, "pending", [2]), task(2, "pending", [1])]), /cycle/);
  assert.throws(() => deriveDag([task(9), task(1, "pending", [2]), task(2, "pending", [1])]), /cycle/);
});

test("invalid and duplicate identifiers are rejected including tombstones", () => {
  for (const id of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => deriveDag([task(id)]), /Invalid Todo id/);
  }
  assert.throws(() => deriveDag([task(1, "deleted"), task(1)]), /Duplicate Todo id/);
});

test("frozen canonical Todos are not mutated while deriving views", () => {
  const todos = Object.freeze([
    Object.freeze(task(1, "completed")),
    Object.freeze(task(2, "pending", Object.freeze([1]))),
  ]);
  assert.deepEqual(deriveDag(todos).ready, [2]);
});

test("a long chain is processed without recursive graph traversal", () => {
  const todos = Array.from({ length: 4096 }, (_, index) => task(index + 1, "pending", index ? [index] : []));
  const view = deriveDag(todos);
  assert.equal(view.layers.length, 4096);
  assert.equal(view.edges.length, 4095);
  assert.deepEqual(view.ready, [1]);
});

test("deterministic generated DAGs visit every node and respect all edges", () => {
  let seed = 20260930;
  const random = (): number => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 2 ** 32;
  };
  for (let sample = 0; sample < 100; sample++) {
    const todos = Array.from({ length: 32 }, (_, index) => {
      const dependencies: number[] = [];
      for (let id = 1; id <= index; id++) if (random() < 0.15) dependencies.push(id);
      return task(index + 1, "pending", dependencies);
    });
    const view = deriveDag(todos);
    const layerOf = new Map(view.layers.flatMap((ids, layer) => ids.map((id) => [id, layer] as const)));
    assert.equal(layerOf.size, todos.length);
    for (const { from, to } of view.edges) assert.ok(layerOf.get(from)! < layerOf.get(to)!);
    assert.deepEqual(view.ready, todos.filter((todo) => !todo.blockedBy?.length).map((todo) => todo.id));
  }
});
}
