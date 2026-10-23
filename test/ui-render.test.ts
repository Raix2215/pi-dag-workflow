import assert from "node:assert/strict";
import { checkpointSummary, type CheckpointJob, type CheckpointSummaryOptions } from '../src/todos/domain/checkpoint-summary.ts';
import { test } from "node:test";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { createTranslator } from "../src/shared/i18n.ts";
import { emptyState } from "../src/todos/domain/state.ts";
import type { Todo } from "../src/shared/task-types.ts";
import { taskContext, fragmentContext, contextArtifacts } from "../src/agents/domain/context.ts";
import { renderTasks } from "../src/shared/ui/render.ts";
import type { AgentView } from "../src/shared/agent-view.ts";
import type { WorkflowState } from "../src/shared/task-types.ts";
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWorkflow } from '../src/workflow/index.ts';
import { FEATURE_NAMES, type Feature } from '../src/workflow/domain/features.ts';
import { STATE_TYPE } from '../src/todos/domain/state.ts';
import { PresetStore } from '../src/todos/domain/presets.ts';
import { widgetHeightBudget } from '../src/shared/ui/render.ts';
import { Theme } from '@earendil-works/pi-coding-agent';
import { Lru, snapshotCache } from '../src/shared/ui/render-cache.ts';
import { renderDag } from '../src/shared/ui/render.ts';
import { restoreState } from "../src/todos/domain/state.ts";
import type { Translator } from "../src/shared/i18n.ts";
import { readFileSync } from 'node:fs';
import { Theme as Theme_view_filters } from '@earendil-works/pi-coding-agent';
import type { TodoFilter } from "../src/shared/task-types.ts";
import { filteredView, latestBoundJobs, taskFilterStatus } from '../src/shared/ui/filter.ts';
import { dagStructure } from '../src/shared/dag/cache.ts';
import type { ThemeColor, ThemeBg } from "@earendil-works/pi-coding-agent";
import { renderWidget } from '../src/shared/ui/render.ts';
import { createWorkflowView } from '../src/workflow/commands/view.ts';
import { jobSummary } from '../src/shared/ui/presentation.ts';

// activity-elapsed.test.ts
{
const task: Todo = { id: 1, subject: "实现解析器", status: "in_progress", blockedBy: [] };
const base = { ...emptyState(), tasks: [task], nextId: 2 };
const locales = ["zh-CN", "en"] as const;

const job = (tool: string | undefined, since: number | undefined): AgentView => ({
  id: "a1", todoId: 1, profile: "coding", status: "running",
  activity: { kind: "tool", ...(tool !== undefined ? { tool } : {}), ...(since !== undefined ? { since } : {}) },
});
const render = (jobs: readonly AgentView[], width: number, locale: (typeof locales)[number]): string[] =>
  renderTasks(base, width, { jobs, maxRows: Infinity, msg: createTranslator(locale) }).map(stripTerminalSequences);

test("elapsed seconds stay unbounded and compact from seconds through hours in both locales", () => {
  const cases: Array<[number, string]> = [
    [45_000, "45s"],       // under a minute keeps plain seconds
    [99_000, "99s"],       // still seconds at the old cap
    [145_000, "2m25s"],    // past it, minutes and seconds
    [725_000, "12m5s"],    // two-digit minutes drop the empty padding
    [3_720_000, "1h2m"],   // the first hour switches to hours and minutes
    [36_000_000, "10h0m"], // long runs stay bounded, never growing a third unit
  ];
  for (const locale of locales) {
    for (const [elapsed, expected] of cases) {
      const line = render([job("bash", Date.now() - elapsed)], 120, locale).join("\n");
      assert.match(line, new RegExp(`󰆍 bash ${expected}`), `${locale} at ${elapsed}ms`);
      assert.doesNotMatch(line, /NaN|Infinity/);
    }
  }
});

test("a backwards clock clamps to zero and non-finite timestamps add no time or NaN", () => {
  for (const locale of locales) {
    const future = render([job("bash", Date.now() + 5_000)], 120, locale).join("\n");
    assert.match(future, /󰆍 bash/);
    assert.doesNotMatch(future, /\d+s|NaN/);
    for (const since of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      const line = render([job("bash", since)], 120, locale).join("\n");
      assert.match(line, /󰆍 bash/);
      assert.doesNotMatch(line, /NaN|Infinity|undefined/);
    }
  }
});

test("locale still drives the surrounding live label while the elapsed format is shared", () => {
  const thinking = (): AgentView => ({ id: "a1", todoId: 1, profile: "coding", status: "running", activity: { kind: "thinking", since: Date.now() - 4000 } });
  assert.match(render([thinking()], 120, "en").join("\n"), /󰧑 Thinking/);
  assert.match(render([thinking()], 120, "zh-CN").join("\n"), /󰧑 思考中/);
});

test("long elapsed labels stay inside every finite width with the ten-column tool clip intact", () => {
  const since = Date.now() - 725_000;
  for (const locale of locales) {
    const wide = render([job("mcp__github__list_repository_files", since)], 120, locale).join("\n");
    assert.match(wide, /󰆍 list_repo… 12m5s/, `${locale} clip + elapsed`);
    for (const width of [0, 1, 8, 12, 20, 28, 34, 42, 60, 80, 120]) {
      for (const line of render([job("mcp__github__list_repository_files", since)], width, locale)) {
        assert.ok(visibleWidth(line) <= width, `${locale} at width ${width}: ${line}`);
        assert.doesNotMatch(line, /NaN|Infinity|undefined/);
      }
    }
  }
});
}

