import { randomUUID } from 'node:crypto';
import type { ExtensionContext } from '@earendil-works/pi-coding-agent';

interface Message { customType: string; content: string; display: false; details: { checkpointId: string } }
type Branch = ReturnType<ExtensionContext['sessionManager']['getBranch']>;
/** A small append-only proposal. Drafting/queueing is not persistence or model acceptance. */
export function passiveMessage(customType: string, content: () => string | undefined, branch?: (ctx: ExtensionContext) => Branch, onSaved?: () => void) {
  let pending = false;
  let revision = 0;
  let recovery = false;
  let lastSaved: string | undefined;
  let proposal: { message: Message; revision: number } | undefined;
  let attemptedAt: object | undefined;
  const confirm = (ctx: ExtensionContext) => {
    if (!proposal) return;
    const id = proposal.message.details.checkpointId;
    if (!(branch?.(ctx) ?? ctx.sessionManager.getBranch()).some((entry) => entry.type === 'custom_message' && entry.customType === customType && (entry.details as { checkpointId?: string } | undefined)?.checkpointId === id)) return;
    lastSaved = proposal.message.content;
    if (proposal.revision === revision) { pending = false; onSaved?.(); }
    proposal = undefined;
  };
  const take = (ctx: ExtensionContext, event?: object): Message | undefined => {
    confirm(ctx);
    if (!pending || event !== undefined && attemptedAt === event) return;
    const text = content();
    if (text === undefined) { pending = false; proposal = undefined; return; }
    if (text === lastSaved) { pending = false; proposal = undefined; onSaved?.(); return; }
    if (!proposal || proposal.revision !== revision || proposal.message.content !== text) proposal = { revision, message: { customType, content: text, display: false, details: { checkpointId: randomUUID() } } };
    attemptedAt = event;
    return proposal.message;
  };
  return {
    mark(force = false) {
      pending = true; revision++; attemptedAt = undefined;
      if (force) { lastSaved = undefined; proposal = undefined; recovery = true; }
    },
    reset(wanted = false) { pending = wanted; revision++; recovery = false; lastSaved = undefined; proposal = undefined; attemptedAt = undefined; },
    take,
    beforeWake(ctx: ExtensionContext, send: (message: Message) => void) { if (ctx.isIdle()) { const message = take(ctx); if (message) send(message); } },
    /** Only a successful compaction arms this request-local append. Never edits old messages. */
    recover(messages: readonly { role?: string; customType?: string; content?: unknown }[], ctx: ExtensionContext, event: object) {
      if (!recovery) return;
      recovery = false;
      const message = take(ctx, event);
      if (!message || messages.some((item) => item.customType === customType && item.content === message.content)) return;
      // This does not clear pending: the next normal boundary persists the then-current content.
      return { role: 'custom' as const, ...message, timestamp: Date.now() };
    },
  };
}
