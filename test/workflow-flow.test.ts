import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { IsolatedClient } from './fixtures/isolated-client.ts';
import { FEATURE_NAMES, type Feature } from '../src/workflow/features.ts';

const root = fileURLToPath(new URL('../', import.meta.url));
const provider = fileURLToPath(new URL('./fixtures/offline-model.ts', import.meta.url));
const controls = fileURLToPath(new URL('./fixtures/session-controls.ts', import.meta.url));
async function call(client: IsolatedClient, tool: string, args: object, expectedError = false) {
  const records = await client.prompt(`TEST CALL ${tool} ${JSON.stringify(args)}`);
  const event = records.find((record) => record.type === 'tool_execution_end' && record.toolName === tool)!;
  assert.ok(event, `${tool} returned`); assert.equal(event.isError === true, expectedError, JSON.stringify(event.result)); return (event.result as any).details;
}
async function verifyCommands(client: IsolatedClient, features: readonly Feature[]) {
  const actual = ((await client.send('get_commands')).data as any).commands.map((item: any) => item.name).filter((name: string) => !name.startsWith('test-')).sort();
  const expected = [...features.flatMap((name) => name === 'todos' ? ['todos', 'dag'] : [name])].sort(); assert.deepEqual(actual, expected);
}

test('F1: all 32 resource selections perform real work, stop, reload and remain independently usable', { timeout: 120000 }, async () => {
  for (let mask = 0; mask < 32; mask++) {
    const features = FEATURE_NAMES.filter((_name, index) => Boolean(mask & (1 << index)));
    const client = await IsolatedClient.start(undefined, `flow-${mask}`, [controls], features.includes('agents') ? ['--dag-workflow-test-child-provider', provider] : [], false, features.map((name) => `${root}src/${name}/index.ts`));
    try {
      await verifyCommands(client, features);
      if (features.includes('todos')) {
        await call(client, 'todo', { action: 'batch', operations: [{ action: 'create', ref: 'first', subject: 'Investigate' }, { action: 'create', subject: 'Verify', blockedBy: ['@first'] }] });
        await client.prompt('/todos start #2'); const blocked = await call(client, 'todo', { action: 'get', id: 2 }); assert.equal(blocked.tasks[0].status, 'pending');
      }
      if (features.includes('plan')) {
        await client.prompt('/plan start'); await call(client, 'write', { path: 'forbidden.txt', content: 'no' }, true);
        if (features.includes('todos')) await call(client, 'todo', { action: 'update', id: 1, status: 'completed' }, true);
        await client.prompt('/plan off'); await call(client, 'write', { path: 'permitted.txt', content: 'verified' });
      }
      if (features.includes('agents')) {
        const job = await call(client, 'subagent_spawn', { task: 'Read existing workspace and report the check; no edits.' });
        const report = await call(client, 'subagent_inspect', { jobId: job.jobId, output: true, until: 'finish', timeout: 10 }); assert.equal(report.status, 'completed');
        if (!features.includes('todos')) await call(client, 'subagent_spawn', { task: 'Cannot bind an unavailable Todo', todoId: 1 }, true);
      }
      if (features.includes('goal')) {
        await call(client, 'goal', { action: 'create', title: '预算测试', maxTurns: 1 }); await client.prompt('/goal enable #1');
        await client.until(() => client.records.some((record) => record.method === 'notify' && String(record.message).includes('轮上限')));
        await client.prompt('/goal disable #1'); const goal = await call(client, 'goal', { action: 'get', id: 1 }); assert.equal(goal.goalState.run.paused, true);
      }
      if (features.includes('retry')) {
        await client.prompt('/retry when-error 1s count 1'); await client.prompt('/retry off'); await client.prompt('/retry status');
      }
      if (features.includes('todos')) { await call(client, 'todo', { action: 'update', id: 1, status: 'completed' }); await call(client, 'todo', { action: 'update', id: 2, status: 'completed' }); await client.prompt('/todos hide'); }
      await client.prompt('/test-reload'); await verifyCommands(client, features);
      if (features.includes('goal')) { const goal = await call(client, 'goal', { action: 'get', id: 1 }); assert.equal(goal.goalState.run.paused, true); }
      if (features.includes('todos')) { const state = await call(client, 'todo', { action: 'status' }); assert.equal(state.status.counts.completed, 2); if (features.includes('retry')) assert.equal(state.status.retry.enabled, false); else assert.equal(state.status.retry, undefined); }
      assert.equal(client.records.some((record) => record.type === 'extension_error'), false, `selection ${features.join(',')}`);
    } finally { await client.close(); }
  }
});

test('F7: hiding Todos does not hide Goal and legacy UI-only never starts another feature', { timeout: 30000 }, async (t) => {
  const client = await IsolatedClient.start(undefined, 'display-owner', [], [], false, ['todos', 'goal'].map((name) => `${root}src/${name}/index.ts`)); t.after(() => client.close());
  await call(client, 'todo', { action: 'create', subject: 'Visible Todo' }); await call(client, 'goal', { action: 'create', title: '预算测试', maxTurns: 1 }); await client.prompt('/goal enable #1');
  await client.until(() => client.records.some((record) => record.method === 'notify' && String(record.message).includes('轮上限'))); await client.prompt('/todos hide');
  const last = client.records.filter((record) => record.method === 'setWidget').at(-1)!; assert.ok(JSON.stringify(last.widgetLines).includes('预算测试')); assert.ok(!JSON.stringify(last.widgetLines).includes('Visible Todo'));
  const inert = await IsolatedClient.start(undefined, 'legacy-ui', [], [], false, [`${root}src/ui/index.ts`]); try { assert.deepEqual(((await inert.send('get_commands')).data as any).commands, []); await inert.prompt('ordinary'); assert.ok(!inert.records.some((record) => record.method === 'setWidget')); } finally { await inert.close(); }
});
