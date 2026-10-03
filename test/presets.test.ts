import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expand, fill, instances, nextRun, PresetStore, resetClosure, type Preset } from "../src/todos/presets.ts";
import { applyTodo, emptyState, newlyReady, validateState, type WorkflowState } from "../src/todos/state.ts";

async function storeWith(presets: unknown): Promise<{ store: PresetStore; close: () => Promise<void> }> {
  const root = await mkdtemp(join(tmpdir(), "pi-dag-presets-"));
  try {
    const path = join(root, "preset.json");
    await writeFile(path, JSON.stringify({ presets }), "utf8");
    const store = new PresetStore({ path });
    await store.load();
    return { store, close: () => rm(root, { recursive: true, force: true }) };
  } catch (error) {
    // A rejected definition must not leave its temporary directory behind.
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}
const release = {
  name: "release",
  description: "Ship a version",
  skill: "release-checklist",
  steps: [
    { key: "verify", subject: "跑全量测试", owner: "fast" },
    { key: "changelog", subject: "更新 CHANGELOG" },
    { key: "tag", subject: "打标签 v{version}", after: ["verify", "changelog"] },
    { key: "announce", subject: "发布公告", after: ["tag"] },
  ],
};
const names = (tasks: readonly { id: number }[]) => tasks.map((task) => task.id);

test("fragment definitions reject unknown fields, bad keys and broken dependency graphs", async () => {
  const steps = [{ key: "a", subject: "A" }];
  const cases: [unknown[], RegExp][] = [
    [[{ name: "x", steps, extra: 1 }], /Unknown preset field/],
    [[{ name: "-bad", steps }], /Invalid preset name/],
    [[{ name: "x", steps: [] }], /needs 1-32 steps/],
    [[{ name: "x", steps: [{ key: "A", subject: "A" }] }], /Invalid preset step key/],
    [[{ name: "x", steps: [{ key: "a", subject: "A" }, { key: "a", subject: "B" }] }], /Duplicate preset step key/],
    [[{ name: "x", steps: [{ key: "a", subject: "A", after: ["nope"] }] }], /unknown key/],
    [[{ name: "x", steps: [{ key: "a", subject: "A", after: ["a"] }] }], /depends on itself/],
    [[{ name: "x", steps: [{ key: "a", subject: "A", after: ["b"] }, { key: "b", subject: "B", after: ["a"] }] }], /dependency cycle/],
    [[{ name: "x", skill: "bad name", steps }], /Invalid preset skill/],
    [[{ name: "dup", steps }, { name: "dup", steps: [{ key: "b", subject: "B" }] }], /Duplicate preset name/],
  ];
  for (const [entries, expected] of cases) await assert.rejects(storeWith(entries), expected);
  // A missing file simply means no fragments.
  const empty = new PresetStore({ path: join(tmpdir(), "pi-dag-presets-missing", "preset.json") });
  await empty.load();
  assert.deepEqual(empty.list(), []);
});

test("a loaded fragment keeps its steps, skill and description", async () => {
  const { store, close } = await storeWith([release]);
  try {
    const preset = store.get("release")!;
    assert.equal(preset.skill, "release-checklist");
    assert.deepEqual(preset.steps.map((step) => step.key), ["verify", "changelog", "tag", "announce"]);
    assert.deepEqual(preset.steps[2]!.after, ["verify", "changelog"]);
    assert.equal(store.get("missing"), undefined);
  } finally { await close(); }
});

test("placeholders must be filled from caller variables", () => {
  assert.equal(fill("打标签 v{version}", { version: "0.2" }, "step tag"), "打标签 v0.2");
  assert.throws(() => fill("打标签 v{version}", {}, "step tag"), /needs a value for \{version\}/);
  assert.equal(fill("无需变量", undefined, "step"), "无需变量");
});

test("placeholder values must be own string properties, including prototype-shaped names", () => {
  assert.throws(() => fill("{constructor}", {}, "step"), /needs a value/);
  assert.throws(() => fill("{toString}", {}, "step"), /needs a value/);
  assert.throws(() => fill("{version}", Object.create({ version: "inherited" }), "step"), /needs a value/);
  assert.equal(fill("{constructor}", { constructor: "supplied" } as unknown as Record<string, string>, "step"), "supplied");
});

test("a valid fragment can refer to steps defined later without changing display ordinals", async () => {
  const preset = { name: "forward", steps: [{ key: "last", subject: "Last", after: ["first"] }, { key: "first", subject: "First" }] };
  const { store, close } = await storeWith([preset]);
  try {
    const expanded = expand(store.get("forward")!, 1, 10);
    assert.deepEqual(expanded.tasks.map((task) => task.blockedBy), [[11], []]);
    assert.deepEqual(expanded.tasks.map((task) => task.metadata!.step), [1, 2]);
  } finally { await close(); }
});

test("run selection ignores user metadata that is not a positive safe integer", () => {
  const base = expand(release as Preset, 1, 1, { version: "0.2" }).tasks;
  const malformed = [NaN, Infinity, -1, 0, 1.5].map((run, index) => ({ id: index + 10, subject: "Other", status: "pending" as const, blockedBy: [], metadata: { preset: "release", run } }));
  assert.equal(nextRun([...base, ...malformed], "release"), 2);
  assert.deepEqual(instances([...base, ...malformed], "release"), [1, 2, 3, 4]);
});

test("reset does not resurrect deleted tasks while reopening live descendants", () => {
  const tasks = expand(release as Preset, 1, 1, { version: "0.2" }).tasks;
  tasks[3]!.status = "deleted";
  tasks.push({ id: 5, subject: "Deleted unrelated history", status: "deleted", blockedBy: [3] });
  assert.deepEqual(resetClosure(tasks, "release", undefined, 1), [1, 2, 3]);
  assert.deepEqual(resetClosure(tasks, "release", "tag", 1), [3]);
});

test("a live successor of a deleted middle step is rejected before it can enter a reset", () => {
  let state: WorkflowState = { ...emptyState(), tasks: expand(release as Preset, 1, 1, { version: "0.2" }).tasks, nextId: 5 };
  assert.throws(() => applyTodo(state, { action: "delete", id: 3 }), /deleted|删除/);
  state = { ...state, tasks: state.tasks.map((task) => task.id === 3 ? { ...task, status: "deleted" as const } : task) };
  assert.throws(() => validateState(state), /deleted|删除/);
});

test("expanding a fragment creates pending tasks with mapped dependencies and run metadata", () => {
  const first = expand(release as Preset, 1, 1, { version: "0.2" });
  assert.deepEqual(names(first.tasks), [1, 2, 3, 4]);
  assert.equal(first.tasks[0]!.owner, "fast");
  assert.equal(first.tasks[2]!.subject, "打标签 v0.2");
  assert.deepEqual(first.tasks[2]!.blockedBy, [1, 2]);
  assert.deepEqual(first.tasks[3]!.blockedBy, [3]);
  assert.deepEqual(first.tasks.map((task) => task.metadata), [
    { preset: "release", run: 1, key: "verify", step: 1 },
    { preset: "release", run: 1, key: "changelog", step: 2 },
    { preset: "release", run: 1, key: "tag", step: 3 },
    { preset: "release", run: 1, key: "announce", step: 4 },
  ]);
  assert.deepEqual([...first.ids], [["verify", 1], ["changelog", 2], ["tag", 3], ["announce", 4]]);
  // A second application is a new run with fresh ids.
  const second = expand(release as Preset, nextRun(first.tasks, "release"), 5, { version: "0.3" });
  assert.equal(second.run, 2);
  assert.equal(second.tasks[0]!.metadata!.run, 2);
  assert.equal(second.tasks[0]!.metadata!.step, 1);
  assert.equal(second.tasks[0]!.id, 5);
  assert.equal(nextRun(first.tasks, "release"), 2);
});

test("resetting reopens the requested fragment, and a single step reopens its dependents", () => {
  const state: WorkflowState = { ...emptyState(), tasks: [
    { id: 1, subject: "verify", status: "completed", blockedBy: [], metadata: { preset: "release", run: 1, key: "verify" } },
    { id: 2, subject: "changelog", status: "completed", blockedBy: [], metadata: { preset: "release", run: 1, key: "changelog" } },
    { id: 3, subject: "tag", status: "completed", blockedBy: [1, 2], metadata: { preset: "release", run: 1, key: "tag" } },
    { id: 4, subject: "announce", status: "completed", blockedBy: [3], metadata: { preset: "release", run: 1, key: "announce" } },
    { id: 5, subject: "外部依赖发布", status: "completed", blockedBy: [4] },
    { id: 6, subject: "无关任务", status: "completed", blockedBy: [] },
    { id: 7, subject: "第二轮 verify", status: "pending", blockedBy: [], metadata: { preset: "release", run: 2, key: "verify" } },
  ], nextId: 8 };
  // Naming no run means the newest instance, which is what a plain reset reopens.
  assert.deepEqual(instances(state.tasks, "release"), [7]);
  assert.deepEqual(instances(state.tasks, "release", 1), [1, 2, 3, 4]);
  assert.deepEqual(instances(state.tasks, "release", 2), [7]);
  assert.deepEqual(instances(state.tasks, "release", 9), []);
  // One step reopens its transitive dependents, including tasks outside the fragment.
  assert.deepEqual(resetClosure(state.tasks, "release", "tag", 1).sort((a, b) => a - b), [3, 4, 5]);
  assert.deepEqual(resetClosure(state.tasks, "release", "nope", 1), []);
  // A step that is not part of the newest run cannot be reset there.
  assert.deepEqual(resetClosure(state.tasks, "release", "tag"), []);
  // Without a step the newest run reopens; naming a run selects that one.
  assert.deepEqual(resetClosure(state.tasks, "release"), [7]);
  assert.deepEqual(resetClosure(state.tasks, "release", undefined, 1), [1, 2, 3, 4, 5]);
  assert.deepEqual(resetClosure(state.tasks, "release", undefined, 2), [7]);
  assert.deepEqual(resetClosure(state.tasks, "other"), []);
});

test("apply and reset work through the task tool, keeping ids unique and blocks intact", async () => {
  const { store, close } = await storeWith([release]);
  try {
    const applied = applyTodo({ ...emptyState(), nextId: 40 }, { action: "apply", preset: "release", vars: { version: "1.0" } }, undefined, store);
    assert.match(applied.text, /已创建片段 release 第 1 轮（4 项）：verify=#40, changelog=#41, tag=#42, announce=#43；执行前建议加载 skill：release-checklist/);
    assert.equal(applied.state.nextId, 44);
    assert.equal(applied.state.tasks.length, 4);

    // Complete the fragment in dependency order (starting work requires finished predecessors).
    let state = applied.state;
    for (const id of [40, 41, 42, 43]) {
      state = applyTodo(state, { action: "update", id, status: "in_progress" }, undefined, store).state;
      state = applyTodo(state, { action: "update", id, status: "completed" }, undefined, store).state;
    }
    assert.ok(state.tasks.every((task) => task.status === "completed"));
    const reset = applyTodo(state, { action: "reset", preset: "release" }, undefined, store);
    assert.match(reset.text, /已重置片段 release 的 4 项为待执行/);
    assert.ok(reset.state.tasks.every((task) => task.status === "pending"));
    // Reopening a later step only touches that step and its dependents.
    let advanced = reset.state;
    for (const id of [40, 41]) {
      advanced = applyTodo(advanced, { action: "update", id, status: "in_progress" }, undefined, store).state;
      advanced = applyTodo(advanced, { action: "update", id, status: "completed" }, undefined, store).state;
    }
    const stepReset = applyTodo(advanced, { action: "reset", preset: "release", step: "changelog" }, undefined, store);
    assert.match(stepReset.text, /#41, #42, #43/);
    assert.equal(stepReset.state.tasks.find((task) => task.id === 40)!.status, "completed");

    // Unknown names and fragments without instructions are reported, never invented.
    assert.throws(() => applyTodo(emptyState(), { action: "apply", preset: "missing" }, undefined, store), /未找到片段 missing/);
    assert.throws(() => applyTodo(emptyState(), { action: "apply", preset: "release" }, undefined, undefined), /需要 preset/);
    assert.throws(() => applyTodo(emptyState(), { action: "reset", preset: "release" }, undefined, store), /没有可重置的片段/);
    assert.throws(() => applyTodo(emptyState(), { action: "apply", preset: "release", id: 3 }, undefined, store), /不接受字段 id/);
    // Plan mode edits the list, so applying a fragment is allowed there.
    const planned = applyTodo({ ...emptyState(), plan: true, nextId: 1 }, { action: "apply", preset: "release", vars: { version: "2.0" } }, undefined, store);
    assert.equal(planned.state.tasks.length, 4);
  } finally { await close(); }
});

test("completing a prerequisite reports the tasks it just unlocked", () => {
  const base: WorkflowState = { ...emptyState(), tasks: [
    { id: 1, subject: "前置", status: "in_progress", blockedBy: [] },
    { id: 2, subject: "依赖前置", status: "pending", blockedBy: [1] },
    { id: 3, subject: "双重依赖", status: "pending", blockedBy: [1, 4] },
    { id: 4, subject: "另一前置", status: "pending", blockedBy: [] },
    { id: 5, subject: "无关任务", status: "pending", blockedBy: [] },
  ], nextId: 6 };
  const done = (state: WorkflowState, id: number): WorkflowState => ({ ...state, tasks: state.tasks.map((task) => task.id === id ? { ...task, status: "completed" as const } : task) });
  assert.deepEqual(newlyReady(base, done(base, 1)).map((task) => task.id), [2]);
  // Only when every prerequisite is completed, and never before the change.
  assert.deepEqual(newlyReady(base, done(base, 4)).map((task) => task.id), []);
  const both = done(done(base, 1), 4);
  assert.deepEqual(newlyReady(base, both).map((task) => task.id), [2, 3]);
  assert.deepEqual(newlyReady(both, done(both, 5)).map((task) => task.id), []);
  assert.deepEqual(newlyReady(base, { ...base, tasks: base.tasks.map((task) => task.id === 1 ? { ...task, subject: "改名" } : task) }), []);
});
