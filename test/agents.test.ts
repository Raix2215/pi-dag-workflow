import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, mkdir, rm, writeFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { AgentRuntime, resolvePiCli, type AgentNotice, type JobSummary } from "../src/agents/runtime.ts";
import { ProfileStore } from "../src/agents/profiles.ts";
import { takeProfilePrompt } from "../src/agents/child.ts";

const model = { provider: "dag-test", id: "scripted" };
const offline = fileURLToPath(new URL("./fixtures/offline-model.ts", import.meta.url));
const fixture = fileURLToPath(new URL("./fixtures/m2-rpc-fixture.mjs", import.meta.url));
const reportFixture = fileURLToPath(new URL("./fixtures/report-rpc-fixture.mjs", import.meta.url));
async function setup(fake = false, cli = fixture) {
  const root = await mkdtemp(join(tmpdir(), "pi-dag-m2-agents-"));
  const profiles = new ProfileStore({ registry: { find: (provider, id) => provider === model.provider && id === model.id ? model : undefined } });
  const notices: AgentNotice[] = [];
  const changes: JobSummary[][] = [];
  const runtime = new AgentRuntime({ cwd: root, profiles, getInheritedModel: () => model, childEnv: { HOME: root, PI_CODING_AGENT_DIR: join(root, "agent") }, ...(fake ? { testCliPath: cli } : { testExtensions: [offline] }), onNotice: (notice) => notices.push(notice), onChanged: (summaries) => changes.push(summaries) });
  return { root, runtime, profiles, notices, changes, close: async () => { await runtime.shutdown(); await rm(root, { recursive: true, force: true }); } };
}
const question = (text: string) => `TEST CALL subagent_send ${JSON.stringify({ message: text, question: true })}`;

test("CLI is resolved from installed package bin", () => { assert.match(resolvePiCli(), /pi-coding-agent.*dist\/bundle\/cli\.js$/); });

test("real offline Pi child completes, isolated resource discovery and no standalone job state", async () => {
  const ctx = await setup();
  try {
    await mkdir(join(ctx.root, ".pi", "extensions"), { recursive: true });
    await writeFile(join(ctx.root, ".pi", "extensions", "m2-unwanted.ts"), `import {writeFileSync} from 'node:fs'; export default function(){writeFileSync('unwanted-loaded','bad')}`);
    const job = await ctx.runtime.spawn({ task: "A private task not visible in inspect", todoId: 3 });
    const result = await ctx.runtime.wait(job.id, { timeout: 15 });
    assert.equal(result.status, "completed");
    assert.match(result.output, /离线模拟/);
    assert.equal(ctx.runtime.activeCount(), 0);
    assert.equal(ctx.notices.filter((notice) => notice.kind === "completed").length, 1);
    const inspection = JSON.stringify(ctx.runtime.inspect());
    assert.doesNotMatch(inspection, /private task|离线模拟|output|requestId/);
    assert.deepEqual(result.tools, ["read", "grep", "find", "ls"]);
    assert.ok(!(await readdir(ctx.root)).includes("unwanted-loaded"));
    assert.ok(!(await readdir(ctx.root)).some((name) => name.endsWith(".json") || name.endsWith(".jsonl")));
    await assert.rejects(ctx.runtime.send({ recipient: job.id, message: "Too late" }), /no longer active/);
  } finally { await ctx.close(); }
});

