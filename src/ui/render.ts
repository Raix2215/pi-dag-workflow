import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { dagStructure, type DagStructure } from "../dag/cache.ts";
import { dagLayout } from "../dag/layout.ts";
import { statusLabel, type Todo, type WorkflowState } from "../todos/state.ts";
import { chinese, type Translator } from "../shared/i18n.ts";

const icons = { pending: "○", in_progress: "◐", completed: "✓", deleted: "×" } as const;
const colors: Record<Todo["status"], ThemeColor> = { pending: "muted", in_progress: "accent", completed: "success", deleted: "dim" };

/** Untrusted text never contributes terminal controls; keep emoji ZWJ sequences intact. */
export function clean(text: string): string {
  const escaped = text.replace(/\u009b/g, "\x1b[").replace(/\u009d/g, "\x1b]").replace(/\u009c/g, "\x1b\\");
  return stripTerminalSequences(escaped).replace(/[\r\n\t\u2028\u2029]+/g, " ").replace(/[\p{Cc}\p{Bidi_Control}\u206a-\u206f]/gu, "").trim();
}
const columns = (width: number): number => Number.isFinite(width) ? Math.max(0, Math.floor(width)) : 0;
const clip = (text: string, width: number): string => stripTerminalSequences(truncateToWidth(text, Math.max(0, width), "…"));
const tint = (text: string, color: ThemeColor, theme?: Theme): string => theme ? theme.fg(color, text) : text;
const bounded = (line: string, width: number, theme?: Theme): string => {
  const result = truncateToWidth(line, width, "…");
  return theme ? result : stripTerminalSequences(result);
};
const reference = (task: Todo, dependencies: readonly number[]): string => `#${task.id}${dependencies.length ? `<-${dependencies.map((id) => `#${id}`).join(",")}` : ""}`;
const rootMark = (tasks: readonly Todo[]): string => tasks.some((task) => task.status !== "completed") ? "●" : "○";

function projection(tasks: readonly Todo[]): DagStructure { return dagStructure(tasks); }

