/** Minimal input shared by Todo validation and the two derived task views. */
export interface DependencyTask {
  readonly id: number;
  readonly status: "pending" | "in_progress" | "completed" | "failed" | "cancelled" | "deleted";
  readonly blockedBy?: readonly number[];
}

/** Ephemeral projection: never a second task store or a dispatch queue. */
export interface DagProjection {
  readonly layers: readonly (readonly number[])[];
  readonly edges: readonly { readonly from: number; readonly to: number }[];
  readonly ready: readonly number[];
}

/** Validate dependency edges, then derive stable topological layers from current Todos. */
export function deriveDag(tasks: readonly DependencyTask[]): DagProjection {
  const byId = new Map<number, DependencyTask>();
  for (const task of tasks) {
    if (!Number.isSafeInteger(task.id) || task.id < 1) {
      throw new Error(`Invalid Todo id: ${task.id}`);
    }
    if (byId.has(task.id)) throw new Error(`Duplicate Todo id: #${task.id}`);
    byId.set(task.id, task);
  }

  const visible = tasks.filter((task) => task.status !== "deleted");
  const order = new Map(visible.map((task, index) => [task.id, index]));
  const incoming = new Map(visible.map((task) => [task.id, 0]));
  const outgoing = new Map(visible.map((task) => [task.id, [] as number[]]));
  const edges: { from: number; to: number }[] = [];
  const ready: number[] = [];

  for (const task of visible) {
    const predecessors = new Set(task.blockedBy ?? []);
    let predecessorsCompleted = true;
    for (const id of predecessors) {
      if (id === task.id) throw new Error(`Task #${task.id} depends on itself`);
      const dependency = byId.get(id);
      if (!dependency) throw new Error(`Task #${task.id} depends on missing #${id}`);
      if (dependency.status === "deleted") {
        throw new Error(`Task #${task.id} depends on deleted #${id}`);
      }
      predecessorsCompleted &&= dependency.status === "completed";
      incoming.set(task.id, incoming.get(task.id)! + 1);
      outgoing.get(id)!.push(task.id);
      edges.push({ from: id, to: task.id });
    }
    if (task.status === "pending" && predecessorsCompleted) ready.push(task.id);
  }

  const layers: number[][] = [];
  let layer = visible.filter((task) => incoming.get(task.id) === 0).map((task) => task.id);
  let visited = 0;
  while (layer.length > 0) {
    layers.push(layer);
    visited += layer.length;
    const next: number[] = [];
    for (const id of layer) {
      for (const successor of outgoing.get(id)!) {
        const remaining = incoming.get(successor)! - 1;
        incoming.set(successor, remaining);
        if (remaining === 0) next.push(successor);
      }
    }
    layer = next.sort((a, b) => order.get(a)! - order.get(b)!);
  }
  if (visited !== visible.length) throw new Error("Todo dependencies contain a cycle");

  return { layers, edges, ready };
}

/** A direct edge that an unfinished path already implies, so it carries no extra ordering. */
export interface RedundantEdge {
  readonly from: number;
  readonly to: number;
  readonly via: readonly number[];
}

/**
 * Edges this definition change makes redundant. An edge is redundant when a longer path already
 * orders its two ends through unfinished nodes: completed nodes cannot prove the block is gone, and
 * `failed`/`cancelled` are not acceptance. Only newly added edges, and old edges whose alternative
 * path now runs through a new one, are reported — an old redundancy is not the caller's problem.
 */
export function newRedundantEdges(before: readonly DependencyTask[], after: readonly DependencyTask[]): RedundantEdge[] {
  const previous = new Map(before.map((task) => [task.id, new Set(task.blockedBy ?? [])]));
  const visible = after.filter((task) => task.status !== 'deleted');
  const unfinished = new Set(visible.filter((task) => task.status !== 'completed').map((task) => task.id));
  const outgoing = new Map<number, number[]>(visible.map((task) => [task.id, []]));
  const incoming = new Map<number, number[]>(visible.map((task) => [task.id, []]));
  const fresh = new Set<string>();
  for (const task of visible) {
    for (const from of new Set(task.blockedBy ?? [])) {
      outgoing.get(from)?.push(task.id);
      incoming.get(task.id)?.push(from);
      if (!previous.get(task.id)?.has(from)) fresh.add(`${from}>${task.id}`);
    }
  }
  // A write that adds no edge cannot make an edge newly redundant. Titles, statuses, deletions and
  // any other edit that leaves the edges alone return here without walking the graph.
  if (!fresh.size) return [];

  /**
   * Reachability from one source over the product of "which node" and "this path already used a new
   * edge": one visit per state instead of enumerating every simple path, which is what made a legal
   * diamond graph take seconds. Only unfinished nodes carry a path, so a completed node never stands
   * in for a block that is really still there. The graph is acyclic (deriveDag rejects cycles), so
   * visiting a state once is exact.
   */
  interface ReachTable { zero: Set<number>; used: Set<number>; parent: Map<string, { node: number; used: boolean }> }
  const stateKey = (node: number, used: boolean): string => `${node}:${used ? 1 : 0}`;
  const tables = new Map<number, ReachTable>();
  const tableFor = (source: number): ReachTable => {
    const cached = tables.get(source);
    if (cached) return cached;
    const zero = new Set<number>(), used = new Set<number>();
    const parent = new Map<string, { node: number; used: boolean }>();
    const queue: { node: number; used: boolean }[] = [];
    const reach = (node: number, from: number, fromUsed: boolean, grew: boolean): void => {
      const trail = fromUsed || grew;
      if (parent.has(stateKey(node, trail))) return;
      parent.set(stateKey(node, trail), { node: from, used: fromUsed });
      (trail ? used : zero).add(node);
      queue.push({ node, used: trail });
    };
    for (const next of outgoing.get(source) ?? []) if (unfinished.has(next)) reach(next, source, false, fresh.has(`${source}>${next}`));
    for (let at = 0; at < queue.length; at += 1) {
      const current = queue[at]!;
      for (const next of outgoing.get(current.node) ?? []) if (unfinished.has(next)) reach(next, current.node, current.used, fresh.has(`${current.node}>${next}`));
    }
    const table: ReachTable = { zero, used, parent };
    tables.set(source, table);
    return table;
  };

  /** Follow the recorded predecessors back to `source`: one concrete path, not a search. */
  const witness = (table: ReachTable, source: number, end: number, endUsed: boolean): number[] | undefined => {
    const trail: number[] = [];
    let node = end, used = endUsed;
    while (node !== source) {
      trail.push(node);
      const step = table.parent.get(stateKey(node, used));
      if (!step) return undefined;
      node = step.node;
      used = step.used;
    }
    return trail.reverse();
  };

  const redundant: RedundantEdge[] = [];
  for (const task of visible) {
    for (const from of new Set(task.blockedBy ?? [])) {
      // A new edge is redundant on any longer unfinished path; an older edge only when that path
      // now runs through one of the new edges.
      const isNewEdge = fresh.has(`${from}>${task.id}`);
      const table = tableFor(from);
      let via: number[] | undefined;
      for (const node of incoming.get(task.id) ?? []) {
        if (node === from) continue;
        const reachedFresh = table.used.has(node), reachedPlain = table.zero.has(node);
        if (!reachedFresh && !reachedPlain) continue;
        if (!isNewEdge && !reachedFresh && !fresh.has(`${node}>${task.id}`)) continue;
        const found = witness(table, from, node, reachedFresh);
        if (found && found.length > 0) { via = found; break; }
      }
      if (via) redundant.push({ from, to: task.id, via });
    }
  }
  return redundant;
}