test("real child questions/requestId replies and reports travel through private RPC pipes", async () => {
  const ctx = await setup();
  try {
    const job = await ctx.runtime.spawn({ task: question("Which option should I use?") });
    const pending = await ctx.runtime.wait(job.id, { timeout: 15 });
    assert.equal(pending.status, "waiting");
    assert.equal(pending.requests.length, 1);
    const request = pending.requests[0]!;
    assert.equal(request.message, "Which option should I use?");
    assert.equal(ctx.notices.find((item) => item.kind === "question")?.requestId, request.requestId);
    await assert.rejects(ctx.runtime.send({ recipient: job.id, requestId: "wrong", message: "answer" }), /requestId/);
    await ctx.runtime.send({ recipient: job.id, requestId: request.requestId, message: "Use the safe option." });
    const completed = await ctx.runtime.wait(job.id, { timeout: 15 });
    assert.equal(completed.status, "completed");
    assert.match(completed.output, /Use the safe option/);
    assert.equal(completed.pendingRequests, 0);
    const reporting = await ctx.runtime.spawn({ task: 'TEST CALL subagent_send {"message":"Found a useful result"}' });
    const result = await ctx.runtime.wait(reporting.id, { timeout: 15 });
    assert.equal(result.status, "completed");
    assert.ok(ctx.notices.some((item) => item.kind === "message" && item.message === "Found a useful result"));
  } finally { await ctx.close(); }
});

test("real parent steering is delivered after a blocked tool batch, not as a new child", async () => {
  const ctx = await setup();
  try {
    const job = await ctx.runtime.spawn({ task: question("Please answer before continuing") });
    const pending = await ctx.runtime.wait(job.id, { timeout: 15 });
    await ctx.runtime.send({ recipient: job.id, message: "Parent steering after the full tool batch." });
    assert.equal(ctx.runtime.activeCount(), 1);
    await ctx.runtime.send({ recipient: job.id, requestId: pending.requests[0]!.requestId, message: "Proceed." });
    const result = await ctx.runtime.wait(job.id, { timeout: 15 });
    assert.equal(result.status, "completed");
    assert.match(result.output, /离线模拟/);
    assert.equal(ctx.runtime.inspect().length, 1);
  } finally { await ctx.close(); }
});

test("maximum reserved slots, duplicate todo blocked, no extra dispatch queue", async () => {
  const ctx = await setup(true);
  try {
    const started = [1, 2, 3, 4, 5, 6, 7, 8].map((todoId) => ctx.runtime.spawn({ task: "HOLD", todoId }));
    assert.equal(ctx.runtime.activeCount(), 8);
    await assert.rejects(ctx.runtime.spawn({ task: "HOLD" }), /All 8 agent slots/);
    const jobs = await Promise.all(started);
    await ctx.runtime.cancel(jobs[3]!.id);
    await assert.rejects(ctx.runtime.spawn({ task: "HOLD", todoId: 1 }), /already has an active/);
    assert.equal(ctx.runtime.inspect().length, 8);
    await ctx.runtime.cancel(jobs[0]!.id, { remove: true });
    assert.equal(ctx.runtime.inspect().length, 7);
    assert.throws(() => ctx.runtime.inspect(jobs[0]!.id), /Unknown agent/);
  } finally { await ctx.close(); }
});

test("wait deadlines and abort leave active process intact; cancellation removes pending questions", async () => {
  const ctx = await setup(true);
  try {
    const job = await ctx.runtime.spawn({ task: "HOLD" });
    const pending = await ctx.runtime.wait(job.id, { timeout: 0.03 });
    assert.equal(pending.timedOut, true);
    assert.equal(ctx.runtime.activeCount(), 1);
    const controller = new AbortController();
    const wait = ctx.runtime.wait(job.id, { signal: controller.signal });
    controller.abort();
    await assert.rejects(wait, /agent continues/);
    await ctx.runtime.cancel(job.id);
    assert.equal((await ctx.runtime.wait(job.id)).status, "cancelled");
    assert.equal(ctx.runtime.activeCount(), 0);
  } finally { await ctx.close(); }
});

test("agent_end alone and even settled with pending followups cannot complete a child", async () => {
  const ctx = await setup(true);
  try {
    const job = await ctx.runtime.spawn({ task: "INTERIM" });
    const interim = await ctx.runtime.wait(job.id, { timeout: 0.025 });
    assert.equal(interim.timedOut, true);
    assert.equal(interim.status, "running");
    const completed = await ctx.runtime.wait(job.id, { timeout: 2 });
    assert.equal(completed.status, "completed");
    assert.match(completed.output, /followup really finished/);
    assert.equal(ctx.notices.filter((item) => item.kind === "completed").length, 1);
  } finally { await ctx.close(); }
});

