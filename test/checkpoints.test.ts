import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { IsolatedClient } from "./fixtures/isolated-client.ts";
import { CHECKPOINT_TYPE, registerCheckpoints } from "../src/todos/checkpoints.ts";
import type { CheckpointJob } from "../src/todos/checkpoint-summary.ts";
import { emptyState, STATE_TYPE, type Todo, type WorkflowState } from "../src/todos/state.ts";

interface CheckpointMessage { customType: string; content: string; display: boolean; details: { schema: number; reason: string } }
interface Sent { message: CheckpointMessage; options?: { triggerTurn?: boolean; deliverAs?: string } }
interface Draft { type: string; customType?: string; content?: string; display?: boolean; details?: unknown; [key: string]: unknown }
type Handler = (event: { type?: string; [key: string]: unknown }, ctx: ExtensionContext) => unknown;

const workflow = (items: ReadonlyArray<readonly [number, string, Todo["status"]?]>): WorkflowState => ({
  ...emptyState(),
  tasks: items.map(([id, subject, status = "pending"]) => ({ id, subject, status, blockedBy: [] })),
  nextId: Math.max(0, ...items.map(([id]) => id)) + 1,
});
const stateEntry = (data: WorkflowState = emptyState()) => ({ type: "custom", customType: STATE_TYPE, data });

/** Minimal in-process stand-in for the Pi extension host: records handlers and messages. */
function harness(init: { branch?: unknown[]; state?: WorkflowState; jobs?: readonly CheckpointJob[]; protected?: boolean } = {}) {
  const handlers = new Map<string, Handler[]>();
  const sent: Sent[] = [];
  const pi = {
    on(event: string, handler: Handler) {
      const list = handlers.get(event);
      if (list) list.push(handler); else handlers.set(event, [handler]);
      return () => {};
    },
    sendMessage(message: CheckpointMessage, options?: Sent["options"]) { sent.push(options ? { message, options } : { message }); },
  } as unknown as ExtensionAPI;
  let state = init.state ?? emptyState();
  let jobs: readonly CheckpointJob[] = init.jobs ?? [];
  let protectedState = init.protected ?? false;
  const checkpoints = registerCheckpoints(pi, { state: () => state, jobs: () => jobs, protected: () => protectedState });
  const branch = init.branch ?? [];
  let idle = true;
  const ctx = {
    sessionManager: { getBranch: () => branch },
    isIdle: () => idle,
  } as unknown as ExtensionContext;
  const emit = (event: string, payload: Record<string, unknown> = {}): unknown[] => (handlers.get(event) ?? []).map((handler) => handler({ type: event, ...payload }, ctx));
  return {
    checkpoints,
    sent,
    branch,
    handlers,
    ctx,
    emit,
    beforeStart(): CheckpointMessage | undefined {
      const result = emit("before_agent_start")[0] as { message?: CheckpointMessage } | undefined;
      return result?.message;
    },
    setState(next: WorkflowState) { state = next; },
    setIdle(next: boolean) { idle = next; },
  };
}

test("session_start restores the branch and emits a restore checkpoint only for an existing session", () => {
  const fresh = harness();
  fresh.emit("session_start");
  assert.equal(fresh.beforeStart(), undefined, "a brand-new empty session produces no checkpoint");

  const existing = harness({ branch: [stateEntry()] });
  existing.emit("session_start");
  const message = existing.beforeStart();
  assert.ok(message);
  assert.equal(message.details.reason, "restore");
  assert.match(message.content, /Workflow state checkpoint/);
});

test("session_tree re-restores from the selected branch and re-evaluates whether state exists", () => {
  const arriving = harness();
  arriving.emit("session_start");
  assert.equal(arriving.beforeStart(), undefined);
  arriving.branch.push(stateEntry());
  arriving.emit("session_tree");
  assert.ok(arriving.beforeStart(), "a branch with workflow state yields a checkpoint");

  const leaving = harness({ branch: [stateEntry()] });
  leaving.emit("session_start");
  assert.ok(leaving.beforeStart());
  leaving.branch.length = 0;
  leaving.emit("session_tree");
  assert.equal(leaving.beforeStart(), undefined, "a branch without workflow state yields nothing");
});

