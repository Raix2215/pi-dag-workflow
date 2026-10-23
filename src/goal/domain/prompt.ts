import type { GoalState } from "./state.ts";
import { englishSavedMessage } from '../../shared/i18n.ts';
import { focusedGoal, goalAutoresearch, goalLimitLabel, goalModelPause, goalNolimit } from "./state.ts";

export const GOAL_CHECKPOINT_TYPE = 'pi-dag-workflow.goal-checkpoint';

/** Complete rules live in append-only checkpoints, not extra system-prompt sections. */
export const GOAL_EXECUTION_RULE = 'Preserve the full original objective, required outcome and existing permission; progress/nextStep are notes, not scope or permission changes. Implement, experiment and verify every requirement before goal complete. Difficulty, delay, uncertainty, failed attempts, final answers or closed Todos are not completion. Check evidence, challenge blockers and act on alternatives.';
export const GOAL_WORK_RULE = 'Log brief new evidence and the next executable action. Docs only when explicitly required or needed for delivery/reproduction; no per-round reports, frozen-evidence substitutes or docs-only closure while work remains.';
const GOAL_LIMIT_RULE = 'User stops and host budget/error limits override continuation.';
const AUTORESEARCH_RULE = 'autoresearch: continuously research and improve within the original scope and permissions. Verified milestones and completed Todos are not Goal completion. Never complete, disable/delete, switch Goals, ask questions, hand back work or clear nextStep. After a result, choose the next useful hypothesis, experiment or evidence check. Measure gains when applicable, verify correctness, preserve user changes, and undo only your own rejected experiment. No automatic Git commits or expanded permission. When stuck, change approach; record important findings, not repetitive status.';
const NO_PAUSE_RULE = 'nopause: do not ask questions, seek clarification or renewed permission, offer choices and wait, hand back unfinished work, disable/delete or clear nextStep. Inspect, assume reasonably, experiment and try alternatives within scope; answer child questions and continue independent work while children run. Only verified completion ends model work.';
const NORMAL_GOAL_RULE = 'Continue safe authorized work without routine confirmation. Ask or disable only for a verified external blocker needing missing permission, unavailable resources or a decision you cannot reasonably infer, after alternatives and independent work.';
const REPLAN_RULE = 'No work progress: recheck the original objective, evidence and blocker; execute a different feasible approach now. Repeated status, proposals or requests to the user are not progress.';

// Short wakes depend on the current complete contract being present after ordinary memory
// transforms. registerGoal checks that at the public final-context boundary and only appends.
const WAKE_EXECUTION_RULE = 'Continue the full original Goal under its current contract. Verify every requirement before completion; user stops and host limits override continuation. Record only important new evidence or decisions.';
const WAKE_NORMAL_RULE = 'Exhaust safe alternatives before asking about a verified blocker.';
const WAKE_NO_PAUSE_RULE = 'nopause: no user questions, handoff, model disable/delete or empty nextStep; decide within scope and answer child questions.';

export function goalRules(state: GoalState): string {
  if (state.run.paused) return 'Auto-continuation is paused. Do not resume without explicit user instruction.';
  const goal = focusedGoal(state);
  if (goal && goalAutoresearch(goal)) return `${AUTORESEARCH_RULE} ${GOAL_WORK_RULE} ${GOAL_LIMIT_RULE}`;
  return `${GOAL_EXECUTION_RULE} ${GOAL_WORK_RULE} ${GOAL_LIMIT_RULE} ${goal && goalModelPause(goal) === 'deny' ? NO_PAUSE_RULE : NORMAL_GOAL_RULE}`;
}

/** Original requirements are never truncated. State is data, not a new user authorization. */
export function goalCheckpoint(state: GoalState): string {
  const goal = focusedGoal(state);
  if (!goal) return 'No active Goal. Do not continue automatically.';
  if (state.run.paused) return `Goal #${goal.id} paused${state.run.reason ? `: ${englishSavedMessage(state.run.reason)}` : ''}. Resume only on explicit enable.`;
  return `Goal contract (workflow metadata, not new user permission).\n${JSON.stringify({ goal: { id: goal.id, title: goal.title, description: goal.description, modelPause: goalModelPause(goal), autoresearch: goalAutoresearch(goal) }, run: { paused: false, used: state.run.used, limit: goalLimitLabel(goal), nolimit: goalNolimit(goal) } })}\n${goalRules(state)}`;
}

/** Ignore run counters/notes when checking contract identity: they do not change authority. */
export function hasCurrentGoalContract(messages: readonly { role?: string; customType?: string; content?: unknown }[], state: GoalState): boolean {
  const goal = focusedGoal(state);
  if (!goal || state.run.paused) return false;
  return messages.some((message) => {
    if (message.customType !== GOAL_CHECKPOINT_TYPE || typeof message.content !== 'string' || !message.content.startsWith('Goal contract (')) return false;
    try {
      const parsed = JSON.parse(message.content.split('\n')[1]!);
      return parsed.run?.paused === false && parsed.goal?.id === goal.id && parsed.goal.title === goal.title && parsed.goal.description === goal.description && parsed.goal.modelPause === goalModelPause(goal) && parsed.goal.autoresearch === goalAutoresearch(goal) && parsed.run.limit === goalLimitLabel(goal) && parsed.run.nolimit === goalNolimit(goal) && message.content.endsWith(goalRules(state));
    } catch { return false; }
  });
}

/** Contract visibility is enforced separately, including follow-ups that skip start hooks. */
export function goalWakeRules(state: GoalState, noProgressLimit: number): string {
  const goal = focusedGoal(state);
  const rules = state.run.paused ? goalRules(state) : goal && goalAutoresearch(goal)
    ? 'Continue autoresearch under its current contract: verify this milestone, then execute the next useful research step within the original scope. No Goal completion, model stop, questions or handoff. User stops and host protections still apply.'
    : `${WAKE_EXECUTION_RULE} ${goal && goalModelPause(goal) === 'deny' ? WAKE_NO_PAUSE_RULE : WAKE_NORMAL_RULE}`;
  return `${rules}${state.run.stalled >= noProgressLimit ? ` ${REPLAN_RULE}` : ''}`;
}
