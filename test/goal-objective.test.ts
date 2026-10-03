import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { IsolatedClient } from './fixtures/isolated-client.ts';
import { GOAL_TYPE, type GoalState } from '../src/goal/state.ts';
import { STATE_TYPE } from '../src/todos/state.ts';

for (const language of ['zh-CN', 'en']) {
  test(`real Pi: finished Todos and a plain final answer do not end an active Goal (${language})`, { timeout: 30000 }, async (t) => {
    const client = await IsolatedClient.start(undefined, 'goal-objective', [], ['--dag-test-plain-goal'], false, undefined, language);
    t.after(() => client.close());
    await client.prompt('TEST CALL todo {"action":"create","subject":"finish the first phase"}');
    await client.prompt('TEST CALL goal {"action":"create","title":"Complete the full objective","description":"The first Todo is only a phase; write objective evidence before completion.","maxTurns":6}');
    await client.prompt('/goal enable #1');
    await client.until(() => client.records.some((event) => event.type === 'entry_appended' && (event.entry as any)?.customType === GOAL_TYPE && (event.entry as any).data.goals[0].status === 'completed'));
    const entries = await client.entries() as any[];
    const final = entries.findLast((entry) => entry.type === 'custom' && entry.customType === GOAL_TYPE).data as GoalState;
    assert.equal(final.goals[0]!.status, 'completed');
    assert.equal(final.run.used, 2);
    assert.equal(final.run.reason, language === 'en' ? 'Goal completed' : '目标已完成');
    assert.equal(await readFile(join(client.root, 'objective-evidence.txt'), 'utf8'), 'GOAL-CONTINUED\n');
    const continued = entries.findIndex((entry) => entry.customType === 'pi-dag-workflow.goal-continue');
    assert.ok(continued > 0, 'an automatic decision follows the first model final answer');
    assert.match(entries[continued].content, /goal get/);
    const earlierTodo = entries.slice(0, continued).findLast((entry) => entry.type === 'custom' && entry.customType === STATE_TYPE).data;
    assert.ok(earlierTodo.tasks.every((task: any) => task.status === 'completed'), 'all Todos were already complete before the objective continuation');
    const earlierGoal = entries.slice(0, continued).filter((entry) => entry.type === 'custom' && entry.customType === GOAL_TYPE).map((entry) => entry.data as GoalState);
    assert.ok(earlierGoal.some((state) => state.run.used === 1 && !state.run.paused && state.run.nextStep === undefined));
    assert.ok(!earlierGoal.some((state) => state.run.reason === '没有具体下一步，等待用户' || state.run.reason === 'No concrete next step; waiting for the user'));
    assert.ok(entries.slice(0, continued).some((entry) => entry.type === 'message' && entry.message?.role === 'assistant' && entry.message.stopReason === 'stop'), 'the first round actually stopped; native tool follow-ups alone cannot explain phase two');
  });
}
