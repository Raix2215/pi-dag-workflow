import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { test } from "node:test";
import { IsolatedClient } from "./fixtures/isolated-client.ts";
import { STATE_TYPE, type WorkflowState } from "../src/todos/state.ts";

function latestState(entries: unknown[]): WorkflowState | undefined {
  return entries.map((entry) => entry as { type?: string; customType?: string; data?: WorkflowState }).findLast((entry) => entry.type === "custom" && entry.customType === STATE_TYPE)?.data;
}
function resultText(events: Record<string, unknown>[]): string {
  return events.filter((event) => event.type === "tool_execution_end").map((event) => JSON.stringify(event.result)).join("\n");
}

test("actual Pi RPC uses only the new plugin, executes Todo tools and keeps UI state out of model messages", { timeout: 30000 }, async (t) => {
  const client = await IsolatedClient.start();
  t.after(() => client.close());
  const commands = (await client.send("get_commands")).data as { commands: { name: string }[] };
  assert.deepEqual(commands.commands.map((item) => item.name).sort(), ["agents", "dag", "goal", "plan", "todos"]);
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
  assert.equal(latestState(await client.entries())!.plan, true);
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
  assert.equal(before.plan, true);
  const root = client.root;
  await client.close(false);
  client = await IsolatedClient.start(root);
  assert.equal(client.records.some((event) => event.type === "agent_start"), false);
  const notifications = JSON.stringify(client.records);
  assert.match(notifications, /Plan/);
  const after = latestState(await client.entries())!;
  assert.deepEqual(after, before);
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
  assert.deepEqual(latestState(await client.entries())!.planTools, ["test_search"]);
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
  const clearing = client.prompt("/todos clear");
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
  assert.match(widget(), /●  Todo \(0\/4\)/);
  assert.match(widget(), /   │  └─ #4<-#3/);
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
  assert.match(widget(), /#4<-#3/);
  assert.doesNotMatch(widget(), /#4<-#2,#3/);
});
