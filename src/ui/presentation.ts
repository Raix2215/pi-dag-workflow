/**
 * User-readable presentation helpers.
 *
 * Pure formatting only: these functions never read or write workflow state, never touch files,
 * credentials or the model, and never render a raw JSON object. Callers own localization (pass
 * `msg`) and layout/theme; every function returns sanitized plain text lines with no ANSI colors,
 * emoji or terminal control sequences.
 *
 * `import type` from ./render.ts is erased at runtime, so this module has no import cycle with the
 * widget renderer even though the menu layer imports both.
 */
import { stripTerminalSequences } from '@earendil-works/pi-tui';
import { chinese, localizeSavedMessage, type Translator } from '../shared/i18n.ts';
import type { Goal, GoalRun } from '../goal/state.ts';
import { goalModelPause, goalNolimit } from '../goal/policy.ts';
import type { Profile, ThinkingLevel } from '../agents/profiles.ts';
import type { Todo, TodoStatus } from '../todos/state.ts';
import { taskStatusLabels as statusLabel } from '../shared/state-types.ts';
import type { JobSummary } from '../agents/runtime.ts';
import type { AgentView } from './render.ts';

// ---------------------------------------------------------------------------
// Sanitizing: independent of ui/render.ts clean/displayText to avoid a cycle.
// ---------------------------------------------------------------------------

const ESCAPED_C1 = /\u009b/g;
/** One display line: strip terminal sequences and controls, fold newlines to spaces, trim. */
export function plain(value: unknown): string {
  if (typeof value !== 'string') return '';
  const escaped = value.replace(ESCAPED_C1, '\x1b[').replace(/\u009d/g, '\x1b]').replace(/\u009c/g, '\x1b\\');
  return stripTerminalSequences(escaped)
    .replace(/[\r\n\t\u2028\u2029]+/g, ' ')
    .replace(/[\p{Cc}\p{Bidi_Control}\u206a-\u206f]/gu, '')
    .trim();
}

/** Multi-line text: remove controls per line while keeping intended line breaks and indentation. */
export function plainBlock(value: unknown): string[] {
  if (typeof value !== 'string') return [];
  return value.split('\n').map((line) => {
    const indent = (line.match(/^[ \t]*/) ?? [''])[0]!.replace(/\t/g, '    ');
    const content = plain(line);
    return content ? indent + content : '';
  });
}

