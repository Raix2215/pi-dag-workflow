import { emptyState, type WorkflowState, STATE_TYPE } from './fixtures/public-records.ts';
import { todosHost } from './fixtures/d5-todos-host.ts';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stripTerminalSequences } from '@earendil-works/pi-tui';
import { IsolatedClient } from './fixtures/isolated-client.ts';

// presets.test.ts
{
const release = {
  name: 'release', description: 'Ship a version', skill: 'release-checklist',
  steps: [
    { key: 'verify', subject: '跑全量测试', owner: 'fast' },
    { key: 'changelog', subject: '更新 CHANGELOG' },
    { key: 'tag', subject: '打标签 v{version}', after: ['verify', 'changelog'] },
    { key: 'announce', subject: '发布公告', after: ['tag'] },
  ],
};
// Isolate Pi's documented config directory rather than constructing its private preset store.
async function configured(presets?: unknown[], state?: WorkflowState) {
  const root = await mkdtemp(join(tmpdir(), 'pi-dag-presets-'));
  const previous = process.env.PI_CODING_AGENT_DIR;
  try {
    process.env.PI_CODING_AGENT_DIR = root;
    await mkdir(join(root, 'pi-dag-workflow'));
    if (presets) await writeFile(join(root, 'pi-dag-workflow', 'pi-dag-workflow-preset.json'), JSON.stringify({ presets }));
    const host = await todosHost(state);
    return { host, close: () => rm(root, { recursive: true, force: true }) };
  } catch (error) { await rm(root, { recursive: true, force: true }); throw error; }
  finally { if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous; }
}
const tasks = (host: Awaited<ReturnType<typeof configured>>['host']) => host.state().tasks;
const content = (result: any) => result.content[0].text as string;
const names = (list: readonly { id: number }[]) => list.map(task => task.id);

 test('fragment definitions reject unknown fields, bad keys and broken dependency graphs', async () => {
  const steps = [{ key: 'a', subject: 'A' }];
  const cases: [unknown[], RegExp][] = [
    [[{ name: 'x', steps, extra: 1 }], /Unknown preset field/],
    [[{ name: '-bad', steps }], /Invalid preset name/],
    [[{ name: 'x', steps: [] }], /needs 1-32 steps/],
    [[{ name: 'x', steps: [{ key: 'A', subject: 'A' }] }], /Invalid preset step key/],
    [[{ name: 'x', steps: [{ key: 'a', subject: 'A' }, { key: 'a', subject: 'B' }] }], /Duplicate preset step key/],
    [[{ name: 'x', steps: [{ key: 'a', subject: 'A', after: ['nope'] }] }], /unknown key/],
    [[{ name: 'x', steps: [{ key: 'a', subject: 'A', after: ['a'] }] }], /depends on itself/],
    [[{ name: 'x', steps: [{ key: 'a', subject: 'A', after: ['b'] }, { key: 'b', subject: 'B', after: ['a'] }] }], /dependency cycle/],
    [[{ name: 'x', skill: 'bad name', steps }], /Invalid preset skill/],
    [[{ name: 'dup', steps }, { name: 'dup', steps: [{ key: 'b', subject: 'B' }] }], /Duplicate preset name/],
  ];
  for (const [definitions, expected] of cases) {
    const { host, close } = await configured(definitions);
    try { assert.match(host.notifications.join('\n'), expected); }
    finally { await close(); }
  }
  const { host, close } = await configured();
  try { assert.deepEqual((await host.call({ action: 'presets' })).details.presets, []); }
  finally { await close(); }
});

test('a loaded fragment keeps its steps, skill and description', async () => {
  const { host, close } = await configured([release]);
  try {
    const listed = await host.call({ action: 'presets' });
    assert.equal(listed.details.presets[0].description, 'Ship a version');
    assert.equal(listed.details.presets[0].name, 'release');
    const applied = await host.call({ action: 'apply', preset: 'release', vars: { version: '0.2' } });
    assert.match(content(applied), /release-checklist/);
    assert.deepEqual(tasks(host).map(task => task.metadata?.key), ['verify', 'changelog', 'tag', 'announce']);
    assert.deepEqual(tasks(host)[2]!.blockedBy, [1, 2]);
    assert.equal(listed.details.presets.find((item: any) => item.name === 'missing'), undefined);
  } finally { await close(); }
});

test('placeholders must be filled from caller variables', async () => {
  const { host, close } = await configured([release, { name: 'plain', steps: [{ key: 'a', subject: '无需变量' }] }]);
  try {
    assert.match(content(await host.call({ action: 'apply', preset: 'release', vars: { version: '0.2' } })), /已创建片段 release/);
    assert.equal(tasks(host)[2]!.subject, '打标签 v0.2');
    assert.match(content(await host.call({ action: 'apply', preset: 'release' })), /needs a value for \{version\}/);
    await host.call({ action: 'apply', preset: 'plain' });
    assert.equal(tasks(host).at(-1)!.subject, '无需变量');
  } finally { await close(); }
});

test('placeholder values must be own string properties, including prototype-shaped names', async () => {
  const { host, close } = await configured([
    { name: 'ctor', steps: [{ key: 'a', subject: '{constructor}' }] },
    { name: 'string', steps: [{ key: 'a', subject: '{toString}' }] },
    { name: 'inherited', steps: [{ key: 'a', subject: '{version}' }] },
  ]);
  try {
    assert.match(content(await host.call({ action: 'apply', preset: 'ctor', vars: {} })), /needs a value/);
    assert.match(content(await host.call({ action: 'apply', preset: 'string', vars: {} })), /needs a value/);
    assert.match(content(await host.call({ action: 'apply', preset: 'inherited', vars: Object.create({ version: 'inherited' }) })), /needs a value/);
    await host.call({ action: 'apply', preset: 'ctor', vars: { constructor: 'supplied' } });
    assert.equal(tasks(host)[0]!.subject, 'supplied');
  } finally { await close(); }
});

test('a valid fragment can refer to steps defined later without changing display ordinals', async () => {
  const { host, close } = await configured([{ name: 'forward', steps: [{ key: 'last', subject: 'Last', after: ['first'] }, { key: 'first', subject: 'First' }] }], { ...emptyState(), nextId: 10 });
  try {
    await host.call({ action: 'apply', preset: 'forward' });
    assert.deepEqual(tasks(host).map(task => task.blockedBy), [[11], []]);
    assert.deepEqual(tasks(host).map(task => task.metadata!.step), [1, 2]);
  } finally { await close(); }
});

test('run selection ignores user metadata that is not a positive safe integer', async () => {
  const malformed = [NaN, Infinity, -1, 0, 1.5].map((run, index) => ({ id: index + 10, subject: 'Other', status: 'pending' as const, blockedBy: [], metadata: { preset: 'release', run } }));
  const previous: WorkflowState = { ...emptyState(), tasks: [1, 2, 3, 4].map((id) => ({ id, subject: 'Old', status: 'pending' as const, blockedBy: [], metadata: { preset: 'release', run: 1 } })).concat(malformed), nextId: 20 };
  const { host, close } = await configured([release], previous);
  try {
    const list = await host.call({ action: 'list' });
    assert.deepEqual(list.details.tasks.slice(0, 4).map((task: any) => task.id), [1, 2, 3, 4]);
    const result = await host.call({ action: 'apply', preset: 'release', vars: { version: '0.2' } });
    assert.match(content(result), /第 2 轮/);
    assert.deepEqual(tasks(host).slice(-4).map(task => task.metadata!.run), [2, 2, 2, 2]);
    assert.deepEqual(tasks(host).slice(4, 9).map(task => task.metadata!.run), [NaN, Infinity, -1, 0, 1.5]);
    const reset = await host.call({ action: 'reset', preset: 'release', run: 1 });
    assert.match(content(reset), /#1, #2, #3, #4/);
    assert.deepEqual(tasks(host).slice(4, 9).map(task => task.status), Array(5).fill('pending'));
  } finally { await close(); }
});

test('reset does not resurrect deleted tasks while reopening live descendants', async () => {
  const state: WorkflowState = { ...emptyState(), nextId: 6, tasks: [
    { id: 1, subject: 'A', status: 'completed', blockedBy: [], metadata: { preset: 'release', run: 1, key: 'verify' } },
    { id: 2, subject: 'B', status: 'completed', blockedBy: [], metadata: { preset: 'release', run: 1, key: 'changelog' } },
    { id: 3, subject: 'C', status: 'completed', blockedBy: [1, 2], metadata: { preset: 'release', run: 1, key: 'tag' } },
    { id: 4, subject: 'D', status: 'deleted', blockedBy: [3], metadata: { preset: 'release', run: 1, key: 'announce' } },
    { id: 5, subject: 'Deleted unrelated history', status: 'deleted', blockedBy: [3] },
  ] };
  const { host, close } = await configured([release], state);
  try {
    const result = await host.call({ action: 'reset', preset: 'release', run: 1 });
    assert.match(content(result), /#1, #2, #3/);
    assert.deepEqual(tasks(host).map(task => task.status), ['pending', 'pending', 'pending', 'deleted', 'deleted']);
  } finally { await close(); }
  const { host: stepHost, close: closeStep } = await configured([release], state);
  try {
    assert.match(content(await stepHost.call({ action: 'reset', preset: 'release', step: 'tag', run: 1 })), /#3/);
    assert.deepEqual(tasks(stepHost).map(task => task.status), ['completed', 'completed', 'pending', 'deleted', 'deleted']);
  } finally { await closeStep(); }
});

test('a live successor of a deleted middle step is rejected before it can enter a reset', async () => {
  const { host, close } = await configured([release]);
  try {
    await host.call({ action: 'apply', preset: 'release', vars: { version: '0.2' } });
    assert.match(content(await host.call({ action: 'delete', id: 3 })), /deleted|删除/);
    const persisted = structuredClone(host.entries.at(-1));
    const invalid = structuredClone(host.state());
    invalid.tasks[2]!.status = 'deleted';
    host.entries.push({ type: 'custom', customType: STATE_TYPE, data: invalid });
    await host.emit('session_tree');
    assert.equal(JSON.parse(content(await host.call({ action: 'status' }))).protected, true);
    assert.match(content(await host.call({ action: 'reset', preset: 'release' })), /状态恢复失败/);
    assert.deepEqual(host.entries.at(-2), persisted, 'the last valid persisted record is untouched');
    assert.equal(host.entries.at(-1)!.data.tasks[2].status, 'deleted', 'invalid imported record is not rewritten');
  } finally { await close(); }
});

test('expanding a fragment creates pending tasks with mapped dependencies and run metadata', async () => {
  const { host, close } = await configured([release]);
  try {
    await host.call({ action: 'apply', preset: 'release', vars: { version: '0.2' } });
    const first = tasks(host);
    assert.deepEqual(names(first), [1, 2, 3, 4]);
    assert.equal(first[0]!.owner, 'fast');
    assert.equal(first[2]!.subject, '打标签 v0.2');
    assert.deepEqual(first[2]!.blockedBy, [1, 2]);
    assert.deepEqual(first[3]!.blockedBy, [3]);
    assert.deepEqual(first.map(task => task.metadata), [
      { preset: 'release', run: 1, key: 'verify', step: 1 }, { preset: 'release', run: 1, key: 'changelog', step: 2 },
      { preset: 'release', run: 1, key: 'tag', step: 3 }, { preset: 'release', run: 1, key: 'announce', step: 4 },
    ]);
    assert.deepEqual(first.map(task => [task.metadata!.key, task.id]), [['verify', 1], ['changelog', 2], ['tag', 3], ['announce', 4]]);
    await host.call({ action: 'apply', preset: 'release', vars: { version: '0.3' } });
    assert.equal(tasks(host)[4]!.metadata!.run, 2);
    assert.equal(tasks(host)[4]!.metadata!.step, 1);
    assert.equal(tasks(host)[4]!.id, 5);
    assert.equal(host.state().nextId, 9);
  } finally { await close(); }
});

test('resetting reopens the requested fragment, and a single step reopens its dependents', async () => {
  const state: WorkflowState = { ...emptyState(), tasks: [
    { id: 1, subject: 'verify', status: 'completed', blockedBy: [], metadata: { preset: 'release', run: 1, key: 'verify' } },
    { id: 2, subject: 'changelog', status: 'completed', blockedBy: [], metadata: { preset: 'release', run: 1, key: 'changelog' } },
    { id: 3, subject: 'tag', status: 'completed', blockedBy: [1, 2], metadata: { preset: 'release', run: 1, key: 'tag' } },
    { id: 4, subject: 'announce', status: 'completed', blockedBy: [3], metadata: { preset: 'release', run: 1, key: 'announce' } },
    { id: 5, subject: '外部依赖发布', status: 'completed', blockedBy: [4] },
    { id: 6, subject: '无关任务', status: 'completed', blockedBy: [] },
    { id: 7, subject: '第二轮 verify', status: 'pending', blockedBy: [], metadata: { preset: 'release', run: 2, key: 'verify' } },
  ], nextId: 8 };
  const { host, close } = await configured([release], state);
  try {
    assert.match(content(await host.call({ action: 'reset', preset: 'release', step: 'tag', run: 1 })), /#3, #4, #5/);
    assert.deepEqual(tasks(host).filter(task => task.status === 'pending').map(task => task.id), [3, 4, 5, 7]);
    assert.match(content(await host.call({ action: 'reset', preset: 'release', step: 'nope', run: 1 })), /没有|未知/);
    assert.match(content(await host.call({ action: 'reset', preset: 'release', step: 'tag' })), /没有|未知/);
    assert.match(content(await host.call({ action: 'reset', preset: 'release', run: 9 })), /没有|未知/);
    assert.match(content(await host.call({ action: 'reset', preset: 'other' })), /没有|未知/);
    assert.match(content(await host.call({ action: 'reset', preset: 'release', run: 1 })), /#1, #2, #3, #4, #5/);
    assert.deepEqual(tasks(host).map(task => task.status), ['pending', 'pending', 'pending', 'pending', 'pending', 'completed', 'pending']);
    assert.match(content(await host.call({ action: 'reset', preset: 'release' })), /#7/);
    assert.equal(tasks(host)[6]!.status, 'pending');
    assert.equal(tasks(host).length, 7);
  } finally { await close(); }
});

test('apply and reset work through the task tool, keeping ids unique and blocks intact', async () => {
  const { host, close } = await configured([release], { ...emptyState(), nextId: 40 });
  try {
    const applied = await host.call({ action: 'apply', preset: 'release', vars: { version: '1.0' } });
    assert.match(content(applied), /已创建片段 release 第 1 轮（4 项）：verify=#40, changelog=#41, tag=#42, announce=#43；执行前建议加载 skill：release-checklist/);
    assert.equal(host.state().nextId, 44);
    assert.equal(tasks(host).length, 4);
    for (const id of [40, 41, 42, 43]) {
      await host.call({ action: 'update', id, status: 'in_progress' });
      await host.call({ action: 'update', id, status: 'completed' });
    }
    assert.ok(tasks(host).every(task => task.status === 'completed'));
    const reset = await host.call({ action: 'reset', preset: 'release' });
    assert.match(content(reset), /已重置片段 release 的 4 项为待执行/);
    assert.ok(tasks(host).every(task => task.status === 'pending'));
    for (const id of [40, 41]) {
      await host.call({ action: 'update', id, status: 'in_progress' });
      await host.call({ action: 'update', id, status: 'completed' });
    }
    const stepReset = await host.call({ action: 'reset', preset: 'release', step: 'changelog' });
    assert.match(content(stepReset), /#41, #42, #43/);
    assert.equal(tasks(host).find(task => task.id === 40)!.status, 'completed');
    assert.match(content(await host.call({ action: 'apply', preset: 'missing' })), /未找到片段 missing/);
    assert.match(content(await host.call({ action: 'reset', preset: 'release', run: 9 })), /没有可重置的片段/);
    assert.match(content(await host.call({ action: 'apply', preset: 'release', id: 3 })), /不接受字段 id/);
    assert.equal((await host.call({ action: 'apply', preset: 'release', vars: { version: '2.0' } })).isError, undefined);
  } finally { await close(); }
});

test('completing a prerequisite reports the tasks it just unlocked', async () => {
  const base: WorkflowState = { ...emptyState(), tasks: [
    { id: 1, subject: '前置', status: 'in_progress', blockedBy: [] },
    { id: 2, subject: '依赖前置', status: 'pending', blockedBy: [1] },
    { id: 3, subject: '双重依赖', status: 'pending', blockedBy: [1, 4] },
    { id: 4, subject: '另一前置', status: 'pending', blockedBy: [] },
    { id: 5, subject: '无关任务', status: 'pending', blockedBy: [] },
  ], nextId: 6 };
  const { host, close } = await configured([], base);
  try {
    assert.match(content(await host.call({ action: 'update', id: 1, status: 'completed' })), /#2 依赖前置/);
    assert.match(content(await host.call({ action: 'update', id: 4, status: 'completed' })), /#3 双重依赖/);
    assert.deepEqual((await host.call({ action: 'list', ready: true })).details.tasks.map((task: any) => task.id), [2, 3, 5]);
    assert.doesNotMatch(content(await host.call({ action: 'update', id: 5, subject: '改名' })), /前置已完成，可开始/);
    assert.equal(tasks(host).find(task => task.id === 3)!.status, 'pending');
    assert.equal(tasks(host).find(task => task.id === 2)!.status, 'pending');
  } finally { await close(); }
});
}

// preset-integration.test.ts
{
/** A real Pi session with explicit fragment discovery, apply, panel tags and reset. */
test('actual Pi: fragments are discovered on demand, apply from one call and reset on request', { timeout: 30000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'pi-dag-preset-'));
  await mkdir(join(root, 'agent', 'pi-dag-workflow'), { recursive: true });
  await writeFile(join(root, 'agent', 'pi-dag-workflow', 'pi-dag-workflow-preset.json'), JSON.stringify({ presets: [{
    name: 'release', description: 'Ship a version', skill: 'release-checklist', steps: [
      { key: 'verify', subject: '跑全量测试', owner: 'fast' }, { key: 'tag', subject: '打标签 v{version}', after: ['verify'] },
    ],
  }] }), 'utf8');
  const client = await IsolatedClient.start(root);
  t.after(() => client.close());
  const call = async (name: string, args: unknown) => {
    const events = await client.prompt(`TEST CALL ${name} ${JSON.stringify(args)}`);
    const event = events.find(item => item.type === 'tool_execution_end' && item.toolName === name);
    assert.ok(event, `expected ${name}`);
    return event.result as { isError?: boolean; content: { text: string }[]; details: { presets: { name: string; description?: string }[] } };
  };
  const state = async () => {
    const entries = await client.entries() as { customType?: string; data?: WorkflowState }[];
    return entries.findLast(entry => entry.customType === STATE_TYPE)!.data!;
  };
  await client.prompt('开始片段验收');
  const applied = await call('todo', { action: 'apply', preset: 'release', vars: { version: '0.9' } });
  assert.ok(!applied.isError, JSON.stringify(applied));
  assert.match(applied.content[0]!.text, /已创建片段 release 第 1 轮（2 项）：verify=#1, tag=#2；执行前建议加载 skill：release-checklist/);
  const created = (await state()).tasks;
  assert.deepEqual(created.map(task => `${task.id}:${task.subject}:${task.blockedBy.join('/')}:${task.owner ?? '-'}`), ['1:跑全量测试::fast', '2:打标签 v0.9:1:-']);
  assert.deepEqual(created.map(task => task.metadata), [{ preset: 'release', run: 1, key: 'verify', step: 1 }, { preset: 'release', run: 1, key: 'tag', step: 2 }]);
  const widget = client.records.filter(item => item.method === 'setWidget').flatMap(item => (item.widgetLines as string[] | undefined) ?? []).map(stripTerminalSequences).join('\n');
  assert.match(widget, /\[release#1\] \[fast\] \[待执行\]/);
  assert.match(widget, /\[release#2\] \[主会话\] \[待执行\]/);
  const entries = await client.entries() as any[];
  assert.ok(!entries.some(entry => entry.customType === 'pi-dag-workflow.guidance' && /Available Todo presets/.test(entry.content)));
  assert.ok(!entries.some(entry => Object.keys(entry.message?.sections ?? {}).some(key => key.startsWith('dag_workflow'))));
  const directory = await call('todo', { action: 'presets' });
  assert.equal(directory.details.presets[0]!.name, 'release');
  assert.equal(directory.details.presets[0]!.description, 'Ship a version');
  await call('todo', { action: 'update', id: 1, status: 'in_progress' });
  const completed = await call('todo', { action: 'update', id: 1, status: 'completed' });
  assert.match(completed.content[0]!.text, /前置已完成，可开始：#2 打标签/);
  assert.ok(!client.records.some(record => record.method === 'notify' && typeof record.message === 'string' && /前置已完成，可开始：#2 打标签/.test(record.message)), 'the hint is carried only by the tool result');
  const reopened = await call('todo', { action: 'reset', preset: 'release' });
  assert.match(reopened.content[0]!.text, /已重置片段 release 的 2 项为待执行：#1, #2/);
  assert.ok((await state()).tasks.every(task => task.status === 'pending'));
  const missing = await call('todo', { action: 'apply', preset: 'nope' });
  assert.equal(missing.isError, true);
  assert.match(missing.content[0]!.text, /未找到片段 nope/);
  await call('todo', { action: 'apply', preset: 'release', vars: { version: '1.0' } });
  const secondWidget = client.records.filter(item => item.method === 'setWidget').flatMap(item => (item.widgetLines as string[] | undefined) ?? []).map(stripTerminalSequences).join('\n');
  assert.match(secondWidget, /\[release#1·r2\]/);
  assert.ok((await state()).tasks.slice(-2).every(task => task.metadata?.run === 2));
});
}
