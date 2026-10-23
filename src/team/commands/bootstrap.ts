import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import type { Translator } from '../../shared/i18n.ts';

const BOOTSTRAP = 'pi-dag-workflow.team-bootstrap';
/** A launcher opt-in, once per new blank session. No ordinary join/reload starts a model turn. */
export function teamBootstrap(pi: ExtensionAPI, hooks: {
  msg: Translator; joined(ctx: ExtensionContext): boolean;
  note(ctx: ExtensionContext, status: 'pending' | 'confirmed' | 'failed'): Promise<boolean>;
}) {
  const { msg } = hooks;
  let timer: ReturnType<typeof setTimeout> | undefined, active: string | undefined;
  const cancel = () => { if (timer) clearTimeout(timer); timer = undefined; active = undefined; };
  pi.registerFlag('team-bootstrap', { type: 'boolean', description: msg('新建空白团队会话首次仅回复确认，不执行工作') });
  const replyLanguage = msg.locale === 'zh-CN' ? 'Simplified Chinese' : 'English';
  const instruction = () => `Team startup confirmation. Your current team, member name and SID are supplied in the local Team membership context. This is a startup acknowledgement, not a work assignment or new authorization. Reply only with a brief acknowledgement in ${replyLanguage}, confirming receipt and readiness for a task. Do not call tools, inspect files, send Team messages, execute work, enable Goals or continue automatically. Stop after this acknowledgement and await further instructions.`;
  pi.on('before_agent_start', (event, ctx) => {
    if (event.messageType !== 'custom') { active = undefined; return; }
    if (event.message.customType === BOOTSTRAP) { active = ctx.sessionManager.getSessionId(); return; }
    // Automatic recovery remains an acknowledgement, not permission to work after an initial failure.
    if (active && event.message.customType !== BOOTSTRAP) return { message: { customType: BOOTSTRAP, content: instruction(), display: false } };
  });
  pi.on('tool_call', (_event, ctx) => {
    if (active !== ctx.sessionManager.getSessionId()) return;
    ctx.abort();
    return { block: true, reason: msg('启动确认只需回复收到；不允许执行工具。') };
  });
  pi.on('agent_settled', async (_event, ctx) => {
    if (active !== ctx.sessionManager.getSessionId()) return;
    const last = ctx.sessionManager.getBranch().findLast(entry => entry.type === 'message' && entry.message.role === 'assistant');
    const message = last?.type === 'message' && last.message.role === 'assistant' ? last.message : undefined;
    const ok = message?.stopReason === 'stop' && message.content.some(part => part.type === 'text' && part.text.trim());
    if (ok) active = undefined;
    await hooks.note(ctx, ok ? 'confirmed' : 'failed');
  });
  return {
    cancel,
    async start(ctx: ExtensionContext) {
      if (pi.getFlag('team-bootstrap') !== true || !hooks.joined(ctx)) return;
      const branch = ctx.sessionManager.getBranch();
      if (branch.some(entry => entry.type === 'custom' && entry.customType === BOOTSTRAP || entry.type === 'message' && entry.message.role === 'assistant')) return;
      pi.appendEntry(BOOTSTRAP, { sessionId: ctx.sessionManager.getSessionId() });
      await hooks.note(ctx, 'pending');
      timer = setTimeout(() => {
        timer = undefined;
        if (!hooks.joined(ctx)) return;
        try {
          pi.sendMessage({ customType: BOOTSTRAP, display: true, content: instruction() }, { triggerTurn: true, deliverAs: 'followUp' });
        } catch { active = undefined; void hooks.note(ctx, 'failed').catch(() => {}); }
      }, 0);
    },
  };
}
