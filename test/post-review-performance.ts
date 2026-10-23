import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { AgentRuntime } from "../src/agents/domain/runtime.ts";
import { ProfileStore } from "../src/agents/domain/profiles.ts";

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
const report = { note: 'Local hot-cache microbenchmark; before/after selection does the same work. Not a terminal latency guarantee.', agents128: { beforeFullInspection: measure(oldSummary), afterUiProjection: measure(newSummary) } };
await runtime.shutdown();
const dir = fileURLToPath(new URL('../../docs/evidence/m4/', import.meta.url));
await mkdir(dir, { recursive: true }); await writeFile(`${dir}post-review-performance.json`, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
