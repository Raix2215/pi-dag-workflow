import { emptyState, STATE_TYPE, AGENTS_TYPE, type WorkflowState, type Todo, type Feature, CHECKPOINT_TYPE, retainedJobs } from './fixtures/public-records.ts';
import { todosHost } from './fixtures/d5-todos-host.ts';
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdir, mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { IsolatedClient } from "./fixtures/isolated-client.ts";
import { Type } from 'typebox';
import { Value } from 'typebox/value';
import { stripTerminalSequences } from '@earendil-works/pi-tui';

/** Isolate Pi's documented config directory instead of constructing private stores. */
async function configuredHost(config: Record<string, unknown>, state: WorkflowState = emptyState(), features: readonly Feature[] = ['todos', 'plan']) {
  const root = await mkdtemp(join(tmpdir(), 'pi-dag-todos-'));
  const previous = process.env.PI_CODING_AGENT_DIR;
  try {
    await mkdir(join(root, 'pi-dag-workflow'), { recursive: true });
    await writeFile(join(root, 'pi-dag-workflow', 'pi-dag-workflow-config.json'), JSON.stringify(config));
    process.env.PI_CODING_AGENT_DIR = root;
    const host = await todosHost(state, features);
    return { host, close: async () => { if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous; await rm(root, { recursive: true, force: true }); } };
  } catch (error) { if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous; await rm(root, { recursive: true, force: true }); throw error; }
}
const listed = async (host: Awaited<ReturnType<typeof todosHost>>, params: Record<string, unknown> = { action: 'list' }): Promise<Todo[]> => (await host.call(params)).details.tasks as Todo[];

