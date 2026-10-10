import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { IsolatedClient } from './fixtures/isolated-client.ts';
import { STATE_TYPE } from '../src/todos/state.ts';
import { planViolation } from '../src/plan/policy.ts';
import { emptyState } from '../src/todos/state.ts';
import { displayText } from '../src/ui/render.ts';

const offline = fileURLToPath(new URL('./fixtures/offline-model.ts', import.meta.url));
async function start() {
  const root = await mkdtemp(join(tmpdir(), 'dag-release-audit-'));
  const folder = join(root, 'agent', 'pi-dag-workflow');
  await mkdir(folder, { recursive: true });
  await writeFile(join(folder, 'pi-dag-workflow-preset.json'), JSON.stringify({ presets: [
    { name: 'flow', steps: [{ key: 'first', subject: 'First' }, { key: 'last', subject: 'Last', after: ['first'] }] },
    { name: 'vars', steps: [{ key: 'one', subject: '{__proto__}' }] },
  ] }));
  return IsolatedClient.start(root, 'release-audit', [], ['--dag-workflow-test-child-provider', offline], false, undefined, 'en');
}
async function call(client: IsolatedClient, tool: string, params: object) {
  const events = await client.prompt(`TEST CALL ${tool} ${JSON.stringify(params)}`);
  const event = events.find((item) => item.type === 'tool_execution_end' && item.toolName === tool)!;
  assert.ok(event, `${tool} must have executed`);
  return { ...event.result as any, isError: event.isError === true || (event.result as any)?.isError === true };
}
const state = async (client: IsolatedClient) => (await client.entries() as any[]).findLast((entry) => entry.customType === STATE_TYPE)?.data;

test('Plan distinguishes status filters from mutations and permits fragment editing', () => {
  const state = { ...emptyState(), plan: true };
  for (const status of ['completed', 'in_progress']) {
    assert.equal(planViolation(state, 'todo', { action: 'list', status }), undefined);
    assert.ok(planViolation(state, 'todo', { action: 'update', id: 1, status }));
  }
  for (const action of ['apply', 'reset']) assert.equal(planViolation(state, 'todo', { action, preset: 'flow' }), undefined);
});

test('actual Pi: whole-run and step resets guard every active child in the downstream closure', { timeout: 60000 }, async (t) => {
  const client = await start(); t.after(() => client.close());
  await call(client, 'todo', { action: 'apply', preset: 'flow' });
  for (const id of [1, 2]) await call(client, 'todo', { action: 'update', id, status: 'completed' });
  await call(client, 'todo', { action: 'create', subject: 'External successor', blockedBy: [2] });
  const job = await call(client, 'subagent_spawn', { todoId: 3, task: 'TEST CALL subagent_send {"message":"Keep waiting","question":true}' });
  assert.equal(job.isError, false);
  assert.equal((await call(client, 'subagent_inspect', { jobId: job.details.jobId, output: true, timeout: 10 })).details.status, 'waiting');
  for (const step of [undefined, 'first']) {
    const result = await call(client, 'todo', { action: 'reset', preset: 'flow', ...(step ? { step } : {}) });
    assert.equal(result.isError, true);
    assert.match(JSON.stringify(result.content), /active|running|report/i);
    assert.deepEqual((await state(client)).tasks.map((task: any) => task.status), ['completed', 'completed', 'in_progress']);
  }
  await call(client, 'subagent_cancel', { jobId: job.details.jobId });
  assert.equal((await call(client, 'todo', { action: 'reset', preset: 'flow' })).isError, false);
  assert.deepEqual((await state(client)).tasks.map((task: any) => task.status), ['pending', 'pending', 'pending']);
  // The same guard protects a child bound directly to the selected fragment.
  await call(client, 'todo', { action: 'update', id: 1, status: 'completed' });
  const bound = await call(client, 'subagent_spawn', { todoId: 2, task: 'TEST CALL subagent_send {"message":"Keep waiting","question":true}' });
  await call(client, 'subagent_inspect', { jobId: bound.details.jobId, output: true, timeout: 10 });
  assert.equal((await call(client, 'todo', { action: 'reset', preset: 'flow', step: 'last' })).isError, true);
  await call(client, 'subagent_cancel', { jobId: bound.details.jobId });
});

test('actual Pi: Plan tool/command paths agree and prototype-shaped CLI variables are ordinary data', { timeout: 30000 }, async (t) => {
  const client = await start(); t.after(() => client.close());
  await client.prompt('/plan start');
  assert.equal((await call(client, 'todo', { action: 'apply', preset: 'flow' })).isError, false);
  assert.equal((await call(client, 'todo', { action: 'list', status: 'completed' })).isError, false);
  assert.equal((await call(client, 'todo', { action: 'update', id: 1, status: 'in_progress' })).isError, true);
  assert.equal((await call(client, 'todo', { action: 'reset', preset: 'flow' })).isError, false);
  const before = JSON.stringify(await state(client));
  await client.prompt('/todos reset flow first extra');
  assert.equal(JSON.stringify(await state(client)), before, 'extra reset arguments cannot silently mutate the list');
  await client.prompt('/todos apply vars __proto__=supplied');
  assert.equal((await state(client)).tasks.at(-1).subject, 'supplied');
  assert.equal((await call(client, 'write', { path: 'blocked.txt', content: 'no' })).isError, true);
});

test('actual Pi: saving a profile preserves external file edits and safely displays instructions', { timeout: 30000 }, async (t) => {
  const client = await start(); t.after(() => client.close());
  await client.prompt('/agents profile original dag-test/scripted off read');
  const path = join(client.root, 'agent', 'pi-dag-workflow', 'pi-dag-workflow-profile.json');
  const config = JSON.parse(await readFile(path, 'utf8'));
  config.profiles.push({ name: 'external', instructions: 'Guidance\u202e' });
  await writeFile(path, JSON.stringify(config));
  await client.prompt('/agents profile added dag-test/scripted off read');
  const saved = JSON.parse(await readFile(path, 'utf8'));
  assert.deepEqual(saved.profiles.map((profile: any) => profile.name), ['original', 'external', 'added']);
  const mark = client.records.length;
  await client.prompt('/agents profiles');
  const note = client.records.slice(mark).find((record) => record.method === 'notify')!;
  assert.doesNotMatch(String(note.message), /\u202e/);
  assert.match(String(note.message), /\n  \{/);
});

test('notifications strip terminal controls while keeping intended lines and stored user content', { timeout: 30000 }, async (t) => {
  const client = await start(); t.after(() => client.close());
  const title = 'Goal\u001b[31mred\u001b[0m\u202e';
  await call(client, 'goal', { action: 'create', title });
  const mark = client.records.length;
  await client.prompt('/goal list');
  const note = client.records.slice(mark).find((record) => record.method === 'notify')!;
  assert.doesNotMatch(String(note.message), /\u001b|\u202e/);
  assert.match(String(note.message), /Goalred/);
  const goal = await call(client, 'goal', { action: 'get', id: 1 });
  assert.equal(JSON.parse(goal.content[0].text).goal.title, title, 'display sanitization must not change canonical user data');
  assert.equal(displayText('one\n\u001b[31mtwo\u001b[0m\u202e'), 'one\ntwo');
  assert.equal(displayText('  one\n    two'), '  one\n    two');
});
