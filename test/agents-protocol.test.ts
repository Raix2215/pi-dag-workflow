import { emptyState, STATE_TYPE, type WorkflowState, AGENTS_TYPE, PLAN_TYPE, type PlanState } from './fixtures/public-records.ts';
import assert from "node:assert/strict";
import { test, after } from "node:test";
import { mkdtemp, mkdir, rm, writeFile, open } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { loadPublic, recordPanels } from './fixtures/public-host.ts';


import { IsolatedClient } from "./fixtures/isolated-client.ts";
import { retainedJobs as foldAgentEntries } from './fixtures/public-records.ts';
import { protocolHost } from './fixtures/agents-protocol-host.ts';
import { readFile } from "node:fs/promises";
import { stripTerminalSequences } from "@earendil-works/pi-tui";

import { Value } from "typebox/value";

{
const offline = fileURLToPath(new URL("./fixtures/offline-model.ts", import.meta.url));
const controls = fileURLToPath(new URL("./fixtures/session-controls.ts", import.meta.url));
const freshStart = (root?: string) => IsolatedClient.start(root, "m2-parent", [controls], ["--dag-workflow-test-child-provider", offline]);
let shared: IsolatedClient | undefined;
after(async () => { await shared?.close(); });
async function start() {
  if (!shared) shared = await freshStart();
  else { await shared.send('new_session'); shared.records.length = 0; }
  return shared;
}
async function call(client: IsolatedClient, name: string, args: unknown) {
  const events = await client.prompt(`TEST CALL ${name} ${JSON.stringify(args)}`);
  const event = events.find((item) => item.type === "tool_execution_end" && item.toolName === name);
  assert.ok(event, `expected ${name}`);
  return event.result as { isError?: boolean; details: Record<string, any>; content: { text: string }[] };
}
const state = (entries: unknown[]) => (entries as { customType?: string; data?: WorkflowState }[]).findLast((entry) => entry.customType === STATE_TYPE)!.data!;
const planState = (entries: unknown[]) => (entries as { customType?: string; data?: PlanState }[]).findLast((entry) => entry.customType === PLAN_TYPE)?.data;
const widgets = (client: IsolatedClient) => client.records.filter((item) => item.method === "setWidget").flatMap((item) => (item.widgetLines as string[] | undefined) ?? []).map(stripTerminalSequences).join("\n");

test("actual Pi delegates an unblocked Todo, shows real waiting/profile state, guards edits/Plan, replies, and requires explicit Todo completion", { timeout: 30000 }, async () => {
  const client = await start();
  await client.prompt("开始M2离线验收");
  await client.prompt("/todos add 调查入口");
  await client.prompt("/todos add 下游任务 --after 1");
  let result = await call(client, "subagent_spawn", { task: "blocked", todoId: 2 });
  assert.equal(result.isError, true); assert.match(result.content[0]!.text, /前置未完成|只能派发/);
  await client.prompt("/agents profile research dag-test/scripted off read,grep,find,ls");
  result = await call(client, "subagent_spawn", { task: 'TEST CALL subagent_send {"message":"请选择方向","question":true}', todoId: 1, profile: "research" });
  assert.ok(!result.isError, JSON.stringify(result));
  const jobId = result.details.jobId as string;
  result = await call(client, "subagent_inspect", { jobId, output: true, timeout: 10 });
  assert.equal(result.details.status, "waiting");
  const requestId = result.details.requests[0].requestId;
  assert.match(widgets(client), /a1 · research/); assert.match(widgets(client), /等待回复/);
  const inspect = await call(client, "subagent_inspect", { jobId, profiles: 'summary' });
  assert.doesNotMatch(JSON.stringify(inspect.details.jobs), /\"output\"|\"requests\"/);
  assert.equal(inspect.details.jobs[0].questions[0].message, '请选择方向');
  assert.equal(inspect.details.jobs[0].questions[0].requestId, requestId);
  assert.equal(inspect.details.jobs[0].phase, 'waiting');
  assert.equal(inspect.details.profiles[0].name, "research");
  await client.prompt("/plan start");
  assert.equal(planState(await client.entries())?.enabled ?? false, false);
  assert.ok(client.records.some((item) => item.method === "notify" && typeof item.message === "string" && item.message.includes("子 Agent 仍在执行")));
  result = await call(client, "todo", { action: "update", id: 1, status: "completed" });
  assert.equal(result.isError, true);
  result = await call(client, "todo", { action: "update", id: 1, subject: "新调查范围" });
  assert.equal(result.isError, true);
  await call(client, "subagent_send", { recipient: jobId, message: "调整为新调查范围，完成后报告实际检查" });
  result = await call(client, "todo", { action: "update", id: 1, subject: "新调查范围" });
  assert.ok(!result.isError);
  result = await call(client, "subagent_send", { requestId, message: "只做只读调查" });
  assert.ok(!result.isError, JSON.stringify(result));
  result = await call(client, "subagent_inspect", { jobId, output: true, timeout: 10 });
  assert.equal(result.details.status, "completed");
  assert.match(result.details.output, /离线模拟/);
  assert.ok(!result.details.requests.length);
  assert.equal(state(await client.entries()).tasks[0]!.status, "in_progress");
  result = await call(client, "todo", { action: "update", id: 1, status: "completed" }); assert.ok(!result.isError);
  await client.prompt("/plan start"); assert.equal(planState(await client.entries())!.enabled, true);
  result = await call(client, "subagent_spawn", { task: "forbidden" }); assert.match(result.content[0]!.text, /Plan/);
  result = await call(client, "subagent_inspect", {}); assert.ok(!result.isError);
});

test("actual Pi cancels/removes jobs, preserves terminal output on reload and never revives old processes", { timeout: 30000 }, async (t) => {
  let client = await freshStart(); t.after(() => client.close());
  await client.prompt("开始持久化验收");
  let result = await call(client, "subagent_spawn", { task: "完成只读调查" });
  const done = result.details.jobId;
  result = await call(client, "subagent_inspect", { jobId: done, output: true, timeout: 10 });
  const output = result.details.output; assert.equal(result.details.status, "completed");
  result = await call(client, "subagent_spawn", { task: 'TEST CALL subagent_send {"message":"等待暂停","question":true}' });
  const pending = result.details.jobId;
  await call(client, "subagent_inspect", { jobId: pending, output: true, timeout: 10 });
  await client.prompt("/test-reload");
  let jobs = (await call(client, "subagent_inspect", {})).details.jobs;
  assert.equal(jobs.find((job: any) => job.id === pending).status, "interrupted");
  result = await call(client, "subagent_inspect", { jobId: done, output: true, timeout: 0 }); assert.equal(result.details.output, output);
  await call(client, "subagent_cancel", { jobId: pending, remove: true });
  jobs = (await call(client, "subagent_inspect", {})).details.jobs; assert.equal(jobs.length, 1);
  const entries = await client.entries(); assert.ok(entries.some((entry: any) => entry.customType === AGENTS_TYPE));
  await client.close(false); client = await freshStart(client.root);
  assert.ok(!client.records.some((item) => item.type === "agent_start"));
  result = await call(client, "subagent_inspect", { jobId: done, output: true, timeout: 0 }); assert.equal(result.details.output, output);
});

test("actual Pi consumes wait results without duplicate auto reports and suppresses paused old wakes", { timeout: 30000 }, async () => {
  const client = await start();
  const result = await call(client, "subagent_spawn", { task: 'TEST CALL subagent_send {"message":"请求核验","question":true}' });
  const jobId = result.details.jobId;
  const pending = await call(client, "subagent_inspect", { jobId, output: true, timeout: 10 });
  assert.equal(pending.details.status, "waiting");
  assert.match(JSON.stringify(pending.details.requests), /请求核验/);
  const entries = await client.entries();
  const reports = entries.filter((item: any) => item.type === "custom_message" && item.customType === AGENT_REPORT_MESSAGE) as any[];
  // The wait tool result already carries the question into model context; no duplicate automatic report.
  assert.ok(!JSON.stringify(reports).includes("请求核验"), JSON.stringify(entries));
  await client.prompt("/agents pause");
  await client.prompt(`/agents reply ${pending.details.requests[0].requestId} 完成即可`);
  await client.until(() => client.records.some((item) => item.type === "entry_appended" && (item.entry as any)?.data?.jobs?.some((job: any) => job.id === jobId && job.status === "completed")));
  const after = client.records.length;
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.ok(!client.records.slice(after).some((item) => item.type === "agent_start"));
});

test("actual Pi keeps paused terminal reports pending until an explicit wait acknowledges delivery", { timeout: 30000 }, async () => {
  const client = await start();
  const jobs = (entries: unknown[]) => foldAgentEntries(entries).records as any[];
  const result = await call(client, "subagent_spawn", { task: "完成只读调查" });
  const jobId = result.details.jobId;
  await client.prompt("/agents pause");
  await client.until(() => client.records.some((item) => item.type === "entry_appended" && (item.entry as any)?.data?.jobs?.some((job: any) => job.id === jobId && job.status === "completed")));
  assert.equal(jobs(client.records.filter((item) => item.type === "entry_appended").map((item) => (item as any).entry)).find((job) => job.id === jobId)!.reportDelivery, "pending");
  // A UI-only /agents wait never enters model context and must not acknowledge the report.
  await client.prompt(`/agents wait ${jobId}`);
  assert.equal(jobs(await client.entries()).find((job) => job.id === jobId)!.reportDelivery, "pending");
  const waited = await call(client, "subagent_inspect", { jobId, output: true, timeout: 0 });
  assert.equal(waited.details.status, "completed");
  assert.equal(waited.details.reportDelivery, "delivered");
  await client.until(() => client.records.some((item) => item.type === "entry_appended" && (item.entry as any)?.data?.jobs?.some((job: any) => job.id === jobId && job.reportDelivery === "delivered")));
  assert.equal(jobs(await client.entries()).find((job) => job.id === jobId)!.reportDelivery, "delivered");
});

test("actual Pi delivers an idle terminal report automatically and marks it delivered once", { timeout: 30000 }, async () => {
  const client = await start();
  const jobs = (entries: unknown[]) => foldAgentEntries(entries).records as any[];
  const result = await call(client, "subagent_spawn", { task: 'TEST CALL subagent_send {"message":"自动交付报告"}' });
  const jobId = result.details.jobId;
  await client.until(() => client.records.some((item) => item.type === "entry_appended" && (item.entry as any)?.data?.jobs?.some((job: any) => job.id === jobId && job.reportDelivery === "delivered")));
  const entries = await client.entries();
  const reports = entries.filter((entry: any) => entry.customType === AGENT_REPORT_MESSAGE);
  assert.ok(reports.length, JSON.stringify(entries));
  assert.match(JSON.stringify(reports), /自动交付报告/);
  assert.equal(jobs(entries).find((job) => job.id === jobId)!.reportDelivery, "delivered");
});

test("actual Pi lists a child spawned without a Todo in its own panel section until its report is delivered", { timeout: 30000 }, async () => {
  const client = await start();
  const lastWidget = () => {
    const record = client.records.findLast((item) => item.method === "setWidget" && Array.isArray(item.widgetLines));
    return ((record?.widgetLines as string[] | undefined) ?? []).map(stripTerminalSequences).join("\n");
  };
  await client.prompt("开始游离子 Agent 验收");
  const result = await call(client, "subagent_spawn", { task: "调研不需要绑定任务的场景" });
  assert.ok(!result.isError, JSON.stringify(result));
  const jobId = result.details.jobId as string;
  assert.match(widgets(client), /Standalone Agents · 1/);
  assert.match(widgets(client), new RegExp(`${jobId} · scripted`));
  assert.match(widgets(client), /调研不需要绑定任务的场景/);
  const waited = await call(client, "subagent_inspect", { jobId, output: true, timeout: 10 });
  assert.equal(waited.details.status, "completed");
  // The wait hands the report to this context, so nothing is left for the section to carry.
  await client.prompt("/todos list");
  assert.doesNotMatch(lastWidget(), /Standalone/);
});
}

{
const model = { provider: 'dag-test', id: 'scripted' };
const setup = () => protocolHost();
async function until(check: () => boolean) {
  const deadline = Date.now() + 10000;
  while (!check()) { if (Date.now() > deadline) throw new Error('Child observation timed out'); await delay(10); }
}

test('real Pi: a temporary environment selects model, thinking and skill without a saved profile', { timeout: 30000 }, async (t) => {
  const h = await setup(); t.after(h.close);
  await writeFile(join(h.root, 'review.md'), 'TEMPORARY-SKILL-CONTENT');
  const job = await h.call('subagent_spawn', { task: 'TEST SELECTED SKILL', model: { provider: model.provider, id: 'reasoned' }, thinking: 'low', tools: ['read'], skills: ['./review.md'], timeout: 20 });
  const result = await h.call('subagent_inspect', { jobId: job.jobId, output: true, until: 'finish', timeout: 15 });
  assert.equal(result.status, 'completed', result.output);
  assert.equal(result.model.id, 'reasoned'); assert.equal(result.thinking, 'low');
  assert.deepEqual(result.skills, [join(h.root, 'review.md')]);
  assert.match(result.output, /TEMPORARY-SKILL-CONTENT/);
  assert.deepEqual((await h.call('subagent_inspect', { profiles: true })).profiles, []);
});

test('real Pi: granting tools preserves the same job and question context, and applies before the next request', { timeout: 30000 }, async (t) => {
  const h = await setup(); t.after(h.close);
  const job = await h.call('subagent_spawn', { task: 'CONTROL QUESTION', tools: ['read'], timeout: 20 });
  await until(() => h.jobs().find(item => item.id === job.jobId)?.status === 'waiting');
  const requestId = h.jobs().find(item => item.id === job.jobId)!.requests[0].requestId;
  await assert.rejects(h.call('subagent_send', { recipient: job.jobId, message: 'invalid', tools: ['read', 'write'] }), /interrupt/);
  assert.equal(h.jobs().find(item => item.id === job.jobId)!.requests.some((request: any) => request.requestId === requestId), true, 'invalid input must not cancel the question');
  const sent = await h.call('subagent_send', { recipient: job.jobId, message: 'CONTROL REDIRECT QUESTION', tools: ['read', 'write'], interrupt: true });
  assert.equal(sent.interrupted, true); assert.deepEqual(sent.tools, ['read', 'write']);
  const result = await h.call('subagent_inspect', { jobId: job.jobId, output: true, until: 'finish', timeout: 10 });
  assert.equal(result.status, 'completed', result.output); assert.deepEqual(result.tools, ['read', 'write']);
  assert.equal(await readFile(join(h.root, 'redirect-question.txt'), 'utf8'), 'CONTROL-SELF-DECIDED');
  assert.equal((await h.call('subagent_inspect', {})).jobs.length, 1); assert.equal(h.jobs().find(item => item.id === job.jobId)!.requests.some((request: any) => request.requestId === requestId), false);
  const contexts = (await readFile(h.log, 'utf8')).trim().split('\n').map((line) => JSON.parse(line)).filter((record) => record.type === 'input').map((record) => record.context);
  const declaredTools = (context: { messages: { role: string; toolsAdded?: { name: string }[]; toolsRemoved?: string[] }[] }) => {
    const names = new Set<string>();
    for (const message of context.messages) if (message.role === 'system') {
      for (const name of message.toolsRemoved ?? []) names.delete(name);
      for (const tool of message.toolsAdded ?? []) names.add(tool.name);
    }
    return [...names].sort();
  };
  assert.deepEqual(declaredTools(contexts[0]), ['read', 'subagent_send']);
  assert.deepEqual(declaredTools(contexts.at(-1)), ['read', 'subagent_send', 'write']);
  assert.doesNotMatch(JSON.stringify(contexts), /pi-dag-child-control:|pi-dag-child-tools:|PI_DAG_AGENT_CONTROL/);
});

test('real Pi: unselected registered tools cannot write; removing a tool also prevents the next write', { timeout: 30000 }, async (t) => {
  const h = await setup(); t.after(h.close);
  const denied = await h.call('subagent_spawn', { task: 'TEST CALL write {"path":"denied.txt","content":"NO"}', tools: ['read'], timeout: 20 });
  const first = await h.call('subagent_inspect', { jobId: denied.jobId, output: true, until: 'finish', timeout: 10 });
  assert.equal(first.status, 'completed', first.output);
  await assert.rejects(readFile(join(h.root, 'denied.txt')), { code: 'ENOENT' });
  const job = await h.call('subagent_spawn', { task: 'CONTROL QUESTION', tools: ['read', 'write'], timeout: 20 });
  await until(() => h.jobs().find(item => item.id === job.jobId)?.status === 'waiting');
  await h.call('subagent_send', { recipient: job.jobId, message: 'TEST CALL write {"path":"revoked.txt","content":"NO"}', tools: ['read'], interrupt: true });
  const result = await h.call('subagent_inspect', { jobId: job.jobId, output: true, until: 'finish', timeout: 10 });
  assert.equal(result.status, 'completed', result.output); assert.deepEqual(result.tools, ['read']);
  await assert.rejects(readFile(join(h.root, 'revoked.txt')), { code: 'ENOENT' });
});

test('real Pi: actual configuration survives profile deletion and journal restore, including instructions and empty skills', { timeout: 30000 }, async (t) => {
  const h = await setup(); t.after(h.close);
  await writeFile(join(h.root, 'review.md'), 'SAVED-SKILL');
  await h.profiles([{ name: 'reviewer', model: { provider: model.provider, id: 'reasoned' }, thinking: 'low', tools: ['read'], skills: ['./review.md'], instructions: 'ORIGINAL-PROFILE-GUIDANCE' }]);
  const old = await h.call('subagent_spawn', { task: 'CONTROL QUESTION', profile: 'reviewer', timeout: 20 });
  await until(() => h.jobs().find(item => item.id === old.jobId)?.status === 'waiting');
  await h.call('subagent_cancel', { jobId: old.jobId });
  await h.profiles([]);
  await h.emit('session_tree');
  const resumed = await h.call('subagent_spawn', { task: 'TEST SELECTED SKILL', resumeFrom: old.jobId, skills: [], timeout: 20 });
  const result = await h.call('subagent_inspect', { jobId: resumed.jobId, output: true, until: 'finish', timeout: 10 });
  assert.equal(result.status, 'completed', result.output); assert.equal(result.model.id, 'reasoned'); assert.equal(result.thinking, 'low');
  assert.deepEqual(result.skills, []); assert.doesNotMatch(result.output, /SAVED-SKILL/);
  assert.equal(h.jobs().find(item => item.id === resumed.jobId)!.profileInstructions, 'ORIGINAL-PROFILE-GUIDANCE');
  assert.doesNotMatch(JSON.stringify((await h.call('subagent_inspect', { jobId: resumed.jobId })).jobs), /ORIGINAL-PROFILE-GUIDANCE/);
});

for (const payload of ['{"token":"wrong-token","nonce":"private-nonce","tools":["write"]}', '{malformed-control']) test(`real Pi: rejected private control never reaches the model (${payload.startsWith('{malformed') ? 'malformed' : 'wrong token'})`, { timeout: 30000 }, async (t) => {
  const h = await setup(); t.after(h.close);
  const job = await h.call('subagent_spawn', { task: 'CONTROL QUESTION', tools: ['read'], timeout: 20 });
  await until(() => h.jobs().find(item => item.id === job.jobId)?.status === 'waiting');
  await assert.rejects(h.call('subagent_send', { recipient: job.jobId, message: 'pi-dag-child-control:' + payload, interrupt: true }), /without a model run/);
  assert.equal(h.jobs().find(item => item.id === job.jobId)!.status, 'failed');
  const contexts = await readFile(h.log, 'utf8');
  assert.doesNotMatch(contexts, /pi-dag-child-control:|wrong-token|private-nonce|malformed-control/);
  assert.deepEqual(h.jobs().find(item => item.id === job.jobId)!.tools, ['read']);
});

test('real Pi: restoring a snapshot and temporary dispatch do not depend on unrelated broken Profiles', { timeout: 30000 }, async (t) => {
  const offline = new URL('./fixtures/offline-model.ts', import.meta.url).pathname;
  const client = await IsolatedClient.start(undefined, 'snapshot-broken-profile', [], ['--dag-workflow-test-child-provider', offline]);
  t.after(() => client.close());
  const call = async (name: string, params: object, expectError = false) => {
    const events = await client.prompt(`TEST CALL ${name} ${JSON.stringify(params)}`);
    const end = events.find((event) => event.type === 'tool_execution_end' && event.toolName === name)!;
    assert.ok(end); assert.equal(Boolean(end.isError || (end.result as any).isError), expectError, JSON.stringify(end.result));
    return (end.result as any).details;
  };
  const original = await call('subagent_spawn', { task: 'Original snapshot', tools: ['read'], skills: [] });
  await call('subagent_inspect', { jobId: original.jobId, output: true, until: 'finish', timeout: 10 });
  await mkdir(join(client.root, 'agent/pi-dag-workflow'), { recursive: true });
  await writeFile(join(client.root, 'agent/pi-dag-workflow/pi-dag-workflow-profile.json'), JSON.stringify({ profiles: [{ name: 'unrelated', model: { provider: 'unknown', id: 'removed' } }] }));
  const state = (await client.send('get_state')).data as { sessionFile: string };
  await client.send('switch_session', { sessionPath: state.sessionFile });
  const resumed = await call('subagent_spawn', { resumeFrom: original.jobId, task: 'Check saved snapshot' });
  const result = await call('subagent_inspect', { jobId: resumed.jobId, output: true, until: 'finish', timeout: 10 });
  assert.equal(result.status, 'completed'); assert.deepEqual(result.tools, ['read']);
  const temporary = await call('subagent_spawn', { task: 'Temporary work', tools: [], skills: [] });
  assert.deepEqual(temporary.tools, []);
  await call('subagent_inspect', { profile: 'unrelated' }, true);
});

test('real Pi workflow: temporary dispatch, parent-approved live tools, report verification and Todo completion', { timeout: 30000 }, async (t) => {
  const offline = new URL('./fixtures/offline-model.ts', import.meta.url).pathname;
  const client = await IsolatedClient.start(undefined, 'temporary-child-workflow', [], ['--dag-workflow-test-child-provider', offline]);
  t.after(() => client.close());
  await writeFile(join(client.root, 'review.md'), 'WORKFLOW-SKILL');
  const call = async (name: string, params: object) => {
    const events = await client.prompt(`TEST CALL ${name} ${JSON.stringify(params)}`);
    const end = events.find((event) => event.type === 'tool_execution_end' && event.toolName === name)!;
    assert.ok(end); assert.ok(!end.isError && !(end.result as any).isError, JSON.stringify(end.result));
    return (end.result as any).details;
  };
  const models = await call('subagent_inspect', { models: true, query: 'reasoned' });
  assert.equal(models.total, 1);
  await call('todo', { action: 'create', subject: 'Temporary child work', description: 'Produce and verify the requested artifact' });
  const spawned = await call('subagent_spawn', { todoId: 1, task: 'CONTROL QUESTION', model: { provider: models.models[0].provider, id: models.models[0].id }, thinking: 'low', tools: ['read'], skills: ['./review.md'] });
  assert.equal(spawned.model.id, 'reasoned'); assert.deepEqual(spawned.tools, ['read']); assert.deepEqual(spawned.skills, [join(client.root, 'review.md')]);
  const question = await call('subagent_inspect', { jobId: spawned.jobId, output: true, until: 'update', timeout: 10 });
  assert.equal(question.status, 'waiting'); assert.equal(question.questions?.length ?? question.requests.length, 1);
  const sent = await call('subagent_send', { recipient: spawned.jobId, interrupt: true, tools: ['read', 'write'], message: 'CONTROL REDIRECT QUESTION' });
  assert.deepEqual(sent.tools, ['read', 'write']);
  const result = await call('subagent_inspect', { jobId: spawned.jobId, output: true, until: 'finish', timeout: 10 });
  assert.equal(result.status, 'completed'); assert.equal(result.todoStatus, 'in_progress');
  assert.deepEqual(result.tools, ['read', 'write']); assert.equal(result.model.id, 'reasoned');
  assert.equal(await readFile(join(client.root, 'redirect-question.txt'), 'utf8'), 'CONTROL-SELF-DECIDED');
  await call('todo', { action: 'update', id: 1, status: 'completed' });
  assert.equal((await call('todo', { action: 'get', id: 1 })).tasks[0].status, 'completed');
  assert.equal((await call('subagent_inspect', {})).jobs.length, 1);
  const parent = (await client.send('get_state')).data as { model: { id: string }; thinkingLevel: string };
  assert.equal(parent.model.id, 'scripted'); assert.equal(parent.thinkingLevel, 'off');
});
}

{
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
    ui: { notify: () => {}, setWidget() {}, confirm: async () => false },
  };
  await loadPublic(pi, ['agents']);
  const jobs = (): any[] => foldAgentEntries(entries).records;
  for (const handler of handlers.get("session_start") ?? []) await handler({}, ctx);
  const spawned = await tools.get("subagent_spawn").execute("call", { task: "离线模拟交付" }, undefined, undefined, ctx);
  assert.ok(!spawned.isError, JSON.stringify(spawned));
  await until(() => jobs().some(job => job.status === 'completed'));
  return {
    root, ctx, jobs, handlers, tools,
    accept(boundary: any, visible = true) {
      entries.push(...boundary.entries);
      for (const handler of handlers.get('context') ?? []) handler({ messages: visible ? boundary.entries.map((entry: any) => ({ role: 'custom', ...entry })) : [] }, ctx);
    },
    wakeAttempts: () => wakeAttempts,
    job: () => jobs().findLast(item => item.status === 'completed')!,
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
      await until(() => h.jobs().filter(job => job.status === 'completed').length === index + 2);
      await delay(80);
    }
    assert.equal(h.wakeAttempts(), 3);
    options.wakeFails = false;
    for (const handler of h.handlers.get('input') ?? []) await handler({ source: 'rpc', text: 'continue new work' }, h.ctx);
    await h.tools.get('subagent_spawn').execute('new-work', { task: 'new child report' }, undefined, undefined, h.ctx);
    await until(() => h.jobs().filter(job => job.status === 'completed').length === 4);
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
}

