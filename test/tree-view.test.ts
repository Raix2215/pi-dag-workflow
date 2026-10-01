import assert from "node:assert/strict";
import { test } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { emptyState, restoreState, STATE_TYPE, type Todo, type WorkflowState } from "../src/todos/state.ts";
import { renderTasks } from "../src/ui/render.ts";

function sample(): WorkflowState {
  const dependencies = [[], [1], [1], [2, 3], [2], [4, 5], []];
  return { ...emptyState(), nextId: 8, tasks: dependencies.map((blockedBy, index) => ({ id: index + 1, subject: `节点${index + 1}`, status: index === 0 ? "completed" : "pending", blockedBy })) };
}
const ids = (lines: string[]) => lines.flatMap((line) => { const match = /[├└]─ #([0-9]+)/.exec(line); return match ? [Number(match[1])] : []; });

test("default main paths follow creation order and only label the additional incoming edges", () => {
  const lines = renderTasks(sample(), 120, { maxRows: Infinity });
  // Chronological spanning forest: rows read strictly #1..#7, subtrees contiguous, no DFS reordering.
  assert.deepEqual(ids(lines), [1, 2, 3, 4, 5, 6, 7]);
  assert.ok(lines[0]!.startsWith("●  Todo (1/7)"));
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
  assert.match(renderTasks({ ...current, plan: true }, 120)[0]!, /Todo .* · 󰏫 Plan \[只读\]/);
  assert.match(renderTasks(current, 120, { goalTitle: "解析器改造" })[0]!, /Todo .* · 󰓾 Goal: 解析器改造/);
  assert.match(renderTasks({ ...current, plan: true }, 120, { goalTitle: "解析器改造" })[0]!, /Todo .* · .*Plan .* · .*Goal:/);
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
