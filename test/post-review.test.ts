import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ProfileStore } from '../src/profiles.ts';
import { AgentNotices } from '../src/agent-notices.ts';
import { IsolatedClient } from './fixtures/isolated-client.ts';

test('known non-reasoning Profile is rejected before spawning, but off is accepted', () => {
  const model = { provider: 'plain', id: 'model' };
  const profiles = new ProfileStore({ registry: { find: () => ({ ...model, reasoning: false }) } });
  assert.throws(() => profiles.set({ name: 'invalid', model, thinking: 'high' }), /does not support thinking/);
  profiles.set({ name: 'valid', model, thinking: 'off' });
  assert.equal(profiles.resolve('valid').thinking, 'off');
  assert.equal(profiles.list().length, 1);
});
test('notice truncation never splits UTF-16 pairs and counts whole message overhead', () => {
  const notices = new AgentNotices();
  notices.add({ jobId: 'a1', kind: 'completed', message: 'x'.repeat(2047) + '😀' });
  const result = notices.drain((notice) => notice.message)!;
  assert.ok(!/[\uD800-\uDBFF]$/.test(result));
  assert.equal(new TextDecoder().decode(new TextEncoder().encode(result)), result);
});
test('actual Pi: explicit Agent resume works without a current Goal but never bypasses a paused Goal', { timeout: 30000 }, async (t) => {
  const client = await IsolatedClient.start(); t.after(() => client.close());
  await client.prompt('TEST CALL goal {"action":"create","title":"完成测试","maxTurns":2}');
  await client.prompt('TEST CALL goal {"action":"enable","id":1}');
  let events = await client.prompt('/agents resume');
  assert.ok(events.some((event) => event.method === 'notify' && String(event.message).includes('后续新结果')));
  assert.ok(!events.some((event) => event.type === 'agent_start'));
  await client.prompt('TEST CALL goal {"action":"create","title":"暂停测试","maxTurns":1}');
  await client.prompt('TEST CALL goal {"action":"enable","id":2}');
  events = await client.prompt('/agents resume');
  assert.ok(events.some((event) => event.method === 'notify' && String(event.message).includes('先明确 /goal resume')));
  const entries = await client.entries() as any[];
  const goal = entries.findLast((entry) => entry.customType === 'pi-dag-workflow.goal').data;
  assert.equal(goal.run.paused, true); assert.equal(goal.run.used, 1);
});
