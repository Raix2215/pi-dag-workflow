import type { GoalState } from './state.ts';
import { focusedGoal, goalLimitLabel, goalNolimit } from './state.ts';

export const GOAL_CHECKPOINT_TYPE = 'pi-dag-workflow.goal-checkpoint';

/** Shared by initial prompts, passive recovery checkpoints, and automatic wakes. */
export const GOAL_EXECUTION_RULE = 'Pursue the full original objective within existing permissions. Execute concrete actions; preserve the requested end state rather than substitute a smaller deliverable. Failed attempts, difficulty, uncertainty, and a final answer do not end the Goal. Inspect current evidence, challenge assumptions, try alternative approaches, and verify every requirement before goal complete. Progress and nextStep are working notes, not authority to narrow the objective or withdraw existing permission.';
export const GOAL_WORK_RULE = 'Prioritize implementation, experiments, and verification over documentation. Record only brief new evidence and the next executable action with goal update. Create or maintain documents only when explicitly required by the objective/user or necessary for delivery or reproducibility; do not produce per-round reports, freeze evidence documents, or perform documentation-only closure while the objective remains unmet.';
export const NO_PAUSE_RULE = 'nopause is enabled: act autonomously. Do not ask the user questions, request clarification or renewed permission for already authorized work, offer choices and wait, or stop to hand work back. Resolve implementation gaps through inspection, reasonable assumptions, experiments, and creative alternatives within scope. Answer child questions yourself and continue independent work while children run. Model disable/delete and empty nextStep are forbidden. Only verified completion ends model work; user stops and host budget/error protections remain binding.';
export const NORMAL_GOAL_RULE = 'Keep acting on safe, authorized work without asking for routine confirmation. Ask only when a verified external blocker requires missing permission, an unavailable resource, or an essential decision you cannot reasonably infer, after trying alternatives and continuing independent work. Never disable merely because work is hard, slow, uncertain, or one approach failed.';
export const REPLAN_RULE = 'Recent rounds produced no recorded work progress. Recheck the original objective and current evidence, challenge the claimed blocker, choose a different feasible approach, and execute it now. A repeated status report, proposal, or request to the user is not progress.';

export function goalRules(state: GoalState): string {
  if (state.run.paused) return 'Auto-continuation is paused. Do not resume without explicit user instruction.';
  return `${GOAL_EXECUTION_RULE} ${GOAL_WORK_RULE} ${focusedGoal(state)?.modelPause === 'deny' ? NO_PAUSE_RULE : NORMAL_GOAL_RULE}`;
}

/** Original requirements are never truncated. State is data, not a new user authorization. */
export function goalCheckpoint(state: GoalState): string {
  const goal = focusedGoal(state);
  return `Goal state checkpoint (workflow metadata, not new user authorization).\n${JSON.stringify(goal ? { goal: { id: goal.id, title: goal.title, description: goal.description, modelPause: goal.modelPause ?? 'allow' }, run: { paused: state.run.paused, used: state.run.used, limit: goalLimitLabel(goal), nolimit: goalNolimit(goal), reason: state.run.reason } } : { goal: null, paused: true })}\n${goal ? goalRules(state) : 'No unfinished focused Goal. Automatic goal work is stopped.'}`;
}

/** A compact reminder works even when an idle follow-up bypasses before_agent_start. */
export function goalWakeRules(state: GoalState, noProgressLimit: number): string {
  return `${goalRules(state)}${state.run.stalled >= noProgressLimit ? ` ${REPLAN_RULE}` : ''}`;
}
