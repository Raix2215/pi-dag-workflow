import assert from 'node:assert/strict';
import { test } from 'node:test';
import { IsolatedClient } from './fixtures/isolated-client.ts';
import { GOAL_TYPE } from '../src/goal/state.ts';
import { goalWakeRules, GOAL_EXECUTION_RULE } from '../src/goal/prompt.ts';

for (const nopause of [false, true]) test(`real Pi: bounded ${nopause ? 'nopause' : 'ordinary'} Goal exposes repeatable context sizes without claiming model tokens`, { timeout: 30000 }, async (t) => {
  const client = await IsolatedClient.start(undefined, 'goal-context-cost', [], ['--dag-test-context-metrics']);
  t.after(() => client.close());
  await client.prompt('TEST CALL goal {"action":"create","title":"预算测试","maxTurns":6}');
  if (nopause) {
    const configuring = client.prompt('/goal nopause #1');
    await client.until(() => client.records.some((record) => record.type === 'extension_ui_request' && record.method === 'select'));
    const menu = client.records.findLast((record) => record.type === 'extension_ui_request' && record.method === 'select')!;
    client.child.stdin.write(`${JSON.stringify({ type: 'extension_ui_response', id: menu.id, value: (menu.options as string[])[1] })}\n`);
    await configuring;
  }
  await client.prompt('/goal enable #1');
  await client.until(() => client.records.some((record) => (record.entry as any)?.customType === GOAL_TYPE && (record.entry as any).data.run.reason?.includes('轮上限')));
  const entries = await client.entries() as any[];
  const wakes = entries.filter((entry) => entry.customType === 'pi-dag-workflow.goal-continue');
  assert.equal(wakes.length, 5);
  const goalState = entries.findLast((entry) => entry.customType === GOAL_TYPE).data;
  const activeState = { ...goalState, run: { ...goalState.run, paused: false, stalled: 0 } };
  assert.ok(wakes.every((entry) => entry.content.includes(goalWakeRules(activeState, 8))));
  assert.ok(wakes.every((entry) => !entry.content.includes(GOAL_EXECUTION_RULE)), 'wakes use the approved compact reminder');
  const metrics = entries.filter((entry) => entry.customType === 'dag-test.context-metrics').map((entry) => entry.data);
  const rules = metrics.map((entry) => entry.messages.reduce((sum: number, message: any) => sum + message.executionRules + message.sectionExecutionRules, 0));
  assert.equal(Math.max(...rules), 1, 'full rules occur only in the checkpoint, not the system or every wake');
  assert.ok(metrics.every((entry) => entry.messages.every((message: any) => message.sectionExecutionRules === 0)), 'no Goal rules in system sections');
  assert.ok(metrics.every((entry) => Number.isInteger(entry.contextBytes) && entry.contextBytes > 0));
  t.diagnostic(JSON.stringify({ mode: nopause ? 'nopause' : 'ordinary', wakeChars: wakes.map((entry) => entry.content.length), wakeBytes: wakes.map((entry) => Buffer.byteLength(entry.content)), contextBytes: metrics.map((entry) => entry.contextBytes), ruleOccurrences: rules, systemBytes: [...new Set(metrics.map((entry) => entry.systemBytes))], toolsBytes: [...new Set(metrics.map((entry) => entry.toolsBytes))] }));
});