{
const tasks = () => ({ ...emptyState(), nextId: 8, tasks: Array.from({ length: 7 }, (_, index) => ({ id: index + 1, subject: 'Original work', description: 'Original scope', status: 'pending' as const, blockedBy: [] })) });
async function host() {
  const h = await protocolHost({ state: tasks(), features: ['todos', 'agents'], cli: fileURLToPath(new URL('./fixtures/m2-rpc-fixture.mjs', import.meta.url)) });
  h.ctx.model = { provider: 'fixture', id: 'original' };
  h.ctx.modelRegistry.find = (provider: string, id: string) => provider === 'fixture' ? { provider, id, reasoning: true } : undefined;
  await h.profiles([{ name: 'fallback', model: { provider: 'fixture', id: 'alternative' }, thinking: 'low', tools: ['read', 'write'] }]);
  return h;
}

test('resumeFrom uses a new job on the original Todo; an explicit profile overlays the saved configuration', async () => {
  const h = await host(); try {
    const old = await h.call('subagent_spawn', { task: 'HOLD', todoId: 7 });
    await h.call('subagent_cancel', { jobId: old.jobId });
    assert.equal(h.jobs().find(item => item.id === old.jobId)!.dismissed, true);
    assert.equal(h.jobs().find(item => item.id === old.jobId)!.taskReportStale, true);
    const resumed = await h.call('subagent_spawn', { resumeFrom: old.jobId, todoId: 7, task: 'Check files before finishing', profile: 'fallback' });
    const result = await h.call('subagent_inspect', { jobId: resumed.jobId, output: true, until: 'finish', timeout: 3 });
    assert.notEqual(resumed.jobId, old.jobId); assert.equal(resumed.todoId, 7); assert.equal(resumed.resumeFrom, old.jobId);
    assert.equal(result.model.id, 'alternative'); assert.deepEqual(result.tools, ['read', 'write']);
    assert.match(result.output, /Original assignment:\nHOLD/); assert.match(result.output, /Check files before finishing/);
    assert.doesNotMatch(JSON.stringify((await h.call('subagent_inspect', {})).jobs), /Original assignment|Check files before finishing/);
    assert.equal(h.jobs().find(item => item.id === resumed.jobId)!.assignment, 'HOLD');
    assert.equal(h.jobs().find(item => item.id === old.jobId)!.status, 'cancelled');
  } finally { await h.close(); }
});

test('resume rejects active work, changed Todo binding and changed definition without consuming IDs', async () => {
  const h = await host(); try {
    const old = await h.call('subagent_spawn', { task: 'HOLD', todoId: 1 });
    await assert.rejects(h.call('subagent_spawn', { task: 'again', todoId: 1, resumeFrom: old.jobId }), /Task #1 already has an active agent/);
    await h.call('subagent_cancel', { jobId: old.jobId });
    const next = h.entries.findLast(entry => entry.customType === AGENTS_TYPE).data.nextId;
    await assert.rejects(h.call('subagent_spawn', { task: 'again', todoId: 2, resumeFrom: old.jobId }), /binding/);
    await h.call('todo', { action: 'update', id: 1, description: 'changed scope' });
    await assert.rejects(h.call('subagent_spawn', { task: 'again', todoId: 1, resumeFrom: old.jobId }), /definition changed/);
    assert.equal(h.entries.findLast(entry => entry.customType === AGENTS_TYPE).data.nextId, next);
  } finally { await h.close(); }
});

test('resume inputs survive journal deltas and restoration without reviving the old process', async () => {
  const h = await host(); try {
    const old = await h.call('subagent_spawn', { task: 'HOLD', todoId: 1 });
    const start = h.entries.length;
    await h.call('subagent_cancel', { jobId: old.jobId });
    const delta = h.entries.slice(start).findLast(entry => entry.customType === AGENTS_TYPE).data;
    assert.ok(delta.jobs?.every((job: any) => job.assignment === undefined && job.taskDefinition === undefined), 'immutable inputs are not copied on each delta');
    assert.equal(h.jobs()[0]!.assignment, 'HOLD'); assert.equal(h.jobs()[0]!.dismissed, true);
    await h.emit('session_tree');
    assert.equal((await h.call('subagent_inspect', {})).jobs.filter((job: any) => ['starting', 'running', 'waiting'].includes(job.status)).length, 0);
    const resumed = await h.call('subagent_spawn', { task: 'check restored files', todoId: 1, resumeFrom: old.jobId });
    assert.match((await h.call('subagent_inspect', { jobId: resumed.jobId, output: true, timeout: 3 })).output, /Original assignment:\nHOLD/);
    assert.equal(h.jobs().length, 2);
  } finally { await h.close(); }
});

test('legacy records need a self-contained continuation; short labels are not original instructions', async () => {
  const h = await host(); try {
    await h.restore([{ id: 'a1', todoId: 3, profile: 'inherit', model: { provider: 'fixture', id: 'original' }, thinking: 'off', tools: ['read'], status: 'interrupted', label: 'misleading label only', startedAt: 1, pendingRequests: 0 }]);
    const resumed = await h.call('subagent_spawn', { task: 'Full instructions with all requirements', todoId: 3, resumeFrom: 'a1' });
    const result = await h.call('subagent_inspect', { jobId: resumed.jobId, output: true, timeout: 3 });
    assert.match(result.output, /Legacy record has no full assignment/);
    assert.doesNotMatch(result.output, /misleading label only/);
    assert.equal(h.jobs().find(item => item.id === resumed.jobId)!.assignment, 'Full instructions with all requirements');
  } finally { await h.close(); }
});

test('failure summaries retain bounded root causes; explicit cancel archives even already closed jobs', async () => {
  const h = await host(); try {
    const old = await h.call('subagent_spawn', { task: 'ERROR', todoId: 1 });
    const deadline = Date.now() + 3000;
    while (h.jobs().find(item => item.id === old.jobId)?.status !== 'failed') { if (Date.now() > deadline) throw new Error('public failure record did not arrive'); await delay(10); }
    const failed = h.jobs().find(item => item.id === old.jobId)!;
    assert.equal(failed.status, 'failed'); assert.match(failed.failure.reason, /fixture model error/);
    await h.call('todo', { action: 'update', id: 1, status: 'completed' });
    const clearing = await h.call('todo', { action: 'clear', scope: 'all' });
    assert.equal(clearing.removedIds.includes(1), false, 'an undelivered report protects its otherwise eligible Task from clearing');
    assert.equal((await h.call('subagent_inspect', { jobId: old.jobId })).jobs.length, 1, 'a refused prune keeps the full record');
    assert.match(failed.failure.recovery, /same Todo/);
    await h.call('subagent_cancel', { jobId: old.jobId });
    assert.equal(h.jobs().find(item => item.id === old.jobId)!.status, 'failed', 'history keeps the actual failure outcome');
    assert.equal(h.jobs().find(item => item.id === old.jobId)!.dismissed, true);
    assert.equal(h.jobs().find(item => item.id === old.jobId)!.taskReportStale, true);
    assert.match((await h.execute('subagent_inspect', { jobId: old.jobId, output: true, timeout: 0 })).details.output, /partial retained/);
  } finally { await h.close(); }
});

test('startup crashes include sanitized stderr in their failure report', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dag-broken-public-'));
  const path = join(root, 'broken-cli.mjs');
  await writeFile(path, `process.stderr.write('startup configuration rejected; password=private-value'); process.exit(2);`);
  const h = await protocolHost({ root, cli: path });
  try {
    const spawned = await h.execute('subagent_spawn', { task: 'work' });
    const inspected = await h.execute('subagent_inspect', { jobId: spawned.details.jobId, output: true, timeout: 3 });
    assert.equal(inspected.details.failure.kind, 'process', 'the public result identifies a child-process failure');
    const result = inspected.details;
    assert.equal(result.status, 'failed'); assert.match(result.output, /startup configuration rejected/);
    assert.doesNotMatch(JSON.stringify(result), /private-value/);
    assert.equal((await h.call('subagent_inspect', {})).jobs.filter((job: any) => ['starting', 'running', 'waiting'].includes(job.status)).length, 0);
  } finally { await h.close(); await rm(root, { recursive: true, force: true }); }
});

test('actual offline Pi: cancel then switch profile and resume the same Todo without replacing it', { timeout: 30000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dag-resume-integration-'));
  await mkdir(join(root, 'agent', 'pi-dag-workflow'), { recursive: true });
  await writeFile(join(root, 'agent', 'pi-dag-workflow', 'pi-dag-workflow-profile.json'), JSON.stringify({ profiles: [
    { name: 'worker', model: { provider: 'dag-test', id: 'scripted' }, thinking: 'off', tools: ['read'] },
    { name: 'fallback', model: { provider: 'dag-test', id: 'reasoned' }, thinking: 'off', tools: ['read', 'write'] },
  ] }));
  const offline = new URL('./fixtures/offline-model.ts', import.meta.url).pathname;
  const client = await IsolatedClient.start(root, 'same-todo-resume', [], ['--dag-workflow-test-child-provider', offline]);
  t.after(() => client.close());
  const call = async (name: string, params: object, expectError = false) => {
    const events = await client.prompt(`TEST CALL ${name} ${JSON.stringify(params)}`);
    const result = events.find((event) => event.type === 'tool_execution_end' && event.toolName === name)!;
    assert.ok(result); assert.equal(result.isError === true || (result.result as any).isError === true, expectError, JSON.stringify(result));
    return (result.result as any).details;
  };
  await call('todo', { action: 'create', subject: 'Original work', description: 'Verify every original requirement' });
  const old = await call('subagent_spawn', { task: 'HOLD-IDLE-ENABLE-CHILD', todoId: 1, profile: 'worker' });
  await call('subagent_cancel', { jobId: old.jobId });
  const cancelledView = await client.prompt('/todos list pending');
  const viewText = (events: any[]) => events.filter((event) => event.method === 'notify').map((event) => event.message).join('\n');
  assert.match(viewText(cancelledView), /主会话.*可接续/);
  assert.doesNotMatch(viewText(cancelledView), new RegExp(`${old.jobId} ·`));
  await call('todo', { action: 'update', id: 1, status: 'in_progress' });
  assert.doesNotMatch(viewText(await client.prompt('/todos list pending')), /可接续/);
  const chosen = await call('subagent_inspect', { profile: 'fallback' }); assert.equal(chosen.profile.name, 'fallback');
  const resumed = await call('subagent_spawn', { resumeFrom: old.jobId, profile: 'fallback', task: 'TEST CALL subagent_send {"message":"Partial files inspected; remaining requirements verified"}' });
  assert.equal(resumed.todoId, 1); assert.equal(resumed.resumeFrom, old.jobId); assert.notEqual(resumed.jobId, old.jobId);
  const result = await call('subagent_inspect', { jobId: resumed.jobId, output: true, until: 'finish', timeout: 10 });
  assert.equal(result.status, 'completed'); assert.deepEqual(result.tools, ['read', 'write']); assert.equal(result.model.id, 'reasoned');
  assert.match(result.output, /remaining requirements verified/);
  const entries = await client.entries() as any[];
  const taskState = entries.findLast((entry) => entry.customType === 'pi-dag-workflow.state').data;
  assert.equal(taskState.tasks.length, 1); assert.equal(taskState.tasks[0].status, 'in_progress');
  await call('todo', { action: 'update', id: 1, description: 'Different required end state' });
  await call('subagent_spawn', { resumeFrom: resumed.jobId, task: 'Do not silently use the old scope' }, true);
  assert.equal((await call('todo', { action: 'list' })).page.total, 1);
});
}

