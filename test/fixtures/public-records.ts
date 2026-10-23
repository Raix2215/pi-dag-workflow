// Test data for the public tool parameters and native session-record formats; no source internals.
export const FEATURE_NAMES = ['todos', 'plan', 'agents', 'goal', 'retry', 'team'] as const;
export type Feature = typeof FEATURE_NAMES[number];
export const STATE_TYPE = 'pi-dag-workflow.state';
export const GOAL_TYPE = 'pi-dag-workflow.goal';
export const PLAN_TYPE = 'pi-dag-workflow.plan';
export const AGENTS_TYPE = 'pi-dag-workflow.agents';
export const AGENTS_ENTRY_TYPE = AGENTS_TYPE;
export const CHECKPOINT_TYPE = 'pi-dag-workflow.checkpoint';
export const GOAL_CHECKPOINT_TYPE = 'pi-dag-workflow.goal-checkpoint';
export const RETRY_TYPE = 'pi-dag-workflow.retry';
export const RETRY_MESSAGE = 'pi-dag-workflow.retry.request';
// Message custom types (ticket 15): asserted as literals so the src scan can prove they are defined once.
export const AGENT_REPORT_MESSAGE = 'pi-dag-workflow.agents.report';
export const GOAL_RETRY_MESSAGE = 'pi-dag-workflow.goal.retry';
export const GOAL_CONTINUE_MESSAGE = 'pi-dag-workflow.goal.continue';
export const RETRY_REQUEST_MESSAGE = 'pi-dag-workflow.retry.request';
export const TEAM_MESSAGE = 'pi-dag-workflow.team.message';
export const TEAM_MEMBERSHIP_MESSAGE = 'pi-dag-workflow.team.membership';
export type TodoStatus = 'pending' | 'in_progress' | 'completed' | 'failed' | 'cancelled' | 'deleted';
export interface Todo { id: number; subject: string; status: TodoStatus; blockedBy: number[]; description?: string; activeForm?: string; owner?: string; metadata?: Record<string, any> }
export interface WorkflowState { version: 1; tasks: Todo[]; nextId: number; plan: boolean; planTools: string[]; visible: boolean; view: 'list' | 'dag'; treeStyle?: 'paths' | 'flat'; filter?: 'full' | 'pending' | 'completed' | 'failed' | 'cancelled' }
export interface PlanState { version: 1; enabled: boolean; tools: string[] }
export interface Goal { id: number; title: string; description?: string; status: 'active' | 'paused' | 'completed' | 'deleted'; maxTurns: number; createdAt: number; completedAt?: number; modelPause?: 'allow' | 'deny'; nolimit?: boolean; autoresearch?: boolean }
export interface GoalParams { action: 'create' | 'update' | 'list' | 'get' | 'delete' | 'enable' | 'disable' | 'complete'; id?: number; title?: string; description?: string; maxTurns?: number; progress?: string; nextStep?: string }
export interface GoalRun { paused: boolean; used: number; stalled: number; reason?: string; progress?: string; nextStep?: string; errorRetries?: number; pendingWake?: { id: string; goalId: number; usedBefore: number; nextStep?: string } }
export interface GoalState { version: 1; goals: Goal[]; nextId: number; focusId?: number; run: GoalRun }
export const emptyState = (): WorkflowState => ({ version: 1, tasks: [], nextId: 1, plan: false, planTools: [], visible: true, view: 'list', treeStyle: 'paths' });
export const emptyGoalState = (): GoalState => ({ version: 1, goals: [], nextId: 1, run: { paused: true, used: 0, stalled: 0 } });

/** Decode the published v1 snapshot / v2 output-tail record format for assertions. */
export function retainedJobs(entries: readonly any[]) {
  const records = new Map<string, any>();
  let nextId: number | undefined;
  for (const entry of entries) {
    if (entry.type !== 'custom' || entry.customType !== AGENTS_TYPE) continue;
    const data = entry.data;
    if (data.version === 1) records.clear();
    for (const id of data.removed ?? []) records.delete(id);
    for (const delta of data.jobs ?? []) {
      const previous = records.get(delta.id);
      const { outputAppend, offset: _offset, ...fields } = delta;
      const savedInputs = previous && { assignment: previous.assignment, taskDefinition: previous.taskDefinition, profileInstructions: previous.profileInstructions };
      records.set(delta.id, { ...savedInputs, ...fields, output: outputAppend === undefined ? fields.output ?? previous?.output ?? '' : previous.output + outputAppend });
    }
    if (data.nextId !== undefined) nextId = data.nextId;
  }
  return { records: [...records.values()], nextId };
}