test("unexpected exit, model errors and malformed protocol all fail and clean up", async () => {
  const ctx = await setup(true);
  try {
    for (const task of ["EXIT", "ERROR", "BAD JSON"]) {
      const job = await ctx.runtime.spawn({ task });
      const result = await ctx.runtime.wait(job.id, { timeout: 3 });
      assert.equal(result.status, "failed", task);
      assert.equal(ctx.runtime.activeCount(), 0, task);
      if (task === "ERROR") assert.match(result.output, /partial retained|fixture model error/);
      assert.doesNotMatch(JSON.stringify(ctx.runtime.inspect(job.id)), /partial retained|fixture model error/);
    }
  } finally { await ctx.close(); }
});

test("startup failure and execution timeout cleanly fail while keeping full output", async () => {
  const ctx = await setup(true);
  try {
    const invalid = new AgentRuntime({ cwd: ctx.root, profiles: ctx.profiles, getInheritedModel: () => model, testCliPath: join(ctx.root, "m2-missing-cli.mjs") });
    try {
      const job = await invalid.spawn({ task: "test" });
      assert.equal((await invalid.wait(job.id, { timeout: 3 })).status, "failed");
      assert.equal(invalid.activeCount(), 0);
    } finally { await invalid.shutdown(); }
    const job = await ctx.runtime.spawn({ task: "HOLD", timeout: 0.08 });
    assert.equal((await ctx.runtime.wait(job.id, { timeout: 2 })).error, "Agent deadline exceeded");
    const huge = await ctx.runtime.spawn({ task: "HUGE" });
    const result = await ctx.runtime.wait(huge.id, { timeout: 2 });
    assert.equal(result.status, "completed");
    assert.equal(result.output, "🦊\u2028\u2029" + "bounded output ".repeat(12000) + "\n");
  } finally { await ctx.close(); }
});

test("long child reports and >1 MiB output are delivered and stored whole", async () => {
  const ctx = await setup(true, reportFixture);
  try {
    const report = await ctx.runtime.spawn({ task: "BIGREPORT" });
    const reportResult = await ctx.runtime.wait(report.id, { timeout: 15 });
    assert.equal(reportResult.status, "completed");
    assert.ok(reportResult.output.includes("r".repeat(1100000)));
    assert.equal(ctx.notices.find((item) => item.kind === "message")?.message, "r".repeat(1100000));

    const output = await ctx.runtime.spawn({ task: "BIGOUTPUT" });
    const outputResult = await ctx.runtime.wait(output.id, { timeout: 15 });
    assert.equal(outputResult.status, "completed");
    assert.equal(outputResult.output, "o".repeat(1100000) + "\n");
  } finally { await ctx.close(); }
});

test("export/import and full completion keep long child output and reports intact", async () => {
  const ctx = await setup(true, reportFixture);
  try {
    const job = await ctx.runtime.spawn({ task: "BIGOUTPUT" });
    const completed = await ctx.runtime.wait(job.id, { timeout: 15 });
    assert.equal(completed.output.length, 1100001);
    const records = ctx.runtime.exportRecords();
    assert.equal(records[0]!.output, "o".repeat(1100000) + "\n");
    const restored = new AgentRuntime({ cwd: ctx.root, profiles: ctx.profiles, getInheritedModel: () => model, testCliPath: join(ctx.root, "m2-cannot-spawn.mjs") });
    try {
      await restored.importSummaries(records);
      const restoredResult = await restored.wait(job.id);
      assert.equal(restoredResult.output, "o".repeat(1100000) + "\n");
    } finally { await restored.shutdown(); }
  } finally { await ctx.close(); }
});

