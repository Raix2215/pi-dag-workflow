import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { AgentRuntime } from '../src/agents.ts';
import { ProfileStore } from '../src/profiles.ts';
import { detailView } from '../src/detail-view.ts';

function measure(fn: () => void, samples = 1000) {
  for (let i = 0; i < 20; i++) fn();
  const values: number[] = [];
  for (let i = 0; i < samples; i++) { const begin = performance.now(); fn(); values.push(performance.now() - begin); }
  values.sort((a, b) => a - b);
  return { samples, medianMs: values[Math.floor(samples / 2)], p95Ms: values[Math.floor(samples * 0.95)] };
}
const model = { provider: 'fixture', id: 'model' };
const runtime = new AgentRuntime({ cwd: '.', profiles: new ProfileStore({ registry: { find: () => model } }), getInheritedModel: () => model });
await runtime.importSummaries(Array.from({ length: 128 }, (_, i) => ({ id: `a${i + 1}`, profile: 'profile', model, thinking: 'off' as const, tools: ['read', 'grep', 'find', 'ls'], status: 'completed' as const, startedAt: 1, endedAt: 2, pendingRequests: 0 })));
const oldSummary = () => runtime.inspect().map((job) => ({ id: job.id, todoId: job.todoId, profile: job.profile, status: job.status }));
const newSummary = () => runtime.viewSummaries();
assert.deepEqual(newSummary().map((job) => job.id), oldSummary().map((job) => job.id));
const data = ['HEADER', ...Array.from({ length: 4096 }, (_, i) => `row ${i}`)];
let layouts = 0;
const panel = detailView(() => { layouts++; return data; }, () => 30, () => {}, () => {});
panel.render(80);
const cachedBody = data.slice(1);
const beforeScrollAllocation = () => { const body = data.slice(1); return ['HEADER', ...body.slice(10, 34), 'footer']; };
const afterScrollAllocation = () => ['HEADER', ...cachedBody.slice(10, 34), 'footer'];
const afterScroll = () => { panel.handleInput!('\x1b[B'); panel.render(80); };
assert.deepEqual(beforeScrollAllocation(), afterScrollAllocation());
const report = { note: 'Local hot-cache microbenchmark; before/after selection does the same work, actualPanel includes key handling/scroll/footer. Not a terminal latency guarantee.', agents128: { beforeFullInspection: measure(oldSummary), afterUiProjection: measure(newSummary) }, detail4096: { beforeSelectionArrayCopy: measure(beforeScrollAllocation), afterCachedSelection: measure(afterScrollAllocation), actualPanelScrollRender: measure(afterScroll), layouts } };
assert.equal(layouts, 1);
await runtime.shutdown();
const dir = fileURLToPath(new URL('../../docs/evidence/m4/', import.meta.url));
await mkdir(dir, { recursive: true }); await writeFile(`${dir}post-review-performance.json`, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
