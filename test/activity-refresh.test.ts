import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { registerAgents } from '../src/agents/register.ts';
import { AgentRuntime, type AgentRuntimeOptions, type JobSummary } from '../src/agents/runtime.ts';
import { emptyState } from '../src/todos/state.ts';

test('tool activity repaints past 99 seconds and stops its timer on completion and shutdown', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dag-activity-refresh-'));
  const prior = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = join(root, 'agent');
  await mkdir(join(root, 'agent'), { recursive: true });
  let paints = 0; let saved = 0;
  let active = true;
  let onActivity: (() => void) | undefined;
  const events = new Map<string, Function[]>(); const tools = new Map<string, any>();
  const now = 1700000000000;
  const activity = { kind: 'tool' as const, tool: 'bash', since: now - 100000 };
  const job: JobSummary = { id: 'a1', profile: 'inherit', model: { provider: 'dag-test', id: 'scripted' }, thinking: 'off', tools: ['read'], status: 'running', startedAt: now - 101000, pendingRequests: 0 };
  t.mock.method(AgentRuntime.prototype, 'activities', () => active ? [{ jobId: 'a1', activity }] : []);
  t.mock.method(AgentRuntime.prototype, 'viewSummaries', () => [{ ...job, ...(active ? { activity } : {}) }]);
  // Exercise the actual registration timer without starting a process or waiting 100 real seconds.
  t.mock.method(AgentRuntime.prototype, 'spawn', async function(this: AgentRuntime) {
    onActivity = (this as unknown as { options: AgentRuntimeOptions }).options.onActivity;
    onActivity?.(); return job;
  });
  const pi: any = { on(name: string, handler: Function) { events.set(name, [...events.get(name) ?? [], handler]); }, registerFlag() {}, registerTool(tool: any) { tools.set(tool.name, tool); }, registerCommand() {}, getFlag() {}, appendEntry() { saved++; } };
  const ctx: any = { cwd: root, hasUI: true, isIdle: () => false, sessionManager: { getBranch: () => [] }, modelRegistry: {}, ui: { notify() {} } };
  registerAgents(pi, { state: emptyState, mutate() {}, paint() { paints++; }, protected: () => false });
  t.after(async () => {
    for (const handler of events.get('session_shutdown') ?? []) await handler({}, ctx);
    t.mock.timers.reset();
    if (prior === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = prior;
    await rm(root, { recursive: true, force: true });
  });
  for (const handler of events.get('session_start') ?? []) await handler({}, ctx);
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now });
  await tools.get('subagent_spawn').execute('test', { task: 'long tool' }, undefined, undefined, ctx);
  t.mock.timers.tick(1);
  const first = paints;
  const persisted = saved;
  t.mock.timers.tick(1000); assert.equal(paints, first + 1);
  t.mock.timers.tick(1000); assert.equal(paints, first + 2, 'a >99s tool keeps ticking every second');
  assert.equal(saved, persisted, 'clock ticks never append workflow or model state');
  active = false; onActivity?.(); t.mock.timers.tick(1000);
  const stopped = paints;
  t.mock.timers.tick(5000); assert.equal(paints, stopped, 'completion stops repeated activity refresh');
  active = true; onActivity?.(); t.mock.timers.tick(1);
  for (const handler of events.get('session_shutdown') ?? []) await handler({}, ctx);
  const shutDown = paints;
  t.mock.timers.tick(5000); assert.equal(paints, shutDown, 'shutdown cannot leak the long-running activity timer');
});