/** Goal is display input from a real focus controller, not a second Goal state store. */
function header(state: WorkflowState, tasks: readonly Todo[], width: number, theme?: Theme, goalTitle?: string, dag = false, msg: Translator = chinese): string[] {
  const goal = clean(goalTitle ?? "");
  if (!tasks.length && !state.plan && !goal) return [];
  const done = tasks.filter((task) => task.status === "completed").length;
  let todoBlock = `${rootMark(tasks)} \uf0ae Todo (${done}/${tasks.length})${dag ? " DAG" : ""}`;
  let planBlock = state.plan ? msg("󰏫 Plan [只读]") : "";
  let goalBlock = goal ? `󰓾 Goal: ${goal}` : "";
  const size = () => visibleWidth([todoBlock, planBlock, goalBlock].filter(Boolean).join(" · "));
  if (size() > width) {
    todoBlock = `${rootMark(tasks)} \uf0ae Todo ${done}/${tasks.length}${dag ? " DAG" : ""}`;
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
  return [bounded(blocks.join(tint(" · ", "dim", theme)), width, theme)];
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
/** Live labels use seconds capped at 99; tool names clipped to 10 columns (MCP shortened after the last separator). */
function activityLabel(activity: NonNullable<AgentView["activity"]>, now: number, msg: Translator = chinese): string {
  const seconds = activity.since !== undefined ? Math.min(99, Math.max(0, Math.floor((now - activity.since) / 1000))) : 0;
  if (activity.kind === "thinking") return msg("󰧑 思考中");
  if (activity.kind === "output") return msg("󰏫 输出中");
  if (activity.tool) {
    const raw = clean(activity.tool);
    const name = raw.startsWith("mcp__") ? raw.split("__").at(-1)! : raw.includes(":") ? raw.split(":").at(-1)! : raw;
    const clipped = clip(name, 10);
    return `󰆍 ${clipped}${seconds ? ` ${seconds}s` : ""}`;
  }
  return msg("󰆍 工具");
}
const ACTIVE_LIVE = new Set(["starting", "running"]);
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

function agentSection(jobs: readonly AgentView[], width: number, theme?: Theme, msg: Translator = chinese): string[] {
  const unbound = jobs.filter((job) => job.todoId === undefined && (job.status !== "completed" || job.reportDelivery === "pending"));
  if (!unbound.length) return [];
  const ordered = [...unbound].sort((a, b) => agentRank(a) - agentRank(b));
  const shown = ordered.slice(0, AGENT_ROWS);
  const lines = [bounded(tint("\uf0c0 ", "dim", theme) + tint(msg`子 Agent · ${unbound.length}`, "muted", theme), width, theme)];
  for (const [index, job] of shown.entries()) {
    const prefix = index === shown.length - 1 && shown.length === ordered.length ? "└─ " : "├─ ";
    const live = job.activity && ACTIVE_LIVE.has(job.status) ? job.activity : undefined;
    const status = `[${live ? activityLabel(live, Date.now(), msg) : agentLabel(job, msg)}]`;
    const statusWidth = visibleWidth(status);
    // Narrow terminals keep the job and its state; the profile and the excerpt are presentation.
    const compact = visibleWidth(prefix) + visibleWidth(clean(job.id)) + statusWidth + 2 > width;
    const owner = compact || !job.profile ? clean(job.id) : `${clean(job.id)} · ${clean(job.profile)}`;
    const head = tint(prefix, "dim", theme) + tint(owner, "dim", theme);
    const room = width - visibleWidth(prefix + owner) - statusWidth - 2;
    const excerpt = room >= 4 ? clip(clean(job.label ?? ""), room) : "";
    const text = excerpt ? ` ${tint(excerpt, "accent", theme)}` : "";
    const gap = " ".repeat(Math.max(1, width - visibleWidth(prefix + owner) - visibleWidth(text) - statusWidth));
    lines.push(bounded(head + text + gap + tint(status, agentColor(job), theme), width, theme));
  }
  if (ordered.length > shown.length) lines.push(tint(clip(msg`└─ … 隐藏 ${ordered.length - shown.length} 项`, width), "dim", theme));
  return lines;
}
function drawRows(rows: readonly TreeRow[], width: number, theme?: Theme, jobs: readonly AgentView[] = [], msg: Translator = chinese): string[] {
  const byTodo = new Map(jobs.filter((job) => job.todoId !== undefined).map((job) => [job.todoId!, job]));
  const refWidth = rows.reduce((max, row) => Math.max(max, visibleWidth(reference(row.task, row.dependencies))), 0);
  const prefixWidth = rows.reduce((max, row) => Math.max(max, visibleWidth(row.prefix)), 0);
  // Alignment is optional presentation, never worth sacrificing the path or readable text.
  const align = prefixWidth + refWidth + 4 + 6 + visibleWidth(`[${msg('主会话')}] [${msg('进行中')}]`) <= width;
  return rows.map(({ task, prefix, dependencies }) => {
    const icon = icons[task.status];
    // Three blocks: (1) tree+id+refs rendered exactly as-is, byte-identical to the compact form;
    // (2) status icon+title merged as one unit starting at a unified column (fill sits after
    // the reference, never inside block 1); (3) right-aligned [owner][status] suffix.
    const refBudget = Math.max(0, width - (align ? prefixWidth : visibleWidth(prefix)) - visibleWidth(icon) - 2);
    const budget = Math.min(refBudget, align ? refWidth : Math.max(visibleWidth(`#${task.id}`), Math.floor(width * 0.38)));
    const ref = clip(reference(task, dependencies), budget);
    const lead = align ? " ".repeat(prefixWidth - visibleWidth(prefix) + Math.max(0, budget - visibleWidth(ref))) : "";
    const left = tint(prefix + ref + lead, "dim", theme) + " " + tint(icon, colors[task.status], theme);
    const available = width - visibleWidth(left) - 1;
    if (available <= 0) return bounded(left, width, theme);
    const title = clean(task.subject) || msg("(无标题)");
    const job = byTodo.get(task.id);
    const owner = job ? `${clean(job.id)} · ${clean(job.profile)}` : clean(task.owner ?? "") || msg("主会话");
    const live = job?.activity && ACTIVE_LIVE.has(job.status) ? job.activity : undefined;
    const label = job ? live ? activityLabel(live, Date.now(), msg) : agentLabel(job, msg) : msg(statusLabel[task.status]);
    const minTitle = Math.min(6, visibleWidth(title));
    const statusBudget = available - minTitle - 1;
    const variants = live?.kind === "tool" ? [label, label.replace(/ \d+s$/, ""), "󰆍"] : [label];
    const ownerText = `[${owner}]`;
    const withOwner = variants.find((value) => visibleWidth(ownerText) + 1 + visibleWidth(value) + 2 <= statusBudget);
    const chosen = withOwner ?? variants.find((value) => visibleWidth(value) + 2 <= statusBudget);
    const status = chosen !== undefined ? `[${chosen}]` : "";
    const ownerPart = withOwner !== undefined ? ownerText + " " : "";
    const suffix = ownerPart + status;
    const titleBudget = available - (suffix ? visibleWidth(suffix) + 1 : 0);
    let body = clip(title, titleBudget);
    const active = task.status === "in_progress" ? clean(task.activeForm ?? "") : "";
    const activeBudget = titleBudget - visibleWidth(title) - visibleWidth(" · ");
    if (active && activeBudget >= 1) body = `${title} · ${clip(active, activeBudget)}`;
    const gap = suffix ? align ? " ".repeat(Math.max(1, available - visibleWidth(body) - visibleWidth(suffix))) : " " : "";
    return bounded(left + " " + tint(body, "accent", theme) + gap + tint(ownerPart, "muted", theme) + tint(status, job ? agentColor(job) : 'muted', theme), width, theme);
  });
}

export interface TaskViewOptions { maxRows?: number; theme?: Theme; goalTitle?: string | undefined; jobs?: readonly AgentView[]; msg?: Translator }
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
    if (task.status !== "completed") chosen.add(task);
  }
  // Walk backwards: recent completed tasks are the useful context, not the oldest #1.
  for (let index = tasks.length - 1; index >= 0 && chosen.size < limit; index--) {
    const task = tasks[index]!;
    if (task.status === "completed") chosen.add(task);
  }
  // Selection decides the window; rendering keeps the canonical creation order.
  return tasks.filter((task) => chosen.has(task));
}
/** Default: main dependency paths. Flat mode retains all predecessor references. */
export function renderTasks(state: WorkflowState, width: number, options?: TaskViewOptions): string[] {
  width = columns(width);
  if (!width) return [];
  const msg = options?.msg ?? chinese;
  const tasks = state.tasks.filter((task) => task.status !== "deleted");
  const lines = header(state, tasks, width, options?.theme, options?.goalTitle, false, msg);
  const requested = options?.maxRows ?? 8;
  const limit = requested === Infinity ? tasks.length : Number.isFinite(requested) ? Math.max(0, Math.floor(requested)) : 8;
  const selected = previewTasks(tasks, limit);
  const more = tasks.length > selected.length;
  const rows = state.treeStyle === "flat" ? flatRows(selected, more) : pathRows(selected, width, more);
  lines.push(...drawRows(rows, width, options?.theme, options?.jobs, msg));
  if (more) lines.push(tint(clip(msg`└─ … 隐藏 ${tasks.length - selected.length} 项`, width), "dim", options?.theme));
  lines.push(...agentSection(options?.jobs ?? [], width, options?.theme, msg));
  return lines;
}

