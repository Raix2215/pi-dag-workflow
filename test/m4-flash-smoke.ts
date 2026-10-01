import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { IsolatedClient } from './fixtures/isolated-client.ts';
import { STATE_TYPE } from '../src/todos/state.ts';
import { GOAL_TYPE } from '../src/goal/state.ts';
import { AGENTS_TYPE } from '../src/agents/index.ts';

// Explicit low-cost integration: parent + two short children, bounded wall time/parent turns.
const client = await IsolatedClient.startFlash(['goal', 'subagent_spawn', 'subagent_wait', 'subagent_inspect', 'subagent_send', 'subagent_cancel']);
let stopped = false;
const abort = () => { stopped = true; void client.send('abort').catch(() => {}); };
const deadline = setTimeout(abort, 120000);
const watchdog = setInterval(() => { if (client.records.filter((record) => record.type === 'turn_start').length >= 24) abort(); }, 50);
let failure: string | undefined;
try {
  await client.prompt('做一次极小的联合验收，所有文件只在当前临时目录：建立 Goal“两个文件联合验收”，maxTurns=4；建立 4 个 Todo：#1确认范围，#2生成左文件（依赖1），#3生成右文件（依赖1），#4核验整合（依赖2和3）。确认范围后完成#1。启用 Goal。用两个子Agent分别关联todoId=2和3，只做一次write：left.txt内容LEFT\\n，right.txt内容RIGHT\\n；每次spawn明确tools=["read","write"]、timeout=40，不再派生。等待返回，主会话read两个文件确认真实内容，再完成#2、#3，开始并完成#4，最后完成Goal并汇总。不要bash，不重试，不创建额外任务；若失败则暂停并说明。', 110000);
  await client.until(() => client.records.some((record) => record.type === 'entry_appended' && (record.entry as any)?.customType === GOAL_TYPE && (record.entry as any)?.data?.goals?.some((goal: any) => goal.status === 'completed')), 20000);
  const entries = await client.entries() as any[];
  const todos = entries.findLast((entry) => entry.customType === STATE_TYPE).data;
  const goals = entries.findLast((entry) => entry.customType === GOAL_TYPE).data;
  const jobs = entries.findLast((entry) => entry.customType === AGENTS_TYPE).data.jobs;
  assert.equal(stopped, false);
  assert.equal(todos.tasks.length, 4); assert.ok(todos.tasks.every((task: any) => task.status === 'completed'));
  assert.deepEqual(todos.tasks[3].blockedBy, [2, 3]);
  assert.equal(goals.focusId, undefined); assert.ok(goals.run.used <= 4);
  assert.equal(jobs.length, 2); assert.ok(jobs.every((job: any) => job.status === 'completed'));
  assert.equal(await readFile(`${client.root}/left.txt`, 'utf8'), 'LEFT\n');
  assert.equal(await readFile(`${client.root}/right.txt`, 'utf8'), 'RIGHT\n');
  assert.ok(client.records.some((record) => record.type === 'tool_execution_end' && record.toolName === 'read'));
} catch (cause) { failure = String(cause); }
finally {
  clearTimeout(deadline); clearInterval(watchdog);
  // Stop children explicitly on failure; don't leave paid subprocesses running after a watchdog abort.
  if (failure) {
    const entries = await client.entries().catch(() => []) as any[];
    const jobs = entries.findLast((entry) => entry.customType === AGENTS_TYPE)?.data?.jobs ?? [];
    for (const job of jobs) if (['starting', 'running', 'waiting'].includes(job.status)) await client.send('prompt', { message: `/agents cancel ${job.id}` }).catch(() => {});
  }
  const assistants = client.records.filter((record) => record.type === 'message_end' && (record.message as any)?.role === 'assistant').map((record) => record.message as any);
  const savedJobs = (await client.entries().catch(() => []) as any[]).findLast((entry) => entry.customType === AGENTS_TYPE)?.data?.jobs ?? [];
  const estimatedChildCost = savedJobs.reduce((sum: number, job: any) => sum + (job.usage?.estimatedCost ?? 0), 0);
  const childRequests = savedJobs.reduce((sum: number, job: any) => sum + (job.usage?.requests ?? 0), 0);
  const estimatedParentCost = assistants.reduce((sum, item) => sum + (item.usage?.cost?.total ?? 0), 0);
  const summary = { model: 'example-model', passed: !failure, failure, stopped, parentRequests: client.records.filter((record) => record.type === 'turn_start').length, tools: client.records.filter((record) => record.type === 'tool_execution_end').map((record) => ({ name: record.toolName, isError: record.isError })), childRequests, estimatedParentCost, estimatedChildCost, estimatedTotalCost: estimatedParentCost + estimatedChildCost, costNote: 'Model-configuration estimates for parent and children, not a bill; native Pi parent totals do not include detached child usage.' };
  const dir = fileURLToPath(new URL('../../docs/evidence/m4/', import.meta.url));
  await mkdir(dir, { recursive: true }); await writeFile(`${dir}flash-summary.json`, JSON.stringify(summary, null, 2) + '\n');
  console.log(JSON.stringify(summary, null, 2)); await client.close();
}
if (failure) throw new Error(failure);
