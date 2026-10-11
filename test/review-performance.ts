import { performance } from 'node:perf_hooks';
import { applyTodo, emptyState, newlyReady, type Todo } from '../src/todos/state.ts';
import { fragmentContext } from '../src/agents/context.ts';
import { registerGoal } from '../src/goal/register.ts';
import { defaultConfig } from '../src/shared/config.ts';

function measure(fn: () => void, samples = 100) {
  for (let i = 0; i < 5; i++) fn();
  const times: number[] = [];
  for (let i = 0; i < samples; i++) { const start = performance.now(); fn(); times.push(performance.now() - start); }
  times.sort((a, b) => a - b);
  return { samples, medianMs: times[Math.floor(samples / 2)], p95Ms: times[Math.floor(samples * .95)] };
}
const tasks: Todo[] = Array.from({ length: 4096 }, (_, i) => ({ id: i + 1, subject: `Task ${i}`, status: 'completed', blockedBy: [] }));
tasks.push({ id: 4097, subject: 'Consumer', status: 'pending', blockedBy: tasks.map((item) => item.id) });
const state = { ...emptyState(), tasks, nextId: 4098 };
const fragment: Todo[] = [{ id: 1, subject: 'Producer', status: 'completed', blockedBy: [], metadata: { preset: 'probe', run: 1, key: 'first', step: 1 } }, { id: 2, subject: 'Consumer', status: 'pending', blockedBy: [1], metadata: { preset: 'probe', run: 1, key: 'last', step: 2 } }];
const report = [{ todoId: 1, status: 'completed', output: 'VISIBLE-RESULT ' + 'x'.repeat(8 * 1024 * 1024) }];
const events = new Map<string, Function[]>(); const tools = new Map<string, any>(); const commands = new Map<string, any>(); const history: any[] = [];
let goals = 0;
const pi: any = { on(n: string, f: Function) { events.set(n, [...events.get(n) ?? [], f]); }, registerTool(t: any) { tools.set(t.name, t); }, registerCommand(n: string, c: any) { commands.set(n, c); }, appendEntry(t: string, d: unknown) { history.push({ type: 'custom', customType: t, data: d }); }, sendMessage() {}, sendUserMessage() {} };
const ctx: any = { isIdle: () => false, hasUI: true, ui: { notify() {}, select: async (_: string, choices: string[]) => choices[1] }, sessionManager: { getBranch: () => history } };
registerGoal(pi, { state: () => state, jobs: () => [], paint() {}, protected: () => false, pauseAgents() {}, resumeAgents() {}, loadConfig: async () => defaultConfig() });
await tools.get('goal').execute('test', { action: 'create', title: 'Benchmark' }, undefined, undefined, ctx);
for (const f of events.get('input') ?? []) f({ source: 'rpc', text: 'enable' }, ctx);
await tools.get('goal').execute('test', { action: 'enable', id: 1 }, undefined, undefined, ctx);
await commands.get('goal').handler('nolimit #1', ctx); await commands.get('goal').handler('nopause #1', ctx);
const round = () => {
  let event: any = { outcome: 'completed', continue: false, entries: [] };
  for (const f of events.get('agent_before_settle') ?? []) { const result = f(event, ctx); if (result?.entries) event.entries = result.entries; if (result?.continue) event.continue = true; }
  for (const f of events.get('turn_start') ?? []) f({}, ctx);
  goals++;
};
const results = {
  note: 'Same-input local CPU microbenchmark. No paid model, real TUI or billing/cache claim.', node: process.version,
  unchangedReady4097: measure(() => { newlyReady(state, state); }),
  start4096Prerequisites: measure(() => { applyTodo(state, { action: 'update', id: 4097, status: 'in_progress' }); }, 30),
  fragment8MiBReport: measure(() => { fragmentContext(2, fragment, report); }, 30),
  goalRound4097Tasks: measure(round, 50),
};
for (const f of events.get('session_shutdown') ?? []) await f({}, ctx);
console.log(JSON.stringify({ ...results, goalRoundsMeasured: goals }, null, 2));
