import assert from "node:assert/strict";
import { test } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { emptyState, type Todo, type WorkflowState } from "../src/todos/state.ts";
import { renderTasks } from "../src/ui/render.ts";

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

test("bounded preview shows current work, then the most recent completed history", () => {
  const lines = renderTasks(scene(), 120);
  const ids = shownIds(lines);
  assert.equal(ids.length, 8);
  for (const current of [41, 42, 43, 44]) assert.ok(ids.includes(current), `missing #${current}`);
  const completed = ids.filter((id) => id <= 40).sort((a, b) => a - b);
  assert.deepEqual(completed, [37, 38, 39, 40]);
  const output = lines.join("\n");
  for (const old of [1, 2, 3, 4, 5, 36]) assert.doesNotMatch(output, new RegExp(`#${old}(?![0-9])`));
  assert.match(output, /40\/44/);
  assert.match(output, /隐藏 36 项/);
  assert.ok(output.indexOf("#41") < output.indexOf("#37"));
});

test("hidden parents keep their predecessor reference instead of inventing ancestry", () => {
  const output = renderTasks(scene(), 120).join("\n");
  // #10 and #11 are visible in the full list but cropped from this preview; the child must still name them.
  assert.match(output, /#41<-#10(?![0-9])/);
  assert.match(output, /#42<-#11(?![0-9])/);
  // The shown parent is drawn as the path; the other visible predecessor stays in the reference.
  assert.match(output, /#43(?![<])/);
  assert.match(output, /#44<-#42(?![,0-9])/);
  assert.doesNotMatch(output, /#10<|#11</);
});

test("flat preview selects the same recent window and keeps every predecessor", () => {
  const lines = renderTasks({ ...scene(), treeStyle: "flat" }, 120);
  const output = lines.join("\n");
  assert.deepEqual(shownIds(lines), [41, 42, 43, 44, 37, 38, 39, 40]);
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
  const ids = shownIds(lines).sort((a, b) => a - b);
  assert.deepEqual(ids, Array.from({ length: 44 }, (_, index) => index + 1));
  const output = lines.join("\n");
  assert.doesNotMatch(output, /隐藏/);
  // Every parent is on screen, so the path itself carries the edge and no cropped reference is needed.
  assert.match(output, /#41(?![<])/);
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
