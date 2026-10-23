import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import type { WorkflowState } from '../../shared/task-types.ts';
import { chinese, type Translator } from '../../shared/i18n.ts';
import { notify } from '../../shared/terminal.ts';
import { passiveMessage } from '../../shared/passive-message.ts';
import { appendPlanRecord } from '../io/records.ts';
import { PLAN_TYPE, emptyPlanState, restorePlanState } from './state.ts';

interface Hooks {
  msg?: Translator;
  api(): ExtensionAPI;
  branch(ctx: ExtensionContext): ReturnType<ExtensionContext['sessionManager']['getBranch']>;
  todos(): boolean;
  goal(): boolean;
  paint(ctx: ExtensionContext): void;
  saved(ctx: ExtensionContext): void;
  modeChanged(ctx: ExtensionContext): void;
}
export function createPlanOwner(hooks: Hooks) {
  const msg = hooks.msg ?? chinese;
  let plan = emptyPlanState(), error: string | undefined, notice = false;
  const guidance = passiveMessage('pi-dag-workflow.guidance', () => notice ? plan.enabled
    ? `Plan: read/search/ask${hooks.todos() ? ' and edit Todo definitions' : ''} only. No implementation, shell, task start/complete or dispatch; only the user may /plan off.${hooks.goal() ? ' Goal is paused.' : ''}`
    : `Normal:${hooks.todos() ? ' continue the existing Todo list.' : ' implementation is available.'}${hooks.goal() ? ' Goal stays paused until explicitly enabled.' : ''}` : undefined, hooks.branch, () => { notice = false; });
  function restore(ctx: ExtensionContext) {
    try { plan = restorePlanState(hooks.branch(ctx), msg); error = undefined; }
    catch (cause) { plan = { ...emptyPlanState(), enabled: true }; error = String(cause); notify(ctx, msg('Plan 状态不可读，保持只读保护；/plan settings 可查看'), 'error'); }
    notice = plan.enabled || hooks.branch(ctx).some(entry => entry.type === 'custom' && entry.customType === PLAN_TYPE);
    guidance.reset(notice);
  }
  function commit(next: WorkflowState, ctx: ExtensionContext) {
    if (error) throw new Error(error);
    if (next.plan === plan.enabled && next.planTools === plan.tools) return;
    const changedMode = next.plan !== plan.enabled;
    const value = { version: 1 as const, enabled: next.plan, tools: [...next.planTools] };
    appendPlanRecord(hooks.api(), PLAN_TYPE, value); plan = value;
    if (changedMode) { hooks.modeChanged(ctx); notice = true; guidance.mark(); }
    hooks.paint(ctx); hooks.saved(ctx);
  }
  return {
    restore, commit,
    state: () => plan,
    error: () => error,
    protected: () => !!error,
    reset() { plan = emptyPlanState(); error = undefined; notice = false; guidance.reset(); },
    compact(ctx: ExtensionContext) { if (plan.enabled || hooks.branch(ctx).some(entry => entry.type === 'custom' && entry.customType === PLAN_TYPE)) { notice = true; guidance.mark(true); } },
    take: guidance.take,
    recover: guidance.recover,
    beforeWake(ctx: ExtensionContext, send: Parameters<typeof guidance.beforeWake>[1]) { guidance.beforeWake(ctx, send); },
  };
}
