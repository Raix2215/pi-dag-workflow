import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { registerAgents } from "../src/agents/register.ts";
import { emptyState, type WorkflowState } from "../src/todos/state.ts";

const offline = fileURLToPath(new URL("./fixtures/offline-model.ts", import.meta.url));

async function until(predicate: () => boolean, timeout = 15000): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeout) { if (predicate()) return; await delay(20); }
  throw new Error("delivery test timed out");
}

/** Register against a fake Pi so the real child runtime drives register-level delivery decisions. */
async function harness(options: { idle: boolean; wakeFails?: boolean }) {
  const root = await mkdtemp(join(tmpdir(), "pi-dag-delivery-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = join(root, "agent");
  const state: WorkflowState = emptyState();
  const tools = new Map<string, any>();
  const handlers = new Map<string, Function[]>();
  let wakeAttempts = 0;
  const pi: any = {
    registerFlag() {},
    on(name: string, handler: Function) { const list = handlers.get(name) ?? []; list.push(handler); handlers.set(name, list); },
    registerTool(definition: { name: string }) { tools.set(definition.name, definition); },
    registerCommand() {},
    appendEntry() {},
    sendMessage() { wakeAttempts++; if (options.wakeFails) throw new Error("wake transport unavailable"); },
    sendUserMessage() {},
    getFlag: (name: string) => name === "dag-workflow-test-child-provider" ? offline : undefined,
  };
  const ctx: any = {
    cwd: root,
    model: { provider: "dag-test", id: "scripted" },
    hasUI: true,
    isIdle: () => options.idle,
    modelRegistry: { find: (provider: string, id: string) => provider === "dag-test" && id === "scripted" ? { provider, id, reasoning: false, api: "dag-test-api" } : undefined },
    sessionManager: { getBranch: () => [] },
    ui: { notify: () => {}, confirm: async () => false },
  };
  const agents = registerAgents(pi, { state: () => state, mutate: () => {}, paint: () => {}, protected: () => false, canWake: () => true });
  for (const handler of handlers.get("session_start") ?? []) await handler({}, ctx);
  const spawned = await tools.get("subagent_spawn").execute("call", { task: "离线模拟交付" }, undefined, undefined, ctx);
  assert.ok(!spawned.isError, JSON.stringify(spawned));
  await until(() => agents.summaries().some((job) => job.status === "completed"));
  return {
    root, ctx, agents, handlers, tools,
    wakeAttempts: () => wakeAttempts,
    job: () => agents.summaries().find((item) => item.status === "completed")!,
    close: async () => {
      for (const handler of handlers.get("session_shutdown") ?? []) await handler({}, ctx);
      if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous;
      await rm(root, { recursive: true, force: true });
    },
  };
}

test("a failed automatic wake never acknowledges the pending report", { timeout: 30000 }, async () => {
  const h = await harness({ idle: true, wakeFails: true });
  try {
    await delay(80); // Let the idle wake attempt actually run.
    assert.ok(h.wakeAttempts() >= 1, "the idle wake must run");
    assert.equal(h.job().reportDelivery, "pending", "a failed wake must not acknowledge the report");
  } finally { await h.close(); }
});

test("a model error suspends report delivery until recovery succeeds without discarding results", { timeout: 30000 }, async () => {
  const options = { idle: false };
  const h = await harness(options);
  try {
    const boundary = (outcome: string) => (h.handlers.get('turn_end') ?? [])[0]!({ outcome }, h.ctx);
    assert.equal(await boundary('error'), undefined);
    assert.equal(h.job().reportDelivery, 'pending');
    options.idle = true;
    await (h.handlers.get('agent_settled') ?? [])[0]!({}, h.ctx);
    await delay(80);
    assert.equal(h.wakeAttempts(), 0, 'child reports must not race the failed-request recovery');
    options.idle = false;
    const recovered = await boundary('completed');
    assert.ok(recovered?.continue, 'a successful retry must reopen the report channel');
    assert.equal(h.job().reportDelivery, 'delivered');
    assert.equal(await boundary('completed'), undefined, 'recovery delivers each batch once');
  } finally { await h.close(); }
});

test("a successful turn-boundary delivery acknowledges the report once", { timeout: 30000 }, async () => {
  const h = await harness({ idle: false });
  try {
    assert.equal(h.wakeAttempts(), 0, "a busy parent must not deliver while idle");
    assert.equal(h.job().reportDelivery, "pending");
    const cancel = await h.tools.get('subagent_cancel').execute('cancel-finished', { jobId: h.job().id }, undefined, undefined, h.ctx);
    assert.ok(!cancel.isError, JSON.stringify(cancel));
    assert.equal(h.job().reportDelivery, 'pending', 'canceling an already finished child must not discard its pending terminal report');
    const boundary = await (h.handlers.get("turn_end") ?? [])[0]!({ outcome: "completed" }, h.ctx);
    assert.ok(boundary && Array.isArray((boundary as { entries?: unknown[] }).entries), JSON.stringify(boundary));
    assert.equal(h.job().reportDelivery, "delivered", "the boundary entry is a real delivery");
    // The drained notice is not replayed by a later boundary.
    const again = await (h.handlers.get("turn_end") ?? [])[0]!({ outcome: "completed" }, h.ctx);
    assert.equal(again, undefined);
    assert.equal(h.job().reportDelivery, "delivered");
  } finally { await h.close(); }
});
