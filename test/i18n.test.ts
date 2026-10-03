import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { visibleWidth } from "@earendil-works/pi-tui";
import { chinese, createTranslator, localizeSavedMessage, resolveLocale } from "../src/shared/i18n.ts";
import { englishMessages } from "../src/shared/messages.en.ts";
import { configPaths, loadConfig, loadLocale } from "../src/shared/config.ts";
import { applyTodo, emptyState, statusLabel, type Todo, type WorkflowState } from "../src/todos/state.ts";
import { applyGoal, emptyGoalState, type GoalState } from "../src/goal/state.ts";
import { renderTasks, renderDag, clean } from "../src/ui/render.ts";
import { detailView } from "../src/ui/detail.ts";
import { dagLayout } from "../src/dag/layout.ts";
import { dagStructure } from "../src/dag/cache.ts";
import { registerTodos } from "../src/todos/register.ts";
import { registerPlan } from "../src/plan/register.ts";
import { registerGoal } from "../src/goal/register.ts";
import { registerAgents } from "../src/agents/register.ts";

const en = createTranslator("en");
const hasHan = (text: string): boolean => /\p{Script=Han}/u.test(text);
const placeholders = (text: string): string[] => [...text.matchAll(/\{(\d+)\}/g)].map((match) => match[1]!).sort();
const stripAnsi = (text: string): string => text.replace(/\x1b\[[0-9;]*m/g, "");

// ---------------------------------------------------------------------------
// Locale resolution
// ---------------------------------------------------------------------------

test("resolveLocale honours an explicit language and otherwise follows terminal preferences", () => {
  assert.equal(resolveLocale("en", {}), "en");
  assert.equal(resolveLocale("zh-CN", { LANG: "en_US.UTF-8" }), "zh-CN");
  assert.equal(resolveLocale("auto", { LANG: "zh_CN.UTF-8" }), "zh-CN");
  assert.equal(resolveLocale("auto", { LANG: "zh-TW" }), "zh-CN");
  assert.equal(resolveLocale("auto", { LANG: "en_US.UTF-8" }), "en");
  assert.equal(resolveLocale("auto", { LANG: "fr_FR.UTF-8" }), "en");
  assert.equal(resolveLocale("auto", {}), "en");
});

test("resolveLocale precedence is LC_ALL > LC_MESSAGES > LANGUAGE > LANG, first LANGUAGE entry wins", () => {
  assert.equal(resolveLocale("auto", { LC_ALL: "zh_CN", LANG: "en_US" }), "zh-CN");
  assert.equal(resolveLocale("auto", { LC_MESSAGES: "zh_CN", LANG: "en_US" }), "zh-CN");
  assert.equal(resolveLocale("auto", { LC_ALL: "en_US", LC_MESSAGES: "zh_CN", LANG: "zh_CN" }), "en");
  assert.equal(resolveLocale("auto", { LANGUAGE: "zh_CN:en", LANG: "en_US" }), "zh-CN");
  assert.equal(resolveLocale("auto", { LANGUAGE: "fr_FR:zh_CN", LANG: "zh_CN" }), "en");
  assert.equal(resolveLocale("auto", { LANGUAGE: "", LANG: "zh_CN" }), "zh-CN");
});

// ---------------------------------------------------------------------------
// Translator semantics
// ---------------------------------------------------------------------------

test("createTranslator translates static templates before interpolation and copies values verbatim", () => {
  assert.equal(en("待执行"), "Pending");
  assert.equal(createTranslator("zh-CN")("待执行"), "待执行");
  assert.equal(en`已清空 ${2} 项，编号不复用`, "Cleared 2 item(s); ids are not reused");
  // Unknown keys fall through untouched in both locales.
  assert.equal(en("不存在的模板"), "不存在的模板");
  assert.equal(chinese("不存在的模板"), "不存在的模板");
  for (const key of ['constructor', 'toString', '__proto__']) assert.equal(en(key), key);
  // A user value that itself looks like a placeholder is not re-substituted.
  const subject = "含 {0} 与 {1} 的用户标题";
  assert.equal(en`已创建 #${1}：${subject} [${en("已完成")}]`, "Created #1: 含 {0} 与 {1} 的用户标题 [Completed]");
  // User text with terminal escapes reaches the translator untouched; UI clean() removes it.
  const dirty = "标题\x1b[31m红\x1b[0m\n下一行";
  const rendered = en`已更新 #${1}：${dirty} [${en("进行中")}]`;
  assert.ok(rendered.includes("\x1b[31m"));
  assert.doesNotMatch(clean(rendered), /\x1b|\n/);
});

test("interleaved translators keep their own locale without leaking global state", () => {
  const zh = createTranslator("zh-CN");
  const messages: string[] = [];
  for (let index = 0; index < 3; index++) {
    messages.push(en("已完成"), zh("已完成"), en("待执行"), zh("待执行"));
    messages.push(en`已更新 #${index + 1}：${index} [${en("已完成")}]`, zh`已更新 #${index + 1}：${index} [${zh("已完成")}]`);
  }
  assert.deepEqual(messages.slice(0, 4), ["Completed", "已完成", "Pending", "待执行"]);
  assert.equal(messages[4], "Updated #1: 0 [Completed]");
  assert.equal(messages[5], "已更新 #1：0 [已完成]");
  // Repeated calls remain stable and the exported default still speaks Chinese.
  assert.equal(en("已完成"), "Completed");
  assert.equal(chinese("已完成"), "已完成");
});

test('saved plugin reasons follow the new locale without changing unknown text', () => {
  assert.equal(localizeSavedMessage('目标已完成', en), 'Goal completed');
  assert.equal(localizeSavedMessage('Goal completed', chinese), '目标已完成');
  assert.equal(localizeSavedMessage('Goal completed', en), 'Goal completed');
  assert.equal(localizeSavedMessage('Unknown historical reason {0}', en), 'Unknown historical reason {0}');
});

test("English catalog values never contain Han characters and mirror key placeholders", () => {
  const entries = Object.entries(englishMessages);
  assert.ok(entries.length > 200);
  for (const [key, value] of entries) {
    assert.ok(key.length > 0 && value.length > 0, key);
    assert.ok(!hasHan(value), `English value still contains Han: ${key} -> ${value}`);
    assert.deepEqual(placeholders(value), placeholders(key), `placeholder mismatch: ${key} -> ${value}`);
  }
});

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

test("applyTodo speaks English while user-authored subjects stay untouched", () => {
  const created = applyTodo(emptyState(), { action: "create", subject: "中文任务" }, en);
  assert.equal(created.text, "Created #1: 中文任务 [Pending]");
  assert.equal(applyTodo(created.state, { action: "list" }, en).text, "#1 [Pending] 中文任务");
  assert.equal(applyTodo(created.state, { action: "clear" }, en).text, "Cleared 1 item(s); ids are not reused");
  // Validation errors are localized.
  assert.throws(() => applyTodo(emptyState(), { action: "create", subject: " " }, en), /subject/);
  assert.throws(() => applyTodo(created.state, { action: "update", id: 99 }, en), /Task #99 not found/);
  assert.throws(() => applyTodo(created.state, { action: "update", id: 1 }, en), /at least one changed field/);
  assert.throws(() => applyTodo(created.state, { action: "bogus" as never }, en), /Unknown Todo action/);
  // Chinese remains the baseline default.
  assert.equal(applyTodo(emptyState(), { action: "create", subject: "任务" }).text, "已创建 #1：任务 [待执行]");
  assert.equal(statusLabel.pending, "待执行");
});

test("applyTodo dependency and Plan rejections are localized without translating ids or subjects", () => {
  const state: WorkflowState = { ...emptyState(), tasks: [
    { id: 1, subject: "入口", status: "pending", blockedBy: [] },
    { id: 2, subject: "下游", status: "pending", blockedBy: [1] },
  ], nextId: 3 };
  assert.throws(() => applyTodo(state, { action: "update", id: 2, status: "completed" }, en), /Prerequisites incomplete: #1; cannot start or complete #2/);
  assert.throws(() => applyTodo({ ...state, plan: true }, { action: "update", id: 1, status: "in_progress" }, en), /Plan only allows organizing tasks/);
  assert.throws(() => applyTodo(emptyState(), { action: "create", subject: "X", blockedBy: [0] }, en), /Dependencies must be valid task ids/);
  assert.throws(() => applyTodo(state, { action: "delete", id: 1 }, en), /depends on deleted #1/);
  assert.throws(() => applyTodo(state, { action: "update", id: 2, blockedBy: [1] } as never, en), /does not accept field blockedBy/);
});

test("applyGoal speaks English, keeps Chinese titles/descriptions and applies the turn budget", () => {
  const created = applyGoal(emptyGoalState(), { action: "create", title: "中文目标", description: "完整描述不要翻译" }, 20, en);
  assert.equal(created.text, "Goal #1 create: 中文目标");
  assert.equal(created.state.goals[0]!.description, "完整描述不要翻译");
  assert.equal(applyGoal(emptyGoalState(), { action: "list" }, 20, en).text, "No goals");
  assert.throws(() => applyGoal(emptyGoalState(), { action: "create", title: "" }, 20, en), /title must be non-empty text of at most 1024 bytes/);
  assert.throws(() => applyGoal(emptyGoalState(), { action: "create", title: "X", maxTurns: 201 }, 32, en), /Corrupt goal status\/budget/);
  assert.throws(() => applyGoal(emptyGoalState(), { action: "bogus" as never }, 20, en), /Unknown Goal action/);
  // A paused focused goal labels itself in English while preserving the title.
  const paused: GoalState = { ...created.state, focusId: 1, goals: [{ ...created.state.goals[0]!, status: "paused" }], run: { paused: true, used: 1, stalled: 0 } };
  assert.equal(applyGoal(paused, { action: "list" }, 20, en).text, "#1 󰓾 [Paused] 中文目标");
  // Chinese baseline default.
  assert.equal(applyGoal(emptyGoalState(), { action: "create", title: "目标" }).text, "Goal #1 create：目标");
});

// ---------------------------------------------------------------------------
// UI rendering
// ---------------------------------------------------------------------------

const uiTasks: Todo[] = [
  { id: 1, subject: "Entry", status: "completed", blockedBy: [] },
  { id: 2, subject: "Research", status: "in_progress", blockedBy: [1], activeForm: "checking" },
  { id: 3, subject: "Implement", status: "pending", blockedBy: [1], owner: "User{0}\x1b[31m" },
  { id: 4, subject: "Verify", status: "pending", blockedBy: [2, 3] },
];
const uiState: WorkflowState = { ...emptyState(), tasks: uiTasks, nextId: 5, plan: true };
const uiJobs = [{ id: "a1", todoId: 2, profile: "fast", status: "running" as const, activity: { kind: "thinking" as const, since: Date.now() } }];

test("English renderTasks shows read-only, live agent activity, hidden rows and status words at every width", () => {
  for (const width of [20, 40, 80, 120]) {
    const lines = renderTasks(uiState, width, { maxRows: 3, jobs: uiJobs, msg: en });
    for (const line of lines) {
      assert.ok(visibleWidth(line) <= width, `${width}: ${line}`);
      assert.doesNotMatch(line, /[\r\n]/);
    }
    assert.ok(!hasHan(lines.join("\n")), `unexpected Chinese at width ${width}: ${lines.join("\n")}`);
  }
  const wide = renderTasks(uiState, 80, { maxRows: 3, jobs: uiJobs, msg: en }).join("\n");
  assert.match(wide, /Plan \[read-only\]/);
  assert.match(wide, /Thinking/);
  assert.match(wide, /Main session/);
  assert.match(wide, /1 hidden/);
  const narrow = renderTasks(uiState, 20, { maxRows: 3, jobs: uiJobs, msg: en }).join("\n");
  assert.match(narrow, /1 hidden/);
  assert.doesNotMatch(narrow, /Plan \[read-only\]/);
  // Owner text is cleaned for display but its placeholder-looking content survives as data.
  assert.match(wide, /User\{0\}/);
  assert.equal(stripAnsi(wide), wide);
  assert.doesNotMatch(wide, /\x1b/);
});

test("English renderTasks keeps the three-block alignment and canonical chronological ids", () => {
  const lines = renderTasks(uiState, 120, { maxRows: Infinity, jobs: uiJobs, msg: en });
  const body = lines.filter((line) => /^[│ ]*[├└]─ /.test(stripAnsi(line)));
  assert.equal(body.length, 4);
  const iconColumn = (line: string): number => stripAnsi(line).search(/[✓○◐]/);
  const titleColumn = (line: string): number => {
    const plain = stripAnsi(line);
    const icon = plain.search(/[✓○◐]/);
    const after = plain.slice(icon + 1);
    return icon + 1 + (after.length - after.replace(/^ +/, "").length);
  };
  const icons = body.map(iconColumn);
  const titles = body.map(titleColumn);
  assert.ok(icons.every((value) => value === icons[0]));
  assert.ok(titles.every((value) => value === icons[0]! + 2));
  const ids = body.map((line) => Number(/#(\d+)/.exec(stripAnsi(line))![1]));
  assert.deepEqual(ids, [1, 2, 3, 4]);
});

test("English renderDag uses an explicit localized fallback and stays within narrow widths", () => {
  const fallback = renderDag(uiState, 40, undefined, undefined, [], { maxLines: 8, msg: en });
  for (const line of fallback) assert.ok(visibleWidth(line) <= 40, line);
  const text = fallback.join("\n");
  assert.match(text, /Graph degraded to a list: Parallel node/);
  assert.match(text, /#4<-#2,#3/);
  assert.ok(!hasHan(text));
  // A real solid graph is also localized at the header level.
  const graph = renderDag(uiState, 120, undefined, "中文目标", [], { msg: en });
  assert.match(graph.join("\n"), /Plan \[read-only\]/);
});

test("English dagLayout reasons and detail footer use the supplied translator", () => {
  const tiny = dagLayout(dagStructure([{ id: 1, status: "pending", blockedBy: [] }]), 10, en);
  assert.equal(tiny.layout, undefined);
  assert.equal(tiny.reason, "Insufficient width");
  const structure = dagStructure([{ id: 1, status: 'pending', blockedBy: [] }]);
  assert.equal(dagLayout(structure, 10, en).reason, 'Insufficient width');
  assert.equal(dagLayout(structure, 10, chinese).reason, '宽度不足');
  assert.equal(dagLayout(structure, 10, en).reason, 'Insufficient width');

  const panel = detailView(() => ["HEADER", "row"], () => 3, () => {}, () => {}, undefined, en);
  const rendered = panel.render(80);
  assert.match(rendered[rendered.length - 1]!, /Esc back · ↑\/↓ PgUp\/PgDn Home\/End/);
  assert.ok(rendered.every((line) => visibleWidth(line) <= 80));
  assert.ok(!hasHan(rendered.join("\n")));
});

// ---------------------------------------------------------------------------
// Config language
// ---------------------------------------------------------------------------

test("loadConfig defaults to language auto and loadLocale follows config before terminal preferences", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dag-i18n-"));
  const previous = {
    agent: process.env.PI_CODING_AGENT_DIR,
    LC_ALL: process.env.LC_ALL, LC_MESSAGES: process.env.LC_MESSAGES,
    LANGUAGE: process.env.LANGUAGE, LANG: process.env.LANG,
  };
  process.env.PI_CODING_AGENT_DIR = directory;
  delete process.env.LC_ALL; delete process.env.LC_MESSAGES; delete process.env.LANGUAGE; delete process.env.LANG;
  try {
    assert.deepEqual(await loadConfig(), { language: "auto", goalMaxTurns: 32, goalNoProgressLimit: 3, goalErrorRetries: 5, planTools: [] });
    process.env.LANG = "zh_CN.UTF-8";
    assert.equal(loadLocale(), "zh-CN");
    process.env.LC_ALL = "en_US.UTF-8";
    assert.equal(loadLocale(), "en");

    await mkdir(configPaths().directory, { recursive: true });
    const config = configPaths().config;
    const write = (value: unknown) => writeFile(config, JSON.stringify(value));
    await write({ language: "en" });
    assert.equal(loadLocale(), "en");
    assert.deepEqual(await loadConfig(), { language: "en", goalMaxTurns: 32, goalNoProgressLimit: 3, goalErrorRetries: 5, planTools: [] });
    await write({ language: "zh-CN" });
    assert.equal(loadLocale(), "zh-CN");
    await write({ language: "auto" });
    assert.equal(loadLocale(), "en");
    await write({ language: "fr" });
    assert.equal(loadLocale(), "en");
    await write("not json");
    assert.equal(loadLocale(), "en");
  } finally {
    if (previous.agent === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous.agent;
    const restore = (key: "LC_ALL" | "LC_MESSAGES" | "LANGUAGE" | "LANG", value: string | undefined) => {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    };
    restore("LC_ALL", previous.LC_ALL); restore("LC_MESSAGES", previous.LC_MESSAGES);
    restore("LANGUAGE", previous.LANGUAGE); restore("LANG", previous.LANG);
    await rm(directory, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Registration hooks accept a translator
// ---------------------------------------------------------------------------

interface CompletionItem { value: string; description?: string }
interface FakePi { commands: Map<string, { description?: string; getArgumentCompletions?: (prefix: string) => CompletionItem[] | null }>; pi: unknown }
function fakePi(): FakePi {
  const commands = new Map<string, { description?: string; getArgumentCompletions?: (prefix: string) => CompletionItem[] | null }>();
  const pi = {
    registerTool() {}, registerFlag() {}, on() {}, appendEntry() {},
    getAllTools: () => [],
    registerCommand(name: string, options: { description?: string; getArgumentCompletions?: (prefix: string) => CompletionItem[] | null }) { commands.set(name, options); },
  };
  return { commands, pi };
}

test("registerTodos/Plan/Goal/Agents localize command descriptions and completions through hooks.msg", async () => {
  const { pi, commands } = fakePi();
  const state: WorkflowState = { ...emptyState(), tasks: [{ id: 1, subject: "入口", status: "pending", blockedBy: [] }] };
  registerTodos(pi as never, { msg: en, state: () => state, mutate: () => state as never, commit: () => {}, show: async () => {}, protected: () => false, reset: () => {} });
  registerPlan(pi as never, { msg: en, state: () => state, commit: () => {}, protected: () => false, assertCanEnter: () => {}, onEnter: () => {} });
  registerGoal(pi as never, { msg: en, state: () => state, jobs: () => [], paint: () => {}, protected: () => false, pauseAgents: () => {}, resumeAgents: () => {} });
  registerAgents(pi as never, { msg: en, state: () => state, mutate: () => {}, paint: () => {}, protected: () => false });

  for (const name of ["todos", "plan", "goal", "agents"]) {
    const description = commands.get(name)!.description!;
    assert.ok(description.length > 0);
    assert.ok(!hasHan(description), `/${name} description is not English: ${description}`);
  }
  assert.match(commands.get("todos")!.description!, /Current Todos/);
  assert.match(commands.get("goal")!.description!, /Goal new\/list\/enable/);

  const roots = (name: string): Record<string, string | undefined> => {
    const items = commands.get(name)!.getArgumentCompletions!("")!;
    return Object.fromEntries(items.map((item) => [item.value, item.description]));
  };
  const todos = roots("todos");
  assert.equal(todos["add"], "New task: add title [--after 1,2]");
  assert.equal(todos["start"], "Start task: start #id");
  assert.ok(Object.values(todos).every((description) => description === undefined || !hasHan(description)));
  const plan = roots("plan");
  assert.equal(plan["start"], "Enter read-only planning");
  assert.equal(plan["off"], "Exit planning and resume implementation");
  const goal = roots("goal");
  assert.equal(goal["new"], "Create a goal (does not start): new title");
  assert.equal(goal["enable"], "Enable and advance a goal: enable [ #id]");
  assert.equal(goal["disable"], "Disable or pause a goal: disable [ #id]");
  assert.deepEqual(Object.keys(goal), ["new", "list", "enable", "disable", "complete", "delete", "edit", "get", "policy", "config", "reset", "help"]);
  const agents = roots("agents");
  assert.equal(agents["list"], "View Jobs and pause state");
  assert.equal(agents["profile"], "Save a Profile: profile name provider/model [thinking] [tools]");

  // Omitting msg keeps the Chinese baseline.
  const plain = fakePi();
  registerTodos(plain.pi as never, { state: () => state, mutate: () => state as never, commit: () => {}, show: async () => {}, protected: () => false, reset: () => {} });
  assert.equal(plain.commands.get("todos")!.description, "当前 Todos：查看、编辑与视图切换；也可直接描述需求");
  const zhItems = plain.commands.get("todos")!.getArgumentCompletions!("")!;
  assert.equal(zhItems.find((item) => item.value === "add")!.description, "新建任务：add 标题 [--after 1,2]");
});