test("child questions larger than the old 1 MiB cap round-trip through requestId replies", async () => {
  const ctx = await setup(true, reportFixture);
  try {
    const job = await ctx.runtime.spawn({ task: "BIGQUESTION" });
    const pending = await ctx.runtime.wait(job.id, { timeout: 15 });
    assert.equal(pending.status, "waiting");
    const request = pending.requests[0]!;
    assert.equal(request.message, "q".repeat(1100000));
    assert.equal(ctx.notices.find((item) => item.kind === "question")?.message, "q".repeat(1100000));
    await ctx.runtime.send({ recipient: job.id, requestId: request.requestId, message: "a".repeat(1100000) });
    const completed = await ctx.runtime.wait(job.id, { timeout: 15 });
    assert.equal(completed.status, "completed");
    assert.match(completed.output, /answered:1100000/);
  } finally { await ctx.close(); }
});

test("terminal reports stay pending until the parent context acknowledges delivery", async () => {
  const ctx = await setup(true);
  try {
    const job = await ctx.runtime.spawn({ task: "plain result" });
    const result = await ctx.runtime.wait(job.id, { timeout: 3 });
    assert.equal(result.status, "completed");
    assert.equal(result.reportDelivery, "pending");
    assert.equal(ctx.runtime.inspect(job.id)[0]!.reportDelivery, "pending");
    assert.equal(ctx.runtime.viewSummaries()[0]!.reportDelivery, "pending");
    assert.equal(ctx.runtime.markReportDelivered(job.id), true);
    assert.equal(ctx.runtime.inspect(job.id)[0]!.reportDelivery, "delivered");
    assert.equal(ctx.runtime.markReportDelivered(job.id), false, "acknowledgement is idempotent");
  } finally { await ctx.close(); }
});

test("cancelled and interrupted records carry no pending delivery acknowledgement", async () => {
  const ctx = await setup(true);
  try {
    const cancelled = await ctx.runtime.spawn({ task: "HOLD" });
    await ctx.runtime.cancel(cancelled.id);
    assert.equal(ctx.runtime.inspect(cancelled.id)[0]!.reportDelivery, undefined);
    assert.equal(ctx.runtime.markReportDelivered(cancelled.id), false);
    const active = await ctx.runtime.spawn({ task: "HOLD" });
    const records = ctx.runtime.exportRecords();
    const restored = new AgentRuntime({ cwd: ctx.root, profiles: ctx.profiles, getInheritedModel: () => model, testCliPath: join(ctx.root, "m2-cannot-spawn.mjs") });
    try {
      await restored.importSummaries(records);
      assert.equal(restored.inspect(active.id)[0]!.reportDelivery, undefined);
      assert.equal(restored.markReportDelivered(active.id), false);
    } finally { await restored.shutdown(); }
  } finally { await ctx.close(); }
});

test("restore preserves pending delivery without auto replay; manual wait acknowledges", async () => {
  const ctx = await setup(true);
  try {
    const job = await ctx.runtime.spawn({ task: "restored report" });
    await ctx.runtime.wait(job.id, { timeout: 3 });
    const records = ctx.runtime.exportRecords();
    assert.equal(records[0]!.reportDelivery, "pending");
    await assert.rejects(ctx.runtime.importSummaries([{ ...records[0]!, reportDelivery: "bogus" } as never]), /Invalid/);
    const restored = new AgentRuntime({ cwd: ctx.root, profiles: ctx.profiles, getInheritedModel: () => model, testCliPath: join(ctx.root, "m2-cannot-spawn.mjs") });
    try {
      await restored.importSummaries(records);
      assert.equal(restored.inspect(job.id)[0]!.reportDelivery, "pending");
      // Restoring never replays or starts work: the result stays pending until an explicit wait acks it.
      assert.equal((await restored.wait(job.id, { timeout: 0 })).reportDelivery, "pending");
      assert.equal(restored.markReportDelivered(job.id), true);
      assert.equal((await restored.wait(job.id, { timeout: 0 })).reportDelivery, "delivered");
    } finally { await restored.shutdown(); }
    // A terminal record without a delivery state never claims a pending report.
    const withoutDelivery = { ...records[0]! } as Record<string, unknown>;
    delete withoutDelivery.reportDelivery;
    const old = new AgentRuntime({ cwd: ctx.root, profiles: ctx.profiles, getInheritedModel: () => model, testCliPath: join(ctx.root, "m2-cannot-spawn.mjs") });
    try {
      await old.importSummaries([withoutDelivery as never]);
      assert.equal(old.inspect(job.id)[0]!.reportDelivery, undefined);
      assert.equal(old.markReportDelivered(job.id), false);
      assert.doesNotMatch(JSON.stringify(old.viewSummaries()), /reportDelivery/);
    } finally { await old.shutdown(); }
  } finally { await ctx.close(); }
});

