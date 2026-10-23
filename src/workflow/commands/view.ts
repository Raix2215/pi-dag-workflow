import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import { truncateToWidth, visibleWidth } from '@earendil-works/pi-tui';
import type { TodoFilter, WorkflowState } from '../../shared/task-types.ts';
import type { AgentView } from '../../shared/agent-view.ts';
import { chinese, type Translator } from '../../shared/i18n.ts';
import * as render from '../../shared/ui/render.ts';
import * as menu from '../../shared/ui/menu.ts';
import { glyph, type IconStyle } from '../../shared/ui/symbols.ts';
import { middleTruncate } from '../../shared/ui/panel.ts';
import type { Feature } from '../domain/features.ts';

interface RetryView {
  enabled: boolean; phase: string; attempts: number; count: number | null; intervals?: string | undefined; nextAt?: number;
  models?: { enabled: boolean; current?: string | undefined; candidates?: readonly { provider: string; id: string }[] };
}
/**
 * One line, two modes, one skeleton: `module · [status] · interval(s) · count · model`.
 * Icons replace words but never numbers; the status bracket and the countdown always survive, and
 * a narrow terminal loses the model first, then the interval sequence, then the current interval.
 */
export function retryWidgetLine(recovery: RetryView | undefined, now: number, msg: Translator = chinese, iconStyle: IconStyle = 'nerd-font', width = Infinity): string | undefined {
  if (!recovery?.enabled) return;
  const nerd = iconStyle !== 'plain';
  const icon = (name: Parameters<typeof glyph>[0]) => { const glyphOf = glyph(name, nerd ? 'nerd-font' : 'plain'); return glyphOf ? glyphOf + ' ' : ''; };
  const sep = ' · ';
  const count = recovery.count === null ? msg('不限') : String(recovery.count);
  const intervals = recovery.intervals?.split(',').filter(Boolean) ?? [];
  const current = recovery.models?.current;
  const candidate = Boolean(current) && (recovery.models?.candidates ?? []).some(option => `${option.provider}/${option.id}` === current);
  const baseModel = current ?? msg('默认');
  const model = candidate ? msg`${baseModel}（替代）` : baseModel;
  const modelSeg = (text: string) => (nerd ? icon('models') : msg('模型') + ' ') + text;
  const head = nerd ? icon('retry') + 'Retry' : 'Retry';
  const retrying = recovery.phase !== 'armed';
  const words = retrying ? msg`重试中 ${recovery.attempts}/${recovery.count === null ? msg('不限') : recovery.count}` : msg('待命');
  const status = nerd ? `[${icon(retrying ? 'retry-active' : 'retry-armed')}${words}]` : `[${words}]`;
  const seconds = recovery.nextAt === undefined ? undefined : Math.max(0, Math.ceil((recovery.nextAt - now) / 1000));
  const countdown = seconds === undefined ? undefined : nerd ? icon('timer') + `${seconds}s` : msg`${seconds}s 后`;
  const currentInterval = intervals.length ? intervals[recovery.attempts % intervals.length]! : undefined;
  const intervalNow = currentInterval === undefined ? undefined : (nerd ? icon('clock-fast') : msg('间隔') + ' ') + currentInterval;
  const sequence = intervals.length ? (nerd ? icon('clock-fast') : '') + intervals.join('→') : undefined;
  const countSeg = nerd ? icon('counter') + count : msg`上限 ${count}`;
  // The bracket belongs to the module word: `Retry [status] · …`, never a separate segment.
  const lead = `${head} ${status}`;
  const fixed = (retrying ? [countdown, intervalNow] : [sequence, countSeg]).filter(Boolean) as string[];
  const assemble = (modelText: string | undefined) => [lead, ...fixed, ...(modelText === undefined ? [] : [modelSeg(modelText)])].join(sep);
  // Sacrifice order: middle-truncated model → brand only → no model → interval sequence → current interval.
  const candidates = [assemble(model), assemble(middleTruncate(model, 18)), assemble(model.split('/')[0]!), assemble(undefined)];
  candidates.push(retrying ? [lead, ...(countdown ? [countdown] : [])].join(sep) : [lead, countSeg].join(sep));
  for (const line of candidates) if (visibleWidth(line) <= width) return line;
  return truncateToWidth(lead, Math.max(1, width), '…');
}