// block-align.test.ts
{
/** Rows with mixed depths, references and live job owners, like the user's real panel. */
function scene(): WorkflowState {
  const tasks: Todo[] = Array.from({ length: 35 }, (_, index) => ({ id: index + 1, subject: `旧任务 ${index + 1}`, status: 'completed' as const, blockedBy: [] }));
  tasks.push(
    { id: 36, subject: '验证安装并给出试用入口', status: 'completed', blockedBy: [35] },
    { id: 37, subject: '核对 Pi 资源选择与共享协调机制', status: 'completed', blockedBy: [] },
    { id: 38, subject: '重构为 Pi config 可选扩展入口', status: 'completed', blockedBy: [37] },
    { id: 39, subject: '复验组合加载与真实 Pi config', status: 'completed', blockedBy: [38] },
    { id: 40, subject: '核对命令补全 API 并创建 fast Profile', status: 'completed', blockedBy: [] },
    { id: 41, subject: '实现命令补全', status: 'completed', blockedBy: [40] },
    { id: 42, subject: '复验补全与真实子 Agent 流程', status: 'completed', blockedBy: [43] },
    { id: 43, subject: 'Todo 小组件优先显示当前与最近任务', status: 'completed', blockedBy: [40] },
  );
  return { ...emptyState(), tasks, nextId: 44 };
}
const jobs = [
  { id: 'a1', todoId: 41, profile: 'fast', status: 'completed' as const },
  { id: 'a2', todoId: 43, profile: 'fast', status: 'completed' as const },
];
const iconColumn = (plain: string): number => plain.search(/[✓○◐]/);
const titleColumn = (plain: string): number => {
  const icon = iconColumn(plain);
  if (icon < 0) return -1;
  const after = plain.slice(icon + 1);
  return icon + 1 + (after.length - after.replace(/^ +/, '').length);
};

test('three blocks: tree+id+refs stay glued, icon and title share one unified column', () => {
  const lines = renderTasks(scene(), 120, { maxRows: 8, jobs });
  const body = lines.slice(1, -1);
  assert.ok(body.length >= 8);
  const icons = body.map((line) => iconColumn(line.replace(/\x1b\[[0-9;]*m/g, '')));
  const titles = body.map((line) => titleColumn(line.replace(/\x1b\[[0-9;]*m/g, '')));
  // Block 2: every icon (and its merged title, one space later) starts at the same column.
  for (const value of icons) assert.equal(value, icons[0]);
  for (const value of titles) assert.equal(value, icons[0]! + 1 + 1);
  // Block 1: no padding inside the tree — a row's prefix+ref ends exactly where its lead begins.
  for (const line of body) {
    const plain = line.replace(/\x1b\[[0-9;]*m/g, '');
    assert.match(plain, /^[│ ]*[├└]─ #[0-9]+(<-#[0-9,]+)? /);
  }
});

test('block 3 stays right-aligned and every row fits the width', () => {
  for (const width of [80, 100, 120, 140]) {
    const lines = renderTasks(scene(), width, { maxRows: 8, jobs });
    for (const line of lines) assert.ok(visibleWidth(line) <= width, `${width}: ${line}`);
    for (const line of lines.slice(1, -1)) {
      const plain = line.replace(/\x1b\[[0-9;]*m/g, '').replace(/\s+$/, '');
      // Suffix ends the row: the last character is the closing bracket of the status tag.
      assert.ok(plain.endsWith(']'), plain);
      assert.ok(plain.lastIndexOf('[') > 0);
      assert.equal(visibleWidth(line), width, 'metadata must end at the terminal right edge');
    }
  }
});

test('narrow width drops block alignment before harming the tree or block 1 text', () => {
  const lines = renderTasks(scene(), 42, { maxRows: 8, jobs });
  for (const line of lines) assert.ok(visibleWidth(line) <= 42, line);
  // Block 1 is still glued: prefix+id+refs contiguous, then the icon.
  for (const line of lines.slice(1, -1)) {
    const plain = line.replace(/\x1b\[[0-9;]*m/g, '');
    assert.match(plain, /^[│ ]*[├└]─ #[0-9]+(<-#[0-9,]+)? [✓○◐]/);
  }
});

test('flat style keeps the same three-block alignment semantics', () => {
  const lines = renderTasks({ ...scene(), treeStyle: 'flat' }, 120, { maxRows: 8, jobs });
  const body = lines.slice(1, -1);
  const icons = body.map((line) => iconColumn(line.replace(/\x1b\[[0-9;]*m/g, '')));
  for (const value of icons) assert.equal(value, icons[0]);
});
}

// loading-optimization.test.ts
{
async function host(features: readonly (Feature | 'ui')[], branch: any[] = [], tui = false) {
  const root = await mkdtemp(join(tmpdir(), 'dag-lifecycle-'));
  const events = new Map<string, Function[]>(), tools = new Map<string, any>();
  let reads = 0, widgets = 0, dataReads = 0, leaf = 1, active: string[] = [];
  let latestWidget: any;
  const entries = branch;
  for (const entry of entries) if (entry.customType === STATE_TYPE) {
    const data = entry.data; Object.defineProperty(entry, 'data', { get() { dataReads++; return data; } });
  }
  const pi: any = { on(name: string, fn: Function) { events.set(name, [...events.get(name) ?? [], fn]); }, registerTool(tool: any) { tools.set(tool.name, tool); }, registerCommand() {}, registerMessageRenderer() {}, registerFlag() {}, getFlag() {}, appendEntry(customType: string, data: unknown) { entries.push({ type: 'custom', customType, data }); leaf++; }, getActiveTools: () => [...active], setActiveTools(names: string[]) { active = names; }, sendMessage() {}, sendUserMessage() {} };
  const ctx: any = { mode: tui ? 'tui' : 'rpc', hasUI: true, cwd: root, isIdle: () => false, modelRegistry: { find: () => undefined }, sessionManager: { getSessionId: () => 'ui-render-session', getBranch() { reads++; return [...entries]; }, getLeafId: () => String(leaf), getSessionFile: () => undefined }, ui: { theme: undefined, notify() {}, setWidget(_id: string, content: unknown) { widgets++; latestWidget = content; } } };
  const workflow = createWorkflow(pi);
  for (const feature of features) await workflow.attach(feature, pi);
  const fire = async (name: string, event: any = {}) => { for (const fn of events.get(name) ?? []) await fn(event, ctx); };
  const call = (name: string, params: object) => tools.get(name).execute('test', params, undefined, undefined, ctx);
  return { ctx, fire, call, widget: () => latestWidget, reads: () => reads, dataReads: () => dataReads, widgets: () => widgets, close: async () => { await fire('session_shutdown'); await rm(root, { recursive: true, force: true }); } };
}

test('all loaded modules share one branch read while Todo and legacy Plan each read their own domain once, with one preset load in either order', async () => {
  const original = PresetStore.prototype.load;
  const previous = process.env.PI_CODING_AGENT_DIR;
  let loads = 0;
  PresetStore.prototype.load = async function () { loads++; return original.call(this); };
  try {
    process.env.PI_CODING_AGENT_DIR = join(tmpdir(), 'fixture-nonexistent-agent-directory');
    for (const features of [FEATURE_NAMES, [...FEATURE_NAMES].reverse()]) {
      loads = 0;
      const state = { ...emptyState(), plan: true, nextId: 2, tasks: [{ id: 1, subject: 'retained task', status: 'pending', blockedBy: [] }] };
      const h = await host(features, [{ type: 'custom', customType: STATE_TYPE, data: state }]);
      try {
        await h.fire('session_start');
        assert.equal(h.reads(), 2, 'modules share the branch read, and Team reads its pointer once'); assert.equal(h.dataReads(), 2, 'Todo and Plan each read the legacy record once'); assert.equal(loads, 1);
        const blocked = await h.call('todo', { action: 'update', id: 1, status: 'completed' });
        assert.equal(blocked.isError, true, 'the legacy Plan bit still restores independently when Plan loads later');
        await h.fire('session_tree');
        // Same rule as session_start: the event's shared read plus Team's own pointer read.
        assert.equal(h.reads(), 4, 'the tree event shares one branch read, and Team reads its pointer once'); assert.equal(h.dataReads(), 4); assert.equal(loads, 2);
      } finally { await h.close(); }
    }
  } finally {
    PresetStore.prototype.load = original;
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous;
  }
});

test('Goal-only and UI-only never read Todo/preset state or fail on disabled corrupt Todo history', async () => {
  const original = PresetStore.prototype.load; let loads = 0;
  PresetStore.prototype.load = async function () { loads++; return original.call(this); };
  try {
    const h = await host(['goal', 'ui'], [{ type: 'custom', customType: STATE_TYPE, data: { version: 99 } }]);
    try { await h.fire('session_start'); assert.equal(loads, 0); assert.equal(h.dataReads(), 0); assert.equal((await h.call('goal', { action: 'create', title: 'independent' })).isError, undefined); }
    finally { await h.close(); }
    const ui = await host(['ui']);
    try { await ui.fire('session_start'); assert.equal(ui.reads(), 0, 'the inert UI entry restores nothing, not even shared retry settings'); assert.equal(loads, 0); }
    finally { await ui.close(); }
  } finally { PresetStore.prototype.load = original; }
});

for (const tui of [false, true]) {
  test(`unchanged Goal run metadata does not re-register its widget; task/title changes still repaint (${tui ? 'tui' : 'rpc'})`, async () => {
    const h = await host(['todos', 'goal', 'ui'], [], tui);
    try {
      await h.fire('session_start');
      await h.call('goal', { action: 'create', title: 'original' });
      await h.fire('input', { source: 'rpc', text: 'enable' });
      await h.call('goal', { action: 'enable', id: 1 });
      const mark = h.widgets();
      for (let i = 0; i < 10; i++) await h.call('goal', { action: 'update', progress: `evidence ${i}`, nextStep: `step ${i}` });
      assert.equal(h.widgets(), mark);
      await h.fire('input', { source: 'rpc', text: 'rename' });
      await h.call('goal', { action: 'update', title: 'changed title' });
      assert.ok(h.widgets() > mark);
      const after = h.widgets();
      await h.call('todo', { action: 'create', subject: 'visible task' });
      assert.ok(h.widgets() > after);
      if (tui) {
        const component = h.widget()();
        const initial = component.render(80);
        let tint = 31;
        h.ctx.ui.theme = { fg: (_color: string, text: string) => `\x1b[${tint}m${text}\x1b[39m` };
        component.invalidate();
        const recolored = component.render(80);
        assert.notDeepEqual(initial, recolored);
        assert.match(recolored.join('\n'), /\x1b\[31m/);
        tint = 32; component.invalidate();
        assert.match(component.render(80).join('\n'), /\x1b\[32m/);
        assert.notDeepEqual(component.render(40), recolored, 'resize does not return old-width cached lines');
      }
    } finally { await h.close(); }
  });
}

test('the widget adapts to height-only resize without a new registration or task change', async () => {
  const state = { ...emptyState(), nextId: 31, tasks: Array.from({ length: 30 }, (_, index) => ({ id: index + 1, subject: `task ${index + 1}`, status: 'pending', blockedBy: [] })) };
  const h = await host(['todos', 'ui'], [{ type: 'custom', customType: STATE_TYPE, data: state }], true);
  try {
    await h.fire('session_start');
    const terminal = { rows: 36 };
    const component = h.widget()({ terminal });
    const mark = h.widgets();
    const tall = component.render(80);
    terminal.rows = 9;
    const short = component.render(80);
    assert.ok(short.length <= widgetHeightBudget(9));
    assert.ok(tall.length > short.length);
    terminal.rows = 36;
    assert.deepEqual(component.render(80), tall);
    assert.equal(h.widgets(), mark);
  } finally { await h.close(); }
});
}

// recent-preview.test.ts
{
/**
 * 40 completed history tasks (#1–#40) plus four current tasks with old (now hidden)
 * predecessors, a visible chain and a fan-in, so previews must stay honest about hidden parents.
 */
function scene(): WorkflowState {
  const tasks: Todo[] = Array.from({ length: 40 }, (_, index) => ({
    id: index + 1,
    subject: `旧任务 ${index + 1}`,
    status: "completed" as const,
    blockedBy: [],
  }));
  tasks.push(
    { id: 41, subject: "当前任务 41", status: "pending", blockedBy: [10] },
    { id: 42, subject: "当前任务 42", status: "in_progress", blockedBy: [11] },
    { id: 43, subject: "当前任务 43", status: "pending", blockedBy: [41] },
    { id: 44, subject: "当前任务 44", status: "pending", blockedBy: [42, 43] },
  );
  return { ...emptyState(), tasks, nextId: 45 };
}

const shownIds = (lines: string[]): number[] => lines.flatMap((line) => {
  const match = /[├└]─ #([0-9]+)/.exec(line);
  return match ? [Number(match[1])] : [];
});

test("bounded preview keeps the recent window in canonical creation order", () => {
  const output = renderTasks(scene(), 120).join("\n");
  const ids = shownIds(output.split("\n"));
  assert.equal(ids.length, 8);
  // Selection picks the recent window; rendering restores the canonical order, newest at the bottom.
  assert.deepEqual(ids, [37, 38, 39, 40, 41, 42, 43, 44]);
  for (const current of [41, 42, 43, 44]) assert.ok(ids.includes(current), `missing #${current}`);
  assert.deepEqual(ids.filter((id) => id <= 40), [37, 38, 39, 40]);
  for (const old of [1, 2, 3, 4, 5, 36]) assert.doesNotMatch(output, new RegExp(`#${old}(?![0-9])`));
  assert.match(output, /40\/44/);
  assert.match(output, /隐藏 36 项/);
  assert.ok(output.indexOf("#37") < output.indexOf("#41"));
  assert.ok(output.indexOf("#41") < output.indexOf("#44"));
});

test("hidden and closed parents keep their predecessor reference instead of inventing ancestry", () => {
  const output = renderTasks(scene(), 120).join("\n");
  // #10 and #11 are visible in the full list but cropped from this preview; the child must still name them.
  assert.match(output, /#41<-#10(?![0-9])/);
  assert.match(output, /#42<-#11(?![0-9])/);
  // #41's branch is closed by the time #43 is drawn, so #43 starts a root and still names #41.
  assert.match(output, /#43<-#41(?![,0-9])/);
  assert.match(output, /#44<-#42(?![,0-9])/);
  assert.doesNotMatch(output, /#10<|#11</);
});

test("flat preview selects the same recent window and keeps every predecessor", () => {
  const lines = renderTasks({ ...scene(), treeStyle: "flat" }, 120);
  const output = lines.join("\n");
  assert.deepEqual(shownIds(lines), [37, 38, 39, 40, 41, 42, 43, 44]);
  assert.match(output, /#41<-#10(?![0-9])/);
  assert.match(output, /#42<-#11(?![0-9])/);
  assert.match(output, /#43<-#41(?![,0-9])/);
  assert.match(output, /#44<-#42,#43(?![,0-9])/);
});

test("overflowing unfinished work selects the newest window and keeps cropped dependencies", () => {
  const tasks: Todo[] = Array.from({ length: 12 }, (_, index) => ({ id: index + 1, subject: `待执行 ${index + 1}`, status: 'pending', blockedBy: index ? [index] : [] }));
  const state = { ...emptyState(), tasks, nextId: 13 };
  for (const treeStyle of ['paths', 'flat'] as const) {
    const lines = renderTasks({ ...state, treeStyle }, 120, { maxRows: 3 });
    assert.deepEqual(shownIds(lines), [10, 11, 12]);
    assert.match(lines.join('\n'), /#10<-#9/);
    assert.match(lines.join('\n'), /隐藏 9 项/);
  }
  assert.deepEqual(shownIds(renderTasks({ ...state, treeStyle: 'flat' }, 120, { maxRows: Infinity })), tasks.map((task) => task.id));
});

test("maxRows 0 hides every task but still reports the exact hidden total", () => {
  const lines = renderTasks(scene(), 120, { maxRows: 0 });
  assert.deepEqual(shownIds(lines), []);
  const output = lines.join("\n");
  assert.doesNotMatch(output, /旧任务|当前任务/);
  assert.match(output, /40\/44/);
  assert.match(output, /隐藏 44 项/);
});

test("Infinity still renders the complete history in canonical order without a preview marker", () => {
  const lines = renderTasks(scene(), 120, { maxRows: Infinity });
  const ids = shownIds(lines);
  assert.deepEqual(ids, Array.from({ length: 44 }, (_, index) => index + 1));
  const output = lines.join("\n");
  assert.doesNotMatch(output, /隐藏/);
  // An earlier parent whose branch is closed remains a reference, keeping chronology truthful.
  assert.match(output, /#41<-#10/);
});

test("every preview row stays within narrow and wide widths", () => {
  const state = scene();
  for (const width of [20, 40, 80, 120]) {
    for (const style of ["paths", "flat"] as const) {
      for (const line of renderTasks({ ...state, treeStyle: style }, width)) {
        assert.ok(visibleWidth(line) <= width, `${width}/${style}: ${line}`);
      }
    }
  }
});

/** Completed 40..43 plus current 44..47, with a forward reference (#44 names the future #47) and a merge (#47 waits on #45 and #46). */
function progressing(): WorkflowState {
  const history: Todo[] = Array.from({ length: 39 }, (_, index) => ({ id: index + 1, subject: `历史 ${index + 1}`, status: "completed" as const, blockedBy: [] }));
  return {
    ...emptyState(),
    nextId: 48,
    tasks: [
      ...history,
      { id: 40, subject: "任务 40", status: "completed", blockedBy: [] },
      { id: 41, subject: "任务 41", status: "completed", blockedBy: [] },
      { id: 42, subject: "任务 42", status: "completed", blockedBy: [41] },
      { id: 43, subject: "任务 43", status: "completed", blockedBy: [42] },
      { id: 44, subject: "任务 44", status: "pending", blockedBy: [47] },
      { id: 45, subject: "任务 45", status: "pending", blockedBy: [43] },
      { id: 46, subject: "任务 46", status: "pending", blockedBy: [43] },
      { id: 47, subject: "任务 47", status: "pending", blockedBy: [45, 46] },
    ],
  };
}

const expected = [40, 41, 42, 43, 44, 45, 46, 47];

test("a bounded preview never lifts newer work above older rows at 80 or 120 columns", () => {
  const state = progressing();
  for (const width of [80, 120]) {
    const lines = renderTasks(state, width);
    assert.deepEqual(shownIds(lines), expected, `width ${width}`);
    for (const line of lines) assert.ok(visibleWidth(line) <= width, `${width}: ${line}`);
  }
  const output = renderTasks(state, 120).join("\n");
  // The forward reference stays a reference; the merge draws one parent and names the other.
  assert.match(output, /#44<-#47(?![,0-9])/);
  assert.match(output, /#47<-#45(?![,0-9])/);
});

test("every creation refresh and status change keeps body ids in canonical ascending order", () => {
  const ordered: Todo[] = [
    { id: 40, subject: "任务 40", status: "completed", blockedBy: [] },
    { id: 41, subject: "任务 41", status: "completed", blockedBy: [] },
    { id: 42, subject: "任务 42", status: "completed", blockedBy: [41] },
    { id: 43, subject: "任务 43", status: "completed", blockedBy: [42] },
    { id: 44, subject: "任务 44", status: "pending", blockedBy: [47] },
    { id: 45, subject: "任务 45", status: "pending", blockedBy: [43] },
    { id: 46, subject: "任务 46", status: "pending", blockedBy: [43] },
    { id: 47, subject: "任务 47", status: "pending", blockedBy: [45, 46] },
  ];
  let tasks: Todo[] = [];
  for (const task of ordered) {
    tasks = [...tasks, task];
    for (const width of [80, 120]) {
      const lines = renderTasks({ ...emptyState(), tasks, nextId: 48 }, width, { maxRows: Infinity });
      assert.deepEqual(shownIds(lines), tasks.map((item) => item.id), `#${task.id}@${width}`);
    }
  }
  // A completion changes status, not the visible creation order.
  const completed = tasks.map((task) => task.id === 44 ? { ...task, status: "completed" as const } : task);
  assert.deepEqual(shownIds(renderTasks({ ...emptyState(), tasks: completed, nextId: 48 }, 80, { maxRows: Infinity })), expected);
  assert.deepEqual(shownIds(renderTasks({ ...emptyState(), tasks: completed, nextId: 48 }, 120)), expected);
});
}

// render-cache.test.ts
{
const state = () => ({ ...emptyState(), nextId: 3, tasks: [{ id: 1, subject: 'visible one', status: 'in_progress' as const, blockedBy: [] }, { id: 2, subject: 'visible two', status: 'pending' as const, blockedBy: [1] }] });

test('snapshot variants use bounded LRU and never retain another snapshot value', () => {
  const cache = snapshotCache<number>(2); let made = 0;
  const tasks = {}, other = {};
  const value = (key: string) => cache(tasks, key, () => ++made);
  assert.equal(value('a'), 1); assert.equal(value('b'), 2); assert.equal(value('a'), 1);
  assert.equal(value('c'), 3); assert.equal(value('a'), 1); assert.equal(value('b'), 4);
  assert.equal(cache(other, 'a', () => ++made), 5);
  const lru = new Lru<string>(1); lru.set('a', 'first'); lru.set('b', 'second'); assert.equal(lru.get('a'), undefined);
  const bounded = snapshotCache<number>(2, 2); const snapshots = [{}, {}, {}]; let builds = 0;
  for (const snapshot of snapshots) bounded(snapshot, 'width', () => ++builds);
  assert.equal(bounded(snapshots[0]!, 'width', () => ++builds), 4, 'old retained session snapshots cannot keep all frame variants resident');
});

test('cached rows apply current colors even when the Theme object changes in place', () => {
  const tasks = state(); let prefix = 31;
  const theme = { fg: (_color: string, text: string) => `\x1b[${prefix}m${text}\x1b[39m` } as unknown as Theme;
  const first = renderTasks(tasks, 80, { theme, maxRows: Infinity });
  prefix = 32;
  const changed = renderTasks(tasks, 80, { theme, maxRows: Infinity });
  assert.match(first.join('\n'), /\x1b\[31m/);
  assert.match(changed.join('\n'), /\x1b\[32m/);
  assert.doesNotMatch(changed.join('\n'), /\x1b\[31m/);
  assert.ok(changed.every((line) => visibleWidth(line) <= 80));
});

test('cached live rows use a fresh tool start time and continue across second boundaries', () => {
  const tasks = state(); const original = Date.now; let now = 1000000;
  Date.now = () => now;
  const job: AgentView = { id: 'a1', todoId: 1, profile: 'fixture', status: 'running', activity: { kind: 'tool', tool: 'bash', since: now - 100000 } };
  try {
    assert.match(renderTasks(tasks, 80, { jobs: [job] }).join('\n'), /bash 1m40s/);
    now += 1000;
    assert.match(renderTasks(tasks, 80, { jobs: [job] }).join('\n'), /bash 1m41s/);
    const restarted = { ...job, activity: { ...job.activity!, since: now - 2000 } };
    assert.match(renderTasks(tasks, 80, { jobs: [restarted] }).join('\n'), /bash 2s/);
    const output = { ...job, activity: { kind: 'output' as const } };
    assert.doesNotMatch(renderTasks(tasks, 80, { jobs: [output] }).join('\n'), /bash/);
  } finally { Date.now = original; }
});

test('cached geometry invalidates for title, owner, language, width, status and filter changes', () => {
  const tasks = state(); const english = createTranslator('en');
  renderTasks(tasks, 80, { maxRows: Infinity });
  const changed = { ...tasks, tasks: tasks.tasks.map((task) => task.id === 1 ? { ...task, subject: 'replacement', owner: 'new owner', status: 'failed' as const } : task) };
  const lines = renderTasks(changed, 120, { maxRows: Infinity, msg: english, filter: 'failed' });
  assert.match(lines.join('\n'), /replacement/); assert.match(lines.join('\n'), /new owner/); assert.match(lines.join('\n'), /Failed/);
  assert.doesNotMatch(lines.join('\n'), /visible one|visible two/);
  const jobs: AgentView[] = [{ id: 'a9', profile: 'fixture', status: 'failed', label: 'standalone' }];
  const dag = renderDag(changed, 120, undefined, undefined, jobs, { filter: 'failed', msg: english });
  assert.match(dag.join('\n'), /Standalone/); assert.match(dag.join('\n'), /a9/);
  assert.ok(dag.every((line) => visibleWidth(line) <= 120));
});
}

// Inherited model names belong to presentation, not the saved Profile identity.
{
const state = { ...emptyState(), nextId: 2, tasks: [{ id: 1, subject: 'Model display', status: 'in_progress' as const, blockedBy: [] }] };
const model = { provider: 'catalog-provider', id: 'actual-model' };

test('inherit and empty profiles show the actual model id while named and legacy profiles keep their names', () => {
  for (const locale of ['en', 'zh-CN'] as const) for (const [profile, selected, expected] of [
    ['inherit', model, 'actual-model'], ['', model, 'actual-model'], ['reader', model, 'reader'], ['inherit', undefined, 'inherit'], ['', undefined, ''],
  ] as const) {
    const msg = createTranslator(locale);
    const job: AgentView = { id: 'a1', todoId: 1, profile, status: 'waiting', ...(selected ? { model: selected } : {}) };
    const owner = expected ? `a1 · ${expected}` : 'a1';
    const { todoId: _todoId, ...standalone } = job;
    assert.equal(jobSummary(job, msg)[0], `Job ${owner} · Task #1`);
    const scenes = [
      ...(['paths', 'flat'] as const).map((treeStyle) => renderTasks({ ...state, treeStyle }, 120, { jobs: [job], msg })),
      renderDag(state, 120, undefined, undefined, [job], { msg }),
      renderWidget(state, 120, 12, { jobs: [job], msg }),
      renderWidget({ ...state, view: 'dag' }, 120, 12, { jobs: [job], msg }),
      renderTasks(emptyState(), 120, { jobs: [standalone], msg }),
    ];
    for (const lines of scenes) {
      assert.ok(lines.some((line) => line.includes(owner)), lines.join('\n'));
      assert.ok(lines.every((line) => visibleWidth(line) <= 120));
      assert.doesNotMatch(lines.join('\n'), /catalog-provider|undefined/);
      if (profile === 'inherit' && selected) assert.doesNotMatch(lines.join('\n'), /inherit/);
      if (profile === 'reader') assert.doesNotMatch(lines.join('\n'), /actual-model/);
      if (!expected) assert.ok(lines.filter((line) => line.includes('a1')).every((line) => !line.includes('a1 ·')));
    }
  }
});

test('narrow list, DAG and standalone rows drop the entire profile or model segment before losing the job state', () => {
  for (const profile of ['inherit', 'very-long-profile-name'.repeat(4)]) for (const width of [34, 40, 80]) {
    const job: AgentView = { id: 'a1', todoId: 1, profile, model: { ...model, id: 'very-long-model-name'.repeat(4) }, status: 'waiting' };
    const { todoId: _todoId, ...standalone } = job;
    for (const lines of [
      renderTasks(state, width, { jobs: [job] }),
      renderTasks({ ...state, treeStyle: 'flat' }, width, { jobs: [job] }),
      renderDag(state, width, undefined, undefined, [job]),
      renderTasks(emptyState(), width, { jobs: [standalone] }),
    ]) {
      const text = lines.join('\n');
      assert.match(text, /a1/);
      assert.match(text, /等待回复/);
      assert.doesNotMatch(text, /very-long/);
      assert.ok(text.includes('a1'));
      assert.ok(lines.every((line) => visibleWidth(line) <= width), text);
    }
  }
});

test('cached bound rows refresh on a model-only change without rebuilding the task or filter snapshot', () => {
  const job: AgentView = { id: 'a1', todoId: 1, profile: 'inherit', model, status: 'waiting' };
  const changed = { ...job, model: { ...model, id: 'new-model' } };
  const view = filteredView(state.tasks, 'full', [job]);
  assert.equal(filteredView(state.tasks, 'full', [changed]), view);
  for (const treeStyle of ['paths', 'flat'] as const) {
    const snapshot = { ...state, treeStyle };
    assert.match(renderTasks(snapshot, 120, { jobs: [job] }).join('\n'), /a1 · actual-model/);
    const lines = renderTasks(snapshot, 120, { jobs: [changed] }).join('\n');
    assert.match(lines, /a1 · new-model/);
    assert.doesNotMatch(lines, /actual-model/);
  }
});

for (const mode of ['rpc', 'tui']) test(`widget paint invalidates for model-only and profile-only changes (${mode})`, () => {
  let jobs: AgentView[] = [{ id: 'a1', todoId: 1, profile: 'inherit', model, status: 'waiting' }];
  let widget: any, paints = 0;
  const ctx: any = { mode, hasUI: true, ui: { theme: undefined, setWidget(_id: string, value: unknown) { widget = value; paints++; } } };
  const view = createWorkflowView({ state: () => state, todo: () => state, modules: () => ({ todos: true, plan: false, agents: true, goal: false, retry: false, team: false }), preferences: () => ({}), visible: (feature) => feature === 'todos' || feature === 'agents', jobs: () => jobs, goalTitle: () => undefined, retry: () => undefined, errors: () => ({ todoError: undefined, planError: undefined }), generation: () => 0 });
  const lines = () => (mode === 'tui' ? widget({ terminal: { rows: 36 } }).render(120) : widget).join('\n');
  view.paint(ctx);
  assert.match(lines(), /a1 · actual-model/);
  view.paint(ctx); assert.equal(paints, 1);
  jobs = [{ ...jobs[0]!, model: { ...model, id: 'new-model' } }];
  view.paint(ctx); assert.equal(paints, 2);
  assert.match(lines(), /a1 · new-model/);
  assert.doesNotMatch(lines(), /actual-model/);
  jobs = [{ ...jobs[0]!, profile: 'reader' }];
  view.paint(ctx); assert.equal(paints, 3);
  assert.match(lines(), /a1 · reader/);
  assert.doesNotMatch(lines(), /new-model/);
});
}

// report-delivery-view.test.ts
{
const state = { ...emptyState(), nextId: 2, tasks: [{ id: 1, subject: 'Implementation', status: 'in_progress' as const, blockedBy: [] }] };
const job: AgentView = { id: 'a1', todoId: 1, profile: 'worker', status: 'completed', reportDelivery: 'pending' };

test('a finished child is pending delivery or verification until the Todo itself is accepted, in both locales and views', () => {
  for (const locale of ['en', 'zh-CN'] as const) {
    const msg = createTranslator(locale);
    const pending = locale === 'en' ? 'Pending delivery' : '待交付';
    const verification = locale === 'en' ? undefined : '待核验';
    for (const width of [80, 120]) {
      const list = renderTasks(state, width, { jobs: [job], msg });
      assert.ok(list.join('\n').includes(pending));
      for (const line of list) assert.ok(visibleWidth(line) <= width);
      const accepted = renderTasks(state, width, { jobs: [{ ...job, reportDelivery: 'delivered' }], msg }).join('\n');
      assert.ok(!accepted.includes(pending));
      if (verification) assert.ok(accepted.includes(verification));
      else assert.ok(!/\p{Script=Han}/u.test(accepted), accepted);
    }
    const graph = renderDag(state, 120, undefined, undefined, [job], { msg });
    assert.ok(graph.join('\n').includes(pending));
    assert.equal(state.tasks[0]!.status, 'in_progress', 'report delivery never completes the Todo');
  }
});

test('pending delivery remains width-safe and does not override running, waiting or failure states', () => {
  for (const width of [20, 40, 80, 120]) {
    for (const line of renderTasks(state, width, { jobs: [job], msg: createTranslator('en') })) assert.ok(visibleWidth(line) <= width);
  }
  for (const status of ['running', 'waiting', 'failed'] as const) {
    const output = renderTasks(state, 120, { jobs: [{ ...job, status }], msg: createTranslator('en') }).join('\n');
    assert.ok(!output.includes('Pending delivery'));
  }
  const legacy = { ...job }; delete legacy.reportDelivery;
  assert.match(renderTasks(state, 120, { jobs: [legacy] }).join('\n'), /待核验/, 'a legacy bound record waits for verification instead of claiming a fresh handoff');
});
}

// tree-view.test.ts
{
function sample(): WorkflowState {
  const dependencies = [[], [1], [1], [2, 3], [2], [4, 5], []];
  return { ...emptyState(), nextId: 8, tasks: dependencies.map((blockedBy, index) => ({ id: index + 1, subject: `节点${index + 1}`, status: index === 0 ? "completed" : "pending", blockedBy })) };
}
const ids = (lines: string[]) => lines.flatMap((line) => { const match = /[├└]─ #([0-9]+)/.exec(line); return match ? [Number(match[1])] : []; });

test("default main paths follow creation order and only label the additional incoming edges", () => {
  const lines = renderTasks(sample(), 120, { maxRows: Infinity });
  // Chronological spanning forest: rows read strictly #1..#7, subtrees contiguous, no DFS reordering.
  assert.deepEqual(ids(lines), [1, 2, 3, 4, 5, 6, 7]);
  assert.ok(lines[0]!.startsWith("● 󰉹 Todos (1/7)"));
  assert.ok(lines.some((line) => line.startsWith("│  ├─ #2")));
  assert.ok(lines.some((line) => line.startsWith("│     └─ #4<-#2")));
  assert.ok(lines.some((line) => line.startsWith("│  └─ #6<-#4")));
  assert.ok(lines.at(-1)!.startsWith("└─ #7"));
  assert.doesNotMatch(lines.join("\n"), /#2<-#1|#4<-#2,#3|#6<-#4,#5/);
});

test("flat tree retains original ordering and all predecessors", () => {
  const lines = renderTasks({ ...sample(), treeStyle: "flat" }, 120, { maxRows: Infinity });
  assert.deepEqual(ids(lines), [1, 2, 3, 4, 5, 6, 7]);
  assert.match(lines.join("\n"), /├─ #4<-#2,#3/);
  assert.match(lines.join("\n"), /├─ #6<-#4,#5/);
  assert.ok(lines.slice(1).every((line) => /^[├└]─ /.test(line)));
});

test("parent choice is deterministic: deepest open predecessor, independent of blockedBy order", () => {
  // #4 depends on #2 and #3; #3 is the deepest still-open predecessor, so it is drawn and #2 stays a reference.
  const current = sample();
  current.tasks[3]!.blockedBy = [3, 2];
  const output = renderTasks(current, 120, { maxRows: Infinity }).join("\n");
  assert.match(output, /│     └─ #4<-#2(?![,0-9])/);
  assert.doesNotMatch(output, /#4<-#2,#3/);
  // A later task whose predecessors already closed starts a new root instead of inventing ancestry.
  current.tasks = [...current.tasks, { id: 8, subject: "更深父路径", status: "pending", blockedBy: [1, 6] }];
  current.nextId = 9;
  const deeper = renderTasks(current, 120, { maxRows: Infinity }).join("\n");
  assert.match(deeper, /└─ #8<-#1,#6(?![,0-9])/);
});

test("hidden parents never silently remove predecessor references or imply false ancestry", () => {
  const current = sample();
  const lines = renderTasks(current, 120, { maxRows: 2 });
  // Recent unfinished work wins the bounded preview: #6 and #7, with #6's cropped parents still named.
  assert.deepEqual(ids(lines), [6, 7]);
  assert.match(lines.join("\n"), /#6<-#4,#5/);
  assert.match(lines.join("\n"), /隐藏 5 项/);
  assert.match(lines[0]!, /1\/7/);
});

test("40 columns retain the main path but remove fixed reference and right-side alignment", () => {
  const lines = renderTasks(sample(), 40, { maxRows: Infinity });
  const first = lines.find((line) => line.startsWith("├─ #1"))!;
  assert.equal(first, "├─ #1 ✓ 节点1 [主会话] [已完成]");
  assert.ok(lines.some((line) => line.startsWith("│     └─ #4<-#2 ○")));
  for (const line of lines) assert.ok(visibleWidth(line) <= 40);
  const wide = renderTasks(sample(), 120, { maxRows: Infinity });
  // Block 2 (icon+title) starts at one unified column across all depths.
  const icons = wide.slice(1).map((line) => line.search(/[✓○◐]/));
  for (const column of icons) assert.equal(column, icons[0]);
});

test("only extremely narrow paths flatten; the shallow forest survives normal narrow width", () => {
  const current = sample();
  assert.ok(renderTasks(current, 20, { maxRows: Infinity }).some((line) => line.startsWith("│     └─ #4")));
  assert.deepEqual(renderTasks(current, 12, { maxRows: Infinity }), renderTasks({ ...current, treeStyle: "flat" }, 12, { maxRows: Infinity }));
  const long = { ...emptyState(), nextId: 4097, tasks: Array.from({ length: 4096 }, (_, index): Todo => ({ id: index + 1, subject: "深链", status: "pending", blockedBy: index ? [index] : [] })) };
  const lines = renderTasks(long, 80, { maxRows: Infinity });
  assert.equal(ids(lines).length, 4096);
  assert.ok(lines.every((line) => visibleWidth(line) <= 80));
});

test("root means unfinished work; the Todo block is never dimmed just because everything completed", () => {
  const unfinished = sample();
  assert.ok(renderTasks(unfinished, 120)[0]!.startsWith("●"));
  const completed = { ...unfinished, tasks: unfinished.tasks.map((task) => ({ ...task, status: "completed" as const })) };
  assert.ok(renderTasks(completed, 120)[0]!.startsWith("○"));
  assert.ok(renderTasks({ ...emptyState(), plan: true }, 120)[0]!.startsWith("○"));
  assert.deepEqual(renderTasks(emptyState(), 120), []);
});

test("header uses conditional Todo · Plan · Goal blocks without inventing a focus", () => {
  const current = sample();
  assert.doesNotMatch(renderTasks(current, 120)[0]!, /Plan|Goal/);
  assert.match(renderTasks({ ...current, plan: true }, 120)[0]!, /Todos .* · 󰏫 Plan \[只读\]/);
  assert.match(renderTasks(current, 120, { goalTitle: "解析器改造" })[0]!, /Todos .* · 󰓾 Goal: 解析器改造/);
  assert.match(renderTasks({ ...current, plan: true }, 120, { goalTitle: "解析器改造" })[0]!, /Todos .* · .*Plan .* · .*Goal:/);
  assert.doesNotMatch(renderTasks(current, 120, { goalTitle: " \n " })[0]!, /Goal/);
  for (const width of [1, 3, 10, 20, 40, 80]) for (const line of renderTasks({ ...current, plan: true }, width, { goalTitle: "很长的当前目标 👩‍💻".repeat(20) })) assert.ok(visibleWidth(line) <= width);
});

test("old snapshots without the optional tree setting use paths; explicit flat preference restores", () => {
  const { treeStyle: _oldSetting, ...old } = sample();
  const legacy = restoreState([{ type: "custom", customType: STATE_TYPE, data: old }]);
  assert.deepEqual(renderTasks(legacy, 80), renderTasks(sample(), 80));
  const flat = restoreState([{ type: "custom", customType: STATE_TYPE, data: { ...old, treeStyle: "flat" } }]);
  assert.match(renderTasks(flat, 120).join("\n"), /#4<-#2,#3/);
});
}

// unbound-agents.test.ts
{
const task = (id: number, subject = "实现解析器"): Todo => ({ id, subject, status: "pending", blockedBy: [] });
const base = { ...emptyState(), tasks: [task(1)], nextId: 2 };
const free = (id: string, status: AgentView["status"] = "running", extra: Partial<AgentView> = {}): AgentView => ({ id, profile: "fast", status, label: "调研现有实现", ...extra });
const lines = (jobs: readonly AgentView[], width = 80, state = base, translate: Translator | undefined = undefined, maxRows = Infinity) => renderTasks(state, width, { jobs, maxRows, ...(translate ? { msg: translate } : {}) }).map(stripTerminalSequences).join("\n");

test("a job spawned without a Todo gets its own section below the list", () => {
  const rendered = lines([free("a1")]);
  assert.match(rendered, /● 󰀏 Standalone Agents · 1/);
  assert.match(rendered, /[├└]─ a1 · fast .*调研现有实现/);
  assert.match(rendered, /\[󰥔 运行中\]/);
});

test("the root mark follows the Todo rule: solid while unfinished work remains", () => {
  assert.match(lines([free("a1")]), /● 󰀏/);
  assert.match(lines([free("a1", "waiting")]), /● 󰀏/);
  assert.match(lines([free("a1", "completed", { reportDelivery: "pending" })]), /● 󰀏/);
  // Only settled jobs are left, so the block reads as closed.
  assert.match(lines([free("a1", "failed")]), /○ 󰀏/);
  assert.match(lines([free("a1", "cancelled"), free("a2", "interrupted")]), /○ 󰀏/);
});

test("the section stays away when no unbound job needs attention", () => {
  const bound: AgentView = { id: "a1", todoId: 1, profile: "fast", status: "running", label: "绑定任务" };
  assert.doesNotMatch(lines([]), /Standalone/);
  assert.doesNotMatch(lines([bound]), /Standalone/);
  // A report that already reached the main context no longer explains anything.
  assert.doesNotMatch(lines([free("a1", "completed", { reportDelivery: "delivered" })]), /Standalone/);
});

test("delivered reports stay out while pending handoff, failures and interruptions remain", () => {
  const rendered = lines([
    free("a1", "completed", { reportDelivery: "pending" }),
    free("a2", "failed"),
    free("a3", "interrupted"),
    free("a4", "cancelled"),
    free("a5", "completed", { reportDelivery: "delivered" }),
  ]);
  assert.match(rendered, /● 󰀏 Standalone Agents · 4/);
  assert.match(rendered, /\[󰥔 待交付\]/);
  assert.match(rendered, /\[󰅙 失败\]/);
  assert.match(rendered, /\[󰙦 已中断\]/);
  assert.match(rendered, /\[󰓛 已取消\]/);
  assert.doesNotMatch(rendered, /a5/);
});

test('an empty completed report says so instead of waiting for delivery', () => {
  const rendered = lines([
    free('a1', 'completed', { reportDelivery: 'pending' }),
    free('a2', 'completed', { reportDelivery: 'delivered', reportEmpty: true }),
    free('a3', 'completed', { reportDelivery: 'delivered' }),
  ]);
  assert.match(rendered, /待交付/, 'a real undelivered report keeps its row');
  assert.doesNotMatch(rendered, /a2/, 'the empty one is not a default row');
  assert.doesNotMatch(rendered, /a3/);
  // The detail view names the state instead of implying someone read it.
  const detail = jobSummary({ id: 'a2', profile: 'p', status: 'completed', reportDelivery: 'delivered', reportEmpty: true }).join('\n');
  assert.match(detail, /已结束·无报告/);
  const pendingDetail = jobSummary({ id: 'a1', profile: 'p', status: 'completed', reportDelivery: 'pending' }).join('\n');
  assert.match(pendingDetail, /报告交付：待交付/);
});

test("live work is listed before closed jobs and the section is bounded", () => {
  const jobs = [free("a1", "failed"), free("a2"), free("a3"), free("a4"), free("a5"), free("a6", "completed", { reportDelivery: "pending" })];
  // The widget preview bounds the section at four rows; the complete view carries every job.
  const rendered = lines(jobs, 80, base, undefined, 8);
  const positions = ["a2", "a3", "a4", "a5"].map((id) => rendered.indexOf(`─ ${id} `));
  assert.ok(positions.every((index) => index >= 0), `live work fills the section first: ${rendered}`);
  assert.deepEqual(positions, [...positions].sort((left, right) => left - right));
  assert.match(rendered, /● 󰀏 Standalone Agents · 6/);
  assert.match(rendered, /└─ … 隐藏 2 项/);
  // The clipped jobs are the closed one and the waiting handoff, never live work.
  assert.doesNotMatch(rendered, /a1 · fast/);
  assert.doesNotMatch(rendered, /a6 · fast/);
  const complete = lines(jobs);
  assert.doesNotMatch(complete, /隐藏/);
  assert.match(complete, /a1 · fast/);
  assert.match(complete, /a6 · fast/);
});

test("plain icon style leaves no empty gap where the group glyph would be", () => {
  const job = free("a1");
  const withStyle = (iconStyle: 'plain' | 'nerd-font') => renderTasks(base, 80, { jobs: [job], maxRows: Infinity, iconStyle }).map(stripTerminalSequences).join("\n");
  const plain = withStyle('plain');
  assert.match(plain, /● Standalone Agents · 1/);
  assert.doesNotMatch(plain, /● {2,}Standalone/, "no double space where the glyph was");
  // The group slot is empty in plain mode; other widget glyphs are outside ticket 17's scope.
  assert.equal(plain.includes(String.fromCodePoint(0xf000f)), false, "the group glyph is not emitted in plain mode");
  const nerd = withStyle('nerd-font');
  assert.match(nerd, /● 󰀏 Standalone Agents · 1/);
  // The next width where the title still fits keeps the same clean join.
  const tighter = renderTasks(base, 60, { jobs: [job], maxRows: Infinity, iconStyle: 'plain' }).map(stripTerminalSequences).join("\n");
  assert.match(tighter, /● Standalone Agents · 1/);
  assert.doesNotMatch(tighter, /● {2,}Standalone/);
});

test("an unbound job alone still renders the panel when the task list is empty", () => {
  const rendered = lines([free("a1")], 80, { ...emptyState() });
  assert.match(rendered, /● 󰀏 Standalone Agents · 1/);
  assert.doesNotMatch(rendered, /Todos/);
});

test("narrow terminals keep the job and its state and drop the excerpt first", () => {
  const jobs = [free("a1", "running", { activity: { kind: "tool", tool: "list_repository_files", since: Date.now() - 3000 } })];
  const narrow = lines(jobs, 34);
  assert.match(narrow, /a1/);
  assert.match(narrow, /󰆍/);
  assert.doesNotMatch(narrow, /调研现有实现/);
  assert.ok(renderTasks(base, 34, { jobs, maxRows: Infinity }).every((line) => visibleWidth(stripTerminalSequences(line)) <= 34));
});

test("a very narrow terminal keeps the count with the compact title", () => {
  const rendered = lines([free("a1")], 24);
  assert.match(rendered, /● 󰀏 Standalone · 1/);
  assert.doesNotMatch(rendered, /Standalone Agents/);
});

test("the section follows the English locale", () => {
  const rendered = lines([free("a1")], 80, base, createTranslator("en"));
  assert.match(rendered, /● 󰀏 Standalone Agents · 1/);
  assert.match(rendered, /\[󰥔 Running\]/);
});
}

// view-filters.test.ts
{
const Theme = Theme_view_filters;
const task = (id: number, status: Todo['status'], blockedBy: number[] = []): Todo => ({ id, subject: `任务${id}`, status, blockedBy });
const state = (tasks: Todo[], filter?: TodoFilter): WorkflowState => ({ ...emptyState(), tasks, nextId: tasks.length + 1, ...(filter ? { filter } : {}) });
const job = (id: string, extra: Partial<AgentView> = {}): AgentView => ({ id, profile: 'fast', status: 'running', label: `工作 ${id}`, ...extra });
const bound = (id: string, todoId: number, extra: Partial<AgentView> = {}): AgentView => ({ ...job(id), todoId, ...extra });
const plain = (lines: string[]): string => lines.map(stripTerminalSequences).join('\n');
const shownIds = (lines: string[]): number[] => lines.flatMap((line) => {
  const match = /[├└]─ #([0-9]+)/.exec(stripTerminalSequences(line));
  return match ? [Number(match[1])] : [];
});
const standaloneCount = (text: string, count: number): boolean => new RegExp(`Standalone(?: Agents)? · ${count}\\b`).test(text);

// ---------------------------------------------------------------------------
// Filter selection and the effective status of a Todo row
// ---------------------------------------------------------------------------

test('the full view is the default, and an explicit filter resolves options over state', () => {
  const tasks = [task(1, 'completed'), task(2, 'pending'), task(3, 'in_progress'), task(4, 'failed'), task(5, 'cancelled')];
  const current = state(tasks);
  assert.deepEqual(renderTasks(current, 120), renderTasks({ ...current, filter: 'full' }, 120));
  assert.deepEqual(shownIds(renderTasks(current, 120, { maxRows: Infinity })), [1, 2, 3, 4, 5]);

  const pending = state(tasks, 'pending');
  assert.deepEqual(shownIds(renderTasks(pending, 120, { maxRows: Infinity })), [2, 3]);
  // A per-call filter overrides the persisted view without touching the state.
  assert.deepEqual(shownIds(renderTasks(pending, 120, { maxRows: Infinity, filter: 'completed' })), [1]);
  assert.deepEqual(shownIds(renderTasks(pending, 120, { maxRows: Infinity, filter: 'failed' })), [4]);
  assert.deepEqual(shownIds(renderTasks(pending, 120, { maxRows: Infinity, filter: 'cancelled' })), [5]);
  assert.deepEqual(shownIds(renderTasks(current, 120, { maxRows: Infinity, filter: 'completed' })), [1]);
  // The active scope is visible in the header, so an empty filtered panel explains itself.
  assert.match(plain(renderTasks(pending, 120)), /筛选：未完成/);
  assert.match(plain(renderTasks(current, 120, { filter: 'cancelled' })), /筛选：已取消/);
  assert.doesNotMatch(plain(renderTasks(current, 120)), /筛选/);
});

test('canonical acceptance wins, then only the newest non-stale child job may report a failure', () => {
  // A verified completed Todo is never dragged back by a later failed job.
  const completed = state([task(1, 'completed')]);
  assert.deepEqual(shownIds(renderTasks(completed, 120, { maxRows: Infinity, filter: 'completed', jobs: [bound('a1', 1, { status: 'failed' })] })), [1]);
  assert.deepEqual(shownIds(renderTasks(completed, 120, { maxRows: Infinity, filter: 'failed', jobs: [bound('a1', 1, { status: 'failed' })] })), []);

  // An unfinished Todo takes the failure or cancellation of its newest job.
  const inProgress = state([task(1, 'in_progress')]);
  const failed = plain(renderTasks(inProgress, 120, { maxRows: Infinity, filter: 'failed', jobs: [bound('a1', 1, { status: 'failed' })] }));
  assert.match(failed, /#1/);
  assert.match(failed, /✗/);
  assert.match(failed, /\[󰅙 失败\]/);
  assert.match(plain(renderTasks(inProgress, 120, { maxRows: Infinity, filter: 'cancelled', jobs: [bound('a1', 1, { status: 'cancelled' })] })), /\[󰓛 已取消\]/);
  assert.match(plain(renderTasks(inProgress, 120, { maxRows: Infinity, filter: 'cancelled', jobs: [bound('a1', 1, { status: 'interrupted' })] })), /\[󰙦 已中断\]/);

  // The newest job decides: a fresh attempt outranks an older failure, and the order is runtime order.
  const tasks = [task(7, 'in_progress')];
  assert.deepEqual(shownIds(renderTasks(state(tasks), 120, { maxRows: Infinity, filter: 'pending', jobs: [bound('a1', 7, { status: 'failed' }), bound('a2', 7, { status: 'running' })] })), [7]);
  assert.deepEqual(shownIds(renderTasks(state(tasks), 120, { maxRows: Infinity, filter: 'failed', jobs: [bound('a1', 7, { status: 'failed' }), bound('a2', 7, { status: 'running' })] })), []);
  assert.deepEqual(shownIds(renderTasks(state(tasks), 120, { maxRows: Infinity, filter: 'failed', jobs: [bound('a2', 7, { status: 'running' }), bound('a1', 7, { status: 'failed' })] })), [7]);
  // A stale report belongs to a previous attempt and cannot relabel the current one.
  assert.deepEqual(shownIds(renderTasks(state(tasks), 120, { maxRows: Infinity, filter: 'failed', jobs: [bound('a1', 7, { status: 'running' }), bound('a2', 7, { status: 'failed', taskReportStale: true })] })), []);
  assert.deepEqual(shownIds(renderTasks(state(tasks), 120, { maxRows: Infinity, filter: 'pending', jobs: [bound('a2', 7, { status: 'failed', taskReportStale: true })] })), [7]);
});

test('a child that finished execution does not complete the Todo; it waits for acceptance', () => {
  const pending = state([task(1, 'pending'), task(2, 'in_progress')]);
  const jobs = [bound('a1', 1, { status: 'completed', reportDelivery: 'pending' }), bound('a2', 2, { status: 'completed' })];
  const text = plain(renderTasks(pending, 120, { maxRows: Infinity, jobs }));
  assert.match(text, /\[󰥔 待交付\]/);
  assert.match(text, /\[󰥔 待核验\]/);
  // Both stay pending work; neither reaches the completed filter.
  assert.deepEqual(shownIds(renderTasks(pending, 120, { maxRows: Infinity, filter: 'pending', jobs })), [1, 2]);
  assert.deepEqual(shownIds(renderTasks(pending, 120, { maxRows: Infinity, filter: 'completed', jobs })), []);
});

test('native failed and cancelled Todos keep Nerd Font icons and semantic theme colors', () => {
  const builtin = JSON.parse(readFileSync(new URL('../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/dark.json', import.meta.url), 'utf8'));
  const tokens = Object.keys(builtin.colors);
  const foreground = Object.fromEntries(tokens.map((token) => [token, '#cccccc']));
  const background = Object.fromEntries(tokens.map((token) => [token, '#222222']));
  const theme = new Theme(foreground as never, background as never, 'truecolor');
  const current = state([task(1, 'failed'), task(2, 'cancelled')]);
  const text = renderTasks(current, 120, { theme, maxRows: Infinity }).join('\n');
  assert.ok(text.includes(theme.fg('error', '✗')), 'failed rows use the error color');
  assert.ok(text.includes(theme.fg('dim', '⊘')), 'cancelled rows use the dim color');
  assert.ok(text.includes(theme.fg('muted', '[失败]')));
  assert.ok(text.includes(theme.fg('muted', '[已取消]')));
  // A job failure on an unfinished Todo reads the same way, from the agent palette.
  const fromJob = renderTasks(state([task(3, 'in_progress')]), 120, { theme, maxRows: Infinity, jobs: [bound('a1', 3, { status: 'failed' })] }).join('\n');
  assert.ok(fromJob.includes(theme.fg('error', '✗')));
  assert.ok(fromJob.includes(theme.fg('error', '[󰅙 失败]')));
});

// ---------------------------------------------------------------------------
// Standalone section membership per filter
// ---------------------------------------------------------------------------

test('the Standalone section follows the filter while full keeps the delivered-report auto-hide', () => {
  const jobs = [
    bound('b1', 1, { status: 'running' }),
    job('a1', { status: 'running' }),
    job('a2', { status: 'completed', reportDelivery: 'pending' }),
    job('a3', { status: 'completed', reportDelivery: 'delivered' }),
    job('a4', { status: 'failed' }),
    job('a5', { status: 'cancelled' }),
    job('a6', { status: 'interrupted' }),
  ];
  const current = state([task(1, 'in_progress')]);
  const full = plain(renderTasks(current, 120, { maxRows: Infinity, jobs }));
  assert.ok(standaloneCount(full, 5), full);
  assert.match(full, /a1 · fast/);
  assert.doesNotMatch(full, /a3 · fast/);

  const pending = plain(renderTasks(current, 120, { maxRows: Infinity, filter: 'pending', jobs }));
  assert.ok(standaloneCount(pending, 2), pending);
  assert.match(pending, /a1 · fast/);
  assert.match(pending, /a2 · fast/);
  assert.doesNotMatch(pending, /a3|a4|a5|a6/);

  // The completed scope shows delivered history, not the delivered auto-hide of the full view.
  const completed = plain(renderTasks(current, 120, { maxRows: Infinity, filter: 'completed', jobs }));
  assert.ok(standaloneCount(completed, 2), completed);
  assert.match(completed, /a2 · fast/);
  assert.match(completed, /a3 · fast/);
  assert.doesNotMatch(completed, /a1|a4|a5|a6/);

  const failed = plain(renderTasks(current, 120, { maxRows: Infinity, filter: 'failed', jobs }));
  assert.ok(standaloneCount(failed, 1), failed);
  assert.match(failed, /a4 · fast/);
  assert.doesNotMatch(failed, /a1|a2|a3|a5|a6/);

  // Cancellation covers both the cancelled and the interrupted terminal states.
  const cancelled = plain(renderTasks(current, 120, { maxRows: Infinity, filter: 'cancelled', jobs }));
  assert.ok(standaloneCount(cancelled, 2), cancelled);
  assert.match(cancelled, /a5 · fast/);
  assert.match(cancelled, /a6 · fast/);
  assert.doesNotMatch(cancelled, /a1|a2|a3|a4/);
});

// ---------------------------------------------------------------------------
// DAG paths and hidden prerequisites
// ---------------------------------------------------------------------------

test('every DAG path appends the Standalone section exactly once', () => {
  const jobs = [job('a1')];
  const tasks = [task(1, 'pending'), task(2, 'pending', [1])];
  // Normal solid graph.
  const graph = plain(renderDag(state(tasks), 120, undefined, undefined, jobs));
  assert.doesNotMatch(graph, /降级/);
  assert.equal((graph.match(/Standalone/g) ?? []).length, 1);
  // Degraded list (width below the graph minimum).
  const fallback = plain(renderDag(state(tasks), 20, undefined, undefined, jobs));
  assert.match(fallback, /降级/);
  assert.match(fallback, /#2<-#1/);
  assert.equal((fallback.match(/Standalone/g) ?? []).length, 1);
  // No Todo at all: the section is the whole panel.
  const lone = plain(renderDag(state([]), 120, undefined, undefined, jobs));
  assert.match(lone, /Standalone/);
  assert.doesNotMatch(lone, /Todos/);
  assert.equal((lone.match(/Standalone/g) ?? []).length, 1);
  // A bound job reports on its row and never doubles into the section.
  const boundGraph = plain(renderDag(state(tasks), 120, undefined, undefined, [bound('b1', 1, { status: 'running' })]));
  assert.doesNotMatch(boundGraph, /Standalone/);
});

test('a filtered DAG never reports a missing prerequisite and keeps the external reference', () => {
  const tasks = [task(1, 'completed'), task(2, 'pending', [1]), task(3, 'pending', [2])];
  const current = state(tasks);
  const before = structuredClone(tasks);
  const graph = plain(renderDag(current, 120, undefined, undefined, [], { filter: 'pending' }));
  assert.doesNotMatch(graph, /降级|missing|未知|缺失/);
  // #1 is hidden by the filter, so the box names it instead of drawing a false edge.
  assert.match(graph, /#2<-#1/);
  const fallback = plain(renderDag(current, 20, undefined, undefined, [], { filter: 'pending' }));
  assert.match(fallback, /降级/);
  assert.match(fallback, /#2<-#1/);
  assert.doesNotMatch(shownIds(fallback.split('\n')).join(','), /(^|,)1(,|$)/);
  // The full view still draws a real edge and never falls back to predecessor text.
  const full = plain(renderDag(current, 120));
  assert.doesNotMatch(full, /<-/);
  // Filtering is display-only: the canonical tasks and their blockedBy lists never change.
  assert.deepEqual(tasks, before);
  assert.deepEqual(current.tasks, before);
});

test('long external references stay inside graph boxes and remain complete below the full graph', () => {
  const parents = Array.from({ length: 10 }, (_, index) => ({ id: index + 1, subject: `parent ${index}`, status: 'completed' as const, blockedBy: [] }));
  const state = { ...emptyState(), nextId: 12, tasks: [...parents, { id: 11, subject: 'failed child', status: 'failed' as const, blockedBy: parents.map((task) => task.id) }] };
  const lines = renderDag(state, 80, undefined, undefined, [], { filter: 'failed' });
  assert.ok(lines.every((line) => visibleWidth(line) <= 80));
  const reference = '#11<-' + parents.map((task) => `#${task.id}`).join(',');
  assert.ok(lines.join('\n').includes(reference));
  const titleLine = lines.find((line) => line.includes('✗'))!;
  assert.ok(titleLine.trimEnd().endsWith('│'), 'truncated prefix cannot overwrite the graph border');
});

test('taskFilterStatus gives cleanup the same verdict the view shows', () => {
  const one = (status: AgentView['status'], extra: Partial<AgentView> = {}): AgentView => ({ id: 'a1', profile: 'fast', status, ...extra });
  // Unfinished work never counts as closed, whatever its child is doing.
  assert.equal(taskFilterStatus(task(1, 'pending')), 'pending');
  assert.equal(taskFilterStatus(task(1, 'in_progress'), one('starting')), 'pending');
  assert.equal(taskFilterStatus(task(1, 'in_progress'), one('running')), 'pending');
  assert.equal(taskFilterStatus(task(1, 'in_progress'), one('waiting')), 'pending');
  assert.equal(taskFilterStatus(task(1, 'in_progress'), one('completed', { reportDelivery: 'pending' })), 'pending');
  assert.equal(taskFilterStatus(task(1, 'in_progress'), one('completed')), 'pending');
  // Only a failure or cancellation from the newest non-stale job closes it as failed/cancelled.
  assert.equal(taskFilterStatus(task(1, 'in_progress'), one('failed')), 'failed');
  assert.equal(taskFilterStatus(task(1, 'in_progress'), one('cancelled')), 'cancelled');
  assert.equal(taskFilterStatus(task(1, 'in_progress'), one('interrupted')), 'cancelled');
  // Verified native states outrank any job.
  assert.equal(taskFilterStatus(task(1, 'completed'), one('failed')), 'completed');
  assert.equal(taskFilterStatus(task(1, 'failed'), one('completed')), 'failed');
  assert.equal(taskFilterStatus(task(1, 'cancelled'), one('running')), 'cancelled');
  // Cleanup passes the latest bound job, and a stale report is not one.
  const jobs = [
    bound('a1', 1, { status: 'failed' }),
    bound('a2', 1, { status: 'running' }),
    bound('a3', 2, { status: 'failed', taskReportStale: true }),
  ];
  const latest = latestBoundJobs(jobs);
  assert.equal(latest.get(1)!.id, 'a2');
  assert.equal(latest.get(2), undefined);
  assert.equal(taskFilterStatus(task(1, 'in_progress'), latest.get(1)), 'pending');
});

test('the filter projection is cached per immutable snapshot', () => {
  const tasks = [task(1, 'completed'), task(2, 'pending', [1]), task(3, 'in_progress')];
  const jobs = [bound('a1', 3, { status: 'failed' })];
  const first = filteredView(tasks, 'full', jobs);
  const second = filteredView(tasks, 'full', [{ ...jobs[0]! }]);
  assert.equal(first, second, 'an unchanged snapshot and job statuses reuse the projection');
  assert.equal(first.dagTasks, second.dagTasks);
  assert.equal(dagStructure(first.dagTasks), dagStructure(second.dagTasks), 'the DAG structure is reused too');
  assert.equal(first.effective.get(3), 'failed');
  // A changed job status produces a new projection instead of a stale one.
  const changed = filteredView(tasks, 'full', [bound('a1', 3, { status: 'cancelled' })]);
  assert.notEqual(first, changed);
  assert.equal(changed.effective.get(3), 'cancelled');
});

// ---------------------------------------------------------------------------
// Preview budgets
// ---------------------------------------------------------------------------

test('preview budgets hold: 8 Todo rows, 4 standalone rows and an 11-line graph', () => {
  const tasks = Array.from({ length: 12 }, (_, index) => task(index + 1, 'pending'));
  const jobs = Array.from({ length: 6 }, (_, index) => job(`a${index + 1}`, { status: 'running' }));
  const current = state(tasks);
  const preview = plain(renderTasks(current, 120, { jobs }));
  assert.equal(shownIds(preview.split('\n')).length, 8);
  assert.match(preview, /隐藏 4 项/);
  assert.ok(standaloneCount(preview, 6), preview);
  assert.match(preview, /隐藏 2 项/);
  // Complete views carry every standalone row they show.
  const list = plain(renderTasks(current, 120, { jobs, maxRows: Infinity }));
  assert.doesNotMatch(list, /隐藏/);
  for (const id of ['a1', 'a6']) assert.match(list, new RegExp(`${id} · fast`));

  const chain = Array.from({ length: 20 }, (_, index) => task(index + 1, 'pending', index ? [index] : []));
  const dagPreview = plain(renderDag(state(chain), 120, undefined, undefined, jobs, { maxLines: 11 })).split('\n');
  const standaloneAt = dagPreview.findIndex((line) => line.includes('Standalone'));
  assert.ok(standaloneAt > 0 && standaloneAt <= 12, `graph keeps its own budget: ${standaloneAt}`);
  assert.match(dagPreview.slice(0, standaloneAt).join('\n'), /图预览/);
  assert.match(dagPreview.slice(standaloneAt).join('\n'), /隐藏 2 项/);
  const dagFull = plain(renderDag(state(chain), 120, undefined, undefined, jobs)).split('\n');
  const fullAt = dagFull.findIndex((line) => line.includes('Standalone'));
  assert.doesNotMatch(dagFull.slice(fullAt).join('\n'), /隐藏/);
  for (const id of ['a1', 'a6']) assert.match(dagFull.slice(fullAt).join('\n'), new RegExp(`${id} · fast`));
});

test('filtered rows stay inside narrow and wide terminals in both views', () => {
  const tasks = [task(1, 'failed'), task(2, 'cancelled'), task(3, 'pending', [1]), task(4, 'in_progress', [2])];
  const jobs = [bound('a1', 4, { status: 'running', activity: { kind: 'tool', tool: 'read', since: Date.now() - 3000 } }), job('a9', { status: 'failed' })];
  for (const filter of ['full', 'pending', 'completed', 'failed', 'cancelled'] as const) {
    for (const width of [20, 40, 80, 120]) {
      for (const line of renderTasks(state(tasks), width, { jobs, maxRows: Infinity, filter })) assert.ok(visibleWidth(line) <= width, `${filter}/${width}: ${line}`);
      for (const line of renderDag(state(tasks), width, undefined, undefined, jobs, { filter })) assert.ok(visibleWidth(line) <= width, `${filter}/${width}: ${line}`);
    }
  }
});
}

// view-theme.test.ts
{
const Theme = Theme_view_filters;
test("semantic theme colors do not change terminal width or corrupt user content", () => {
  const builtin = JSON.parse(readFileSync(new URL("../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/dark.json", import.meta.url), "utf8"));
  const tokens = Object.keys(builtin.colors);
  const palette: Record<string, string> = { accent: "#bf40ff", dim: "#555555", success: "#00cc55", warning: "#ffcc00" };
  const foreground = Object.fromEntries(tokens.map((token) => [token, palette[token] ?? "#cccccc"])) as Record<ThemeColor, string>;
  const background = Object.fromEntries(tokens.map((token) => [token, "#222222"])) as Record<ThemeBg, string>;
  const theme = new Theme(foreground, background, "truecolor");
  const state = { ...emptyState(), plan: true, tasks: [
    { id: 1, subject: "已完成", status: "completed" as const, blockedBy: [] },
    { id: 2, subject: "中文标题 👩‍💻", status: "in_progress" as const, blockedBy: [1], owner: "主会话" },
  ], nextId: 3 };
  for (const width of [20, 40, 80, 120]) {
    const plain = renderTasks(state, width);
    const styled = renderTasks(state, width, { theme });
    assert.deepEqual(styled.map(stripTerminalSequences), plain);
    for (const line of styled) assert.ok(visibleWidth(line) <= width);
    const dagPlain = renderDag(state, width);
    const dagStyled = renderDag(state, width, theme);
    assert.deepEqual(dagStyled.map(stripTerminalSequences), dagPlain);
    for (const line of dagStyled) assert.ok(visibleWidth(line) <= width);
  }
  const styled = renderTasks(state, 120, { theme });
  assert.ok(styled[0]!.startsWith(theme.getFgAnsi("accent")));
  assert.ok(styled[1]!.startsWith(theme.getFgAnsi("dim")));
  assert.ok(styled[1]!.includes(theme.fg("accent", "已完成")));
  assert.ok(styled[1]!.includes(theme.fg("success", "✓")));
  // The header gives each block its own color: Todo accent, Plan error, Goal success.
  assert.ok(styled[0]!.includes(theme.fg("error", "󰏫 Plan [只读]")), "Plan block uses the error color");
  const withGoal = renderTasks(state, 120, { theme, goalTitle: "#1 目标标题" });
  const goalBlock = theme.fg("success", "󰓾 Goal: #1 目标标题");
  assert.ok(withGoal[0]!.includes(goalBlock), "Goal block uses the success color");
  assert.ok(withGoal[0]!.startsWith(theme.getFgAnsi("accent")), "Todo keeps the accent color");
  const withFree = renderTasks({ ...emptyState(), tasks: [] }, 120, { theme, jobs: [{ id: "a1", profile: "fast", status: "running", label: "独立任务" }] });
  assert.ok(withFree[0]!.includes(theme.fg("accent", "● 󰀏 Standalone Agents · 1")), "the Subagents block shares the Todo accent color");
  assert.ok(withFree[1]!.includes(theme.fg("muted", "a1 · fast")), "the job reference uses the same muted color as a Todo owner bracket");
  assert.ok(withFree[1]!.includes(theme.fg("accent", "独立任务")), "the excerpt keeps the Todo title accent");
  const dag = renderDag(state, 120, theme, "#1 目标标题");
  assert.ok(dag[0]!.includes(theme.fg("error", "󰏫 Plan [只读]")) && dag[0]!.includes(goalBlock), "the DAG header shares the same colors");
});
}

// view.test.ts
{
const task = (id: number, status: Todo["status"] = "pending", blockedBy: number[] = []): Todo => ({ id, subject: `中文任务 ${id} 👩‍💻`, status, blockedBy });
const state = (tasks: Todo[], plan = false): WorkflowState => ({ ...emptyState(), tasks, nextId: tasks.length + 1, plan });

test("empty widget disappears but empty Plan still displays readonly mode", () => {
  assert.deepEqual(renderTasks(emptyState(), 80), []);
  assert.match(renderTasks({ ...emptyState(), plan: true }, 80).join("\n"), /Plan.*只读/);
});

test("list dependencies are only at the left identifier", () => {
  const rows = renderTasks({ ...state([task(1), task(2), task(3), task(4, "pending", [2, 3])]), treeStyle: "flat" }, 120);
  const row = rows.find((line) => line.includes("#4"))!;
  assert.ok(row.startsWith("└─ #4<-#2,#3 ")); 
  assert.equal(row.match(/#2/g)?.length, 1);
  assert.equal(row.match(/#3/g)?.length, 1);
});

test("all rows fit narrow/normal/wide terminals with Chinese emoji and Nerd Font", () => {
  for (const width of [1, 3, 6, 20, 40, 80, 120]) {
    const tasks = [task(1, "completed"), { ...task(2, "in_progress", [1]), subject: "研究非常长的中文标题 👨‍👩‍👧‍👦 ".repeat(5), owner: "Agent·很长的Profile名称", activeForm: "正在检查边界情况" }];
    for (const line of [...renderTasks(state(tasks, true), width), ...renderDag(state(tasks, true), width)]) {
      assert.ok(visibleWidth(line) <= width, `${width}: ${line}`);
      assert.doesNotMatch(line, /[\r\n]/);
    }
  }
});

test("terminal escape and bidi/newline injection from user fields is removed", () => {
  const dirty = { ...task(1, "in_progress"), subject: "标题\x1b[31m红色\x1b[0m\n下一行\u202e", owner: "\x1b]0;hacked\x07Agent", activeForm: "\r正在做\u009b31m事" };
  const output = renderTasks(state([dirty]), 120).join("\n");
  assert.doesNotMatch(output, /\x1b|\x07|\u202e|\u009b|hacked/);
  assert.match(output, /标题/);
  assert.equal(stripTerminalSequences(output), output);
});

test("row budget favors unfinished work, keeps order and reports hidden tasks", () => {
  const tasks = [task(1, "completed"), task(2, "completed"), task(3), task(4, "in_progress")];
  const output = renderTasks(state(tasks), 80, { maxRows: 2 }).join("\n");
  assert.doesNotMatch(output, /#1|#2/);
  assert.ok(output.indexOf("#3") < output.indexOf("#4"));
  assert.match(output, /隐藏 2 项/);
  assert.match(output, /2\/4/);
  assert.doesNotMatch(renderTasks(state(tasks), 80, { maxRows: Infinity }).join("\n"), /隐藏/);
});

test("deleted tasks are neither shown nor counted, and activeForm does not replace the title", () => {
  const output = renderTasks(state([task(1, "deleted"), { ...task(2, "in_progress"), activeForm: "检查中" }]), 120).join("\n");
  assert.doesNotMatch(output, /#1/);
  assert.match(output, /0\/1/);
  assert.match(output, /中文任务 2/);
  assert.match(output, /检查中/);
});

test("DAG solid lines retain fan-in and explicitly degrade at narrow width", () => {
  const current = state([task(1), task(2, "pending", [1]), task(3, "pending", [1]), task(4, "pending", [2, 3])]);
  const output = renderDag(current, 100).join("\n");
  assert.match(output, /┌.*─.*┐/);
  assert.match(output, /┬/);
  assert.doesNotMatch(output, /<-|前驱/);
  const fallback = renderDag(current, 40).join("\n");
  assert.match(fallback, /降级/);
  assert.match(fallback, /#4<-#2,#3/);
});
}

// widget-budget.test.ts
{
const task = (id: number, status: Todo['status'] = 'pending'): Todo => ({ id, subject: `task-${id} 中文宽度 \x1b[2J`, status, blockedBy: id > 1 ? [id - 1] : [] });
const state = (count: number): WorkflowState => ({ ...emptyState(), tasks: Array.from({ length: count }, (_, index) => task(index + 1)), nextId: count + 1 });
const jobs: AgentView[] = Array.from({ length: 6 }, (_, index) => ({ id: `a${index + 1}`, profile: 'fixture', status: 'running', label: 'independent work' }));

test('the whole widget fits the terminal budget in both views, languages and tree styles', () => {
  for (const view of ['list', 'dag'] as const) for (const treeStyle of ['paths', 'flat'] as const) for (const locale of ['en', 'zh-CN'] as const) {
    const workflow = { ...state(24), view, treeStyle, plan: true };
    for (const width of [1, 20, 40, 80, 120]) for (const rows of [3, 9, 18, 24, 36, 60]) {
      const budget = widgetHeightBudget(rows);
      const lines = renderWidget(workflow, width, budget, { jobs, goalTitle: 'active goal', msg: createTranslator(locale) });
      assert.ok(lines.length <= budget, `${view}/${treeStyle}/${locale}/${width}x${rows}: ${lines.length} > ${budget}`);
      assert.ok(lines.every((line) => visibleWidth(line) <= width));
      assert.ok(lines.every((line) => !line.includes('\x1b[2J')));
    }
  }
  assert.equal(widgetHeightBudget(90), 12);
  assert.equal(widgetHeightBudget(9), 3);
  assert.equal(widgetHeightBudget(0), 1);
  assert.equal(widgetHeightBudget(NaN), 12);
  assert.deepEqual(renderWidget(state(2), 0, 12), []);
  assert.deepEqual(renderWidget(state(2), 80, 0), []);
});

test('old active work and unaccepted or failed bound reports win over newer pending tasks', () => {
  const workflow = state(100);
  for (const status of ['in_progress', 'failed', 'cancelled'] as const) {
    const changed = { ...workflow, tasks: workflow.tasks.map((todo) => todo.id === 1 ? { ...todo, status } : todo) };
    for (const budget of [2, 3]) assert.match(renderWidget(changed, 100, budget).join('\n'), /task-1 /);
  }
  for (const status of ['completed', 'failed', 'cancelled', 'waiting', 'running'] as const) {
    const bound: AgentView = { id: 'bound', todoId: 1, profile: 'fixture', status, reportDelivery: 'delivered' };
    assert.match(renderWidget(workflow, 100, 3, { jobs: [bound] }).join('\n'), /task-1 /);
  }
  const stale: AgentView = { id: 'old', todoId: 1, profile: 'fixture', status: 'completed', taskReportStale: true };
  assert.doesNotMatch(renderWidget(workflow, 100, 3, { jobs: [stale] }).join('\n'), /task-1 /);
});

test('waiting standalone jobs remain visible in a tiny widget, and settled reports stay hidden', () => {
  const standalone: AgentView[] = [
    { id: 'closed', profile: 'fixture', status: 'failed' },
    { id: 'question', profile: 'fixture', status: 'waiting' },
    { id: 'delivered', profile: 'fixture', status: 'completed', reportDelivery: 'delivered' },
  ];
  const lines = renderWidget(state(100), 100, 3, { jobs: standalone });
  assert.ok(lines.length <= 3);
  assert.match(lines.join('\n'), /question/);
  assert.doesNotMatch(lines.join('\n'), /delivered/);
  assert.doesNotMatch(renderWidget(emptyState(), 100, 12, { jobs: [standalone[2]!] }).join('\n'), /Standalone/);
});

test('DAG previews either fit fully or clearly degrade while preserving the complete detail view', () => {
  const small = { ...state(1), view: 'dag' as const };
  const fits = renderWidget(small, 100, 12);
  assert.ok(fits.some((line) => /[┌┐]/.test(line)), fits.join('\n'));
  assert.doesNotMatch(fits.join('\n'), /降级/);
  const large = { ...state(24), view: 'dag' as const };
  const cropped = renderWidget(large, 100, 12, { jobs });
  assert.match(cropped.join('\n'), /图已降级为列表/);
  assert.equal(large.view, 'dag');
  const english = renderWidget(large, 100, 12, { msg: createTranslator('en') }).join('\n');
  assert.match(english, /Insufficient terminal height/);
  const details = renderTasks(large, 120, { maxRows: Infinity, jobs }).join('\n');
  assert.match(details, /task-1 /); assert.match(details, /task-24 /); assert.match(details, /a6/);
  assert.ok(renderDag(large, 100).length > 12, 'scrollable DAG details are not subject to the widget budget');
});

test('a fitting DAG never hides attention rows that a smaller list budget could show', () => {
  const workflow = { ...state(1), view: 'dag' as const };
  for (const status of ['waiting', 'running', 'completed', 'failed'] as const) {
    const standalone: AgentView[] = [1, 2].map((id) => ({ id: `a${id}`, profile: 'fixture', status, reportDelivery: 'pending' }));
    for (const locale of ['en', 'zh-CN'] as const) for (const treeStyle of ['paths', 'flat'] as const) for (const width of [80, 100]) {
      for (const budget of [7, widgetHeightBudget(24), 9, 12]) {
        const lines = renderWidget({ ...workflow, treeStyle }, width, budget, { jobs: standalone, msg: createTranslator(locale) });
        assert.ok(lines.length <= budget);
        assert.ok(lines.every((line) => visibleWidth(line) <= width));
        assert.match(lines.join('\n'), /a1/, `${status}/${locale}/${width}/${budget}`);
        assert.match(lines.join('\n'), /a2/, `${status}/${locale}/${width}/${budget}`);
        assert.equal((lines.join('\n').match(/Standalone/g) ?? []).length, 1);
        if (budget >= 9) assert.ok(lines.some((line) => /[┌┐]/.test(line)), 'keep the graph when attention rows fit too');
      }
    }
  }
});

test('narrow filtered DAG fallbacks keep complete hidden prerequisites or an explicit warning', () => {
  for (const treeStyle of ['paths', 'flat'] as const) for (const locale of ['en', 'zh-CN'] as const) {
    const workflow: WorkflowState = { ...state(3), view: 'dag', filter: 'pending', treeStyle, tasks: [
      { ...task(1, 'completed'), blockedBy: [] },
      { ...task(2, 'completed'), blockedBy: [] },
      { ...task(3), blockedBy: [1, 2] },
    ] };
    const before = structuredClone(workflow);
    const msg = createTranslator(locale);
    const lines = renderWidget(workflow, 20, widgetHeightBudget(36), { msg });
    assert.ok(lines.length <= widgetHeightBudget(36));
    assert.ok(lines.every((line) => visibleWidth(line) <= 20));
    assert.match(lines.join('\n'), /#3<-#1,#2/);
    assert.doesNotMatch(lines.join('\n'), /[├└]─ #(?:1|2)\b/);
    for (const budget of [2, 3]) {
      const tiny = renderWidget(workflow, 20, budget, { msg });
      assert.ok(tiny.length <= budget);
      assert.ok(tiny.every((line) => visibleWidth(line) <= 20));
      assert.ok(/#3<-#1,#2|截断|shortened/.test(tiny.join('\n')), tiny.join('\n'));
      if (!tiny.join('\n').includes('#3<-#1,#2')) assert.doesNotMatch(tiny.join('\n'), /完整前驱|keep all predecessors/);
    }
    assert.match(renderDag(workflow, 20, undefined, undefined, [], { msg }).join('\n'), /#3<-#1,#2/);
    assert.deepEqual(workflow, before, 'fallbacks do not alter the complete detail state');
  }
});

test('long fallback references stay budgeted, themed and honest alongside live activity', (t) => {
  const now = 1700000000000;
  t.mock.method(Date, 'now', () => now);
  const parents = Array.from({ length: 14 }, (_, index) => ({ ...task(index + 1, 'completed'), blockedBy: [] }));
  const child = { ...task(15), blockedBy: parents.map((todo) => todo.id) };
  const reference = '#15<-' + child.blockedBy.map((id) => `#${id}`).join(',');
  const live: AgentView = { id: 'live', todoId: 15, profile: 'fixture', status: 'running', activity: { kind: 'tool', tool: 'mcp__fixture__very_long_tool_name', since: now - 105000 } };
  const question: AgentView = { id: 'question', profile: 'fixture', status: 'waiting' };
  let color = 31;
  const theme: any = { fg: (_name: string, value: string) => `\x1b[${color}m${value}\x1b[39m` };
  for (const locale of ['en', 'zh-CN'] as const) for (const treeStyle of ['paths', 'flat'] as const) for (const width of [20, 40, 100]) for (const budget of [2, 3, 6, 8, 12]) {
    const workflow: WorkflowState = { ...state(15), view: 'dag', filter: 'pending', treeStyle, tasks: [...parents, child] };
    const options = { jobs: [live, question], msg: createTranslator(locale), theme };
    color = 31;
    const first = renderWidget(workflow, width, budget, options);
    color = 32;
    const next = renderWidget(workflow, width, budget, options);
    assert.ok(next.length <= budget);
    assert.ok(next.every((line) => visibleWidth(line) <= width));
    assert.deepEqual(first.map(stripTerminalSequences), next.map(stripTerminalSequences));
    assert.match(next.join('\n'), /\x1b\[32m/);
    assert.doesNotMatch(next.join('\n'), /\x1b\[31m|\x1b\[2J/);
    const plain = next.map(stripTerminalSequences);
    if (plain.some((line) => /[├└]─ #15/.test(line))) assert.ok(plain.join('').includes(reference) || /截断|shortened/.test(plain.join('\n')), plain.join('\n'));
    if (width === 100 && budget >= 8) {
      assert.match(plain.join('\n'), /question/);
      assert.match(plain.join('\n'), /󰆍 very_long…/);
      assert.doesNotMatch(plain.join('\n'), /very_long_tool_name/);
    }
    assert.ok(renderDag(workflow, 20, undefined, undefined, [], { msg: options.msg }).map(stripTerminalSequences).join('').includes(reference), 'complete DAG detail keeps every prerequisite');
  }
});

test('hiding Todo rows does not hide a standalone handoff in a tiny widget', () => {
  for (const view of ['list', 'dag'] as const) for (const status of ['waiting', 'running', 'completed'] as const) {
    const workflow = { ...state(20), view, plan: true, tasks: state(20).tasks.map((todo) => todo.id === 1 ? { ...todo, status: 'failed' as const } : todo) };
    const standalone: AgentView = { id: 'handoff', profile: 'fixture', status, reportDelivery: 'pending' };
    for (const budget of [2, 3, 4, 6]) {
      const lines = renderWidget(workflow, 100, budget, { maxRows: 0, jobs: [standalone] });
      assert.ok(lines.length <= budget);
      assert.match(lines.join('\n'), /handoff/);
      assert.doesNotMatch(lines.join('\n'), /task-\d+/);
    }
  }
});

test('widget colors and filters use the current theme without changing the overall budget', () => {
  const workflow = { ...state(30), tasks: state(30).tasks.map((todo) => todo.id === 1 ? { ...todo, status: 'failed' as const } : todo) };
  let color = 31;
  const theme: any = { fg: (_name: string, value: string) => `\x1b[${color}m${value}\x1b[39m` };
  const first = renderWidget(workflow, 100, 6, { theme, filter: 'failed' });
  assert.match(first.join('\n'), /task-1 /); assert.doesNotMatch(first.join('\n'), /task-30 /);
  color = 32;
  const next = renderWidget(workflow, 100, 6, { theme, filter: 'failed' });
  assert.match(next.join('\n'), /\x1b\[32m/); assert.doesNotMatch(next.join('\n'), /\x1b\[31m/);
  assert.deepEqual(first.map(stripTerminalSequences), next.map(stripTerminalSequences));
});
}

// checkpoint-summary.test.ts
{
const task = (id: number, subject: string, status: Todo["status"] = "pending", blockedBy: number[] = []): Todo => ({ id, subject, status, blockedBy });
const state = (tasks: Todo[], extra: Partial<WorkflowState> = {}): WorkflowState => ({ ...emptyState(), tasks, nextId: Math.max(0, ...tasks.map((item) => item.id)) + 1, ...extra });
const job = (id: string, patch: Partial<CheckpointJob> = {}): CheckpointJob => ({ id, status: "running", ...patch });
const render = (workflow: WorkflowState, jobs: readonly CheckpointJob[] = [], options: CheckpointSummaryOptions = {}): string => {
  const text = checkpointSummary(workflow, jobs, options);
  assert.ok(text, "expected a checkpoint summary");
  return text;
};
const lines = (text: string, prefix: string): string[] => text.split("\n").filter((line) => line.startsWith(prefix));
const todoLines = (text: string): string[] => lines(text, "- #");
const jobLines = (text: string): string[] => text.split("\n").filter((line) => line.startsWith("- ") && !line.startsWith("- #"));
const graphemes = (text: string): string[] => [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text)].map((part) => part.segment);

test("ranks returned verification, in_progress, ready and blocked Todos stably", () => {
  const workflow = state([
    task(1, "blocked work", "pending", [2]),
    task(2, "ready work"),
    task(3, "running work", "in_progress"),
    task(4, "returned work", "in_progress"),
    task(5, "another ready"),
  ]);
  const jobs = [
    job("job-3", { todoId: 3, status: "running" }),
    job("job-4", { todoId: 4, status: "completed", reportDelivery: "pending" }),
  ];
  const text = render(workflow, jobs);
  assert.equal(text.split("\n")[0], "Workflow state checkpoint");
  assert.deepEqual(todoLines(text).map((line) => line.slice(0, 4)), ["- #4", "- #3", "- #2", "- #5", "- #1"]);
  assert.match(todoLines(text)[0]!, /\[in_progress, execution ended - inspect report\] returned work/);
  assert.match(todoLines(text)[2]!, /\[pending, ready\] ready work/);
  assert.match(todoLines(text)[4]!, /\[pending, blocked\] blocked work \(unfinished prerequisites: #2\)/);
});

test("lists at most twelve unfinished Todos and points at the list tools", () => {
  const workflow = state(Array.from({ length: 15 }, (_, index) => task(index + 1, `work ${index + 1}`)));
  const text = render(workflow);
  assert.equal(todoLines(text).length, 12);
  assert.match(text, /Unfinished Todos \(12 of 15\):/);
  assert.match(text, /Hidden: 3 more unfinished Todos; use "todo list" or "todo get" for details\./);
});

test("counts live Todos only and says No unfinished Todos when only history remains", () => {
  const text = render(state([task(1, "done", "completed"), task(2, "gone", "deleted"), task(3, "later", "completed")]));
  assert.match(text, /Todos: 2 completed \(2 total, 1 deleted\)/);
  assert.match(text, /No unfinished Todos\./);
  assert.doesNotMatch(text, /Unfinished Todos:/);
});

test("clips titles and labels to 32 unicode characters without breaking a grapheme", () => {
  const subject = "👨‍👩‍👧".repeat(40) + "TAIL";
  const text = render(state([task(1, subject, "in_progress")]));
  const line = todoLines(text)[0]!;
  const title = line.slice(line.indexOf("] ") + 2).split(" — ")[0]!;
  assert.equal(graphemes(title).length, 32);
  assert.ok(title.endsWith("…"));
  assert.ok(!text.includes("TAIL"));
});

test("clips Job labels to 32 unicode characters", () => {
  const text = render(state([task(1, "work", "in_progress")]), [job("job-1", { todoId: 1, status: "running", label: "x".repeat(50) })]);
  const line = jobLines(text)[0]!;
  const shown = line.slice(line.indexOf("] ") + 2, line.indexOf(" — "));
  assert.equal(graphemes(shown).length, 32);
  assert.ok(shown.endsWith("…"));
});

test("shows only the single latest Job bound to a Todo", () => {
  const workflow = state([task(1, "work", "in_progress")]);
  const jobs = [
    job("job-old", { todoId: 1, status: "failed" }),
    job("job-new", { todoId: 1, status: "completed", reportDelivery: "delivered" }),
  ];
  const line = todoLines(render(workflow, jobs))[0]!;
  assert.match(line, /latest job job-new: completed, report delivered/);
  assert.doesNotMatch(line, /job-old/);
});

test("a delivered completed report calls for verification and never implies task acceptance", () => {
  const text = render(state([task(1, "work", "in_progress")]), [job("job-1", { todoId: 1, status: "completed", reportDelivery: "delivered" })]);
  assert.match(text, /\[in_progress, report returned - verify\]/);
  assert.doesNotMatch(text, /No unfinished Todos/);
});

test("marks a stale completed report as historical output only", () => {
  const workflow = state([task(1, "work", "in_progress")]);
  const jobs = [job("job-stale", { todoId: 1, status: "completed", reportDelivery: "delivered", taskReportStale: true })];
  const line = todoLines(render(workflow, jobs))[0]!;
  assert.match(line, /\[in_progress\] work/);
  assert.doesNotMatch(line, /verify/);
  assert.match(line, /latest job job-stale: completed, report delivered \[historical output only\]/);
});

test("lists active Jobs bound to completed Todos and standalone Jobs", () => {
  const workflow = state([task(1, "done", "completed")]);
  const jobs = [
    job("job-bound", { todoId: 1, status: "running", label: "verify build" }),
    job("job-free", { status: "waiting", label: "research" }),
    job("job-done", { todoId: 1, status: "completed", reportDelivery: "delivered" }),
  ];
  const text = render(workflow, jobs);
  assert.match(text, /No unfinished Todos\./);
  assert.match(text, /Active Jobs:/);
  assert.match(text, /- job-bound \[running\] verify build — todo #1 \(completed\)/);
  assert.match(text, /- job-free \[waiting\] research — standalone/);
  assert.doesNotMatch(text, /job-done/);
});

test("lists at most eight active Jobs", () => {
  const jobs = Array.from({ length: 11 }, (_, index) => job(`job-${index + 1}`, { status: "running", label: `w${index + 1}` }));
  const text = render(state([task(1, "work", "in_progress")]), jobs);
  assert.equal(jobLines(text).length, 8);
  assert.match(text, /Active Jobs \(8 of 11\):/);
  assert.match(text, /Hidden: 3 more active Jobs; use subagent_inspect for details\./);
});

test("returns undefined for a brand-new empty session unless forceEmpty is set", () => {
  assert.equal(checkpointSummary(emptyState(), []), undefined);
  const text = render(emptyState(), [], { forceEmpty: true });
  assert.equal(text.split("\n")[0], "Workflow state checkpoint");
  assert.match(text, /No unfinished Todos\./);
  assert.match(text, /use subagent_inspect output:true only when a report is missing/);
});

test("reports Plan mode and still returns a summary for an otherwise empty session", () => {
  const text = render({ ...emptyState(), plan: true });
  assert.match(text, /Plan: on \(read-only; tasks cannot start or complete\)\./);
  assert.match(text, /No unfinished Todos\./);
});

test("protected state is reported as unavailable and never implies completion", () => {
  const workflow = state([task(1, "secret task", "completed")]);
  const text = render(workflow, [job("job-run", { todoId: 1, status: "running" })], { protectedState: true });
  assert.match(text, /state unavailable/);
  assert.doesNotMatch(text, /completed/);
  assert.doesNotMatch(text, /secret task/);
  assert.doesNotMatch(text, /job-run/);
  assert.doesNotMatch(text, /Todos:/);
});

test("identical data yields an identical string with no time or activity state", () => {
  const build = () => ({
    workflow: state([task(1, "a", "in_progress"), task(2, "b", "pending", [1])]),
    jobs: [job("job-a", { todoId: 1, status: "running", label: "work" })],
  });
  const first = build();
  const second = build();
  const one = checkpointSummary(first.workflow, first.jobs);
  const two = checkpointSummary(second.workflow, second.jobs);
  assert.equal(one, two);
  assert.doesNotMatch(one!, /\b\d+s\b/);
});

test("ignores live activity and other non-summary Job fields", () => {
  const workflow = state([task(1, "work", "in_progress")]);
  const base = job("job-1", { todoId: 1, status: "running", label: "label" });
  const noisy = { ...base, activity: { kind: "tool", tool: "bash", since: 123 } } as unknown as CheckpointJob;
  assert.equal(checkpointSummary(workflow, [base]), checkpointSummary(workflow, [noisy]));
});

test("never copies descriptions, output, profiles, models or tools", () => {
  const workflow = state([{ ...task(1, "public title", "in_progress"), description: "SECRET-DESCRIPTION" }]);
  const rich = {
    id: "job-1", todoId: 1, status: "running", label: "public label",
    output: "SECRET-OUTPUT", profile: "SECRET-PROFILE", model: "SECRET-MODEL", tools: ["SECRET-TOOL"],
  } as unknown as CheckpointJob;
  const text = render(workflow, [rich]);
  assert.match(text, /public title/);
  assert.match(text, /public label/);
  for (const secret of ["SECRET-DESCRIPTION", "SECRET-OUTPUT", "SECRET-PROFILE", "SECRET-MODEL", "SECRET-TOOL"]) {
    assert.doesNotMatch(text, new RegExp(secret));
  }
});

test("strips terminal controls and bidi marks from titles and labels", () => {
  const workflow = state([task(1, "bad\u001b[31m title\u202e", "in_progress")]);
  const text = render(workflow, [job("job-1", { todoId: 1, status: "running", label: "lab\u009b31mel\u200f" })]);
  for (const control of ["\u001b", "\u202e", "\u200f", "\u009b"]) assert.ok(!text.includes(control), `unexpected ${JSON.stringify(control)}`);
});
}


// task-acceptance.test.ts
{
// ---------------------------------------------------------------------------
// Pure projection: the Todo owns acceptance, the job only records execution
// ---------------------------------------------------------------------------

const task = (id: number, status: Todo['status'], subject = `任务${id}`): Todo => ({ id, subject, status, blockedBy: [] });
const state = (...tasks: Todo[]): WorkflowState => ({ ...emptyState(), tasks, nextId: tasks.length + 1 });
const job = (id: string, todoId: number | undefined, extra: Partial<AgentView> = {}): AgentView => ({ id, profile: 'worker', status: 'completed', ...(todoId === undefined ? {} : { todoId }), ...extra });
const plain = (lines: string[]): string => lines.map(stripTerminalSequences).join('\n');
const list = (current: WorkflowState, jobs: readonly AgentView[], width = 120): string => plain(renderTasks(current, width, { jobs, maxRows: Infinity }));
const graph = (current: WorkflowState, jobs: readonly AgentView[], width = 120): string => plain(renderDag(current, width, undefined, undefined, jobs, { maxLines: 20 }));

test('a completed Todo shows its own state regardless of the job that reported on it', () => {
  const current = state(task(1, 'completed'));
  const terminalJobs = [
    job('a1', 1),
    job('a1', 1, { reportDelivery: 'pending' }),
    job('a1', 1, { reportDelivery: 'delivered' }),
    job('a1', 1, { status: 'failed' }),
    job('a1', 1, { status: 'running', activity: { kind: 'tool', tool: 'read', since: Date.now() - 3000 } }),
  ];
  for (const candidate of terminalJobs) {
    const jobs = [candidate];
    for (const width of [40, 80, 120]) {
      const text = list(current, jobs, width);
      assert.match(text, /\[󰄬 已完成\]/, `${width}: ${text}`);
      assert.doesNotMatch(text, /待交付|待核验|已返回|失败|运行中|思考中/);
      for (const line of renderTasks(current, width, { jobs, maxRows: Infinity })) assert.ok(visibleWidth(line) <= width, `${width}: ${line}`);
    }
    assert.match(graph(current, jobs), /\[󰄬 已完成\]/);
  }
});

test('an unfinished Todo separates pending delivery from pending verification', () => {
  const running = state(task(1, 'in_progress'));
  assert.match(list(running, [job('a1', 1, { reportDelivery: 'pending' })]), /\[󰥔 待交付\]/);
  assert.match(list(running, [job('a1', 1, { reportDelivery: 'delivered' })]), /\[󰥔 待核验\]/);
  assert.match(list(running, [job('a1', 1)]), /\[󰥔 待核验\]/, 'a completed job without a delivery marker still requires verification');
  assert.doesNotMatch(list(running, [job('a1', 1, { reportDelivery: 'pending' })]), /待核验/);
  // A pending Todo with a finished report also waits for verification rather than a fresh return.
  const pending = state(task(1, 'pending'));
  assert.match(list(pending, [job('a1', 1, { reportDelivery: 'delivered' })]), /\[󰥔 待核验\]/);
  assert.match(list(pending, [job('a1', 1, { reportDelivery: 'pending' })]), /\[󰥔 待交付\]/);
});

test('a stale reopened report shows the canonical Todo state, never a fresh acceptance', () => {
  const actions = [
    list(state(task(1, 'pending')), [job('a1', 1, { reportDelivery: 'delivered', taskReportStale: true })]),
    list(state(task(1, 'in_progress')), [job('a1', 1, { reportDelivery: 'pending', taskReportStale: true })]),
    // The stale flag outranks a retained failure label too.
    list(state(task(1, 'in_progress')), [job('a1', 1, { status: 'failed', taskReportStale: true })]),
  ];
  assert.match(actions[0]!, /\[待执行\]/);
  assert.match(actions[1]!, /\[进行中\]/);
  assert.match(actions[2]!, /\[进行中\]/);
  for (const text of actions) assert.doesNotMatch(text, /待交付|待核验|已返回|失败/);
  // A completed Todo still owns the row after a reopen marked its old report stale.
  assert.match(list(state(task(1, 'completed')), [job('a1', 1, { taskReportStale: true })]), /\[󰄬 已完成\]/);
});

test('live and failure labels stay for unfinished non-stale jobs', () => {
  const current = state(task(1, 'in_progress'));
  assert.match(list(current, [job('a1', 1, { status: 'starting' })]), /\[󰓦 启动中\]/);
  assert.match(list(current, [job('a1', 1, { status: 'running' })]), /\[󰥔 运行中\]/);
  assert.match(list(current, [job('a1', 1, { status: 'waiting' })]), /\[󰋗 等待回复\]/);
  assert.match(list(current, [job('a1', 1, { status: 'running', activity: { kind: 'thinking', since: Date.now() - 1000 } })]), /󰧑 思考中/);
  assert.match(list(current, [job('a1', 1, { status: 'failed' })]), /\[󰅙 失败\]/);
  assert.match(list(current, [job('a1', 1, { status: 'cancelled' })]), /\[󰓛 已取消\]/);
  assert.match(list(current, [job('a1', 1, { status: 'interrupted' })]), /\[󰙦 已中断\]/);
});

test('unbound jobs keep the original returned and delivery semantics', () => {
  const current = state(task(1, 'pending'));
  assert.match(list(current, [job('a1', undefined, { reportDelivery: 'pending' })]), /\[󰥔 待交付\]/);
  assert.match(list(current, [job('a1', undefined, { status: 'running' })]), /\[󰥔 运行中\]/);
  assert.match(list(current, [job('a1', undefined, { status: 'failed' })]), /\[󰅙 失败\]/);
  // A delivered unbound report has nothing left to carry, exactly as before.
  assert.doesNotMatch(list(current, [job('a1', undefined, { reportDelivery: 'delivered' })]), /Standalone/);
});

test('the acceptance projection is identical in the list, widget and full DAG previews', () => {
  const current = state(task(1, 'completed'), task(2, 'in_progress'));
  const jobs = [job('a1', 1), job('a2', 2, { reportDelivery: 'pending' })];
  for (const width of [24, 40, 80, 120]) {
    for (const line of renderTasks(current, width, { jobs, maxRows: Infinity })) assert.ok(visibleWidth(line) <= width, `${width}: ${line}`);
    for (const line of renderDag(current, width, undefined, undefined, jobs, { maxLines: 20 })) assert.ok(visibleWidth(line) <= width, `${width}: ${line}`);
  }
  const text = list(current, jobs);
  assert.match(text, /\[󰄬 已完成\]/);
  assert.match(text, /\[󰥔 待交付\]/);
  const preview = graph(current, jobs);
  assert.match(preview, /\[󰄬 已完成\]/);
  assert.match(preview, /\[󰥔 待交付\]/);
  // The Nerd Font row icons survive the new projection.
  assert.match(text, /[✓◐]/);
});

test('the handoff stages keep the warning tint, completion keeps success, stale keeps the Todo tint', () => {
  const builtin = JSON.parse(readFileSync(new URL('../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/dark.json', import.meta.url), 'utf8'));
  const tokens = Object.keys(builtin.colors);
  const foreground = Object.fromEntries(tokens.map((token) => [token, token === 'warning' ? '#ffcc00' : '#cccccc']));
  const background = Object.fromEntries(tokens.map((token) => [token, '#222222']));
  const theme = new Theme(foreground as never, background as never, 'truecolor');
  const render = (current: WorkflowState, jobs: readonly AgentView[]): string => renderTasks(current, 120, { jobs, maxRows: Infinity, theme }).join('\n');
  const running = state(task(1, 'in_progress'));
  assert.ok(render(running, [job('a1', 1, { reportDelivery: 'pending' })]).includes(theme.fg('warning', '[󰥔 待交付]')));
  assert.ok(render(running, [job('a1', 1, { reportDelivery: 'delivered' })]).includes(theme.fg('warning', '[󰥔 待核验]')));
  assert.ok(render(state(task(1, 'completed')), [job('a1', 1)]).includes(theme.fg('success', '[󰄬 已完成]')));
  assert.ok(render(running, [job('a1', 1, { reportDelivery: 'delivered', taskReportStale: true })]).includes(theme.fg('accent', '[进行中]')));
});

test('a bound live tool name still shortens to ten columns', () => {
  const current = state(task(1, 'in_progress'));
  const live = plain(renderTasks(current, 120, { jobs: [job('a1', 1, { status: 'running', activity: { kind: 'tool', tool: 'mcp__github__list_repository_files', since: Date.now() - 3000 } })], maxRows: Infinity }));
  assert.match(live, /󰆍 list_repo… 3s/);
});

test('English acceptance labels stay Han-free once the catalog carries them', () => {
  const en = createTranslator('en');
  const current = state({ ...task(1, 'in_progress'), subject: 'work item' });
  for (const jobs of [[job('a1', 1, { reportDelivery: 'pending' })], [job('a1', 1, { reportDelivery: 'delivered' })], [job('a1', 1, { taskReportStale: true })], [job('a1', 1, { status: 'running' })]]) {
    const text = plain(renderTasks(current, 120, { jobs, maxRows: Infinity, msg: en }));
    assert.doesNotMatch(text, /\p{Script=Han}/u, text);
  }
  const completed = state({ ...task(1, 'completed'), subject: 'work item' });
  assert.match(plain(renderTasks(completed, 120, { jobs: [job('a1', 1)], maxRows: Infinity, msg: en })), /Completed/);
});

// ---------------------------------------------------------------------------
}

// task-takeover.test.ts
{
const current = (): WorkflowState => ({ ...emptyState(), nextId: 2, tasks: [{ id: 1, subject: 'continue the real work', status: 'in_progress', blockedBy: [] }] });
const timedOut = (): AgentView => ({ id: 'a1', todoId: 1, profile: 'worker', status: 'failed', reportDelivery: 'delivered' });

test('explicit main takeover restores the row owner and status in list/DAG/full/preview filters', () => {
  for (const language of ['zh-CN', 'en'] as const) {
    const msg = createTranslator(language); const state = current(); const failed = timedOut();
    assert.match(renderTasks(state, 120, { jobs: [failed], msg }).join('\n'), /a1 · worker/);
    const stale = { ...failed, taskReportStale: true };
    for (const text of [renderTasks(state, 120, { jobs: [stale], msg }).join('\n'), renderTasks(state, 120, { jobs: [stale], msg, maxRows: Infinity, filter: 'pending' }).join('\n'), renderDag(state, 120, undefined, undefined, [stale], { msg }).join('\n'), renderDag(state, 120, undefined, undefined, [stale], { msg, maxLines: 11, filter: 'pending' }).join('\n')]) {
      assert.match(text, language === 'en' ? /\[Main session\]/ : /\[主会话\]/);
      assert.match(text, language === 'en' ? /\[In progress\]/ : /\[进行中\]/);
      assert.doesNotMatch(text, /a1 · worker|失败|Failed|待核验/);
    }
    const custom = { ...state, tasks: state.tasks.map((task) => ({ ...task, owner: 'reviewer' })) };
    assert.match(renderTasks(custom, 120, { jobs: [stale], msg }).join('\n'), /\[reviewer\]/);
    const fresh = { ...stale, id: 'a2', status: 'running' as const, taskReportStale: false };
    assert.match(renderTasks(state, 120, { jobs: [stale, fresh], msg }).join('\n'), /a2 · worker/);
  }
});

test('a wait observation timeout never transfers an actively running job to the main session', () => {
  const running = { ...timedOut(), status: 'running' as const };
  const text = renderTasks(current(), 120, { jobs: [running] }).join('\n');
  assert.match(text, /a1 · worker/); assert.match(text, /运行中/); assert.doesNotMatch(text, /\[主会话\]/);
});

}

// Pure text projection moved out of the behavior suite: building the bounded child brief is a pure
// function of tasks plus job records, so it is exercised directly here (controlled projection suite).
// Original test names and assertions are preserved from task-context.test.ts.
// task-context.test.ts
{
const task = (id: number, status: Todo['status'] = 'completed', blockedBy: number[] = []): Todo => ({ id, subject: `Task ${id}`, status, blockedBy });

test('ordinary context includes only the current task and its direct prerequisites', () => {
  const tasks = [task(1), task(2, 'completed', [1]), { ...task(3, 'pending', [2]), description: 'CURRENT-REQUIREMENTS' }, { ...task(4), subject: 'UNRELATED-PRIVATE' }];
  const before = structuredClone(tasks);
  const brief = taskContext(3, tasks, [{ id: 'a1', todoId: 1, status: 'completed', output: 'TRANSITIVE-PRIVATE' }, { id: 'a2', todoId: 2, status: 'completed', output: 'VERIFIED-DIRECT-RESULT' }])!;
  assert.match(brief, /Task #3.*pending/); assert.match(brief, /CURRENT-REQUIREMENTS/);
  assert.match(brief, /#2 \[completed\].*VERIFIED-DIRECT-RESULT/);
  assert.doesNotMatch(brief, /TRANSITIVE-PRIVATE|UNRELATED-PRIVATE|#1 \[/);
  assert.deepEqual(tasks, before); assert.equal(taskContext(999, tasks, []), undefined);
  assert.equal(taskContext(5, [task(5, 'deleted')], []), undefined);
});

test('ordinary prerequisite ids above the current id still contribute a current report', () => {
  const brief = taskContext(2, [task(2, 'pending', [8]), task(8)], [{ todoId: 8, status: 'completed', output: 'FORWARD-REPORT' }])!;
  assert.match(brief, /#8 \[completed\].*FORWARD-REPORT/);
});

test('a stale or failed newest report never falls back to an earlier successful report', () => {
  for (const latest of [{ status: 'failed' }, { status: 'cancelled' }, { status: 'interrupted' }, { status: 'completed', taskReportStale: true }]) {
    const brief = taskContext(2, [task(1), task(2, 'pending', [1])], [{ todoId: 1, status: 'completed', output: 'OLD-GOOD' }, { todoId: 1, output: 'NEW-UNACCEPTED', ...latest }])!;
    assert.doesNotMatch(brief, /OLD-GOOD|NEW-UNACCEPTED|latest report/);
    assert.match(brief, /#1 \[completed\]/);
  }
});

test('current report excerpts honor outputStart and reject corrupt offsets', () => {
  const history = 'OLD-DIRECTION\n'; const tasks = [task(1), task(2, 'pending', [1])];
  const brief = taskContext(2, tasks, [{ todoId: 1, status: 'completed', output: `${history}CURRENT-REPORT`, outputStart: history.length }])!;
  assert.match(brief, /CURRENT-REPORT/); assert.doesNotMatch(brief, /OLD-DIRECTION/);
  for (const start of [-1, 0.5, 999]) assert.doesNotMatch(taskContext(2, tasks, [{ todoId: 1, status: 'completed', output: 'HIDDEN-REPORT', outputStart: start }])!, /HIDDEN-REPORT/);
});

test('main-owned prerequisites provide explicit references without invented results', () => {
  const first = { ...task(1), description: 'DO-NOT-TREAT-REQUIREMENTS-AS-RESULTS', metadata: { artifacts: ['result.json', 'proof.txt'] } };
  const brief = taskContext(2, [first, task(2, 'pending', [1])], [])!;
  assert.match(brief, /declared artifacts \(unverified\): \["result.json","proof.txt"\]/);
  assert.doesNotMatch(brief, /latest report|DO-NOT-TREAT-REQUIREMENTS-AS-RESULTS/);
  assert.match(brief, /not new permission or proof/);
  assert.deepEqual(contextArtifacts({ ...first, metadata: { artifacts: ['ok.md', 'ok.md', 'bad\npath', 7, 'x'.repeat(513)] } }), ['ok.md']);
});

test('unfinished prerequisite data cannot be presented as accepted output', () => {
  const brief = taskContext(2, [{ ...task(1, 'failed'), metadata: { artifacts: ['UNFINISHED-FILE'] } }, task(2, 'pending', [1])], [{ todoId: 1, status: 'completed', output: 'UNVERIFIED-CLAIM' }])!;
  assert.match(brief, /#1 \[failed\]/); assert.doesNotMatch(brief, /UNFINISHED-FILE|UNVERIFIED-CLAIM/);
});

test('large briefs stay bounded, preserve Unicode and mark omitted input', () => {
  const tasks = Array.from({ length: 60 }, (_, index) => ({ ...task(index + 1), subject: 'long '.repeat(12) }));
  tasks.push({ ...task(61, 'pending', tasks.map((item) => item.id)), description: 'CRITICAL-CURRENT ' + '𐐀'.repeat(2000) });
  const jobs = tasks.slice(0, 60).map((item) => ({ todoId: item.id, status: 'completed', output: 'DIRECT-EVIDENCE ' + '𐐀'.repeat(200) }));
  const brief = taskContext(61, tasks, jobs)!;
  assert.ok(brief.length <= 2000); assert.match(brief, /CRITICAL-CURRENT/); assert.match(brief, /DIRECT-EVIDENCE/); assert.match(brief, /prerequisites omitted/);
  assert.doesNotMatch(brief, /[\uD800-\uDFFF]/u);
});

test('JSON expansion cannot silently delete the current requirements or their truncation notice', () => {
  for (const expansion of ['"', '\\\\', '\u0000']) {
    const current = { ...task(1, 'pending'), subject: 'S'.repeat(120), description: 'MUST KEEP ' + expansion.repeat(900) };
    const brief = taskContext(1, [current], [])!;
    assert.match(brief, /MUST KEEP/); assert.match(brief, /Current requirements excerpt \(truncated/);
    assert.ok(brief.length <= 2000);
    const withDeps = { ...current, blockedBy: [2], metadata: { artifacts: ['path/'.repeat(30) + 'current.json'] } };
    const dependency = { ...task(2), subject: '"'.repeat(80), metadata: { artifacts: ['path/'.repeat(25) + 'result.json'] } };
    const rich = taskContext(1, [withDeps, dependency], [{ todoId: 2, status: 'completed', output: 'DIRECT-PROOF ' + expansion.repeat(200) }])!;
    assert.match(rich, /MUST KEEP/); assert.match(rich, /DIRECT-PROOF/); assert.match(rich, /truncated/); assert.ok(rich.length <= 2000);
  }
});

test('invalid surrogate offsets do not turn a partial character into a current report', () => {
  const tasks = [task(1), task(2, 'pending', [1])];
  assert.doesNotMatch(taskContext(2, tasks, [{ todoId: 1, status: 'completed', output: '𐐀HIDDEN-REPORT', outputStart: 1 }])!, /HIDDEN-REPORT/);
});

test('taskContext preserves the existing fragment path without adding ordinary history', () => {
  const tasks: Todo[] = [{ ...task(1), metadata: { preset: 'flow', run: 1, key: 'first', step: 1 } }, { ...task(2, 'pending', [1]), metadata: { preset: 'flow', run: 1, key: 'last', step: 2 } }];
  const jobs = [{ todoId: 1, status: 'completed', output: 'FRAGMENT-RESULT' }];
  assert.equal(taskContext(2, tasks, jobs), fragmentContext(2, tasks, jobs));
});
}

test('ticket06 the configured model width caps the widget model segment', () => {
  const job: AgentView = { id: 'a1', profile: 'very-long-profile-name', model: { provider: 'dag-test', id: 'very-long-model-name-with-suffix' }, status: 'waiting' };
  const { todoId: _todoId, ...standalone } = job;
  const draw = (modelMax: number) => renderTasks(emptyState(), 120, { jobs: [standalone], modelMax }).join('\n');
  const wide = draw(18), narrow = draw(6);
  assert.notEqual(wide, narrow, 'the configured cap changes the rendered row');
  const segment = (text: string) => /a1 · ([^[]+)\s*\[/.exec(text)?.[1]?.trim() ?? '';
  assert.ok(visibleWidth(segment(narrow)) <= 6, narrow);
  assert.ok(visibleWidth(segment(wide)) <= 18, wide);
  assert.ok(visibleWidth(segment(narrow)) < visibleWidth(segment(wide)));
});
