import assert from 'node:assert/strict';
import { test } from 'node:test';
import { IsolatedClient } from './fixtures/isolated-client.ts';
import { AgentSendError } from '../src/agents/runtime.ts';
import { toolDisplay } from '../src/ui/presentation.ts';
import { createTranslator } from '../src/shared/i18n.ts';

test('structured send failures render phase, status and impact instead of a bare error', () => {
  const details = { jobId: 'a1', stage: 'preflight' as const, status: 'waiting' as const, interrupted: false, queueCleared: false, questionsCleared: false, toolsApplied: null, directionDelivery: 'not_sent' as const, currentTools: ['read'], requestedTools: ['read', 'write'], error: 'unavailable tool', recovery: 'Choose an allowed tool' };
  const error = new AgentSendError('tools rejected', details);
  const rendered = toolDisplay({ ...error.details, error: error.message }, 'fallback body', createTranslator('en'));
  assert.match(rendered, /Recovery: Preflight/);
  assert.match(rendered, /tools rejected/, 'concrete rejection must remain visible');
  assert.match(rendered, /Waiting for reply/);
  assert.match(rendered, /Direction not sent/);
  assert.match(rendered, /Existing queue retained/);
  assert.match(rendered, /Choose an allowed tool/);
  assert.doesNotMatch(rendered, /fallback body/);
});

test('plugin-owned recovery guidance is localized without translating arbitrary diagnostic text', () => {
  const messages = [
    'The child stopped; inspect partial files and external effects before an explicitly authorized resumeFrom attempt. Queue/question waits are not restored automatically.',
    'The child is still active without a confirmed new direction. Inspect its current output and pending messages before sending again; do not blindly replay.',
    'This request did not interrupt or change permissions. Correct the tool selection and retry, or answer the original question if the child is still waiting.',
  ];
  for (const recovery of messages) {
    const details = { jobId: 'a1', stage: 'deliver_direction', status: 'running', directionDelivery: 'not_sent', currentTools: ['read'], error: 'Original provider diagnostic', recovery };
    const zh = toolDisplay(details, '', createTranslator('zh-CN')), en = toolDisplay(details, '', createTranslator('en'));
    assert.match(zh, /说明：.*[\u4e00-\u9fff]/); assert.doesNotMatch(zh, /说明：(?:The child|This request)/);
    assert.ok(en.includes(recovery)); assert.ok(zh.includes(details.error));
    assert.doesNotMatch(zh, /工具未调整|未中断当前运行/);
  }
});

/** The marker starts a fresh record window for one command. */
async function run(client: IsolatedClient, command: string) {
  const mark = client.records.length;
  await client.prompt(command);
  const records = client.records.slice(mark);
  return {
    notifications: records.filter((record) => record.method === 'notify').map((record) => String(record.message)),
    ui: records.filter((record) => ['select', 'input', 'editor', 'confirm'].includes(String(record.method))),
  };
}

test('bare root commands keep the native GUI while argument subcommands only notify readable text', { timeout: 60000 }, async (t) => {
  const client = await IsolatedClient.start(); t.after(() => client.close());

  // Root entries still open the native selector (paging header included), then cancel.
  for (const root of ['/agents', '/retry']) {
    const mark = client.records.length;
    const opening = client.prompt(root);
    await client.until(() => client.records.slice(mark).some((record) => record.method === 'select'));
    const menu = client.records.slice(mark).find((record) => record.method === 'select')!;
    assert.match(String(menu.title), /第 1\/\d+ 页 · 共 \d+ 项/, `${root} root menu still paginates`);
    client.child.stdin.write(`${JSON.stringify({ type: 'extension_ui_response', id: menu.id, cancelled: true })}\n`);
    await opening;
  }

  for (const command of ['/agents list', '/agents profiles', '/agents wait', '/retry models', '/todos list', '/todos list pending', '/todos presets']) {
    const { notifications, ui } = await run(client, command);
    assert.deepEqual(ui, [], `${command} must not open a management menu or read view`);
    assert.ok(notifications.length > 0, `${command} notifies readable text`);
    assert.ok(!notifications.some((text) => text.trim().startsWith('{') || text.trim().startsWith('[')), `${command} never dumps raw JSON`);
  }

  // Precise commands missing a required argument print usage instead of opening anything.
  const wait = await run(client, '/agents wait');
  assert.deepEqual(wait.ui, []);
  assert.ok(wait.notifications.some((text) => text.includes('/agents wait jobId')));
  const after = await run(client, '/retry models after');
  assert.deepEqual(after.ui, []);
  assert.ok(after.notifications.some((text) => text.includes('/retry models after')));

  // A settings view keeps its actual state in readable text, not JSON or a nested menu.
  const models = await run(client, '/retry models');
  assert.match(models.notifications.join('\n'), /自动重试|替代模型/);
});

test('localized notifications cover both languages without UI menus', { timeout: 60000 }, async (t) => {
  const client = await IsolatedClient.start(undefined, 'm1-en', [], [], false, undefined, 'en'); t.after(() => client.close());
  const models = await run(client, '/retry models');
  assert.deepEqual(models.ui, []);
  assert.match(models.notifications.join('\n'), /Automatic retry|Model fallback/);
  const jobs = await run(client, '/agents list');
  assert.deepEqual(jobs.ui, []);
  assert.match(jobs.notifications.join('\n'), /No jobs/);
});