/** Complete solid-line graph, not a spanning tree. Only fallback lists repeat predecessor ids. */
export function renderDag(state: WorkflowState, width: number, theme?: Theme, goalTitle?: string, jobs: readonly AgentView[] = [], options?: { maxLines?: number; msg?: Translator }): string[] {
  width = columns(width);
  if (!width) return [];
  const msg = options?.msg ?? chinese;
  const tasks = state.tasks.filter((task) => task.status !== "deleted");
  const lines = header(state, tasks, width, theme, goalTitle, true, msg);
  if (!tasks.length) return lines;
  const limit = options?.maxLines !== undefined && Number.isFinite(options.maxLines) ? Math.max(3, Math.floor(options.maxLines)) : Infinity;
  const result = dagLayout(projection(state.tasks), width, msg);
  if (!result.layout) {
    lines.push(tint(clip(msg`图已降级为列表：${result.reason}；左编号保留完整前驱`, width), "dim", theme));
    const selected = tasks.slice(0, limit === Infinity ? tasks.length : Math.max(1, limit - 2));
    const rows = flatRows(selected, selected.length < tasks.length);
    const rendered = drawRows(rows, width, theme, jobs, msg);
    for (const [index, row] of rows.entries()) {
      if (lines.length >= limit) break;
      lines.push(rendered[index]!);
      const fullRef = reference(row.task, row.dependencies);
      if (row.dependencies.length && !stripTerminalSequences(rendered[index]!).includes(fullRef)) {
        // Never claim a truncated identifier contains all predecessors.
        lines.push(...wrapTextWithAnsi(fullRef, width).map((part) => tint(part, 'dim', theme)));
      }
    }
    if (selected.length < tasks.length || lines.length >= limit) return [...lines.slice(0, limit), tint(clip(msg`图预览 · 共 ${tasks.length} 项 · /dag 查看完整结构`, width), 'dim', theme)];
    return lines;
  }
  const layout = result.layout;
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const byTodo = new Map(jobs.filter((job) => job.todoId !== undefined).map((job) => [job.todoId!, job]));
  const bodies = new Map<number, { left: number; width: number; text: string }[]>();
  for (const box of layout.boxes) {
    if (box.top + 1 >= limit) continue;
    const task = byId.get(box.id)!;
    const job = byTodo.get(box.id);
    const budget = box.width - 4;
    const prefix = `${icons[task.status]} #${task.id} `;
    const title = clip(clean(task.subject), Math.max(0, budget - visibleWidth(prefix)));
    const first = tint(icons[task.status], colors[task.status], theme) + tint(` #${task.id} `, "dim", theme) + tint(title, "accent", theme);
    const owner = job ? `${clean(job.id)} · ${clean(job.profile)}` : clean(task.owner ?? "") || msg("主会话");
    const label = job ? job.activity && ACTIVE_LIVE.has(job.status) ? activityLabel(job.activity, Date.now(), msg) : agentLabel(job, msg) : msg(statusLabel[task.status]);
    const content = [first, tint(clip(`[${owner}]`, budget), "muted", theme), tint(clip(`[${label}]`, budget), job ? agentColor(job) : colors[task.status], theme)];
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
  return lines;
}
