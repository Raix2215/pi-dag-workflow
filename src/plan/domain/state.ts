import { chinese, type Translator } from '../../shared/i18n.ts';
import { WORKFLOW_STATE_TYPE } from '../../shared/state-types.ts';

export const PLAN_TYPE = 'pi-dag-workflow.plan';
export interface PlanState { version: 1; enabled: boolean; tools: string[] }
export const emptyPlanState = (): PlanState => ({ version: 1, enabled: false, tools: [] });
export function restorePlanState(branch: readonly { type: string; customType?: string; data?: unknown }[], msg: Translator = chinese): PlanState {
  const own = branch.findLast((entry) => entry.type === 'custom' && entry.customType === PLAN_TYPE);
  const legacy = !own && branch.findLast((entry) => entry.type === 'custom' && entry.customType === WORKFLOW_STATE_TYPE);
  const old = legacy ? legacy.data as { version?: unknown; plan?: unknown; planTools?: unknown } : undefined;
  const data = own ? structuredClone(own.data) as PlanState : old?.version === 1 && typeof old.plan === 'boolean' ? { version: 1, enabled: old.plan, tools: old.planTools ?? [] } : emptyPlanState();
  // Plan restores only its own fields; a damaged or disabled Todo history is not Plan state.
  if (!data || data.version !== 1 || typeof data.enabled !== 'boolean' || !Array.isArray(data.tools) || data.tools.some((name) => typeof name !== 'string' || !/^[\w-]+$/.test(name))) throw new Error(msg('损坏的 Plan 状态'));
  return data as PlanState;
}