test("recovery imports compact records, preserves stored output, interrupts active and never spawns", async () => {
  const ctx = await setup(true);
  try {
    const completed = await ctx.runtime.spawn({ task: "Result to keep" });
    await ctx.runtime.wait(completed.id, { timeout: 2 });
    const active = await ctx.runtime.spawn({ task: "HOLD" });
    const records = ctx.runtime.exportRecords();
    const restored = new AgentRuntime({ cwd: ctx.root, profiles: ctx.profiles, getInheritedModel: () => model, testCliPath: join(ctx.root, "m2-cannot-spawn.mjs") });
    try {
      await restored.importSummaries(records);
      assert.equal(restored.activeCount(), 0);
      assert.equal((await restored.wait(active.id)).status, "interrupted");
      assert.equal((await restored.wait(completed.id)).output, "Result to keep\n");
      assert.equal(restored.inspect().length, 2);
      assert.equal(restored.inspect().every((job) => job.pendingRequests === 0), true);
      await assert.rejects(restored.importSummaries([{ ...records[0]!, id: "bad" }]), /Invalid/);
      assert.equal(restored.inspect().length, 2);
      const priorNotices = ctx.notices.length;
      await ctx.runtime.importSummaries(records);
      assert.equal(ctx.runtime.activeCount(), 0);
      assert.equal(ctx.runtime.inspect(active.id)[0]!.status, "interrupted");
      assert.equal(ctx.notices.length, priorNotices);
    } finally { await restored.shutdown(); }
  } finally { await ctx.close(); }
});

test("builtin model bootstrap uses in-memory credentials with a real loopback provider, no auth files", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-dag-m2-bootstrap-"));
  let requests = 0;
  let authorization: string | undefined;
  const server = createServer((request, response) => {
    requests++; authorization = request.headers.authorization;
    request.resume();
    request.on("end", () => {
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      const chunk = { id: "m2-response", object: "chat.completion.chunk", created: 1, model: "m2-local", choices: [{ index: 0, delta: { role: "assistant", content: "Loopback bootstrap succeeded" }, finish_reason: null }] };
      response.write(`data: ${JSON.stringify(chunk)}\n\n`);
      response.write(`data: ${JSON.stringify({ ...chunk, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`);
      response.end("data: [DONE]\n\n");
    });
  });
  await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const ref = { provider: "m2-local", id: "m2-local" };
  const definition = { ...ref, name: "Local deterministic test", api: "openai-completions", baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 65536, maxTokens: 1024 };
  const profiles = new ProfileStore({ registry: { find: () => definition } });
  const runtime = new AgentRuntime({ cwd: root, profiles, getInheritedModel: () => ref, childEnv: { HOME: root, PI_CODING_AGENT_DIR: join(root, "agent") }, getModelBootstrap: async () => ({ model: definition, apiKey: "m2-secret-never-on-disk" }) });
  try {
    const job = await runtime.spawn({ task: "Return the test response." });
    const result = await runtime.wait(job.id, { timeout: 15 });
    assert.equal(result.status, "completed", result.output);
    assert.match(result.output, /Loopback bootstrap succeeded/);
    assert.equal(requests, 1);
    assert.equal(authorization, "Bearer m2-secret-never-on-disk");
    assert.doesNotMatch(JSON.stringify(runtime.exportRecords()), /m2-secret/);
    async function scan(path: string): Promise<void> {
      const { readFile } = await import("node:fs/promises");
      for (const entry of await readdir(path, { withFileTypes: true })) {
        const file = join(path, entry.name);
        if (entry.isDirectory()) await scan(file);
        else assert.doesNotMatch(await readFile(file, "utf8"), /m2-secret-never-on-disk/);
      }
    }
    await scan(root);
  } finally { await runtime.shutdown(); await new Promise<void>((resolveClose) => server.close(() => resolveClose())); await rm(root, { recursive: true, force: true }); }
});

