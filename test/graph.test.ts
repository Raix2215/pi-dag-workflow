import assert from "node:assert/strict";
import { test } from "node:test";
import { deriveDag, type DependencyTask } from "../src/dag/graph.ts";

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
