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

test("bounded preview keeps the recent window in canonical creation order", () => {
  const output = renderTasks(scene(), 120).join("\n");
  const ids = shownIds(output.split("\n"));
  assert.equal(ids.length, 8);
  // Selection picks the recent window; rendering restores the canonical order, newest at the bottom.
  assert.deepEqual(ids, [37, 38, 39, 40, 41, 42, 43, 44]);
  for (const current of [41, 42, 43, 44]) assert.ok(ids.includes(current), `missing #${current}`);
  assert.deepEqual(ids.filter((id) => id <= 40), [37, 38, 39, 40]);
  for (const old of [1, 2, 3, 4, 5, 36]) assert.doesNotMatch(output, new RegExp(`#${old}(?![0-9])`));
  assert.match(output, /40\/44/);
  assert.match(output, /隐藏 36 项/);
  assert.ok(output.indexOf("#37") < output.indexOf("#41"));
  assert.ok(output.indexOf("#41") < output.indexOf("#44"));
});

test("hidden and closed parents keep their predecessor reference instead of inventing ancestry", () => {
  const output = renderTasks(scene(), 120).join("\n");
  // #10 and #11 are visible in the full list but cropped from this preview; the child must still name them.
  assert.match(output, /#41<-#10(?![0-9])/);
  assert.match(output, /#42<-#11(?![0-9])/);
  // #41's branch is closed by the time #43 is drawn, so #43 starts a root and still names #41.
  assert.match(output, /#43<-#41(?![,0-9])/);
  assert.match(output, /#44<-#42(?![,0-9])/);
  assert.doesNotMatch(output, /#10<|#11</);
});

test("flat preview selects the same recent window and keeps every predecessor", () => {
  const lines = renderTasks({ ...scene(), treeStyle: "flat" }, 120);
  const output = lines.join("\n");
  assert.deepEqual(shownIds(lines), [37, 38, 39, 40, 41, 42, 43, 44]);
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
  const ids = shownIds(lines);
  assert.deepEqual(ids, Array.from({ length: 44 }, (_, index) => index + 1));
  const output = lines.join("\n");
  assert.doesNotMatch(output, /隐藏/);
  // An earlier parent whose branch is closed remains a reference, keeping chronology truthful.
  assert.match(output, /#41<-#10/);
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

/** Completed 40..43 plus current 44..47, with a forward reference (#44 names the future #47) and a merge (#47 waits on #45 and #46). */
function progressing(): WorkflowState {
  const history: Todo[] = Array.from({ length: 39 }, (_, index) => ({ id: index + 1, subject: `历史 ${index + 1}`, status: "completed" as const, blockedBy: [] }));
  return {
    ...emptyState(),
    nextId: 48,
    tasks: [
      ...history,
      { id: 40, subject: "任务 40", status: "completed", blockedBy: [] },
      { id: 41, subject: "任务 41", status: "completed", blockedBy: [] },
      { id: 42, subject: "任务 42", status: "completed", blockedBy: [41] },
      { id: 43, subject: "任务 43", status: "completed", blockedBy: [42] },
      { id: 44, subject: "任务 44", status: "pending", blockedBy: [47] },
      { id: 45, subject: "任务 45", status: "pending", blockedBy: [43] },
      { id: 46, subject: "任务 46", status: "pending", blockedBy: [43] },
      { id: 47, subject: "任务 47", status: "pending", blockedBy: [45, 46] },
    ],
  };
}

const expected = [40, 41, 42, 43, 44, 45, 46, 47];

test("a bounded preview never lifts newer work above older rows at 80 or 120 columns", () => {
  const state = progressing();
  for (const width of [80, 120]) {
    const lines = renderTasks(state, width);
    assert.deepEqual(shownIds(lines), expected, `width ${width}`);
    for (const line of lines) assert.ok(visibleWidth(line) <= width, `${width}: ${line}`);
  }
  const output = renderTasks(state, 120).join("\n");
  // The forward reference stays a reference; the merge draws one parent and names the other.
  assert.match(output, /#44<-#47(?![,0-9])/);
  assert.match(output, /#47<-#45(?![,0-9])/);
});

test("every creation refresh and status change keeps body ids in canonical ascending order", () => {
  const ordered: Todo[] = [
    { id: 40, subject: "任务 40", status: "completed", blockedBy: [] },
    { id: 41, subject: "任务 41", status: "completed", blockedBy: [] },
    { id: 42, subject: "任务 42", status: "completed", blockedBy: [41] },
    { id: 43, subject: "任务 43", status: "completed", blockedBy: [42] },
    { id: 44, subject: "任务 44", status: "pending", blockedBy: [47] },
    { id: 45, subject: "任务 45", status: "pending", blockedBy: [43] },
    { id: 46, subject: "任务 46", status: "pending", blockedBy: [43] },
    { id: 47, subject: "任务 47", status: "pending", blockedBy: [45, 46] },
  ];
  let tasks: Todo[] = [];
  for (const task of ordered) {
    tasks = [...tasks, task];
    for (const width of [80, 120]) {
      const lines = renderTasks({ ...emptyState(), tasks, nextId: 48 }, width, { maxRows: Infinity });
      assert.deepEqual(shownIds(lines), tasks.map((item) => item.id), `#${task.id}@${width}`);
    }
  }
  // A completion changes status, not the visible creation order.
  const completed = tasks.map((task) => task.id === 44 ? { ...task, status: "completed" as const } : task);
  assert.deepEqual(shownIds(renderTasks({ ...emptyState(), tasks: completed, nextId: 48 }, 80, { maxRows: Infinity })), expected);
  assert.deepEqual(shownIds(renderTasks({ ...emptyState(), tasks: completed, nextId: 48 }, 120)), expected);
});
