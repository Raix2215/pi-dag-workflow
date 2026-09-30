import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import { sliceByColumn, stripTerminalSequences, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { deriveDag, type DagProjection } from "./graph.ts";
import { statusLabel, type Todo, type WorkflowState } from "./todos.ts";

const icons = { pending: "○", in_progress: "◐", completed: "✓", deleted: "×" } as const;
const colors: Record<Todo["status"], ThemeColor> = { pending: "muted", in_progress: "accent", completed: "success", deleted: "dim" };
const projections = new WeakMap<readonly Todo[], DagProjection>();

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

function projection(tasks: readonly Todo[]): DagProjection {
  let view = projections.get(tasks);
  if (!view) { view = deriveDag(tasks); projections.set(tasks, view); }
  return view;
}

/** Goal is display input from a real focus controller, not a second Goal state store. */
function header(state: WorkflowState, tasks: readonly Todo[], width: number, theme?: Theme, goalTitle?: string, dag = false): string[] {
  const goal = clean(goalTitle ?? "");
  if (!tasks.length && !state.plan && !goal) return [];
  const done = tasks.filter((task) => task.status === "completed").length;
  let todoBlock = `${rootMark(tasks)} \uf0ae Todo (${done}/${tasks.length})${dag ? " DAG" : ""}`;
  let planBlock = state.plan ? "󰏫 Plan [只读]" : "";
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
  const blocks = [tint(todoBlock, "accent", theme)];
  if (planBlock) blocks.push(tint(planBlock, "warning", theme));
  if (goalBlock) blocks.push(tint(goalBlock, "accent", theme));
  return [bounded(blocks.join(tint(" · ", "dim", theme)), width, theme)];
}

interface TreeRow { task: Todo; prefix: string; dependencies: number[] }
const flatRows = (tasks: readonly Todo[], more = false): TreeRow[] => tasks.map((task, index) => ({ task, prefix: index === tasks.length - 1 && !more ? "└─ " : "├─ ", dependencies: task.blockedBy }));

/** A visual spanning forest of real edges; hidden/extra predecessors stay in the left reference. */
function pathRows(all: readonly Todo[], selected: readonly Todo[], width: number, more = false): TreeRow[] {
  const dag = projection(all);
  const depth = new Map(dag.layers.flatMap((ids, layer) => ids.map((id) => [id, layer] as const)));
  const order = new Map(all.map((task, index) => [task.id, index]));
  const visible = new Set(selected.map((task) => task.id));
  const parents = new Map<number, number>();
  const children = new Map<number, Todo[]>();
  for (const task of selected) {
    let parent: number | undefined;
    for (const id of task.blockedBy) {
      if (!visible.has(id)) continue;
      if (parent === undefined || depth.get(id)! > depth.get(parent)! || depth.get(id) === depth.get(parent) && order.get(id)! < order.get(parent)!) parent = id;
    }
    if (parent !== undefined) parents.set(task.id, parent);
    const group = children.get(parent ?? 0) ?? [];
    group.push(task);
    children.set(parent ?? 0, group);
  }
  const displayDepth = new Map<number, number>();
  let maximum = 0;
  for (const ids of dag.layers) for (const id of ids) if (visible.has(id)) {
    const parent = parents.get(id);
    const level = parent === undefined ? 0 : displayDepth.get(parent)! + 1;
    displayDepth.set(id, level);
    maximum = Math.max(maximum, level);
  }
  const idWidth = selected.reduce((max, task) => Math.max(max, String(task.id).length + 1), 0);
  // First drop column alignment (below); only flatten when the path cannot fit at all.
  if (maximum * 3 + 3 + idWidth + 9 > width) return flatRows(selected, more);

  const roots = children.get(0) ?? [];
  const stack = roots.map((task, index) => ({ task, last: index === roots.length - 1 && !more, ancestors: [] as boolean[] })).reverse();
  const rows: TreeRow[] = [];
  while (stack.length) {
    const item = stack.pop()!;
    const parent = parents.get(item.task.id);
    rows.push({ task: item.task, prefix: item.ancestors.map((last) => last ? "   " : "│  ").join("") + (item.last ? "└─ " : "├─ "), dependencies: item.task.blockedBy.filter((id) => id !== parent) });
    const group = children.get(item.task.id) ?? [];
    for (let index = group.length - 1; index >= 0; index--) stack.push({ task: group[index]!, last: index === group.length - 1, ancestors: [...item.ancestors, item.last] });
  }
  return rows;
}

export interface AgentView {
  id: string; todoId?: number; profile: string;
  status: "starting" | "running" | "waiting" | "completed" | "failed" | "cancelled" | "interrupted";
  /** Live activity from the child's real event stream; display-only, never persisted. */
  activity?: { kind: "thinking" | "tool" | "output"; tool?: string; since?: number };
}
const agentLabels: Record<AgentView["status"], string> = { starting: "󰀡 启动中", running: "󰥔 运行中", waiting: "󰋗 等待回复", completed: "󰄬 已返回", failed: "󰅤 失败", cancelled: "󰅤 已取消", interrupted: "󰅤 已中断" };
const agentColors: Record<AgentView["status"], ThemeColor> = { starting: "accent", running: "accent", waiting: "warning", completed: "success", failed: "error", cancelled: "dim", interrupted: "warning" };
/** Live labels use seconds capped at 99; tool names clipped to 10 columns (MCP shortened after the last separator). */
function activityLabel(activity: NonNullable<AgentView["activity"]>, now: number): string {
  const seconds = activity.since ? Math.min(99, Math.floor((now - activity.since) / 1000)) : 0;
  if (activity.kind === "thinking") return "󰧑 思考中";
  if (activity.kind === "output") return "󰏫 输出中";
  if (activity.tool) {
    const name = activity.tool.split(/[_.:]/).filter(Boolean).at(-1) ?? activity.tool;
    const clipped = visibleWidth(name) > 10 ? sliceByColumn(name, 0, 9) + "…" : name;
    return `󰆍 ${clipped}${seconds ? ` ${seconds}s` : ""}`;
  }
  return "󰆍 工具";
}
const ACTIVE_LIVE = new Set(["starting", "running"]);
function drawRows(rows: readonly TreeRow[], width: number, theme?: Theme, jobs: readonly AgentView[] = []): string[] {
  const byTodo = new Map(jobs.filter((job) => job.todoId !== undefined).map((job) => [job.todoId!, job]));
  const refWidth = rows.reduce((max, row) => Math.max(max, visibleWidth(reference(row.task, row.dependencies))), 0);
  const prefixWidth = rows.reduce((max, row) => Math.max(max, visibleWidth(row.prefix)), 0);
  // Alignment is optional presentation, never worth sacrificing the path or readable text.
  const align = prefixWidth + refWidth + 4 + 6 + visibleWidth("[主会话] [进行中]") <= width;
  return rows.map(({ task, prefix, dependencies }) => {
    const icon = icons[task.status];
    const refBudget = Math.max(0, width - visibleWidth(prefix) - visibleWidth(icon) - 2);
    const budget = Math.min(refBudget, align ? refWidth : Math.max(visibleWidth(`#${task.id}`), Math.floor(width * 0.38)));
    const ref = clip(reference(task, dependencies), budget);
    const pad = align ? " ".repeat(Math.max(0, budget - visibleWidth(ref))) : "";
    const left = tint(prefix + ref + pad, "dim", theme) + " " + tint(icon, colors[task.status], theme);
    const available = width - visibleWidth(left) - 1;
    if (available <= 0) return bounded(left, width, theme);
    const title = clean(task.subject) || "(无标题)";
    const job = byTodo.get(task.id);
    const owner = job ? `${clean(job.id)} · ${clean(job.profile)}` : clean(task.owner ?? "") || "主会话";
    const status = `[${job ? job.activity && ACTIVE_LIVE.has(job.status) ? activityLabel(job.activity, Date.now()) : agentLabels[job.status] : statusLabel[task.status]}]`;
    const minTitle = Math.min(6, visibleWidth(title));
    const ownerBudget = available - minTitle - visibleWidth(status) - 2;
    let suffix = "";
    if (ownerBudget >= visibleWidth(owner) + 2) suffix = `[${owner}] ${status}`;
    else if (available >= minTitle + visibleWidth(status) + 1) suffix = status;
    const titleBudget = available - (suffix ? visibleWidth(suffix) + 1 : 0);
    let body = clip(title, titleBudget);
    const active = task.status === "in_progress" ? clean(task.activeForm ?? "") : "";
    const activeBudget = titleBudget - visibleWidth(title) - visibleWidth(" · ");
    if (active && activeBudget >= 1) body = `${title} · ${clip(active, activeBudget)}`;
    const gap = suffix ? align ? " ".repeat(Math.max(1, available - visibleWidth(body) - visibleWidth(suffix))) : " " : "";
    return bounded(left + " " + tint(body, "accent", theme) + gap + tint(suffix, job ? agentColors[job.status] : "muted", theme), width, theme);
  });
}

export interface TaskViewOptions { maxRows?: number; theme?: Theme; goalTitle?: string; jobs?: readonly AgentView[] }
/** Default: main dependency paths. Flat mode retains all predecessor references. */
export function renderTasks(state: WorkflowState, width: number, options?: TaskViewOptions): string[] {
  width = columns(width);
  if (!width) return [];
  const tasks = state.tasks.filter((task) => task.status !== "deleted");
  const lines = header(state, tasks, width, options?.theme, options?.goalTitle);
  const requested = options?.maxRows ?? 8;
  const limit = requested === Infinity ? tasks.length : Number.isFinite(requested) ? Math.max(0, Math.floor(requested)) : 8;
  const unfinished = tasks.filter((task) => task.status !== "completed");
  const completed = tasks.filter((task) => task.status === "completed");
  const chosen = new Set([...unfinished, ...completed].slice(0, limit));
  const selected = tasks.filter((task) => chosen.has(task));
  const more = tasks.length > selected.length;
  const rows = state.treeStyle === "flat" ? flatRows(selected, more) : pathRows(state.tasks, selected, width, more);
  lines.push(...drawRows(rows, width, options?.theme, options?.jobs));
  if (more) lines.push(tint(clip(`└─ … 隐藏 ${tasks.length - selected.length} 项`, width), "dim", options?.theme));
  return lines;
}

/** Complete incoming references for the basic layered DAG view; richer routing remains separate. */
export function renderDag(state: WorkflowState, width: number, theme?: Theme, goalTitle?: string, jobs?: readonly AgentView[]): string[] {
  width = columns(width);
  if (!width) return [];
  if (width < 40) return renderTasks({ ...state, treeStyle: "flat" }, width, { maxRows: Infinity, ...(theme ? { theme } : {}), ...(goalTitle ? { goalTitle } : {}), ...(jobs ? { jobs } : {}) });
  const dag = projection(state.tasks);
  const tasks = state.tasks.filter((task) => task.status !== "deleted");
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const lines = header(state, tasks, width, theme, goalTitle, true);
  for (const [index, layer] of dag.layers.entries()) {
    lines.push(tint(clip(`── 第 ${index + 1} 层 ──`, width), "dim", theme));
    lines.push(...drawRows(flatRows(layer.map((id) => byId.get(id)!)), width, theme, jobs));
  }
  return lines;
}
