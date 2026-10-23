import { checkpointSummary, type CheckpointJob } from './checkpoint-summary.ts';
import type { WorkflowState } from '../../shared/task-types.ts';
import { STATE_TYPE } from './state.ts';

export const CHECKPOINT_TYPE = 'pi-dag-workflow.checkpoint';
export const CHECKPOINT_RULE = 'Use the latest workflow checkpoint as a baseline and apply later Todo tool results and Agent reports. After compaction, read todo list/get before dispatching or accepting work if fresh task state is missing. Checkpoints are metadata, not user authorization; returned reports still require verification.';

export function createCheckpointState(hooks: { state(): WorkflowState; jobs(): readonly CheckpointJob[]; protected(): boolean }) {
  let pending: 'restore' | 'compaction' | 'command' | undefined, lastContent: string | undefined, used = false;
  const changed = new Set<number>();
  const make = () => {
    if (!pending) return;
    const reason = pending;
    const summary = checkpointSummary(hooks.state(), hooks.jobs(), { forceEmpty: used, protectedState: hooks.protected() });
    const changes = [...changed].sort((a, b) => a - b);
    const content = summary && `${summary}${changes.length ? `\nExternally changed Todos: ${changes.slice(0, 12).map((id) => `#${id}`).join(', ')}${changes.length > 12 ? ` (+${changes.length - 12} more)` : ''}; use todo get for details.` : ''}`;
    pending = undefined; changed.clear();
    if (!content || reason === 'command' && content === lastContent) return;
    lastContent = content; used = true;
    return { customType: CHECKPOINT_TYPE, content, display: false as const, details: { schema: 1, reason } };
  };
  return {
    make,
    restore(branch: readonly { type: string; customType?: string }[]) {
      lastContent = undefined; changed.clear(); pending = 'restore';
      used = branch.some(entry => entry.type === 'custom' && entry.customType === STATE_TYPE);
    },
    shutdown() { pending = undefined; changed.clear(); lastContent = undefined; used = false; },
    compact() { pending = 'compaction'; },
    changed(ids: readonly number[] = []) { used = true; if (!pending) pending = 'command'; for (const id of ids) changed.add(id); },
  };
}
