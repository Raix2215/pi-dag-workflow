/** Minimal input shared by Todo validation and the two derived task views. */
export interface DependencyTask {
  readonly id: number;
  readonly status: "pending" | "in_progress" | "completed" | "deleted";
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
      if (id === task.id) throw new Error(`Todo #${task.id} depends on itself`);
      const dependency = byId.get(id);
      if (!dependency) throw new Error(`Todo #${task.id} depends on missing #${id}`);
      if (dependency.status === "deleted") {
        throw new Error(`Todo #${task.id} depends on deleted #${id}`);
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
