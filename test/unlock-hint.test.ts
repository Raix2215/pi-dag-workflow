import assert from 'node:assert/strict';
import { test } from 'node:test';
import { IsolatedClient } from './fixtures/isolated-client.ts';

for (const language of ['zh-CN', 'en']) {
  test(`newly ready tasks reach the Todo result without a separate UI notification (${language})`, { timeout: 30000 }, async (t) => {
    const client = await IsolatedClient.start(undefined, 'unlock-hint', [], [], false, undefined, language);
    t.after(() => client.close());
    await client.prompt('TEST CALL todo {"action":"create","subject":"first task"}');
    await client.prompt('TEST CALL todo {"action":"create","subject":"second task","blockedBy":[1]}');
    const events = await client.prompt('TEST CALL todo {"action":"update","id":1,"status":"completed"}');
    const call = events.find((event) => event.type === 'tool_execution_end' && event.toolName === 'todo')!;
    assert.ok(call && !call.isError);
    const result = call.result as { content: { type: string; text: string }[]; details: { tasks: { id: number; status: string }[] } };
    const text = result.content.filter((part) => part.type === 'text').map((part) => part.text).join('\n');
    assert.match(text, /#2 second task/);
    assert.ok(!events.some((event) => event.method === 'notify' && String(event.message).includes('#2 second task')), 'the UI must not repeat the tool result');
    const read = await client.prompt('TEST CALL todo {"action":"get","id":2}');
    const successor = read.find((event) => event.type === 'tool_execution_end' && event.toolName === 'todo')!.result as typeof result;
    assert.equal(successor.details.tasks[0]!.status, 'pending', 'the hint never starts the successor');
  });
}
