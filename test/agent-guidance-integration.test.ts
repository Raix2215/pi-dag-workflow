import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { IsolatedClient } from './fixtures/isolated-client.ts';

const offline = fileURLToPath(new URL('./fixtures/offline-model.ts', import.meta.url));
const capture = fileURLToPath(new URL('./fixtures/child-guidance-log.ts', import.meta.url));
async function start(session: string) {
  const root = await mkdtemp(join(tmpdir(), 'dag-guidance-'));
  const log = join(root, 'child-context.jsonl');
  const client = await IsolatedClient.start(root, session, [capture], ['--dag-workflow-test-child-provider', offline, '--dag-test-child-guidance-log', log]);
  const call = async (name: string, args: object) => {
    const events = await client.prompt(`TEST CALL ${name} ${JSON.stringify(args)}`);
    const event = events.find((item) => item.type === 'tool_execution_end' && item.toolName === name)!;
    assert.ok(event, `${name} executed`);
    return { ...(event.result as any), isError: event.isError === true || (event.result as any).isError === true };
  };
  const logs = async () => (await readFile(log, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
  const finish = async (jobId: string) => { const result = await call('subagent_inspect', { jobId, output: true, until: 'finish', timeout: 10 }); assert.equal(result.isError, false, JSON.stringify(result)); assert.equal(result.details.status, 'completed'); return result.details; };
  return { client, call, logs, finish, root };
}
const text = (message: any) => typeof message.content === 'string' ? message.content : message.content?.filter((item: any) => item.type === 'text').map((item: any) => item.text).join('\n') ?? '';
const inputContains = (entry: any, marker: string) => entry.type === 'input' && entry.context.messages.some((message: any) => text(message).includes(marker));

test('actual Pi: context:true gives an ordinary Todo its current direct report without parent history', { timeout: 40000 }, async (t) => {
  const h = await start('ordinary-context'); t.after(() => h.client.close());
  await h.client.prompt('PARENT-HISTORY-MUST-NOT-LEAK');
  await writeFile(join(h.root, 'artifact.json'), '{"evidence":"VERIFIED-DIRECT-RESULT"}');
  await h.call('todo', { action: 'create', subject: 'Producer', metadata: { artifacts: ['artifact.json'] } });
  const producer = await h.call('subagent_spawn', { task: 'TEST CALL read {"path":"artifact.json"}', todoId: 1, tools: ['read'] });
  assert.equal(producer.isError, false); await h.finish(producer.details.jobId);
  await h.call('todo', { action: 'update', id: 1, status: 'completed' });
  await h.call('todo', { action: 'create', subject: 'Consumer', description: 'CURRENT-CONSUMER-REQUIREMENT', blockedBy: [1] });
  const consumer = await h.call('subagent_spawn', { task: 'Ordinary brief probe', todoId: 2, tools: ['read'], context: true });
  assert.equal(consumer.isError, false); await h.finish(consumer.details.jobId);
  const first = (await h.logs()).find((entry) => inputContains(entry, 'Task #2'));
  assert.ok(first, 'the ordinary task brief actually reaches a separate Pi child');
  const combined = first.context.messages.map(text).join('\n');
  assert.match(combined, /CURRENT-CONSUMER-REQUIREMENT/); assert.match(combined, /#1 \[completed\].*VERIFIED-DIRECT-RESULT/);
  assert.match(combined, /artifact\.json/); assert.doesNotMatch(combined, /PARENT-HISTORY-MUST-NOT-LEAK/);
  assert.doesNotMatch(JSON.stringify(first.context.messages.filter((item: any) => item.role === 'system')), /CURRENT-CONSUMER-REQUIREMENT|VERIFIED-DIRECT-RESULT/);
  await h.call('todo', { action: 'create', subject: 'No context', description: 'UNSELECTED-CONTEXT', blockedBy: [1] });
  const plain = await h.call('subagent_spawn', { task: 'No context probe', todoId: 3, tools: ['read'] }); await h.finish(plain.details.jobId);
  const plainInput = (await h.logs()).find((entry) => inputContains(entry, 'No context probe'));
  assert.doesNotMatch(plainInput.context.messages.map(text).join('\n'), /UNSELECTED-CONTEXT|Task #3|VERIFIED-DIRECT-RESULT/);
});

test('actual Pi: changing artifact references makes old evidence stale but preserves the current declared path', { timeout: 30000 }, async (t) => {
  const h = await start('context-artifact-freshness'); t.after(() => h.client.close());
  await writeFile(join(h.root, 'old.json'), 'OLD-REPORT-MARKER');
  await h.call('todo', { action: 'create', subject: 'Producer', metadata: { artifacts: ['old.json'] } });
  const producer = await h.call('subagent_spawn', { task: 'TEST CALL read {"path":"old.json"}', todoId: 1, tools: ['read'] }); await h.finish(producer.details.jobId);
  await h.call('todo', { action: 'update', id: 1, status: 'completed' });
  await h.call('todo', { action: 'update', id: 1, metadata: { artifacts: ['current.json'] } });
  const inspected = await h.call('subagent_inspect', { jobId: producer.details.jobId });
  assert.equal(inspected.details.jobs[0].taskReportStale, true);
  await h.call('todo', { action: 'create', subject: 'Consumer', blockedBy: [1] });
  const consumer = await h.call('subagent_spawn', { task: 'Freshness probe', todoId: 2, tools: ['read'], context: true }); await h.finish(consumer.details.jobId);
  const first = (await h.logs()).find((entry) => inputContains(entry, 'Task #2'));
  const combined = first.context.messages.map(text).join('\n');
  assert.match(combined, /current\.json/); assert.doesNotMatch(combined, /OLD-REPORT-MARKER|old\.json/);
});

test('actual Pi: Profile.skills delivers only selected file entries and reads bodies through the existing tool', { timeout: 40000 }, async (t) => {
  const h = await start('profile-skill-guidance'); t.after(() => h.client.close());
  const profileDir = join(h.root, 'agent', 'pi-dag-workflow'); await mkdir(profileDir, { recursive: true });
  await mkdir(join(h.root, 'skills', 'selected'), { recursive: true }); await mkdir(join(h.root, 'skills', 'unselected'));
  const selected = join(h.root, 'skills', 'selected', 'SKILL.md');
  await writeFile(selected, '---\nname: selected\ndescription: Local selected skill\nallowed-tools: bash write\n---\nSELECTED-BODY-ONLY-AFTER-READ\n');
  await writeFile(join(h.root, 'skills', 'unselected', 'SKILL.md'), '# UNSELECTED-BODY\n');
  await writeFile(join(profileDir, 'pi-dag-workflow-profile.json'), JSON.stringify({ profiles: [{ name: 'reader', tools: ['read'], skills: ['skills/selected/SKILL.md'], instructions: 'Work only on the assigned input.' }, { name: 'plain', tools: ['read'] }, { name: 'missing', tools: ['read'], skills: ['missing.md'] }] }));
  const directory = await h.call('subagent_inspect', { profiles: 'summary' });
  assert.deepEqual(directory.details.profiles[0].skills, ['skills/selected/SKILL.md']);
  assert.doesNotMatch(JSON.stringify(directory.content), /SELECTED-BODY|instructions/);
  await h.client.prompt('/agents profile reader dag-test/scripted off read');
  const saved = JSON.parse(await readFile(join(profileDir, 'pi-dag-workflow-profile.json'), 'utf8'));
  assert.deepEqual(saved.profiles.find((item: any) => item.name === 'reader').skills, ['skills/selected/SKILL.md']);
  const child = await h.call('subagent_spawn', { task: 'TEST SELECTED SKILL', profile: 'reader' }); assert.equal(child.isError, false);
  const result = await h.finish(child.details.jobId);
  assert.deepEqual(result.tools, ['read']); assert.match(result.output, /SELECTED-BODY-ONLY-AFTER-READ/);
  const requests = (await h.logs()).filter((entry) => inputContains(entry, 'TEST SELECTED SKILL'));
  assert.ok(requests.length >= 2); const first = requests[0];
  const initial = first.context.messages.map(text).join('\n');
  assert.match(initial, /Selected local skill file entries/); assert.ok(initial.includes(selected));
  assert.doesNotMatch(initial, /SELECTED-BODY-ONLY-AFTER-READ|UNSELECTED-BODY/);
  assert.doesNotMatch(JSON.stringify(first.context.messages.filter((message: any) => message.role === 'system')), /skills\/selected\/SKILL\.md|Selected local skill file entries/);
  assert.ok(requests.slice(1).some((entry) => entry.context.messages.map(text).join('\n').includes('SELECTED-BODY-ONLY-AFTER-READ')));
  const plain = await h.call('subagent_spawn', { task: 'Unselected profile probe', profile: 'plain' }); await h.finish(plain.details.jobId);
  const plainInput = (await h.logs()).find((entry) => inputContains(entry, 'Unselected profile probe'));
  assert.doesNotMatch(plainInput.context.messages.map(text).join('\n'), /Selected local skill file entries|skills\/selected|SELECTED-BODY/);
  await h.call('todo', { action: 'create', subject: 'Pending skill validation' });
  const rejected = await h.call('subagent_spawn', { task: 'Invalid skill probe', profile: 'missing', todoId: 1 }); assert.equal(rejected.isError, true);
  assert.equal(rejected.details.todoStatus, 'pending');
  assert.equal((await h.call('todo', { action: 'get', id: 1 })).details.tasks[0].status, 'pending');
  const widened = await h.call('subagent_spawn', { task: 'No read tool probe', profile: 'reader', tools: [], todoId: 1 }); assert.equal(widened.isError, true);
  assert.equal(widened.details.todoStatus, 'pending');
  const captured = JSON.stringify(await h.logs());
  assert.doesNotMatch(captured, /Invalid skill probe|No read tool probe/);
});
