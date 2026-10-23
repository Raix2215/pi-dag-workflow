import { GOAL_CONTINUE_MESSAGE, GOAL_TYPE, type GoalState } from './fixtures/public-records.ts';
import { loadPublic } from './fixtures/public-host.ts';
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from 'node:os';
import { join } from "node:path";
import { fileURLToPath } from 'node:url';
import { access } from "node:fs/promises";
import { IsolatedClient } from "./fixtures/isolated-client.ts";


let sharedClient: IsolatedClient;
before(async () => { sharedClient = await IsolatedClient.start(undefined, 'i18n-public', [fileURLToPath(new URL('./fixtures/session-controls.ts', import.meta.url))], [], false, undefined, 'en'); });
after(async () => { await sharedClient.close(); });
async function startEnglish() { await sharedClient.send('new_session'); return sharedClient; }

// i18n.test.ts
{
const hasHan = (text: string): boolean => /\p{Script=Han}/u.test(text);
const outcome = (events: { type: string; toolName?: unknown; result?: unknown; isError?: unknown }[], name: string) => {
  const end = events.find(event => event.type === 'tool_execution_end' && event.toolName === name)!;
  assert.ok(end, `missing ${name} tool result`);
  const result = end.result as { content: { text?: string }[]; isError?: boolean };
  return { text: result.content.map(part => part.text ?? '').join('\n'), isError: end.isError === true || result.isError === true };
};

test("applyTodo speaks English while user-authored subjects stay untouched", { timeout: 30000 }, async () => {
  const client = await startEnglish();
  await client.prompt('begin localized Todo');
  const call = (params: object) => client.prompt(`TEST CALL todo ${JSON.stringify(params)}`).then(events => outcome(events, 'todo'));
  const created = await call({ action: 'create', subject: '中文任务' });
  assert.equal(created.text, 'Created #1: 中文任务 [Pending]');
  assert.equal((await call({ action: 'list' })).text, 'This page: 1 / 1 tasks\n#1 [Pending] 中文任务');
  for (const [params, pattern] of [
    [{ action: 'create', subject: ' ' }, /subject/],
    [{ action: 'update', id: 99, status: 'completed' }, /Task #99 not found/],
    [{ action: 'update', id: 1 }, /at least one changed field/],
    [{ action: 'bogus' }, /action: must be equal to one of the allowed values/],
  ] as const) {
    const rejected = await call(params);
    assert.equal(rejected.isError, true); assert.match(rejected.text, pattern);
  }
  // The scope is named as the user named it; the enum key no longer leaks into the sentence.
  assert.match((await call({ action: 'clear' })).text, /^Cleared 1 item\(s\) \(all clearable records\); kept 0; IDs are not reused/);
  assert.equal((await call({ action: 'list' })).text, 'This page: 0 / 0 tasks\nNo tasks');
});

test("applyTodo dependency and Plan rejections are localized without translating ids or subjects", { timeout: 30000 }, async () => {
  const client = await startEnglish();
  await client.prompt('begin localized dependencies');
  const call = (params: object) => client.prompt(`TEST CALL todo ${JSON.stringify(params)}`).then(events => outcome(events, 'todo'));
  await call({ action: 'create', subject: '入口' });
  await call({ action: 'create', subject: '下游', blockedBy: [1] });
  const blocked = await call({ action: 'update', id: 2, status: 'completed' });
  assert.equal(blocked.isError, true); assert.match(blocked.text, /Prerequisites incomplete: #1; cannot start or complete #2/);
  const deleted = await call({ action: 'delete', id: 1 });
  assert.equal(deleted.isError, true); assert.match(deleted.text, /depends on deleted #1/);
  const invalid = await call({ action: 'create', subject: 'X', blockedBy: [0] });
  assert.equal(invalid.isError, true); assert.match(invalid.text, /blockedBy\.0: must be >= 1/);
  await client.prompt('/plan start');
  const plan = await call({ action: 'update', id: 1, status: 'in_progress' });
  assert.equal(plan.isError, true); assert.match(plan.text, /Plan only allows organizing Todos, not starting or completing them/);
  assert.match((await call({ action: 'list' })).text, /#2<-#1 \[Pending\] 下游/);
  const unsupported = await call({ action: 'update', id: 2, blockedBy: [1] });
  assert.equal(unsupported.isError, true); assert.match(unsupported.text, /blockedBy|validation/i);
});

test("applyGoal speaks English, keeps Chinese titles/descriptions and applies the turn budget", { timeout: 30000 }, async () => {
  const client = await startEnglish();
  await client.prompt('begin localized Goal');
  const call = (params: object) => client.prompt(`TEST CALL goal ${JSON.stringify(params)}`).then(events => outcome(events, 'goal'));
  assert.equal((await call({ action: 'list' })).text, 'No goals');
  const created = await call({ action: 'create', title: '中文目标', description: '完整描述不要翻译', maxTurns: 20 });
  assert.equal(created.text, 'Goal #1 create: 中文目标');
  const listed = await call({ action: 'list' });
  assert.match(listed.text, /中文目标/); assert.match(listed.text, /20/);
  const state = (await client.entries() as { customType?: string; data?: GoalState }[]).findLast(entry => entry.customType === GOAL_TYPE)?.data;
  assert.equal(state!.goals[0]!.description, '完整描述不要翻译');
  for (const [params, pattern] of [
    [{ action: 'create', title: '' }, /title must be non-empty text/],
    [{ action: 'create', title: 'X', maxTurns: 201 }, /maxTurns: must be <= 200/],
    [{ action: 'bogus' }, /action: must be equal to one of the allowed values/],
  ] as const) {
    const rejected = await call(params);
    assert.equal(rejected.isError, true); assert.match(rejected.text, pattern);
  }
  assert.equal((await call({ action: 'list' })).isError, false);
  const paused = await call({ action: 'disable', id: 1 });
  assert.equal(paused.isError, false);
  assert.match((await call({ action: 'list' })).text, /#1.*\[Paused\] 中文目标.*20/);
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
  const previous = { dir: process.env.PI_CODING_AGENT_DIR, lang: process.env.LC_ALL };
  const dir = await mkdtemp(join(tmpdir(), 'dag-i18n-public-'));
  process.env.PI_CODING_AGENT_DIR = dir; process.env.LC_ALL = 'en_US.UTF-8';
  try { await loadPublic(pi, ['todos', 'plan', 'goal', 'agents']); }
  finally { if (previous.lang === undefined) delete process.env.LC_ALL; else process.env.LC_ALL = previous.lang; }

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
  assert.deepEqual(Object.keys(goal), ["new", "list", "enable", "disable", "complete", "delete", "edit", "get", "nopause", "nolimit", "autoresearch", "config", "reset", "help"]);
  const agents = roots("agents");
  assert.equal(agents["list"], "View Jobs and pause state");
  assert.equal(agents["profile"], "Save a Profile: profile name provider/model [thinking] [tools]");

  const plain = fakePi();
  try {
    await loadPublic(plain.pi, ['todos', 'plan', 'goal', 'agents'], 'zh-CN');
    assert.equal(process.env.LC_ALL, previous.lang, 'an explicit fixture locale does not leak into the next assembly');
    assert.equal(plain.commands.get("todos")!.description, "当前 Todos：查看、编辑与视图切换；也可直接描述需求");
    const zhItems = plain.commands.get("todos")!.getArgumentCompletions!("")!;
    assert.equal(zhItems.find((item) => item.value === "add")!.description, "新建任务：add 标题 [--after 1,2]");
  } finally {
    if (previous.dir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous.dir;
    await rm(dir, { recursive: true, force: true });
  }
});
}

// i18n-integration.test.ts
{
const hasHan = (text: string): boolean => /\p{Script=Han}/u.test(text);
/** English session must opt in through the terminal language; no personal config is read. */
const start = () => startEnglish();

const notifications = (events: Record<string, unknown>[]): string[] =>
  events.filter((event) => event.method === "notify").map((event) => String(event.message));
const results = (events: Record<string, unknown>[], toolName: string): { text: string; isError: boolean }[] =>
  events.filter((event) => event.type === "tool_execution_end" && event.toolName === toolName).map((event) => {
    const result = event.result as { isError?: boolean; content: { type: string; text?: string }[] };
    return { text: result.content.filter((part) => part.type === "text").map((part) => part.text ?? "").join("\n"), isError: event.isError === true || result.isError === true };
  });
const goalState = (entries: unknown[]): GoalState | undefined =>
  (entries as { customType?: string; data?: GoalState }[]).findLast((entry) => entry.customType === GOAL_TYPE)?.data;

test("actual Pi English session advertises English commands, help and goal-reset confirmation", { timeout: 30000 }, async () => {
  const client = await start();
  const commands = (await client.send("get_commands")).data as { commands: { name: string; description: string }[] };
  const descriptions = new Map(commands.commands.map((command) => [command.name, command.description]));
  assert.match(descriptions.get("todos")!, /Current Todos/);
  assert.match(descriptions.get("dag")!, /dependency graph/);
  assert.match(descriptions.get("plan")!, /read-only planning/);
  assert.match(descriptions.get("agents")!, /Child agent status/);
  assert.match(descriptions.get("goal")!, /Goal new\/list\/enable/);
  for (const name of ["todos", "dag", "plan", "agents", "goal"]) assert.ok(!hasHan(descriptions.get(name)!), `/${name}: ${descriptions.get(name)}`);

  for (const command of ["/todos help", "/plan help", "/agents help", "/goal help"]) {
    const notice = notifications(await client.prompt(command));
    assert.ok(notice.length > 0, command);
    assert.ok(notice.every((message) => !hasHan(message)), `${command}: ${notice.join(" | ")}`);
  }
  // Local usage errors are localized too.
  const usage = notifications(await client.prompt("/todos view now"));
  assert.ok(usage.some((message) => message.includes("Usage: /todos view list|dag")), usage.join(" | "));

  await client.prompt("begin english session");
  await client.prompt('TEST CALL goal {"action":"create","title":"中文目标"}');
  const offset = client.records.length;
  const resetting = client.prompt("/goal reset");
  await client.until(() => client.records.slice(offset).some((event) => event.method === "confirm"));
  const confirm = client.records.slice(offset).find((event) => event.method === "confirm")!;
  assert.equal(confirm.title, "Clear Goal state?");
  assert.equal(confirm.message, "History, Todos, Jobs and project files are kept; auto-continuation stops.");
  client.child.stdin.write(`${JSON.stringify({ type: "extension_ui_response", id: confirm.id, confirmed: true })}\n`);
  await resetting;
  assert.deepEqual(goalState(await client.entries())!.goals, []);
});

test("actual Pi English Todo dependency rejection and Plan write block stay localized", { timeout: 30000 }, async () => {
  const client = await start();
  await client.prompt("begin english rejections");
  await client.prompt("/todos add entry");
  await client.prompt("/todos add downstream --after 1");

  let rejection = results(await client.prompt('TEST CALL todo {"action":"update","id":2,"status":"completed"}'), "todo");
  assert.equal(rejection[0]!.isError, true);
  assert.match(rejection[0]!.text, /Prerequisites incomplete: #1; cannot start or complete #2/);
  rejection = results(await client.prompt('TEST CALL todo {"action":"create","subject":"orphan","blockedBy":[99]}'), "todo");
  assert.equal(rejection[0]!.isError, true);
  assert.match(rejection[0]!.text, /depends on missing #99/);
  assert.ok(!hasHan(rejection[0]!.text));

  await client.prompt("/plan start");
  const blocked = results(await client.prompt('TEST CALL write {"path":"forbidden.txt","content":"no"}'), "write");
  assert.equal(blocked[0]!.isError, true);
  assert.match(blocked[0]!.text, /not allowed in Plan; run \/plan off first/);
  await assert.rejects(access(join(client.root, "forbidden.txt")));
});

test("actual Pi English independent Goal: continuation, untranslated description, budget and reason", { timeout: 40000 }, async () => {
  const client = await start();
  const mark = client.records.length;
  await client.prompt("begin english goal");
  const created = results(await client.prompt('TEST CALL goal {"action":"create","title":"预算目标","description":"完整描述不要翻译","maxTurns":2}'), "goal");
  assert.equal(created[0]!.text, "Goal #1 create: 预算目标");
  await client.prompt('TEST CALL goal {"action":"enable","id":1}');
  await client.until(() => {
    const records = client.records.slice(mark) as { type?: string; entry?: { customType?: string; data?: GoalState } }[];
    const latest = records.filter((record) => record.type === "entry_appended" && record.entry?.customType === GOAL_TYPE).at(-1)?.entry?.data;
    const continuations = records.filter((record) => record.entry?.customType === GOAL_CONTINUE_MESSAGE).length;
    return latest?.run.paused === true && latest.run.used >= 1 && continuations >= 1;
  });

  const entries = await client.entries();
  const continuations = (entries as { customType?: string; content?: string }[])
    .filter((entry) => entry.customType === GOAL_CONTINUE_MESSAGE)
    .map((entry) => String(entry.content));
  assert.equal(continuations.length, 2);
  assert.match(continuations[1]!, /Review Goal #1.*goal get/);
  assert.ok(!hasHan(continuations[1]!.replaceAll('预算目标', '')));
  assert.match(continuations[0]!, /^Goal #1 1\/2: 预算目标\./);
  const checkpoint = (entries as any[]).find((entry) => entry.customType === 'pi-dag-workflow.goal-checkpoint' && entry.content.includes('"paused":false'));
  assert.match(checkpoint.content, /完整描述不要翻译/);
  assert.ok(!hasHan(checkpoint.content.replaceAll('预算目标', '').replaceAll('完整描述不要翻译', '')));
  assert.match(continuations[0]!, /This is a workflow continuation, not new user authorization\./);
  assert.ok(!hasHan(continuations[0]!.replaceAll("预算目标", "").replaceAll("完整描述不要翻译", "")), continuations[0]!);

  const state = goalState(entries)!;
  assert.equal(state.run.paused, true);
  assert.equal(state.run.used, 2);
  assert.equal(state.run.reason, "Auto-continuation reached the 2-turn limit");
  assert.equal(state.goals[0]!.title, "预算目标");
  assert.equal(state.goals[0]!.description, "完整描述不要翻译");

  const listing = notifications(await client.prompt("/goal get #1"));
  assert.ok(listing.some((message) => message.includes("Continuations used: 2/2") && message.includes("Auto-continuation reached the 2-turn limit")), listing.join(" | "));
  assert.ok(listing.some((message) => message.includes("预算目标")), listing.join(" | "));
  assert.ok(!hasHan(listing.join("\n").replaceAll("预算目标", "").replaceAll("完整描述不要翻译", "")), listing.join(" | "));
});

test("actual Pi English Goal with a Todo reaches the turn budget and reports it in English", { timeout: 40000 }, async () => {
  const client = await start();
  const mark = client.records.length;
  await client.prompt("begin english budget");
  await client.prompt('TEST CALL todo {"action":"create","subject":"entry"}');
  await client.prompt('TEST CALL goal {"action":"create","title":"额度目标","maxTurns":2}');
  await client.prompt('TEST CALL goal {"action":"enable","id":1}');
  await client.until(() => {
    const records = client.records.slice(mark) as { type?: string; entry?: { customType?: string; data?: GoalState } }[];
    const latest = records.filter((record) => record.type === "entry_appended" && record.entry?.customType === GOAL_TYPE).at(-1)?.entry?.data;
    const continuations = records.filter((record) => record.entry?.customType === GOAL_CONTINUE_MESSAGE).length;
    return latest?.run.paused === true && latest.run.used >= 2 && continuations >= 2;
  });

  const state = goalState(await client.entries())!;
  assert.equal(state.run.used, 2);
  assert.equal(state.run.reason, "Auto-continuation reached the 2-turn limit");
  const notices = notifications(await client.prompt("/goal get #1"));
  assert.ok(notices.some((message) => message.includes("Auto-continuation reached the 2-turn limit")), notices.join(" | "));
  const early = notifications(client.records.slice(mark) as Record<string, unknown>[]);
  assert.ok(early.some((message) => message.includes("Goal paused: Auto-continuation reached the 2-turn limit")), early.join(" | "));
  assert.ok(!hasHan(notices.join("\n").replace("额度目标", "")), notices.join(" | "));
});

test("actual Pi explicit config language overrides the English environment after reload", { timeout: 30000 }, async () => {
  const client = await start();
  const english = (await client.send("get_commands")).data as { commands: { name: string; description: string }[] };
  assert.match(english.commands.find((command) => command.name === "todos")!.description, /Current Todos/);

  await client.prompt("begin english config");
  const directory = join(client.root, "agent", "pi-dag-workflow");
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "pi-dag-workflow-config.json"), JSON.stringify({ language: "zh-CN" }));
  await client.prompt("/test-reload");
  const chinese = (await client.send("get_commands")).data as { commands: { name: string; description: string }[] };
  assert.equal(chinese.commands.find((command) => command.name === "todos")!.description, "当前 Todos：查看、编辑与视图切换；也可直接描述需求");
  const help = notifications(await client.prompt("/todos help"));
  assert.ok(help.some((message) => message.includes("查看完整图")), help.join(" | "));
  const created = results(await client.prompt('TEST CALL todo {"action":"create","subject":"任务"}'), 'todo');
  assert.equal(created[0]!.text, '已创建 #1：任务 [待执行]');
  assert.match(results(await client.prompt('TEST CALL todo {"action":"list"}'), 'todo')[0]!.text, /#1 \[待执行\] 任务/);
});
}
