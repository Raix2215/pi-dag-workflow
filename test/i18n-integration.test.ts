import assert from "node:assert/strict";
import { access, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { IsolatedClient } from "./fixtures/isolated-client.ts";
import { GOAL_TYPE, type GoalState } from "../src/goal/state.ts";

const controls = fileURLToPath(new URL("./fixtures/session-controls.ts", import.meta.url));
const hasHan = (text: string): boolean => /\p{Script=Han}/u.test(text);
/** English session must opt in through the terminal language; no personal config is read. */
const start = (root?: string, session = "i18n-en") => IsolatedClient.start(root, session, [controls], [], false, undefined, "en");

const notifications = (events: Record<string, unknown>[]): string[] =>
  events.filter((event) => event.method === "notify").map((event) => String(event.message));
const results = (events: Record<string, unknown>[], toolName: string): { text: string; isError: boolean }[] =>
  events.filter((event) => event.type === "tool_execution_end" && event.toolName === toolName).map((event) => {
    const result = event.result as { isError?: boolean; content: { type: string; text?: string }[] };
    return { text: result.content.filter((part) => part.type === "text").map((part) => part.text ?? "").join("\n"), isError: event.isError === true || result.isError === true };
  });
const goalState = (entries: unknown[]): GoalState | undefined =>
  (entries as { customType?: string; data?: GoalState }[]).findLast((entry) => entry.customType === GOAL_TYPE)?.data;

test("actual Pi English session advertises English commands, help and goal-reset confirmation", { timeout: 30000 }, async (t) => {
  const client = await start(undefined, "i18n-metadata");
  t.after(() => client.close());
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

test("actual Pi English Todo dependency rejection and Plan write block stay localized", { timeout: 30000 }, async (t) => {
  const client = await start(undefined, "i18n-rejections");
  t.after(() => client.close());
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

test("actual Pi English independent Goal: continuation, untranslated description, budget and reason", { timeout: 40000 }, async (t) => {
  const client = await start(undefined, "i18n-goal");
  t.after(() => client.close());
  await client.prompt("begin english goal");
  const created = results(await client.prompt('TEST CALL goal {"action":"create","title":"预算目标","description":"完整描述不要翻译","maxTurns":2}'), "goal");
  assert.equal(created[0]!.text, "Goal #1 create: 预算目标");
  await client.prompt('TEST CALL goal {"action":"enable","id":1}');
  await client.until(() => {
    const records = client.records as { type?: string; entry?: { customType?: string; data?: GoalState } }[];
    const latest = records.filter((record) => record.type === "entry_appended" && record.entry?.customType === GOAL_TYPE).at(-1)?.entry?.data;
    const continuations = records.filter((record) => record.entry?.customType === "pi-dag-workflow.goal-continue").length;
    return latest?.run.paused === true && latest.run.used >= 1 && continuations >= 1;
  });

  const entries = await client.entries();
  const continuations = (entries as { customType?: string; content?: string }[])
    .filter((entry) => entry.customType === "pi-dag-workflow.goal-continue")
    .map((entry) => String(entry.content));
  assert.equal(continuations.length, 2);
  assert.match(continuations[1]!, /Review Goal #1.*goal get/);
  assert.ok(!hasHan(continuations[1]!));
  assert.match(continuations[0]!, /^Goal #1 1\/2: Advance goal: 预算目标\./);
  assert.match(continuations[0]!, /Requirements: 完整描述不要翻译; full requirements via goal get\./);
  assert.match(continuations[0]!, /This is a workflow continuation, not new user authorization\./);
  assert.ok(!hasHan(continuations[0]!.replace("预算目标", "").replace("完整描述不要翻译", "")), continuations[0]!);

  const state = goalState(entries)!;
  assert.equal(state.run.paused, true);
  assert.equal(state.run.used, 2);
  assert.equal(state.run.reason, "Auto-continuation reached the 2-turn limit");
  assert.equal(state.goals[0]!.title, "预算目标");
  assert.equal(state.goals[0]!.description, "完整描述不要翻译");

  const listing = notifications(await client.prompt("/goal list"));
  assert.ok(listing.some((message) => message.includes("Continuation 2/2 · Auto-continuation reached the 2-turn limit")), listing.join(" | "));
  assert.ok(listing.some((message) => message.includes("预算目标")), listing.join(" | "));
  assert.ok(!hasHan(listing.join("\n").replace("预算目标", "")), listing.join(" | "));
});

test("actual Pi English Goal with a Todo reaches the turn budget and reports it in English", { timeout: 40000 }, async (t) => {
  const client = await start(undefined, "i18n-budget");
  t.after(() => client.close());
  await client.prompt("begin english budget");
  await client.prompt('TEST CALL todo {"action":"create","subject":"entry"}');
  await client.prompt('TEST CALL goal {"action":"create","title":"额度目标","maxTurns":2}');
  await client.prompt('TEST CALL goal {"action":"enable","id":1}');
  await client.until(() => {
    const records = client.records as { type?: string; entry?: { customType?: string; data?: GoalState } }[];
    const latest = records.filter((record) => record.type === "entry_appended" && record.entry?.customType === GOAL_TYPE).at(-1)?.entry?.data;
    const continuations = records.filter((record) => record.entry?.customType === "pi-dag-workflow.goal-continue").length;
    return latest?.run.paused === true && latest.run.used >= 2 && continuations >= 2;
  });

  const state = goalState(await client.entries())!;
  assert.equal(state.run.used, 2);
  assert.equal(state.run.reason, "Auto-continuation reached the 2-turn limit");
  const notices = notifications(await client.prompt("/goal list"));
  assert.ok(notices.some((message) => message.includes("Auto-continuation reached the 2-turn limit")), notices.join(" | "));
  const early = notifications(client.records as Record<string, unknown>[]);
  assert.ok(early.some((message) => message.includes("Goal paused: Auto-continuation reached the 2-turn limit")), early.join(" | "));
  assert.ok(!hasHan(notices.join("\n").replace("额度目标", "")), notices.join(" | "));
});

test("actual Pi explicit config language overrides the English environment after reload", { timeout: 30000 }, async (t) => {
  const client = await start(undefined, "i18n-config");
  t.after(() => client.close());
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
  assert.ok(help.some((message) => message.includes("查看实线图")), help.join(" | "));
});