{
async function call(client: IsolatedClient, params: object, expectError = false) {
  const records = await client.prompt(`TEST CALL subagent_inspect ${JSON.stringify(params)}`);
  const end = records.find((record) => record.type === 'tool_execution_end' && record.toolName === 'subagent_inspect')!;
  assert.ok(end);
  assert.equal(end.isError === true || (end.result as any).isError === true, expectError, JSON.stringify(end));
  return (end.result as any).details;
}

test('actual Pi: merged inspection refuses ambiguous output/directory/wait parameters', { timeout: 15000 }, async (t) => {
  const client = await IsolatedClient.start(); t.after(() => client.close());
  for (const params of [{ output: true }, { jobId: 'a1', timeout: 0 }, { jobId: 'a1', after: 0 }, { jobId: 'a1', until: 'finish' }, { jobId: 'a1', output: true, profiles: 'summary' }, { jobId: 'a1', output: true, profile: 'unknown' }]) await call(client, params, true);
  await client.prompt('ordinary input');
  const entries = await client.entries() as any[];
  const declared = entries.flatMap((entry) => entry.message?.toolsAdded ?? []).map((tool) => tool.name);
  assert.equal(declared.filter((name) => name === 'subagent_inspect').length, 1);
  assert.ok(!declared.includes('subagent_wait'), 'no silent model-tool alias');
});

test('actual Pi: short status never returns full output; collection delivers report but does not accept Todo', { timeout: 20000 }, async (t) => {
  const offline = new URL('./fixtures/offline-model.ts', import.meta.url).pathname;
  const client = await IsolatedClient.start(undefined, 'merged-query', [], ['--dag-workflow-test-child-provider', offline]); t.after(() => client.close());
  await client.prompt('TEST CALL todo {"action":"create","subject":"verify actual artifacts"}');
  const spawned = await client.prompt('TEST CALL subagent_spawn {"task":"short assigned work","todoId":1}');
  const id = (spawned.find((record) => record.type === 'tool_execution_end' && record.toolName === 'subagent_spawn')!.result as any).details.jobId;
  const status = await call(client, { jobId: id });
  assert.equal(status.jobs.length, 1); assert.equal(status.output, undefined); assert.equal(status.jobs[0].output, undefined);
  const report = await call(client, { jobId: id, output: true, profiles: false, until: 'finish', timeout: 8 });
  assert.equal(report.status, 'completed'); assert.match(report.output, /离线模拟/);
  assert.equal(report.reportDelivery, 'delivered'); assert.equal(report.todoStatus, 'in_progress');
  assert.equal((await call(client, { jobId: id })).jobs[0].todoStatus, 'in_progress');
});
}

