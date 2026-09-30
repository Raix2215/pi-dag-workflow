import assert from "node:assert/strict";
import { access, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { IsolatedClient } from "./fixtures/isolated-client.ts";
import { STATE_TYPE, type WorkflowState } from "../src/todos.ts";

// Explicit opt-in only: this script uses the real provider and may consume credits.
const evidence = fileURLToPath(new URL("../../docs/evidence/m1/", import.meta.url));
await mkdir(evidence, { recursive: true });
const client = await IsolatedClient.startFlash();
let budgetStopped = false;
const budget = setInterval(() => {
  const turns = client.records.filter((event) => event.type === "turn_start").length;
  if (turns > 16 && !budgetStopped) {
    budgetStopped = true;
    void client.send("abort").catch(() => {});
  }
}, 200);
const snapshots = async () => (await client.entries()).map((entry) => entry as { type: string; customType?: string; data?: WorkflowState }).filter((entry) => entry.type === "custom" && entry.customType === STATE_TYPE).map((entry) => entry.data!);
let passed = false;
let failure: string | undefined;
try {
  await client.prompt("你是在独立临时目录中的 M1 验收员，不要开发、不读取配置或源码、不写文件。只用 todo 工具做一个很短的真实调用验收：创建两条测试 Todo，第一条叫‘检查依赖阻塞’，第二条叫‘汇总验证结果’并依赖第一条；尝试把第二条设为进行中，应得到前置未完成错误；据此记录验证结果，完成第一条，再开始并完成第二条。不要增加其他任务，不要清空。最多 8 次工具调用，最后用三句中文汇报实际观察。", 90000);
  const normal = (await snapshots()).at(-1)!;
  assert.equal(normal.tasks.length, 2);
  assert.ok(normal.tasks.every((task) => task.status === "completed"));
  assert.deepEqual(normal.tasks[1]!.blockedBy, [normal.tasks[0]!.id]);
  const toolEvents = client.records.filter((event) => event.type === "tool_execution_end");
  assert.ok(toolEvents.some((event) => JSON.stringify(event.result).includes("前置未完成")), "real model must observe dependency rejection");
  await client.prompt("/plan start");
  await client.prompt("继续做 Plan 模式验收：只创建一条新 Todo，标题为‘检查 Plan 边界’，再用 update 给它补充说明，说明应指出当前模式不能开始或完成任务、不能写文件。不要退出 Plan，不要添加其他任务。如果发现模式禁止实施，保持该任务 pending，不要尝试绕过。最后简短汇报这两次工具调用的实际结果。", 90000);
  const planned = (await snapshots()).at(-1)!;
  assert.equal(planned.plan, true);
  assert.equal(planned.tasks.length, 3);
  assert.equal(planned.tasks[2]!.status, "pending");
  assert.ok(planned.tasks[2]!.description?.length);
  await assert.rejects(access(join(client.root, "should-not-exist.txt")));
  assert.equal(budgetStopped, false);
  passed = true;
} catch (error) { failure = error instanceof Error ? error.message : String(error); }
finally {
  clearInterval(budget);
  const messages = client.records.filter((event) => event.type === "message_end").map((event) => event.message as { role?: string; provider?: string; model?: string; content?: { type: string; text?: string }[]; usage?: { input?: number; output?: number; cacheRead?: number; cost?: { total?: number } } }).filter((message) => message.role === "assistant");
  const reports = messages.map((message) => message.content?.filter((part) => part.type === "text").map((part) => part.text ?? "").join("\n")).filter(Boolean);
  const totals = messages.reduce((total, message) => ({ input: total.input + (message.usage?.input ?? 0), output: total.output + (message.usage?.output ?? 0), cacheRead: total.cacheRead + (message.usage?.cacheRead ?? 0), declaredCost: total.declaredCost + (message.usage?.cost?.total ?? 0) }), { input: 0, output: 0, cacheRead: 0, declaredCost: 0 });
  const summary = { passed, ...(failure ? { failure } : {}), provider: "example-provider", model: "example-model", thinking: "low", turns: client.records.filter((event) => event.type === "turn_start").length, tools: client.records.filter((event) => event.type === "tool_execution_end").map((event) => ({ name: event.toolName, isError: event.isError })), usage: totals, reports, sessionRoot: client.root, budgetStopped };
  await writeFile(join(evidence, "flash-summary.json"), JSON.stringify(summary, null, 2) + "\n");
  await client.close(false);
  console.log(JSON.stringify({ passed, failure, turns: summary.turns, tools: summary.tools.length, usage: totals, evidence: join(evidence, "flash-summary.json") }, null, 2));
}
if (!passed) process.exitCode = 1;
