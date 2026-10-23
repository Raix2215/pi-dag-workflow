import { FEATURE_NAMES, GOAL_TYPE, STATE_TYPE, type WorkflowState, PLAN_TYPE, type PlanState, GOAL_CHECKPOINT_TYPE, emptyState, AGENTS_TYPE, emptyGoalState, type Todo, AGENTS_ENTRY_TYPE } from './fixtures/public-records.ts';
import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { IsolatedClient } from "./fixtures/isolated-client.ts";
import { loadPublic, recordPanels } from './fixtures/public-host.ts';

import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { access } from "node:fs/promises";
import { stripTerminalSequences } from "@earendil-works/pi-tui";



import { retainedJobs } from './fixtures/public-records.ts';
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { DefaultResourceLoader, SettingsManager } from "@earendil-works/pi-coding-agent";
import { readFileSync } from "node:fs";
import todos from "../src/todos/index.ts";
import plan from "../src/plan/index.ts";
import agents from "../src/agents/index.ts";
import goal from "../src/goal/index.ts";
import retry from "../src/retry/index.ts";
import { rm, open, rename } from "node:fs/promises";
import { GOAL_CONTINUE_MESSAGE } from './fixtures/public-records.ts';






{
function latestState(entries: unknown[]): WorkflowState | undefined {
  return entries.map((entry) => entry as { type?: string; customType?: string; data?: WorkflowState }).findLast((entry) => entry.type === "custom" && entry.customType === STATE_TYPE)?.data;
}
function latestPlan(entries: unknown[]): PlanState | undefined {
  return entries.map((entry) => entry as { type?: string; customType?: string; data?: PlanState }).findLast((entry) => entry.type === "custom" && entry.customType === PLAN_TYPE)?.data;
}
function resultText(events: Record<string, unknown>[]): string {
  return events.filter((event) => event.type === "tool_execution_end").map((event) => JSON.stringify(event.result)).join("\n");
}

test("actual Pi RPC uses only the new plugin, executes Todo tools and keeps UI state out of model messages", { timeout: 30000 }, async (t) => {
  const client = await IsolatedClient.start();
  t.after(() => client.close());
  const commands = (await client.send("get_commands")).data as { commands: { name: string }[] };
  assert.deepEqual(commands.commands.map((item) => item.name).sort(), ["agents", "dag", "dag-display", "goal", "plan", "retry", "todos"]);
  const events = await client.prompt("帮我创建两件待办：检查入口，然后汇总结果，第二件依赖第一件。");
  assert.equal(events.filter((event) => event.type === "tool_execution_end").length, 2);
  assert.doesNotMatch(resultText(events), /错误/);
  const snapshot = latestState(await client.entries())!;
  assert.equal(snapshot.tasks.length, 2);
  assert.deepEqual(snapshot.tasks[1]!.blockedBy, [1]);
  assert.equal(snapshot.nextId, 3);
  const messages = (await client.send("get_messages")).data as { messages: { role: string; content: unknown }[] };
  assert.ok(!messages.messages.some((message) => message.role === "custom" && JSON.stringify(message.content).includes("Todos")));
  assert.ok(events.some((event) => event.type === "extension_ui_request" && event.method === "setWidget"));
});

test("real tool calls cannot bypass Plan, dependencies or ! shell; rejected operations do not corrupt progress", { timeout: 30000 }, async (t) => {
  const client = await IsolatedClient.start();
  t.after(() => client.close());
  await client.prompt("帮我创建两件待办：检查入口，然后汇总结果，第二件依赖第一件。");
  let events = await client.prompt('TEST CALL todo {"action":"update","id":2,"status":"completed"}');
  assert.match(resultText(events), /前置未完成/);
  await client.prompt("/plan start");
  assert.equal(latestPlan(await client.entries())!.enabled, true);
  events = await client.prompt("请把第一项标为完成");
  assert.match(resultText(events), /Plan/);
  assert.equal(latestState(await client.entries())!.tasks[0]!.status, "pending");
  events = await client.prompt("请写入测试文件");
  assert.match(resultText(events), /Plan/);
  await assert.rejects(access(join(client.root, "should-not-exist.txt")));
  const bash = await client.send("bash", { command: "touch forbidden-shell.txt" });
  assert.match(JSON.stringify(bash.data), /Plan/);
  await assert.rejects(access(join(client.root, "forbidden-shell.txt")));
  await client.prompt('TEST CALL todo {"action":"update","id":2,"subject":"规划后的整合"}');
  assert.equal(latestState(await client.entries())!.tasks[1]!.subject, "规划后的整合");
  await client.prompt("/plan off");
  events = await client.prompt("请把第一项标为完成");
  assert.doesNotMatch(resultText(events), /错误/);
  assert.equal(latestState(await client.entries())!.tasks[0]!.status, "completed");
});

test("commands and tools share one state; reload and restart restore it without running a model", { timeout: 40000 }, async (t) => {
  let client = await IsolatedClient.start();
  t.after(() => client.close());
  await client.prompt("/todos add 检查入口");
  assert.match(JSON.stringify(client.records), /尚未创建会话文件/);
  await client.prompt("开始离线验收，让 Pi 保存这次会话");
  await client.prompt("/todos add 汇总结果 --after 1");
  await client.prompt("/plan start");
  const before = latestState(await client.entries())!;
  assert.equal(before.tasks.length, 2);
  assert.equal(latestPlan(await client.entries())!.enabled, true);
  const root = client.root;
  await client.close(false);
  client = await IsolatedClient.start(root);
  assert.equal(client.records.some((event) => event.type === "agent_start"), false);
  const notifications = JSON.stringify(client.records);
  assert.match(notifications, /Plan/);
  const after = latestState(await client.entries())!;
  assert.deepEqual(after, before);
  assert.equal(latestPlan(await client.entries())!.enabled, true, "Plan state persists across restart");
  await client.prompt("/plan off");
  await client.prompt('TEST CALL todo {"action":"list"}');
  assert.equal(latestState(await client.entries())!.tasks.length, 2);
  await client.prompt("/todos start #2");
  assert.equal(latestState(await client.entries())!.tasks[1]!.status, "pending");
  const persisted = (await client.send("get_state")).data as { sessionFile: string };
  const ledger = await readFile(persisted.sessionFile, "utf8");
  assert.match(ledger, /pi-dag-workflow.state/);
  assert.doesNotMatch(ledger, /sqlite|approved_to_run|todo_graphs/);
});

test("actual Pi branch navigation and extension reload reconstruct only the selected branch", { timeout: 30000 }, async (t) => {
  const helper = fileURLToPath(new URL("./fixtures/session-controls.ts", import.meta.url));
  const client = await IsolatedClient.start(undefined, "m1-branch", [helper]);
  t.after(() => client.close());
  await client.prompt("开始离线分支验收");
  await client.prompt("/todos add 原分支 A");
  const first = (await client.entries()).map((entry) => entry as { id: string; customType?: string }).findLast((entry) => entry.customType === STATE_TYPE)!;
  await client.prompt("/todos add 应离开的 B");
  await client.prompt("/plan start");
  const switched = await client.prompt(`/test-tree ${first.id}`);
  assert.ok(!switched.some((event) => event.type === "agent_start"));
  const listed = await client.prompt('TEST CALL todo {"action":"list"}');
  const result = listed.find((event) => event.type === "tool_execution_end")!.result as { details: { tasks: { subject: string }[] } };
  assert.deepEqual(result.details.tasks.map((task) => task.subject), ["原分支 A"]);
  assert.doesNotMatch(JSON.stringify(switched), /Plan.*只读/);
  await client.prompt("/todos add 新分支 C");
  const reload = await client.prompt("/test-reload");
  assert.ok(!reload.some((event) => event.type === "agent_start"));
  const afterReload = await client.prompt('TEST CALL todo {"action":"list"}');
  const restored = afterReload.find((event) => event.type === "tool_execution_end")!.result as { details: { tasks: { subject: string }[] } };
  assert.deepEqual(restored.details.tasks.map((task) => task.subject), ["原分支 A", "新分支 C"]);
});

test("extra read-only search tools require explicit user configuration", { timeout: 30000 }, async (t) => {
  const helper = fileURLToPath(new URL("./fixtures/session-controls.ts", import.meta.url));
  const client = await IsolatedClient.start(undefined, "m1-search", [helper]);
  t.after(() => client.close());
  await client.prompt("/plan start");
  assert.match(resultText(await client.prompt('TEST CALL test_search {"query":"case"}')), /Plan/);
  await client.prompt("/plan off");
  await client.prompt("/plan tools test_search");
  await client.prompt("/plan start");
  assert.match(resultText(await client.prompt('TEST CALL test_search {"query":"case"}')), /offline search: case/);
  await client.prompt("/plan off");
  await client.prompt("/plan tools write");
  assert.deepEqual(latestPlan(await client.entries())!.tools, ["test_search"]);
});

test("corrupt native state stays protected until an explicit confirmed reset, without deleting its history", { timeout: 30000 }, async (t) => {
  const helper = fileURLToPath(new URL("./fixtures/session-controls.ts", import.meta.url));
  const client = await IsolatedClient.start(undefined, "m1-corrupt", [helper]);
  t.after(() => client.close());
  await client.prompt("开始状态保护验收");
  await client.prompt("/todos add 必须保留的历史");
  await client.prompt("/test-corrupt");
  await client.prompt("/test-reload");
  const blocked = await client.prompt('TEST CALL todo {"action":"create","subject":"不应创建"}');
  assert.match(resultText(blocked), /状态恢复失败/);
  const start = client.records.length;
  const clearing = client.prompt("/todos clear all");
  await client.until(() => client.records.slice(start).some((event) => event.type === "extension_ui_request" && event.method === "confirm"));
  const question = client.records.slice(start).find((event) => event.type === "extension_ui_request" && event.method === "confirm")!;
  client.child.stdin.write(`${JSON.stringify({ type: "extension_ui_response", id: question.id, confirmed: true })}\n`);
  await clearing;
  const entries = await client.entries();
  assert.deepEqual(latestState(entries)!.tasks, []);
  assert.ok(JSON.stringify(entries).includes("必须保留的历史"));
  assert.ok(JSON.stringify(entries).includes('"version":99'));
  await client.prompt("/todos add 重置后的工作");
  assert.equal(latestState(await client.entries())!.tasks[0]!.subject, "重置后的工作");
});

test("actual Pi widget switches path/flat trees, keeps the Plan block conditional and restores the chosen style", { timeout: 30000 }, async (t) => {
  let client = await IsolatedClient.start(undefined, "m1-tree-ui");
  t.after(() => client.close());
  await client.prompt("开始离线任务树界面验收");
  await client.prompt("/todos add 读取入口");
  await client.prompt("/todos add 研究兼容 --after 1");
  await client.prompt("/todos add 实现 --after 1");
  await client.prompt("/todos add 写测试 --after 2,3");
  const widget = (): string => {
    const record = client.records.findLast((event) => event.type === "extension_ui_request" && event.method === "setWidget" && Array.isArray(event.widgetLines))!;
    return (record.widgetLines as string[]).map(stripTerminalSequences).join("\n");
  };
  assert.match(widget(), /● 󰉹 Todos \(0\/4\)/);
  assert.match(widget(), /      └─ #4<-#2/);
  assert.doesNotMatch(widget(), /Plan|Goal|#2<-#1/);
  await client.prompt("/todos flat");
  assert.match(widget(), /└─ #4<-#2,#3/);
  assert.doesNotMatch(widget(), /│  /);
  await client.prompt("/plan start");
  assert.match(widget(), / · 󰏫 Plan \[只读\]/);
  const before = latestState(await client.entries())!;
  assert.equal(before.treeStyle, "flat");
  await client.close(false);
  client = await IsolatedClient.start(client.root, "m1-tree-ui");
  assert.equal(latestState(await client.entries())!.treeStyle, "flat");
  assert.match(widget(), /#4<-#2,#3/);
  assert.ok(!client.records.some((event) => event.type === "agent_start"));
  await client.prompt("/todos paths");
  assert.match(widget(), /#4<-#2(?![,0-9])/);
  assert.doesNotMatch(widget(), /#4<-#2,#3/);
});
}

{
const offline = fileURLToPath(new URL('./fixtures/offline-model.ts', import.meta.url));
async function start() {
  const root = await mkdtemp(join(tmpdir(), 'dag-release-audit-'));
  const folder = join(root, 'agent', 'pi-dag-workflow');
  await mkdir(folder, { recursive: true });
  await writeFile(join(folder, 'pi-dag-workflow-preset.json'), JSON.stringify({ presets: [
    { name: 'flow', steps: [{ key: 'first', subject: 'First' }, { key: 'last', subject: 'Last', after: ['first'] }] },
    { name: 'vars', steps: [{ key: 'one', subject: '{__proto__}' }] },
  ] }));
  return IsolatedClient.start(root, 'release-audit', [], ['--dag-workflow-test-child-provider', offline], false, undefined, 'en');
}
async function call(client: IsolatedClient, tool: string, params: object) {
  const events = await client.prompt(`TEST CALL ${tool} ${JSON.stringify(params)}`);
  const event = events.find((item) => item.type === 'tool_execution_end' && item.toolName === tool)!;
  assert.ok(event, `${tool} must have executed`);
  return { ...event.result as any, isError: event.isError === true || (event.result as any)?.isError === true };
}
const state = async (client: IsolatedClient) => (await client.entries() as any[]).findLast((entry) => entry.customType === STATE_TYPE)?.data;

test('actual Pi: whole-run and step resets guard every active child in the downstream closure', { timeout: 60000 }, async (t) => {
  const client = await start(); t.after(() => client.close());
  await call(client, 'todo', { action: 'apply', preset: 'flow' });
  for (const id of [1, 2]) await call(client, 'todo', { action: 'update', id, status: 'completed' });
  await call(client, 'todo', { action: 'create', subject: 'External successor', blockedBy: [2] });
  const job = await call(client, 'subagent_spawn', { todoId: 3, task: 'TEST CALL subagent_send {"message":"Keep waiting","question":true}' });
  assert.equal(job.isError, false);
  assert.equal((await call(client, 'subagent_inspect', { jobId: job.details.jobId, output: true, timeout: 10 })).details.status, 'waiting');
  for (const step of [undefined, 'first']) {
    const result = await call(client, 'todo', { action: 'reset', preset: 'flow', ...(step ? { step } : {}) });
    assert.equal(result.isError, true);
    assert.match(JSON.stringify(result.content), /active|running|report/i);
    assert.deepEqual((await state(client)).tasks.map((task: any) => task.status), ['completed', 'completed', 'in_progress']);
  }
  await call(client, 'subagent_cancel', { jobId: job.details.jobId });
  assert.equal((await call(client, 'todo', { action: 'reset', preset: 'flow' })).isError, false);
  assert.deepEqual((await state(client)).tasks.map((task: any) => task.status), ['pending', 'pending', 'pending']);
  // The same guard protects a child bound directly to the selected fragment.
  await call(client, 'todo', { action: 'update', id: 1, status: 'completed' });
  const bound = await call(client, 'subagent_spawn', { todoId: 2, task: 'TEST CALL subagent_send {"message":"Keep waiting","question":true}' });
  await call(client, 'subagent_inspect', { jobId: bound.details.jobId, output: true, timeout: 10 });
  assert.equal((await call(client, 'todo', { action: 'reset', preset: 'flow', step: 'last' })).isError, true);
  await call(client, 'subagent_cancel', { jobId: bound.details.jobId });
});

test('actual Pi: Plan tool/command paths agree and prototype-shaped CLI variables are ordinary data', { timeout: 30000 }, async (t) => {
  const client = await start(); t.after(() => client.close());
  await client.prompt('/plan start');
  assert.equal((await call(client, 'todo', { action: 'apply', preset: 'flow' })).isError, false);
  assert.equal((await call(client, 'todo', { action: 'list', status: 'completed' })).isError, false);
  assert.equal((await call(client, 'todo', { action: 'update', id: 1, status: 'in_progress' })).isError, true);
  assert.equal((await call(client, 'todo', { action: 'reset', preset: 'flow' })).isError, false);
  const before = JSON.stringify(await state(client));
  await client.prompt('/todos reset flow first extra');
  assert.equal(JSON.stringify(await state(client)), before, 'extra reset arguments cannot silently mutate the list');
  await client.prompt('/todos apply vars __proto__=supplied');
  assert.equal((await state(client)).tasks.at(-1).subject, 'supplied');
  assert.equal((await call(client, 'write', { path: 'blocked.txt', content: 'no' })).isError, true);
});

test('actual Pi: saving a profile preserves external file edits and safely displays instructions', { timeout: 30000 }, async (t) => {
  const client = await start(); t.after(() => client.close());
  await client.prompt('/agents profile original dag-test/scripted off read');
  const path = join(client.root, 'agent', 'pi-dag-workflow', 'pi-dag-workflow-profile.json');
  const config = JSON.parse(await readFile(path, 'utf8'));
  config.profiles.push({ name: 'external', instructions: 'Guidance\u202e' });
  await writeFile(path, JSON.stringify(config));
  await client.prompt('/agents profile added dag-test/scripted off read');
  const saved = JSON.parse(await readFile(path, 'utf8'));
  assert.deepEqual(saved.profiles.map((profile: any) => profile.name), ['original', 'external', 'added']);
  const mark = client.records.length;
  await client.prompt('/agents profiles');
  const note = client.records.slice(mark).find((record) => record.method === 'notify')!;
  assert.ok(note, 'profile listing is a readable notification, not a management menu');
  assert.doesNotMatch(String(note.message), /\u202e/);
  assert.match(String(note.message), /external/);
});

test('notifications strip terminal controls while keeping intended lines and stored user content', { timeout: 30000 }, async (t) => {
  const client = await start(); t.after(() => client.close());
  const title = 'Goal\u001b[31mred\u001b[0m\u202e';
  await call(client, 'goal', { action: 'create', title });
  const mark = client.records.length;
  await client.prompt('/goal get #1');
  const note = client.records.slice(mark).find((record) => record.method === 'notify')!;
  assert.doesNotMatch(String(note.message), /\u001b|\u202e/);
  assert.match(String(note.message), /Goalred/);
  const goal = await call(client, 'goal', { action: 'get', id: 1 });
  assert.equal(JSON.parse(goal.content[0].text).goal.title, title, 'display sanitization must not change canonical user data');
  const multiline = '  one\n    two';
  await call(client, 'goal', { action: 'create', title: multiline });
  const nextMark = client.records.length;
  await client.prompt('/goal get #2');
  const nextNote = client.records.slice(nextMark).find((record) => record.method === 'notify')!;
  assert.match(String(nextNote.message), /one     two/, 'public Goal notification flattens the line break while preserving indentation');
  assert.equal((await client.entries() as any[]).findLast((entry) => entry.customType === GOAL_TYPE).data.goals[1].title, multiline.trim(), 'the Goal tool trims outer whitespace but retains interior line breaks');
});
}

{
const offline = fileURLToPath(new URL('./fixtures/offline-model.ts', import.meta.url));
const tools = async (client: IsolatedClient, name: string, params: object) => {
  const result = await client.prompt(`TEST CALL ${name} ${JSON.stringify(params)}`);
  return result.find((event) => event.type === 'tool_execution_end' && event.toolName === name)!;
};
const notifications = (records: any[]) => records.filter((record) => record.method === 'notify').map((record) => String(record.message)).join('\n');

async function answer(client: IsolatedClient, record: any, value: string | boolean) {
  client.child.stdin.write(`${JSON.stringify({ type: 'extension_ui_response', id: record.id, ...(typeof value === 'boolean' ? { confirmed: value } : { value }) })}\n`);
}

test('real Pi: list/dag commands persist filters only for previews and full views do not truncate', { timeout: 30000 }, async (t) => {
  const client = await IsolatedClient.start(); t.after(() => client.close());
  for (let id = 1; id <= 12; id++) {
    await tools(client, 'todo', { action: 'create', subject: `row-${id}` });
    await tools(client, 'todo', { action: 'update', id, status: 'completed' });
  }
  await tools(client, 'todo', { action: 'create', subject: 'failed-row' });
  await client.prompt('/todos failed #13');
  await client.prompt('/todos view dag completed');
  let state = (await client.entries() as any[]).findLast((entry) => entry.customType === STATE_TYPE).data;
  assert.equal(state.view, 'dag'); assert.equal(state.filter, 'completed');
  const full = notifications(await client.prompt('/todos list completed'));
  assert.ok(full.includes('#1 ') && full.includes('#12 ')); assert.doesNotMatch(full, /隐藏 \d+ 项/);
  const failed = notifications(await client.prompt('/dag failed'));
  assert.match(failed, /failed-row/); assert.doesNotMatch(failed, /row-12/);
  state = (await client.entries() as any[]).findLast((entry) => entry.customType === STATE_TYPE).data;
  assert.equal(state.filter, 'completed', 'one-off full views never change the preview filter');
  const before = JSON.stringify(state);
  await client.prompt('/todos view dag invalid'); await client.prompt('/dag failed extra');
  assert.equal(JSON.stringify((await client.entries() as any[]).findLast((entry) => entry.customType === STATE_TYPE).data), before);
});

test('real Pi: cleanup menus do not pause, wake or refill an active Goal and do not stop its child', { timeout: 30000 }, async (t) => {
  const client = await IsolatedClient.start(undefined, 'cleanup-menu-goal', [], ['--dag-workflow-test-child-provider', offline]);
  t.after(() => client.close());
  await tools(client, 'todo', { action: 'create', subject: 'finished history' });
  await tools(client, 'todo', { action: 'update', id: 1, status: 'completed' });
  await tools(client, 'goal', { action: 'create', title: '空闲续跑测试', maxTurns: 6 });
  await client.prompt('/goal enable #1');
  await client.until(() => client.records.filter((record) => record.type === 'agent_settled').length >= 4);
  const before = (await client.entries() as any[]).findLast((entry) => entry.customType === GOAL_TYPE).data;
  assert.equal(before.run.paused, false);
  const offset = client.records.length;
  const clearing = client.prompt('/todos clear');
  await client.until(() => client.records.slice(offset).some((record) => record.method === 'select'));
  const menu = client.records.slice(offset).find((record) => record.method === 'select')!;
  await answer(client, menu, (menu.options as string[])[0]!);
  await client.until(() => client.records.slice(offset).some((record) => record.method === 'confirm'));
  const confirm = client.records.slice(offset).find((record) => record.method === 'confirm')!;
  await answer(client, confirm, true); await clearing;
  const entries = await client.entries() as any[];
  const after = entries.findLast((entry) => entry.customType === GOAL_TYPE).data;
  assert.deepEqual(after.run, before.run);
  assert.equal(entries.findLast((entry) => entry.customType === STATE_TYPE).data.tasks.length, 0);
  assert.equal(client.records.slice(offset).some((record) => record.type === 'agent_start'), false);
  // The journal is append-only deltas: fold the branch instead of assuming the last entry is a full snapshot.
  assert.ok(retainedJobs(entries).records.some((job) => job.status === 'running'), `expected a running child, got ${JSON.stringify(retainedJobs(entries).records.map((job) => [job.id, job.status]))}`);
  assert.ok(entries.some((entry) => entry.customType === AGENTS_ENTRY_TYPE));
});

test('real Pi: inspect discovers profile summaries only on demand and explicit true retains instructions', { timeout: 30000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dag-inspection-profile-'));
  await mkdir(join(root, 'agent', 'pi-dag-workflow'), { recursive: true });
  await writeFile(join(root, 'agent', 'pi-dag-workflow', 'pi-dag-workflow-profile.json'), JSON.stringify({ profiles: [{ name: 'probe', thinking: 'off', tools: ['read'], instructions: 'PROFILE-LONG-INSTRUCTIONS '.repeat(30) }] }));
  const client = await IsolatedClient.start(root, 'inspection-profile', [], ['--dag-workflow-test-child-provider', offline]); t.after(() => client.close());
  const ordinary = (await tools(client, 'subagent_inspect', {})).result as any;
  assert.equal(ordinary.details.profiles, undefined);
  const short = (await tools(client, 'subagent_inspect', { profiles: 'summary' })).result as any;
  assert.equal(short.details.profiles[0].name, 'probe'); assert.equal(short.details.profiles[0].instructions, undefined);
  assert.equal(short.details.profilePath, undefined);
  const full = (await tools(client, 'subagent_inspect', { profiles: true })).result as any;
  assert.match(full.details.profiles[0].instructions, /PROFILE-LONG-INSTRUCTIONS/);
  const spawned = (await tools(client, 'subagent_spawn', { task: 'HOLD-IDLE-ENABLE-CHILD' })).result as any;
  const info = (await tools(client, 'subagent_inspect', { jobId: spawned.details.jobId })).result as any;
  assert.equal(info.details.profiles, undefined); assert.ok(info.details.jobs[0].lastEventAt > 0);
  assert.ok(info.details.jobs[0].reportVersion >= 0); assert.equal(typeof info.details.jobs[0].hasOutput, 'boolean');
});
}

{
const text = (message: any) => typeof message.content === 'string' ? message.content : (message.content ?? []).filter((part: any) => part.type === 'text').map((part: any) => part.text).join('\n');
const exportsOf = (entries: any[]) => entries.filter((entry) => entry.customType === 'dag-test.context-export').map((entry) => entry.data.context.messages);
const systems = (messages: any[]) => messages.filter((message) => message.role === 'system').map(({ timestamp: _timestamp, ...message }) => message);

test('actual Pi: mode changes use passive messages and leave the native system prompt/loadout stable', { timeout: 30000 }, async (t) => {
  const client = await IsolatedClient.start(undefined, 'stable-mode-guidance', [], ['--dag-test-context-export']); t.after(() => client.close());
  await client.prompt('stable Normal one');
  await client.prompt('stable Normal two');
  await client.prompt('/plan start'); await client.prompt('read-only request');
  await client.prompt('/plan off'); await client.prompt('Normal request again');
  const entries = await client.entries() as any[];
  const calls = exportsOf(entries);
  assert.equal(calls.length, 4, 'mode notices themselves never request a model turn');
  for (const call of calls) {
    assert.deepEqual(systems(call), systems(calls[0]!));
    assert.ok(systems(call).every((message) => !Object.keys(message.sections ?? {}).some((key) => key.startsWith('dag_workflow'))));
  }
  const notices = entries.filter((entry) => entry.customType === 'pi-dag-workflow.guidance');
  assert.equal(notices.length, 2);
  assert.match(notices[0].content, /Plan:.*Goal is paused/);
  assert.match(notices[1].content, /Normal:.*Goal stays paused until explicitly enabled/);
  assert.ok(calls[2]!.some((message: any) => text(message) === notices[0].content));
  assert.ok(calls[3]!.some((message: any) => text(message) === notices[1].content));
});

test('actual Pi: progress updates do not repeat full Goal rules; definition and policy changes do', { timeout: 30000 }, async (t) => {
  const offline = new URL('./fixtures/offline-model.ts', import.meta.url).pathname;
  const client = await IsolatedClient.start(undefined, 'stable-goal-contract', [], ['--dag-test-context-export', '--dag-workflow-test-child-provider', offline]); t.after(() => client.close());
  await client.prompt('TEST CALL subagent_spawn {"task":"HOLD-IDLE-ENABLE-CHILD"}');
  const records = await client.prompt('TEST CALL goal {"action":"create","title":"persistent objective","description":"ORIGINAL-TAIL","maxTurns":6}');
  assert.ok(records.some((record) => record.type === 'tool_execution_end' && record.toolName === 'goal'));
  await client.prompt('/goal enable #1');
  const contracts = async () => (await client.entries() as any[]).filter((entry) => entry.customType === GOAL_CHECKPOINT_TYPE && entry.content.startsWith('Goal contract ('));
  const before = await contracts(); assert.equal(before.length, 1);
  for (let index = 1; index <= 3; index++) await client.prompt(`TEST CALL goal ${JSON.stringify({ action: 'update', progress: `verified evidence ${index}` })}`);
  assert.equal((await contracts()).length, 1, 'ordinary progress has no full-rule churn');
  await client.prompt('TEST CALL goal {"action":"update","description":"NEW-ORIGINAL-TAIL"}');
  assert.equal((await contracts()).length, 2);
  assert.match((await contracts()).at(-1).content, /NEW-ORIGINAL-TAIL/);
  await client.prompt('/goal nopause #1 on');
  assert.equal((await contracts()).length, 2, 'policy command alone does not request a provider turn');
  await client.prompt('inspect current evidence');
  assert.equal((await contracts()).length, 3);
  assert.match((await contracts()).at(-1).content, /"modelPause":"deny"/);
  await client.prompt('/goal disable #1');
});

for (const plan of [true, false]) test(`actual Pi: the first request after native manual compaction knows ${plan ? 'Plan' : 'Normal after Plan'} without a system section`, { timeout: 30000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dag-mode-recovery-'));
  await mkdir(join(root, 'agent'), { recursive: true });
  await writeFile(join(root, 'agent', 'settings.json'), JSON.stringify({ retry: { enabled: false }, compaction: { enabled: false, reserveTokens: 1, keepRecentTokens: 1 } }));
  const client = await IsolatedClient.start(root, 'mode-recovery', [], ['--dag-test-context-export']); t.after(() => client.close());
  await client.prompt('/plan start'); await client.prompt('Plan context');
  if (!plan) { await client.prompt('/plan off'); await client.prompt('Normal context'); }
  await client.send('compact');
  await client.prompt('first recovery request');
  const entries = await client.entries() as any[];
  const at = entries.findLastIndex((entry) => entry.type === 'compaction');
  assert.ok(at >= 0);
  const first = entries.slice(at + 1).find((entry) => entry.customType === 'dag-test.context-export').data.context.messages;
  assert.ok(first.some((message: any) => text(message).startsWith(plan ? 'Plan: read/search/ask' : 'Normal: continue the existing Todo list')));
  assert.ok(first.every((message: any) => !Object.keys(message.sections ?? {}).some((key) => key.startsWith('dag_workflow'))));
});
}

{
const theme = { fg: (_: string, text: string) => text, bold: (text: string) => text, style: (text: string) => text, colors: {}, appearance: 'dark' };
function harness(branch: any[] = []) {
  const tools = new Map(), commands = new Map(), events = new Map<string, Function[]>(), notifications: string[] = [];
  const pi: any = new Proxy({
    on(name: string, fn: Function) { events.set(name, [...events.get(name) ?? [], fn]); },
    registerTool(tool: any) { tools.set(tool.name, tool); },
    registerCommand(name: string, command: any) { commands.set(name, command); },
    appendEntry(customType: string, data: unknown) { branch.push({ type: 'custom', customType, data: structuredClone(data) }); },
    getAllTools: () => [{ name: 'web_search' }, { name: 'other_search' }],
  }, { get(target: any, key: string) { return target[key] ?? (() => undefined); } });
  const ctx: any = {
    mode: 'rpc', cwd: tmpdir(), hasUI: true, isIdle: () => true,
    sessionManager: { getBranch: () => branch, getSessionFile: () => undefined },
    ui: { theme, setWidget() {}, notify(message: string) { notifications.push(message); }, select: async () => undefined,
      custom() { throw new Error('Menus must use native Pi dialogs'); },
    },
  };
  const emit = async (name: string) => { const event = {}; for (const fn of events.get(name) ?? []) await fn(event, ctx); };
  return { pi, ctx, tools, commands, branch, emit, notifications };
}
const tick = () => new Promise(resolve => setTimeout(resolve, 0));

test('Todo-only writes preserve the unselected legacy Plan domain', async () => {
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = join(tmpdir(), 'fixture-nonexistent-agent-directory');
  try {
    const h = harness([{ type: 'custom', customType: STATE_TYPE, data: { ...emptyState(), plan: true, planTools: ['web_search'] } }]);
    await loadPublic(h.pi, ['todos', 'plan'], 'zh-CN'); await h.emit('session_start');
    const planSettings = async () => { await h.commands.get('plan').handler('settings', h.ctx); return h.notifications.at(-1); };
    assert.match((await planSettings())!, /Plan 只读[\s\S]*web_search/);
    assert.equal((await h.tools.get('todo').execute('test', { action: 'create', subject: 'unrelated Todo edit' }, undefined, undefined, h.ctx)).isError, undefined);
    assert.match((await planSettings())!, /Plan 只读[\s\S]*web_search/);
    await h.commands.get('todos').handler('hide', h.ctx);
    assert.match((await planSettings())!, /Plan 只读[\s\S]*web_search/);
    await h.emit('session_shutdown');
  } finally { if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous; }
});

test('protected Todo display commands cannot overwrite damaged records', async () => {
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = join(tmpdir(), 'fixture-nonexistent-agent-directory');
  try {
    const h = harness([{ type: 'custom', customType: STATE_TYPE, data: { ...emptyState(), tasks: 'damaged', plan: true, planTools: ['web_search'] } }]);
    await loadPublic(h.pi, ['todos']); await h.emit('session_start');
    const original = structuredClone(h.branch);
    for (const command of ['hide', 'show', 'paths', 'flat', 'view list']) await h.commands.get('todos').handler(command, h.ctx);
    assert.deepEqual(h.branch, original, 'only an explicit reset may replace protected Todo data');
    assert.equal((await h.tools.get('todo').execute('protected', { action: 'status' }, undefined, undefined, h.ctx)).details.status.protected, true);
    await h.emit('session_shutdown');
  } finally { if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous; }
});

for (const language of ['zh-CN', 'en']) for (const argument of ['', 'full']) test(`DAG ${argument ? 'shortcut output' : 'native reader'} keeps each padded task and its right-aligned status on one body row (${language})`, async () => {
  const previous = process.env.PI_CODING_AGENT_DIR, oldLocale = process.env.LC_ALL, oldCols = process.stdout.columns, oldRows = process.stdout.rows;
  process.env.PI_CODING_AGENT_DIR = join(tmpdir(), 'fixture-nonexistent-agent-directory'); process.env.LC_ALL = language; process.stdout.columns = 80; process.stdout.rows = 42;
  let h: ReturnType<typeof harness> | undefined;
  try {
    const state = { ...emptyState(), nextId: 6, tasks: Array.from({ length: 5 }, (_, i): Todo => ({ id: i + 1, subject: `构建任务 ${i}`, status: 'pending', blockedBy: [] })) };
    h = harness([{ type: 'custom', customType: STATE_TYPE, data: state }]); h.ctx.mode = 'tui';
    let body: string[] = [];
    h.ctx.ui.notify = (message: string) => { body.push(...message.split('\n')); };
    h.ctx.ui.select = async (_title: string, options: string[]) => { body.push(...options); return undefined; };
    const panels = recordPanels(h.ctx);
    await loadPublic(h.pi, ['todos']); await h.emit('session_start');
    const opening = h.commands.get('dag').handler(argument, h.ctx);
    if (!argument) { await panels.wait(() => panels.live() === 1); body.push(...panels.body()); await panels.press('\x1b'); }
    await opening;
    const taskRows = body.filter(line => /#\d+/.test(line));
    assert.equal(taskRows.length, 5, 'every task is present');
    for (const line of taskRows) assert.match(stripTerminalSequences(line), language === 'zh-CN' ? /\[主会话\].*\[待执行\]$/u : /\[Main session\].*\[Pending\]$/u, 'the right-hand status stays on its task row');
  } finally {
    if (h) await h.emit('session_shutdown'); process.stdout.columns = oldCols; process.stdout.rows = oldRows;
    if (oldLocale === undefined) delete process.env.LC_ALL; else process.env.LC_ALL = oldLocale;
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous;
  }
});

test('old Todo completion confirmation cannot accept a concurrently changed requirement', async () => {
  const h = harness(); h.ctx.mode = 'tui';
  await loadPublic(h.pi, ['todos'], 'zh-CN'); await h.emit('session_start');
  const update = (params: object) => h.tools.get('todo').execute('probe', params, undefined, undefined, h.ctx);
  await update({ action: 'create', subject: 'old verified requirement', description: 'old scope' });
  h.ctx.ui.confirm = () => { throw new Error('TUI confirmation must remain inline'); };
  const panels = recordPanels(h.ctx); let step = 0;
  const running = h.commands.get('todos').handler('', h.ctx);
  await panels.select('old verified requirement'); step++;
  await panels.select('核验后完成任务'); step++;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const bounded = new Promise<'timeout'>(resolve => { timer = setTimeout(() => resolve('timeout'), 2000); });
  assert.match(panels.frame().join('\n'), /再次 Enter 确认/); assert.match(panels.frame().join('\n'), /old verified requirement/); assert.equal(step, 2);
  await update({ action: 'update', id: 1, subject: 'new unverified requirement', description: 'new scope' });
  await panels.press('\r'); await tick();
  const saved = (h.branch.findLast((entry: any) => entry.customType === STATE_TYPE) as { data: WorkflowState }).data;
  assert.equal(saved.tasks[0]!.subject, 'new unverified requirement'); assert.equal(saved.tasks[0]!.status, 'pending');
  await panels.press('\x1b'); await panels.press('\x1b');
  const settled = await Promise.race([running.then(() => 'done' as const), bounded]); clearTimeout(timer);
  assert.equal(settled, 'done', 'the tasks menu returns after native selection completes');
});

for (const active of [true, false]) test(`Plan settings is read-only text and ${active ? 'active Plan keeps tool protection' : 'normal mode allows explicit tool choices'}`, async () => {
  const h = harness([{ type: 'custom', customType: STATE_TYPE, data: { ...emptyState(), ...(active ? { plan: true } : {}) } }]);
  const notices = h.notifications;
  await loadPublic(h.pi, ['todos', 'plan'], 'zh-CN');
  await h.emit('session_start');
  const planState = () => h.branch.findLast((entry: any) => entry.customType === PLAN_TYPE)?.data as PlanState | undefined;
  await h.commands.get('plan').handler('settings', h.ctx);
  assert.equal(notices.at(-1)?.includes('模式：Plan 只读'), active, 'settings neither enters nor leaves Plan');
  assert.deepEqual(planState()?.tools ?? [], [], 'settings never edits tools');
  assert.ok(notices.some((message) => message.includes('Plan 设置')), notices.join(' | '));
  if (active) {
    await h.commands.get('plan').handler('tools other_search', h.ctx);
    assert.deepEqual(planState()?.tools ?? [], [], 'Plan refuses tool changes');
  } else {
    await h.commands.get('plan').handler('tools other_search', h.ctx);
    assert.deepEqual(planState()?.tools, ['other_search']);
  }
});

test('ticket04b /todos adds tasks inline, cycles the layout, clears with two Enters and exposes status rows', async () => {
  const h = harness(); h.ctx.mode = 'tui';
  await loadPublic(h.pi, ['todos'], 'zh-CN'); await h.emit('session_start');
  const update = (params: object) => h.tools.get('todo').execute('probe', params, undefined, undefined, h.ctx);
  await update({ action: 'create', subject: 'done task' }); await update({ action: 'update', id: 1, status: 'completed' });
  await update({ action: 'create', subject: 'pending task' }); await update({ action: 'update', id: 2, status: 'in_progress' });
  const saved = () => (h.branch.findLast((entry: any) => entry.customType === STATE_TYPE) as { data: WorkflowState }).data;
  const panels = recordPanels(h.ctx), running = h.commands.get('todos').handler('', h.ctx);
  await panels.wait(() => panels.live() === 1);
  const frame = () => panels.frame().join('\n');
  for (const label of ['新建任务', '树样式', '清理范围', '清理记录']) await panels.focus(label);
  await panels.focus('任务树');
  assert.match(frame(), /> .*任务树 \(\d\)/, 'the task tree has its own collapsible heading');
  await panels.focus('Task 片段');
  assert.match(frame(), /> .*Task 片段 \(\d\)/, 'fragments keep their own collapsible heading');
  await panels.select('树样式'); assert.equal(saved().treeStyle, 'flat', 'the layout cycle switches the tree style');
  await panels.focus('清理范围'); await panels.press('\r'); assert.match(frame(), /已完成／失败／取消/, 'the scope cycle advances');
  await panels.focus('清理记录'); await panels.press('\r'); assert.match(frame(), /再次 Enter 清理/, 'clearing is armed, not executed');
  await panels.press('x'); assert.match(frame(), /清理记录/); assert.equal(saved().tasks.length, 2, 'any other key disarms the clear');
  await panels.press('\r'); await panels.press('\r');
  assert.equal(saved().tasks.filter(task => task.status === 'completed').length, 0, 'the second Enter clears completed records');
  await panels.focus('pending task'); await panels.press('\r');
  for (const label of ['回到待执行', '标记失败', '标记取消']) await panels.focus(label);
  await panels.focus('标记失败'); await panels.press('\r');
  assert.equal(saved().tasks.find(task => task.id === 2)!.status, 'failed', 'the status row moves the task');
  await panels.focus('标记取消'); await panels.press('\r');
  assert.equal(saved().tasks.find(task => task.id === 2)!.status, 'cancelled', 'each status row is wired');
  await panels.press('\x1b'); await panels.press('\x1b'); await running;
});
}
{
test('Pi actual resource loader loads all five public entries without user settings or model calls', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'pi-dag-workflow-load-'));
  try {
    const root = fileURLToPath(new URL('../', import.meta.url));
    const loader = new DefaultResourceLoader({ cwd: temporary, agentDir: join(temporary, 'agent'), settingsManager: SettingsManager.inMemory({}), additionalExtensionPaths: [root], noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true });
    await loader.reload();
    const loaded = loader.getExtensions();
    assert.deepEqual(loaded.errors, []);
    assert.equal(loaded.extensions.length, FEATURE_NAMES.length);
    assert.deepEqual(loaded.extensions.map((item) => item.resolvedPath).sort(), FEATURE_NAMES.map((name) => join(root, `src/${name}/index.ts`)).sort());
    // Team's model surface is two tools: one to inspect, one to send. Lifecycle and the shared task list
    // left the product, so no model-reachable start/stop/leave/task entry exists.
    assert.deepEqual(loaded.extensions.flatMap((item) => [...item.tools.keys()]).sort(), ['todo', 'goal', 'subagent_spawn', 'subagent_inspect', 'subagent_send', 'subagent_cancel', 'team_send', 'team_inspect'].sort());
    assert.deepEqual(loaded.extensions.flatMap((item) => [...item.commands.keys()]).sort(), ['todos', 'dag', 'plan', 'agents', 'goal', 'retry', 'dag-display', 'team'].sort());
    for (const resource of loaded.extensions) for (const tool of resource.tools.values()) {
      assert.equal(tool.definition.namespace?.name, 'pi_dag_workflow');
      assert.ok(tool.definition.namespace?.instructions);
      assert.ok(tool.definition.annotations);
      // Pi lists a tool in the model's Available tools section only with a snippet, and its
      // guidelines land in the Guidelines section while the tool is active.
      assert.ok(tool.definition.promptSnippet, `${tool.definition.name} needs a promptSnippet to appear in <tools>`);
      assert.doesNotMatch(tool.definition.promptSnippet, /[\r\n]/);
      assert.equal(tool.definition.promptSnippet, tool.definition.promptSnippet.trim());
    }
    const definitions = new Map(loaded.extensions.flatMap((item) => [...item.tools.entries()].map(([name, tool]) => [name, tool.definition] as const)));
    assert.doesNotMatch(definitions.get('todo')!.promptSnippet!, /optional/i);
    assert.equal(definitions.get('todo')!.promptGuidelines?.length, 7);
    assert.ok(definitions.get('todo')!.promptGuidelines!.some((rule) => rule.includes('normally update only id/status')));
    assert.ok(definitions.get('todo')!.promptGuidelines!.some((rule) => rule.includes('indispensable prerequisite outputs')), 'the static DAG guidance travels with the tool');
    assert.ok(definitions.get('todo')!.promptGuidelines!.some((rule) => rule.includes('presets')));
    assert.ok(definitions.get('todo')!.promptGuidelines!.some((rule) => rule.includes('workflow checkpoint')));
    assert.equal(definitions.get('subagent_spawn')!.promptGuidelines, undefined, 'behavior is attached to native rules at before_agent_start');
    assert.match(definitions.get('subagent_spawn')!.description, /resumeFrom/);
    assert.ok(definitions.get('subagent_spawn')!.description.length < 420);
    assert.equal(definitions.get('goal')!.promptGuidelines?.length, 3);
    assert.ok(definitions.get('goal')!.promptGuidelines!.some((rule) => rule.includes('not every turn, tool call, wait or Todo update')));
    assert.ok(definitions.get('goal')!.promptGuidelines!.some((rule) => rule.includes('a final answer, failed attempt, uncertainty, or completed Todo list does not stop it')));
    assert.ok(definitions.get('todo')!.promptGuidelines!.some((rule) => rule.includes('blockedBy')));
    // Both surviving Team tools carry the same frozen permission paragraph: the host keeps one copy.
    const permission = definitions.get('team_send')!.promptGuidelines!;
    assert.equal(permission.length, 1, 'one guideline paragraph on team_send');
    assert.deepEqual(definitions.get('team_inspect')!.promptGuidelines, permission, 'and the identical one on team_inspect');
    assert.match(permission[0]!, /user-only|Do not/i);
    assert.match(permission[0]!, /Delivery never enables paused Goals/);
    assert.equal(definitions.get('team_send')!.promptGuidelines!.filter((rule) => /Team Todos|heartbeat/.test(rule)).length, 0, 'no removed-feature wording rides the surviving rule');
    loaded.runtime.invalidate();
  } finally { await rm(temporary, { recursive: true, force: true }); }
});
}

{
function host() {
  const events = new Map<string, Function[]>(), commands = new Map<string, any>(), tools = new Map<string, any>();
  let entries: any[] = []; const notifications: string[] = [];
  const pi: any = { on(n: string, f: Function) { events.set(n, [...events.get(n) ?? [], f]); }, registerTool(t: any) { tools.set(t.name, t); }, registerCommand(n: string, c: any) { commands.set(n, c); }, registerFlag() {}, getFlag() {}, getAllTools: () => [], appendEntry(t: string, d: unknown) { entries.push({ type: 'custom', customType: t, data: d }); }, sendMessage() {}, sendUserMessage() {} };
  const ctx: any = { hasUI: true, cwd: '.', isIdle: () => false, sessionManager: { getBranch: () => entries, getSessionFile: () => '/tmp/d5-flow-mock-session.jsonl' }, modelRegistry: { find: () => undefined }, ui: { notify: (message: string) => notifications.push(message), setWidget() {}, setStatus() {}, confirm: async () => true } };
  const fire = async (n: string, event: any = {}) => { let result: any; for (const f of events.get(n) ?? []) { const next = await f(event, ctx); if (next) { result = { ...result, ...next }; if (next.entries) event.entries = next.entries; if (next.continue !== undefined) event.continue = next.continue; } } return result; };
  return { pi, ctx, commands, tools, notifications, fire, entries: () => entries, setEntries: (next: any[]) => { entries = next; } };
}
const goalRecord = (title: string) => ({ type: 'custom', customType: GOAL_TYPE, data: { ...emptyGoalState(), nextId: 2, goals: [{ id: 1, title, status: 'paused', maxTurns: 32, createdAt: 1 }] } });

test('old Goal reset confirmation cannot clear the newly selected branch', async (t) => {
  const h = host(); await loadPublic(h.pi, ['goal']);
  t.after(() => h.fire('session_shutdown'));
  let answer!: (value: boolean) => void; h.ctx.ui.confirm = () => new Promise<boolean>((resolve) => { answer = resolve; });
  const resetting = h.commands.get('goal').handler('reset', h.ctx);
  h.setEntries([goalRecord('New branch objective')]); await h.fire('session_tree');
  answer(true); await resetting;
  assert.equal(h.entries().findLast((entry) => entry.customType === GOAL_TYPE)?.data.goals[0].title, 'New branch objective');
  h.ctx.ui.confirm = async () => true; await h.commands.get('goal').handler('reset', h.ctx);
  assert.deepEqual(h.entries().findLast((entry) => entry.customType === GOAL_TYPE)?.data.goals, [], 'a current confirmation still resets');
});

test('Goal reset dialogs are invalidated before navigation can change the branch', async (t) => {
  for (const navigation of ['session_before_switch', 'session_before_fork', 'session_before_tree']) {
    const h = host(); await loadPublic(h.pi, ['goal']);
    t.after(() => h.fire('session_shutdown'));
    h.setEntries([goalRecord('Keep objective')]); await h.fire('session_tree');
    let answer!: (value: boolean) => void; h.ctx.ui.confirm = () => new Promise<boolean>((resolve) => { answer = resolve; });
    const reset = h.commands.get('goal').handler('reset', h.ctx); await h.fire(navigation); answer(true); await reset;
    assert.equal(h.entries().findLast((entry) => entry.customType === GOAL_TYPE)?.data.goals[0].title, 'Keep objective', navigation);
  }
});

test('obsolete Goal config restore errors cannot replace newer branch state', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dag-goal-config-race-'));
  const previous = process.env.PI_CODING_AGENT_DIR; process.env.PI_CODING_AGENT_DIR = root;
  const path = join(root, 'pi-dag-workflow', 'pi-dag-workflow-config.json');
  await mkdir(join(root, 'pi-dag-workflow')); await writeFile(path, '{"goalMaxTurns":');
  const handle = await open(path, 'r'); const prototype = Object.getPrototypeOf(handle); await handle.close();
  const originalRead = prototype.read; let release!: () => void; let entered!: () => void;
  const atRead = new Promise<void>((resolve) => { entered = resolve; });
  let first = true; let reads = 0;
  prototype.read = async function (...args: any[]) {
    reads++;
    if (first) { first = false; entered(); await new Promise<void>((resolve) => { release = resolve; }); }
    return originalRead.apply(this, args);
  };
  const h = host(); h.ctx.cwd = root; await loadPublic(h.pi, ['goal']);
  t.after(async () => { prototype.read = originalRead; await h.fire('session_shutdown'); if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous; await rm(root, { recursive: true, force: true }); });
  h.setEntries([goalRecord('Old')]); const old = h.fire('session_tree');
  await atRead;
  await writeFile(`${path}.new`, '{}'); await rename(`${path}.new`, path);
  h.setEntries([goalRecord('New')]); await h.fire('session_tree');
  release(); await old;
  assert.ok(reads >= 2, 'both the superseded file and the current config were read');
  assert.equal(h.entries().findLast((entry) => entry.customType === GOAL_TYPE)?.data.goals[0].title, 'New');
  assert.equal(h.notifications.some((text) => text.includes('配置需为') || text.includes('Unexpected end')), false);
});

test('old Agent reset confirmation cannot clear newly restored job records', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dag-reset-guard-')); const previous = process.env.PI_CODING_AGENT_DIR; process.env.PI_CODING_AGENT_DIR = root;
  const h = host(); h.ctx.cwd = root;
  await loadPublic(h.pi, ['agents']);
  t.after(async () => { await h.fire('session_shutdown'); if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous; await rm(root, { recursive: true, force: true }); });
  await h.fire('session_start'); let answer!: (value: boolean) => void;
  h.ctx.ui.confirm = () => new Promise<boolean>((resolve) => { answer = resolve; }); const resetting = h.commands.get('agents').handler('reset', h.ctx);
  h.setEntries([{ type: 'custom', customType: AGENTS_TYPE, data: { version: 1, nextId: 8, jobs: [{ id: 'a7', profile: 'inherit', model: { provider: 'fixture', id: 'model' }, thinking: 'off', tools: ['read'], status: 'completed', startedAt: 1, endedAt: 2, pendingRequests: 0, output: 'New branch report' }] } }]);
  await h.fire('session_tree'); answer(true); await resetting;
  assert.equal(retainedJobs(h.entries()).records[0]!.id, 'a7');
  h.ctx.ui.confirm = async () => true; await h.commands.get('agents').handler('reset', h.ctx); assert.deepEqual(retainedJobs(h.entries()).records, []);
});

test('obsolete Agent journal imports cannot replace a newer Agent restoration', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dag-restore-guard-')); const previous = process.env.PI_CODING_AGENT_DIR; process.env.PI_CODING_AGENT_DIR = root;
  const h = host(); h.ctx.cwd = root; await loadPublic(h.pi, ['agents']);
  t.after(async () => { await h.fire('session_shutdown'); if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous; await rm(root, { recursive: true, force: true }); });
  const job = (id: string) => ({ type: 'custom', customType: AGENTS_TYPE, data: { version: 1, nextId: Number(id.slice(1)) + 1, jobs: [{ id, profile: 'inherit', model: { provider: 'fixture', id: 'model' }, thinking: 'off', tools: ['read'], status: 'completed', startedAt: 1, endedAt: 2, pendingRequests: 0, output: `${id} report` }] } });
  h.setEntries([job('a1')]); const old = h.fire('session_start');
  h.setEntries([job('a2')]); await h.fire('session_tree');
  await old;
  const result = await h.tools.get('subagent_inspect').execute('probe', { jobId: 'a2' }, undefined, undefined, h.ctx);
  assert.equal(result.isError, undefined, 'current-branch inspect remains available after overlapping restore');
  assert.equal(result.details.jobs[0].id, 'a2', 'the latest branch, not the obsolete restore, owns the visible job');
  assert.deepEqual(retainedJobs(h.entries()).records.map((item) => item.id), ['a2']);
});

test('Profile save limits match load limits and preserve an existing file on rejection', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dag-profile-limits-')); t.after(() => rm(root, { recursive: true, force: true }));
  const folder = join(root, 'agent', 'pi-dag-workflow'); await mkdir(folder, { recursive: true });
  const path = join(folder, 'pi-dag-workflow-profile.json');
  const profiles = Array.from({ length: 64 }, (_, i) => ({ name: `p${i}`, instructions: 'x'.repeat(960) }));
  await writeFile(path, JSON.stringify({ profiles }, null, 2) + '\n');
  const client = await IsolatedClient.start(root, 'profile-public-limits'); t.after(() => client.close());
  const mark = client.records.length;
  await client.prompt('/agents profile p64 dag-test/scripted off read');
  assert.ok(client.records.slice(mark).some((record) => record.method === 'notify' && /64/.test(String(record.message))));
  assert.equal(JSON.parse(await readFile(path, 'utf8')).profiles.length, 64);
  let rejected = false;
  for (let i = 0; i < 12 && !rejected; i++) {
    const before = await readFile(path);
    const offset = client.records.length;
    await client.prompt(`/agents profile p${i} dag-test/scripted off read`);
    rejected = client.records.slice(offset).some((record) => record.method === 'notify' && /64 KiB/.test(String(record.message)));
    if (rejected) assert.deepEqual(await readFile(path), before);
  }
  assert.equal(rejected, true, 'oversized save is rejected at the public command boundary');
  await client.prompt('/agents profiles');
  assert.equal(JSON.parse(await readFile(path, 'utf8')).profiles.length, 64, 'a rejected save leaves the persisted profile list loadable');
});

test('Goal reuses readiness only for the current immutable snapshot and recomputes changed statuses', async (t) => {
  const h = host(); h.ctx.hasUI = false;
  h.setEntries([{ type: 'custom', customType: STATE_TYPE, data: { ...emptyState(), tasks: [{ id: 1, subject: 'First', status: 'completed', blockedBy: [] }, { id: 2, subject: 'Last', status: 'pending', blockedBy: [1] }], nextId: 3 } }]);
  await loadPublic(h.pi, ['todos', 'goal']); await h.fire('session_start'); t.after(() => h.fire('session_shutdown'));
  const call = (tool: string, params: object) => h.tools.get(tool).execute('probe', params, undefined, undefined, h.ctx);
  await call('goal', { action: 'create', title: 'Readiness' }); await h.fire('input', { source: 'rpc', text: 'enable' }); await call('goal', { action: 'enable', id: 1 });
  const propose = () => h.fire('agent_before_settle', { outcome: 'completed', continue: false, entries: [] });
  // Confirmation belongs to a real provider turn: task_start arms the receipt, context consumes it.
  const consume = async (draft: any) => { await h.fire('turn_start'); await h.fire('context', { messages: draft.entries.map((entry: any) => ({ role: 'custom', ...entry })) }); };
  const step = (draft: any) => draft?.entries?.find((entry: any) => entry.customType === GOAL_CONTINUE_MESSAGE)?.content ?? '';
  await consume(await propose()); // consume the initial placeholder, then the ready task is the paid step.
  const ready = await propose();
  assert.match(step(ready), /Last/, 'completed prerequisite makes its successor available to the Goal');
  await consume(ready);
  const unchanged = await propose();
  assert.match(step(unchanged), /Last/, 'same Todo snapshot keeps the successor available');
  await consume(unchanged);
  await call('todo', { action: 'create', subject: 'Third' }); await call('todo', { action: 'update', id: 2, addBlockedBy: [3] });
  const blocked = await propose();
  assert.doesNotMatch(step(blocked), /Last/, 'a new unfinished prerequisite removes the stale ready successor');
});


}