{
test('real Pi: restore normalization is persisted on the next change and reset supersedes corruption', { timeout: 30000 }, async (t) => {
  const fixture = fileURLToPath(new URL('./fixtures/history-records.ts', import.meta.url));
  const controls = fileURLToPath(new URL('./fixtures/session-controls.ts', import.meta.url));
  const offline = fileURLToPath(new URL('./fixtures/offline-model.ts', import.meta.url));
  const client = await IsolatedClient.start(undefined, 'journal-normalization', [fixture, controls], ['--dag-workflow-test-child-provider', offline]);
  t.after(() => client.close());
  await client.prompt('/test-history-records [{"id":"a1","status":"running"}]');
  await client.prompt('/test-reload');
  await client.prompt('TEST CALL subagent_spawn {"task":"HOLD-IDLE-ENABLE-CHILD"}');
  const restored = foldAgentEntries(await client.entries());
  assert.equal(restored.records.find((job) => job.id === 'a1')!.status, 'interrupted');
  assert.equal(restored.records.find((job) => job.id === 'a1')!.output, 'generic retained report');
  assert.equal(restored.records.find((job) => job.id === 'a20')!.status, 'running');
  await client.prompt('/test-history-corrupt'); await client.prompt('/test-reload');
  const offset = client.records.length;
  const resetting = client.prompt('/agents reset');
  await client.until(() => client.records.slice(offset).some((event) => event.method === 'confirm'));
  const question = client.records.slice(offset).find((event) => event.method === 'confirm')!;
  client.child.stdin.write(`${JSON.stringify({ type: 'extension_ui_response', id: question.id, confirmed: true })}\n`);
  await resetting;
  assert.deepEqual(foldAgentEntries(await client.entries()).records, []);
  const inspected = await client.prompt('TEST CALL subagent_inspect {}');
  assert.equal(inspected.find((event) => event.type === 'tool_execution_end' && event.toolName === 'subagent_inspect')!.isError, false);
});

}


