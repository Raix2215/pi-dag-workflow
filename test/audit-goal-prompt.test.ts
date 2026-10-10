import assert from 'node:assert/strict';
import { test } from 'node:test';
import { IsolatedClient } from './fixtures/isolated-client.ts';

test('actual Pi: idle Goal enable after Plan uses fresh Normal/Goal guidance and acceptance description', { timeout: 30000 }, async (t) => {
  const client = await IsolatedClient.start(); t.after(() => client.close());
  await client.prompt('TEST CALL goal {"action":"create","title":"完成测试","description":"附加验收要求","maxTurns":2}');
  await client.prompt('/plan start'); await client.prompt('只读探索');
  await client.prompt('/plan off');
  const offset = client.records.length;
  await client.send('prompt', { message: '/goal enable 1' });
  await client.until(() => client.records.slice(offset).some((record) => record.type === 'agent_settled'));
  const entries = await client.entries() as any[];
  const system = entries.findLast((entry) => entry.message?.role === 'system');
  assert.ok(!Object.keys(system.message.sections ?? {}).some((key) => key.startsWith('dag_workflow')));
  const mode = entries.findLast((entry) => entry.customType === 'pi-dag-workflow.guidance');
  assert.match(mode.content, /Normal: continue the existing Todo list/);
  assert.match(mode.content, /Goal stays paused until explicitly enabled/);
  const checkpoint = entries.find((entry) => entry.customType === 'pi-dag-workflow.goal-checkpoint' && entry.content.includes('"paused":false'));
  assert.match(checkpoint.content, /附加验收要求/);
  assert.match(checkpoint.content, /verify every requirement/);
  assert.equal(entries.findLast((entry) => entry.customType === 'pi-dag-workflow.goal').data.goals[0].status, 'completed');
});
