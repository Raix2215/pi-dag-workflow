import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AgentRuntime } from '../src/agents/runtime.ts';
import { ProfileStore } from '../src/agents/profiles.ts';

test('lightweight UI job projection excludes model/tools/private output and cannot mutate runtime', async () => {
  const model = { provider: 'test', id: 'model' };
  const runtime = new AgentRuntime({ cwd: '.', profiles: new ProfileStore({ registry: { find: () => model } }), getInheritedModel: () => model });
  try {
    await runtime.importSummaries([{ id: 'a1', todoId: 1, profile: 'test', status: 'completed', model, tools: ['read'], thinking: 'off', startedAt: 1, pendingRequests: 0, output: 'private result', truncated: false, requests: [] }]);
    const view = runtime.viewSummaries();
    assert.deepEqual(view, [{ id: 'a1', todoId: 1, profile: 'test', status: 'completed' }]);
    assert.doesNotMatch(JSON.stringify(view), /tools|model|private|output/);
    view[0]!.profile = 'changed';
    assert.equal(runtime.inspect('a1')[0]!.profile, 'test');
    assert.equal((await runtime.wait('a1', { timeout: 0 })).output, 'private result');
  } finally { await runtime.shutdown(); }
});
