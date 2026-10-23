import type { ExtensionAPI, ExtensionContext, SessionBoundaryDraft } from '@earendil-works/pi-coding-agent';
import type { CheckpointJob } from '../domain/checkpoint-summary.ts';
import type { WorkflowState } from '../../shared/task-types.ts';
import { createCheckpointState } from '../domain/checkpoint-state.ts';
import { sendCheckpoint } from '../io/records.ts';

export { CHECKPOINT_TYPE, CHECKPOINT_RULE } from '../domain/checkpoint-state.ts';
interface Hooks { state(): WorkflowState; jobs(): readonly CheckpointJob[]; protected(): boolean; branch?(ctx: ExtensionContext): ReturnType<ExtensionContext['sessionManager']['getBranch']> }

export function registerCheckpoints(pi: ExtensionAPI, hooks: Hooks) {
  const state = createCheckpointState(hooks);
  const restore = (ctx: ExtensionContext) => state.restore(hooks.branch?.(ctx) ?? ctx.sessionManager.getBranch());
  pi.on('session_start', (_event, ctx) => restore(ctx));
  pi.on('session_tree', (_event, ctx) => restore(ctx));
  pi.on('session_shutdown', () => state.shutdown());
  pi.on('session_compact', (_event, ctx) => {
    state.compact();
    if (!ctx.isIdle()) { const message = state.make(); if (message) sendCheckpoint(pi, message); }
  });
  pi.on('before_agent_start', () => { const message = state.make(); if (message) return { message }; });
  const boundary = (entries: SessionBoundaryDraft[]) => {
    const message = state.make();
    if (message) return { entries: [...entries, { type: 'custom_message' as const, ...message }] };
  };
  pi.on('turn_end', event => boundary(event.entries));
  pi.on('agent_before_settle', event => boundary(event.entries));
  return {
    changed: state.changed,
    beforeWake(ctx: ExtensionContext) { if (!ctx.isIdle()) return; const message = state.make(); if (message) sendCheckpoint(pi, message); },
  };
}
