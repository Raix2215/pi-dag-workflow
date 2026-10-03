import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applyTodo, emptyState } from '../src/todos/state.ts';
import { planViolation } from '../src/plan/policy.ts';
import { createTranslator } from '../src/shared/i18n.ts';
import { IsolatedClient } from './fixtures/isolated-client.ts';

for (const locale of ['zh-CN', 'en'] as const) {
  test(`create accepts safe initial status with unchanged Plan and dependency guards (${locale})`, () => {
    const msg = createTranslator(locale);
    const initial = emptyState();
    const omitted = applyTodo(initial, { action: 'create', subject: 'default' }, msg).state;
    const pending = applyTodo(initial, { action: 'create', subject: 'default', status: 'pending' }, msg).state;
    assert.deepEqual(pending, omitted);
    assert.equal(applyTodo(initial, { action: 'create', subject: 'start now', status: 'in_progress' }, msg).state.tasks[0]!.status, 'in_progress');
    const before = JSON.stringify(pending);
    assert.throws(() => applyTodo(pending, { action: 'create', subject: 'blocked', status: 'in_progress', blockedBy: [1] }, msg), locale === 'en' ? /Prerequisites incomplete/ : /前置未完成/);
    assert.equal(JSON.stringify(pending), before, 'a failed create is atomic and cannot consume an id');
    const complete = applyTodo(pending, { action: 'update', id: 1, status: 'completed' }, msg).state;
    assert.equal(applyTodo(complete, { action: 'create', subject: 'ready', status: 'in_progress', blockedBy: [1] }, msg).state.tasks[1]!.status, 'in_progress');
    for (const status of ['completed', 'deleted'] as const) assert.throws(() => applyTodo(initial, { action: 'create', subject: 'forbidden initial state', status }, msg), /pending.*in_progress/);
    assert.equal(initial.nextId, 1); assert.equal(initial.tasks.length, 0);
    const plan = { ...initial, plan: true };
    assert.equal(applyTodo(plan, { action: 'create', subject: 'plan', status: 'pending' }, msg).state.tasks[0]!.status, 'pending');
    assert.throws(() => applyTodo(plan, { action: 'create', subject: 'cannot start in Plan', status: 'in_progress' }, msg), /Plan/);
    assert.ok(planViolation(plan, 'todo', { action: 'create', subject: 'blocked at execution', status: 'in_progress' }, msg));
    assert.equal(planViolation(plan, 'todo', { action: 'create', subject: 'allowed', status: 'pending' }, msg), undefined);
    assert.equal(planViolation(plan, 'todo', { action: 'list', status: 'in_progress' }, msg), undefined, 'listing a status stays read-only');
  });
}

async function call(client: IsolatedClient, params: object) {
  const events = await client.prompt(`TEST CALL todo ${JSON.stringify(params)}`);
  const event = events.find((record) => record.type === 'tool_execution_end' && record.toolName === 'todo')!;
  assert.ok(event, 'todo executed');
  return { ...(event.result as any), isError: event.isError === true || (event.result as any).isError === true };
}

test('actual Pi create status uses the same atomic rules through normal and Plan tool paths', { timeout: 30000 }, async (t) => {
  const client = await IsolatedClient.start(); t.after(() => client.close());
  const pending = await call(client, { action: 'create', subject: 'first', status: 'pending' });
  assert.equal(pending.isError, false); assert.equal(pending.details.tasks[0].status, 'pending');
  const blocked = await call(client, { action: 'create', subject: 'blocked', status: 'in_progress', blockedBy: [1] });
  assert.equal(blocked.isError, true);
  await call(client, { action: 'update', id: 1, status: 'completed' });
  const started = await call(client, { action: 'create', subject: 'ready', status: 'in_progress', blockedBy: [1] });
  assert.equal(started.isError, false); assert.equal(started.details.nextId, 3); assert.equal(started.details.tasks[1].id, 2);
  await call(client, { action: 'update', id: 2, status: 'completed' });
  await client.prompt('/plan start');
  assert.equal((await call(client, { action: 'create', subject: 'plan pending', status: 'pending' })).isError, false);
  assert.equal((await call(client, { action: 'create', subject: 'plan started', status: 'in_progress' })).isError, true);
  const list = await call(client, { action: 'list' });
  assert.equal(list.details.nextId, 4, 'rejected creates never advance the counter');
});