/** Compact duration without a cap: `59s`, `5m3s`, `2h7m`. */
export function durationText(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '0s';
  const total = Math.floor(ms / 1000);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  if (hours) return `${hours}h${minutes}m`;
  if (minutes) return `${minutes}m${seconds}s`;
  return `${seconds}s`;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
function text(value: unknown): string | undefined { return typeof value === 'string' ? value : undefined; }
function number(value: unknown): number | undefined { return typeof value === 'number' && Number.isFinite(value) ? value : undefined; }
function boolean(value: unknown): boolean | undefined { return typeof value === 'boolean' ? value : undefined; }
function list(value: unknown): unknown[] | undefined { return Array.isArray(value) ? value : undefined; }
function numbers(value: unknown): number[] {
  const items = list(value);
  return items ? items.filter((item): item is number => typeof item === 'number' && Number.isFinite(item)) : [];
}
function strings(value: unknown): string[] {
  const items = list(value);
  return items ? items.filter((item): item is string => typeof item === 'string') : [];
}
function objects(value: unknown): Record<string, unknown>[] {
  const items = list(value);
  return items ? items.map(record).filter((item): item is Record<string, unknown> => item !== undefined) : [];
}
function modelRefText(value: unknown): string {
  const model = record(value);
  if (model) {
    const provider = text(model.provider) ?? '';
    const id = text(model.id) ?? '';
    if (provider && id) return `${provider}/${id}`;
    return provider || id;
  }
  const direct = text(value);
  return direct ?? '';
}
function labelledBlock(label: string, value: unknown, msg: Translator): string[] {
  const body = plainBlock(value).filter((line, index, all) => line !== '' || index > 0 && index < all.length - 1);
  if (!body.length) return [msg`${label}：`];
  return [msg`${label}：${body[0]!}`, ...body.slice(1)];
}

// ---------------------------------------------------------------------------
// Todo
// ---------------------------------------------------------------------------

function todoStatusText(status: string, msg: Translator): string {
  return Object.hasOwn(statusLabel, status) ? msg(statusLabel[status as TodoStatus]) : plain(status);
}

function todoFrom(value: Record<string, unknown>): Todo {
  const status = text(value.status) ?? 'pending';
  return {
    id: number(value.id) ?? 0,
    subject: text(value.subject) ?? '',
    status: Object.hasOwn(statusLabel, status) ? status as TodoStatus : 'pending',
    blockedBy: numbers(value.blockedBy),
    ...(text(value.description) !== undefined ? { description: text(value.description)! } : {}),
    ...(text(value.activeForm) !== undefined ? { activeForm: text(value.activeForm)! } : {}),
    ...(text(value.owner) !== undefined ? { owner: text(value.owner)! } : {}),
    ...(record(value.metadata) !== undefined ? { metadata: record(value.metadata)! } : {}),
  };
}

/** Full task requirement, state, dependencies and declared references. */
export function todoSummary(todo: Todo, msg: Translator = chinese): string[] {
  const lines: string[] = [msg`Todo #${todo.id} · ${todoStatusText(todo.status, msg)}`, plain(todo.subject)];
  if (todo.activeForm?.trim()) lines.push(msg`当前活动：${plain(todo.activeForm)}`);
  if (todo.owner?.trim()) lines.push(msg`负责：${plain(todo.owner)}`);
  lines.push(todo.blockedBy.length ? msg`依赖：#${todo.blockedBy.join(', #')}` : msg('依赖：无'));
  const preset = text(todo.metadata?.preset);
  const step = number(todo.metadata?.step);
  const run = number(todo.metadata?.run);
  if (preset) lines.push(msg`片段：${plain(preset)}${step !== undefined ? `#${step}` : ''}${run !== undefined && run > 1 ? msg` · 第 ${run} 轮` : ''}`);
  const artifacts = strings(todo.metadata?.artifacts).filter((item) => item.trim());
  if (artifacts.length) {
    lines.push(msg('引用：'));
    for (const artifact of artifacts) lines.push(`  ${plain(artifact)}`);
  }
  lines.push(...(todo.description?.trim() ? labelledBlock(msg('需求'), todo.description, msg) : [msg('需求：未填写')]));
  return lines;
}

// ---------------------------------------------------------------------------
// Goal
// ---------------------------------------------------------------------------

function goalStatusText(status: string, msg: Translator): string {
  return status === 'active' ? msg('活动') : status === 'paused' ? msg('暂停') : status === 'completed' ? msg('已完成') : status === 'deleted' ? msg('已删除') : plain(status);
}

function goalControlLines(goal: Goal, msg: Translator): string[] {
  const lines: string[] = [];
  const effectivePause = goalModelPause(goal);
  const savedPause = goal.modelPause ?? 'allow';
  const pauseText = effectivePause === 'deny' ? msg('禁止模型中断') : msg('允许模型中断');
  lines.push(savedPause !== effectivePause
    ? msg`模型中断：${pauseText}（保存：${savedPause === 'deny' ? msg('禁止') : msg('允许')}）`
    : msg`模型中断：${pauseText}`);
  const effectiveNoLimit = goalNolimit(goal);
  if (effectiveNoLimit && goal.nolimit !== true) lines.push(`${msg`续跑上限：不限（保存：上限 ${goal.maxTurns}）`} · ∞`);
  else lines.push(effectiveNoLimit ? `${msg('续跑上限：不限')} · ∞` : msg`续跑上限：上限 ${goal.maxTurns}`);
  return lines;
}

/** Distinguishes ordinary/continuous mode, effective/saved controls, budget, scope and run state. */
export function goalSummary(goal: Goal, run?: GoalRun, msg: Translator = chinese): string[] {
  const lines: string[] = [msg`Goal #${goal.id}：${plain(goal.title)}`];
  lines.push(goal.autoresearch === true ? msg('模式：持续研究（自主执行、不自行完成）') : msg('模式：普通目标（达成后可完成）'));
  if (run?.paused && !['completed', 'deleted'].includes(goal.status)) lines.push(msg`状态：暂停（${run.reason ? localizeSavedMessage(plain(run.reason), msg) : msg('未启用')}）`);
  else lines.push(msg`状态：${goalStatusText(goal.status, msg)}`);
  if (run) {
    lines.push(msg`续跑：已用 ${run.used}/${goalNolimit(goal) ? '∞' : String(goal.maxTurns)}`);
    if (run.stalled > 0) lines.push(msg`连续无进展：${run.stalled} 轮`);
    if (run.errorRetries) lines.push(msg`错误重试：${run.errorRetries} 次`);
  }
  lines.push(...goalControlLines(goal, msg));
  if (goal.description?.trim()) lines.push(...labelledBlock(msg('范围与要求'), goal.description, msg));
  if (run) lines.push(...(run.progress?.trim() ? labelledBlock(msg('已验证进展'), run.progress, msg) : [msg('已验证进展：暂无')]));
  if (run?.nextStep?.trim()) lines.push(...labelledBlock(msg('下一步'), run.nextStep, msg));
  return lines;
}

function goalFrom(value: Record<string, unknown>): Goal {
  const status = text(value.status);
  return {
    id: number(value.id) ?? 0,
    title: text(value.title) ?? '',
    status: status === 'active' || status === 'paused' || status === 'completed' || status === 'deleted' ? status : 'paused',
    maxTurns: number(value.maxTurns) ?? 0,
    createdAt: number(value.createdAt) ?? 0,
    ...(typeof value.completedAt === 'number' ? { completedAt: value.completedAt } : {}),
    ...(value.modelPause === 'allow' || value.modelPause === 'deny' ? { modelPause: value.modelPause } : {}),
    ...(value.nolimit === true ? { nolimit: true } : {}),
    ...(value.autoresearch === true ? { autoresearch: true } : {}),
    ...(typeof value.description === 'string' ? { description: value.description } : {}),
  };
}

function goalRunFrom(value: Record<string, unknown>): GoalRun {
  return {
    paused: value.paused === true,
    used: number(value.used) ?? 0,
    stalled: number(value.stalled) ?? 0,
    ...(typeof value.reason === 'string' ? { reason: value.reason } : {}),
    ...(typeof value.progress === 'string' ? { progress: value.progress } : {}),
    ...(typeof value.nextStep === 'string' ? { nextStep: value.nextStep } : {}),
    ...(number(value.errorRetries) !== undefined ? { errorRetries: number(value.errorRetries)! } : {}),
  };
}

// ---------------------------------------------------------------------------
// Jobs
// ---------------------------------------------------------------------------

/** Structural view covering JobSummary, AgentView and their inspect/spawn projections. */
export interface JobView {
  id?: string; todoId?: number; profile?: string; status?: string;
  model?: { provider: string; id: string } | string; thinking?: string; tools?: readonly string[]; skills?: readonly string[];
  startedAt?: number; endedAt?: number; error?: string; pendingRequests?: number;
  label?: string; reportDelivery?: 'pending' | 'delivered'; taskReportStale?: boolean;
  dismissed?: boolean; resumeFrom?: string; todoStatus?: string; ignoredInheritedTools?: readonly string[];
  activity?: { kind: string; tool?: string; since?: number };
  output?: string; requests?: readonly { requestId?: string; message?: string }[];
  timedOut?: boolean;
}

const JOB_STATUS_LABELS: Record<string, string> = { starting: '启动中', running: '运行中', waiting: '等待回复', completed: '已返回', failed: '失败', cancelled: '已取消', interrupted: '已中断' };
const ACTIVE_JOB_STATUSES = new Set(['starting', 'running', 'waiting']);

function jobStatusText(status: string | undefined, msg: Translator): string {
  return status && JOB_STATUS_LABELS[status] ? msg(JOB_STATUS_LABELS[status]!) : plain(status);
}

function activityText(activity: NonNullable<JobView['activity']>, msg: Translator): string {
  if (activity.kind === 'thinking') return msg('思考中');
  if (activity.kind === 'output') return msg('输出中');
  if (activity.tool) return msg`工具：${plain(activity.tool)}`;
  return msg('工具');
}

/** Active vs terminal state, report delivery, Todo acceptance and report text kept as text. */
export function jobSummary(job: JobSummary | AgentView | JobView, msg: Translator = chinese): string[] {
  const value = job as JobView;
  const head = [plain(value.id ?? 'job'), value.profile ? plain(value.profile) : '', value.todoId !== undefined ? `Todo #${value.todoId}` : ''].filter(Boolean).join(' · ');
  const lines: string[] = [msg`Job ${head}`];
  const active = value.status !== undefined && ACTIVE_JOB_STATUSES.has(value.status);
  lines.push(msg`状态：${jobStatusText(value.status, msg)}`);
  if (value.status === 'completed') lines.push(value.reportDelivery === 'delivered' ? msg('报告交付：已交付') : msg('报告交付：待交付'));
  if (value.todoId !== undefined) {
    if (value.todoStatus) lines.push(msg`Todo #${value.todoId} 验收：${todoStatusText(value.todoStatus, msg)}${value.taskReportStale ? msg('（历史报告，需重新核验）') : ''}`);
    else if (value.taskReportStale) lines.push(msg`Todo #${value.todoId} 验收：历史报告，需重新核验`);
  }
  if (value.label?.trim()) lines.push(msg`任务：${plain(value.label)}`);
  const model = modelRefText(value.model);
  if (model) lines.push(msg`模型：${model}${value.thinking ? ` · thinking ${plain(value.thinking)}` : ''}`);
  if (value.tools !== undefined) lines.push(msg`工具：${value.tools.length} 个（${value.tools.map(plain).join(', ')}）`);
  if (value.skills !== undefined) {
    lines.push(value.skills.length ? msg`技能：${value.skills.length} 项` : msg('技能：未配置'));
    for (const skill of value.skills) lines.push(`  ${plain(skill)}`);
  }
  if (active && value.activity) lines.push(msg`活动：${activityText(value.activity, msg)}`);
  if (value.pendingRequests && value.pendingRequests > 0) lines.push(msg`待答复问题：${value.pendingRequests} 个`);
  if (value.startedAt !== undefined && value.endedAt !== undefined) lines.push(msg`耗时：${durationText(value.endedAt - value.startedAt)}`);
  if (value.resumeFrom) lines.push(msg`接续自：${plain(value.resumeFrom)}`);
  if (value.ignoredInheritedTools?.length) lines.push(msg`忽略的父工具：${value.ignoredInheritedTools.map(plain).join(', ')}`);
  if (value.dismissed) lines.push(msg('该尝试已停止；Todo 交由主会话处理'));
  if (value.error?.trim()) lines.push(msg`错误：${plain(value.error)}`);
  if (value.timedOut) lines.push(msg('等待超时：仅结束本次等待，子进程未停止'));
  if (value.requests?.length) for (const request of value.requests) {
    const requestId = request.requestId ? ` requestId=${plain(request.requestId)}` : '';
    lines.push(msg`问题${requestId}：${plain(request.message)}`);
  }
  if (typeof value.output === 'string' && value.output.trim()) {
    lines.push(msg('报告正文：'));
    lines.push(...plainBlock(value.output));
  }
  return lines;
}

// ---------------------------------------------------------------------------
// Models and profiles
// ---------------------------------------------------------------------------

export interface ModelView {
  provider: string; id: string; name: string; reasoning: boolean;
  contextWindow?: number; maxTokens?: number; input?: readonly string[];
}

/** Allowlisted model metadata only; never include registry credentials or endpoint settings. */
export function modelSummary(model: ModelView, msg: Translator = chinese): string[] {
  const lines = [msg`模型：${plain(model.name)}`, `provider: ${plain(model.provider)}`, `id: ${plain(model.id)}`, msg`推理：${model.reasoning ? msg('支持') : msg('不支持')}`];
  if (model.contextWindow !== undefined) lines.push(msg`上下文窗口：${model.contextWindow}`);
  if (model.maxTokens !== undefined) lines.push(msg`最大输出：${model.maxTokens}`);
  if (model.input !== undefined) lines.push(msg`输入：${model.input.map(plain).join(', ')}`);
  return lines;
}

function profileFrom(value: Record<string, unknown>): Profile {
  const model = record(value.model);
  const provider = model ? text(model.provider) : undefined;
  const id = model ? text(model.id) : undefined;
  const thinking = text(value.thinking);
  return {
    name: text(value.name) ?? '',
    ...(provider && id ? { model: { provider, id } } : {}),
    ...(thinking && ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(thinking) ? { thinking: thinking as ThinkingLevel } : {}),
    ...(Array.isArray(value.tools) ? { tools: strings(value.tools) } : {}),
    ...(Array.isArray(value.skills) ? { skills: strings(value.skills) } : {}),
    ...(typeof value.instructions === 'string' ? { instructions: value.instructions } : {}),
  };
}

/** Selected vs inherited model, thinking, tool count, skill entries and instructions. */
export function profileSummary(profile: Profile, msg: Translator = chinese): string[] {
  const lines: string[] = [msg`Profile ${plain(profile.name)}`];
  lines.push(profile.model ? msg`模型：${modelRefText(profile.model)}` : msg('模型：继承主会话'));
  lines.push(profile.thinking ? msg`thinking：${plain(profile.thinking)}` : msg('thinking：继承主会话'));
  const tools = profile.tools ?? [];
  lines.push(tools.length ? msg`工具：${tools.length} 个（${tools.map(plain).join(', ')}）` : msg('工具：继承主会话核心工具'));
  const skills = profile.skills ?? [];
  lines.push(skills.length ? msg`技能：${skills.length} 项` : msg('技能：未配置'));
  for (const skill of skills) lines.push(`  ${plain(skill)}`);
  lines.push(...(profile.instructions?.trim() ? labelledBlock(msg('指令'), profile.instructions, msg) : [msg('指令：未配置')]));
  return lines;
}

// ---------------------------------------------------------------------------
// Retry
// ---------------------------------------------------------------------------

const RETRY_PHASE_LABELS: Record<string, string> = {
  off: '已关闭', armed: '等待下一次错误', waiting: '等待重试', running: '重试运行中',
  starting: '重试启动中', switching: '切换替代模型', exhausted: '已耗尽', failed: '启动失败',
};

function retryModeText(mode: string, msg: Translator): string {
  return mode === 'plan' ? msg('Plan 只读') : mode === 'goal' ? msg('Goal') : msg('普通');
}

/** Enabled vs phase, waiting time, real model/count/per-model, candidates and reason. */
export function retrySummary(snapshot: unknown, msg: Translator = chinese, now = Date.now()): string[] {
  const data = record(snapshot);
  if (!data) return [msg('重试状态不可读')];
  const lines: string[] = [boolean(data.enabled) === true ? msg('自动重试：开启') : msg('自动重试：关闭')];
  const phase = text(data.phase) ?? 'off';
  const phaseText = RETRY_PHASE_LABELS[phase] ? msg(RETRY_PHASE_LABELS[phase]!) : plain(phase);
  const nextAt = number(data.nextAt);
  if (phase === 'waiting') lines.push(nextAt !== undefined && nextAt > now ? msg`阶段：${phaseText}（约 ${durationText(nextAt - now)} 后）` : msg`阶段：${phaseText}（即将触发）`);
  else lines.push(msg`阶段：${phaseText}`);
  const mode = text(data.mode);
  if (mode) lines.push(msg`运行模式：${retryModeText(mode, msg)}`);
  const attempts = number(data.attempts) ?? 0;
  const skipped = number(data.skipped) ?? 0;
  const count = number(data.count);
  const progress = count === undefined ? msg`已重试 ${attempts} 次（不限次数）` : msg`已重试 ${attempts}/${count} 次`;
  lines.push(skipped > 0 ? msg`${progress} · 跳过 ${skipped} 次` : progress);
  const intervals = text(data.intervals);
  lines.push(intervals ? msg`重试间隔：${intervals}` : msg('重试间隔：未设置（用 /retry when-error 设置）'));
  const models = record(data.models);
  if (!models) lines.push(msg('替代模型：未设置（用 /retry models 开启）'));
  else {
    const enabled = boolean(models.enabled) === true;
    const candidates = objects(models.candidates);
    const after = number(models.after);
    const base = enabled ? msg`替代模型：开启 · 每模型 ${after ?? '-'} 次` : msg('替代模型：关闭');
    lines.push(candidates.length ? msg`${base} · 候选 ${candidates.length} 个` : base);
    const refs = candidates.map(modelRefText).filter(Boolean);
    if (refs.length) lines.push(msg`候选顺序：${refs.join(' → ')}`);
    const current = text(models.current);
    lines.push(current ? msg`实际使用模型：${current}` : msg('实际使用模型：未记录'));
    const used = record(models.attemptsInModel);
    if (used) {
      const parts = Object.entries(used).filter(([, value]) => typeof value === 'number' && value > 0).map(([key, value]) => msg`${key} ${String(value)} 次`);
      if (parts.length) lines.push(msg`各模型已用：${parts.join(' · ')}`);
    }
  }
  const reason = text(data.reason);
  if (reason) lines.push(msg`说明：${plain(reason)}`);
  const lastError = text(data.lastError) ?? text(data.error);
  if (lastError) lines.push(msg`最近错误：${plain(lastError)}`);
  return lines;
}

// ---------------------------------------------------------------------------
// Tool result details
// ---------------------------------------------------------------------------

export interface ToolDisplayOptions {
  msg?: Translator;
  /** Known tool name (`todo`/`goal`/`subagent`) when the details alone are ambiguous. */
  action?: string;
  id?: string;
}

function todoStatusLines(status: Record<string, unknown>, msg: Translator): string[] {
  const lines: string[] = [msg`Todo 状态 · 模式：${text(status.mode) === 'plan' ? msg('Plan 只读') : msg('普通')} · 共 ${number(status.total) ?? 0} 项`];
  const counts = record(status.counts);
  if (counts) {
    const parts: string[] = [];
    for (const key of ['pending', 'in_progress', 'completed', 'failed', 'cancelled']) {
      const value = number(counts[key]) ?? 0;
      if (value) parts.push(`${todoStatusText(key, msg)} ${value}`);
    }
    lines.push(parts.length ? msg`分布：${parts.join(' · ')}` : msg('分布：全部为空'));
  }
  const deleted = number(status.deleted);
  if (deleted) lines.push(msg`已删除：${deleted}`);
  if (boolean(status.protected) === true) lines.push(msg('状态受保护：是'));
  const retry = record(status.retry);
  if (retry) lines.push(...retrySummary(retry, msg));
  return lines;
}

function presetLines(data: Record<string, unknown>, msg: Translator): string[] {
  const single = record(data.preset);
  if (single) {
    const lines: string[] = [msg`片段 ${plain(text(single.name) ?? '')}`];
    if (text(single.description)?.trim()) lines.push(plain(single.description));
    if (text(single.skill)?.trim()) lines.push(msg`技能：${plain(single.skill)}`);
    const steps = objects(single.steps);
    lines.push(msg`步骤：${steps.length} 项`);
    for (const [index, step] of steps.entries()) {
      const key = plain(text(step.key) ?? String(index + 1));
      const subject = plain(text(step.subject) ?? '');
      const after = strings(step.after);
      lines.push(`  ${index + 1}. ${key} ${subject}${after.length ? msg`（依赖 ${after.join(', ')}）` : ''}`);
    }
    return lines;
  }
  const presets = objects(data.presets);
  if (!presets.length) return [msg('未配置 Todo 片段')];
  const lines: string[] = [msg`Todo 片段：${presets.length} 项`];
  for (const preset of presets) {
    const description = text(preset.description);
    lines.push(`  ${plain(text(preset.name) ?? '')}${description ? ` — ${plain(description)}` : ''}${msg`（${number(preset.steps) ?? 0} 步）`}`);
  }
  return lines;
}

function todoListLines(data: Record<string, unknown>, msg: Translator): string[] {
  const lines: string[] = [];
  const tasks = objects(data.tasks);
  const page = record(data.page);
  if (page) lines.push(msg`本页 ${number(page.count) ?? tasks.length} / 共 ${number(page.total) ?? tasks.length} 项`);
  else if (tasks.length) lines.push(msg`共 ${tasks.length} 项`);
  for (const task of tasks) lines.push(...todoSummary(todoFrom(task), msg));
  const relations = record(data.relations);
  if (relations) {
    const blocks = numbers(relations.blocks);
    const unmet = numbers(relations.unmetPrerequisites);
    if (blocks.length) lines.push(msg`被以下任务依赖：#${blocks.join(', #')}`);
    if (unmet.length) lines.push(msg`未满足依赖：#${unmet.join(', #')}`);
  }
  const removed = numbers(data.removedIds);
  if (removed.length) lines.push(msg`已移除：#${removed.join(', #')}`);
  const refs = record(data.refs);
  if (refs) {
    const parts = Object.entries(refs).filter(([, value]) => typeof value === 'number').map(([key, value]) => `${key}=#${String(value)}`);
    if (parts.length) lines.push(msg`映射：${parts.join(', ')}`);
  }
  if (!tasks.length && !page && !removed.length) lines.push(text(data.action) === 'clear' ? msg('已清理记录') : msg('暂无任务'));
  return lines;
}

function goalStateLines(value: unknown, msg: Translator, targetId?: number): string[] {
  const state = record(value);
  if (!state) return [msg('Goal 状态不可读')];
  const goals = objects(state.goals);
  if (!goals.length) return [msg('暂无目标')];
  const focusId = number(state.focusId);
  const run = record(state.run);
  const selected = goals.find((goal) => number(goal.id) === (targetId ?? focusId)) ?? goals[0]!;
  const lines: string[] = [...goalSummary(goalFrom(selected), number(selected.id) === focusId && run ? goalRunFrom(run) : undefined, msg)];
  const others = targetId === undefined ? goals.filter((goal) => goal !== selected) : [];
  if (others.length) {
    lines.push(msg('其他目标：'));
    for (const goal of others) lines.push(`  #${number(goal.id) ?? '?'} [${goalStatusText(text(goal.status) ?? '', msg)}] ${plain(text(goal.title) ?? '')}`);
  }
  return lines;
}

function spawnLines(data: Record<string, unknown>, msg: Translator): string[] {
  const lines: string[] = [msg`已派发 Job ${plain(text(data.jobId) ?? '')}`];
  lines.push(msg`状态：${jobStatusText(text(data.status), msg)}`);
  const model = modelRefText(data.model);
  if (model) lines.push(msg`模型：${model}${text(data.thinking) ? ` · thinking ${plain(data.thinking)}` : ''}`);
  if (Array.isArray(data.tools)) lines.push(msg`工具：${data.tools.length} 个（${strings(data.tools).map(plain).join(', ')}）`);
  if (Array.isArray(data.skills)) {
    lines.push(data.skills.length ? msg`技能：${data.skills.length} 项` : msg('技能：未配置'));
    for (const skill of strings(data.skills)) lines.push(`  ${plain(skill)}`);
  }
  const todoId = number(data.todoId);
  if (todoId !== undefined) lines.push(msg`Todo #${todoId} 验收：${todoStatusText(text(data.todoStatus) ?? 'pending', msg)}；报告不会自动完成任务`);
  const resumeFrom = text(data.resumeFrom);
  if (resumeFrom) lines.push(msg`接续自：${plain(resumeFrom)}`);
  const ignored = strings(data.ignoredInheritedTools);
  if (ignored.length) lines.push(msg`忽略的父工具：${ignored.map(plain).join(', ')}`);
  const error = text(data.error);
  if (error?.trim()) lines.push(msg`错误：${plain(error)}`);
  return lines;
}

function sendLines(data: Record<string, unknown>, msg: Translator): string[] {
  const delivery = text(data.delivery);
  const deliveryText = delivery === 'accepted' ? msg('已接受') : delivery === 'queued' ? msg('已排队') : delivery === 'answered' ? msg('已回答') : plain(delivery);
  const status = text(data.status);
  return [msg`消息${deliveryText ? `（${deliveryText}）` : ''}${status ? msg` → Job 状态：${jobStatusText(status, msg)}` : ''}`];
}

function cancelLines(data: Record<string, unknown>, msg: Translator): string[] {
  const jobId = plain(text(data.jobId) ?? '');
  return [data.removed === true ? msg`已停止并移除 Job ${jobId}（记录清理，不改变 Todo 与文件）` : msg`已停止 Job ${jobId}（记录保留）`];
}

function inspectLines(data: Record<string, unknown>, msg: Translator): string[] {
  const lines: string[] = [];
  if (Array.isArray(data.models)) {
    const models = objects(data.models);
    lines.push(msg`模型目录：本页 ${models.length} / 共 ${number(data.total) ?? models.length} 项`);
    for (const model of models) lines.push(...modelSummary(model as unknown as ModelView, msg));
    if (number(data.nextOffset) !== undefined) lines.push(msg`下一页 offset：${number(data.nextOffset)}`);
  }
  if ('jobs' in data) {
    if (data.paused === true) lines.push(msg('结果自动唤醒：已暂停'));
    const jobs = objects(data.jobs);
    if (!jobs.length) lines.push(msg('暂无 Job'));
    for (const job of jobs) lines.push(...jobSummary(job as unknown as JobView, msg));
  }
  const profile = record(data.profile);
  if (profile) lines.push(...profileSummary(profileFrom(profile), msg));
  if ('profiles' in data) {
    const profiles = objects(data.profiles);
    if (!profiles.length) lines.push(msg('未配置 Profile'));
    else {
      lines.push(msg`Profile 列表：${profiles.length} 项`);
      for (const item of profiles) lines.push(...profileSummary(profileFrom(item), msg));
    }
  }
  const profilePath = text(data.profilePath);
  if (profilePath) lines.push(msg`Profile 文件：${plain(profilePath)}`);
  return lines;
}

/** Structured direction failure: phase, actual status and what the failed send did or did not change. */
const SEND_STAGE_LABELS: Record<string, string> = { preflight: '预检', clear_queue: '清空队列', interrupt: '中断当前运行', apply_tools: '应用工具', deliver_direction: '投递方向' };
export function sendFailureLines(data: Record<string, unknown>, msg: Translator): string[] {
  const stage = text(data.stage);
  const lines: string[] = [`Job ${plain(text(data.jobId) ?? '')}`, msg`阶段：${stage && SEND_STAGE_LABELS[stage] ? msg(SEND_STAGE_LABELS[stage]) : plain(stage ?? '')}`];
  const error = text(data.error);
  if (error?.trim()) lines.push(msg`错误：${plain(error)}`);
  const status = text(data.status);
  if (status) lines.push(msg`状态：${jobStatusText(status, msg)}`);
  const impact: string[] = [];
  impact.push(msg(data.directionDelivery === 'not_sent' ? '方向未发送' : '方向投递未确认'));
  if (data.interrupted !== undefined) impact.push(msg(data.interrupted === null ? '中断结果未确认' : data.interrupted ? '已中断当前运行' : '未中断当前运行'));
  if (data.queueCleared !== undefined) impact.push(msg(data.queueCleared === null ? '队列清理未确认' : data.queueCleared ? '原队列已清除' : '原队列保留'));
  if (data.questionsCleared !== undefined) impact.push(msg(data.questionsCleared === null ? '问题等待取消未确认' : data.questionsCleared ? '原问题等待已取消' : '待答复问题保留'));
  if (data.toolsApplied !== undefined) impact.push(msg(data.toolsApplied === null ? '工具调整未确认' : data.toolsApplied ? '工具调整已确认' : '工具未调整'));
  if (impact.length) lines.push(msg`影响：${impact.join('；')}`);
  if (Array.isArray(data.currentTools)) lines.push(msg`最后确认的工具：${strings(data.currentTools).map(plain).join(', ')}`);
  const recovery = text(data.recovery);
  if (recovery?.trim()) lines.push(msg`说明：${plain(localizeSavedMessage(recovery, msg))}`);
  return lines;
}

function toolLines(data: Record<string, unknown>, hint: ToolDisplayOptions, msg: Translator): string[] | undefined {
  if (typeof data.jobId === 'string' && typeof data.stage === 'string' && typeof data.directionDelivery === 'string') return sendFailureLines(data, msg);
  if ('goalState' in data) return goalStateLines(data.goalState, msg, number(data.targetId));
  if (Array.isArray(data.models) || Array.isArray(data.jobs) || Array.isArray(data.profiles) || (record(data.profile) !== undefined && typeof data.status !== 'string')) return inspectLines(data, msg);
  if (typeof data.id === 'string' && typeof data.status === 'string') return jobSummary(data as unknown as JobView, msg);
  if (typeof data.jobId === 'string' && data.stopped === true) return cancelLines(data, msg);
  if (typeof data.jobId === 'string' && typeof data.status === 'string') return spawnLines(data, msg);
  if (data.delivered === true || ('delivery' in data && 'status' in data)) return sendLines(data, msg);
  if (typeof data.error === 'string' && data.error.trim()) return [msg`错误：${plain(data.error)}`];
  if (data.version === 2 || Array.isArray(data.tasks)) {
    const status = record(data.status);
    if (status && text(data.action) === 'status') return todoStatusLines(status, msg);
    if (Array.isArray(data.presets) || record(data.preset) !== undefined) return presetLines(data, msg);
    return todoListLines(data, msg);
  }
  if (hint.action === 'todo') return todoListLines(data, msg);
  if (hint.action === 'goal') return goalStateLines(record(data.goalState), msg);
  return undefined;
}

/**
 * Format a known plugin tool's `details` into readable text. Unknown shapes keep the caller's
 * already-readable fallback instead of dumping a raw object; a plain string fallback is preserved.
 */
export function toolDisplay(details: unknown, fallback: string, options?: Translator | ToolDisplayOptions): string {
  const hint: ToolDisplayOptions = typeof options === 'function' ? { msg: options } : options ?? {};
  const msg = hint.msg ?? chinese;
  const data = record(details);
  if (!data) return plainBlock(fallback).join('\n');
  try {
    const formatted = toolLines(data, hint, msg);
    if (formatted && formatted.length) return formatted.join('\n');
  } catch { /* A malformed known shape must still fall back, never print a raw object. */ }
  return plainBlock(fallback).join('\n');
}
