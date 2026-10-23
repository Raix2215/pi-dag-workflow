import { deriveDag, type DependencyTask, type DagProjection } from './graph.ts';

export interface DagStructure { readonly layers: DagProjection['layers']; readonly edges: DagProjection['edges']; readonly depth: ReadonlyMap<number, number>; readonly order: ReadonlyMap<number, number> }
const cache = new WeakMap<readonly DependencyTask[], DagStructure>();
/** Cache belongs only to immutable canonical Todo snapshots, never a persisted graph. */
export function dagStructure(tasks: readonly DependencyTask[]): DagStructure {
  let value = cache.get(tasks);
  if (!value) {
    const dag = deriveDag(tasks);
    value = { layers: dag.layers, edges: dag.edges, depth: new Map(dag.layers.flatMap((ids, layer) => ids.map((id) => [id, layer] as const))), order: new Map(tasks.map((task, index) => [task.id, index])) };
    cache.set(tasks, value);
  }
  return value;
}
/** Canonical reducers may reuse topology when ids, deletion and dependencies did not change. */
export function reuseDagStructure(before: readonly DependencyTask[], after: readonly DependencyTask[]): boolean {
  if (before.length !== after.length) return false;
  for (let index = 0; index < before.length; index++) {
    const a = before[index]!; const b = after[index]!;
    if (a === b) continue;
    const ad = a.blockedBy ?? []; const bd = b.blockedBy ?? [];
    if (a.id !== b.id || (a.status === 'deleted') !== (b.status === 'deleted') || ad.length !== bd.length || ad.some((id, i) => id !== bd[i])) return false;
  }
  cache.set(after, dagStructure(before));
  return true;
}
