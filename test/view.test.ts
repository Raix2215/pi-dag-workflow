import assert from "node:assert/strict";
import { test } from "node:test";
import { visibleWidth, stripTerminalSequences } from "@earendil-works/pi-tui";
import { emptyState, type WorkflowState, type Todo } from "../src/todos/state.ts";
import { renderTasks, renderDag } from "../src/ui/render.ts";

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
