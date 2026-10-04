import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { AgentRuntime } from '../src/agents/runtime.ts';
import { ProfileStore } from '../src/agents/profiles.ts';
import { registerGoal } from '../src/goal/register.ts';
import { emptyState, type Todo } from '../src/todos/state.ts';

function measure(fn: () => void, samples = 200) {
  for (let i = 0; i < 20; i++) fn();
  const times: number[] = [];
  for (let i = 0; i < samples; i++) { const start = performance.now(); fn(); times.push(performance.now() - start); }
  times.sort((a, b) => a - b);
  return { samples, medianMs: times[Math.floor(samples / 2)], p95Ms: times[Math.floor(samples * .95)] };
}
const model = { provider: 'fixture', id: 'model' };
const profiles = new ProfileStore({ registry: { find: () => model } });
const runtime = new AgentRuntime({ cwd: '.', profiles, getInheritedModel: () => model });
const whiteOutput = ' '.repeat(65536);
await runtime.importSummaries(Array.from({ length: 128 }, (_, i) => ({ id: `a${i + 1}`, profile: 'profile', model, thinking: 'off' as const, tools: ['read'], status: 'completed' as const, startedAt: 1, endedAt: 2, pendingRequests: 0, output: i % 2 ? whiteOutput + 'result' : whiteOutput })));
const inspection = measure(() => { const jobs = runtime.inspect(); assert.equal(jobs[0]!.hasOutput, false); assert.equal(jobs[1]!.hasOutput, true); });
await runtime.shutdown();

function goalHost(tasks: Todo[]) {
  const events = new Map<string, Function[]>(), tools = new Map<string, any>(), commands = new Map<string, any>();
  let branchReads = 0, leaf = 30000;
  const history: any[] = Array.from({ length: leaf }, (_, i) => ({ type: 'custom', id: `e${i}`, customType: 'fixture', data: {} }));
  history.push({ type: 'message', id: `m${leaf}`, message: { role: 'assistant', stopReason: 'stop' } });
  const ctx: any = { cwd: '.', hasUI: true, mode: 'rpc', isIdle: () => false, sessionManager: { getSessionId: () => 'fixture-session', getLeafId: () => String(leaf), getBranch: () => { branchReads++; return [...history]; } }, ui: { notify() {}, select: async (_title: string, choices: string[]) => choices[1] } };
  const pi: any = { on(name: string, fn: Function) { events.set(name, [...events.get(name) ?? [], fn]); }, registerTool(tool: any) { tools.set(tool.name, tool); }, registerCommand(name: string, cmd: any) { commands.set(name, cmd); }, appendEntry(customType: string, data: unknown) { history.push({ type: 'custom', id: `e${++leaf}`, customType, data }); }, sendMessage() {}, sendUserMessage() {} };
  const controller = registerGoal(pi, { state: () => ({ ...emptyState(), tasks, nextId: tasks.length + 1 }), jobs: () => [], protected: () => false, paint() {}, pauseAgents() {}, resumeAgents() {} });
  const input = () => { for (const fn of events.get('input') ?? []) fn({ source: 'rpc', text: 'ordinary input' }, ctx); };
  const call = (params: any) => tools.get('goal').execute('fixture', params, undefined, undefined, ctx);
  return { controller, reserve: () => controller.reserveWake(ctx), input, call, unlimited: () => commands.get('goal').handler('nolimit #1', ctx), branchReads: () => branchReads };
}
const inactive = goalHost([]);
const ordinaryInput = measure(inactive.input);
const inactiveReads = inactive.branchReads();
const tasks: Todo[] = Array.from({ length: 4096 }, (_, i) => ({ id: i + 1, subject: `task ${i}`, status: 'completed', blockedBy: [] }));
const active = goalHost(tasks);
await active.call({ action: 'create', title: 'performance fixture', description: 'requirement '.repeat(500) });
active.input(); await active.call({ action: 'enable', id: 1 }); await active.unlimited();
const wakeReservation = measure(() => { assert.equal(active.reserve(), true); });
console.log(JSON.stringify({ note: 'Local isolated hot-path microbenchmark, not provider or terminal latency; same behavior asserted before/after', node: process.version, inspect128LongOutputs: inspection, ordinaryInput30000Entries: ordinaryInput, ordinaryInputBranchReads: inactiveReads, goalWake4096Tasks: wakeReservation }, null, 2));