interface Hooks {
  msg?: Translator;
  state(): WorkflowState;
  todo(): WorkflowState;
  modules(): Record<Feature, boolean>;
  preferences(): unknown;
  visible(feature: Feature): boolean;
  jobs(): readonly AgentView[];
  goalTitle(): string | undefined;
  retry(): RetryView | undefined;
  errors(): { todoError: string | undefined; planError: string | undefined };
  generation(): number;
  iconStyle?(): import('../../shared/ui/symbols.ts').IconStyle;
  modelMax?(): number;
}
export function createWorkflowView(hooks: Hooks) {
  const WIDGET = 'pi-dag-workflow.todos', msg = hooks.msg ?? chinese;
  const { state, visible, jobs } = hooks;
  let lastPaint: { tasks: WorkflowState['tasks']; key: string; ui: ExtensionContext['ui']; theme: ExtensionContext['ui']['theme'] } | undefined;
  const noTasks: WorkflowState['tasks'] = [];
  let tick: ReturnType<typeof setInterval> | undefined;
  const stopTick = () => { if (tick) clearInterval(tick); tick = undefined; };
function paint(ctx: ExtensionContext) {
    const modules = hooks.modules(), tasks = hooks.todo(), preferences = hooks.preferences();
    const { todoError, planError } = hooks.errors();
    if (!ctx.hasUI || !Object.values(modules).some(Boolean)) return;
    const ticking = ctx.mode === 'tui' && visible('retry') && !!hooks.retry()?.nextAt;
    if (ticking && !tick) { tick = setInterval(() => paint(ctx), 1000); tick.unref?.(); }
    if (!ticking) stopTick();
    if (menu.menuDisplayOpen(ctx)) { lastPaint = undefined; ctx.ui.setWidget(WIDGET, undefined); return; }
    const snapshotJobs = visible('agents') ? jobs() : [];
    const projected = { ...state(), tasks: visible('todos') ? state().tasks : noTasks, plan: visible('plan') && state().plan };
    const goalTitle = visible('goal') ? hooks.goalTitle() : undefined;
    const recovery = visible('retry') ? hooks.retry() : undefined;
    const retryLine = retryWidgetLine(recovery, Date.now(), msg, hooks.iconStyle?.() ?? (ctx.mode === 'tui' ? 'nerd-font' : 'plain'));
    const now = Date.now();
    const jobKey = snapshotJobs.map((job) => [job.id, job.todoId, job.profile, job.model?.provider, job.model?.id, job.status, job.reportDelivery, job.taskReportStale, job.dismissed, job.label, job.activity?.kind, job.activity?.tool, job.activity?.since, job.activity?.since ? Math.floor((now - job.activity.since) / 1000) : undefined]);
    const key = JSON.stringify([modules, projected.plan, tasks.visible, preferences, tasks.view, tasks.treeStyle, tasks.filter, goalTitle, retryLine, todoError, planError, jobKey]);
    if (lastPaint?.tasks === projected.tasks && lastPaint.key === key && lastPaint.ui === ctx.ui && lastPaint.theme === ctx.ui.theme) return;
    lastPaint = { tasks: projected.tasks, key, ui: ctx.ui, theme: ctx.ui.theme };
    if (!projected.tasks.some((task) => task.status !== 'deleted') && !projected.plan && !todoError && !planError && !goalTitle && !snapshotJobs.length && !retryLine) { ctx.ui.setWidget(WIDGET, undefined); return; }
    const style = () => hooks.iconStyle?.() ?? (ctx.mode === 'tui' ? 'nerd-font' : 'plain');
    const lines = (width: number, rows = 36, currentRetry = retryWidgetLine(visible('retry') ? hooks.retry() : undefined, Date.now(), msg, style(), width)) => {
      const error = todoError ?? planError, budget = render.widgetHeightBudget(rows);
      const result = render.renderWidget(projected, width, Math.max(0, budget - (error ? 1 : 0) - (currentRetry ? 1 : 0)), { ...(!visible('todos') ? { maxRows: 0 } : {}), theme: ctx.ui.theme, jobs: snapshotJobs, goalTitle, msg, iconStyle: style(), ...(hooks.modelMax ? { modelMax: hooks.modelMax() } : {}) });
      // The line is already built to fit: a tail truncation here would cut the status bracket.
      if (currentRetry) result.push(truncateToWidth(render.clean(currentRetry), width, '…'));
      if (error) result.push(truncateToWidth(render.clean(msg`恢复失败：${error}；受影响功能保持保护`), width));
      return result.slice(0, budget);
    };
    if (ctx.mode === 'tui') ctx.ui.setWidget(WIDGET, (tui) => {
      let width = -1, rows = -1, previous: string | undefined, rendered: string[] = [];
      return { render(next: number) {
        const height = tui?.terminal?.rows ?? 36, live = retryWidgetLine(visible('retry') ? hooks.retry() : undefined, Date.now(), msg, style(), next);
        if (width !== next || rows !== height || previous !== live) { rendered = lines(next, height, live); width = next; rows = height; previous = live; }
        return rendered;
      }, invalidate() { width = -1; } };
    }); else ctx.ui.setWidget(WIDGET, lines(80));
  }
async function show(ctx: ExtensionContext, view: 'list' | 'dag', filter?: TodoFilter) {
    const tasks = hooks.todo();
    const selection = filter ?? tasks.filter ?? 'full';
    const lines = (width: number) => view === 'dag' ? render.renderDag(state(), width, ctx.ui.theme, hooks.goalTitle(), jobs(), { msg, filter: selection, ...(hooks.modelMax ? { modelMax: hooks.modelMax() } : {}) }) : render.renderTasks(state(), width, { maxRows: Infinity, theme: ctx.ui.theme, jobs: jobs(), goalTitle: hooks.goalTitle(), msg, filter: selection, ...(hooks.modelMax ? { modelMax: hooks.modelMax() } : {}) });
    const own = hooks.generation();
    await menu.readView(ctx, view === 'dag' ? 'DAG' : msg('任务清单'), lines(Math.max(16, (process.stdout.columns ?? 80) - 4) - 2).join('\n') || msg('暂无任务'), { msg, isCurrent: () => own === hooks.generation() });
  }
  return { paint, show, invalidate() { lastPaint = undefined; stopTick(); }, bind(ctx: ExtensionContext) { const unbind = menu.bindMenuDisplay(ctx, () => { lastPaint = undefined; paint(ctx); }); return () => { stopTick(); unbind(); }; } };
}
