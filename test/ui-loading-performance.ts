import { performance } from 'node:perf_hooks';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWorkflow } from '../src/workflow/index.ts';
import { FEATURE_NAMES, type Feature } from '../src/workflow/features.ts';
import { PresetStore } from '../src/todos/presets.ts';
import { emptyState, STATE_TYPE } from '../src/todos/state.ts';
import { renderTasks, renderDag } from '../src/ui/render.ts';
import { IsolatedClient } from './fixtures/isolated-client.ts';

const measure = (fn: () => void, count = 50) => {
  for (let i = 0; i < 5; i++) fn();
  const values: number[] = [];
  for (let i = 0; i < count; i++) { const start = performance.now(); fn(); values.push(performance.now() - start); }
  values.sort((a, b) => a - b);
  return { medianMs: values[Math.floor(count / 2)], p95Ms: values[Math.floor(count * .95)] };
};
const root = await mkdtemp(join(tmpdir(), 'dag-load-bench-'));
const beforeDir = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = join(root, 'agent');
const state = { ...emptyState(), nextId: 4097, tasks: Array.from({ length: 4096 }, (_, index) => ({ id: index + 1, subject: `task ${index}`, status: 'pending' as const, blockedBy: index ? [index] : [] })) };
const history: any[] = Array.from({ length: 30000 }, (_, i) => ({ type: 'custom', customType: 'fixture', id: `entry-${i}`, data: {} }));
history.push({ type: 'custom', customType: STATE_TYPE, data: state });
let loads = 0;
const originalLoad = PresetStore.prototype.load;
PresetStore.prototype.load = async function() { loads++; return originalLoad.call(this); };
const samples: any[] = [];
try {
  for (let i = 0; i < 10; i++) {
    loads = 0; let branchReads = 0, widgets = 0;
    const handlers = new Map<string, Function[]>();
    const pi: any = { on(name: string, fn: Function) { handlers.set(name, [...handlers.get(name) ?? [], fn]); }, registerTool() {}, registerCommand() {}, registerFlag() {}, getFlag() {}, appendEntry() {}, getActiveTools: () => [], setActiveTools() {}, getAllTools: () => [], events: { on: () => () => {}, emit() {} } };
    const ctx: any = { mode: 'rpc', hasUI: false, cwd: root, isIdle: () => true, sessionManager: { getBranch: () => { branchReads++; return [...history]; }, getSessionFile: () => undefined, getLeafId: () => 'fixture-leaf' }, modelRegistry: { find: () => undefined }, ui: { notify() {}, setWidget() { widgets++; } } };
    const workflow = createWorkflow(pi);
    for (const feature of FEATURE_NAMES) await workflow.attach(feature, pi);
    const event = {};
    const start = performance.now();
    for (const fn of handlers.get('session_start') ?? []) await fn(event, ctx);
    await new Promise((resolve) => setTimeout(resolve, 0));
    samples.push({ ms: performance.now() - start, branchReads, presetLoads: loads, widgets });
    for (const fn of handlers.get('session_shutdown') ?? []) await fn({}, ctx);
  }
  const sorted = samples.map((item) => item.ms).sort((a,b)=>a-b);
  const source = join(import.meta.dirname, '..');
  const cold: Record<string, number[]> = {};
  for (const [name, features] of [['todos', ['todos']], ['goal', ['goal']], ['all', [...FEATURE_NAMES]]] as [string, Feature[]][]) {
    cold[name] = [];
    for (let i = 0; i < 3; i++) {
      const start = performance.now();
      const client = await IsolatedClient.start(undefined, 'loading-benchmark', [], [], false, features.map((feature) => join(source, `src/${feature}/index.ts`)));
      cold[name]!.push(performance.now()-start); await client.close();
    }
  }
  console.log(JSON.stringify({ note: 'Local microbenchmark; cold values include Pi/Node startup, not just extension imports', node: process.version, restore30000Entries4096Tasks: { medianMs: sorted[5], samples }, coldPiStartupMs: cold, gui4096: { previewList: measure(() => { renderTasks(state,80); }), fullList: measure(() => { renderTasks(state,80,{maxRows:Infinity}); }), previewDag: measure(() => { renderDag(state,80,undefined,undefined,[],{maxLines:11}); }), fullDagFallback: measure(() => { renderDag(state,80); }) } }, null, 2));
} finally {
  PresetStore.prototype.load = originalLoad;
  if (beforeDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = beforeDir;
  await rm(root, { recursive: true, force: true });
}