{
const presetConfig = {
  presets: [
    { name: 'alpha', description: 'First fragment', steps: [{ key: 'one', subject: '第一步' }, { key: 'two', subject: '第二步', after: ['one'] }] },
    { name: 'beta', steps: [{ key: 'only', subject: 'Only step' }] },
  ],
};
test('Todo fragments remain reachable inside the bare root menu while the shortcut stays text-only', async (t) => {
  const host = await protocolHost({ features: ['todos'], language: 'zh-CN' });
  t.after(() => host.close());
  await writeFile(presetFile(host), JSON.stringify(presetConfig), 'utf8');
  let selects = 0, reads = 0;
  host.ctx.mode = 'tui'; host.ctx.hasUI = true;
  host.ctx.ui.theme = { style: (text: string) => text, fg: (_color: string, text: string) => text, bold: (text: string) => text };
  host.ctx.ui.notify = () => {};
  const panels = recordPanels(host.ctx), opening = host.commands.get('todos').handler('', host.ctx);
  // Fragments live in a root-page group now: the entity expands in place and the read action opens the steps.
  await panels.focus('alpha');
  await panels.select('alpha'); selects++;
  assert.ok(panels.frame().some(line => line.includes('应用片段')), 'the fragment row expands to its actions');
  await panels.select('查看步骤'); selects++;
  await panels.wait(() => panels.frame().some(line => line.includes('第一步'))); reads++;
  await panels.press('\x1b');
  await panels.wait(() => panels.live() === 1 && panels.frame()[0]!.includes('Todos'));
  // Esc returns from the read view, then collapses the expanded fragment, then exits the panel.
  await panels.press('\x1b'); await panels.press('\x1b'); await opening;
  assert.equal(reads, 1); assert.equal(host.state().tasks.length, 0); assert.equal(host.appended.filter((entry: any) => entry.customType === STATE_TYPE).length, 0);
  const before = selects; await host.commands.get('todos').handler('presets', host.ctx); assert.equal(selects, before, 'shortcut remains non-interactive');
  // The fragment row can apply its steps without leaving the panel.
  const applied = host.commands.get('todos').handler('', host.ctx);
  await panels.wait(() => panels.live() === 1);
  await panels.focus('alpha'); await panels.press('\r');
  await panels.select('应用片段');
  await panels.wait(() => host.state().tasks.length === 2);
  assert.deepEqual(host.state().tasks.map((task: any) => task.subject), ['第一步', '第二步']);
  await panels.press('\x1b'); await panels.press('\x1b'); await panels.press('\x1b'); await applied;

});

const labels = {
  'zh-CN': { extensions: '子扩展', addLoaded: '添加：从已加载扩展选择', missing: '缺失', tools: (count: number) => `${count} 个工具`, catalog: '模型目录', next: '下一页', search: '搜索', editInstructions: '编辑 Profile 指令', rootProfiles: 'Profile 列表' },
  en: { extensions: 'Agent extensions', addLoaded: 'Add: choose a loaded extension', missing: 'Missing', tools: (count: number) => `${count} tool(s)`, catalog: 'Model catalog', next: 'Next page', search: 'Search', editInstructions: 'Edit profile instructions', rootProfiles: 'Profile 列表' },
} as const;
const presetFile = (host: { directory: string }) => join(host.directory, 'pi-dag-workflow-preset.json');
const todoTool = async (t: { after(fn: () => unknown): void }, language: 'zh-CN' | 'en' = 'zh-CN') => {
  const host = await protocolHost({ features: ['todos'], language });
  t.after(() => host.close());
  await writeFile(presetFile(host), JSON.stringify(presetConfig), 'utf8');
  return { host, tool: host.tools.get('todo') as any };
};

test('todo presets is a read-only catalog: summaries, one full definition, no state write', async (t) => {
  const { host, tool } = await todoTool(t);
  assert.equal(Value.Check(tool.parameters, { action: 'presets' }), true);
  assert.equal(Value.Check(tool.parameters, { action: 'presets', preset: 'alpha' }), true);
  assert.equal(Value.Check(tool.parameters, { action: 'presets', nope: true }), false);
  const extra = await tool.execute('c0', { action: 'presets', description: 'nope' } as any, undefined, undefined, host.ctx);
  assert.equal(extra.isError, true, 'presets rejects fields outside preset');

  const stateWrites = () => host.appended.filter((entry: any) => entry.customType === STATE_TYPE).length;
  const listing = await tool.execute('c1', { action: 'presets' }, undefined, undefined, host.ctx);
  assert.ok(!listing.isError, JSON.stringify(listing));
  assert.deepEqual(listing.details, { version: 2, action: 'presets', presets: [{ name: 'alpha', description: 'First fragment', steps: 2 }, { name: 'beta', steps: 1 }] });
  assert.equal('tasks' in listing.details, false);
  assert.equal('nextId' in listing.details, false);
  assert.match(listing.content[0]!.text, /First fragment/);
  assert.doesNotMatch(listing.content[0]!.text, /第一步|第二步/);

  const one = await tool.execute('c2', { action: 'presets', preset: 'alpha' }, undefined, undefined, host.ctx);
  assert.ok(!one.isError, JSON.stringify(one));
  assert.equal(one.details.preset.name, 'alpha');
  assert.equal(one.details.preset.description, 'First fragment');
  assert.deepEqual(one.details.preset.steps.map((step: any) => step.key), ['one', 'two']);
  assert.deepEqual(JSON.parse(one.content[0]!.text).steps.map((step: any) => step.key), ['one', 'two']);

  const missing = await tool.execute('c3', { action: 'presets', preset: 'missing' }, undefined, undefined, host.ctx);
  assert.equal(missing.isError, true);
  assert.match(missing.content[0]!.text, /缺失 missing|missing/);
  assert.equal(stateWrites(), 0, 'catalog discovery never commits state');

  // apply/reset keep working from the same freshly loaded store.
  const applied = await tool.execute('c4', { action: 'apply', preset: 'beta' }, undefined, undefined, host.ctx);
  assert.ok(!applied.isError, JSON.stringify(applied));
  assert.equal(host.state().tasks.length, 1);
  assert.equal(stateWrites(), 1);
});

test('subagent_inspect hides profiles by default and only the chosen query returns full instructions', async (t) => {
  const host = await protocolHost({ language: 'zh-CN' });
  t.after(() => host.close());
  const long = 'PROFILE-LONG-INSTRUCTIONS '.repeat(30);
  await writeFile(join(host.directory, 'pi-dag-workflow-profile.json'), JSON.stringify({ profiles: [{ name: 'probe', thinking: 'off', tools: ['read'], instructions: long }] }), 'utf8');
  const inspect = host.tools.get('subagent_inspect');

  assert.equal(Value.Check(inspect.parameters, { profiles: 'summary' }), true);
  assert.equal(Value.Check(inspect.parameters, { profile: 'probe' }), true);
  assert.equal(Value.Check(inspect.parameters, { profiles: 'nope' }), false);

  const plain = await inspect.execute('i1', {}, undefined, undefined, host.ctx);
  assert.deepEqual(Object.keys(plain.details).sort(), ['jobs', 'paused']);
  assert.equal(Object.hasOwn(plain.details, 'profiles'), false);
  assert.doesNotMatch(JSON.stringify(plain.details), /PROFILE-LONG-INSTRUCTIONS/);

  const summary = await inspect.execute('i2', { profiles: 'summary' }, undefined, undefined, host.ctx);
  assert.equal(summary.details.profiles[0].name, 'probe');
  assert.equal(summary.details.profiles[0].instructions, undefined);
  assert.deepEqual(summary.details.profiles[0].tools, ['read']);
  assert.equal(summary.details.profiles[0].thinking, 'off');
  assert.equal(summary.details.profilePath, undefined, 'summary stays minimal');
  assert.doesNotMatch(JSON.stringify(summary.details), /PROFILE-LONG-INSTRUCTIONS/);

  const full = await inspect.execute('i3', { profiles: true }, undefined, undefined, host.ctx);
  assert.match(full.details.profiles[0].instructions, /PROFILE-LONG-INSTRUCTIONS/);
  assert.ok(full.details.profilePath);

  const one = await inspect.execute('i4', { profile: 'probe' }, undefined, undefined, host.ctx);
  assert.match(one.details.profile.instructions, /PROFILE-LONG-INSTRUCTIONS/);
  assert.equal(Object.hasOwn(one.details, 'profiles'), false);

  const missing = await inspect.execute('i5', { profile: 'nope' }, undefined, undefined, host.ctx);
  assert.equal(missing.isError, true);
  assert.match(missing.content[0]!.text, /未找到 Profile nope/);

  const ambiguous = await inspect.execute('i6', { profile: 'probe', profiles: 'summary' }, undefined, undefined, host.ctx);
  assert.equal(ambiguous.isError, true);

  assert.deepEqual(host.appended, [], 'inspection appends no session entries');
});

const catalogModel = (provider: string, id: string) => ({ provider, id, name: `Name ${id}`, reasoning: true, contextWindow: 10000, maxTokens: 1000, input: ['text'], baseUrl: 'https://private.invalid', headers: { Authorization: 'SECRET' }, apiKey: 'SECRET' });

test('model discovery is opt-in, paginated, stable and strips private registry fields', async (t) => {
  const host = await protocolHost();
  t.after(() => host.close());
  let reads = 0;
  const source = Array.from({ length: 25 }, (_, i) => catalogModel(i < 12 ? 'b' : 'a', `model-${String(i).padStart(2, '0')}`)).reverse();
  host.ctx.modelRegistry.getAvailable = () => { reads++; return source; };
  assert.equal(reads, 0, 'session startup does not enumerate available models');
  assert.deepEqual([...host.tools.keys()], ['subagent_spawn', 'subagent_inspect', 'subagent_send', 'subagent_cancel']);
  const inspect = host.tools.get('subagent_inspect');
  const query = (args: object) => inspect.execute('models', args, undefined, undefined, host.ctx);
  for (const args of [{ models: true }, { models: true, limit: 1, offset: 0 }, { models: true, limit: 100, offset: 30, query: 'name' }]) assert.equal(Value.Check(inspect.parameters, args), true);
  for (const args of [{ limit: 0 }, { limit: 101 }, { limit: 1.5 }, { offset: -1 }, { offset: 0.5 }, { query: false }]) assert.equal(Value.Check(inspect.parameters, { models: true, ...args }), false);
  await query({}); await query({ models: false }); await query({ profiles: 'summary' });
  assert.equal(reads, 0, 'ordinary job/profile queries do not enumerate models');
  for (const field of ['jobId', 'profile', 'profiles', 'output', 'timeout', 'until', 'after']) {
    const value: Record<string, unknown> = { jobId: 'a1', profile: 'probe', profiles: false, output: false, timeout: 0, until: 'update', after: 0 };
    assert.equal((await query({ models: true, [field]: value[field] })).isError, true, field);
  }
  for (const args of [{ query: '' }, { limit: 20 }, { offset: 0 }, { models: false, query: 'a' }]) assert.equal((await query(args)).isError, true);
  assert.equal(reads, 0, 'invalid combinations are rejected before registry access');
  const first = await query({ models: true });
  assert.equal(first.details.models.length, 20); assert.equal(first.details.total, 25); assert.equal(first.details.nextOffset, 20);
  assert.deepEqual(first.details.models.map((model: any) => `${model.provider}/${model.id}`), [...source].sort((a, b) => `${a.provider}/${a.id}`.localeCompare(`${b.provider}/${b.id}`)).slice(0, 20).map(model => `${model.provider}/${model.id}`));
  assert.deepEqual(Object.keys(first.details.models[0]).sort(), ['contextWindow', 'id', 'input', 'maxTokens', 'name', 'provider', 'reasoning']);
  assert.doesNotMatch(first.content[0].text, /private|SECRET|baseUrl|headers|apiKey/);
  assert.equal('jobs' in first.details, false); assert.equal('profiles' in first.details, false);
  const last = await query({ models: true, offset: first.details.nextOffset });
  assert.equal(last.details.models.length, 5); assert.equal(last.details.nextOffset, null);
  const beyond = await query({ models: true, offset: 99 }); assert.deepEqual(beyond.details.models, []); assert.equal(beyond.details.nextOffset, null); assert.equal(beyond.details.total, 25);
  const match = await query({ models: true, query: ' NAME MODEL-05 ' });
  assert.equal(match.details.total, 1); assert.equal(match.details.models[0].id, 'model-05');
  const byProvider = await query({ models: true, query: 'B', limit: 2 }); assert.equal(byProvider.details.total, 12); assert.equal(byProvider.details.nextOffset, 2);
  assert.deepEqual((await query({ models: true, query: 'absent' })).details, { models: [], total: 0, nextOffset: null });
  assert.deepEqual(host.appended, []);
});

test('spawn schemas and forwarding preserve explicit overrides and return actual configuration', async (t) => {
  const host = await protocolHost();
  t.after(() => host.close());
  const spawn = host.tools.get('subagent_spawn');
  for (const thinking of ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']) assert.equal(Value.Check(spawn.parameters, { task: 'test', thinking }), true);
  for (const args of [{ thinking: 'impossible' }, { model: { id: 'only' } }, { model: { provider: 'test', id: 'm', headers: {} } }, { skills: [1] }, { skills: [''] }]) assert.equal(Value.Check(spawn.parameters, { task: 'test', ...args }), false);
  const explicit = { task: 'test', model: { provider: 'dag-test', id: 'reasoned' }, thinking: 'off', tools: ['read'], skills: [] as string[] };
  assert.equal(Value.Check(spawn.parameters, explicit), true);
  const result = await spawn.execute('spawn', explicit, undefined, undefined, host.ctx);
  assert.equal(result.isError, undefined, JSON.stringify(result));
  assert.deepEqual(result.details.model, { provider: 'dag-test', id: 'reasoned' });
  assert.equal(result.details.thinking, 'off');
  assert.deepEqual(result.details.tools, ['read']);
  assert.deepEqual(result.details.skills, []);
  const defaults = await host.call('subagent_spawn', { task: 'defaults' });
  assert.deepEqual(defaults.model, { provider: 'dag-test', id: 'scripted' });
  assert.equal(defaults.thinking, 'off');
  assert.deepEqual(defaults.tools, ['read']);
  await writeFile(join(host.root, 'probe.md'), '# Probe\n');
  const paths = await host.call('subagent_spawn', { task: 'paths', skills: ['probe.md'] });
  assert.deepEqual(paths.skills, [join(host.root, 'probe.md')], 'paths resolve to readable local files without implicit tools');
  assert.deepEqual(paths.tools, ['read']);
  await writeFile(join(host.directory, 'pi-dag-workflow-profile.json'), '{invalid');
  for (const profile of [undefined, 'inherit']) {
    const args = { task: 'resume', resumeFrom: result.details.jobId as string, ...(profile ? { profile } : {}) };
    const resumed = await spawn.execute('resume', args, undefined, undefined, host.ctx);
    assert.equal(resumed.isError, undefined, JSON.stringify(resumed));
  }
  assert.equal((await spawn.execute('named-resume', { task: 'resume', resumeFrom: result.details.jobId as string, profile: 'changed' }, undefined, undefined, host.ctx)).isError, true, 'explicit named profile still reloads its configuration');
  assert.match(spawn.description, /last actual configuration/); assert.match(spawn.description, /never added implicitly/); assert.match(spawn.description, /not auto-discovered or system prompts/);
});

test('B4: profile extension rows and the loaded-extension picker localize, dedupe sources and exclude synthetic and Agent tools', async (t) => {
  for (const locale of ['zh-CN', 'en'] as const) {
    const imported: string[] = [];
    const host = await protocolHost({ language: locale, tools: () => imported.length ? [
      { name: 'one', sourceInfo: { path: imported[0] } }, { name: 'two', sourceInfo: { path: imported[0] } },
      { name: 'hidden', sourceInfo: { path: imported[1] } },
      { name: 'read', sourceInfo: { path: 'builtin:read' } }, { name: 'synthetic', sourceInfo: { path: '<generated>' } },
      { name: 'subagent_spawn', sourceInfo: { path: imported[0] } },
    ] : [] });
    t.after(() => host.close());
    const extension = join(host.root, 'loaded.ts');
    const hiddenDirectory = join(host.root, 'long-extension-source-directory-for-tail-regression', 'nested', 'deeper');
    const hidden = join(hiddenDirectory, 'hidden.ts');
    await mkdir(hiddenDirectory, { recursive: true });
    await writeFile(extension, 'export default function() {}'); await writeFile(hidden, 'export default function() {}');
    imported.push(extension, hidden);
    const profilePath = join(host.directory, 'pi-dag-workflow-profile.json');
    await writeFile(profilePath, JSON.stringify({ profiles: [{ name: 'work', childExtensions: ['missing.ts', hidden] }] }));
    const savedPaths = async () => JSON.parse(await readFile(profilePath, 'utf8')).profiles[0].childExtensions;
    host.ctx.hasUI = true; host.ctx.mode = 'tui';
    const styled: { text: string; fg: string }[] = [];
    host.ctx.ui.theme = { style(value: string, options: { fg: string }) { styled.push({ text: value, fg: options.fg }); return value; } };
    const text = locale === 'en' ? { add: 'Choose a loaded extension', tools: (count: number) => `${count} tool(s)` } : { add: '从已加载扩展选择', tools: (count: number) => `${count} 个工具` };
    const panels = recordPanels(host.ctx), opening = host.commands.get('agents').handler('', host.ctx);
    await panels.wait(() => panels.live() === 1);
    const frame = () => panels.frame().join('\n');
    if (locale === 'en') assert.doesNotMatch(frame(), /[\u3400-\u9fff]/u);
    // Every declared path is listed in place, without a separate sub-screen.
    await panels.focus('work'); await panels.press('\r');
    await panels.focus('missing.ts');
    assert.match(frame(), /missing\.ts/);
    assert.equal(panels.frame().filter(line => /│ .*missing\.ts/.test(line)).length, 1, 'one row per declared path');
    await panels.press('\x1b[B');
    const hiddenRow = panels.frame().find(line => /^[ │]*> /.test(line));
    assert.ok(hiddenRow, 'the next declared path row is selectable');
    assert.match(hiddenRow, /….*hidden\.ts[↑↓↕]?$/u, 'the long path keeps its filename tail at the visible end');
    assert.match(frame(), /hidden\.ts/, 'every declared path is listed in place');
    assert.deepEqual(await savedPaths(), ['missing.ts', hidden], 'the full saved path is unchanged while its row is shortened');
    // The picker offers only not-yet-configured loaded sources, with their delegable tool counts.
    await panels.focus(text.add); await panels.press('\r');
    await panels.wait(() => panels.frame().some(line => line.includes('loaded.ts')));
    assert.equal(panels.frame().filter(line => /\p{Co}.*loaded\.ts/u.test(line)).length, 1, 'one picker row per source');
    const loadedRow = panels.frame().find(line => /\p{Co}.*loaded\.ts/u.test(line))!;
    assert.match(loadedRow, /….*loaded\.ts/u, 'the picker path keeps its filename tail');
    assert.match(loadedRow, /….*loaded\.ts.*\[/u, 'the tool count still follows the kept filename');
    assert.ok(frame().includes(text.tools(2)), 'the picker shows the delegable tool count');
    assert.doesNotMatch(frame(), /builtin:|<generated>/);
    // The declared path stays visible under the Profile; the picker must not offer it a second time.
    assert.equal(panels.frame().filter(line => /\p{Co}.*hidden\.ts/u.test(line)).length, 1, 'one row for an already configured path');
    assert.equal(panels.frame().filter(line => /hidden\.ts/.test(line) && /个工具|tool\(s\)/.test(line)).length, 0, 'a configured path never appears as a picker row with a tool count');
    assert.ok(styled.some(item => item.text === text.tools(2) && item.fg === 'muted'));
    await panels.select('loaded.ts');
    for (let attempt = 0; attempt < 50; attempt++) { if ((await savedPaths()).length === 3) break; await new Promise(resolve => setTimeout(resolve, 20)); }
    assert.deepEqual(await savedPaths(), ['missing.ts', hidden, extension]);
    // Removing a missing path needs two Enter presses and only rewrites the profile file.
    await panels.focus('missing.ts'); await panels.press('\r');
    assert.match(frame(), /再次 Enter 移除|Press Enter again to remove/);
    await panels.press('\r');
    for (let attempt = 0; attempt < 50; attempt++) { if ((await savedPaths()).length === 2) break; await new Promise(resolve => setTimeout(resolve, 20)); }
    assert.deepEqual(await savedPaths(), [hidden, extension]);
    // The panel re-renders after the delete; close every mounted frame before the handler returns.
    for (let attempt = 0; attempt < 3 && panels.live() === 1; attempt++) { await panels.press('\x1b'); await new Promise(resolve => setTimeout(resolve, 150)); }
    await opening; assert.equal(panels.live(), 0);
  }
});

test('B1.1: ordinary and inherit dispatch read child configuration once without a cache', async (t) => {
  const host = await protocolHost();
  t.after(() => host.close());
  const profilePath = join(host.directory, 'pi-dag-workflow-profile.json');
  await writeFile(profilePath, JSON.stringify({ profiles: [{ name: 'plain', childExtensions: [] }] }));
  const handle = await open(profilePath, 'r'), prototype = Object.getPrototypeOf(handle), stat = prototype.stat;
  await handle.close(); let reads = 0;
  t.mock.method(prototype, 'stat', function (this: unknown, ...args: unknown[]) { reads++; return Reflect.apply(stat, this, args); });
  const inspect = host.tools.get('subagent_inspect');
  for (const profile of [undefined, 'inherit']) {
    const before = reads;
    const spawned = await host.tools.get('subagent_spawn').execute('spawn', { task: 'Short independent assignment', ...(profile ? { profile } : {}) }, undefined, undefined, host.ctx);
    assert.equal(spawned.isError, undefined, JSON.stringify(spawned));
    const result = await inspect.execute('wait', { jobId: spawned.details.jobId, output: true, until: 'finish', timeout: 10 }, undefined, undefined, host.ctx);
    assert.equal(result.details.status, 'completed');
    assert.equal(reads - before, 1, 'each dispatch reads the profile configuration exactly once');
  }
});

test('B1.1: Profile menu refreshes live tools before loading and saving after an editor', async (t) => {
  let extension = '';
  const host = await protocolHost({ language: 'zh-CN', tools: () => extension ? [{ name: 'mock_search', description: 'Search', exposure: 'direct', sourceInfo: { path: extension } }] : [] });
  t.after(() => host.close());
  extension = join(host.root, 'menu-extension.ts');
  await writeFile(extension, 'export default function() {}');
  const profilePath = join(host.directory, 'pi-dag-workflow-profile.json');
  await writeFile(profilePath, JSON.stringify({ profiles: [{ name: 'searcher', tools: ['mock_search'], instructions: 'original', childExtensions: [extension] }] }));
  const notices: string[] = []; host.ctx.hasUI = true; host.ctx.mode = 'rpc'; host.ctx.ui.notify = (message: string) => notices.push(message);
  async function edit(save: string, revoke = false) {
    let rootVisits = 0, profileVisits = 0;
    host.ctx.ui.select = async (title: string, options: string[]) => {
      const pick = (word: string) => options.find(option => option.includes(word));
      // The Profile detail page is paginated; walk to the page that holds the instruction editor.
      if (title.startsWith('Profile ')) return pick('编辑 Profile 指令') ?? pick('下一页');
      if (title.startsWith('Profile')) return profileVisits++ === 0 ? pick('searcher') : undefined;
      return rootVisits++ === 0 ? pick('Profile 列表') : undefined;
    };
    host.ctx.ui.editor = async () => {
      if (revoke) {
        // Revoke the extension without touching the instructions saved earlier.
        const current = JSON.parse(await readFile(profilePath, 'utf8'));
        delete current.profiles[0].childExtensions;
        await writeFile(profilePath, JSON.stringify(current));
      }
      return save;
    };
    await host.commands.get('agents').handler('', host.ctx);
  }
  await edit('saved with extension');
  assert.equal(JSON.parse(await readFile(profilePath, 'utf8')).profiles[0].instructions, 'saved with extension');
  assert.doesNotMatch(notices.join('\n'), /not trusted or supported/);
  await edit('must not save after revocation', true);
  assert.match(notices.join('\n'), /not trusted or supported: mock_search/);
  assert.equal(JSON.parse(await readFile(profilePath, 'utf8')).profiles[0].instructions, 'saved with extension');
});

test('send tools requires recipient + interrupt, and only forwards validated replacements', async (t) => {
  const host = await protocolHost();
  t.after(() => host.close());
  const send = host.tools.get('subagent_send');
  const call = (args: object) => send.execute('send', { message: 'authorized direction', ...args }, undefined, undefined, host.ctx);
  const ask = async () => {
    const child = await host.call('subagent_spawn', { task: 'CONTROL QUESTION' });
    const pending = await host.call('subagent_inspect', { jobId: child.jobId, output: true, until: 'update', timeout: 10 });
    assert.equal(pending.status, 'waiting');
    return { jobId: child.jobId as string, requestId: pending.requests[0].requestId as string };
  };
  assert.equal(Value.Check(send.parameters, { recipient: 'a1', message: 'change', interrupt: true, tools: ['read'] }), true);
  assert.equal(Value.Check(send.parameters, { recipient: 'a1', message: 'change', interrupt: true, tools: [1] }), false);
  for (const args of [{ recipient: 'a1', tools: [] }, { recipient: 'a1', tools: [], interrupt: false }, { requestId: 'q1', tools: ['read'], interrupt: true }, { recipient: 'a1', requestId: 'q1', tools: ['read'], interrupt: true }]) assert.equal((await call(args)).isError, true);
  const answeredChild = await ask();
  assert.equal((await call({ recipient: answeredChild.jobId })).isError, undefined, 'an ordinary direction needs no replacement');
  const answered = await call({ requestId: answeredChild.requestId });
  assert.equal(answered.isError, undefined, JSON.stringify(answered));
  const replacedChild = await ask();
  const replaced = await call({ recipient: replacedChild.jobId, interrupt: true, tools: ['read'] });
  assert.equal(replaced.isError, undefined, JSON.stringify(replaced));
  assert.equal(replaced.details.interrupted, true);
  assert.deepEqual(replaced.details.tools, ['read']);
  const event: any = { systemPromptOptions: { sections: {} } };
  await host.emit('before_agent_start', event);
  const rules = event.systemPromptOptions.promptGuidelines.join('\n');
  assert.match(rules, /child's request is not authorization/); assert.match(rules, /not a sandbox/);
  await host.call('subagent_cancel', { jobId: answeredChild.jobId });
  await host.call('subagent_cancel', { jobId: replacedChild.jobId });
});

for (const locale of ['zh-CN', 'en'] as const) test(`native agents model catalog searches/pages and reads exact references without mutations (${locale})`, async (t) => {
  const host = await protocolHost({ language: locale });
  t.after(() => host.close());
  const text = labels[locale];
  const profilePath = join(host.directory, 'pi-dag-workflow-profile.json');
  const profileBytes = JSON.stringify({ profiles: [{ name: 'unchanged', tools: ['read'] }] }); await writeFile(profilePath, profileBytes);
  const beforeModel = structuredClone(host.ctx.model);
  const models = Array.from({ length: 10 }, (_, i) => catalogModel('test', `model-${i}`)); models[9]!.id = 'exact/id/with/slashes';
  let reads = 0; host.ctx.modelRegistry.getAvailable = () => { reads++; return models; };
  host.ctx.hasUI = true; host.ctx.mode = 'rpc';
  const notices: string[] = []; host.ctx.ui.notify = (value: string) => notices.push(value);
  host.ctx.ui.input = async () => 'exact/id/with/slashes';
  let step = 0;
  host.ctx.ui.select = async (title: string, options: string[]) => {
    const pick = (word: string) => { const option = options.find(value => value.includes(word)); assert.ok(option, `${title}: missing ${word}`); return option; };
    switch (++step) {
      case 1: assert.equal(reads, 0); return pick(text.catalog);
      case 2: return pick(text.next);
      case 3: return pick(text.search);
      case 4: assert.equal(options.filter(value => value.startsWith('Name')).length, 1); return pick('Name model-9');
      case 5: return undefined;
      case 6: return undefined;
      default: throw new Error('Unexpected extra menu');
    }
  };
  await host.commands.get('agents').handler('', host.ctx);
  assert.equal(step, 6); assert.equal(notices.length, 1); assert.match(notices[0]!, /provider: test\nid: exact\/id\/with\/slashes/);
  assert.doesNotMatch(notices[0]!, /SECRET|private|baseUrl|headers/);
  assert.deepEqual(host.ctx.model, beforeModel); assert.equal(await readFile(profilePath, 'utf8'), profileBytes); assert.deepEqual(host.appended, []);
});


}

// Dispatched child resources: native Pi extension registration and lifecycle, not pure projection.
import { childResourceHost } from './fixtures/child-resource-host.ts';
import { AGENT_REPORT_MESSAGE } from './fixtures/public-records.ts';
{
const CHILD_GUIDANCE_TYPE="pi-dag-child.assignment-guidance";
const PROFILE = "PROFILE-FULL-TEXT: stay read-only unless the assignment says otherwise.";
const FRAGMENT = "FRAGMENT-FULL-TEXT: browser-check run 1, step 2 of 3.";

test('B2.1: unenforceable child selection exits with a diagnostic instead of returning from before_agent_start', async (t) => {
  const h = await childResourceHost({ PI_DAG_AGENT_TOOLS: JSON.stringify(['read']) }); t.after(() => h.close());
  h.pi.getAllTools = (() => [{ name: 'read' }, { name: 'write' }]) as any;
  h.pi.setActiveTools = () => {};
  h.pi.getActiveTools = () => ['read', 'write', 'subagent_send'];
  const stopped = new Error('intercepted process exit');
  const exit = t.mock.method(process, 'exit', () => { throw stopped; });
  const stderr = t.mock.method(process.stderr, 'write', () => true);
  const event = { systemPromptOptions: { sections: {} } };
  assert.throws(() => h.fire('before_agent_start', event), (cause) => cause === stopped);
  assert.equal(exit.mock.callCount(), 1);
  assert.equal(exit.mock.calls[0]!.arguments[0], 1);
  assert.equal(stderr.mock.callCount(), 1);
  assert.equal(String(stderr.mock.calls[0]!.arguments[0]), 'Child tool selection is not enforceable: Error: Child tool update did not apply\n');
  assert.deepEqual(event.systemPromptOptions.sections, {});
  assert.deepEqual(h.sent, []);
});

test("selected guidance leaves the system prompt and the fixed child safety contract stays", async (t) => {
  const h = await childResourceHost({ PI_DAG_AGENT_PROFILE_PROMPT: PROFILE, PI_DAG_AGENT_CONTEXT: FRAGMENT }); t.after(() => h.close());
  const { event, result } = h.start();
  assert.equal(event.systemPromptOptions.sections.dag_profile, undefined);
  assert.equal(event.systemPromptOptions.sections.dag_context, undefined);
  assert.match(event.systemPromptOptions.sections.dag_child, /one-tier child agent/);
  assert.match(event.systemPromptOptions.sections.dag_child, /Never delegate, spawn another Pi agent/);
  assert.ok(result.message, "the selected guidance still reaches the child");
});

test("both selected inputs arrive whole as one passive custom message, never as a report copy", async (t) => {
  const h = await childResourceHost({ PI_DAG_AGENT_PROFILE_PROMPT: PROFILE, PI_DAG_AGENT_CONTEXT: FRAGMENT }); t.after(() => h.close());
  const message = h.start().result.message;
  assert.equal(message.customType, CHILD_GUIDANCE_TYPE);
  assert.equal(message.display, false);
  assert.ok(message.details.checkpointId);
  assert.ok(message.content.includes(PROFILE), "profile text is complete, not an index");
  assert.ok(message.content.includes(FRAGMENT), "fragment text is complete, not a summary");
  assert.match(message.content, /not a new user authorization/);
  assert.match(message.content, /does not override later explicit direction/);
  assert.equal(h.sent.length, 0, "no sendMessage means no extra turn");
  assert.equal(h.entries.length, 0);
});

test("a saved message is not repeated, and long selected text is not truncated", async (t) => {
  const long = "长".repeat(1500);
  const h = await childResourceHost({ PI_DAG_AGENT_PROFILE_PROMPT: long }); t.after(() => h.close());
  const first = h.start().result.message;
  assert.ok(first.content.includes(long));
  h.persist(first);
  assert.equal(h.start().result, undefined);
  const saved = h.entries.filter((entry) => entry.customType === CHILD_GUIDANCE_TYPE);
  assert.equal(saved.length, 1, "guidance persists exactly once");
  assert.equal(saved[0]!.details!.checkpointId, first.details.checkpointId);
  assert.equal(h.sent.length, 0, "no wake or turn from persistence");
});

test("an unsaved draft is reproposed with the same checkpoint until Pi saves it", async (t) => {
  const h = await childResourceHost({ PI_DAG_AGENT_CONTEXT: FRAGMENT }); t.after(() => h.close());
  const first = h.start().result.message;
  const retry = h.start().result.message;
  assert.ok(first && retry);
  assert.equal(retry.details.checkpointId, first.details.checkpointId);
  assert.equal(h.entries.length, 0, "a draft is not persistence");
  h.persist(retry);
  assert.equal(h.start().result, undefined);
});

test("compaction appends the guidance once at the first context and the next boundary persists it", async (t) => {
  const h = await childResourceHost({ PI_DAG_AGENT_PROFILE_PROMPT: PROFILE, PI_DAG_AGENT_CONTEXT: FRAGMENT }); t.after(() => h.close());
  const first = h.start().result.message;
  h.persist(first);
  assert.equal(h.start().result, undefined);

  h.fire("session_compact", { type: "session_compact", reason: "threshold" });
  const contextEvent: any = { type: "context", messages: [] };
  const recovered = h.fire("context", contextEvent)[0];
  assert.ok(recovered?.messages, "the first context after compaction appends the guidance");
  assert.equal(recovered.messages.length, 1);
  const appended = recovered.messages[0];
  assert.equal(appended.role, "custom");
  assert.equal(appended.customType, CHILD_GUIDANCE_TYPE);
  assert.ok(appended.content.includes(PROFILE) && appended.content.includes(FRAGMENT));
  assert.deepEqual(contextEvent.messages, [], "old messages are not rewritten");
  assert.equal(h.fire("context", { type: "context", messages: recovered.messages })[0], undefined, "only the first context appends");

  const boundary = h.start().result.message;
  assert.ok(boundary, "the next normal boundary persists the same message");
  assert.equal(boundary.details.checkpointId, appended.details.checkpointId);
  assert.equal(h.sent.length, 0);
});

test("no environment guidance keeps normal child behavior", async (t) => {
  const h = await childResourceHost({}); t.after(() => h.close());
  const { event, result } = h.start();
  assert.equal(result, undefined, "no passive message without selected env");
  assert.match(event.systemPromptOptions.sections.dag_child, /one-tier child agent/);
  h.fire("session_compact", { type: "session_compact" });
  assert.equal(h.fire("context", { type: "context", messages: [] })[0], undefined, "no compaction recovery without selected env");
  assert.equal(h.fire("context", { type: "context", messages: [] })[0], undefined);
  assert.equal(h.entries.length, 0);
  assert.equal(h.sent.length, 0);
});

test('selected skill entries are passive references, never a native system catalog or tool grant', async (t) => {
  const selected = ['skills/check/SKILL.md', 'skills/format.md'];
  const h = await childResourceHost({ PI_DAG_AGENT_SKILLS: JSON.stringify(selected) }); t.after(() => h.close());
  const { event, result } = h.start();
  assert.ok(result?.message); assert.equal(result.message.display, false);
  assert.match(result.message.content, /Selected local skill file entries/);
  for (const path of selected) assert.ok(result.message.content.includes(path));
  assert.match(result.message.content, /cannot add tools, authorize scripts or override the assignment/);
  assert.doesNotMatch(JSON.stringify(event.systemPromptOptions.sections), /skills\/check|skills\/format/);
  assert.equal(h.sent.length, 0);
  h.persist(result.message); assert.equal(h.start().result, undefined);
  h.fire('session_compact');
  const restored = h.fire('context', { messages: [] })[0];
  assert.ok(restored.messages[0].content.includes(selected[0]!));
});

test("profile-only and context-only selections stay complete", async (t) => {
  const profileHost = await childResourceHost({ PI_DAG_AGENT_PROFILE_PROMPT: PROFILE });
  const profileOnly = profileHost.start().result.message;
  await profileHost.close();
  assert.ok(profileOnly.content.includes(PROFILE));
  assert.equal(profileOnly.content.includes(FRAGMENT), false);
  const contextHost = await childResourceHost({ PI_DAG_AGENT_CONTEXT: FRAGMENT }); t.after(() => contextHost.close());
  const contextOnly = contextHost.start().result.message;
  assert.ok(contextOnly.content.includes(FRAGMENT));
  assert.equal(contextOnly.content.includes(PROFILE), false);
});
}