test("cancelling during model bootstrap never creates a process when callback resolves later", async () => {
  const ctx = await setup(true);
  let release!: (value: { model: Record<string, unknown> }) => void;
  const deferred = new Promise<{ model: Record<string, unknown> }>((resolveBootstrap) => { release = resolveBootstrap; });
  const runtime = new AgentRuntime({ cwd: ctx.root, profiles: ctx.profiles, getInheritedModel: () => model, testCliPath: join(ctx.root, "m2-missing-cli.mjs"), getModelBootstrap: () => deferred });
  try {
    const spawn = runtime.spawn({ task: "Bootstrap still pending" });
    const job = runtime.inspect()[0]!;
    await runtime.cancel(job.id);
    assert.equal(runtime.activeCount(), 0);
    release({ model });
    assert.equal((await spawn).status, "cancelled");
    assert.equal(runtime.inspect(job.id)[0]!.status, "cancelled");
  } finally { await runtime.shutdown(); await ctx.close(); }
});

test("Unix process-group cancellation kills tool descendants even if they ignore TERM", { skip: process.platform === "win32" }, async () => {
  const ctx = await setup(true);
  try {
    const job = await ctx.runtime.spawn({ task: "DESCENDANT" });
    const result = await ctx.runtime.wait(job.id, { timeout: 0.1 });
    const pid = Number(/descendant=(\d+)/.exec(result.output)?.[1]);
    assert.ok(Number.isSafeInteger(pid) && pid > 0);
    process.kill(pid, 0);
    await ctx.runtime.cancel(job.id);
    let gone = false;
    for (let attempt = 0; attempt < 30; attempt++) {
      try { process.kill(pid, 0); } catch { gone = true; break; }
      // Containers sometimes keep a zombie until their init reaps it; zombie is not executing.
      try { const { readFile } = await import("node:fs/promises"); if (/\) Z /.test(await readFile(`/proc/${pid}/stat`, "utf8"))) { gone = true; break; } } catch { gone = true; break; }
      await delay(20);
    }
    assert.equal(gone, true);
    assert.equal(ctx.runtime.activeCount(), 0);
  } finally { await ctx.close(); }
});

