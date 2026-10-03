import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { IsolatedClient } from './fixtures/isolated-client.ts';
import { GOAL_TYPE, type GoalState } from '../src/goal/state.ts';

// Explicit opt-in live acceptance: PI_DAG_TEST_MODEL chooses the provider, never a private default.
// Two different Goal continuation messages must advance two verified file-writing phases.
const client = await IsolatedClient.startFlash(['goal']);
let aborted = false;
const abort = () => { aborted = true; void client.send('abort').catch(() => {}); };
const timer = setTimeout(abort, 90000);
const watch = setInterval(() => { if (client.records.filter((record) => record.type === 'turn_start').length >= 18) abort(); }, 50);
try {
  const description = '这是严格的两轮续跑验收，不创建 Todo。首次收到 Goal # 续跑消息时，只写 phase-one.txt，内容 ONE\\n，并用 read 验证；然后 goal update progress="第一阶段已核验" nextStep="第二阶段：写 phase-two.txt，内容 TWO\\n；read 核验两份文件的内容后 goal complete。"。update 后本轮不再调用工具，输出一句阶段完成并结束。仅当收到下一条 Goal # 续跑消息时，才执行第二阶段并完成目标。';
  await client.prompt(`只创建一个 Goal，title="Two-round continuation check"，maxTurns=3，description=${JSON.stringify(description)}。不启用，不写文件，创建后结束。`, 60000);
  const goal = (await client.entries() as any[]).findLast((entry) => entry.customType === GOAL_TYPE)?.data as GoalState;
  assert.equal(goal.goals.length, 1);
  const mark = client.records.length;
  await client.send('prompt', { message: `/goal enable ${goal.goals[0]!.id}` });
  await client.until(() => client.records.slice(mark).some((record) => record.type === 'entry_appended' && (record.entry as any)?.customType === GOAL_TYPE && (record.entry as any)?.data?.goals[0]?.status === 'completed'), 60000);
  const entries = await client.entries() as any[];
  const final = entries.findLast((entry) => entry.customType === GOAL_TYPE).data as GoalState;
  assert.equal(aborted, false);
  assert.equal(final.run.used, 2, 'the second phase must follow a separately budgeted automatic continuation');
  assert.equal(entries.filter((entry) => entry.customType === 'pi-dag-workflow.goal-continue').length, 1, 'idle enable uses a user message, the second phase uses a boundary continuation');
  assert.equal(await readFile(join(client.root, 'phase-one.txt'), 'utf8'), 'ONE\n');
  assert.equal(await readFile(join(client.root, 'phase-two.txt'), 'utf8'), 'TWO\n');
  console.log(JSON.stringify({ passed: true, automaticRounds: final.run.used, requests: client.records.filter((record) => record.type === 'turn_start').length }, null, 2));
} finally {
  clearInterval(watch); clearTimeout(timer);
  await client.close();
}
