import { Type, type Static } from 'typebox';
import { chinese, type Translator } from '../shared/i18n.ts';

export const GoalParamsSchema = Type.Object({
  action: Type.Union([Type.Literal('create'), Type.Literal('update'), Type.Literal('list'), Type.Literal('get'), Type.Literal('delete'), Type.Literal('enable'), Type.Literal('disable'), Type.Literal('focus'), Type.Literal('switch'), Type.Literal('resume'), Type.Literal('pause'), Type.Literal('complete')]),
  id: Type.Optional(Type.Integer({ minimum: 1 })),
  title: Type.Optional(Type.String({ description: 'Short title; create requires it' })),
  description: Type.Optional(Type.String({ description: 'Objective and acceptance criteria' })),
  maxTurns: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })),
  progress: Type.Optional(Type.String({ description: 'Update: brief new verified progress, including research without Todos' })),
  nextStep: Type.Optional(Type.String({ description: 'Update: concrete next action; empty means wait for the user' })),
}, { additionalProperties: false });
export type GoalParams = Static<typeof GoalParamsSchema>;
export interface Goal { id: number; title: string; description?: string; status: 'active' | 'paused' | 'completed' | 'deleted'; maxTurns: number; createdAt: number; completedAt?: number }
export interface GoalRun { paused: boolean; used: number; stalled: number; reason?: string; progress?: string; nextStep?: string }
export interface GoalState { version: 1; goals: Goal[]; nextId: number; focusId?: number; run: GoalRun }
export const GOAL_TYPE = 'pi-dag-workflow.goal';
export const GOAL_DEFAULT_TURNS = 20;
export const emptyGoalState = (): GoalState => ({ version: 1, goals: [], nextId: 1, run: { paused: true, used: 0, stalled: 0 } });
export const focusedGoal = (state: GoalState): Goal | undefined => state.goals.find((goal) => goal.id === state.focusId && !['completed', 'deleted'].includes(goal.status));
export const activates = (action: GoalParams['action']): boolean => ['enable', 'focus', 'switch', 'resume'].includes(action);
export const stops = (action: GoalParams['action']): boolean => ['disable', 'pause', 'complete', 'delete'].includes(action);
function text(value: unknown, field: string, bytes: number, required = false, msg: Translator = chinese): asserts value is string {
  if (typeof value !== 'string' || Buffer.byteLength(value) > bytes || required && !value.trim()) throw new Error(msg`${field} 需为${required ? msg('非空') : ''}文本，最多 ${bytes} 字节`);
}
export function validateGoalState(state: GoalState, msg: Translator = chinese): void {
  if (!state || state.version !== 1 || !Array.isArray(state.goals) || !Number.isSafeInteger(state.nextId) || state.nextId < 1) throw new Error(msg('不支持或损坏的 Goal 状态'));
  const ids = new Set<number>();
  let active = 0;
  for (const goal of state.goals) {
    if (!goal || !Number.isSafeInteger(goal.id) || goal.id < 1 || goal.id >= state.nextId || ids.has(goal.id)) throw new Error(msg('损坏或重复的目标编号'));
    ids.add(goal.id); text(goal.title, 'title', 1024, true, msg);
    if (Array.from(goal.title).length > 80) throw new Error(msg('目标标题最多 80 个字符'));
    if (goal.description !== undefined) text(goal.description, 'description', 8192, false, msg);
    if (!['active', 'paused', 'completed', 'deleted'].includes(goal.status) || !Number.isSafeInteger(goal.maxTurns) || goal.maxTurns < 1 || goal.maxTurns > 200 || !Number.isFinite(goal.createdAt)) throw new Error(msg('损坏的目标状态／预算'));
    if (goal.completedAt !== undefined && !Number.isFinite(goal.completedAt)) throw new Error(msg('损坏的完成时间'));
    if (goal.status === 'active') { active++; if (state.focusId !== goal.id) throw new Error(msg('只有 focus 目标可以启用')); }
  }
  if (active > 1 || state.focusId !== undefined && (!Number.isSafeInteger(state.focusId) || !focusedGoal(state))) throw new Error(msg('损坏的 focus 目标'));
  const run = state.run;
  if (!run || typeof run.paused !== 'boolean' || !Number.isSafeInteger(run.used) || run.used < 0 || !Number.isSafeInteger(run.stalled) || run.stalled < 0 || !run.paused && focusedGoal(state)?.status !== 'active') throw new Error(msg('损坏的 Goal 续跑状态'));
  if (run.reason !== undefined) text(run.reason, 'reason', 2048, false, msg);
  if (run.progress !== undefined) text(run.progress, 'progress', 2048, false, msg);
  if (run.nextStep !== undefined) text(run.nextStep, 'nextStep', 2048, false, msg);
}
const fields: Record<GoalParams['action'], string[]> = {
  create: ['title', 'description', 'maxTurns'], update: ['id', 'title', 'description', 'maxTurns', 'progress', 'nextStep'], list: [], get: ['id'], delete: ['id'], enable: ['id'], disable: ['id'], focus: ['id'], switch: ['id'], resume: ['id'], pause: ['id'], complete: ['id'],
};
export function applyGoal(state: GoalState, params: GoalParams, defaultTurns = GOAL_DEFAULT_TURNS, msg: Translator = chinese): { state: GoalState; text: string } {
  const allowed = fields[params.action];
  if (!allowed) throw new Error(msg('未知 Goal 操作'));
  for (const key of Object.keys(params)) if (key !== 'action' && !allowed.includes(key)) throw new Error(msg`${params.action} 不接受字段 ${key}`);
  const current = state.goals.find((goal) => goal.id === (params.id ?? state.focusId));
  if (params.action !== 'create' && params.action !== 'list' && !current) throw new Error(msg('找不到目标；请给出 id'));
  if (params.action === 'list') {
    const content = state.goals.filter((goal) => goal.status !== 'deleted').map((goal) => {
      const label = goal.id === state.focusId && state.run.paused ? '暂停' : { active: '活动', paused: '暂停', completed: '已完成', deleted: '已删除' }[goal.status];
      return `#${goal.id}${goal.id === state.focusId ? ' 󰓾' : ''} [${msg(label)}] ${goal.title}`;
    }).join('\n') || msg('暂无目标');
    return { state, text: content };
  }
  if (params.action === 'get') return { state, text: JSON.stringify({ goal: current, ...(current!.id === state.focusId ? { run: state.run } : {}) }) };
  if (current?.status === 'deleted' && params.action !== 'create') throw new Error(msg('目标已删除'));
  const next = structuredClone(state);
  if (params.action === 'create') {
    text(params.title, 'title', 1024, true, msg);
    next.goals.push({ id: next.nextId++, title: params.title.trim(), status: 'paused', maxTurns: params.maxTurns ?? defaultTurns, createdAt: Date.now(), ...(params.description !== undefined ? { description: params.description } : {}) });
  } else {
    const goal = next.goals.find((item) => item.id === current!.id)!;
    if (params.action === 'update') {
      if (Object.keys(params).every((key) => key === 'action' || key === 'id')) throw new Error(msg('update 需要修改字段'));
      if (params.title !== undefined) { text(params.title, 'title', 1024, true, msg); goal.title = params.title.trim(); }
      if (params.description !== undefined) goal.description = params.description;
      if (params.maxTurns !== undefined) goal.maxTurns = params.maxTurns;
      if (params.progress !== undefined || params.nextStep !== undefined) {
        if (goal.id !== next.focusId || next.run.paused) throw new Error(msg('先启用此目标，再报告进展／下一步'));
        if (params.progress !== undefined) next.run.progress = params.progress;
        if (params.nextStep !== undefined) next.run.nextStep = params.nextStep;
      }
    } else if (activates(params.action)) {
      if (goal.status === 'completed') throw new Error(msg('已完成目标不能重启；新建目标记录返工'));
      // Repeating enable/focus on an already-running goal does not refill its budget.
      if (next.focusId === goal.id && !next.run.paused) return { state, text: msg`目标 #${goal.id} 已启用；预算不重置` };
      for (const item of next.goals) if (item.status === 'active') item.status = 'paused';
      goal.status = 'active'; next.focusId = goal.id;
      next.run = { paused: false, used: 0, stalled: 0, nextStep: msg`推进目标：${goal.title}` };
    } else if (params.action === 'disable' || params.action === 'pause') {
      if (goal.status === 'completed') throw new Error(msg('已完成目标无需停用'));
      goal.status = 'paused';
      if (goal.id === next.focusId) next.run = { ...next.run, paused: true, reason: msg('用户停用') };
    } else {
      goal.status = params.action === 'delete' ? 'deleted' : 'completed';
      if (goal.status === 'completed') goal.completedAt = Date.now();
      if (goal.id === next.focusId) { delete next.focusId; next.run = { ...next.run, paused: true, reason: goal.status === 'deleted' ? msg('目标已删除') : msg('目标已完成') }; delete next.run.nextStep; }
    }
  }
  validateGoalState(next, msg);
  if (JSON.stringify(next) === JSON.stringify(state)) return { state, text: msg('Goal 无变化') };
  const goal = params.action === 'create' ? next.goals.at(-1)! : next.goals.find((item) => item.id === current!.id)!;
  const hint = activates(params.action) ? msg`；自动续跑上限 ${goal.maxTurns}，研究可 update progress/nextStep，需要用户时 pause` : '';
  return { state: next, text: msg`Goal #${goal.id} ${params.action}：${goal.title}${hint}` };
}
export function pauseGoal(state: GoalState, reason: string): GoalState {
  if (state.run.paused && state.run.reason === reason) return state;
  return { ...state, run: { ...state.run, paused: true, reason } };
}
export function reserveGoalWake(state: GoalState): GoalState | undefined {
  const goal = focusedGoal(state);
  if (!goal || state.run.paused || state.run.used >= goal.maxTurns) return;
  return { ...state, run: { ...state.run, used: state.run.used + 1 } };
}
/** Unknown/corrupt authoritative entries are errors, never silently roll back. */
export function restoreGoalState(branch: readonly { type: string; customType?: string; data?: unknown }[], msg: Translator = chinese): GoalState {
  const entry = [...branch].reverse().find((item) => item.type === 'custom' && item.customType === GOAL_TYPE);
  const state = entry ? structuredClone(entry.data) as GoalState : emptyGoalState();
  validateGoalState(state, msg);
  return state;
}