test("the panel label is one bounded line of the spawn task and restore sanitizes foreign text", async () => {
  const ctx = await setup(true);
  try {
    const dirty = `第一行\n第二行\u0007\u001b[31m红\u001b[0m ${"长".repeat(120)}`;
    const job = await ctx.runtime.spawn({ task: dirty });
    const label = ctx.runtime.viewSummaries()[0]!.label!;
    assert.match(label, /^第一行 第二行红/);
    assert.doesNotMatch(label, /[\r\n\u0007\u001b]|\[31m|\[0m/);
    assert.equal(label.length, 80);
    // The model-facing inspect stays private-safe; only persistence and the panel keep the excerpt.
    assert.equal("label" in ctx.runtime.inspect(job.id)[0]!, false);
    assert.equal(ctx.runtime.exportSummaries()[0]!.label, label);
    assert.equal(ctx.runtime.viewSummaries()[0]!.label, label);
    const records = ctx.runtime.exportRecords();
    const restored = new AgentRuntime({ cwd: ctx.root, profiles: ctx.profiles, getInheritedModel: () => model, testCliPath: join(ctx.root, "m2-cannot-spawn.mjs") });
    try {
      await restored.importSummaries([{ ...records[0]!, label: "跨行\n\u001b[32m标签" } as never]);
      assert.equal(restored.viewSummaries()[0]!.label, "跨行 标签");
      // A record without a label restores without one.
      const bare = new AgentRuntime({ cwd: ctx.root, profiles: ctx.profiles, getInheritedModel: () => model, testCliPath: join(ctx.root, "m2-cannot-spawn.mjs") });
      try {
        const { label: _dropped, ...withoutLabel } = records[0]!;
        await bare.importSummaries([withoutLabel as never]);
        assert.equal("label" in bare.viewSummaries()[0]!, false);
      } finally { await bare.shutdown(); }
    } finally { await restored.shutdown(); }
  } finally { await ctx.close(); }
});

test("profile instructions reach the child process through the environment exactly once", async () => {
  const ctx = await setup(true);
  try {
    ctx.profiles.set({ name: "browser", model, instructions: "Stay read-only unless the task says otherwise." });
    const job = await ctx.runtime.spawn({ task: "ENV:PI_DAG_AGENT_PROFILE_PROMPT", profile: "browser" });
    const result = await ctx.runtime.wait(job.id, { timeout: 5 });
    assert.match(result.output, /env PI_DAG_AGENT_PROFILE_PROMPT=Stay read-only unless the task says otherwise\./);
    // A profile without instructions leaves the variable unset, so children inherit no guidance.
    const plain = await ctx.runtime.spawn({ task: "ENV:PI_DAG_AGENT_PROFILE_PROMPT" });
    assert.match((await ctx.runtime.wait(plain.id, { timeout: 5 })).output, /env PI_DAG_AGENT_PROFILE_PROMPT=\s*$/);
  } finally { await ctx.close(); }
});

test("interim reports are counted per job so a bound task can be closed", async () => {
  const ctx = await setup(true, reportFixture);
  try {
    const reported = await ctx.runtime.spawn({ task: "REPORT" });
    await ctx.runtime.wait(reported.id, { timeout: 5 });
    assert.equal(ctx.runtime.reports(reported.id), 1);
    assert.equal(ctx.runtime.reports("a404"), 0);
    const silent = await ctx.runtime.spawn({ task: "SILENT" });
    await ctx.runtime.wait(silent.id, { timeout: 5 });
    assert.equal(ctx.runtime.reports(silent.id), 0);
  } finally { await ctx.close(); }
});

test("a fragment brief reaches the child process and nothing is sent when unset", async () => {
  const ctx = await setup(true);
  try {
    const briefed = await ctx.runtime.spawn({ task: "ENV:PI_DAG_AGENT_CONTEXT", context: "Fragment browser-check run 1, step 2 of 3" });
    assert.match((await ctx.runtime.wait(briefed.id, { timeout: 5 })).output, /env PI_DAG_AGENT_CONTEXT=Fragment browser-check run 1, step 2 of 3/);
    const plain = await ctx.runtime.spawn({ task: "ENV:PI_DAG_AGENT_CONTEXT" });
    assert.match((await ctx.runtime.wait(plain.id, { timeout: 5 })).output, /env PI_DAG_AGENT_CONTEXT=\s*$/);
  } finally { await ctx.close(); }
});

test("the child reads its profile instructions once and removes them from its environment", () => {
  const env: NodeJS.ProcessEnv = { PI_DAG_AGENT_PROFILE_PROMPT: "Use the Chrome bridge over curl." };
  assert.equal(takeProfilePrompt(env), "Use the Chrome bridge over curl.");
  assert.equal("PI_DAG_AGENT_PROFILE_PROMPT" in env, false, "a leftover variable would leak to further child processes");
  assert.equal(takeProfilePrompt({}), undefined);
  assert.equal(takeProfilePrompt({ PI_DAG_AGENT_PROFILE_PROMPT: "   " }), undefined);
});
