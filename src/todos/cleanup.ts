import type { ClearScope, Todo } from './state.ts';

export interface TaskCleanup { tasks: Todo[]; removedIds: number[]; keptIds: number[] }
/** Remove eligible records together, retaining the complete prerequisite closure of survivors. */
export function planTaskCleanup(tasks: readonly Todo[], scope: ClearScope, protectedIds: ReadonlySet<number> = new Set(), outcomes?: ReadonlyMap<number, string>): TaskCleanup {
  if (!['all', 'completed', 'closed'].includes(scope)) throw new Error('Unknown cleanup scope');
  const eligible = new Set(tasks.filter((task) => {
    const status = outcomes?.get(task.id) ?? task.status;
    if (scope === 'all') return true;
    if (scope === 'completed') return status === 'completed';
    return ['completed', 'failed', 'cancelled', 'deleted'].includes(status);
  }).map((task) => task.id));
  const removable = new Set([...eligible].filter((id) => !protectedIds.has(id)));
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const queue = tasks.filter((task) => task.status !== 'deleted' && !removable.has(task.id)).map((task) => task.id);
  // Live retained records (including retryable failures) retain their prerequisites.
  // Permanent deleted tombstones never anchor work and may retain historical references.
  for (let index = 0; index < queue.length; index++) {
    for (const id of byId.get(queue[index]!)?.blockedBy ?? []) {
      if (!removable.delete(id)) continue;
      queue.push(id);
    }
  }
  return { tasks: tasks.filter((task) => !removable.has(task.id)), removedIds: tasks.filter((task) => removable.has(task.id)).map((task) => task.id), keptIds: tasks.filter((task) => eligible.has(task.id) && !removable.has(task.id)).map((task) => task.id) };
}
