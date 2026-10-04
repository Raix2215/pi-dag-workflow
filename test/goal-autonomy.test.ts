import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { IsolatedClient } from './fixtures/isolated-client.ts';
import { GOAL_TYPE } from '../src/goal/state.ts';

const offline = fileURLToPath(new URL('./fixtures/offline-model.ts', import.meta.url));
const probes = fileURLToPath(new URL('./fixtures/goal-question-tools.ts', import.meta.url));

test('real Pi: configurable nopause bans direct and nested question tools; a user stop restores interaction', { timeout: 30000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'pi-dag-autonomy-'));
  await mkdir(join(root, 'agent', 'pi-dag-workflow'), { recursive: true });
  await writeFile(join(root, 'agent', 'pi-dag-workflow', 'pi-dag-workflow-config.json'), JSON.stringify({ goalNoPauseTools: [' ask_user_question ', 'test_custom_question'] }));
  const client = await IsolatedClient.start(root, 'autonomy', [probes], ['--dag-workflow-test-child-provider', offline]);
  t.after(() => client.close());
  await client.prompt('TEST CALL goal {"action":"create","title":"空闲续跑测试","maxTurns":6}');
  const offset = client.records.length;
  const menu = client.prompt('/goal nopause #1');
  await client.until(() => client.records.slice(offset).some((record) => record.method === 'select'));
  const question = client.records.slice(offset).find((record) => record.method === 'select')!;
  client.child.stdin.write(`${JSON.stringify({ type: 'extension_ui_response', id: question.id, value: (question.options as string[])[1] })}\n`);
  await menu;
  await client.prompt('/goal enable #1');
  await client.until(() => client.records.filter((record) => record.type === 'agent_settled').length >= 2);
  const list = await client.prompt('/test-question-tools');
  const active = JSON.parse(String(list.find((record) => record.method === 'notify')!.message)) as string[];
  assert.ok(!active.includes('ask_user_question'));
  assert.ok(active.includes('goal'));
  for (const name of ['ask_user_question', 'test_nested_question']) {
    const result = await client.prompt(`TEST CALL ${name} {}`);
    const end = result.find((record) => record.type === 'tool_execution_end' && record.toolName === name)!;
    assert.equal(end.isError, true, `${name} cannot ask or execute its question body`);
  }
  await assert.rejects(readFile(join(root, 'question-executed.txt')), { code: 'ENOENT' });
  const state = (await client.entries() as any[]).findLast((entry) => entry.customType === GOAL_TYPE).data;
  assert.equal(state.run.paused, false);
  assert.equal(state.goals[0].modelPause, 'deny');
  await client.prompt('/goal disable #1');
  const restored = await client.prompt('/test-question-tools');
  assert.ok(JSON.parse(String(restored.find((record) => record.method === 'notify')!.message)).includes('ask_user_question'));
  await client.prompt('TEST CALL ask_user_question {}');
  await client.prompt('TEST CALL test_nested_question {}');
  assert.equal(await readFile(join(root, 'question-executed.txt'), 'utf8'), 'ask_user_question\ntest_custom_question\n');
});
