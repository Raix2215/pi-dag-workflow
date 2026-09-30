import assert from 'node:assert/strict';
import { test } from 'node:test';
import { IsolatedClient } from './fixtures/isolated-client.ts';

test('help is local and read-only: no model calls, mode changes, new tasks or Goal budget resets', { timeout: 30000 }, async (t) => {
  const client = await IsolatedClient.start(); t.after(() => client.close());
  for (const command of ['/todos help', '/plan help', '/agents help', '/goal help']) {
    const records = await client.prompt(command);
    assert.ok(records.some((record) => record.method === 'notify'));
    assert.ok(!records.some((record) => record.type === 'agent_start'));
  }
  assert.ok(!(await client.entries() as any[]).some((entry) => entry.type === 'custom'));
});