test("idle compaction keeps the checkpoint pending for the next prompt or boundary", () => {
  const h = harness({ branch: [stateEntry()], state: workflow([[1, "work", "in_progress"]]) });
  h.emit("session_start");
  assert.ok(h.beforeStart(), "consume the restore checkpoint first");

  h.emit("session_compact");
  assert.equal(h.sent.length, 0, "an idle session is not sent eagerly");
  const boundary = h.emit("turn_end", { entries: [] })[0] as { entries: Draft[] };
  assert.equal(boundary.entries.length, 1);
  assert.equal(boundary.entries[0]!.customType, CHECKPOINT_TYPE);
  assert.equal((boundary.entries[0]!.details as { reason: string }).reason, "compaction");
});

test("busy compaction appends the checkpoint passively at once and asks for no turn", () => {
  const h = harness({ branch: [stateEntry()], state: workflow([[1, "work", "in_progress"]]) });
  h.emit("session_start");
  assert.ok(h.beforeStart(), "consume the restore checkpoint first");

  h.setIdle(false);
  h.emit("session_compact");
  assert.equal(h.sent.length, 1, "a resumed run cannot wait for a boundary that may never fire");
  assert.equal(h.sent[0]!.message.customType, CHECKPOINT_TYPE);
  assert.equal((h.sent[0]!.message.details as { reason: string }).reason, "compaction");
  assert.deepEqual(h.sent[0]!.options, { triggerTurn: false });
  assert.equal(h.emit("turn_end", { entries: [] })[0], undefined, "the pending checkpoint was already consumed");
  assert.equal(h.emit("agent_before_settle", { entries: [] })[0], undefined);
});

test("a brand-new empty session never emits an empty checkpoint", () => {
  const h = harness();
  h.emit("session_start");
  assert.equal(h.beforeStart(), undefined);
  assert.equal(h.emit("turn_end", { entries: [] })[0], undefined);
  assert.equal(h.emit("agent_before_settle", { entries: [] })[0], undefined);
});

