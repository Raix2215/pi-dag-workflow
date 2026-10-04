import type { ExtensionContext, Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { dagStructure, type DagStructure } from "../dag/cache.ts";
import { dagLayout } from "../dag/layout.ts";
import { statusLabel, type Todo, type TodoFilter, type WorkflowState } from "../todos/state.ts";
import { chinese, type Translator } from "../shared/i18n.ts";
import { filteredView, type TaskView } from "./filter.ts";
import { objectId, snapshotCache, weakMemo } from "./render-cache.ts";

// Failed and cancelled are native Todo outcomes: a cross and a slash keep the row honest without
// inventing a new shape for the three original states.
const icons: Record<Todo["status"], string> = { pending: "○", in_progress: "◐", completed: "✓", failed: "✗", cancelled: "⊘", deleted: "×" };
const colors: Record<Todo["status"], ThemeColor> = { pending: "muted", in_progress: "accent", completed: "success", failed: "error", cancelled: "dim", deleted: "dim" };

/** Untrusted text never contributes terminal controls; keep emoji ZWJ sequences intact. */
export function clean(text: string): string {
  const escaped = text.replace(/\u009b/g, "\x1b[").replace(/\u009d/g, "\x1b]").replace(/\u009c/g, "\x1b\\");
  return stripTerminalSequences(escaped).replace(/[\r\n\t\u2028\u2029]+/g, " ").replace(/[\p{Cc}\p{Bidi_Control}\u206a-\u206f]/gu, "").trim();
}
/** Display text keeps intended line breaks while removing terminal controls from each line. */
export function displayText(text: string): string {
  return text.split("\n").map((line) => {
    const indent = (line.match(/^[ \t]*/)![0]).replace(/\t/g, "    ");
    const content = clean(line);
    return content ? indent + content : "";
  }).join("\n");
}
export function notify(ctx: ExtensionContext, text: string, type: "info" | "warning" | "error" = "info"): void {
  ctx.ui.notify(displayText(text), type);
}
const columns = (width: number): number => Number.isFinite(width) ? Math.max(0, Math.floor(width)) : 0;
const clip = (text: string, width: number): string => stripTerminalSequences(truncateToWidth(text, Math.max(0, width), "…"));
const tint = (text: string, color: ThemeColor, theme?: Theme): string => theme ? theme.fg(color, text) : text;
const bounded = (line: string, width: number, theme?: Theme): string => {
  const result = truncateToWidth(line, width, "…");
  return theme ? result : stripTerminalSequences(result);
};
const reference = (task: Todo, dependencies: readonly number[]): string => `#${task.id}${dependencies.length ? `<-${dependencies.map((id) => `#${id}`).join(",")}` : ""}`;
/** Completed/active scan shared by every header of one immutable snapshot. */
const headerCounts = weakMemo((tasks: readonly Todo[]) => {
  let completed = 0;
  let active = false;
  for (const task of tasks) {
    if (task.status === "completed") completed++;
    else if (task.status === "pending" || task.status === "in_progress") active = true;
  }
  return { completed, root: active ? "●" : "○" };
});
/** Fragment instances carry their preset name, run and step position in task metadata. */
function fragmentTag(task: Todo): string {
  const preset = task.metadata?.preset;
  if (typeof preset !== "string") return "";
  const run = task.metadata?.run;
  const step = task.metadata?.step;
  // Tasks written before step numbers existed fall back to their run, never to a wrong position.
  const position = typeof step === "number" ? step : typeof run === "number" ? run : undefined;
  if (position === undefined) return "";
  const suffix = typeof run === "number" && run > 1 ? `·r${run}` : "";
  return `${clean(preset)}#${position}${suffix}`;
}

interface TaskStatics { subject: string; active: string; owner: string; fragment: string }
/** Cleaned per-task text, tied to Todo identity: an unchanged task is reused by the next snapshot. */
const staticsFor = weakMemo((task: Todo): TaskStatics => ({ subject: clean(task.subject), active: clean(task.activeForm ?? ""), owner: clean(task.owner ?? ""), fragment: fragmentTag(task) }));

function projection(tasks: readonly Todo[]): DagStructure { return dagStructure(tasks); }

/** Goal is display input from a real focus controller, not a second Goal state store. */
function header(state: WorkflowState, tasks: readonly Todo[], width: number, theme?: Theme, goalTitle?: string, dag = false, msg: Translator = chinese, filter: TodoFilter = "full"): string[] {
  const goal = clean(goalTitle ?? "");
  // An active filter keeps the header visible when nothing matches, so the empty list explains itself.
  if (!tasks.length && !state.plan && !goal && filter === "full") return [];
  const counts = headerCounts(tasks);
  const done = counts.completed;
  let todoBlock = `${counts.root} \uf0ae Todo (${done}/${tasks.length})${dag ? " DAG" : ""}`;
  let planBlock = state.plan ? msg("󰏫 Plan [只读]") : "";
  let goalBlock = goal ? `󰓾 Goal: ${goal}` : "";
  const size = () => visibleWidth([todoBlock, planBlock, goalBlock].filter(Boolean).join(" · "));
  if (size() > width) {
    todoBlock = `${counts.root} \uf0ae Todo ${done}/${tasks.length}${dag ? " DAG" : ""}`;
    if (planBlock) planBlock = "󰏫 Plan";
    if (goalBlock) {
      const used = visibleWidth([todoBlock, planBlock].filter(Boolean).join(" · ")) + 3;
      goalBlock = clip(goalBlock, width - used);
    }
    if (size() > width && planBlock) planBlock = "Plan";
  }
  // One distinct theme color per block: Todo keeps the main accent, Plan marks the restricted
  // read-only state, and Goal carries the active objective.
  const blocks = [tint(todoBlock, "accent", theme)];
  if (planBlock) blocks.push(tint(planBlock, "error", theme));
  if (goalBlock) blocks.push(tint(goalBlock, "success", theme));
  const line = blocks.join(tint(" · ", "dim", theme));
  if (filter === "full") return [bounded(line, width, theme)];
  // The scope block is secondary: it is dropped rather than squeezing the Todo, Plan and Goal blocks.
  const scope = tint(msg`筛选：${filter === 'pending' ? msg('未完成') : msg(statusLabel[filter])}`, "muted", theme);
  const withScope = `${line}${tint(" · ", "dim", theme)}${scope}`;
  return [bounded(visibleWidth(withScope) <= width ? withScope : line, width, theme)];
}

interface TreeRow { task: Todo; prefix: string; dependencies: number[] }
const flatRows = (tasks: readonly Todo[], more = false): TreeRow[] => tasks.map((task, index) => ({ task, prefix: index === tasks.length - 1 && !more ? "└─ " : "├─ ", dependencies: task.blockedBy }));

/**
 * Chronological spanning forest of real edges, drawn strictly in creation order. Scanning the
 * selected window once, each task attaches to the deepest still-open ancestor that is a real
 * predecessor; that branch is then truncated so a parent always precedes its children and every
 * subtree stays contiguous. Tasks without an open predecessor start a new root. Edges that were
 * closed or cropped stay honest as left-hand references; hidden/extra predecessors are never
 * invented as ancestry. Two linear passes keep the work O(tasks + edges) in the common case.
 */
function pathRows(selected: readonly Todo[], width: number, more = false): TreeRow[] {
  const parents = new Map<number, number>();
  const depth = new Map<number, number>();
  const path: number[] = [];
  const open = new Map<number, number>();
  let maximum = 0;
  for (const task of selected) {
    let at = -1;
    for (const id of task.blockedBy) {
      const index = open.get(id);
      if (index !== undefined && index > at) at = index;
    }
    if (at >= 0) {
      const parent = path[at]!;
      parents.set(task.id, parent);
      for (let index = path.length - 1; index > at; index--) open.delete(path[index]!);
      path.length = at + 1;
      depth.set(task.id, depth.get(parent)! + 1);
    } else {
      open.clear();
      path.length = 0;
      depth.set(task.id, 0);
    }
    maximum = Math.max(maximum, depth.get(task.id)!);
    open.set(task.id, path.length);
    path.push(task.id);
  }
  const idWidth = selected.reduce((max, task) => Math.max(max, String(task.id).length + 1), 0);
  // First drop column alignment (below); only flatten when the path cannot fit at all.
  if (maximum * 3 + 3 + idWidth + 9 > width) return flatRows(selected, more);

  // A child is last when no later sibling shares its parent; a truncated "more" marker keeps
  // the final root open so the hidden-count line reads as a continuation.
  const lastChild = new Map<number, number>();
  for (const task of selected) lastChild.set(parents.get(task.id) ?? 0, task.id);
  const last = new Set(lastChild.values());
  if (more) {
    const root = lastChild.get(0);
    if (root !== undefined) last.delete(root);
  }

  const rows: TreeRow[] = [];
  open.clear();
  path.length = 0;
  for (const task of selected) {
    let at = -1;
    for (const id of task.blockedBy) {
      const index = open.get(id);
      if (index !== undefined && index > at) at = index;
    }
    const parent = at >= 0 ? path[at] : undefined;
    let prefix = "";
    for (let index = 0; index <= at; index++) prefix += last.has(path[index]!) ? "   " : "│  ";
    prefix += last.has(task.id) ? "└─ " : "├─ ";
    rows.push({ task, prefix, dependencies: parent !== undefined ? task.blockedBy.filter((id) => id !== parent) : task.blockedBy });
    if (at >= 0) {
      for (let index = path.length - 1; index > at; index--) open.delete(path[index]!);
      path.length = at + 1;
    } else {
      open.clear();
      path.length = 0;
    }
    open.set(task.id, path.length);
    path.push(task.id);
  }
  return rows;
}

export interface AgentView {
  id: string; todoId?: number; profile: string;
  status: "starting" | "running" | "waiting" | "completed" | "failed" | "cancelled" | "interrupted";
  /** Execution completion and report handoff are separate stages. */
  reportDelivery?: 'pending' | 'delivered';
  taskReportStale?: boolean;
  /** One-line spawn task excerpt, shown for jobs that no Todo row can carry. */
  label?: string;
  /** Live activity from the child's real event stream; display-only, never persisted. */
  activity?: { kind: "thinking" | "tool" | "output"; tool?: string; since?: number };
}
const agentLabels: Record<AgentView["status"], string> = { starting: "󰓦 启动中", running: "󰥔 运行中", waiting: "󰋗 等待回复", completed: "󰄬 已返回", failed: "󰅙 失败", cancelled: "󰓛 已取消", interrupted: "󰙦 已中断" };
const agentColors: Record<AgentView["status"], ThemeColor> = { starting: "accent", running: "accent", waiting: "warning", completed: "success", failed: "error", cancelled: "dim", interrupted: "warning" };
const pendingReport = (job: AgentView): boolean => job.status === 'completed' && job.reportDelivery === 'pending';
const agentLabel = (job: AgentView, msg: Translator): string => msg(pendingReport(job) ? '󰥔 待交付' : agentLabels[job.status]);
const agentColor = (job: AgentView): ThemeColor => pendingReport(job) ? 'warning' : agentColors[job.status];
/**
 * Live labels name the tool (MCP shortened after the last separator, clipped to 10 columns) and
 * count real elapsed time without a cap: `59s`, then `1m40s`, and `1h2m` from the first hour.
 * A missing or non-finite timestamp adds no time instead of NaN; a backwards clock clamps to 0,
 * and the zero case adds nothing so a just-started tool shows only its name.
 */
function activityLabel(activity: NonNullable<AgentView["activity"]>, now: number, msg: Translator = chinese): string {
  if (activity.kind === "thinking") return msg("󰧑 思考中");
  if (activity.kind === "output") return msg("󰏫 输出中");
  if (activity.tool) {
    const raw = clean(activity.tool);
    const name = raw.startsWith("mcp__") ? raw.split("__").at(-1)! : raw.includes(":") ? raw.split(":").at(-1)! : raw;
    const clipped = clip(name, 10);
    const since = activity.since;
    let time = "";
    if (since !== undefined && Number.isFinite(since) && Number.isFinite(now)) {
      const seconds = Math.max(0, Math.floor((now - since) / 1000));
      const minutes = Math.floor(seconds / 60);
      if (minutes >= 60) time = `${Math.floor(minutes / 60)}h${minutes % 60}m`;
      else if (seconds >= 100) time = `${minutes}m${seconds % 60}s`;
      else if (seconds > 0) time = `${seconds}s`;
    }
    return `󰆍 ${clipped}${time ? ` ${time}` : ""}`;
  }
  return msg("󰆍 工具");
}
const ACTIVE_LIVE = new Set(["starting", "running"]);
/**
 * Acceptance projection for a job bound to a Todo row. The canonical Todo state wins the moment
 * the task is completed, and a reopened (stale) report falls back to it too instead of implying a
 * fresh handoff. Unfinished non-stale jobs keep live/failure labels; only terminal completion maps
 * to the handoff (待交付) or the waiting-to-verify (待核验) stage. Unbound jobs keep agentLabel.
 */
const boundLabel = (task: Todo, job: AgentView, msg: Translator): string => {
  if (task.status === "completed") return msg("󰄬 已完成");
  // A native terminal status is already verified; a job cannot relabel it as a fresh handoff.
  if (task.status === "failed" || task.status === "cancelled") return msg(statusLabel[task.status]);
  if (ACTIVE_LIVE.has(job.status) || job.status === "waiting") return msg(agentLabels[job.status]);
  if (job.taskReportStale) return msg(statusLabel[task.status]);
  if (job.status === "completed") return msg(job.reportDelivery === "pending" ? "󰥔 待交付" : "󰥔 待核验");
  return msg(agentLabels[job.status]);
};
const boundColor = (task: Todo, job: AgentView): ThemeColor => {
  if (task.status === "completed") return agentColors.completed;
  if (task.status === "failed" || task.status === "cancelled") return colors[task.status];
  if (ACTIVE_LIVE.has(job.status) || job.status === "waiting") return agentColors[job.status];
  if (job.taskReportStale) return colors[task.status];
  if (job.status === "completed") return "warning";
  return agentColors[job.status];
};
/** Rows of the standalone section that carries jobs without a Todo of their own. */
const AGENT_ROWS = 4;

/**
 * A job bound to a Todo reports on that task row. A job spawned without one has no row to appear
 * on, so the panel lists it separately: live work first, then reports waiting for handoff, then
 * closed jobs that still explain themselves. Delivered reports stay out.
 */
function agentRank(job: AgentView): number {
  if (ACTIVE_LIVE.has(job.status) || job.status === "waiting") return 0;
  return pendingReport(job) ? 1 : 2;
}

/** Same meaning as the Todo root mark: solid while the block still holds unfinished business. */
function agentRootMark(jobs: readonly AgentView[]): string {
  return jobs.some((job) => ACTIVE_LIVE.has(job.status) || job.status === "waiting" || pendingReport(job)) ? "●" : "○";
}

function agentSection(jobs: readonly AgentView[], width: number, theme: Theme | undefined, msg: Translator, view: TaskView, limit: number): string[] {
  // Membership comes from the cached filter view; the live fields always come from this frame.
  const unbound = jobs.filter((job) => view.standaloneIds.has(job.id));
  if (!unbound.length) return [];
  const ordered = [...unbound].sort((a, b) => agentRank(a) - agentRank(b));
  const shown = limit === Infinity ? ordered : ordered.slice(0, limit);
  const count = unbound.length;
  const full = `${agentRootMark(unbound)} \uf0c0 ${msg`Standalone Subagents · ${count}`}`;
  // Narrow terminals keep the distinction and the count instead of clipping both away.
  const compact = `${agentRootMark(unbound)} \uf0c0 ${msg`Standalone · ${count}`}`;
  const lines = [bounded(tint(visibleWidth(full) <= width ? full : compact, "accent", theme), width, theme)];
  for (const [index, job] of shown.entries()) {
    const prefix = index === shown.length - 1 && shown.length === ordered.length ? "└─ " : "├─ ";
    const live = job.activity && ACTIVE_LIVE.has(job.status) ? job.activity : undefined;
    const status = `[${live ? activityLabel(live, Date.now(), msg) : agentLabel(job, msg)}]`;
    const statusWidth = visibleWidth(status);
    // Narrow terminals keep the job and its state; the profile and the excerpt are presentation.
    const compact = visibleWidth(prefix) + visibleWidth(clean(job.id)) + statusWidth + 2 > width;
    const owner = compact || !job.profile ? clean(job.id) : `${clean(job.id)} · ${clean(job.profile)}`;
    const head = tint(prefix, "dim", theme) + tint(owner, "muted", theme);
    const room = width - visibleWidth(prefix + owner) - statusWidth - 2;
    const excerpt = room >= 4 ? clip(clean(job.label ?? ""), room) : "";
    const text = excerpt ? ` ${tint(excerpt, "accent", theme)}` : "";
    const gap = " ".repeat(Math.max(1, width - visibleWidth(prefix + owner) - visibleWidth(text) - statusWidth));
    lines.push(bounded(head + text + gap + tint(status, agentColor(job), theme), width, theme));
  }
  if (ordered.length > shown.length) lines.push(tint(clip(msg`└─ … 隐藏 ${ordered.length - shown.length} 项`, width), "dim", theme));
  return lines;
}
interface RowSegment { readonly color?: ThemeColor; readonly text: string }
interface RowPlan { readonly segments: readonly RowSegment[]; readonly fits: boolean }
interface RowGeometry { readonly byTodo: Map<number, AgentView>; readonly refWidth: number; readonly prefixWidth: number; readonly align: boolean }
interface RowFrame extends RowGeometry { readonly plans: readonly (RowPlan | null)[] }

const planOf = (segments: RowSegment[], width: number): RowPlan => {
  let plain = "";
  for (const segment of segments) plain += segment.text;
  return { segments, fits: visibleWidth(plain) <= width };
};
/**
 * Theme-independent row geometry: tree+id+refs, icon, title and the right-aligned owner/status
 * suffix are laid out (and clipped) once per frame. Only `tint` runs per paint, so a theme change
 * repaints colors without recomputing widths and truncation.
 */
function planRow(row: TreeRow, job: AgentView | undefined, frame: RowGeometry, width: number, msg: Translator, view: TaskView, now: number): RowPlan {
  const { task, prefix, dependencies } = row;
  const statics = staticsFor(task);
  // A job failure or cancellation overrides an unfinished Todo; otherwise the Todo owns the row.
  const effective = view.effective.get(task.id);
  const display = effective === "failed" || effective === "cancelled" ? effective : task.status;
  const icon = icons[display];
  const iconColor = job ? boundColor(task, job) : colors[display];
  // Three blocks: (1) tree+id+refs rendered exactly as-is, byte-identical to the compact form;
  // (2) status icon+title merged as one unit starting at a unified column (fill sits after
  // the reference, never inside block 1); (3) right-aligned [owner][status] suffix.
  const refBudget = Math.max(0, width - (frame.align ? frame.prefixWidth : visibleWidth(prefix)) - visibleWidth(icon) - 2);
  const budget = Math.min(refBudget, frame.align ? frame.refWidth : Math.max(visibleWidth(`#${task.id}`), Math.floor(width * 0.38)));
  const ref = clip(reference(task, dependencies), budget);
  const lead = frame.align ? " ".repeat(frame.prefixWidth - visibleWidth(prefix) + Math.max(0, budget - visibleWidth(ref))) : "";
  const head: RowSegment[] = [{ color: "dim", text: prefix + ref + lead }, { text: " " }, { color: iconColor, text: icon }];
  const available = width - visibleWidth(prefix + ref + lead) - visibleWidth(icon) - 2;
  if (available <= 0) return planOf(head, width);
  const title = statics.subject || msg("(无标题)");
  const owner = job && !job.taskReportStale ? `${clean(job.id)} · ${clean(job.profile)}` : statics.owner || msg("主会话");
  const fragmentText = statics.fragment ? `[${statics.fragment}]` : "";
  // A completed Todo owns the label: late live or terminal job states must not contradict the task.
  const live = job && task.status !== "completed" && job.activity && ACTIVE_LIVE.has(job.status) ? job.activity : undefined;
  const label = job ? live ? activityLabel(live, now, msg) : boundLabel(task, job, msg) : msg(statusLabel[task.status]);
  const minTitle = Math.min(6, visibleWidth(title));
  const statusBudget = available - minTitle - 1;
  const variants = live?.kind === "tool" ? [label, label.replace(/ (?:\d+[hms])+$/, ""), "󰆍"] : [label];
  const ownerText = `[${owner}]`;
  // Tail order is fragment, owner, status; narrow terminals drop the fragment first, then the
  // owner, and keep the state that explains the row.
  const tails = [
    ...(statics.fragment ? [[fragmentText, ownerText]] : []),
    [ownerText],
    [],
  ];
  let suffixHead = "";
  let status = "";
  for (const parts of tails) {
    const prefixText = parts.length ? parts.join(" ") + " " : "";
    const value = variants.find((candidate) => visibleWidth(prefixText) + visibleWidth(candidate) + 2 <= statusBudget);
    if (value !== undefined) { suffixHead = prefixText; status = `[${value}]`; break; }
  }
  const suffix = suffixHead + status;
  const titleBudget = available - (suffix ? visibleWidth(suffix) + 1 : 0);
  let body = clip(title, titleBudget);
  const active = display === "in_progress" ? statics.active : "";
  const activeBudget = titleBudget - visibleWidth(title) - visibleWidth(" · ");
  if (active && activeBudget >= 1) body = `${title} · ${clip(active, activeBudget)}`;
  const gap = suffix ? frame.align ? " ".repeat(Math.max(1, available - visibleWidth(body) - visibleWidth(suffix))) : " " : "";
  return planOf([
    ...head,
    { text: " " },
    { color: "accent", text: body },
    ...(gap ? [{ text: gap }] : []),
    { color: "muted", text: suffixHead },
    { color: job ? boundColor(task, job) : "muted", text: status },
  ], width);
}
const paintPlan = (plan: RowPlan, width: number, theme: Theme | undefined): string => {
  const line = plan.segments.map((segment) => segment.color ? tint(segment.text, segment.color, theme) : segment.text).join("");
  // Geometry already fit; only a defensive truncation of the (possibly pathological) overflow runs.
  return plan.fits ? line : bounded(line, width, theme);
};
function buildFrame(rows: readonly TreeRow[], width: number, jobs: readonly AgentView[], msg: Translator, view: TaskView): RowFrame {
  const byTodo = new Map(jobs.filter((job) => job.todoId !== undefined).map((job) => [job.todoId!, job]));
  const refWidth = rows.reduce((max, row) => Math.max(max, visibleWidth(reference(row.task, row.dependencies))), 0);
  const prefixWidth = rows.reduce((max, row) => Math.max(max, visibleWidth(row.prefix)), 0);
  // Alignment is optional presentation, never worth sacrificing the path or readable text.
  const align = prefixWidth + refWidth + 4 + 6 + visibleWidth(`[${msg('主会话')}] [${msg('进行中')}]`) <= width;
  const geometry: RowGeometry = { byTodo, refWidth, prefixWidth, align };
  const plans = rows.map((row) => {
    const job = byTodo.get(row.task.id);
    // A live tool label embeds elapsed time, so that one row is laid out again on every paint.
    const live = job && row.task.status !== "completed" && job.activity && ACTIVE_LIVE.has(job.status);
    return live ? null : planRow(row, job, geometry, width, msg, view, 0);
  });
  return { ...geometry, plans };
}
const frameCache = snapshotCache<RowFrame>(4);
/** Only bound jobs draw on a row; their display-affecting fields (never elapsed time) key the frame. */
const boundJobSignature = (jobs: readonly AgentView[]): string => JSON.stringify(jobs.filter((job) => job.todoId !== undefined).map((job) => [job.id, job.todoId, job.status, job.reportDelivery ?? null, job.taskReportStale ? 1 : 0, job.profile, job.label ?? null, job.activity?.kind ?? null, job.activity?.tool ?? null, job.activity?.since ?? null]));
function frameFor(rows: readonly TreeRow[], width: number, jobs: readonly AgentView[], msg: Translator, view: TaskView): RowFrame {
  return frameCache(rows, `${width}\u0000${objectId(msg)}\u0000${objectId(view)}\u0000${boundJobSignature(jobs)}`, () => buildFrame(rows, width, jobs, msg, view));
}
function paintRows(rows: readonly TreeRow[], frame: RowFrame, width: number, theme: Theme | undefined, msg: Translator, view: TaskView): string[] {
  // No live row means no clock read, exactly like the uncached renderer.
  const now = frame.plans.some((plan) => plan === null) ? Date.now() : 0;
  return rows.map((row, index) => {
    const planned = frame.plans[index];
    const plan = planned ?? planRow(row, frame.byTodo.get(row.task.id), frame, width, msg, view, now);
    return paintPlan(plan, width, theme);
  });
}

export interface TaskViewOptions { maxRows?: number; theme?: Theme; goalTitle?: string | undefined; jobs?: readonly AgentView[]; msg?: Translator; filter?: TodoFilter }
/**
 * Bounded preview projection. Recent unfinished work wins the row budget, then the
 * most recent completed history fills the rest. Linear scans only, so a per-second redraw
 * never sorts thousands of Todos. The full view keeps the canonical list order.
 */
function previewTasks(tasks: readonly Todo[], limit: number): Todo[] {
  if (limit >= tasks.length) return [...tasks];
  const chosen = new Set<Todo>();
  for (let index = tasks.length - 1; index >= 0 && chosen.size < limit; index--) {
    const task = tasks[index]!;
    if (task.status === 'pending' || task.status === 'in_progress') chosen.add(task);
  }
  // Walk backwards: recent completed tasks are the useful context, not the oldest #1.
  for (let index = tasks.length - 1; index >= 0 && chosen.size < limit; index--) {
    const task = tasks[index]!;
    if (task.status !== 'pending' && task.status !== 'in_progress') chosen.add(task);
  }
  // Selection decides the window; rendering keeps the canonical creation order.
  return tasks.filter((task) => chosen.has(task));
}
interface RowSelection { readonly selected: readonly Todo[]; readonly more: boolean; readonly rows: TreeRow[] }
const selectionCache = snapshotCache<RowSelection>(4);
/** Bounded preview window and its structural rows, reused while the snapshot and width stay put. */
function selectionFor(tasks: readonly Todo[], style: string, width: number, limit: number): RowSelection {
  return selectionCache(tasks, `${style}\u0000${width}\u0000${limit}`, () => {
    const selected = previewTasks(tasks, limit);
    const more = tasks.length > selected.length;
    return { selected, more, rows: style === "flat" ? flatRows(selected, more) : pathRows(selected, width, more) };
  });
}
const fallbackCache = snapshotCache<RowSelection>(4);
/** Flat list the DAG uses when its layout degrades; same window rules as the uncached path. */
function fallbackFor(tasks: readonly Todo[], limit: number): RowSelection {
  return fallbackCache(tasks, `flat\u0000${limit}`, () => {
    const selected = tasks.slice(0, limit === Infinity ? tasks.length : Math.max(1, limit - 2));
    const more = selected.length < tasks.length;
    return { selected, more, rows: flatRows(selected, more) };
  });
}
/** Default: main dependency paths. Flat mode retains all predecessor references. */
export function renderTasks(state: WorkflowState, width: number, options?: TaskViewOptions): string[] {
  width = columns(width);
  if (!width) return [];
  const msg = options?.msg ?? chinese;
  const jobs = options?.jobs ?? [];
  const filter = options?.filter ?? state.filter ?? "full";
  const view = filteredView(state.tasks, filter, jobs);
  const tasks = view.tasks;
  const lines = header(state, tasks, width, options?.theme, options?.goalTitle, false, msg, filter);
  const requested = options?.maxRows ?? 8;
  const limit = requested === Infinity ? tasks.length : Number.isFinite(requested) ? Math.max(0, Math.floor(requested)) : 8;
  const selection = selectionFor(tasks, state.treeStyle === "flat" ? "flat" : "chain", width, limit);
  lines.push(...paintRows(selection.rows, frameFor(selection.rows, width, jobs, msg, view), width, options?.theme, msg, view));
  if (selection.more) lines.push(tint(clip(msg`└─ … 隐藏 ${tasks.length - selection.selected.length} 项`, width), "dim", options?.theme));
  // The bounded widget keeps four standalone rows; the complete view carries every job it shows.
  lines.push(...agentSection(jobs, width, options?.theme, msg, view, requested === Infinity ? Infinity : AGENT_ROWS));
  return lines;
}

/** Complete solid-line graph, not a spanning tree. Only fallback lists repeat predecessor ids. */
export function renderDag(state: WorkflowState, width: number, theme?: Theme, goalTitle?: string, jobs: readonly AgentView[] = [], options?: { maxLines?: number; msg?: Translator; filter?: TodoFilter }): string[] {
  width = columns(width);
  if (!width) return [];
  const msg = options?.msg ?? chinese;
  const filter = options?.filter ?? state.filter ?? "full";
  const view = filteredView(state.tasks, filter, jobs);
  const tasks = view.tasks;
  const lines = header(state, tasks, width, theme, goalTitle, true, msg, filter);
  // The graph keeps its own preview budget; Standalone is appended after it on every path exactly once.
  const tail = agentSection(jobs, width, theme, msg, view, options?.maxLines === undefined ? Infinity : AGENT_ROWS);
  if (!tasks.length) return [...lines, ...tail];
  const limit = options?.maxLines !== undefined && Number.isFinite(options.maxLines) ? Math.max(3, Math.floor(options.maxLines)) : Infinity;
  const result = dagLayout(projection(view.dagTasks), width, msg);
  if (!result.layout) {
    lines.push(tint(clip(msg`图已降级为列表：${result.reason}；左编号保留完整前驱`, width), "dim", theme));
    const selection = fallbackFor(tasks, limit);
    const rendered = paintRows(selection.rows, frameFor(selection.rows, width, jobs, msg, view), width, theme, msg, view);
    const rows = selection.rows;
    const selected = selection.selected;
    for (const [index, row] of rows.entries()) {
      if (lines.length >= limit) break;
      lines.push(rendered[index]!);
      const fullRef = reference(row.task, row.dependencies);
      if (row.dependencies.length && !stripTerminalSequences(rendered[index]!).includes(fullRef)) {
        // Never claim a truncated identifier contains all predecessors.
        lines.push(...wrapTextWithAnsi(fullRef, width).map((part) => tint(part, 'dim', theme)));
      }
    }
    if (selected.length < tasks.length || lines.length >= limit) return [...lines.slice(0, limit), tint(clip(msg`图预览 · 共 ${tasks.length} 项 · /dag 查看完整结构`, width), 'dim', theme), ...tail];
    return [...lines, ...tail];
  }
  const layout = result.layout;
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const byTodo = new Map(jobs.filter((job) => job.todoId !== undefined).map((job) => [job.todoId!, job]));
  const bodies = new Map<number, { left: number; width: number; text: string }[]>();
  const overflowRefs: string[] = [];
  for (const box of layout.boxes) {
    if (box.top + 1 >= limit) continue;
    const task = byId.get(box.id)!;
    const job = byTodo.get(box.id);
    // Same override rule as a list row: a job failure or cancellation replaces an unfinished Todo.
    const effective = view.effective.get(task.id);
    const display = effective === "failed" || effective === "cancelled" ? effective : task.status;
    const budget = box.width - 4;
    // A filtered graph cannot draw an edge to a hidden prerequisite, so the box names it as a
    // left-hand reference instead of implying the dependency is met.
    const hidden = view.external.get(task.id) ?? [];
    const idText = `#${task.id}${hidden.length ? `<-${hidden.map((id) => `#${id}`).join(",")}` : ""} `;
    const prefix = `${icons[display]} ${idText}`;
    const title = clip(clean(task.subject), Math.max(0, budget - visibleWidth(prefix)));
    const rawFirst = tint(icons[display], colors[display], theme) + " " + tint(idText, "dim", theme) + tint(title, "accent", theme);
    const first = bounded(rawFirst, budget, theme);
    if (hidden.length && visibleWidth(prefix) > budget) overflowRefs.push(reference(task, hidden));
    const owner = job && !job.taskReportStale ? `${clean(job.id)} · ${clean(job.profile)}` : staticsFor(task).owner || msg("主会话");
    const live = job && display !== "completed" && job.activity && ACTIVE_LIVE.has(job.status) ? job.activity : undefined;
    const label = job ? live ? activityLabel(live, Date.now(), msg) : boundLabel(task, job, msg) : msg(statusLabel[display]);
    const content = [first, tint(clip(`[${owner}]`, budget), "muted", theme), tint(clip(`[${label}]`, budget), job ? boundColor(task, job) : colors[display], theme)];
    content.forEach((text, index) => {
      const y = box.top + index + 1;
      const group = bodies.get(y) ?? [];
      group.push({ left: box.left + 1, width: box.width - 2, text: " " + text + " ".repeat(Math.max(0, box.width - 3 - visibleWidth(text))) });
      bodies.set(y, group);
    });
  }
  const offset = " ".repeat(Math.max(0, Math.floor((width - layout.width) / 2)));
  for (const [y, raw] of layout.lines.slice(0, Math.max(0, limit - lines.length)).entries()) {
    let x = 0; let row = offset;
    for (const part of (bodies.get(y) ?? []).sort((a, b) => a.left - b.left)) {
      row += tint(raw.slice(x, part.left), "dim", theme) + part.text;
      x = part.left + part.width;
    }
    row += tint(raw.slice(x), "dim", theme);
    lines.push(bounded(row, width, theme));
  }
  if (lines.length - 1 < layout.lines.length) lines.push(tint(clip(msg`图预览 ${lines.length}/${layout.lines.length + 1} 行 · /dag 滚动查看完整结构`, width), 'dim', theme));
  else if (layout.crossings) lines.push(tint(clip(msg("╳ 仅交叉、不汇合；依赖从上向下读取"), width), "dim", theme));
  if (overflowRefs.length) {
    if (limit === Infinity) for (const ref of overflowRefs) lines.push(...wrapTextWithAnsi(ref, width).map((part) => tint(part, 'dim', theme)));
    else lines.push(tint(clip(msg('前置引用已截断；/dag 查看完整结构'), width), 'dim', theme));
  }
  return [...lines, ...tail];
}
