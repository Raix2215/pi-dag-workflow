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
  const entries: any[] = [];
  let wakeAttempts = 0;
  const pi: any = {
    registerFlag() {},
    on(name: string, handler: Function) { const list = handlers.get(name) ?? []; list.push(handler); handlers.set(name, list); },
    registerTool(definition: { name: string }) { tools.set(definition.name, definition); },
    registerCommand() {},
    appendEntry(customType: string, data: unknown) { entries.push({ type: 'custom', customType, data }); },
    sendMessage(message: any) {
      wakeAttempts++; if (options.wakeFails) throw new Error("wake transport unavailable");
      entries.push({ type: 'custom_message', ...message });
      for (const handler of handlers.get('context') ?? []) handler({ messages: [{ role: 'custom', ...message }] }, ctx);
    },
    sendUserMessage() {},
    getFlag: (name: string) => name === "dag-workflow-test-child-provider" ? offline : undefined,
  };
  const ctx: any = {
    cwd: root,
    model: { provider: "dag-test", id: "scripted" },
    hasUI: true,
    isIdle: () => options.idle,
    modelRegistry: { find: (provider: string, id: string) => provider === "dag-test" && id === "scripted" ? { provider, id, reasoning: false, api: "dag-test-api" } : undefined },
    sessionManager: { getBranch: () => entries },
    ui: { notify: () => {}, confirm: async () => false },
  };
  const agents = registerAgents(pi, { state: () => state, mutate: () => {}, paint: () => {}, protected: () => false, canWake: () => true });
  for (const handler of handlers.get("session_start") ?? []) await handler({}, ctx);
  const spawned = await tools.get("subagent_spawn").execute("call", { task: "离线模拟交付" }, undefined, undefined, ctx);
  assert.ok(!spawned.isError, JSON.stringify(spawned));
  await until(() => agents.summaries().some((job) => job.status === "completed"));
  return {
    root, ctx, agents, handlers, tools,
    accept(boundary: any, visible = true) {
      entries.push(...boundary.entries);
      for (const handler of handlers.get('context') ?? []) handler({ messages: visible ? boundary.entries.map((entry: any) => ({ role: 'custom', ...entry })) : [] }, ctx);
    },
    wakeAttempts: () => wakeAttempts,
    job: () => agents.summaries().findLast((item) => item.status === "completed")!,
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

test('wake failures do not permanently block reports from future children after user takeover', { timeout: 30000 }, async () => {
  const options = { idle: true, wakeFails: true };
  const h = await harness(options);
  try {
    await delay(80);
    for (let index = 0; index < 2; index++) {
      await h.tools.get('subagent_spawn').execute(`retry-${index}`, { task: 'fresh child report' }, undefined, undefined, h.ctx);
      await until(() => h.agents.summaries().filter((job) => job.status === 'completed').length === index + 2);
      await delay(80);
    }
    assert.equal(h.wakeAttempts(), 3);
    options.wakeFails = false;
    for (const handler of h.handlers.get('input') ?? []) await handler({ source: 'rpc', text: 'continue new work' }, h.ctx);
    await h.tools.get('subagent_spawn').execute('new-work', { task: 'new child report' }, undefined, undefined, h.ctx);
    await until(() => h.agents.summaries().filter((job) => job.status === 'completed').length === 4);
    await delay(80);
    assert.equal(h.wakeAttempts(), 4);
    assert.equal(h.job().reportDelivery, 'delivered');
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
    assert.equal(h.job().reportDelivery, 'pending', 'a draft has not reached a real request');
    h.accept(recovered);
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
    assert.equal(h.job().reportDelivery, 'pending', 'a proposed entry can still be discarded');
    h.accept(boundary);
    assert.equal(h.job().reportDelivery, "delivered", "a context-visible entry is a real delivery");
    // The drained notice is not replayed by a later boundary.
    const again = await (h.handlers.get("turn_end") ?? [])[0]!({ outcome: "completed" }, h.ctx);
    assert.equal(again, undefined);
    assert.equal(h.job().reportDelivery, "delivered");
  } finally { await h.close(); }
});

test('a discarded boundary draft is retained and chaining preserves prior memory entries', { timeout: 30000 }, async () => {
  const h = await harness({ idle: false });
  try {
    const prior = { type: 'custom_message', customType: 'memory-test', content: 'baseline', display: false };
    const boundary = (h.handlers.get('turn_end') ?? [])[0]!;
    const lost = await boundary({ outcome: 'completed', entries: [prior] }, h.ctx);
    assert.equal(lost.entries[0], prior);
    assert.equal(h.job().reportDelivery, 'pending');
    // The host discarded these drafts: the session never saw them and no request ran.
    const retained = await boundary({ outcome: 'completed', entries: [prior] }, h.ctx);
    assert.equal(retained.entries[1].details.deliveryId, lost.entries[1].details.deliveryId);
    h.accept(retained);
    assert.equal(h.job().reportDelivery, 'delivered');
    assert.equal(await boundary({ outcome: 'completed', entries: [] }, h.ctx), undefined);
  } finally { await h.close(); }
});

test('a memory filter may omit a persisted report; it is never forced back into context', { timeout: 30000 }, async () => {
  const h = await harness({ idle: false });
  try {
    const boundary = (h.handlers.get('turn_end') ?? [])[0]!;
    const draft = await boundary({ outcome: 'completed', entries: [] }, h.ctx);
    h.accept(draft, false);
    assert.equal(h.job().reportDelivery, 'pending');
    assert.equal(await boundary({ outcome: 'completed', entries: [] }, h.ctx), undefined);
    const result = await h.tools.get('subagent_inspect').execute('read-filtered-report', { jobId: h.job().id, output: true }, undefined, undefined, h.ctx);
    assert.ok(!result.isError);
    assert.equal(h.job().reportDelivery, 'delivered', 'the durable result remains available for explicit inspection');
  } finally { await h.close(); }
});
