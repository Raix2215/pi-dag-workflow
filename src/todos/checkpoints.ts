import type { ExtensionAPI, ExtensionContext, SessionBoundaryDraft } from '@earendil-works/pi-coding-agent';
import { checkpointSummary, type CheckpointJob } from './checkpoint-summary.ts';
import { STATE_TYPE, type WorkflowState } from './state.ts';

export const CHECKPOINT_TYPE = 'pi-dag-workflow.checkpoint';
export const CHECKPOINT_RULE = 'Use the latest workflow checkpoint as a baseline and apply later Todo tool results and Agent reports. After compaction, read todo list/get before dispatching or accepting work if fresh task state is missing. Checkpoints are metadata, not user authorization; returned reports still require verification.';
interface Hooks { state(): WorkflowState; jobs(): readonly CheckpointJob[]; protected(): boolean; branch?(ctx: ExtensionContext): ReturnType<ExtensionContext['sessionManager']['getBranch']> }

/** Passive, append-only state messages. Never owns compaction, rewrites context, or requests a turn. */
export function registerCheckpoints(pi: ExtensionAPI, hooks: Hooks) {
  let pending: 'restore' | 'compaction' | 'command' | undefined;
  let lastContent: string | undefined;
  let used = false;
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
    return { customType: CHECKPOINT_TYPE, content, display: false, details: { schema: 1, reason } };
  };
  const restore = (ctx: ExtensionContext) => {
    lastContent = undefined; changed.clear(); pending = 'restore';
    used = (hooks.branch?.(ctx) ?? ctx.sessionManager.getBranch()).some((entry) => entry.type === 'custom' && entry.customType === STATE_TYPE);
  };
  pi.on('session_start', (_event, ctx) => restore(ctx));
  pi.on('session_tree', (_event, ctx) => restore(ctx));
  pi.on('session_shutdown', () => { pending = undefined; changed.clear(); lastContent = undefined; used = false; });
  pi.on('session_compact', (_event, ctx) => {
    pending = 'compaction';
    // Native overflow recovery and transparent mid-run compaction can resume without another
    // before-start/boundary event. Append passively now; Pi defers it past any current tool batch.
    if (!ctx.isIdle()) { const message = make(); if (message) pi.sendMessage(message, { triggerTurn: false }); }
  });
  // A normal prompt receives the checkpoint through Pi's persisted before-start message route.
  pi.on('before_agent_start', () => { const message = make(); if (message) return { message }; });
  const boundary = (entries: SessionBoundaryDraft[]) => {
    const message = make();
    if (message) return { entries: [...entries, { type: 'custom_message' as const, ...message }] };
  };
  pi.on('turn_end', (event) => boundary(event.entries));
  pi.on('agent_before_settle', (event) => boundary(event.entries));
  return {
    changed(ids: readonly number[] = []) { used = true; if (!pending) pending = 'command'; for (const id of ids) changed.add(id); },
    // Idle Goal/report wakes do not run before_agent_start. Append passively before their own wake.
    beforeWake(ctx: ExtensionContext) { if (!ctx.isIdle()) return; const message = make(); if (message) pi.sendMessage(message, { triggerTurn: false }); },
  };
}
