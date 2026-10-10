import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applyTodo, emptyState } from '../src/todos/state.ts';
import { registerTodos } from '../src/todos/register.ts';

for (const status of ['completed', 'failed', 'cancelled'] as const) test(`status-only ${status} keeps original task requirements unchanged`, () => {
  let state = applyTodo(emptyState(), { action: 'create', subject: 'Check actual artifacts', description: 'Input: result.json. Verify every required field.', metadata: { evidencePath: 'test-results.txt' } }).state;
  const before = structuredClone(state.tasks[0]);
  state = applyTodo(state, { action: 'update', id: 1, status }).state;
  assert.deepEqual(state.tasks[0], { ...before, status });
  const result = applyTodo(state, { action: 'update', id: 1, status });
  assert.equal(result.state, state);
});

test('status guidance keeps reports in the conversation and requirement edits explicit', async () => {
  let state = applyTodo(emptyState(), { action: 'create', subject: 'Check actual artifacts', description: 'Original acceptance criteria' }).state;
  let tool: any;
  registerTodos({ on() {}, registerCommand() {}, registerTool(value: any) { tool = value; } } as any, { state: () => state, protected: () => false, mutate(params) { const result = applyTodo(state, params); state = result.state; return result; }, commit() {}, reset() {}, async show() {} });
  assert.match(tool.parameters.properties.description.description, /not a status log/);
  assert.ok(tool.promptGuidelines.some((line: string) => line.includes('normally update only id/status')));
  const done = await tool.execute('status-only', { action: 'update', id: 1, status: 'completed' }, undefined, undefined, {});
  assert.equal(done.isError, undefined);
  assert.equal(done.details.tasks[0].description, 'Original acceptance criteria');
  assert.doesNotMatch(done.content[0].text, /Original acceptance criteria/);
  assert.equal(applyTodo(state, { action: 'update', id: 1, description: 'An explicit revised requirement' }).state.tasks[0]!.description, 'An explicit revised requirement');
});
