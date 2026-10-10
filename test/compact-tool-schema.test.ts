import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Type } from 'typebox';
import { Value } from 'typebox/value';
import { TodoParamsSchema } from '../src/todos/state.ts';
import { GoalParamsSchema } from '../src/goal/state.ts';

/** Standard string enums preserve the accepted scalar set without repeated anyOf/const objects. */
test('compact enums preserve actions/status/scope validation, including malformed scalar types', () => {
  for (const schema of [TodoParamsSchema, GoalParamsSchema]) {
    const properties: any = schema.properties;
    for (const name of ['action', 'status', 'scope']) {
      const compact = properties[name];
      if (!compact) continue;
      assert.equal(compact.type, 'string'); assert.ok(Array.isArray(compact.enum));
      assert.equal(compact.anyOf, undefined);
      const old = Type.Union(compact.enum.map((value: string) => Type.Literal(value)));
      for (const input of [...compact.enum, 'unsupported-action', '', 1, false, null, undefined, [], {}, ['pending']]) assert.equal(Value.Check(compact, input), Value.Check(old, input), `${name}: ${JSON.stringify(input)}`);
    }
  }
  assert.equal(Value.Check(TodoParamsSchema, { action: 'batch', operations: [{ action: 'create', subject: 'valid', status: 'pending' }] }), true);
  assert.equal(Value.Check(TodoParamsSchema, { action: 'batch', operations: [{ action: 'update', status: 'completed', id: 1 }] }), false);
  assert.equal(Value.Check(GoalParamsSchema, { action: 'update', progress: 'New verified result' }), true);
  assert.equal(Value.Check(GoalParamsSchema, { action: 'update', nolimit: true }), false);
});
