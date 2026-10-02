import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { IsolatedClient } from "./fixtures/isolated-client.ts";
import { STATE_TYPE, type WorkflowState } from "../src/todos/state.ts";

/** A real Pi session with a configured fragment file: apply, panel tag, prompt advert, reset. */
test("actual Pi: fragments apply from one call, advertise in the prompt, and reset on request", { timeout: 30000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-dag-preset-"));
  await mkdir(join(root, "agent", "pi-dag-workflow"), { recursive: true });
  await writeFile(join(root, "agent", "pi-dag-workflow", "pi-dag-workflow-preset.json"), JSON.stringify({
    presets: [{
      name: "release",
      description: "Ship a version",
      skill: "release-checklist",
      steps: [
        { key: "verify", subject: "跑全量测试", owner: "fast" },
        { key: "tag", subject: "打标签 v{version}", after: ["verify"] },
      ],
    }],
  }), "utf8");
  const client = await IsolatedClient.start(root);
  t.after(() => client.close());
  const call = async (name: string, args: unknown) => {
    const events = await client.prompt(`TEST CALL ${name} ${JSON.stringify(args)}`);
    const event = events.find((item) => item.type === "tool_execution_end" && item.toolName === name);
    assert.ok(event, `expected ${name}`);
    return event.result as { isError?: boolean; content: { text: string }[] };
  };
  const state = async () => {
    const entries = await client.entries() as { customType?: string; data?: WorkflowState }[];
    return entries.findLast((entry) => entry.customType === STATE_TYPE)!.data!;
  };

  await client.prompt("开始片段验收");
  const applied = await call("todo", { action: "apply", preset: "release", vars: { version: "0.9" } });
  assert.ok(!applied.isError, JSON.stringify(applied));
  assert.match(applied.content[0]!.text, /已创建片段 release 第 1 轮（2 项）：verify=#1, tag=#2；执行前建议加载 skill：release-checklist/);
  const tasks = (await state()).tasks;
  assert.deepEqual(tasks.map((task) => `${task.id}:${task.subject}:${task.blockedBy.join("/")}:${task.owner ?? "-"}`), ["1:跑全量测试::fast", "2:打标签 v0.9:1:-"]);
  assert.deepEqual(tasks.map((task) => task.metadata), [{ preset: "release", run: 1, key: "verify" }, { preset: "release", run: 1, key: "tag" }]);

  // The panel labels fragment tasks with their instance, leftmost in the tail.
  const widget = client.records.filter((item) => item.method === "setWidget").flatMap((item) => (item.widgetLines as string[] | undefined) ?? []).map(stripTerminalSequences).join("\n");
  assert.match(widget, /\[release#1\] \[fast\] \[待执行\]/);
  assert.match(widget, /\[release#1\] \[主会话\] \[待执行\]/);

  // The prompt advertises names and descriptions only, like Pi's skill list.
  const prompt = (await client.entries() as { message?: { role?: string; sections?: Record<string, string> } }[])
    .findLast((entry) => entry.message?.role === "system" && entry.message.sections?.dag_workflow_mode)!.message!.sections!;
  assert.match(prompt.dag_workflow_mode!, /Presets \(todo action=apply preset=NAME\): release \(Ship a version\)\./);

  await call("todo", { action: "update", id: 1, status: "in_progress" });
  await call("todo", { action: "update", id: 1, status: "completed" });
  const reopened = await call("todo", { action: "reset", preset: "release" });
  assert.match(reopened.content[0]!.text, /已重置片段 release 的 2 项为待执行：#1, #2/);
  assert.ok((await state()).tasks.every((task) => task.status === "pending"));
  const missing = await call("todo", { action: "apply", preset: "nope" });
  assert.equal(missing.isError, true);
  assert.match(missing.content[0]!.text, /未找到片段 nope/);
});
