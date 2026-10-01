import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { AgentRuntime } from '../src/agents/runtime.ts';
import { ProfileStore } from '../src/agents/profiles.ts';

test('protocol activity tracks parallel tools and clears on terminal/restore without persisting deltas', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dag-audit-'));
  const model = { provider: 'fixture', id: 'model' };
  const observed: string[] = [];
  let changes = 0;
  const runtime = new AgentRuntime({ cwd: root, profiles: new ProfileStore({ registry: { find: () => model } }), getInheritedModel: () => model,
    testCliPath: fileURLToPath(new URL('./fixtures/m2-rpc-fixture.mjs', import.meta.url)),
    onActivity() { const activity = runtime.activities()[0]?.activity; observed.push(activity ? `${activity.kind}:${activity.tool ?? ''}` : 'none'); },
    onChanged() { changes++; },
  });
  try {
    await assert.rejects(runtime.spawn({ task: 'HOLD', timeout: 0 }), /timeout/);
    const job = await runtime.spawn({ task: 'ACTIVITY' });
    const result = await runtime.wait(job.id, { timeout: 5 });
    assert.equal(result.status, 'completed');
    assert.deepEqual(observed.slice(0, 5), ['thinking:', 'output:', 'tool:very_long_tool_name', 'tool:read', 'tool:read']);
    assert.ok(!observed.includes('output:') || observed.lastIndexOf('output:') === 1, 'text while a tool is active cannot replace it');
    assert.equal(runtime.activities().length, 0);
    assert.doesNotMatch(JSON.stringify(runtime.exportRecords()), /activity|since|thinking:/);
    assert.ok(changes <= 5, 'streaming deltas must not write durable snapshots');
    const pending = await runtime.spawn({ task: 'HOLD' });
    await runtime.shutdown();
    await runtime.importSummaries(runtime.exportRecords());
    assert.equal(runtime.inspect(pending.id)[0]!.status, 'interrupted');
    assert.equal(runtime.activeCount(), 0);
    const next = await runtime.spawn({ task: 'available after cancelled navigation' });
    assert.equal((await runtime.wait(next.id)).status, 'completed');
  } finally { await runtime.shutdown(); await rm(root, { recursive: true, force: true }); }
});