// todos.test.ts
{
const tasksOf = (items: ReadonlyArray<readonly [number, string, Todo['status']?]>, extra: Partial<WorkflowState> = {}): WorkflowState => ({ ...emptyState(), tasks: items.map(([id, subject, status = 'pending']) => ({ id, subject, status, blockedBy: [] })), nextId: Math.max(0, ...items.map(([id]) => id)) + 1, ...extra });

test("one canonical list retains stable ids across delete and clear", async () => {
  const host = await todosHost();
  await host.call({ action: 'create', subject: '入口' });
  await host.call({ action: 'create', subject: '回归' });
  await host.call({ action: 'delete', id: 1 });
  assert.equal(host.state().tasks[0]!.status, 'deleted');
  await host.call({ action: 'clear' });
  await host.call({ action: 'create', subject: '新工作' });
  assert.equal(host.state().tasks[0]!.id, 3);
});

test("blockedBy only releases work after actual predecessor completion", async () => {
  const host = await todosHost();
  await host.call({ action: 'create', subject: '调查' });
  await host.call({ action: 'create', subject: '整合', blockedBy: [1] });
  const original = structuredClone(host.state());
  assert.match((await host.call({ action: 'update', id: 2, status: 'in_progress' })).content[0].text, /前置未完成/);
  assert.match((await host.call({ action: 'update', id: 2, status: 'completed' })).content[0].text, /前置未完成/);
  assert.deepEqual(host.state(), original);
  await host.call({ action: 'update', id: 1, status: 'completed' });
  await host.call({ action: 'update', id: 2, status: 'in_progress', activeForm: '正在整合' });
  assert.equal(host.state().tasks[1]!.activeForm, '正在整合');
});

test("Plan creates and edits the same list but cannot begin or complete work", async () => {
  const host = await todosHost(emptyState(), ['todos', 'plan']);
  await host.runCommand('plan', 'start');
  await host.call({ action: 'create', subject: '规划步骤' });
  await host.call({ action: 'update', id: 1, subject: '修订步骤' });
  assert.equal(host.state().tasks[0]!.subject, '修订步骤');
  for (const status of ['in_progress', 'completed'] as const) {
    const blocked = await host.call({ action: 'update', id: 1, status });
    assert.equal(blocked.isError, true);
    assert.match(blocked.content[0].text, /Plan/);
  }
  await host.runCommand('plan', 'off');
  assert.equal((await host.call({ action: 'update', id: 1, status: 'in_progress' })).isError, undefined);
  assert.equal((await host.call({ action: 'update', id: 1, status: 'completed' })).isError, undefined);
  assert.equal(host.state().tasks[0]!.status, "completed");
});

test("dependency changes reject cycles, missing edges and deleting a referenced predecessor atomically", async () => {
  const host = await todosHost();
  await host.call({ action: 'create', subject: 'A' });
  await host.call({ action: 'create', subject: 'B', blockedBy: [1] });
  const frozen = structuredClone(host.state());
  const cycle = await host.call({ action: "update", id: 1, addBlockedBy: [2] });
  assert.equal(cycle.isError, true); assert.match(cycle.content[0].text, /cycle/);
  const missing = await host.call({ action: "create", subject: "C", blockedBy: [99] });
  assert.equal(missing.isError, true); assert.match(missing.content[0].text, /missing/);
  const deleted = await host.call({ action: "delete", id: 1 });
  assert.equal(deleted.isError, true); assert.match(deleted.content[0].text, /deleted/);
  assert.deepEqual(host.state(), frozen);
  await host.call({ action: "update", id: 2, removeBlockedBy: [1] });
  await host.call({ action: "delete", id: 1 });
  assert.equal(host.state().tasks[0]!.status, "deleted");
});

test("completed work cannot be silently reopened; metadata null removes keys", async () => {
  const host = await todosHost();
  await host.call({ action: "create", subject: "完成的工作" });
  await host.call({ action: "update", id: 1, status: "completed", metadata: { evidence: "通过", temp: 1 } });
  const reopened = await host.call({ action: "update", id: 1, status: "pending" });
  assert.equal(reopened.isError, true); assert.match(reopened.content[0].text, /返工/);
  await host.call({ action: "update", id: 1, metadata: { temp: null } });
  assert.deepEqual(host.state().tasks[0]!.metadata, { evidence: "通过" });
});

test("read operations and identical updates do not publish extra state", async () => {
  const host = await todosHost();
  await host.call({ action: "create", subject: "任务" });
  const before = host.entries.length;
  for (const params of [{ action: "list" }, { action: "get", id: 1 }, { action: "update", id: 1, subject: "任务" }]) {
    await host.call(params);
    assert.equal(host.entries.length, before, 'reads and identical updates never publish another snapshot');
  }
  assert.match((await host.call({ action: "list" })).content[0].text, /#1/);
});

test("titles, instructions, empty updates and action-specific fields are validated", async () => {
  const host = await todosHost();
  await host.call({ action: "create", subject: "A" });
  const cases: [Record<string, unknown>, RegExp][] = [
    [{ action: "create", subject: " " }, /subject/],
    [{ action: "create", subject: "中".repeat(61) }, /60/],
    [{ action: "update", id: 1 }, /修改字段/],
    [{ action: "update", id: 1, description: "x".repeat(8193) }, /8 KiB/],
    [{ action: "create", subject: "B", status: "completed" }, /只支持 pending 或 in_progress/],
    [{ action: "update", id: 1, blockedBy: [1] }, /不接受/],
  ];
  for (const [params, expected] of cases) {
    const result = await host.call(params);
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, expected);
  }
});

test("list filters hide tombstones without changing canonical tasks", async () => {
  const host = await todosHost();
  await host.call({ action: "create", subject: "A" });
  await host.call({ action: "create", subject: "B" });
  await host.call({ action: "delete", id: 1 });
  assert.doesNotMatch((await host.call({ action: "list" })).content[0].text, /#1/);
  assert.match((await host.call({ action: "list", includeDeleted: true })).content[0].text, /#1/);
  assert.equal(host.state().tasks.length, 2, 'tombstones stay in the canonical list');
});

test("metadata cannot mutate caller-owned values or introduce object prototype state", async () => {
  const host = await todosHost();
  await host.call({ action: "create", subject: "A" });
  const metadata = JSON.parse('{"__proto__":{"bad":true},"value":{"nested":1}}');
  await host.call({ action: "update", id: 1, metadata });
  metadata.value.nested = 2;
  const stored = host.state().tasks[0]!.metadata!;
  assert.equal((stored.value as { nested: number }).nested, 1);
  assert.equal(({} as { bad?: boolean }).bad, undefined);
});

test("active branch replay restores a single latest native snapshot and does not rewrite history", async () => {
  const first = tasksOf([[1, "A"]]);
  const second = tasksOf([[1, "A"], [2, "B"]]);
  const entry = (data: WorkflowState) => ({ type: "custom", customType: STATE_TYPE, data });
  const host = await todosHost(undefined, ['todos'], [entry(first), entry(second)]);
  await host.emit('session_start');
  assert.deepEqual((await listed(host)).map((task) => task.subject), ["A", "B"]);
  const single = await todosHost(undefined, ['todos'], [entry(first)]);
  await single.emit('session_start');
  assert.deepEqual((await listed(single)).map((task) => task.subject), ["A"]);
  const blank = await todosHost(undefined, ['todos'], []);
  await blank.emit('session_start');
  assert.deepEqual(await listed(blank), []);
  second.tasks[0]!.subject = "不同分支";
  assert.equal((await host.call({ action: "get", id: 1 })).details.tasks[0]!.subject, "A");
});

test("a rpiv-todo task snapshot is read only when this plugin has no state on the branch", async () => {
  // The full rpiv-todo envelope: extra task fields, a tombstone, and a dependency all survive.
  const rpiv = { type: "message", message: { role: "toolResult", toolName: "todo", details: {
    action: "update", params: { action: "update", id: 2, status: "in_progress" },
    tasks: [
      { id: 7, subject: "外部任务", status: "completed", blockedBy: [], activeForm: "调查中", owner: "main", metadata: { tag: "x" } },
      { id: 8, subject: "下游任务", description: "说明", status: "in_progress", blockedBy: [7] },
      { id: 9, subject: "已删除任务", status: "deleted", blockedBy: [] },
    ], nextId: 10 } } };
  const host = await todosHost(undefined, ['todos'], [rpiv]);
  await host.emit('session_start');
  const restored = await host.call({ action: 'list', includeDeleted: true });
  assert.equal(restored.details.nextId, 10);
  assert.equal(restored.details.tasks[0]!.subject, "外部任务");
  assert.equal(restored.details.tasks[0]!.owner, "main");
  assert.deepEqual(restored.details.tasks[1]!.blockedBy, [7], "dependencies come across");
  assert.equal(restored.details.tasks[2]!.status, "deleted");
  const partial = await todosHost(undefined, ['todos'], [{ type: "message", message: { role: "toolResult", toolName: "todo", details: { tasks: [{ id: 3, subject: "缺依赖列表", status: "pending" }], nextId: 4 } } }]);
  await partial.emit('session_start');
  assert.deepEqual((await listed(partial))[0]!.blockedBy, [], "a missing dependency list becomes empty");
  const foreign = await todosHost(undefined, ['todos'], [{ type: "message", message: { role: "toolResult", toolName: "todo", details: { tasks: [{ id: 3, status: "pending" }], nextId: 4 } } }]);
  await foreign.emit('session_start');
  assert.deepEqual(await listed(foreign), [], "a foreign snapshot that fails validation is ignored instead of breaking restore");
  const own = await todosHost(undefined, ['todos'], [{ type: "custom", customType: STATE_TYPE, data: emptyState() }, rpiv]);
  await own.emit('session_start');
  assert.deepEqual(await listed(own), [], "this plugin's own snapshot wins");
});

test("invalid or future snapshots are not silently replaced by empty work", async () => {
  const future = await todosHost(undefined, ['todos'], [{ type: "custom", customType: STATE_TYPE, data: { version: 99 } }]);
  await future.emit('session_start');
  assert.equal(JSON.parse((await future.call({ action: 'status' })).content[0].text).protected, true);
  assert.match(future.notifications.join('\n'), /状态恢复失败/);
  const badCounter = await todosHost(tasksOf([[1, 'A']], { nextId: 1 }));
  assert.match(badCounter.notifications.join('\n'), /计数器/);
  assert.equal(JSON.parse((await badCounter.call({ action: 'status' })).content[0].text).protected, true);
});

test("Plan guard allows explicit read/search/questions and task edits, not implementation", async () => {
  const host = await todosHost(emptyState(), ['todos', 'plan']);
  const gate = async (tool: string, input: unknown = {}) => (await host.emit('tool_call', { toolName: tool, input }))[0] as { block?: boolean; reason?: string } | undefined;
  assert.equal(await gate('write'), undefined, 'outside Plan nothing is blocked');
  // A session tool allowlist can be widened only with a registered read tool, and only before entering Plan.
  host.tools.set('my_search', { name: 'my_search', description: 'test read tool' });
  await host.runCommand('plan', 'tools my_search');
  await host.runCommand('plan', 'start');
  for (const tool of ["read", "grep", "find", "ls", "ask_user_question", "my_search"]) assert.equal(await gate(tool), undefined);
  assert.equal(await gate("todo", { action: "create", subject: "研究" }), undefined);
  assert.ok(await gate("todo", { action: "update", status: "completed" }));
  for (const tool of ["write", "edit", "bash", "powershell", "subagent_spawn", "unknown_search"]) assert.ok(await gate(tool));
  // Machine-wide config tools are allowed, and the hard guards still win over any configured name.
  const configured = await configuredHost({ language: 'zh-CN', planTools: ['web_search', 'fetch_content', 'write', 'subagent_spawn'] });
  try {
    await configured.host.runCommand('plan', 'start');
    const configuredGate = async (tool: string) => (await configured.host.emit('tool_call', { toolName: tool, input: {} }))[0];
    assert.equal(await configuredGate('web_search'), undefined);
    assert.equal(await configuredGate('fetch_content'), undefined);
    assert.ok(await configuredGate("other_tool"));
    assert.ok(await configuredGate("write"));
    assert.ok(await configuredGate("subagent_spawn"));
    assert.ok(await configuredGate("bash"));
  } finally { await configured.close(); }
});

test("Todo reference carries every dependency at the left, with no duplicated edge text", async () => {
  const host = await todosHost();
  await host.call({ action: 'create', subject: '前置' });
  await host.call({ action: 'create', subject: '第二前置' });
  await host.call({ action: 'create', subject: '整合', blockedBy: [1, 2] });
  const text = (await host.call({ action: 'list' })).content[0].text;
  assert.match(text, /#3<-#1,#2/);
  assert.equal(text.split('#3<-#1,#2').length - 1, 1, 'the edge text is written once per row');
});
}

// checkpoints.test.ts
{
interface CheckpointMessage { customType: string; content: string; display: boolean; details: { schema: number; reason: string } }
interface Draft { type: string; customType?: string; content?: string; display?: boolean; details?: unknown; [key: string]: unknown }

const workflow = (items: ReadonlyArray<readonly [number, string, Todo["status"]?]>): WorkflowState => ({
  ...emptyState(),
  tasks: items.map(([id, subject, status = "pending"]) => ({ id, subject, status, blockedBy: [] })),
  nextId: Math.max(0, ...items.map(([id]) => id)) + 1,
});
const stateEntry = (data: WorkflowState = emptyState()) => ({ type: "custom", customType: STATE_TYPE, data });

/** The actual Todos entry receives Pi-shaped records and lifecycle events. */
async function harness(init: { branch?: unknown[]; state?: WorkflowState; jobs?: readonly { id: string; todoId?: number; status: string }[]; protected?: boolean } = {}) {
  const branch = (init.branch ?? []).map((entry: any) => entry.customType === STATE_TYPE ? { ...entry, data: init.protected ? { version: 99 } : init.state ?? entry.data } : entry);
  if (init.jobs) branch.push({ type: 'custom', customType: AGENTS_TYPE, data: { version: 1, nextId: 2, jobs: init.jobs.map(job => ({ ...job, profile: 'worker', model: { provider: 'test', id: 'offline' }, thinking: 'off', tools: ['read'], startedAt: 1, pendingRequests: 0, output: '', requests: [] })) } });
  const host = await todosHost(undefined, init.jobs ? ['todos', 'agents'] : ['todos'], branch);
  return {
    ...host,
    branch: host.entries,
    async beforeStart(): Promise<CheckpointMessage | undefined> {
      const result = (await host.emit('before_agent_start', { systemPromptOptions: { promptGuidelines: [] } }))[0] as { message?: CheckpointMessage } | undefined;
      return result?.message;
    },
  };
}

test("session_start restores the branch and emits a restore checkpoint only for an existing session", async () => {
  const fresh = await harness();
  await fresh.emit("session_start");
  assert.equal(await fresh.beforeStart(), undefined, "a brand-new empty session produces no checkpoint");

  const existing = await harness({ branch: [stateEntry()] });
  await existing.emit("session_start");
  const message = await existing.beforeStart();
  assert.ok(message);
  assert.equal(message.details.reason, "restore");
  assert.match(message.content, /Workflow state checkpoint/);
});

test("session_tree re-restores from the selected branch and re-evaluates whether state exists", async () => {
  const arriving = await harness();
  await arriving.emit("session_start");
  assert.equal(await arriving.beforeStart(), undefined);
  arriving.branch.push(stateEntry());
  await arriving.emit("session_tree");
  assert.ok(await arriving.beforeStart(), "a branch with workflow state yields a checkpoint");

  const leaving = await harness({ branch: [stateEntry()] });
  await leaving.emit("session_start");
  assert.ok(await leaving.beforeStart());
  leaving.branch.length = 0;
  await leaving.emit("session_tree");
  assert.equal(await leaving.beforeStart(), undefined, "a branch without workflow state yields nothing");
});

test("idle compaction keeps the checkpoint pending for the next prompt or boundary", async () => {
  const h = await harness({ branch: [stateEntry()], state: workflow([[1, "work", "in_progress"]]) });
  await h.emit("session_start");
  assert.ok(await h.beforeStart(), "consume the restore checkpoint first");

  await h.emit("session_compact");
  assert.equal(h.sent.length, 0, "an idle session is not sent eagerly");
  const boundary = (await h.emit("turn_end", { entries: [] }))[0] as { entries: Draft[] };
  assert.equal(boundary.entries.length, 1);
  assert.equal(boundary.entries[0]!.customType, CHECKPOINT_TYPE);
  assert.equal((boundary.entries[0]!.details as { reason: string }).reason, "compaction");
});

test("busy compaction appends the checkpoint passively at once and asks for no turn", async () => {
  const h = await harness({ branch: [stateEntry()], state: workflow([[1, "work", "in_progress"]]) });
  await h.emit("session_start");
  assert.ok(await h.beforeStart(), "consume the restore checkpoint first");

  h.setIdle(false);
  await h.emit("session_compact");
  assert.equal(h.sent.length, 1, "a resumed run cannot wait for a boundary that may never fire");
  assert.equal(h.sent[0]!.message.customType, CHECKPOINT_TYPE);
  assert.equal((h.sent[0]!.message.details as { reason: string }).reason, "compaction");
  assert.deepEqual(h.sent[0]!.options, { triggerTurn: false });
  assert.equal((await h.emit("turn_end", { entries: [] }))[0], undefined, "the pending checkpoint was already consumed");
  assert.equal((await h.emit("agent_before_settle", { entries: [] }))[0], undefined);
});

test("a brand-new empty session never emits an empty checkpoint", async () => {
  const h = await harness();
  await h.emit("session_start");
  assert.equal(await h.beforeStart(), undefined);
  assert.equal((await h.emit("turn_end", { entries: [] }))[0], undefined);
  assert.equal((await h.emit("agent_before_settle", { entries: [] }))[0], undefined);
});

test("command changes coalesce into one bounded checkpoint and identical content is not repeated", async () => {
  const h = await harness({ branch: [stateEntry()], state: workflow([[1, "a"], [2, "b"], [3, "c"]]) });
  await h.emit("session_start");
  assert.ok(await h.beforeStart());

  await h.command('edit #3 c updated');
  await h.command('edit #1 a updated');
  await h.command('edit #2 b updated');
  const message = (await h.beforeStart())!;
  assert.match(message.content, /Externally changed Todos: #1, #2, #3; use todo get for details\./);
  assert.equal(message.details.reason, "command");
  assert.equal(h.sent.length, 0, "before-start checkpoints are returned, not sent");
  assert.equal(await h.beforeStart(), undefined, "one coalesced checkpoint per command sequence");

  await h.command('edit #1 a updated');
  assert.equal(await h.beforeStart(), undefined, "identical command content is suppressed");
});

test("a command that clears the list still emits an empty-state checkpoint once in use", async () => {
  const h = await harness({ branch: [stateEntry()], state: workflow([[1, "gone"], [2, "also gone"]]) });
  await h.emit("session_start");
  assert.ok(await h.beforeStart());

  await h.command('clear all');
  const message = (await h.beforeStart())!;
  assert.ok(message);
  assert.equal(message.details.reason, "command");
  assert.match(message.content, /Todos: none/);
  assert.match(message.content, /No unfinished Todos\./);
  assert.match(message.content, /Externally changed Todos: #1, #2/, 'the public clear command reports its removed ids');
});

test("turn_end and agent_before_settle chain entries after the existing prefix without requesting continue", async () => {
  const h = await harness({ branch: [stateEntry()], state: workflow([[1, "work", "in_progress"]]) });
  await h.emit("session_start");
  assert.ok(await h.beforeStart());

  await h.command('edit #1 changed');
  const existing: Draft[] = [{ type: "custom", customType: "prior", data: 1 }];
  const turn = (await h.emit("turn_end", { entries: [...existing] }))[0] as { entries: Draft[]; continue?: boolean };
  assert.equal(turn.entries.length, 2, "the existing prefix is preserved verbatim");
  assert.equal(turn.entries[0], existing[0]);
  assert.equal(turn.entries[1]!.type, "custom_message");
  assert.equal(turn.entries[1]!.customType, CHECKPOINT_TYPE);
  assert.equal(turn.entries[1]!.display, false);
  assert.equal("continue" in turn, false, "a passive checkpoint never asks Pi to continue");

  await h.command('add another task');
  const settle = (await h.emit("agent_before_settle", { entries: [] }))[0] as { entries: Draft[]; continue?: boolean };
  assert.equal(settle.entries.length, 1);
  assert.equal("continue" in settle, false);

  assert.equal((await h.emit("turn_end", { entries: [] }))[0], undefined, "nothing pending means Pi's entries are untouched");
  assert.equal((await h.emit("agent_before_settle", { entries: [] }))[0], undefined);
});

test("beforeWake appends only while idle and never requests a turn", async (t) => {
  const { retryHost } = await import('./fixtures/retry-public-host.ts');
  const h = await retryHost(t, ['todos', 'retry']);
  h.entries.push(stateEntry(workflow([[1, 'work']])));
  await h.fire('session_tree');
  await h.cmd('when-error 1s'); await h.failure();
  const checkpoints = () => h.sends.filter(item => item.message.customType === CHECKPOINT_TYPE);
  h.setIdle(false); h.tick(1000);
  assert.equal(checkpoints().length, 0, 'a busy session is left alone');
  assert.equal(h.sends.length, 0, 'busy recovery never queues a request');
  h.setIdle(true); h.tick(1000);
  assert.equal(checkpoints().length, 1);
  assert.equal(checkpoints()[0].message.customType, CHECKPOINT_TYPE);
  assert.deepEqual(checkpoints()[0].options, { triggerTurn: false });
  assert.equal(h.sends[0].message.customType, CHECKPOINT_TYPE, 'the checkpoint precedes the retry request');
  assert.equal(h.sends[1].options.triggerTurn, true, 'only the recovery request asks for a turn');
  const results = [];
  for (const handler of h.handlers.get('turn_end') ?? []) results.push(await handler({ entries: [] }, h.ctx));
  assert.ok(results.every(result => result === undefined), 'the passive append consumed the pending checkpoint');
});

interface SessionEntry { id: string; type?: string; customType?: string; content?: string; details?: { schema?: number; reason?: string }; [key: string]: unknown }
const checkpointEntries = (entries: unknown[]): SessionEntry[] =>
  (entries as SessionEntry[]).filter((entry) => entry.type === "custom_message" && entry.customType === CHECKPOINT_TYPE);

test("real Pi compaction preserves the persisted prefix and the memory context transform", { timeout: 45000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-dag-checkpoints-"));
  await mkdir(join(root, "agent"), { recursive: true });
  await writeFile(join(root, "agent", "settings.json"), JSON.stringify({ compaction: { keepRecentTokens: 1, reserveTokens: 1 } }));
  const memory = fileURLToPath(new URL("./fixtures/checkpoint-memory.ts", import.meta.url));
  const client = await IsolatedClient.start(root, "checkpoints-rpc", [memory]);
  t.after(() => client.close());

  await client.prompt("开始检查点验收");
  await client.prompt("/todos add 检查入口");
  await client.prompt("继续推进");
  const before = await client.entries();
  const beforeIds = new Set((before as SessionEntry[]).map((entry) => entry.id));
  const commandCheckpoint = checkpointEntries(before).find((entry) => entry.details?.reason === "command");
  assert.ok(commandCheckpoint, "a command change yields a persisted checkpoint");

  const compacted = await client.send("compact");
  assert.equal(compacted.success, true);
  await client.prompt("压缩之后继续");

  const after = await client.entries();
  for (const id of beforeIds) assert.ok((after as SessionEntry[]).some((entry) => entry.id === id), `pre-compaction entry ${id} stays in the append-only session`);
  assert.ok((after as SessionEntry[]).some((entry) => entry.type === "compaction"), "Pi recorded the compaction entry");
  const reasons = checkpointEntries(after).map((entry) => entry.details?.reason);
  assert.ok(reasons.includes("compaction"), "the compaction checkpoint reaches the next request");
  const unchanged = checkpointEntries(after).find((entry) => entry.details?.reason === "command");
  assert.equal(unchanged?.content, commandCheckpoint.content, "compaction never rewrites the earlier checkpoint");

  const readLog = async () => (await readFile(join(root, "checkpoint-memory.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line) as { checkpoint: boolean; fingerprint: string; requestMessages: any[] });
  const log = await readLog();
  assert.ok(log.some((call) => call.checkpoint), "the memory transform saw the checkpoint");
  assert.ok(log.some((call) => call.checkpoint && call.requestMessages.some((message) => message.role === 'compactionSummary' && message.summary.startsWith('MEMORY-PROJECTION:'))), "the workflow preserves the memory owner's summary projection");

  await client.prompt('stable-prefix-one');
  const first = (await readLog()).at(-1)!.requestMessages;
  await client.prompt('stable-prefix-two');
  const second = (await readLog()).at(-1)!.requestMessages;
  assert.deepEqual(second.slice(0, first.length), first, 'ordinary requests grow by appending; all earlier model messages remain byte-identical');
  assert.equal(checkpointEntries(await client.entries()).length, checkpointEntries(after).length, 'no per-request checkpoint churn');

  await client.prompt('/test-filter-checkpoints');
  await client.prompt('request-after-memory-filter');
  const filtered = (await readLog()).at(-1)!;
  assert.equal(filtered.checkpoint, false, 'a memory-owned filter can omit checkpoints');
  assert.ok(checkpointEntries(await client.entries()).length > 0, 'filtering does not delete persisted state messages');
});

test("checkpoint messages keep the documented persistence shape", async () => {
  const h = await harness({ branch: [stateEntry()], state: workflow([[1, "work"]]) });
  await h.emit("session_start");
  const message = (await h.beforeStart())!;
  assert.deepEqual(Object.keys(message).sort(), ["content", "customType", "details", "display"]);
  assert.equal(message.customType, CHECKPOINT_TYPE);
  assert.equal(message.display, false);
  assert.deepEqual(message.details, { schema: 1, reason: "restore" });
  assert.match(message.content, /Workflow state checkpoint/);
});

test("only lifecycle boundaries can emit, never every tool or message update", async () => {
  const h = await harness({ branch: [stateEntry()], state: workflow([[1, "work"]]) });
  const registered = [...h.handlers.keys()].sort();
  assert.deepEqual(registered, ["agent_before_settle", "before_agent_start", "session_compact", "session_shutdown", "session_start", "session_tree", "turn_end"]);
  for (const event of ["message_update", "tool_execution_update", "tool_execution_start", "tool_execution_end", "message_end", "turn_start"]) {
    assert.ok(!h.handlers.has(event), `${event} must not trigger a checkpoint`);
  }

  await h.emit("session_start");
  assert.ok(await h.beforeStart());
  assert.equal((await h.emit("turn_end", { entries: [] }))[0], undefined);
  assert.equal((await h.emit("agent_before_settle", { entries: [] }))[0], undefined);
  assert.equal((await h.emit("turn_end", { entries: [] }))[0], undefined);
});

test("session_shutdown drops pending state so nothing leaks into the next session", async () => {
  const h = await harness({ branch: [stateEntry()], state: workflow([[1, "work"]]) });
  await h.emit("session_start");
  await h.command('edit #1 changed');
  await h.emit("session_shutdown");
  assert.equal(await h.beforeStart(), undefined);
});

test("a protected-state session with active jobs still emits a passive checkpoint that names no work", async () => {
  const h = await harness({
    branch: [stateEntry()],
    state: workflow([[1, "secret", "in_progress"]]),
    jobs: [{ id: "job-1", todoId: 1, status: "running" }],
    protected: true,
  });
  await h.emit("session_start");
  const message = (await h.beforeStart())!;
  assert.match(message.content, /state unavailable/);
  assert.doesNotMatch(message.content, /secret/);
  assert.doesNotMatch(message.content, /job-1/);
});
}

// compact-tool-schema.test.ts
{
/** Standard string enums preserve the accepted scalar set without repeated anyOf/const objects. */
test('compact enums preserve actions/status/scope validation, including malformed scalar types', async () => {
  const host = await todosHost(undefined, ['todos', 'goal']);
  const TodoParamsSchema = host.tools.get('todo').parameters;
  const GoalParamsSchema = host.tools.get('goal').parameters;
  for (const schema of [TodoParamsSchema, GoalParamsSchema]) {
    const properties: any = schema.properties;
    for (const name of ['action', 'status', 'scope']) {
      const compact = properties[name];
      if (!compact) continue;
      assert.equal(compact.type, 'string'); assert.ok(Array.isArray(compact.enum));
      assert.equal(compact.anyOf, undefined);
      const old = Type.Union(compact.enum.map((value: string) => Type.Literal(value)));
      for (const input of [...compact.enum, 'unsupported-action', '', 1, false, null, undefined, [], {}, ['pending']]) assert.equal(Value.Check(compact, input), Value.Check(old, input), `${name}: ${JSON.stringify(input)}`);
    }
  }
  assert.equal(Value.Check(TodoParamsSchema, { action: 'batch', operations: [{ action: 'create', subject: 'valid', status: 'pending' }] }), true);
  assert.equal(Value.Check(TodoParamsSchema, { action: 'batch', operations: [{ action: 'update', status: 'completed', id: 1 }] }), false);
  assert.equal(Value.Check(GoalParamsSchema, { action: 'update', progress: 'New verified result' }), true);
  assert.equal(Value.Check(GoalParamsSchema, { action: 'update', nolimit: true }), false);
});
}

// create-status.test.ts
{
for (const locale of ['zh-CN', 'en'] as const) {
  test(`create accepts safe initial status with unchanged Plan and dependency guards (${locale})`, async () => {
    const seed = async (state: WorkflowState = emptyState(), plan = false) => {
      const { host, close } = await configuredHost({ language: locale }, state);
      if (plan) await host.runCommand('plan', 'start');
      return { host, close };
    };
    const initial = emptyState();
    const omitted = await seed(initial);
    const pending = await seed();
    try {
      await omitted.host.call({ action: 'create', subject: 'default' });
      await pending.host.call({ action: 'create', subject: 'default', status: 'pending' });
      assert.deepEqual(pending.host.state(), omitted.host.state());
      assert.equal(initial.nextId, 1); assert.equal(initial.tasks.length, 0, 'the seeded state is copied, never mutated in place');

      const started = await seed();
      try {
        await started.host.call({ action: 'create', subject: 'start now', status: 'in_progress' });
        assert.equal(started.host.state().tasks[0]!.status, 'in_progress');
      } finally { await started.close(); }

      const guarded = await seed();
      try {
        await guarded.host.call({ action: 'create', subject: 'default', status: 'pending' });
        const before = JSON.stringify(guarded.host.state());
        const blocked = await guarded.host.call({ action: 'create', subject: 'blocked', status: 'in_progress', blockedBy: [1] });
        assert.equal(blocked.isError, true);
        assert.match(blocked.content[0].text, locale === 'en' ? /Prerequisites incomplete/ : /前置未完成/);
        assert.equal(JSON.stringify(guarded.host.state()), before, 'a failed create is atomic and cannot consume an id');
        await guarded.host.call({ action: 'update', id: 1, status: 'completed' });
        const ready = await guarded.host.call({ action: 'create', subject: 'ready', status: 'in_progress', blockedBy: [1] });
        assert.equal(ready.isError, undefined);
        assert.equal(guarded.host.state().tasks[1]!.status, 'in_progress');
      } finally { await guarded.close(); }

      for (const status of ['completed', 'deleted'] as const) {
        const forbidden = await seed();
        try {
          const result = await forbidden.host.call({ action: 'create', subject: 'forbidden initial state', status });
          assert.equal(result.isError, true);
          assert.match(result.content[0].text, /pending.*in_progress/);
        } finally { await forbidden.close(); }
      }

      const planned = await seed(emptyState(), true);
      try {
        await planned.host.call({ action: 'create', subject: 'plan', status: 'pending' });
        assert.equal(planned.host.state().tasks[0]!.status, 'pending');
        const cannot = await planned.host.call({ action: 'create', subject: 'cannot start in Plan', status: 'in_progress' });
        assert.equal(cannot.isError, true);
        assert.match(cannot.content[0].text, /Plan/);
        const gate = async (input: unknown) => (await planned.host.emit('tool_call', { toolName: 'todo', input }))[0];
        assert.ok(await gate({ action: 'create', subject: 'blocked at execution', status: 'in_progress' }));
        assert.equal(await gate({ action: 'create', subject: 'allowed', status: 'pending' }), undefined);
        assert.equal(await gate({ action: 'list', status: 'in_progress' }), undefined, 'listing a status stays read-only');
      } finally { await planned.close(); }
    } finally { await pending.close(); await omitted.close(); }
  });
}

async function call(client: IsolatedClient, params: object) {
  const events = await client.prompt(`TEST CALL todo ${JSON.stringify(params)}`);
  const event = events.find((record) => record.type === 'tool_execution_end' && record.toolName === 'todo')!;
  assert.ok(event, 'todo executed');
  return { ...(event.result as any), isError: event.isError === true || (event.result as any).isError === true };
}

test('actual Pi create status uses the same atomic rules through normal and Plan tool paths', { timeout: 30000 }, async (t) => {
  const client = await IsolatedClient.start(); t.after(() => client.close());
  const pending = await call(client, { action: 'create', subject: 'first', status: 'pending' });
  assert.equal(pending.isError, false); assert.equal(pending.details.tasks[0].status, 'pending');
  const blocked = await call(client, { action: 'create', subject: 'blocked', status: 'in_progress', blockedBy: [1] });
  assert.equal(blocked.isError, true);
  await call(client, { action: 'update', id: 1, status: 'completed' });
  const started = await call(client, { action: 'create', subject: 'ready', status: 'in_progress', blockedBy: [1] });
  assert.equal(started.isError, false); assert.equal(started.details.nextId, 3); assert.deepEqual(started.details.tasks.map((task: any) => task.id), [2]);
  await call(client, { action: 'update', id: 2, status: 'completed' });
  await client.prompt('/plan start');
  assert.equal((await call(client, { action: 'create', subject: 'plan pending', status: 'pending' })).isError, false);
  assert.equal((await call(client, { action: 'create', subject: 'plan started', status: 'in_progress' })).isError, true);
  const list = await call(client, { action: 'list' });
  assert.equal(list.details.nextId, 4, 'rejected creates never advance the counter');
});
}

// passive-message.test.ts
// The passive proposal primitive is observed through the Plan guidance that owns it: mode changes
// mark a draft, lifecycle events propose it, and only a persisted custom_message confirms it.
{
const planHost = () => todosHost(undefined, ['plan']);
type Proposal = { customType: string; content: string; display: false; details: { checkpointId: string } };
const proposal = (results: unknown[]): Proposal | undefined => (results as any[]).map((result) => result?.message).find((message) => message?.customType === 'pi-dag-workflow.guidance');
const persist = (host: Awaited<ReturnType<typeof todosHost>>, message: Proposal) => { host.entries.push({ type: 'custom_message', ...message }); };

test('rejected drafts can be reproposed with one id; only persistence clears pending', async () => {
  const host = await planHost();
  await host.runCommand('plan', 'start');
  const first = proposal(await host.emit('before_agent_start', {}))!;
  assert.ok(first);
  assert.match(first.content, /^Plan: read\/search\/ask/);
  const again = proposal(await host.emit('before_agent_start', {}))!;
  assert.equal(again.details.checkpointId, first.details.checkpointId);
  assert.ok(host.sent.every((entry) => entry.message?.customType !== 'pi-dag-workflow.guidance'), 'proposing is not delivery or saving');
  persist(host, first);
  assert.equal(proposal(await host.emit('before_agent_start', {})), undefined, 'only persistence clears the pending proposal');
  assert.equal(proposal(await host.emit('before_agent_start', {})), undefined, 'no mark means no per-turn churn');
});

test('a late saved old proposal does not suppress a new definition', async () => {
  const host = await planHost();
  await host.runCommand('plan', 'start');
  const old = proposal(await host.emit('before_agent_start', {}))!;
  await host.runCommand('plan', 'off');
  persist(host, old);
  const current = proposal(await host.emit('before_agent_start', {}))!;
  assert.match(current.content, /^Normal:/);
  assert.notEqual(current.details.checkpointId, old.details.checkpointId);
  persist(host, current);
  assert.equal(proposal(await host.emit('before_agent_start', {})), undefined);
});

test('successful compaction adds only one request-local message and does not consume persistence', async () => {
  const host = await planHost();
  await host.runCommand('plan', 'start');
  persist(host, proposal(await host.emit('before_agent_start', {}))!);
  assert.equal(proposal(await host.emit('before_agent_start', {})), undefined);
  await host.emit('session_compact', {});
  const summary = { role: 'compactionSummary', summary: 'memory-owned summary' };
  const prefix = [summary];
  const merged = (await host.emit('context', { messages: [...prefix] }))[0] as { messages: any[] };
  const recovery = merged.messages.at(-1);
  assert.equal(recovery.role, 'custom');
  assert.equal(recovery.display, false);
  assert.deepEqual(prefix, [summary]);
  assert.equal((await host.emit('context', { messages: [...prefix] }))[0], undefined, 'not inserted on ordinary contexts');
  const boundary = proposal(await host.emit('before_agent_start', {}))!;
  assert.equal(boundary.details.checkpointId, recovery.details.checkpointId);
  persist(host, boundary);
  assert.equal(proposal(await host.emit('before_agent_start', {})), undefined);
});

test('persistence after request-local recovery takes the current state, not a queued stale snapshot', async () => {
  const host = await planHost();
  await host.runCommand('plan', 'start');
  await host.emit('session_compact', {});
  const active = ((await host.emit('context', { messages: [] }))[0] as { messages: any[] }).messages.at(-1);
  assert.match(active.content, /^Plan:/);
  await host.runCommand('plan', 'off');
  const boundary = proposal(await host.emit('before_agent_start', {}))!;
  assert.match(boundary.content, /^Normal:/);
  assert.notEqual(boundary.details.checkpointId, active.details.checkpointId);
});

test('restores and shutdown abandon old proposals; passive busy wakes do not queue them', async () => {
  const host = await planHost();
  await host.runCommand('plan', 'start');
  const first = proposal(await host.emit('before_agent_start', {}))!;
  await host.runCommand('plan', 'off');
  await host.emit('session_shutdown', {});
  assert.equal(proposal(await host.emit('before_agent_start', {})), undefined, 'shutdown abandons the old proposal');
  await host.emit('session_start', {});
  const next = proposal(await host.emit('before_agent_start', {}))!;
  assert.match(next.content, /^Normal:/);
  assert.notEqual(next.details.checkpointId, first.details.checkpointId);
  // Guidance is only ever proposed at a boundary and returned to Pi; no wake queue exists to replay it.
  assert.ok(host.sent.every((entry) => entry.message?.customType !== 'pi-dag-workflow.guidance'), 'passive guidance never queues a wake');
});

test('an already visible recovery checkpoint is not duplicated in the request', async () => {
  const host = await planHost();
  await host.runCommand('plan', 'start');
  await host.emit('session_compact', {});
  const message = proposal(await host.emit('before_agent_start', {}))!;
  assert.equal((await host.emit('context', { messages: [{ role: 'custom', ...message }] }))[0], undefined);
  const again = proposal(await host.emit('before_agent_start', {}))!;
  assert.equal(again.details.checkpointId, message.details.checkpointId, 'still needs normal persistence');
});
}

// task-acceptance.test.ts
{
// Real isolated Pi session: the runtime projection follows a real Todo update
// ---------------------------------------------------------------------------

const offline = fileURLToPath(new URL('./fixtures/offline-model.ts', import.meta.url));
const start = () => IsolatedClient.start(undefined, 'task-acceptance', [], ['--dag-workflow-test-child-provider', offline]);
async function call(client: IsolatedClient, name: string, args: unknown) {
  const events = await client.prompt(`TEST CALL ${name} ${JSON.stringify(args)}`);
  const event = events.find((item) => item.type === 'tool_execution_end' && item.toolName === name);
  assert.ok(event, `expected ${name}`);
  return event.result as { isError?: boolean; details: Record<string, any>; content: { text: string }[] };
}
const lastWidget = (client: IsolatedClient): string => {
  const record = client.records.findLast((item) => item.method === 'setWidget' && Array.isArray(item.widgetLines));
  return ((record?.widgetLines as string[] | undefined) ?? []).map(stripTerminalSequences).join('\n');
};
const todoState = (entries: unknown[]): WorkflowState => (entries as { customType?: string; data?: WorkflowState }[]).findLast((entry) => entry.customType === STATE_TYPE)!.data!;

test('actual Pi: completing the Todo flips the bound label while the execution status stays completed', { timeout: 30000 }, async (t) => {
  const client = await start();
  t.after(() => client.close());
  await client.prompt('开始任务验收投影');
  await client.prompt('/todos add 实现验收状态');
  const spawned = await call(client, 'subagent_spawn', { task: '完成只读验收', todoId: 1 });
  assert.ok(!spawned.isError, JSON.stringify(spawned));
  const jobId = spawned.details.jobId as string;
  assert.equal(spawned.details.todoStatus, 'in_progress');

  const waited = await call(client, 'subagent_inspect', { jobId, output: true, timeout: 10 });
  assert.equal(waited.details.status, 'completed');
  assert.equal(waited.details.todoStatus, 'in_progress');
  // The report reached this context, so the bound row waits for verification.
  await client.until(() => lastWidget(client).includes('待核验'));

  let inspected = await call(client, 'subagent_inspect', { jobId });
  assert.equal(inspected.details.jobs[0].status, 'completed');
  assert.equal(inspected.details.jobs[0].todoStatus, 'in_progress');

  const updated = await call(client, 'todo', { action: 'update', id: 1, status: 'completed' });
  assert.ok(!updated.isError, JSON.stringify(updated));
  await client.until(() => lastWidget(client).includes('已完成'));

  inspected = await call(client, 'subagent_inspect', { jobId });
  assert.equal(inspected.details.jobs[0].status, 'completed', 'the execution state machine is unchanged');
  assert.equal(inspected.details.jobs[0].todoStatus, 'completed');
  const reread = await call(client, 'subagent_inspect', { jobId, output: true, timeout: 0 });
  assert.equal(reread.details.status, 'completed');
  assert.equal(reread.details.todoStatus, 'completed');
  assert.equal(todoState(await client.entries()).tasks[0]!.status, 'completed');
  // The projection is display-only: persisted Agent state never gains a todoStatus field.
  const persisted = retainedJobs(await client.entries()).records as unknown as Record<string, unknown>[];
  assert.ok(persisted.length > 0);
  for (const record of persisted) assert.ok(!Object.hasOwn(record, 'todoStatus'), JSON.stringify(record));
});

test('actual Pi: an unbound job keeps returned/delivery semantics without a todoStatus field', { timeout: 30000 }, async (t) => {
  const client = await start();
  t.after(() => client.close());
  await client.prompt('开始无绑定验收');
  const spawned = await call(client, 'subagent_spawn', { task: '完成无绑定只读验收' });
  assert.ok(!spawned.isError, JSON.stringify(spawned));
  const jobId = spawned.details.jobId as string;
  const waited = await call(client, 'subagent_inspect', { jobId, output: true, timeout: 10 });
  assert.equal(waited.details.status, 'completed');
  assert.equal(waited.details.todoStatus, undefined, 'an unbound job never invents a Todo status');
  const inspected = await call(client, 'subagent_inspect', { jobId });
  assert.equal(inspected.details.jobs[0].todoStatus, undefined);
});
}

// task-takeover.test.ts
{
test('real Pi: deadline failure, report verification, explicit main takeover and redispatch preserve history', { timeout: 30000 }, async (t) => {
  const offline = fileURLToPath(new URL('./fixtures/offline-model.ts', import.meta.url));
  const client = await IsolatedClient.start(undefined, 'task-takeover', [], ['--dag-workflow-test-child-provider', offline]);
  t.after(() => client.close());
  const call = async (name: string, params: object) => {
    const result = await client.prompt(`TEST CALL ${name} ${JSON.stringify(params)}`);
    const end = result.find((event) => event.type === 'tool_execution_end' && event.toolName === name)!;
    assert.equal(end.isError, false, JSON.stringify(end.result)); return (end.result as any).details;
  };
  await call('todo', { action: 'create', subject: 'take over the expired assignment' });
  const spawn = await call('subagent_spawn', { task: 'HOLD-IDLE-ENABLE-CHILD', todoId: 1, timeout: 2 });
  const ended = await call('subagent_inspect', { jobId: spawn.jobId, output: true, until: 'finish', timeout: 8 });
  assert.equal(ended.status, 'failed'); assert.equal(ended.error, 'Agent deadline exceeded');
  await call('todo', { action: 'update', id: 1, status: 'in_progress' });
  const text = await client.prompt('/todos list pending');
  const display = text.filter((event) => event.method === 'notify').map((event) => event.message).join('\n');
  assert.match(display, /\[主会话\].*\[进行中\]/); assert.doesNotMatch(display, /a1 ·/);
  const records = retainedJobs(await client.entries()).records;
  assert.equal(records.find((record) => record.id === spawn.jobId)!.taskReportStale, true);
  assert.equal(records.find((record) => record.id === spawn.jobId)!.error, 'Agent deadline exceeded');
  const newJob = await call('subagent_spawn', { task: 'Fresh short assignment', todoId: 1 });
  assert.notEqual(newJob.jobId, spawn.jobId);
  const after = await client.prompt('/todos list pending');
  assert.match(after.filter((event) => event.method === 'notify').map((event) => event.message).join('\n'), new RegExp(`${newJob.jobId} ·`));
});
}

// todo-batch-integration.test.ts
{
async function call(client: IsolatedClient, tool: string, params: object) {
  const events = await client.prompt(`TEST CALL ${tool} ${JSON.stringify(params)}`);
  const event = events.find((item) => item.type === 'tool_execution_end' && item.toolName === tool)!;
  assert.ok(event, `${tool} executed`);
  return { ...(event.result as any), isError: event.isError === true || (event.result as any).isError === true };
}
const snapshots = async (client: IsolatedClient) => (await client.entries() as any[]).filter((entry) => entry.type === 'custom' && entry.customType === STATE_TYPE);

test('actual Pi: atomic batches build 1,000 tasks, pagination/get remain compact, and reload/tree preserve the complete branch', { timeout: 60000 }, async (t) => {
  const helper = fileURLToPath(new URL('./fixtures/session-controls.ts', import.meta.url));
  const client = await IsolatedClient.start(undefined, 'todo-batch-reads', [helper]); t.after(() => client.close());
  for (let group = 0; group < 20; group++) {
    const operations = Array.from({ length: 50 }, (_, i) => ({ action: 'create', ref: `t${i}`, subject: `Task ${group * 50 + i + 1}`, ...(group === 9 && i === 49 ? { description: 'complete task instructions', metadata: { evidence: 'full metadata' } } : {}) }));
    const result = await call(client, 'todo', { action: 'batch', operations });
    assert.equal(result.isError, false); assert.equal(result.details.tasks.length, 50);
  }
  const before = await snapshots(client); assert.equal(before.length, 20, 'one canonical commit per batch');
  const first = await call(client, 'todo', { action: 'list' });
  assert.equal(first.details.tasks.length, 50); assert.equal(first.details.page.total, 1000);
  const ids: number[] = []; let params: any = { action: 'list', limit: 200 };
  while (params) { const page = await call(client, 'todo', params); ids.push(...page.details.tasks.map((task: any) => task.id)); params = page.details.page.next; }
  assert.deepEqual(ids, Array.from({ length: 1000 }, (_, i) => i + 1));
  const get = await call(client, 'todo', { action: 'get', id: 500 });
  assert.equal(get.details.tasks.length, 1); assert.equal(get.details.tasks[0].description, 'complete task instructions');
  assert.equal(get.details.tasks[0].metadata.evidence, 'full metadata');
  await call(client, 'todo', { action: 'update', id: 500, subject: 'Task 500' });
  assert.equal((await snapshots(client)).length, 20, 'reads and no-ops never append another canonical snapshot');
  const bad = await call(client, 'todo', { action: 'batch', operations: [{ action: 'create', subject: 'Must roll back' }, { action: 'update', id: 2000, subject: 'Missing' }] });
  assert.equal(bad.isError, true); assert.equal((await snapshots(client)).length, 20);
  await client.prompt('/plan start');
  const plan = await call(client, 'todo', { action: 'batch', operations: [{ action: 'create', ref: 'a', subject: 'Plan A' }, { action: 'create', subject: 'Plan B', blockedBy: ['@a'] }] });
  assert.equal(plan.isError, false); assert.deepEqual(plan.details.refs, { a: 1001 });
  await client.prompt('/plan off'); await client.prompt('/test-reload');
  assert.equal((await call(client, 'todo', { action: 'list' })).details.page.total, 1002);
  await client.prompt(`/test-tree ${before.at(-1)!.id}`);
  assert.equal((await call(client, 'todo', { action: 'list' })).details.page.total, 1000);
});

test('actual Pi: a batch cannot bypass an active child or partially commit another task', { timeout: 30000 }, async (t) => {
  const offline = fileURLToPath(new URL('./fixtures/offline-model.ts', import.meta.url));
  const client = await IsolatedClient.start(undefined, 'todo-batch-child-guard', [], ['--dag-workflow-test-child-provider', offline]); t.after(() => client.close());
  await call(client, 'todo', { action: 'create', subject: 'Owned task' });
  const child = await call(client, 'subagent_spawn', { todoId: 1, task: 'TEST CALL bash {"command":"sleep 10"}', tools: ['bash'] });
  assert.equal(child.isError, false);
  const before = (await snapshots(client)).at(-1)!.data;
  const operations = [{ action: 'create', subject: 'Would be partial' }, { action: 'update', id: 1, subject: 'Unannounced direction' }];
  const result = await call(client, 'todo', { action: 'batch', operations }); assert.equal(result.isError, true);
  assert.deepEqual((await snapshots(client)).at(-1)!.data, before);
  await call(client, 'subagent_cancel', { jobId: child.details.jobId });
  const allowed = await call(client, 'todo', { action: 'batch', operations }); assert.equal(allowed.isError, false);
  assert.equal(allowed.details.nextId, before.nextId + 1);
});
}

// todo-batch.test.ts
{
test('batch creates a dependency chain and updates new tasks through batch-local refs', async () => {
  const host = await todosHost();
  const result = await host.call({ action: 'batch', operations: [
    { action: 'create', ref: 'build', subject: 'Build' },
    { action: 'create', ref: 'review', subject: 'Review', blockedBy: ['@build'] },
    { action: 'update', id: '@review', description: 'Review actual artifacts', metadata: { evidence: 'pending' } },
  ] });
  assert.equal(result.isError, undefined);
  assert.deepEqual(result.details.refs, { build: 1, review: 2 });
  const tasks = host.state().tasks;
  assert.deepEqual(tasks[1]!.blockedBy, [1]);
  assert.equal(tasks[1]!.description, 'Review actual artifacts');
  assert.equal(host.state().nextId, 3);
  assert.deepEqual(tasks.map((task) => task.id), [1, 2]);
  assert.deepEqual(tasks.map((task) => task.subject), ['Build', 'Review']);
});

test('bad operations, unknown refs and cycles leave the original state and high-water id unchanged', async () => {
  const host = await todosHost();
  await host.call({ action: 'create', subject: 'Existing' });
  await host.call({ action: 'create', subject: 'Dependent', blockedBy: [1] });
  const before = structuredClone(host.state());
  const failures: object[][] = [
    [{ action: 'create', ref: 'new', subject: 'Discarded' }, { action: 'update', id: 999, subject: 'Missing' }],
    [{ action: 'create', subject: 'Unknown ref', blockedBy: ['@later'] }, { action: 'create', ref: 'later', subject: 'Later' }],
    [{ action: 'create', ref: 'same', subject: 'One' }, { action: 'create', ref: 'same', subject: 'Two' }],
    [{ action: 'update', id: 1, addBlockedBy: [2] }],
    [{ action: 'create', subject: 'Missing prerequisite', blockedBy: [999] }],
    [{ action: 'create', ref: '__proto__', subject: 'Bad ref' }],
  ];
  for (const operations of failures) {
    const result = await host.call({ action: 'batch', operations });
    assert.equal(result.isError, true);
    assert.deepEqual(host.state(), before);
  }
  await host.call({ action: 'create', subject: 'Next' });
  assert.equal(host.state().tasks.at(-1)!.id, 3);
});

test('batch accepts only pending creates and definition edits, including in Plan', async () => {
  const host = await todosHost(emptyState(), ['todos', 'plan']);
  await host.call({ action: 'create', subject: 'Existing' });
  await host.runCommand('plan', 'start');
  const gate = async (input: unknown) => (await host.emit('tool_call', { toolName: 'todo', input }))[0];
  const good = [{ action: 'create', ref: 'a', subject: 'New', status: 'pending' }, { action: 'update', id: 1, subject: 'Definition' }];
  assert.equal(await gate({ action: 'batch', operations: good }), undefined);
  const applied = await host.call({ action: 'batch', operations: good });
  assert.equal(applied.isError, undefined);
  assert.equal(host.state().tasks[0]!.subject, 'Definition');
  for (const operation of [
    { action: 'create', subject: 'Start', status: 'in_progress' }, { action: 'update', id: 1, status: 'completed' },
    { action: 'update', id: 1, owner: 'new owner' }, { action: 'delete', id: 1 }, { action: 'clear' }, { action: 'apply', preset: 'example' }, { action: 'batch', operations: [] },
  ]) {
    const result = await host.call({ action: 'batch', operations: [operation] });
    assert.equal(result.isError, true);
  }
  assert.ok(await gate({ action: 'batch', operations: [{ action: 'update', id: 1, status: 'completed' }] }));
});

test('batch is bounded, refs expire with the call, and a semantic no-op preserves canonical identity', async () => {
  const host = await todosHost();
  await host.call({ action: 'create', subject: 'Existing' });
  assert.equal((await host.call({ action: 'batch', operations: [] })).isError, true);
  assert.equal((await host.call({ action: 'batch', operations: Array.from({ length: 51 }, () => ({ action: 'create', subject: 'Too many' })) })).isError, true);
  const created = await host.call({ action: 'batch', operations: [{ action: 'create', ref: 'constructor', subject: 'Safe name' }] });
  assert.equal(created.details.refs!.constructor, 2);
  assert.equal((await host.call({ action: 'batch', operations: [{ action: 'update', id: '@constructor', subject: 'Expired ref' }] })).isError, true);
  const before = host.entries.length;
  const undone = await host.call({ action: 'batch', operations: [{ action: 'update', id: 1, subject: 'Temporary' }, { action: 'update', id: 1, subject: 'Existing' }] });
  assert.equal(undone.isError, undefined);
  assert.equal(host.entries.length, before, 'a semantic no-op publishes no further snapshot');
  assert.equal(host.state().tasks[0]!.subject, 'Existing');
});

test('batch cannot edit deleted work or use a deleted prerequisite and does not reopen completed tasks', async () => {
  const host = await todosHost();
  await host.call({ action: 'create', subject: 'Closed' });
  await host.call({ action: 'update', id: 1, status: 'completed' });
  const edited = await host.call({ action: 'batch', operations: [{ action: 'update', id: 1, description: 'Evidence' }] });
  assert.equal(edited.isError, undefined);
  assert.equal(host.state().tasks[0]!.status, 'completed');
  await host.call({ action: 'delete', id: 1 });
  for (const operations of [[{ action: 'update', id: 1, subject: 'Deleted' }], [{ action: 'create', subject: 'Bad anchor', blockedBy: [1] }]]) {
    assert.equal((await host.call({ action: 'batch', operations: operations as object[] })).isError, true);
  }
});
}

// todo-cleanup.test.ts
{
const task = (id: number, status: Todo['status'], blockedBy: number[] = []): Todo => ({ id, subject: `task ${id}`, status, blockedBy });
const history = fileURLToPath(new URL('./fixtures/history-records.ts', import.meta.url));
const controls = fileURLToPath(new URL('./fixtures/session-controls.ts', import.meta.url));
const offline = fileURLToPath(new URL('./fixtures/offline-model.ts', import.meta.url));

test('closed cleanup removes failed/cancelled/deleted records and retains all dependency anchors', async () => {
  const host = await todosHost({ ...emptyState(), tasks: [task(1, 'completed'), task(2, 'pending', [1]), task(3, 'failed'), task(4, 'cancelled'), task(5, 'deleted'), task(6, 'failed'), task(7, 'pending', [6])], nextId: 40 });
  const result = await host.call({ action: 'clear', scope: 'closed' });
  assert.equal(result.isError, undefined, JSON.stringify(result));
  assert.deepEqual(result.details.removedIds, [3, 4, 5]);
  assert.deepEqual(host.state().tasks.map((item) => item.id), [1, 2, 6, 7]);
  assert.deepEqual(host.state().tasks.map((item) => item.status), ['completed', 'pending', 'failed', 'pending']);
  assert.equal(host.state().nextId, 40);
});

test('deleted tombstones do not pin completed history; retryable failed successors still retain anchors', async () => {
  const tombstone = await todosHost({ ...emptyState(), tasks: [task(1, 'completed'), task(2, 'deleted', [1])], nextId: 3 });
  const removed = await tombstone.call({ action: 'clear', scope: 'completed' });
  assert.deepEqual(removed.details.removedIds, [1]);
  assert.deepEqual(tombstone.state().tasks.map((item) => item.id), [2]);
  const retryable = await todosHost({ ...emptyState(), tasks: [task(1, 'completed'), task(2, 'failed', [1])], nextId: 3 });
  await retryable.call({ action: 'clear', scope: 'completed' });
  assert.deepEqual(retryable.state().tasks.map((item) => item.id), [1, 2]);
});

test('failed/cancelled never satisfy prerequisites; failed attempts can be explicitly retried', async () => {
  const host = await todosHost();
  await host.call({ action: 'create', subject: 'first' });
  await host.call({ action: 'create', subject: 'second', blockedBy: [1] });
  for (const status of ['failed', 'cancelled'] as const) {
    await host.call({ action: 'update', id: 1, status });
    const blocked = await host.call({ action: 'update', id: 2, status: 'in_progress' });
    assert.equal(blocked.isError, true); assert.match(blocked.content[0].text, /前置未完成/);
    await host.call({ action: 'update', id: 1, status: 'pending' });
  }
  const bad = await host.call({ action: 'create', subject: 'bad', status: 'failed' });
  assert.equal(bad.isError, true); assert.match(bad.content[0].text, /pending 或 in_progress/);
  const extra = await host.call({ action: 'clear', id: 1 });
  assert.equal(extra.isError, true); assert.match(extra.content[0].text, /不接受字段/);
});

test('cleanup protects active work and uses the same derived failure outcome as the view', async () => {
  const tasks = [task(1, 'completed'), task(2, 'in_progress'), task(3, 'pending'), task(4, 'completed', [1])];
  // A real undelivered report has content: a blank one is delivered, so it protects nothing.
  const job = (id: string, todoId: number, status: string, reportDelivery: string, output = 'verification report\n') => ({ id, todoId, status, reportDelivery, profile: 'worker', model: { provider: 'test', id: 'offline' }, thinking: 'off', tools: ['read'], startedAt: 1, pendingRequests: 0, output, requests: [] });
  const branch = () => [
    { type: 'custom', customType: STATE_TYPE, data: { ...emptyState(), tasks, nextId: 5 } },
    { type: 'custom', customType: AGENTS_TYPE, data: { version: 1, nextId: 5, jobs: [job('a1', 1, 'completed', 'pending'), job('a2', 2, 'failed', 'delivered'), job('a3', 3, 'cancelled', 'delivered'), job('a4', 4, 'completed', 'pending')] } },
  ];
  const host = await todosHost(undefined, ['todos', 'agents'], branch());
  await host.emit('session_start');
  const result = await host.call({ action: 'clear', scope: 'closed' });
  assert.equal(result.isError, undefined, JSON.stringify(result));
  assert.deepEqual(result.details.removedIds, [2, 3]);
  assert.deepEqual(host.state().tasks.map((item) => item.id), [1, 4]);
  // Completed-scope cleanup keeps work whose report has not been delivered yet.
  const pendingReport = await todosHost(undefined, ['todos', 'agents'], branch());
  await pendingReport.emit('session_start');
  const kept = await pendingReport.call({ action: 'clear', scope: 'completed' });
  assert.equal(kept.isError, undefined, JSON.stringify(kept));
  assert.deepEqual(kept.details.removedIds, []);
  assert.deepEqual(pendingReport.state().tasks.map((item) => item.id), [1, 2, 3, 4]);
});

test('agent pruning never stops live jobs and preserves ID high-water after all history is removed', { timeout: 30000 }, async (t) => {
  // Public contract: cleanup never prunes a live child record, a removed id is never reused, and the
  // id high-water survives after every record is gone.
  const client = await IsolatedClient.start(undefined, 'prune-id', [], ['--dag-workflow-test-child-provider', offline]);
  t.after(() => client.close());
  const spawned = await call(client, 'subagent_spawn', { task: 'HOLD-IDLE-ENABLE-CHILD' });
  const jobId = (spawned.result as any).details.jobId as string;
  const live = await call(client, 'todo', { action: 'clear', scope: 'all' });
  assert.equal(live.isError, false, JSON.stringify(live.result));
  const running = retainedJobs(await client.entries()).records.find((record) => record.id === jobId);
  assert.ok(running, 'a live job is never pruned by cleanup');
  assert.ok(['starting', 'running', 'waiting'].includes(running.status), 'the live job stays active');
  await call(client, 'subagent_cancel', { jobId });
  await call(client, 'todo', { action: 'clear', scope: 'all' });
  assert.equal(retainedJobs(await client.entries()).records.some((record) => record.id === jobId), false, 'a cancelled record is pruned');
  const second = await call(client, 'subagent_spawn', { task: 'HOLD-IDLE-ENABLE-CHILD' });
  const nextId = (second.result as any).details.jobId as string;
  assert.notEqual(nextId, jobId, 'a removed id is never reused');
  assert.equal(nextId, `a${Number(jobId.slice(1)) + 1}`, 'the id continues from the high-water');
  await call(client, 'subagent_cancel', { jobId: nextId });
});

async function call(client: IsolatedClient, name: string, params: object) {
  const events = await client.prompt(`TEST CALL ${name} ${JSON.stringify(params)}`);
  const result = events.find((event) => event.type === 'tool_execution_end' && event.toolName === name)!;
  assert.ok(result); return result;
}
async function retainedClient() {
  const client = await IsolatedClient.start(undefined, 'record-cleanup', [history, controls], ['--dag-workflow-test-child-provider', offline]);
  for (let id = 1; id <= 6; id++) await call(client, 'todo', { action: 'create', subject: `record ${id}` });
  for (const [id, status] of [[1, 'completed'], [2, 'failed'], [3, 'cancelled'], [4, 'completed'], [5, 'in_progress']] as const) await call(client, 'todo', { action: 'update', id, status });
  await call(client, 'todo', { action: 'update', id: 6, addBlockedBy: [1] });
  await client.prompt(`/test-history-records ${JSON.stringify([
    { id: 'a1', status: 'completed', reportDelivery: 'delivered' },
    { id: 'a2', status: 'failed', reportDelivery: 'delivered', todoId: 2 },
    { id: 'a3', status: 'cancelled', todoId: 3 },
    { id: 'a4', status: 'completed', reportDelivery: 'pending', todoId: 4 },
    { id: 'a5', status: 'completed', reportDelivery: 'delivered', todoId: 5 },
    { id: 'a6', status: 'failed', reportDelivery: 'pending' },
  ])}`);
  await client.prompt('/test-reload');
  return client;
}

test('real Pi closed cleanup includes main failed/cancelled and child records while preserving pending evidence/anchors', { timeout: 30000 }, async (t) => {
  const client = await retainedClient(); t.after(() => client.close());
  const clear = await call(client, 'todo', { action: 'clear', scope: 'closed' });
  assert.equal(clear.isError, false);
  let entries = await client.entries() as any[];
  const state = entries.findLast((entry) => entry.customType === STATE_TYPE).data;
  assert.deepEqual(state.tasks.map((task: Todo) => task.id), [1, 4, 5, 6]);
  assert.equal(state.nextId, 7);
  const agents = retainedJobs(entries);
  assert.deepEqual(agents.records.map((job) => job.id), ['a4', 'a5', 'a6']);
  assert.equal(agents.nextId, 20);
  await client.prompt('/test-reload');
  const inspect = await call(client, 'subagent_inspect', { profiles: true });
  assert.equal((inspect.result as any).details.jobs.length, 3);
  const spawned = await call(client, 'subagent_spawn', { task: 'HOLD-IDLE-ENABLE-CHILD' });
  assert.equal((spawned.result as any).details.jobId, 'a20');
});

test('real Pi invalid cleanup fields are rejected and completed cleanup does not remove failed records', { timeout: 30000 }, async (t) => {
  const client = await retainedClient(); t.after(() => client.close());
  const bad = await call(client, 'todo', { action: 'clear', scope: 'closed', id: 2 });
  assert.equal(bad.isError, true);
  await call(client, 'todo', { action: 'clear', scope: 'completed' });
  const entries = await client.entries() as any[];
  assert.ok(entries.findLast((entry) => entry.customType === STATE_TYPE).data.tasks.some((task: Todo) => task.id === 2 && task.status === 'failed'));
  assert.ok(retainedJobs(entries).records.some((job) => job.id === 'a2'));
});
}

// todo-reads.test.ts
{
const stateOf = (count: number): WorkflowState => ({ ...emptyState(), nextId: count + 1, tasks: Array.from({ length: count }, (_, i) => ({ id: i + 1, subject: `Task ${i + 1}`, status: 'pending', blockedBy: [] })) });
const snapshots = (host: Awaited<ReturnType<typeof todosHost>>) => host.entries.filter((entry) => entry.customType === STATE_TYPE).length - 1;
const render = (host: Awaited<ReturnType<typeof todosHost>>, result: any, expanded: boolean) => host.tools.get('todo').renderResult(result, { expanded }, { fg: (_key: string, value: string) => value }).render(180);

test('default list is bounded and all 10,000 tasks can be retrieved with the returned cursor', async () => {
  const host = await todosHost(stateOf(10000));
  const first = await host.call({ action: 'list' });
  assert.equal(first.details.tasks.length, 50);
  assert.equal(first.details.page.total, 10000);
  const ids: number[] = []; let params: any = { action: 'list', limit: 200 };
  const before = snapshots(host);
  while (params) { const page = await host.call(params); ids.push(...page.details.tasks.map((task: Todo) => task.id)); params = page.details.page.next; }
  assert.equal(snapshots(host), before, 'reading never publishes state');
  assert.deepEqual(ids, host.state().tasks.map((task) => task.id));
});

test('cursor pagination filters before counting and handles insertion, deletion and unordered imports', async () => {
  const base = stateOf(6);
  const host = await todosHost({ ...base, tasks: [base.tasks[5]!, ...base.tasks.slice(0, 5)] });
  const first = await host.call({ action: 'list', limit: 2 });
  assert.deepEqual(first.details.tasks.map((task: Todo) => task.id), [1, 2]);
  await host.call({ action: 'delete', id: 3 });
  await host.call({ action: 'create', subject: 'new task' });
  const next = await host.call({ action: 'list', limit: 200, afterId: first.details.page.nextAfterId });
  assert.deepEqual(next.details.tasks.map((task: Todo) => task.id), [4, 5, 6, 7]);
  assert.equal(next.details.page.total, 6);
  assert.deepEqual((await host.call({ action: 'list', status: 'deleted', includeDeleted: true })).details.tasks.map((task: Todo) => task.id), [3]);
  assert.equal((await host.call({ action: 'list', afterId: 999 })).details.tasks.length, 0);
  for (const params of [{ action: 'list', limit: 0 }, { action: 'list', limit: 201 }, { action: 'list', afterId: -1 }, { action: 'list', limit: 1.5 }]) {
    assert.equal((await host.call(params)).isError, true);
  }
});

test('ready and get relationships derive from current statuses without adding persisted graph state', async () => {
  const host = await todosHost(stateOf(3));
  await host.call({ action: 'update', id: 2, addBlockedBy: [1] });
  await host.call({ action: 'update', id: 3, addBlockedBy: [2] });
  for (const status of ['pending', 'failed', 'cancelled'] as const) {
    await host.call({ action: 'update', id: 1, status });
    assert.deepEqual((await host.call({ action: 'list', ready: true })).details.tasks.map((task: Todo) => task.id), status === 'pending' ? [1] : []);
  }
  await host.call({ action: 'update', id: 1, status: 'completed' });
  assert.deepEqual((await host.call({ action: 'list', ready: true })).details.tasks.map((task: Todo) => task.id), [2]);
  const second = JSON.parse((await host.call({ action: 'get', id: 2 })).content[0].text);
  assert.deepEqual(second.blocks, [3]); assert.deepEqual(second.unmetPrerequisites, []);
  assert.deepEqual(JSON.parse((await host.call({ action: 'get', id: 3 })).content[0].text).unmetPrerequisites, [2]);
  assert.equal((await host.call({ action: 'list', ready: true, status: 'completed' })).isError, true);
  assert.deepEqual(host.state().tasks.map((item) => item.blockedBy), [[], [1], [2]]);
  assert.ok(host.state().tasks.every((item) => !('blocks' in item) && !('unmetPrerequisites' in item)), 'relationships stay derived, not persisted');
});

test('read, single mutation and no-op details are compact; rendering expands only the current page', async () => {
  const state = stateOf(1000); const host = await todosHost(state);
  const list = await host.call({ action: 'list' });
  assert.equal(list.details.version, 2); assert.equal(list.details.tasks.length, 50);
  assert.equal(list.details.page.total, 1000);
  assert.ok(render(host, list, false).length <= 6);
  assert.ok(render(host, list, true).length >= 50);
  assert.match(render(host, list, false).join('\n'), /50.*1000/);
  assert.doesNotMatch(render(host, list, false).join('\n'), /afterId|"action"/);
  const get = await host.call({ action: 'get', id: 7 });
  assert.deepEqual(get.details.tasks.map((task: Todo) => task.id), [7]);
  const noOp = await host.call({ action: 'update', id: 7, subject: 'Task 7' });
  assert.ok(noOp.details.tasks.length <= 1); assert.equal(snapshots(host), 0);
  const update = await host.call({ action: 'update', id: 7, subject: 'Updated' });
  assert.deepEqual(update.details.tasks.map((task: Todo) => task.id), [7]); assert.equal(snapshots(host), 1);
  assert.ok(JSON.stringify(get.details).length < JSON.stringify(state.tasks).length / 50);
  const nothing = await host.call({ action: 'clear', scope: 'completed' });
  assert.deepEqual(nothing.details.tasks, []); assert.equal(snapshots(host), 1);
  await host.call({ action: 'update', id: 7, status: 'completed' });
  const cleared = await host.call({ action: 'clear', scope: 'completed' });
  assert.deepEqual(cleared.details.tasks, []); assert.deepEqual(cleared.details.removedIds, [7]);
  assert.equal((await host.call({ action: 'list' })).details.page.total, 999);
});

test('compact tool results never become a full-state import and canonical branches still win', async () => {
  const state = stateOf(100);
  const old = { type: 'message', message: { role: 'toolResult', toolName: 'todo', details: { tasks: state.tasks, nextId: state.nextId } } };
  const compact = { type: 'message', message: { role: 'toolResult', toolName: 'todo', details: { version: 2, tasks: [state.tasks[5]], nextId: state.nextId } } };
  const full = await todosHost(undefined, ['todos'], [old, compact]);
  await full.emit('session_start');
  assert.deepEqual((await listed(full, { action: 'list', limit: 200 })).map((task) => task.id), state.tasks.map((task) => task.id));
  const compactOnly = await todosHost(undefined, ['todos'], [compact]);
  await compactOnly.emit('session_start');
  assert.deepEqual(await listed(compactOnly), []);
  const changed = { ...state, tasks: state.tasks.map((task) => task.id === 2 ? { ...task, subject: 'branch definition' } : task) };
  const mixed = await todosHost(undefined, ['todos'], [old, { type: 'custom', customType: STATE_TYPE, data: changed }, compact]);
  await mixed.emit('session_start');
  assert.deepEqual((await listed(mixed, { action: 'list', limit: 200 })).map((task) => task.subject)[1], 'branch definition');
});
}

// todo-status-only.test.ts
{
for (const status of ['completed', 'failed', 'cancelled'] as const) test(`status-only ${status} keeps original task requirements unchanged`, async () => {
  const host = await todosHost();
  await host.call({ action: 'create', subject: 'Check actual artifacts', description: 'Input: result.json. Verify every required field.', metadata: { evidencePath: 'test-results.txt' } });
  const before = structuredClone(host.state().tasks[0]);
  await host.call({ action: 'update', id: 1, status });
  assert.deepEqual(host.state().tasks[0], { ...before, status });
  const snapshots = host.entries.filter((entry) => entry.customType === STATE_TYPE).length;
  const repeated = await host.call({ action: 'update', id: 1, status });
  assert.equal(repeated.isError, undefined);
  assert.equal(host.entries.filter((entry) => entry.customType === STATE_TYPE).length, snapshots, 'a repeated status update publishes nothing');
});

test('status guidance keeps reports in the conversation and requirement edits explicit', async () => {
  const host = await todosHost();
  const tool = host.tools.get('todo');
  assert.match(tool.parameters.properties.description.description, /not a status log/);
  assert.ok(tool.promptGuidelines.some((line: string) => line.includes('normally update only id/status')));
  await host.call({ action: 'create', subject: 'Check actual artifacts', description: 'Original acceptance criteria' });
  const done = await host.call({ action: 'update', id: 1, status: 'completed' });
  assert.equal(done.isError, undefined);
  assert.equal(done.details.tasks[0].description, 'Original acceptance criteria');
  assert.doesNotMatch(done.content[0].text, /Original acceptance criteria/);
  await host.call({ action: 'update', id: 1, description: 'An explicit revised requirement' });
  assert.equal(host.state().tasks[0]!.description, 'An explicit revised requirement');
});
}

// todo-workflow-status.test.ts
{
const stateOf = (statuses: Todo['status'][]): WorkflowState => ({
  ...emptyState(),
  nextId: statuses.length + 1,
  tasks: statuses.map((status, index) => ({ id: index + 1, subject: `Task ${index + 1}`, status, blockedBy: [] })),
});

test('pure status summary is read-only and reports every status plus a separate deleted count', async () => {
  const statuses = ['pending', 'pending', 'in_progress', 'completed', 'failed', 'cancelled', 'deleted'] as const;
  const host = await todosHost(stateOf([...statuses]));
  const before = host.entries.filter((entry) => entry.customType === STATE_TYPE).length;
  const result = await host.call({ action: 'status' });
  const status = JSON.parse(result.content[0].text);
  assert.deepEqual(status, {
    mode: 'normal',
    total: 6,
    counts: { pending: 2, in_progress: 1, completed: 1, failed: 1, cancelled: 1 },
    deleted: 1,
    protected: false,
  });
  assert.deepEqual(status, Object.fromEntries(Object.entries(result.details.status).filter(([key]) => key !== 'retry')), 'content text is the readable JSON summary');
  assert.equal(host.entries.filter((entry) => entry.customType === STATE_TYPE).length, before, 'status commits nothing');
  assert.deepEqual(host.state().tasks.map((item) => item.status), [...statuses], 'the canonical list and IDs are untouched');
  assert.equal(host.state().nextId, 8);
});

test('status reports plan mode and Plan allows only the read-only query', async () => {
  const host = await todosHost(stateOf(['pending', 'completed']), ['todos', 'plan']);
  await host.runCommand('plan', 'start');
  assert.equal(JSON.parse((await host.call({ action: 'status' })).content[0].text).mode, 'plan');
  const gate = async (input: unknown) => (await host.emit('tool_call', { toolName: 'todo', input }))[0];
  assert.equal(await gate({ action: 'status' }), undefined);
  assert.ok(await gate({ action: 'update', id: 1, status: 'completed' }));
});

test('schema and field guard accept status with no extra arguments', async () => {
  const host = await todosHost();
  const TodoParamsSchema = host.tools.get('todo').parameters;
  assert.equal(Value.Check(TodoParamsSchema, { action: 'status' }), true);
  assert.equal(Value.Check(TodoParamsSchema, { action: 'status', nope: true }), false);
  for (const extra of [{ id: 1 }, { limit: 5 }, { status: 'pending' }, { subject: 'x' }]) {
    assert.equal((await host.call({ action: 'status', ...extra })).isError, true);
  }
});

test('todo tool status puts readable JSON in content and no tasks snapshot in details', async () => {
  const host = await todosHost(stateOf(['pending', 'completed', 'deleted']));
  const result = await host.call({ action: 'status' });
  assert.equal(result.isError, undefined, JSON.stringify(result));
  const parsed = JSON.parse(result.content[0]!.text);
  assert.deepEqual(parsed, {
    mode: 'normal',
    total: 2,
    counts: { pending: 1, in_progress: 0, completed: 1, failed: 0, cancelled: 0 },
    deleted: 1,
    protected: false,
  });
  assert.equal('tasks' in result.details, false);
  assert.equal('nextId' in result.details, false);
  assert.deepEqual(parsed, Object.fromEntries(Object.entries(result.details.status).filter(([key]) => key !== 'retry')));
  assert.equal(host.entries.filter((entry) => entry.customType === STATE_TYPE).length, 1, 'status never commits state');
});

test('protected state still answers status and flags it without a snapshot', async () => {
  const host = await todosHost(undefined, ['todos'], [{ type: 'custom', customType: STATE_TYPE, data: { version: 99 } }]);
  await host.emit('session_start');
  const result = await host.call({ action: 'status' });
  assert.equal(result.isError, undefined, JSON.stringify(result));
  const parsed = JSON.parse(result.content[0]!.text);
  assert.equal(parsed.protected, true);
  assert.equal(parsed.total, 0);
  assert.equal('tasks' in result.details, false);
  assert.equal(host.entries.filter((entry) => entry.customType === STATE_TYPE).length, 1, 'status never commits state');
});

async function call(client: IsolatedClient, params: object) {
  const events = await client.prompt(`TEST CALL todo ${JSON.stringify(params)}`);
  const event = events.find((record) => record.type === 'tool_execution_end' && record.toolName === 'todo')!;
  assert.ok(event, 'todo executed');
  return { ...(event.result as any), isError: event.isError === true || (event.result as any).isError === true };
}

test('actual Pi: a corrupt Todo record stays protected while status still reports normal mode', { timeout: 30000 }, async (t) => {
  const controls = fileURLToPath(new URL('./fixtures/session-controls.ts', import.meta.url));
  const client = await IsolatedClient.start(undefined, 'protected-status', [controls]);
  t.after(() => client.close());
  await client.prompt('/test-corrupt'); await client.prompt('/test-reload');
  const before = (await client.entries() as any[]).filter((entry) => entry.customType === STATE_TYPE).length;
  const result = await call(client, { action: 'status' });
  assert.equal(result.isError, false, JSON.stringify(result));
  assert.equal(JSON.parse(result.content[0].text).protected, true);
  assert.equal(JSON.parse(result.content[0].text).mode, 'normal', 'a broken Todo record is not a global Plan error');
  assert.equal((await client.entries() as any[]).filter((entry) => entry.customType === STATE_TYPE).length, before);
});

test('actual Pi: one todo status query answers mode, counts and protection without a snapshot', { timeout: 30000 }, async (t) => {
  const client = await IsolatedClient.start();
  t.after(() => client.close());
  assert.equal((await call(client, { action: 'create', subject: 'first' })).isError, false);
  assert.equal((await call(client, { action: 'create', subject: 'second', status: 'in_progress' })).isError, false);
  assert.equal((await call(client, { action: 'update', id: 1, status: 'completed' })).isError, false);
  const status = await call(client, { action: 'status' });
  assert.equal(status.isError, false, JSON.stringify(status));
  const parsed = JSON.parse(status.content[0].text);
  assert.equal(parsed.mode, 'normal');
  assert.equal(parsed.total, 2);
  assert.deepEqual(parsed.counts, { pending: 0, in_progress: 1, completed: 1, failed: 0, cancelled: 0 });
  assert.equal(parsed.deleted, 0);
  assert.equal(parsed.protected, false);
  assert.equal('tasks' in status.details, false);
  assert.equal('nextId' in status.details, false);
});
}

// unlock-hint.test.ts
{
for (const language of ['zh-CN', 'en']) {
  test(`newly ready tasks reach the Todo result without a separate UI notification (${language})`, { timeout: 30000 }, async (t) => {
    const client = await IsolatedClient.start(undefined, 'unlock-hint', [], [], false, undefined, language);
    t.after(() => client.close());
    await client.prompt('TEST CALL todo {"action":"create","subject":"first task"}');
    await client.prompt('TEST CALL todo {"action":"create","subject":"second task","blockedBy":[1]}');
    const events = await client.prompt('TEST CALL todo {"action":"update","id":1,"status":"completed"}');
    const call = events.find((event) => event.type === 'tool_execution_end' && event.toolName === 'todo')!;
    assert.ok(call && !call.isError);
    const result = call.result as { content: { type: string; text: string }[]; details: { tasks: { id: number; status: string }[] } };
    const text = result.content.filter((part) => part.type === 'text').map((part) => part.text).join('\n');
    assert.match(text, /#2 second task/);
    assert.ok(!events.some((event) => event.method === 'notify' && String(event.message).includes('#2 second task')), 'the UI must not repeat the tool result');
    const read = await client.prompt('TEST CALL todo {"action":"get","id":2}');
    const successor = read.find((event) => event.type === 'tool_execution_end' && event.toolName === 'todo')!.result as typeof result;
    assert.equal(successor.details.tasks[0]!.status, 'pending', 'the hint never starts the successor');
  });
}
}


// ticket55: a definition write may not add an edge a longer unfinished path already implies.
{ const refused = async (host: Awaited<ReturnType<typeof todosHost>>, params: Record<string, unknown>): Promise<string> => {
  const result = await host.call(params);
  assert.equal(result.isError, true, `expected a refusal, got ${JSON.stringify(result.details)}`);
  return String(result.details.error);
};

test('ticket55 independent prerequisites stay allowed and fan-in has no cap', async () => {
  const host = await todosHost();
  for (const subject of ['A', 'B', 'C', 'D']) await host.call({ action: 'create', subject });
  const pair = await host.call({ action: 'create', subject: 'E', blockedBy: [1, 2] });
  assert.deepEqual((pair.details.tasks as Todo[])[0]!.blockedBy, [1, 2], 'two independent prerequisites are accepted');
  const wide = await host.call({ action: 'create', subject: 'F', blockedBy: [1, 2, 3, 4] });
  assert.deepEqual((wide.details.tasks as Todo[])[0]!.blockedBy, [1, 2, 3, 4], 'and four are accepted: no fan-in cap');
});

test('ticket55 a new edge a longer path already implies is refused with the path', async () => {
  const host = await todosHost();
  await host.call({ action: 'create', subject: 'A' });
  await host.call({ action: 'create', subject: 'B', blockedBy: [1] });
  await host.call({ action: 'create', subject: 'C', blockedBy: [2] });
  const before = host.state();
  const message = await refused(host, { action: 'update', id: 3, addBlockedBy: [1] });
  assert.match(message, /冗余依赖/, 'the refusal names the redundancy');
  assert.match(message, /#1 -> #2 -> #3/, 'and prints the concrete alternative path');
  assert.equal(host.state(), before, 'a refused write leaves the stored definition untouched');
});

test('ticket55 a new edge that makes an old edge redundant is refused too', async () => {
  const host = await todosHost();
  await host.call({ action: 'create', subject: 'A' });
  await host.call({ action: 'create', subject: 'B', blockedBy: [1] });
  await host.call({ action: 'create', subject: 'C', blockedBy: [1] });
  const before = host.state();
  const message = await refused(host, { action: 'update', id: 3, addBlockedBy: [2] });
  assert.match(message, /#1 -> #2 -> #3/, 'the older A->C edge is the one named');
  assert.equal(host.state(), before, 'the old edge is not silently dropped: nothing was written');
});

test('ticket55 a batch is judged on its final definition, not each step', async () => {
  const host = await todosHost();
  await host.call({ action: 'create', subject: 'A' });
  await host.call({ action: 'create', subject: 'B', blockedBy: [1] });
  await host.call({ action: 'create', subject: 'C', blockedBy: [1] });
  // Mid-way C depends on A and B (a triangle); the final definition drops A, so the batch is legal.
  const done = await host.call({ action: 'batch', operations: [
    { action: 'update', id: 3, addBlockedBy: [2] },
    { action: 'update', id: 3, removeBlockedBy: [1] },
  ] });
  assert.notEqual(done.isError, true, `the batch is accepted: ${JSON.stringify(done.details)}`);
  assert.deepEqual((done.details.tasks as Todo[]).find((task) => task.id === 3)?.blockedBy, [2], 'only B remains a prerequisite');
  assert.deepEqual(host.state().tasks.find((task) => task.id === 3)?.blockedBy, [2], 'and the stored definition matches');
});

test('ticket55 an old redundancy never blocks unrelated writes or reads', async () => {
  // The stored graph already carries A->C and A->B->C: history, not this write's doing.
  const legacy: WorkflowState = { ...emptyState(), tasks: [
    { id: 1, subject: 'A', status: 'pending', blockedBy: [] },
    { id: 2, subject: 'B', status: 'pending', blockedBy: [1] },
    { id: 3, subject: 'C', status: 'pending', blockedBy: [2, 1] },
  ], nextId: 4 };
  const host = await todosHost(legacy);
  await host.call({ action: 'list' });
  await host.call({ action: 'get', id: 3 });
  await host.call({ action: 'update', id: 3, subject: 'C 改名' });
  await host.call({ action: 'update', id: 1, status: 'in_progress' });
  await host.call({ action: 'create', subject: 'D' });
  assert.equal(host.state().tasks[2]!.subject, 'C 改名', 'the rename landed');
  assert.equal(host.state().tasks[0]!.status, 'in_progress', 'and the status change landed');
  assert.deepEqual(host.state().tasks[2]!.blockedBy, [2, 1], 'while the historical edges were not rewritten');
  assert.equal(host.state().tasks[3]!.id, 4, 'and the unrelated create landed');
});

test('ticket55 a completed intermediate cannot prove the block is gone', async () => {
  const host = await todosHost();
  await host.call({ action: 'create', subject: 'A' });
  await host.call({ action: 'update', id: 1, status: 'in_progress' });
  await host.call({ action: 'update', id: 1, status: 'completed' });
  await host.call({ action: 'create', subject: 'B', blockedBy: [1] });
  await host.call({ action: 'update', id: 2, status: 'in_progress' });
  await host.call({ action: 'update', id: 2, status: 'completed' });
  await host.call({ action: 'create', subject: 'C', blockedBy: [2] });
  const added = await host.call({ action: 'update', id: 3, addBlockedBy: [1] });
  assert.notEqual(added.isError, true, `the direct edge is accepted: ${JSON.stringify(added.details)}`);
  assert.deepEqual([...(added.details.tasks as Todo[])[0]!.blockedBy].sort(), [1, 2], 'the real direct edge is allowed');
});

test('ticket55 one illegal addition fails the whole batch without partial writes', async () => {
  const host = await todosHost();
  await host.call({ action: 'create', subject: 'A' });
  await host.call({ action: 'create', subject: 'B', blockedBy: [1] });
  await host.call({ action: 'create', subject: 'C', blockedBy: [2] });
  const before = host.state();
  const message = await refused(host, { action: 'batch', operations: [
    { action: 'update', id: 1, subject: 'A 改名' },
    { action: 'update', id: 3, addBlockedBy: [1] },
  ] });
  assert.match(message, /冗余依赖/, 'the batch fails on the redundant edge');
  assert.equal(host.state(), before, 'nothing was written, not even the legal rename');
});

test('ticket55 the command surface and the owner share the same gate', async () => {
  const host = await todosHost();
  await host.call({ action: 'create', subject: 'A' });
  await host.call({ action: 'create', subject: 'B', blockedBy: [1] });
  await host.call({ action: 'create', subject: 'C', blockedBy: [2] });
  const before = host.state();
  await host.command('add D --after 1,2,3');
  assert.equal(host.state(), before, 'the /todos add command is refused by the same rule');
});
}

test('ticket55 a preset that expands a redundant dependency is refused and its file is untouched', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pi-dag-ticket55-'));
  const previous = process.env.PI_CODING_AGENT_DIR;
  try {
    await mkdir(join(root, 'pi-dag-workflow'), { recursive: true });
    const presetPath = join(root, 'pi-dag-workflow', 'pi-dag-workflow-preset.json');
    // `c` lists `a` even though `a -> b -> c` already orders it.
    const bytes = JSON.stringify({ presets: [{ name: 'tri', steps: [
      { key: 'a', subject: '一' }, { key: 'b', subject: '二', after: ['a'] }, { key: 'c', subject: '三', after: ['a', 'b'] },
    ] }] });
    await writeFile(presetPath, bytes);
    process.env.PI_CODING_AGENT_DIR = root;
    const host = await todosHost();
    const before = host.state();
    const result = await host.call({ action: 'apply', preset: 'tri' });
    assert.equal(result.isError, true, `the preset expansion is refused: ${JSON.stringify(result.details)}`);
    assert.match(String(result.details.error), /冗余依赖/, 'with the same redundancy message');
    assert.deepEqual(host.state().tasks, before.tasks, 'and no task from the fragment was created');
    assert.equal(await readFile(presetPath, 'utf8'), bytes, 'the preset file was not rewritten');
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous;
    await rm(root, { recursive: true, force: true });
  }
});

// ticket55: the gate must not depend on task order or on which outgoing edge is listed first.
{
test('ticket55 a new edge is refused even when the direct edge is listed before the longer path', async () => {
  // C (#2) is stored before B (#3), so #1's outgoing edges are listed as [#2, #3]: the direct
  // edge is seen first. The alternative path #1 -> #3 -> #2 still makes it redundant.
  const state: WorkflowState = { ...emptyState(), tasks: [
    { id: 1, subject: 'A', status: 'pending', blockedBy: [] },
    { id: 2, subject: 'C', status: 'pending', blockedBy: [3] },
    { id: 3, subject: 'B', status: 'pending', blockedBy: [1] },
  ], nextId: 4 };
  const host = await todosHost(state);
  const before = host.state();
  const result = await host.call({ action: 'update', id: 2, addBlockedBy: [1] });
  assert.equal(result.isError, true, `expected a refusal, got ${JSON.stringify(result.details)}`);
  assert.match(String(result.details.error), /#1 -> #3 -> #2/, 'the longer alternative path is reported');
  assert.equal(host.state(), before, 'and nothing was written');
});

test('ticket55 an old edge made redundant by a new one is refused regardless of edge order', async () => {
  // C (#2) already depends on A (#1) and is stored before B (#3): adding B->C makes the older
  // A->C redundant, but A's outgoing edges list the direct one first.
  const state: WorkflowState = { ...emptyState(), tasks: [
    { id: 1, subject: 'A', status: 'pending', blockedBy: [] },
    { id: 2, subject: 'C', status: 'pending', blockedBy: [1] },
    { id: 3, subject: 'B', status: 'pending', blockedBy: [1] },
  ], nextId: 4 };
  const host = await todosHost(state);
  const before = host.state();
  const result = await host.call({ action: 'update', id: 2, addBlockedBy: [3] });
  assert.equal(result.isError, true, `expected a refusal, got ${JSON.stringify(result.details)}`);
  assert.match(String(result.details.error), /#1 -> #3 -> #2/, 'the older edge is named with its new alternative');
  assert.equal(host.state(), before, 'and nothing was written');
});
}

test('ticket55 the verdict does not change when the same graph is stored in another order', async () => {
  // Same three tasks as above, listed as B, A, C: every enumeration of the same graph refuses.
  const permutations: WorkflowState['tasks'][] = [
    [ { id: 3, subject: 'B', status: 'pending', blockedBy: [1] }, { id: 1, subject: 'A', status: 'pending', blockedBy: [] }, { id: 2, subject: 'C', status: 'pending', blockedBy: [3] } ],
    [ { id: 2, subject: 'C', status: 'pending', blockedBy: [3] }, { id: 3, subject: 'B', status: 'pending', blockedBy: [1] }, { id: 1, subject: 'A', status: 'pending', blockedBy: [] } ],
    [ { id: 1, subject: 'A', status: 'pending', blockedBy: [] }, { id: 2, subject: 'C', status: 'pending', blockedBy: [3] }, { id: 3, subject: 'B', status: 'pending', blockedBy: [1] } ],
  ];
  for (const tasks of permutations) {
    const host = await todosHost({ ...emptyState(), tasks, nextId: 4 });
    const before = host.state();
    const result = await host.call({ action: 'update', id: 2, addBlockedBy: [1] });
    assert.equal(result.isError, true, `order ${tasks.map((task) => task.id).join(',')} must refuse: ${JSON.stringify(result.details)}`);
    assert.equal(host.state(), before, 'and nothing was written');
  }
});

// ticket55: a legal graph with many merge paths must not make ordinary writes walk every path.
{
const stateUrl = new URL('../src/todos/domain/state.ts', import.meta.url).href;

/** A diamond stack: every layer's two nodes depend on the previous layer's two, so paths double. */
const mergeChild = `
const { applyTodo } = await import(process.env.DAG_STATE_URL);
const layers = Number(process.env.DAG_LAYERS);
const tasks = [
  { id: 1, subject: 'root', status: 'pending', blockedBy: [] },
  { id: 2, subject: 'target', status: 'pending', blockedBy: [1] },
];
let nextId = 3, prev = [1];
const firsts = [];
for (let layer = 0; layer < layers; layer += 1) {
  const pair = [nextId, nextId + 1]; nextId += 2; firsts.push(pair[0]);
  for (const id of pair) tasks.push({ id, subject: 'n' + id, status: 'pending', blockedBy: [...prev] });
  prev = pair;
}
const state = { version: 1, tasks, nextId, plan: false, planTools: [], visible: true, view: 'list', treeStyle: 'paths' };
// 'title' adds no edge at all; 'fresh' adds one that a two-hop path already implies.
const params = process.env.DAG_MODE === 'fresh'
  ? { action: 'update', id: prev[0], addBlockedBy: [firsts[firsts.length - 3]] }
  : { action: 'update', id: 2, subject: 'renamed' };
const started = performance.now();
try {
  const result = applyTodo(state, params);
  const target = result.state.tasks.find((task) => task.id === 2);
  process.stdout.write(JSON.stringify({ ok: true, elapsed: performance.now() - started, subject: target.subject, nodes: tasks.length }));
} catch (error) {
  process.stdout.write(JSON.stringify({ ok: false, elapsed: performance.now() - started, error: String(error && error.message || error), nodes: tasks.length }));
}
`;

/** Run one case in its own process so a regression is a bounded failure, never a hung suite. */
const runMergeChild = async (mode: 'title' | 'fresh', layers: number): Promise<{ ok: boolean; elapsed: number; error?: string; subject?: string; nodes: number }> => {
  const { spawn } = await import('node:child_process');
  const child = spawn(process.execPath, ['--input-type=module', '-e', mergeChild], {
    env: { ...process.env, DAG_STATE_URL: stateUrl, DAG_LAYERS: String(layers), DAG_MODE: mode },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '', err = '';
  child.stdout.on('data', (chunk) => { out += String(chunk); });
  child.stderr.on('data', (chunk) => { err += String(chunk); });
  const timer = setTimeout(() => child.kill('SIGKILL'), 20000);
  const code = await new Promise<number | null>((resolve) => child.on('close', (value) => resolve(value)));
  clearTimeout(timer);
  assert.equal(code, 0, `the child must finish within 20s, not be killed: ${err.slice(0, 300)}`);
  return JSON.parse(out.trim());
};

test('ticket55 a title change on a wide merge graph does not walk the graph at all', { timeout: 30000 }, async () => {
  const result = await runMergeChild('title', 26);
  assert.equal(result.ok, true, 'the rename was accepted');
  assert.equal(result.subject, 'renamed');
  assert.equal(result.nodes, 54, 'a 54-node graph with 26 layers of merge paths');
  assert.ok(result.elapsed < 3000, `an edge-free write stays fast, took ${result.elapsed.toFixed(1)}ms`);
});

test('ticket55 a title change skips the search even on a very large graph', { timeout: 40000 }, async () => {
  // 6002 nodes: an edge-free write that walks the graph takes seconds, not milliseconds.
  const result = await runMergeChild('title', 3000);
  assert.equal(result.ok, true);
  assert.equal(result.nodes, 6002);
  assert.ok(result.elapsed < 3000, `an edge-free write must not walk the graph at this size, took ${result.elapsed.toFixed(1)}ms`);
});

test('ticket55 a redundant new edge on the same merge graph is still judged, and quickly', { timeout: 30000 }, async () => {
  const result = await runMergeChild('fresh', 26);
  assert.equal(result.ok, false, `the redundant edge is refused: ${JSON.stringify(result)}`);
  assert.match(String(result.error), /冗余依赖/, 'with the ordinary refusal message');
  assert.ok(result.elapsed < 3000, `reachability, not path enumeration: took ${result.elapsed.toFixed(1)}ms`);
});
}
