import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { IsolatedClient } from './fixtures/isolated-client.ts';
import { GOAL_TYPE, type GoalState } from '../src/goals.ts';

// Explicit opt-in live acceptance. No child agents, at most 14 provider turns / 90 seconds.
const client = await IsolatedClient.startFlash(['goal']);
const evidence = fileURLToPath(new URL('../../docs/evidence/m3/', import.meta.url));
let aborted = false;
const timer = setTimeout(() => { aborted = true; void client.send('abort').catch(() => {}); }, 90000);
const watch = setInterval(() => {
  if (client.records.filter((record) => record.type === 'turn_start').length >= 14) { aborted = true; void client.send('abort').catch(() => {}); }
}, 50);
let failure: string | undefined;
try {
  await client.prompt('只创建一个 Goal，不启用、不创建 Todo、不操作文件。标题为“小规模验收”，maxTurns=2，description为：在当前目录写入 goal-smoke.txt，内容严格为 healthy\\ngoal\\n，再用 read 核对这两行，核对成功后调用 goal complete。创建后停止。', 60000);
  const entries = await client.entries();
  const goal = (entries as any[]).findLast((entry) => entry.customType === GOAL_TYPE)?.data as GoalState;
  assert.equal(goal.goals.length, 1); assert.equal(goal.goals[0]!.maxTurns, 2); assert.equal(goal.run.paused, true);
  const offset = client.records.length;
  await client.send('prompt', { message: `/goal enable ${goal.goals[0]!.id}` });
  await client.until(() => client.records.slice(offset).some((record) => record.type === 'agent_settled'), 60000);
  const final = (await client.entries() as any[]).findLast((entry) => entry.customType === GOAL_TYPE)?.data as GoalState;
  assert.equal(aborted, false);
  assert.equal(final.goals[0]!.status, 'completed'); assert.equal(final.focusId, undefined);
  assert.ok(final.run.used <= 2);
  assert.equal(await readFile(`${client.root}/goal-smoke.txt`, 'utf8'), 'healthy\ngoal\n');
} catch (cause) { failure = String(cause); }
finally {
  clearInterval(watch); clearTimeout(timer);
  const assistant = client.records.filter((record) => record.type === 'message_end' && (record.message as any)?.role === 'assistant').map((record) => record.message as any);
  const toolCalls = client.records.filter((record) => record.type === 'tool_execution_end');
  const summary = { model: 'example-model', passed: !failure, failure, aborted, requests: client.records.filter((record) => record.type === 'turn_start').length, tools: toolCalls.map((record) => ({ name: record.toolName, isError: record.isError })), estimatedCost: assistant.reduce((sum, message) => sum + (message.usage?.cost?.total ?? 0), 0) };
  await mkdir(evidence, { recursive: true });
  await writeFile(`${evidence}goal-flash-summary.json`, JSON.stringify(summary, null, 2) + '\n');
  console.log(JSON.stringify(summary, null, 2));
  await client.close();
}
if (failure) throw new Error(failure);
