import type { Goal, GoalState, ModelPausePolicy } from './state.ts';

/** User-owned continuous mode overlays ordinary controls without replacing their saved values. */
export const goalAutoresearch = (goal: Pick<Goal, 'autoresearch'>): boolean => goal.autoresearch === true;
export const goalModelPause = (goal: Pick<Goal, 'modelPause' | 'autoresearch'>): ModelPausePolicy => goalAutoresearch(goal) ? 'deny' : goal.modelPause ?? 'allow';
export const goalNolimit = (goal: Pick<Goal, 'nolimit' | 'autoresearch'>): boolean => goalAutoresearch(goal) || goal.nolimit === true;
export const goalLimitLabel = (goal: Pick<Goal, 'nolimit' | 'maxTurns' | 'autoresearch'>): string => goalNolimit(goal) ? '∞' : String(goal.maxTurns);
export const goalBudgetSpent = (state: Pick<GoalState, 'run'>, goal: Pick<Goal, 'nolimit' | 'maxTurns' | 'autoresearch'>): boolean => !goalNolimit(goal) && state.run.used >= goal.maxTurns;