{
test('manifest exposes every independently selectable Pi resource and release metadata', () => {
  const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const changelog = readFileSync(new URL('../CHANGELOG.md', import.meta.url), 'utf8');
  const lock = JSON.parse(readFileSync(new URL('../package-lock.json', import.meta.url), 'utf8'));
  assert.equal(lock.version, manifest.version);
  assert.equal(lock.packages[''].version, manifest.version);
  assert.deepEqual(manifest.pi.extensions, FEATURE_NAMES.map((name) => `./src/${name}/index.ts`));
  assert.notEqual(manifest.private, true, 'package must be publishable');
  // The version carries a dated changelog heading, so a release always documents itself.
  assert.match(changelog, new RegExp(`^## \\[${manifest.version.replaceAll('.', '\\.')}\\] - \\d{4}-\\d{2}-\\d{2}$`, 'm'));
  assert.equal(manifest.license, 'MIT');
  assert.equal(manifest.peerDependencies['@earendil-works/pi-coding-agent'], '*');
  assert.equal(manifest.dependencies, undefined);
  for (const entry of ['src', 'README.md', 'README.zh-CN.md', 'LICENSE', 'CHANGELOG.md', 'docs']) assert.ok(manifest.files.includes(entry), `files must include ${entry}`);
  assert.ok(manifest.keywords.includes('pi-package'));
});
test('each public resource exports a factory, without an aggregate root entry', () => {
  for (const factory of [todos, plan, agents, goal, retry]) assert.equal(typeof factory, 'function');
});
}