test("command changes coalesce into one bounded checkpoint and identical content is not repeated", () => {
  const h = harness({ branch: [stateEntry()], state: workflow([[1, "a"], [2, "b"], [3, "c"]]) });
  h.emit("session_start");
  assert.ok(h.beforeStart());

  h.checkpoints.changed([3, 1]);
  h.checkpoints.changed([2, 3]);
  const message = h.beforeStart()!;
  assert.match(message.content, /Externally changed Todos: #1, #2, #3; use todo get for details\./);
  assert.equal(message.details.reason, "command");
  assert.equal(h.sent.length, 0, "before-start checkpoints are returned, not sent");
  assert.equal(h.beforeStart(), undefined, "one coalesced checkpoint per command sequence");

  h.checkpoints.changed([1, 2, 3]);
  assert.equal(h.beforeStart(), undefined, "identical command content is suppressed");
});

test("a command that clears the list still emits an empty-state checkpoint once in use", () => {
  const h = harness({ branch: [stateEntry()], state: workflow([[1, "gone"], [2, "also gone"]]) });
  h.emit("session_start");
  assert.ok(h.beforeStart());

  h.setState(emptyState());
  h.checkpoints.changed([]);
  const message = h.beforeStart()!;
  assert.ok(message);
  assert.equal(message.details.reason, "command");
  assert.match(message.content, /Todos: none/);
  assert.match(message.content, /No unfinished Todos\./);
  assert.doesNotMatch(message.content, /Externally changed Todos/);
});

test("turn_end and agent_before_settle chain entries after the existing prefix without requesting continue", () => {
  const h = harness({ branch: [stateEntry()], state: workflow([[1, "work", "in_progress"]]) });
  h.emit("session_start");
  assert.ok(h.beforeStart());

  h.checkpoints.changed([1]);
  const existing: Draft[] = [{ type: "custom", customType: "prior", data: 1 }];
  const turn = h.emit("turn_end", { entries: [...existing] })[0] as { entries: Draft[]; continue?: boolean };
  assert.equal(turn.entries.length, 2, "the existing prefix is preserved verbatim");
  assert.equal(turn.entries[0], existing[0]);
  assert.equal(turn.entries[1]!.type, "custom_message");
  assert.equal(turn.entries[1]!.customType, CHECKPOINT_TYPE);
  assert.equal(turn.entries[1]!.display, false);
  assert.equal("continue" in turn, false, "a passive checkpoint never asks Pi to continue");

  h.checkpoints.changed([2]);
  const settle = h.emit("agent_before_settle", { entries: [] })[0] as { entries: Draft[]; continue?: boolean };
  assert.equal(settle.entries.length, 1);
  assert.equal("continue" in settle, false);

  assert.equal(h.emit("turn_end", { entries: [] })[0], undefined, "nothing pending means Pi's entries are untouched");
  assert.equal(h.emit("agent_before_settle", { entries: [] })[0], undefined);
});

test("beforeWake appends only while idle and never requests a turn", () => {
  const h = harness({ branch: [stateEntry()], state: workflow([[1, "work"]]) });
  h.emit("session_start");

  h.setIdle(false);
  h.checkpoints.beforeWake(h.ctx);
  assert.equal(h.sent.length, 0, "a busy session is left alone");

  h.setIdle(true);
  h.checkpoints.beforeWake(h.ctx);
  assert.equal(h.sent.length, 1);
  assert.equal(h.sent[0]!.message.customType, CHECKPOINT_TYPE);
  assert.deepEqual(h.sent[0]!.options, { triggerTurn: false });

  assert.equal(h.emit("turn_end", { entries: [] })[0], undefined, "the passive append consumed the pending checkpoint");
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

test("checkpoint messages keep the documented persistence shape", () => {
  const h = harness({ branch: [stateEntry()], state: workflow([[1, "work"]]) });
  h.emit("session_start");
  const message = h.beforeStart()!;
  assert.deepEqual(Object.keys(message).sort(), ["content", "customType", "details", "display"]);
  assert.equal(message.customType, CHECKPOINT_TYPE);
  assert.equal(message.display, false);
  assert.deepEqual(message.details, { schema: 1, reason: "restore" });
  assert.match(message.content, /Workflow state checkpoint/);
});

test("only lifecycle boundaries can emit, never every tool or message update", () => {
  const h = harness({ branch: [stateEntry()], state: workflow([[1, "work"]]) });
  const registered = [...h.handlers.keys()].sort();
  assert.deepEqual(registered, ["agent_before_settle", "before_agent_start", "session_compact", "session_shutdown", "session_start", "session_tree", "turn_end"]);
  for (const event of ["message_update", "tool_execution_update", "tool_execution_start", "tool_execution_end", "message_end", "turn_start"]) {
    assert.ok(!h.handlers.has(event), `${event} must not trigger a checkpoint`);
  }

  h.emit("session_start");
  assert.ok(h.beforeStart());
  assert.equal(h.emit("turn_end", { entries: [] })[0], undefined);
  assert.equal(h.emit("agent_before_settle", { entries: [] })[0], undefined);
  assert.equal(h.emit("turn_end", { entries: [] })[0], undefined);
});

test("session_shutdown drops pending state so nothing leaks into the next session", () => {
  const h = harness({ branch: [stateEntry()], state: workflow([[1, "work"]]) });
  h.emit("session_start");
  h.checkpoints.changed([1]);
  h.emit("session_shutdown");
  assert.equal(h.beforeStart(), undefined);
});

test("a protected-state session with active jobs still emits a passive checkpoint that names no work", () => {
  const h = harness({
    branch: [stateEntry()],
    state: workflow([[1, "secret", "in_progress"]]),
    jobs: [{ id: "job-1", todoId: 1, status: "running" }],
    protected: true,
  });
  h.emit("session_start");
  const message = h.beforeStart()!;
  assert.match(message.content, /state unavailable/);
  assert.doesNotMatch(message.content, /secret/);
  assert.doesNotMatch(message.content, /job-1/);
});
