import { loadPublic, recordPanels } from './fixtures/public-host.ts';
import { protocolHost } from './fixtures/agents-protocol-host.ts';
import { retainedJobs, AGENTS_TYPE } from './fixtures/public-records.ts';
import assert from "node:assert/strict";
import { createHash } from 'node:crypto';
import { test } from "node:test";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, mkdir, rm, writeFile, readFile, readdir, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { IsolatedClient } from "./fixtures/isolated-client.ts";

const activeJobs = (host: any) => host.jobs().filter((job: any) => ['starting', 'running', 'waiting'].includes(job.status)).length;
const saved = (host: any) => host.jobs();

test('model command forwards use English wrappers and preserve Chinese arguments', async t => {
  const host = await protocolHost({ features: ['todos', 'agents'], language: 'zh-CN', idle: true }); t.after(() => host.close());
  const original = '保留用户输入甲乙，不进行翻译';
  await host.commands.get('todos').handler(original, host.ctx);
  await host.commands.get('agents').handler(original, host.ctx);
  assert.deepEqual(host.userMessages, [`Manage the current Todos: ${original}`, `Manage the current child agents/Profiles: ${original}`]);
  assert.equal(host.jobs().length, 0, 'forwarding does not dispatch a child');
});

test('U7 inline Job dispatch, bounded wait and Todo accordion assignment reuse the guarded runtime', { timeout: 20000 }, async t => {
  const host = await protocolHost({ features: ['todos', 'agents'], language: 'zh-CN' }); t.after(() => host.close());
  host.ctx.hasUI = true; host.ctx.mode = 'tui'; host.ctx.ui.theme = { style: (text: string) => text, fg: (_color: string, text: string) => text };
  const panels = recordPanels(host.ctx);
  let opening = host.commands.get('agents').handler('', host.ctx);
  await panels.select('派发新 Job'); await panels.press('Bounded standalone menu assignment'); await panels.press('\r');
  await panels.wait(() => host.jobs().length === 1);
  const standalone = host.jobs()[0]!; assert.equal(standalone.assignment, 'Bounded standalone menu assignment'); assert.equal(standalone.todoId, undefined);
  await host.call('subagent_inspect', { jobId: standalone.id, output: true, until: 'finish', timeout: 10 });
  await panels.select('等待所有 Job'); assert.ok(panels.frame().some(line => line.includes(standalone.id)));
  await panels.press('\x1b'); await panels.press('\x1b'); await opening;
  await host.call('todo', { action: 'create', subject: 'Bounded linked menu assignment', description: 'Preserve the full stored requirement' });
  opening = host.commands.get('todos').handler('', host.ctx);
  await panels.wait(() => panels.live() === 1 && panels.frame().some(line => line.includes('Bounded linked menu assignment')));
  await panels.select('Bounded linked menu assignment'); await panels.select('指派子 Agent');
  await panels.wait(() => host.jobs().some(job => job.todoId === 1));
  const linked = host.jobs().find(job => job.todoId === 1)!; assert.match(linked.assignment!, /Preserve the full stored requirement/);
  assert.notEqual(host.state().tasks[0]!.status, 'completed', 'dispatch never accepts the Todo');
  await host.call('subagent_inspect', { jobId: linked.id, output: true, until: 'finish', timeout: 10 });
  await panels.press('\x1b'); await panels.press('\x1b'); await opening;
});

test('U7 Profile and Job directories keep one row per entity and guided accordion children', { timeout: 20000 }, async t => {
  const host = await protocolHost({ features: ['todos', 'agents'], language: 'zh-CN' }); t.after(() => host.close());
  await host.profiles([{ name: 'default', model: { provider: 'dag-test', id: 'scripted' }, tools: ['read'] }, { name: 'review', model: { provider: 'dag-test', id: 'reasoned' }, instructions: 'Review approved inputs only' }, { name: 'fast', tools: [] }]);
  for (const subject of ['First entity', 'Second entity']) {
    await host.call('todo', { action: 'create', subject });
    const job = await host.call('subagent_spawn', { task: subject, todoId: host.state().tasks.at(-1)!.id });
    await host.call('subagent_inspect', { jobId: job.jobId, output: true, until: 'finish', timeout: 10 });
  }
  host.ctx.hasUI = true; host.ctx.mode = 'tui'; host.ctx.ui.theme = { style: (text: string) => text };
  const panels = recordPanels(host.ctx), opening = host.commands.get('agents').handler('', host.ctx);
  await panels.wait(() => panels.live() === 1);
  const upper = () => { const rendered = panels.frame(), rules = rendered.flatMap((line, index) => /^─+$/.test(line) ? [index] : []); return rendered.slice(rules[0]! + 1, rules[1]); };
  for (const job of host.jobs()) assert.equal(upper().filter(line => line.includes(job.id + ' ')).length, 1);
  // Search filters both upper groups, not just the Profile rows.
  await panels.press('/'); for (const character of 'First') await panels.press(character);
  const jobSearch = upper().join('\n');
  assert.match(jobSearch, /a1 First entity/); assert.doesNotMatch(jobSearch, /a2 Second entity/); assert.doesNotMatch(jobSearch, /default/);
  await panels.press('\x1b');
  await panels.press('/'); for (const character of 'review') await panels.press(character);
  const profileSearch = upper().join('\n');
  assert.match(profileSearch, /review/); assert.doesNotMatch(profileSearch, /a1 First entity/); assert.doesNotMatch(profileSearch, /default/);
  await panels.press('\x1b');
  assert.ok(upper().some(line => /Job \(2\)/.test(line)), 'the Job group heading carries its count');
  await panels.select('a1');
  assert.equal(upper().filter(line => /a1 /.test(line)).length, 1);
  assert.ok(upper().some(line => /阅读报告与诊断/.test(line)), 'one Job expands in place');
  await panels.press('h');
  // Profiles are a root-page group now: no subscreen, no breadcrumb.
  assert.ok(upper().some(line => /Profile \(3\)/.test(line)), 'the Profile group heading carries its count');
  for (const name of ['default', 'review', 'fast']) await panels.focus(name);
  assert.match(upper().find(line => line.includes('review'))!, /\[reasoned\] \[继承工具\]/);
  const profileHeader = panels.frame()[0], profileMounts = panels.mounts();
  await panels.select('review');
  assert.equal(panels.frame()[0], profileHeader, 'one Profile expands in place instead of opening an object subscreen');
  assert.equal(panels.mounts(), profileMounts);
  assert.equal(upper().filter(line => /review \./.test(line)).length, 1);
  assert.ok(upper().some(line => /模型/.test(line)), 'profile fields expand in place');
  // The expanded Profile has more rows than one screen; the neighbour is still in the same list, so the panel
  // can still reach it (a page swap would have replaced the list entirely).
  await panels.focus('default');
  assert.match(panels.frame().find(line => /^[ │]*> /.test(line)) ?? '', /default/, 'neighbour stays in the same list');
  const rules = panels.frame().flatMap((line, index) => /^─+$/.test(line) ? [index] : []);
  assert.equal(rules.length, 4, 'the root page keeps its dual-zone shell');
  await panels.select('编辑 Profile 指令'); await panels.press('\x01'); await panels.press('\x0b'); await panels.press('Updated through the input kind');
  const paints = panels.forces.length; await panels.press('\r'); await panels.wait(() => panels.forces.length > paints);
  const profiles = JSON.parse(await readFile(join(host.directory, 'pi-dag-workflow-profile.json'), 'utf8')).profiles;
  assert.equal(profiles.find((profile: any) => profile.name === 'review').instructions, 'Updated through the input kind');
  await panels.press('h'); assert.ok(panels.frame().some(line => /> .*review/.test(line)), 'h collapses the expanded entity');
  // Sub-screen rows carry no tail marker.
  const seen: string[] = [];
  await panels.press('G');
  for (let step = 0; step < 8; step++) { seen.push(...panels.frame()); await panels.press('j'); }
  const directoryRows = [...new Set(seen)].filter(line => /模型目录|子扩展/.test(line) && !/^\s*$/.test(line));
  assert.ok(directoryRows.length >= 2, seen.join('\n'));
  for (const row of directoryRows) assert.doesNotMatch(row, /[›…»]\s*$/, 'directory rows never carry a tail marker');
  // Clearing Agent records requires a second Enter, and the second Enter really clears them.
  await panels.focus('清除 Agent 运行记录'); await panels.press('\r');
  assert.match(panels.frame().join('\n'), /再次 Enter 清除/);
  assert.ok(host.jobs().length > 0, 'arming keeps the records');
  await panels.press('\r');
  await panels.wait(() => host.jobs().length === 0);
  await panels.press('\x1b'); await opening;
  assert.equal(panels.live(), 0);
});

for (const status of ['failed', 'interrupted'] as const) test(`panel redispatch preserves ${status} assignment, resolved scope and Todo binding under a new Job id`, { timeout: 20000 }, async t => {
  const host = await protocolHost({ features: ['todos', 'agents'], language: 'zh-CN' }); t.after(() => host.close());
  await host.call('todo', { action: 'create', subject: 'Preserved Task', description: 'Original Task requirements' });
  const first = await host.call('subagent_spawn', { task: 'ORIGINAL-SCOPE: inspect the selected inputs only', todoId: 1, model: { provider: 'dag-test', id: 'reasoned' }, thinking: 'low', tools: ['read'], skills: [] });
  await host.call('subagent_inspect', { jobId: first.jobId, output: true, until: 'finish', timeout: 10 });
  const original = structuredClone(host.jobs().find(job => job.id === first.jobId));
  await host.restore([{ ...original, status }]);
  host.ctx.hasUI = true; host.ctx.mode = 'tui'; host.ctx.ui.theme = { style: (text: string) => text };
  const panels = recordPanels(host.ctx), opening = host.commands.get('agents').handler('', host.ctx);
  await panels.select(first.jobId); await panels.select('重派（保留范围）');
  await panels.wait(() => host.jobs().some(job => job.resumeFrom === first.jobId));
  const next = host.jobs().find(job => job.resumeFrom === first.jobId)!;
  assert.notEqual(next.id, first.jobId); assert.equal(next.todoId, 1); assert.equal(next.assignment, original.assignment);
  assert.deepEqual(next.model, original.model); assert.equal(next.thinking, original.thinking); assert.deepEqual(next.tools, original.tools); assert.deepEqual(next.skills, original.skills);
  assert.equal(host.jobs().find(job => job.id === first.jobId)!.status, status);
  assert.equal(host.jobs().filter(job => job.id === first.jobId).length, 1);
  await host.call('subagent_inspect', { jobId: next.id, output: true, until: 'finish', timeout: 10 });
  await panels.press('\x1b');
  await panels.wait(() => panels.frame().some(line => line.includes(next.id)));
  await panels.press('\x1b'); await opening;
  assert.equal(panels.live(), 0);
});

{
const offline = fileURLToPath(new URL('./fixtures/offline-model.ts', import.meta.url));
const extensionNames = ['mock_search', ...Array.from({ length: 10 }, (_, index) => `mock_probe_${index}`)];
async function setupB1(t: { after(fn: () => unknown): void }, paths: string[] = ['~/mock-tools.ts']) {
  const root = await mkdtemp(join(tmpdir(), 'dag-b1-'));
  const extension = join(root, 'mock-tools.ts');
  const directory = join(root, 'agent', 'pi-dag-workflow');
  await mkdir(directory, { recursive: true });
  await symlink(extension, join(directory, 'mock-tools.ts'));
  await writeFile(extension, `export default function(pi) {
    pi.on('session_start', () => {
      for (const name of ${JSON.stringify(extensionNames)}) pi.registerTool({ name, label: name, description: 'B1 local search fixture', parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'], additionalProperties: false }, async execute(_id, input) { return { content: [{ type: 'text', text: JSON.stringify({ query: input.query, active: pi.getActiveTools() }) }], details: undefined }; } });
    });
  }`);
  const profilePath = join(directory, 'pi-dag-workflow-profile.json');
  const configure = (childExtensions: string[]) => writeFile(profilePath, JSON.stringify({ profiles: [{ name: 'ext', childExtensions }] }));
  await configure(paths);
  const client = await IsolatedClient.start(root, 'b1-extensions', [extension], ['--dag-workflow-test-child-provider', offline]);
  t.after(() => client.close());
  return { root, extension, directory, configure, client };
}
async function callB1(client: IsolatedClient, tool: string, params: object, failed = false) {
  const events = await client.prompt(`TEST CALL ${tool} ${JSON.stringify(params)}`);
  const end = events.find(event => event.type === 'tool_execution_end' && event.toolName === tool)!;
  assert.ok(end, tool);
  const result = end.result as any;
  assert.equal(end.isError === true || result.isError === true, failed, JSON.stringify(result));
  return result;
}
const activeB1 = (output: string): string[] => JSON.parse(output.slice(output.indexOf('{'))).active;

async function menuB4(client: IsolatedClient, steps: ((request: any) => string | boolean | undefined | Promise<string | boolean | undefined>)[]) {
  let at = client.records.length;
  const command = client.send('prompt', { message: '/agents' });
  for (const step of steps) {
    await client.until(() => client.records.slice(at).some(record => record.type === 'extension_ui_request' && ['select', 'editor', 'confirm'].includes(String(record.method))));
    const index = client.records.findIndex((record, index) => index >= at && record.type === 'extension_ui_request' && ['select', 'editor', 'confirm'].includes(String(record.method)));
    const request = client.records[index]!; at = index + 1;
    const value = await step(request);
    client.child.stdin.write(JSON.stringify({ type: 'extension_ui_response', id: request.id, ...(value === undefined ? { cancelled: true } : typeof value === 'boolean' ? { confirmed: value } : { value }) }) + '\n');
  }
  await command;
}

test('B4: real Pi menus save loaded and manual extensions inside a Profile, remove an entry, and apply it on dispatch', { timeout: 30000 }, async (t) => {
  const h = await setupB1(t, []), profilePath = join(h.directory, 'pi-dag-workflow-profile.json');
  const manual = join(h.directory, 'manual-tools.ts'); await writeFile(manual, 'export default function() {}');
  const pick = (request: any, word: string) => {
    assert.equal(request.method, 'select', `${word} expects a select`);
    const value = request.options.find((option: string) => option.includes(word));
    assert.ok(value, `${request.title}: missing ${word}`);
    return value;
  };
  const profile = async () => JSON.parse(await readFile(profilePath, 'utf8')).profiles[0];
  const saved = async (paths: string[]) => assert.deepEqual((await profile()).childExtensions, paths);
  const profileSteps = [
    (request: any) => pick(request, 'Profile 列表'),
    (request: any) => pick(request, 'ext'),
  ];
  await menuB4(h.client, [
    ...profileSteps,
    (request: any) => pick(request, '从已加载扩展选择'),
    (request: any) => { const matches = request.options.filter((option: string) => option.includes('mock-tools.ts')); assert.equal(matches.length, 1); assert.match(matches[0], /11 个工具/); assert.ok(matches[0].endsWith('mock-tools.ts  11 个工具'), 'the selectable path keeps its filename tail before the count'); return matches[0]; },
    async (request: any) => { await saved([h.extension]); return pick(request, 'Profile 列表'); },
    (request: any) => pick(request, 'ext'),
    (request: any) => pick(request, '下一页'),
    (request: any) => pick(request, '手动输入扩展路径'),
    (request: any) => { assert.equal(request.method, 'editor'); return './missing.ts'; },
    async (request: any) => {
      await saved([h.extension]);
      assert.ok(h.client.records.some(record => record.method === 'notify' && String(record.message).includes('missing.ts')));
      return pick(request, 'Profile 列表');
    },
    (request: any) => pick(request, 'ext'),
    (request: any) => pick(request, '下一页'),
    (request: any) => pick(request, '手动输入扩展路径'),
    (request: any) => { assert.equal(request.method, 'editor'); return './manual-tools.ts'; },
    async (request: any) => { await saved([h.extension, './manual-tools.ts']); await rm(manual); return pick(request, 'Profile 列表'); },
    (request: any) => pick(request, 'ext'),
    (request: any) => pick(request, '下一页'),
    (request: any) => pick(request, './manual-tools.ts'),
    async (request: any) => { assert.equal(request.method, 'confirm'); assert.match(String(request.title), /manual-tools\.ts/); await saved([h.extension, './manual-tools.ts']); return true; },
    async () => { await saved([h.extension]); return undefined; },
  ]);
  const spawned = (await callB1(h.client, 'subagent_spawn', { profile: 'ext', task: 'TEST CALL mock_search {"query":"B4 saved extension"}', tools: ['mock_search'] })).details;
  const result = (await callB1(h.client, 'subagent_inspect', { jobId: spawned.jobId, output: true, until: 'finish', timeout: 10 })).details;
  assert.equal(result.status, 'completed'); assert.match(result.output, /B4 saved extension/);
  await saved([h.extension]);
});

test('B4: extension tool rejection includes its parent source while unknown names keep the original diagnostic', { timeout: 30000 }, async (t) => {
  const h = await setupB1(t, []);
  const registered = await callB1(h.client, 'subagent_spawn', { profile: 'ext', task: 'must not run', tools: ['mock_search'] }, true);
  assert.ok(registered.details.error.includes(h.extension));
  assert.match(registered.details.error, /childExtensions.*\/agents/);
  const unknown = await callB1(h.client, 'subagent_spawn', { task: 'must not run', tools: ['misspelled_search'] }, true);
  assert.match(unknown.details.error, /misspelled_search.*Allowed:.*subagent_inspect tools:true/);
  assert.equal(unknown.details.error.includes(h.extension), false);
  assert.equal(unknown.details.error.includes('childExtensions'), false);
});



test('B1: real Pi discovers classified tools and invokes an explicitly selected extension without an eight-tool cap', { timeout: 30000 }, async (t) => {
  const h = await setupB1(t);
  const directory = (await callB1(h.client, 'subagent_inspect', { tools: true })).details.tools;
  for (const name of ['read', 'grep', 'find', 'ls', 'bash', 'edit', 'write']) assert.ok(directory.some((tool: any) => tool.name === name && tool.from === 'core'), name);
  for (const name of extensionNames) assert.deepEqual(directory.find((tool: any) => tool.name === name), { name, description: 'B1 local search fixture', from: 'extension' });
  assert.equal(directory.some((tool: any) => tool.name === 'subagent_spawn' || tool.name.startsWith('mcp__')), false);
  const selected = ['read', ...extensionNames];
  const spawned = (await callB1(h.client, 'subagent_spawn', { profile: 'ext', task: 'TEST CALL mock_search {"query":"B1 actual invocation"}', tools: selected })).details;
  assert.deepEqual(spawned.tools, selected);
  const result = (await callB1(h.client, 'subagent_inspect', { jobId: spawned.jobId, output: true, until: 'finish', timeout: 10 })).details;
  assert.equal(result.status, 'completed'); assert.match(result.output, /B1 actual invocation/);
  assert.deepEqual(activeB1(result.output).sort(), [...selected, 'subagent_send'].sort());
  const session = (await h.client.send('get_state')).data as { sessionFile: string };
  await h.client.send('switch_session', { sessionPath: session.sessionFile });
  assert.deepEqual((await callB1(h.client, 'subagent_inspect', { jobId: spawned.jobId })).details.jobs[0].tools, selected, 'restoration must not truncate the resolved tool snapshot');
  const resumed = (await callB1(h.client, 'subagent_spawn', { profile: 'ext', resumeFrom: spawned.jobId, task: 'Continue the same verified tool configuration' })).details;
  assert.deepEqual(resumed.tools, selected);
  assert.equal((await callB1(h.client, 'subagent_inspect', { jobId: resumed.jobId, output: true, until: 'finish', timeout: 10 })).details.status, 'completed');
  assert.equal(h.client.records.some(record => record.type === 'extension_error'), false);
});

test('B1: real Pi updates extension tools in the same interrupted child and leaves unselected siblings inactive', { timeout: 30000 }, async (t) => {
  const h = await setupB1(t, ['mock-tools.ts']);
  const spawned = (await callB1(h.client, 'subagent_spawn', { profile: 'ext', task: 'CONTROL QUESTION', tools: ['read'] })).details;
  const waiting = (await callB1(h.client, 'subagent_inspect', { jobId: spawned.jobId, output: true, until: 'update', timeout: 10 })).details;
  assert.equal(waiting.status, 'waiting');
  const sent = (await callB1(h.client, 'subagent_send', { recipient: spawned.jobId, interrupt: true, tools: ['read', 'mock_search'], message: 'TEST CALL mock_search {"query":"B1 hot switch"}' })).details;
  assert.equal(sent.interrupted, true); assert.deepEqual(sent.tools, ['read', 'mock_search']);
  const result = (await callB1(h.client, 'subagent_inspect', { jobId: spawned.jobId, output: true, until: 'finish', timeout: 10 })).details;
  assert.equal(result.id, spawned.jobId); assert.equal(result.status, 'completed'); assert.match(result.output, /B1 hot switch/);
  assert.deepEqual(activeB1(result.output).sort(), ['mock_search', 'read', 'subagent_send']);
  assert.equal((await callB1(h.client, 'subagent_inspect', {})).details.jobs.length, 1);
});

test('B1: live configuration blocks unknown, unconfigured and missing extensions before reserving a child', { timeout: 30000 }, async (t) => {
  const h = await setupB1(t, []);
  const rejected = await callB1(h.client, 'subagent_spawn', { profile: 'ext', task: 'must not run', tools: ['mock_search'] }, true);
  assert.match(rejected.details.error, /mock_search.*Allowed:.*subagent_inspect tools:true/);
  assert.equal((await callB1(h.client, 'subagent_inspect', {})).details.jobs.length, 0);
  await h.configure(['missing.ts']);
  const missing = await callB1(h.client, 'subagent_spawn', { profile: 'ext', task: 'must not run', tools: ['read'] }, true);
  assert.match(missing.details.error, /missing\.ts.*childExtensions/);
  assert.equal((await callB1(h.client, 'subagent_inspect', {})).details.jobs.length, 0);
  await h.configure([h.extension]);
  assert.ok((await callB1(h.client, 'subagent_inspect', { tools: true })).details.tools.some((tool: any) => tool.name === 'mock_search'));
  const spawned = (await callB1(h.client, 'subagent_spawn', { profile: 'ext', task: 'TEST CALL mock_search {"query":"hot configuration"}', tools: ['mock_search'] })).details;
  assert.equal((await callB1(h.client, 'subagent_inspect', { jobId: spawned.jobId, output: true, until: 'finish', timeout: 10 })).details.status, 'completed');
});

test('B1: missing extension tools in a Profile or resume snapshot fail loudly without a new job', { timeout: 30000 }, async (t) => {
  const h = await setupB1(t);
  const profilePath = join(h.directory, 'pi-dag-workflow-profile.json');
  await writeFile(profilePath, JSON.stringify({ profiles: [{ name: 'searcher', tools: ['mock_search'], childExtensions: [h.extension] }] }));
  const spawned = (await callB1(h.client, 'subagent_spawn', { profile: 'searcher', task: 'TEST CALL mock_search {"query":"profile tool"}' })).details;
  assert.equal((await callB1(h.client, 'subagent_inspect', { jobId: spawned.jobId, output: true, until: 'finish', timeout: 10 })).details.status, 'completed');
  await writeFile(profilePath, JSON.stringify({ profiles: [{ name: 'searcher', tools: ['mock_search'] }] }));
  for (const options of [{ resumeFrom: spawned.jobId }, { profile: 'searcher' }]) {
    const result = await callB1(h.client, 'subagent_spawn', { ...options, task: 'must not silently drop the extension' }, true);
    assert.match(result.details.error, /mock_search.*Allowed:/);
  }
  assert.equal((await callB1(h.client, 'subagent_inspect', {})).details.jobs.length, 1);
  assert.equal((await callB1(h.client, 'subagent_inspect', { jobId: spawned.jobId })).details.jobs[0].status, 'completed');
});

test('B1: tool discovery is directory-only and rules carry behavior outside spawn/send schemas', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dag-b1-rules-')); t.after(() => rm(root, { recursive: true, force: true }));
  const previous = process.env.PI_CODING_AGENT_DIR; process.env.PI_CODING_AGENT_DIR = root;
  t.after(() => { if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous; });
  const events = new Map<string, Function[]>(), tools = new Map<string, any>();
  const pi: any = { on(name: string, fn: Function) { events.set(name, [...events.get(name) ?? [], fn]); }, registerFlag() {}, getFlag() {}, appendEntry() {}, getAllTools() { return []; }, getActiveTools() { return []; }, registerTool(tool: any) { tools.set(tool.name, tool); }, registerCommand() {} };
  const previousLocale = process.env.LC_ALL; process.env.LC_ALL = 'en_US.UTF-8';
  try { await loadPublic(pi, ['agents']); }
  finally { if (previousLocale === undefined) delete process.env.LC_ALL; else process.env.LC_ALL = previousLocale; }
  const ctx: any = { cwd: root, hasUI: false, mode: 'rpc', sessionManager: { getBranch: () => [], getLeafId: () => undefined }, modelRegistry: { find: () => undefined }, ui: { notify() {}, setWidget() {} }, isIdle: () => true };
  for (const handler of events.get('session_start') ?? []) await handler({ type: 'session_start' }, ctx);
  const event: any = { systemPromptOptions: { sections: { existing: 'preserved' } } };
  for (const handler of events.get('before_agent_start') ?? []) await handler(event, ctx);
  const rules = event.systemPromptOptions.promptGuidelines.join('\n');
  assert.equal(event.systemPromptOptions.sections.dag_agent_rules, undefined);
  assert.equal(rules.split('\n').length, 6);
  for (const word of ['unblocked Todo', 'pass todoId', 'Do not create a Todo merely to delegate', 'serial steps with one child', 'parallelize independent work']) assert.ok(rules.split('\n')[3]!.includes(word), word);
  for (const word of ['critical path', 'resumeFrom', 'replacement Todo', 'user-stopped objective needs explicit authorization']) assert.ok(rules.split('\n')[4]!.includes(word), word);
  assert.equal(tools.get('subagent_spawn').parameters.properties.todoId.description, 'Bind this child to an existing unblocked Todo; the report never completes the Todo'); assert.match(rules, /subagent_inspect tools:true/); assert.match(rules, /explicit tools list/); assert.match(rules, /Verify reports and artifacts/);
  assert.equal(event.systemPromptOptions.sections.existing, 'preserved');
  for (const name of ['subagent_spawn', 'subagent_send']) {
    const tool = tools.get(name);
    assert.equal(tool.parameters.properties.tools.items.type, 'string'); assert.equal(tool.parameters.properties.tools.items.enum, undefined); assert.equal(tool.parameters.properties.tools.maxItems, undefined);
    assert.ok(tool.description.length < 420); assert.doesNotMatch(tool.description, /sandbox|user authorization/);
  }
  for (const extra of [{ jobId: 'a1' }, { models: true }, { profiles: 'summary' }, { output: true }]) {
    const result = await tools.get('subagent_inspect').execute('inspect', { tools: true, ...extra }, undefined, undefined, { cwd: root });
    assert.equal(result.isError, true); assert.match(result.details.error, /directory query/);
  }
});
test('B1.1: real Pi retains core read when a parent extension overrides its name', { timeout: 30000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dag-b11-read-'));
  const extension = join(root, 'override-read.ts');
  await writeFile(extension, `export default function(pi) {
    pi.on('session_start', () => pi.registerTool({ name: 'read', label: 'read', description: 'Parent read wrapper', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false }, async execute() { return { content: [{ type: 'text', text: 'PARENT-ONLY-WRAPPER' }], details: undefined }; } }));
  }`);
  await writeFile(join(root, 'actual-read.txt'), 'B11-ACTUAL-FILE-CONTENT');
  const client = await IsolatedClient.start(root, 'b11-read-override', [extension], ['--dag-workflow-test-child-provider', offline]); t.after(() => client.close());
  const directory = (await callB1(client, 'subagent_inspect', { tools: true })).details.tools;
  assert.equal(directory.find((tool: any) => tool.name === 'read').from, 'core');
  const spawned = (await callB1(client, 'subagent_spawn', { task: 'TEST CALL read {"path":"actual-read.txt"}' })).details;
  assert.ok(spawned.tools.includes('read'));
  assert.equal((spawned.ignoredInheritedTools ?? []).includes('read'), false);
  const result = (await callB1(client, 'subagent_inspect', { jobId: spawned.jobId, output: true, until: 'finish', timeout: 10 })).details;
  assert.equal(result.status, 'completed'); assert.match(result.output, /B11-ACTUAL-FILE-CONTENT/); assert.doesNotMatch(result.output, /PARENT-ONLY-WRAPPER/);
});

test('B1.1: a residual machine-wide childExtensions key is ignored and never blocks startup or dispatch', { timeout: 30000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dag-b11-residual-'));
  const directory = join(root, 'agent', 'pi-dag-workflow');
  await mkdir(directory, { recursive: true });
  // Simulates a config file written before 04c: the key is now unknown and must be dropped on read.
  await writeFile(join(directory, 'pi-dag-workflow-config.json'), JSON.stringify({ childExtensions: [join(root, 'gone.ts')] }));
  await writeFile(join(directory, 'pi-dag-workflow-profile.json'), JSON.stringify({ profiles: [{ name: 'plain', childExtensions: [] }] }));
  const client = await IsolatedClient.start(root, 'b11-residual', [], ['--dag-workflow-test-child-provider', offline]); t.after(() => client.close());
  const commands = ((await client.send('get_commands')).data as { commands: { name: string }[] }).commands.map(command => command.name);
  assert.ok(commands.includes('agents') && commands.includes('todos'), 'all modules start with the residual key');
  const spawned = (await callB1(client, 'subagent_spawn', { profile: 'plain', task: 'TEST CALL read {"path":"actual-read.txt"}', tools: ['read'] })).details;
  const result = (await callB1(client, 'subagent_inspect', { jobId: spawned.jobId, output: true, until: 'finish', timeout: 10 })).details;
  assert.equal(result.status, 'completed');
  assert.equal(client.records.some(record => record.type === 'extension_error'), false);
  assert.equal(client.records.some(record => record.method === 'notify' && String(record.message).includes('childExtensions')), false);
  // An undeclared profile contributes no extensions: extension tools are not trusted.
  const rejected = await callB1(client, 'subagent_spawn', { profile: 'plain', task: 'must not run', tools: ['mock_search'] }, true);
  assert.match(rejected.details.error, /mock_search.*Allowed:/);
  assert.equal((await callB1(client, 'subagent_inspect', {})).details.jobs.length, 1);
});

test('B1.1: real Pi loads and saves extension Profiles through cold slash-command entry points', { timeout: 30000 }, async (t) => {
  for (const command of ['/agents profiles', '/agents profile created dag-test/scripted off mock_search', '/agents unprofile searcher']) {
    const h = await setupB1(t);
    const profilePath = join(h.directory, 'pi-dag-workflow-profile.json');
    await writeFile(profilePath, JSON.stringify({ profiles: [{ name: 'searcher', tools: ['mock_search'], childExtensions: [h.extension] }] }));
    const records = await h.client.prompt(command);
    const notices = records.filter(record => record.method === 'notify').map(record => String(record.message)).join('\n');
    assert.doesNotMatch(notices, /not trusted or supported|Error:/, command);
    assert.equal(h.client.records.some(record => record.type === 'tool_execution_start' && ['subagent_spawn', 'subagent_inspect'].includes(String(record.toolName))), false, 'Profile commands must work before spawn or discovery');
    const profiles = JSON.parse(await readFile(profilePath, 'utf8')).profiles;
    if (command === '/agents profiles') assert.match(notices, /Profile searcher[\s\S]*mock_search/);
    else if (command.includes('unprofile')) assert.deepEqual(profiles, []);
    else assert.deepEqual(profiles.find((profile: any) => profile.name === 'created').tools, ['mock_search']);
  }
});
}


{
const fixture = fileURLToPath(new URL('./fixtures/m2-rpc-fixture.mjs', import.meta.url));
const reportFixture = fileURLToPath(new URL('./fixtures/report-rpc-fixture.mjs', import.meta.url));

test("CLI is resolved from installed package bin", { timeout: 20000 }, async (t) => {
  const host = await protocolHost(); t.after(() => host.close());
  const job = await host.call('subagent_spawn', { task: 'CLI resolution probe' });
  const result = await host.call('subagent_inspect', { jobId: job.jobId, output: true, until: 'finish', timeout: 10 });
  assert.equal(result.status, 'completed', 'a real child runs through the resolved Pi package bin');
  assert.match(result.output, /离线模拟/);
});

test("real offline Pi child completes, isolated resource discovery and no standalone job state", { timeout: 20000 }, async (t) => {
  const host = await protocolHost({ idle: true }); t.after(() => host.close());
  await mkdir(join(host.root, '.pi', 'extensions'), { recursive: true });
  await writeFile(join(host.root, '.pi', 'extensions', 'm2-unwanted.ts'), `import {writeFileSync} from 'node:fs'; export default function(){writeFileSync('unwanted-loaded','bad')}`);
  const job = await host.call('subagent_spawn', { task: 'A private task not visible in inspect' });
  for (let attempt = 0; attempt < 300; attempt++) { if ((await host.call('subagent_inspect', { jobId: job.jobId })).jobs[0].status === 'completed') break; await delay(20); }
  const noticed = (item: any) => String(item.message?.content ?? '').includes('离线模拟');
  for (let attempt = 0; attempt < 200 && !host.sent.some(noticed); attempt++) await delay(20);
  assert.equal(host.sent.filter(noticed).length, 1, 'a completed report wakes the parent exactly once');
  const result = await host.call('subagent_inspect', { jobId: job.jobId, output: true, until: 'finish', timeout: 10 });
  assert.equal(result.status, 'completed');
  assert.match(result.output, /离线模拟/);
  assert.equal((await host.call('subagent_inspect', {})).jobs[0].status, 'completed');
  const inspection = JSON.stringify(await host.call('subagent_inspect', { jobId: job.jobId }));
  assert.doesNotMatch(inspection, /private task|离线模拟|requestId/);
  assert.ok(result.tools.includes('read'));
  assert.ok(!result.tools.includes('subagent_spawn'));
  assert.ok(!(await readdir(host.root)).includes('unwanted-loaded'));
  assert.ok(!(await readdir(host.root)).some((name) => (name.endsWith('.json') || name.endsWith('.jsonl')) && name !== 'child-context.jsonl'));
  await assert.rejects(host.call('subagent_send', { recipient: job.jobId, message: 'Too late' }), /no longer active/);
  await assert.rejects(host.call('subagent_send', { recipient: job.jobId, requestId: 'wrong', message: 'answer' }), /requestId|recipient/);
});

test("real child questions/requestId replies and reports travel through private RPC pipes", { timeout: 25000 }, async (t) => {
  const host = await protocolHost({ idle: true }); t.after(() => host.close());
  const job = await host.call('subagent_spawn', { task: 'CONTROL QUESTION' });
  const pending = await host.call('subagent_inspect', { jobId: job.jobId, output: true, until: 'update', timeout: 10 });
  assert.equal(pending.status, 'waiting');
  assert.equal(pending.requests.length, 1);
  const request = pending.requests[0];
  assert.equal(request.message, 'CONTROL decision?');
  assert.equal((await host.call('subagent_inspect', { jobId: job.jobId })).jobs[0].questions[0].requestId, request.requestId, 'the pending question keeps its requestId until answered');
  await assert.rejects(host.call('subagent_send', { recipient: job.jobId, requestId: 'wrong', message: 'answer' }), /requestId|recipient/);
  await host.call('subagent_send', { requestId: request.requestId, message: 'Use the safe option.' });
  const completed = await host.call('subagent_inspect', { jobId: job.jobId, output: true, until: 'finish', timeout: 15 });
  assert.equal(completed.status, 'completed');
  assert.match(completed.output, /Use the safe option/);
  assert.equal(completed.pendingRequests, 0);
  const reporting = await host.call('subagent_spawn', { task: 'TEST CALL subagent_send {"message":"Found a useful result"}' });
  const result = await host.call('subagent_inspect', { jobId: reporting.jobId, output: true, until: 'finish', timeout: 15 });
  assert.equal(result.status, 'completed');
  assert.equal((await host.call('subagent_inspect', { jobId: reporting.jobId })).jobs[0].questions.length, 0);
});

test("real parent steering is delivered after a blocked tool batch, not as a new child", { timeout: 25000 }, async (t) => {
  const host = await protocolHost(); t.after(() => host.close());
  const job = await host.call('subagent_spawn', { task: 'CONTROL QUESTION' });
  const pending = await host.call('subagent_inspect', { jobId: job.jobId, output: true, until: 'update', timeout: 10 });
  await host.call('subagent_send', { recipient: job.jobId, message: 'Parent steering after the full tool batch.' });
  assert.equal((await host.call('subagent_inspect', { jobId: job.jobId })).jobs[0].status, 'waiting');
  await host.call('subagent_send', { requestId: pending.requests[0].requestId, message: 'Proceed.' });
  const result = await host.call('subagent_inspect', { jobId: job.jobId, output: true, until: 'finish', timeout: 15 });
  assert.equal(result.status, 'completed');
  assert.match(result.output, /离线模拟/);
  assert.equal((await host.call('subagent_inspect', {})).jobs.length, 1);
});

test("maximum reserved slots, duplicate todo blocked, no extra dispatch queue", { timeout: 40000 }, async (t) => {
  const host = await protocolHost({ features: ['todos', 'agents'] }); t.after(() => host.close());
  for (let index = 1; index <= 8; index++) await host.call('todo', { action: 'create', subject: `slot ${index}` });
  const started: any[] = [];
  for (let index = 1; index <= 8; index++) started.push(await host.call('subagent_spawn', { task: 'CONTROL QUESTION', todoId: index }));
  assert.equal(activeJobs(host), 8);
  const overflow = await host.execute('subagent_spawn', { task: 'CONTROL QUESTION' });
  assert.equal(overflow.isError, true); assert.match(overflow.content[0].text, /All 8 agent slots/);
  await host.call('subagent_cancel', { jobId: started[3]!.jobId });
  const duplicate = await host.execute('subagent_spawn', { task: 'CONTROL QUESTION', todoId: 1 });
  assert.equal(duplicate.isError, true); assert.match(duplicate.content[0].text, /already has an active/);
  assert.equal(saved(host).length, 8);
  await host.call('subagent_cancel', { jobId: started[0]!.jobId, remove: true });
  assert.equal(saved(host).length, 7);
  assert.equal((await host.execute('subagent_inspect', { jobId: started[0]!.jobId })).isError, true);
  for (const job of saved(host)) if (['starting', 'running', 'waiting'].includes(job.status)) await host.call('subagent_cancel', { jobId: job.id });
});

test("wait deadlines and abort leave active process intact; cancellation removes pending questions", { timeout: 25000 }, async (t) => {
  const holder = await protocolHost({ cli: fixture });
  try {
    const held = await holder.call('subagent_spawn', { task: 'HOLD' });
    const timed = await holder.call('subagent_inspect', { jobId: held.jobId, output: true, timeout: 0.03 });
    assert.equal(timed.timedOut, true);
    assert.equal(activeJobs(holder), 1);
  } finally { await holder.close(); }
  const host = await protocolHost(); t.after(() => host.close());
  const questioned = await host.call('subagent_spawn', { task: 'CONTROL QUESTION' });
  const pending = await host.call('subagent_inspect', { jobId: questioned.jobId, output: true, until: 'update', timeout: 5 });
  assert.equal(pending.requests.length, 1);
  await host.call('subagent_cancel', { jobId: questioned.jobId });
  assert.equal((await host.call('subagent_inspect', { jobId: questioned.jobId })).jobs[0].status, 'cancelled');
  assert.equal(activeJobs(host), 0);
});

test("agent_end alone and even settled with pending followups cannot complete a child", { timeout: 15000 }, async (t) => {
  const host = await protocolHost({ cli: fixture }); t.after(() => host.close());
  const job = await host.call('subagent_spawn', { task: 'INTERIM' });
  const interim = await host.call('subagent_inspect', { jobId: job.jobId, output: true, timeout: 0.025 });
  assert.equal(interim.timedOut, true);
  assert.equal(interim.status, 'running');
  const completed = await host.call('subagent_inspect', { jobId: job.jobId, output: true, until: 'finish', timeout: 3 });
  assert.equal(completed.status, 'completed');
  assert.match(completed.output, /followup really finished/);
});

test("unexpected exit, model errors and malformed protocol all fail and clean up", { timeout: 30000 }, async (t) => {
  const host = await protocolHost({ cli: fixture }); t.after(() => host.close());
  for (const task of ["EXIT", "ERROR", "BAD JSON", "BAD EVENT"]) {
    const job = await host.call('subagent_spawn', { task });
    const result = await host.call('subagent_inspect', { jobId: job.jobId, output: true, until: 'finish', timeout: 5 });
    assert.equal(result.status, "failed", task);
    assert.equal(activeJobs(host), 0, task);
    if (task === "ERROR") assert.match(result.output, /partial retained|fixture model error/);
    assert.doesNotMatch(JSON.stringify(await host.call('subagent_inspect', { jobId: job.jobId })), /partial retained/);
    if (task === 'ERROR') assert.match(saved(host).find((item: any) => item.id === job.jobId)!.failure!.reason, /fixture model error/);
  }
});

test("startup failure and execution timeout cleanly fail while keeping full output", { timeout: 30000 }, async (t) => {
  const missing = await protocolHost({ cli: join(await mkdtemp(join(tmpdir(), 'dag-m2-missing-')), 'm2-missing-cli.mjs') });
  try {
    const job = await missing.execute('subagent_spawn', { task: "test" });
    assert.equal(job.isError, true, 'a missing child CLI fails the dispatch instead of hanging');
    assert.equal(job.details.status, "failed");
    assert.equal(activeJobs(missing), 0);
  } finally { await missing.close(); }
  const host = await protocolHost({ cli: fixture }); t.after(() => host.close());
  // HOLD only ends at its deadline, but real child startup is not fixed: give the deadline room and
  // wait for the terminal state instead of assuming dispatch returns while the child is still running.
  const held = await host.execute('subagent_spawn', { task: "HOLD", timeout: 1 });
  const expired = await host.call('subagent_inspect', { jobId: held.details.jobId, output: true, until: 'finish', timeout: 10 });
  assert.equal(expired.status, 'failed', 'a job past its deadline is failed, not pending');
  assert.equal(expired.error, "Agent deadline exceeded");
  const huge = await host.call('subagent_spawn', { task: "HUGE" });
  const result = await host.call('subagent_inspect', { jobId: huge.jobId, output: true, until: 'finish', timeout: 10 });
  assert.equal(result.status, "completed");
  assert.equal(result.output, "🦊\u2028\u2029" + "bounded output ".repeat(12000) + "\n");
});

test("long child reports and >1 MiB output are delivered and stored whole", { timeout: 40000 }, async (t) => {
  const host = await protocolHost({ cli: reportFixture, idle: true }); t.after(() => host.close());
  const report = await host.call('subagent_spawn', { task: "BIGREPORT" });
  for (let attempt = 0; attempt < 300; attempt++) { if ((await host.call('subagent_inspect', { jobId: report.jobId })).jobs[0].status === 'completed') break; await delay(20); }
  await delay(200);
  assert.ok(host.sent.some((item: any) => String(item.message?.content ?? '').includes("r".repeat(1100000))), 'a >1 MiB report is delivered whole');
  const reportResult = await host.call('subagent_inspect', { jobId: report.jobId, output: true, until: 'finish', timeout: 15 });
  assert.equal(reportResult.status, "completed");

  const output = await host.call('subagent_spawn', { task: "BIGOUTPUT" });
  const outputResult = await host.call('subagent_inspect', { jobId: output.jobId, output: true, until: 'finish', timeout: 15 });
  assert.equal(outputResult.status, "completed");
  assert.equal(outputResult.output, "o".repeat(1100000) + "\n");
});

test("export/import and full completion keep long child output and reports intact", { timeout: 30000 }, async (t) => {
  const host = await protocolHost({ cli: reportFixture });
  let restoredHost: any;
  t.after(async () => { await restoredHost?.close(); await host.close(); });
  const job = await host.call('subagent_spawn', { task: "BIGOUTPUT" });
  const completed = await host.call('subagent_inspect', { jobId: job.jobId, output: true, until: 'finish', timeout: 15 });
  assert.equal(completed.output.length, 1100001);
  const persisted = saved(host);
  assert.equal(persisted[0]!.output, "o".repeat(1100000) + "\n");
  restoredHost = await protocolHost({ cli: fixture, entries: host.entries });
  const restored = await restoredHost.call('subagent_inspect', { jobId: job.jobId, output: true, timeout: 0 });
  assert.equal(restored.output, "o".repeat(1100000) + "\n");
});

test("child questions larger than the old 1 MiB cap round-trip through requestId replies", { timeout: 30000 }, async (t) => {
  const host = await protocolHost({ cli: reportFixture }); t.after(() => host.close());
  const job = await host.call('subagent_spawn', { task: "BIGQUESTION" });
  const pending = await host.call('subagent_inspect', { jobId: job.jobId, output: true, until: 'update', timeout: 15 });
  assert.equal(pending.status, "waiting");
  const request = pending.requests[0];
  assert.equal(request.message, "q".repeat(1100000));
  await host.call('subagent_send', { requestId: request.requestId, message: "a".repeat(1100000) });
  const completed = await host.call('subagent_inspect', { jobId: job.jobId, output: true, until: 'finish', timeout: 15 });
  assert.equal(completed.status, "completed");
  assert.match(completed.output, /answered:1100000/);
});

test("terminal reports stay pending until the parent context acknowledges delivery", { timeout: 20000 }, async (t) => {
  const host = await protocolHost({ cli: fixture }); t.after(() => host.close());
  const job = await host.call('subagent_spawn', { task: "plain result" });
  let summary: any;
  for (let attempt = 0; attempt < 200; attempt++) { summary = (await host.call('subagent_inspect', { jobId: job.jobId })).jobs[0]; if (summary.status === 'completed') break; await delay(10); }
  assert.equal(summary.status, 'completed');
  assert.equal(summary.reportDelivery, "pending");
  assert.equal(saved(host).find((item: any) => item.id === job.jobId)!.reportDelivery, "pending");
  const delivered = await host.call('subagent_inspect', { jobId: job.jobId, output: true, timeout: 0 });
  assert.equal(delivered.reportDelivery, "delivered", 'collecting the report acknowledges delivery');
  assert.equal(saved(host).find((item: any) => item.id === job.jobId)!.reportDelivery, "delivered");
});

test("cancelled and interrupted records carry no pending delivery acknowledgement", { timeout: 20000 }, async (t) => {
  const host = await protocolHost({ cli: fixture });
  let restoredHost: any;
  t.after(async () => { await restoredHost?.close(); await host.close(); });
  const cancelled = await host.call('subagent_spawn', { task: "HOLD" });
  await host.call('subagent_cancel', { jobId: cancelled.jobId });
  assert.equal(saved(host).find((item: any) => item.id === cancelled.jobId)!.reportDelivery, undefined);
  const activeJob = await host.call('subagent_spawn', { task: "HOLD" });
  restoredHost = await protocolHost({ cli: fixture, entries: host.entries });
  assert.equal(saved(restoredHost).find((item: any) => item.id === activeJob.jobId)!.reportDelivery, undefined);
  assert.equal((await restoredHost.call('subagent_inspect', { jobId: activeJob.jobId })).jobs[0].status, 'interrupted');
});

test("restore preserves pending delivery without auto replay; manual wait acknowledges", { timeout: 20000 }, async (t) => {
  const host = await protocolHost({ cli: fixture });
  let restoredHost: any;
  t.after(async () => { await restoredHost?.close(); await host.close(); });
  const job = await host.call('subagent_spawn', { task: "restored report" });
  for (let attempt = 0; attempt < 200; attempt++) { if ((await host.call('subagent_inspect', { jobId: job.jobId })).jobs[0].status === 'completed') break; await delay(10); }
  assert.equal(saved(host).find((item: any) => item.id === job.jobId)!.reportDelivery, "pending");
  restoredHost = await protocolHost({ cli: fixture, entries: host.entries });
  assert.equal(saved(restoredHost).find((item: any) => item.id === job.jobId)!.reportDelivery, "pending");
  // Restoring never replays or starts work: collecting is what acknowledges the pending report.
  assert.equal((await restoredHost.call('subagent_inspect', { jobId: job.jobId })).jobs[0].reportDelivery, "pending");
  assert.equal((await restoredHost.call('subagent_inspect', { jobId: job.jobId, output: true, timeout: 0 })).reportDelivery, "delivered");
  assert.equal((await restoredHost.call('subagent_inspect', { jobId: job.jobId, output: true, timeout: 0 })).reportDelivery, "delivered", 'acknowledgement is idempotent');
});

test("invalid restored fields are rejected atomically without stopping an existing child", { timeout: 20000 }, async (t) => {
  const host = await protocolHost({ cli: fixture }); t.after(() => host.close());
  const job = await host.call('subagent_spawn', { task: "HOLD" });
  for (const patch of [{ thinking: {} }, { thinking: "unsupported" }, { endedAt: Infinity }, { todoId: 0 }]) {
    await host.restore([{ ...saved(host)[0], ...patch } as never]);
    const inspected = await host.execute('subagent_inspect', { jobId: job.jobId });
    assert.equal(inspected.isError, true, 'a corrupt snapshot is rejected instead of partially applied');
    assert.match(inspected.content[0].text, /Invalid agent summary/);
    assert.equal(saved(host).filter((item: any) => item.id === job.jobId).length, 1, 'rejection never spawns or duplicates a job');
  }
});

test("panel labels never end on a split supplementary Unicode character", { timeout: 20000 }, async (t) => {
  const host = await protocolHost({ cli: fixture }); t.after(() => host.close());
  const task = "x".repeat(79) + "\u{1D11E}" + " more text";
  const job = await host.call('subagent_spawn', { task });
  saved(host);
  await host.call('subagent_inspect', { jobId: job.jobId, output: true, until: 'finish', timeout: 3 });
  const stored = saved(host).find((item: any) => item.id === job.jobId)!;
  assert.equal(stored.label, "x".repeat(79));
  assert.doesNotMatch(stored.label, /[\uD800-\uDBFF]$/);
  await host.call('subagent_cancel', { jobId: job.jobId });
});

test("recovery imports compact records, preserves stored output, interrupts active and never spawns", { timeout: 25000 }, async (t) => {
  const host = await protocolHost({ cli: fixture });
  let restoredHost: any;
  t.after(async () => { await restoredHost?.close(); await host.close(); });
  const completed = await host.call('subagent_spawn', { task: "Result to keep" });
  await host.call('subagent_inspect', { jobId: completed.jobId, output: true, until: 'finish', timeout: 3 });
  const activeJob = await host.call('subagent_spawn', { task: "HOLD" });
  restoredHost = await protocolHost({ cli: fixture, entries: host.entries });
  const restoredJobs = (await restoredHost.call('subagent_inspect', {})).jobs;
  assert.equal(restoredJobs.filter((item: any) => ['starting', 'running', 'waiting'].includes(item.status)).length, 0);
  assert.equal(restoredJobs.find((item: any) => item.id === activeJob.jobId)!.status, "interrupted");
  assert.equal((await restoredHost.call('subagent_inspect', { jobId: completed.jobId, output: true, timeout: 0 })).output, "Result to keep\n");
  assert.equal(restoredJobs.length, 2);
  assert.equal(restoredJobs.every((item: any) => item.pendingRequests === 0), true);
});

test("Unix process-group cancellation kills tool descendants even if they ignore TERM", { skip: process.platform === "win32", timeout: 30000 }, async (t) => {
  const host = await protocolHost(); t.after(() => host.close());
  const pidFile = join(host.root, 'shell.pid');
  const job = await host.call('subagent_spawn', { task: `TEST CALL bash ${JSON.stringify({ command: `echo $$ > ${pidFile}; trap '' TERM; sleep 45` })}`, tools: ['bash'] });
  let pid = NaN;
  for (let attempt = 0; attempt < 300 && !Number.isSafeInteger(pid); attempt++) { try { pid = Number(await readFile(pidFile, 'utf8')); } catch { await delay(20); } }
  assert.ok(Number.isSafeInteger(pid) && pid > 0);
  process.kill(pid, 0);
  await host.call('subagent_cancel', { jobId: job.jobId });
  let gone = false;
  for (let attempt = 0; attempt < 30; attempt++) {
    try { process.kill(pid, 0); } catch { gone = true; break; }
    try { if (/\) Z /.test(await readFile(`/proc/${pid}/stat`, "utf8"))) { gone = true; break; } } catch { gone = true; break; }
    await delay(20);
  }
  assert.equal(gone, true);
  assert.equal(activeJobs(host), 0);
});

test("the panel label is one bounded line of the spawn task and restore sanitizes foreign text", { timeout: 20000 }, async (t) => {
  const host = await protocolHost({ cli: fixture }); t.after(() => host.close());
  const dirty = `第一行\n第二行\u0007\u001b[31m红\u001b[0m ${"长".repeat(120)}`;
  const job = await host.call('subagent_spawn', { task: dirty });
  const stored = saved(host).find((item: any) => item.id === job.jobId)!;
  assert.match(stored.label, /^第一行 第二行红/);
  assert.doesNotMatch(stored.label, /[\r\n\u0007\u001b]|\[31m|\[0m/);
  assert.equal(stored.label.length, 80);
  assert.equal("label" in (await host.call('subagent_inspect', { jobId: job.jobId })).jobs[0], false);
  assert.equal((await host.call('subagent_inspect', { jobId: job.jobId, output: true, timeout: 0 })).label, stored.label);
  await host.call('subagent_cancel', { jobId: job.jobId });
  await host.restore([{ ...stored, label: '跨行\n\u001b[32m标签' }]);
  assert.equal((await host.call('subagent_inspect', { jobId: job.jobId, output: true, timeout: 0 })).label, '跨行 标签');
  const { label: _dropped, ...withoutLabel } = stored;
  await host.restore([withoutLabel]);
  assert.equal('label' in (await host.call('subagent_inspect', { jobId: job.jobId, output: true, timeout: 0 })), false);
});

test("profile instructions reach the child process through the environment exactly once", { timeout: 25000 }, async (t) => {
  const host = await protocolHost(); t.after(() => host.close());
  await host.profiles([{ name: 'browser', model: { provider: 'dag-test', id: 'scripted' }, instructions: 'Stay read-only unless the task says otherwise.' }]);
  const job = await host.call('subagent_spawn', { task: 'Profile guidance probe', profile: 'browser' });
  const result = await host.call('subagent_inspect', { jobId: job.jobId, output: true, until: 'finish', timeout: 10 });
  assert.equal(result.status, 'completed');
  const logged = await readFile(host.log, 'utf8');
  assert.equal(logged.split('Stay read-only unless the task says otherwise.').length - 1, 1, 'the profile prompt reaches the child exactly once');
  const plain = await host.call('subagent_spawn', { task: 'Plain guidance probe' });
  await host.call('subagent_inspect', { jobId: plain.jobId, output: true, until: 'finish', timeout: 10 });
  assert.doesNotMatch((await readFile(host.log, 'utf8')), /Plain guidance probe[\s\S]*Stay read-only/, 'a profile without instructions inherits no guidance');
});

test("interim reports are counted per job so a bound task can be closed", { timeout: 30000 }, async (t) => {
  const host = await protocolHost({ features: ['todos', 'agents'] }); t.after(() => host.close());
  await host.call('todo', { action: 'create', subject: 'bound work' });
  const reported = await host.call('subagent_spawn', { task: 'CONTROL REPORT HOLD', todoId: 1, tools: ['bash'] });
  const version = (await host.call('subagent_inspect', { jobId: reported.jobId })).jobs[0].reportVersion;
  const pending = await host.call('subagent_inspect', { jobId: reported.jobId, output: true, until: 'update', after: version, timeout: 10 });
  assert.match(pending.output, /CONTROL-PROGRESS/);
  await host.call('todo', { action: 'update', id: 1, status: 'completed' });
  assert.equal((await host.call('todo', { action: 'get', id: 1 })).tasks[0].status, 'completed');
  await host.call('subagent_send', { recipient: reported.jobId, interrupt: true, message: 'stop' });
  const silent = await host.call('subagent_spawn', { task: 'SILENT' });
  const silentResult = await host.call('subagent_inspect', { jobId: silent.jobId, output: true, until: 'finish', timeout: 10 });
  assert.equal(silentResult.status, 'completed');
  assert.equal(saved(host).filter((item: any) => item.id === silent.jobId)[0]!.taskReportStale, undefined);
});

test("a fragment brief reaches the child process and nothing is sent when unset", { timeout: 30000 }, async (t) => {
  const host = await protocolHost({ features: ['todos', 'agents'] }); t.after(() => host.close());
  await host.call('todo', { action: 'create', subject: 'Fragment producer', description: 'FRAGMENT-CONTEXT-MARKER' });
  const briefed = await host.call('subagent_spawn', { task: 'Briefed probe', todoId: 1, context: true });
  await host.call('subagent_inspect', { jobId: briefed.jobId, output: true, until: 'finish', timeout: 10 });
  assert.match(await readFile(host.log, 'utf8'), /FRAGMENT-CONTEXT-MARKER/, 'a declared fragment brief reaches the child');
  await host.call('todo', { action: 'create', subject: 'Plain consumer', description: 'UNSELECTED-BRIEF' });
  const plain = await host.call('subagent_spawn', { task: 'Plain context probe', todoId: 2 });
  await host.call('subagent_inspect', { jobId: plain.jobId, output: true, until: 'finish', timeout: 10 });
  const logged = await readFile(host.log, 'utf8');
  assert.doesNotMatch(logged.slice(logged.lastIndexOf('Plain context probe')), /UNSELECTED-BRIEF/, 'no fragment brief is sent when unset');
});
}

{
const offline = fileURLToPath(new URL('./fixtures/offline-model.ts', import.meta.url));
async function call(client: IsolatedClient, name: string, params: object) {
  const events = await client.prompt(`TEST CALL ${name} ${JSON.stringify(params)}`);
  const event = events.find((item) => item.type === 'tool_execution_end' && item.toolName === name)!;
  assert.ok(event, `${name} must have executed`);
  assert.ok(!event.isError && !(event.result as any).isError, JSON.stringify(event.result));
  return (event.result as any).details;
}
const savedJobs = (entries: any[]) => retainedJobs(entries).records as any[];

test('real Pi: fragment reset invalidates every reopened task report and redispatch creates fresh evidence', { timeout: 30000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dag-report-reset-'));
  const dir = join(root, 'agent', 'pi-dag-workflow');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'pi-dag-workflow-preset.json'), JSON.stringify({ presets: [{ name: 'check', steps: [{ key: 'a', subject: 'first check' }, { key: 'b', subject: 'second check', after: ['a'] }] }] }));
  const client = await IsolatedClient.start(root, 'report-reset', [], ['--dag-workflow-test-child-provider', offline]);
  t.after(() => client.close());
  await call(client, 'todo', { action: 'apply', preset: 'check' });
  const ids: string[] = [];
  for (const todoId of [1, 2]) {
    const spawned = await call(client, 'subagent_spawn', { task: 'Offline retained evidence', todoId });
    ids.push(spawned.jobId);
    const result = await call(client, 'subagent_inspect', { jobId: spawned.jobId, output: true });
    assert.equal(result.status, 'completed');
    await call(client, 'todo', { action: 'update', id: todoId, status: 'completed' });
  }
  await call(client, 'todo', { action: 'reset', preset: 'check', step: 'a' });
  const historical = savedJobs(await client.entries() as any[]);
  for (const id of ids) {
    const job = historical.find((job) => job.id === id)!;
    assert.equal(job.taskReportStale, true, 'root and downstream evidence both belong to the prior attempt');
    assert.ok(job.output.length > 0, 'reset does not delete historical output');
  }
  const fresh = await call(client, 'subagent_spawn', { task: 'Fresh offline evidence', todoId: 1 });
  await call(client, 'subagent_inspect', { jobId: fresh.jobId, output: true });
  const jobs = savedJobs(await client.entries() as any[]);
  assert.equal(jobs.find((job) => job.id === fresh.jobId).taskReportStale, undefined);
  assert.equal(jobs.find((job) => job.id === ids[0]).taskReportStale, true);
});
}

{
test('real Pi: unavailable child tool is rejected before interruption, preserving the question and queued direction', { timeout: 30000 }, async (t) => {
  const host = await protocolHost(); t.after(() => host.close());
  const hiddenWrite = join(host.root, 'hidden-write.ts');
  await writeFile(hiddenWrite, `export default function(pi) { pi.registerTool({ name: 'write', label: 'Test unavailable tool', description: 'Test only', exposure: 'hidden', parameters: { type: 'object', properties: {} }, async execute() { throw Error('must not execute'); } }); }`);
  await writeFile(join(host.directory, 'pi-dag-workflow-profile.json'), JSON.stringify({ profiles: [{ name: 'hidden', childExtensions: [hiddenWrite] }] }));
  const job = await host.call('subagent_spawn', { profile: 'hidden', task: 'CONTROL QUESTION', tools: ['read'] });
  const waiting = await host.call('subagent_inspect', { jobId: job.jobId, output: true, until: 'update', timeout: 10 });
  assert.equal(waiting.status, 'waiting'); const question = waiting.requests[0]!;
  await host.call('subagent_send', { recipient: job.jobId, message: 'Queued original direction' });
  const before = (await host.call('subagent_inspect', { jobId: job.jobId })).jobs[0]!;
  const rejected = await host.execute('subagent_send', { recipient: job.jobId, tools: ['read', 'write'], interrupt: true, message: 'MUST-NOT-DELIVER' });
  assert.equal(rejected.isError, true);
  assert.match(rejected.content[0].text, /unavailable.*write/i);
  assert.equal(rejected.details.stage, 'preflight'); assert.equal(rejected.details.status, 'waiting');
  assert.equal(rejected.details.interrupted, false); assert.equal(rejected.details.queueCleared, false);
  assert.equal(rejected.details.questionsCleared, false); assert.equal(rejected.details.directionDelivery, 'not_sent');
  const after = (await host.call('subagent_inspect', { jobId: job.jobId })).jobs[0]!;
  assert.equal(after.status, 'waiting'); assert.equal(after.questions[0]!.requestId, question.requestId);
  assert.equal(after.pendingMessages, before.pendingMessages); assert.deepEqual(after.tools, ['read']);
  assert.equal(after.taskReportStale, undefined); assert.equal(activeJobs(host), 1);
  await host.call('subagent_send', { requestId: question.requestId, message: 'Answer original question' });
  const result = await host.call('subagent_inspect', { jobId: job.jobId, output: true, until: 'finish', timeout: 10 });
  assert.equal(result.status, 'completed'); assert.doesNotMatch(result.output, /MUST-NOT-DELIVER/);
});

test('tool boundaries are self-describing and inherited omissions are reported only when used', { timeout: 20000 }, async (t) => {
  const host = await protocolHost({ activeTools: () => ['read', 'ffgrep', 'recall'], tools: () => ['read', 'grep', 'find', 'ls', 'write'].map(name => ({ name, sourceInfo: { path: `builtin:${name}` } })) }); t.after(() => host.close());
  const untrusted = await host.execute('subagent_spawn', { task: 'Short explicit assignment', tools: ['ffgrep'] });
  assert.equal(untrusted.isError, true);
  assert.match(untrusted.content[0].text, /Allowed: read, grep, find, ls, write; discover with subagent_inspect tools:true/);
  const job = await host.call('subagent_spawn', { task: 'Short inherited assignment' });
  const inherited = (await host.call('subagent_inspect', { jobId: job.jobId })).jobs[0];
  assert.deepEqual(inherited.ignoredInheritedTools, ['ffgrep', 'recall']);
  const explicit = await host.call('subagent_spawn', { task: 'Short explicit assignment', tools: ['read'] });
  assert.equal((await host.call('subagent_inspect', { jobId: explicit.jobId })).jobs[0].ignoredInheritedTools, undefined);
});
}

{
async function files() {
  const root = await mkdtemp(join(tmpdir(), 'dag-skill-files-'));
  await mkdir(join(root, 'selected'));
  await writeFile(join(root, 'selected', 'SKILL.md'), '# Local skill\nRead only the assigned inputs.\n');
  await writeFile(join(root, 'empty.md'), '');
  await writeFile(join(root, 'large.md'), 'x'.repeat(65537));
  await writeFile(join(root, 'not-markdown.txt'), 'not a skill');
  return root;
}

test('a real child does not inherit unselected guidance or bootstrap environment fields', { timeout: 25000 }, async (t) => {
  const keys = ['PI_DAG_AGENT_PROFILE_PROMPT', 'PI_DAG_AGENT_CONTEXT', 'PI_DAG_AGENT_MODEL_BOOTSTRAP'] as const;
  const saved = keys.map((key) => [key, process.env[key]] as const);
  Object.assign(process.env, { PI_DAG_AGENT_PROFILE_PROMPT: 'UNSELECTED-PROFILE', PI_DAG_AGENT_CONTEXT: 'UNSELECTED-BRIEF', PI_DAG_AGENT_MODEL_BOOTSTRAP: 'unselected-invalid-bootstrap' });
  const host = await protocolHost(); t.after(async () => { await host.close(); for (const [key, value] of saved) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
  const child = await host.call('subagent_spawn', { task: 'Plain child probe' });
  const result = await host.call('subagent_inspect', { jobId: child.jobId, output: true, until: 'finish', timeout: 10 });
  assert.equal(result.status, 'completed', JSON.stringify(result));
  assert.doesNotMatch(await readFile(host.log, 'utf8'), /UNSELECTED-PROFILE|UNSELECTED-BRIEF|unselected-invalid-bootstrap/);
});

test('resumed work selects current Profile skills with an explicit read-only tool override', { timeout: 30000 }, async (t) => {
  const host = await protocolHost(); t.after(() => host.close());
  await writeFile(join(host.root, 'other.md'), '# CURRENT-RESUME-SKILL\n');
  await mkdir(join(host.root, 'selected'), { recursive: true });
  await writeFile(join(host.root, 'selected', 'SKILL.md'), '# Local selected skill\n');
  await host.profiles([{ name: 'reader', model: { provider: 'dag-test', id: 'scripted' }, tools: ['read'], skills: ['selected/SKILL.md'] }, { name: 'other', model: { provider: 'dag-test', id: 'scripted' }, tools: ['read'], skills: ['other.md'] }]);
  const first = await host.call('subagent_spawn', { task: 'First skill probe', profile: 'reader' });
  assert.equal((await host.call('subagent_inspect', { jobId: first.jobId, output: true, until: 'finish', timeout: 10 })).status, 'completed');
  const resumed = await host.call('subagent_spawn', { task: 'TEST SELECTED SKILL', profile: 'other', tools: ['read'], resumeFrom: first.jobId });
  const result = await host.call('subagent_inspect', { jobId: resumed.jobId, output: true, until: 'finish', timeout: 10 });
  assert.equal(result.status, 'completed'); assert.deepEqual(result.tools, ['read']); assert.match(result.output, /CURRENT-RESUME-SKILL/);
  const records = (await readFile(host.log, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
  const current = records.find((entry) => entry.type === 'input' && JSON.stringify(entry.context).includes('Resume attempt from'));
  assert.ok(JSON.stringify(current.context).includes(join(host.root, 'other.md')));
  assert.doesNotMatch(JSON.stringify(current.context), /selected\/SKILL/);
});

test('a rejected skill cannot fork a process, claim a Todo or leave an occupied slot', { timeout: 20000 }, async (t) => {
  const root = await files();
  const host = await protocolHost({ root, features: ['todos', 'agents'] }); t.after(async () => { await host.close(); await rm(root, { recursive: true, force: true }); });
  await host.call('todo', { action: 'create', subject: 'bounded work' });
  await host.profiles([{ name: 'missing', skills: ['does-not-exist.md'], tools: ['read'] }]);
  const job = await host.execute('subagent_spawn', { profile: 'missing', task: 'bounded work', todoId: 1 });
  assert.equal(job.isError, true);
  assert.match(job.content[0].text, /Skill entry 1/);
  assert.doesNotMatch(JSON.parse(job.content[0].text).failure.reason, /does-not-exist\.md/);
  assert.equal(activeJobs(host), 0);
  assert.equal((await host.call('todo', { action: 'get', id: 1 })).tasks[0].status, 'pending');
});
}

{
test('actual Pi: explicit Agent resume works without a current Goal but never bypasses a paused Goal', { timeout: 30000 }, async (t) => {
  const client = await IsolatedClient.start(); t.after(() => client.close());
  await client.prompt('TEST CALL goal {"action":"create","title":"完成测试","maxTurns":2}');
  await client.prompt('TEST CALL goal {"action":"enable","id":1}');
  let events = await client.prompt('/agents resume');
  assert.ok(events.some((event) => event.method === 'notify' && String(event.message).includes('后续新结果')));
  assert.ok(!events.some((event) => event.type === 'agent_start'));
  await client.prompt('TEST CALL goal {"action":"create","title":"暂停测试","maxTurns":1}');
  await client.prompt('TEST CALL goal {"action":"enable","id":2}');
  events = await client.prompt('/agents resume');
  assert.ok(events.some((event) => event.method === 'notify' && String(event.message).includes('先明确 /goal enable')));
  const entries = await client.entries() as any[];
  const goal = entries.findLast((entry) => entry.customType === 'pi-dag-workflow.goal').data;
  assert.equal(goal.run.paused, true); assert.equal(goal.run.used, 1);
});
}

{
test('protocol activity tracks parallel tools and clears on terminal/restore without persisting deltas', { timeout: 30000 }, async (t) => {
  const fixture = fileURLToPath(new URL('./fixtures/m2-rpc-fixture.mjs', import.meta.url));
  const host = await protocolHost({ cli: fixture });
  let restoredHost: any;
  t.after(async () => { await restoredHost?.close(); await host.close(); });
  host.ctx.hasUI = true; host.ctx.mode = 'tui';
  let paints = 0;
  host.ctx.ui.setWidget = () => { paints++; };
  const invalid = await host.execute('subagent_spawn', { task: 'HOLD', timeout: 0 });
  assert.equal(invalid.isError, true); assert.match(invalid.content[0].text, /timeout/);
  const job = await host.call('subagent_spawn', { task: 'ACTIVITY STEPPED' });
  const inspect = async () => (await host.call('subagent_inspect', { jobId: job.jobId })).jobs[0];
  const waitFor = async (predicate: (value: any) => boolean) => {
    const deadline = Date.now() + 4000;
    for (;;) { const value = await inspect(); if (predicate(value)) return value; if (Date.now() > deadline) throw new Error('public activity phase not observed'); await delay(2); }
  };
  const advance = () => host.call('subagent_send', { recipient: job.jobId, message: 'ACTIVITY ADVANCE' });
  assert.equal((await waitFor(value => value.phase === 'thinking')).phase, 'thinking');
  await advance(); assert.equal((await inspect()).phase, 'output');
  await advance(); assert.equal((await inspect()).activeTools[0].tool, 'very_long_tool_name');
  await advance(); const parallel = await inspect();
  assert.deepEqual(parallel.activeTools.map((tool: any) => tool.tool), ['very_long_tool_name', 'read']);
  await advance(); assert.deepEqual((await inspect()).activeTools.map((tool: any) => tool.tool), ['read']);
  await advance(); assert.equal((await inspect()).phase, 'tool', 'text output cannot replace a still-active parallel tool');
  assert.ok(paints > 0, 'live activity repaints the widget while a tool runs');
  await advance();
  await host.call('subagent_inspect', { jobId: job.jobId, output: true, until: 'finish', timeout: 5 });
  const afterRun = paints; await delay(1200);
  assert.equal(paints, afterRun, 'completion stops the periodic activity refresh');
  assert.equal((await host.call('subagent_inspect', { jobId: job.jobId })).jobs[0].status, 'completed');
  assert.equal(saved(host).some((item: any) => 'activity' in item || 'since' in item), false, 'activity is never persisted');
  assert.equal((await inspect()).activeTools.length, 0);
  assert.ok(host.entries.filter(entry => entry.customType === AGENTS_TYPE).length <= 5, 'streaming activity must not append durable snapshots');
  const pending = await host.call('subagent_spawn', { task: 'HOLD' });
  restoredHost = await protocolHost({ cli: fixture, entries: host.entries });
  const restoredJobs = (await restoredHost.call('subagent_inspect', {})).jobs;
  assert.equal(restoredJobs.find((item: any) => item.id === pending.jobId)!.status, 'interrupted');
  assert.equal(restoredJobs.filter((item: any) => ['starting', 'running', 'waiting'].includes(item.status)).length, 0);
  const next = await restoredHost.call('subagent_spawn', { task: 'available after cancelled navigation' });
  assert.equal((await restoredHost.call('subagent_inspect', { jobId: next.jobId, output: true, until: 'finish', timeout: 5 })).status, 'completed');
});
}

{
test("builtin model bootstrap uses in-memory credentials with a real loopback provider, no auth files", { timeout: 30000 }, async (t) => {
  const host = await protocolHost({ childProvider: false });
  t.after(() => host.close());
  let requests = 0; let authorization: string | undefined;
  const server = createServer((request, response) => {
    requests++; authorization = request.headers.authorization;
    request.resume();
    request.on("end", () => {
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      const chunk = { id: "m2-response", object: "chat.completion.chunk", created: 1, model: "m2-local", choices: [{ index: 0, delta: { role: "assistant", content: "Loopback bootstrap succeeded" }, finish_reason: null }] };
      response.write(`data: ${JSON.stringify(chunk)}\n\n`);
      response.write(`data: ${JSON.stringify({ ...chunk, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`);
      response.end("data: [DONE]\n\n");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const ref = { provider: "dag-test", id: "scripted" };
  const definition = { ...ref, name: "Local deterministic test", api: "openai-completions", baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 65536, maxTokens: 1024 };
  host.ctx.modelRegistry.find = () => definition;
  host.ctx.modelRegistry.getApiKeyAndHeaders = async () => ({ ok: true, apiKey: "m2-secret-never-on-disk" });
  const job = await host.call('subagent_spawn', { task: "Return the test response." });
  const result = await host.call('subagent_inspect', { jobId: job.jobId, output: true, until: 'finish', timeout: 20 });
  assert.equal(result.status, "completed", result.output);
  assert.match(result.output, /Loopback bootstrap succeeded/);
  assert.equal(requests, 1);
  assert.equal(authorization, "Bearer m2-secret-never-on-disk");
  assert.doesNotMatch(JSON.stringify(saved(host)), /m2-secret/);
  async function scan(path: string): Promise<void> {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const file = join(path, entry.name);
      if (entry.isDirectory()) await scan(file);
      else assert.doesNotMatch(await readFile(file, "utf8"), /m2-secret-never-on-disk/);
    }
  }
  await scan(host.root);
});

test("cancelling during model bootstrap never creates a process when callback resolves later", { timeout: 20000 }, async (t) => {
  const host = await protocolHost({ childProvider: false });
  t.after(() => host.close());
  let release!: (value: any) => void;
  const deferred = new Promise<any>((resolve) => { release = resolve; });
  host.ctx.modelRegistry.find = () => ({ provider: 'dag-test', id: 'scripted', reasoning: false, api: 'dag-test-api' });
  host.ctx.modelRegistry.getApiKeyAndHeaders = () => deferred;
  const spawn = host.execute('subagent_spawn', { task: "Bootstrap still pending" });
  let id = '';
  for (let attempt = 0; attempt < 200 && !id; attempt++) { const jobs = saved(host); if (jobs[0]) id = jobs[0].id; else await delay(5); }
  assert.ok(id, 'the starting job is observable before bootstrap resolves');
  await host.call('subagent_cancel', { jobId: id });
  assert.equal(activeJobs(host), 0);
  release({ ok: true, apiKey: 'x' });
  const result = await spawn;
  assert.equal(result.isError, true);
  assert.equal(saved(host)[0].status, 'cancelled');
});
}

// ticket56: the shared harness for these regressions.
const rpcFixture = fileURLToPath(new URL('./fixtures/m2-rpc-fixture.mjs', import.meta.url));
const waitTerminal = async (host: any, jobId: string) => {
  for (let attempt = 0; attempt < 300; attempt++) {
    const summary = (await host.call('subagent_inspect', { jobId })).jobs[0];
    if (summary.status === 'completed' || summary.status === 'failed') return summary;
    await delay(10);
  }
  throw new Error(`job ${jobId} never reached a terminal status`);
};

// A terminal attempt with nothing to read is delivered, not permanently pending.
{
test('ticket56 a blank finished attempt is delivered and labelled as having no report', { timeout: 20000 }, async (t) => {
  const host = await protocolHost({ cli: rpcFixture, language: 'zh-CN' }); t.after(() => host.close());
  const job = await host.call('subagent_spawn', { task: 'BLANK' });
  const summary = await waitTerminal(host, job.jobId);
  assert.equal(summary.status, 'completed', 'the child really finished normally');
  assert.equal(summary.reportDelivery, 'delivered', 'nothing to deliver, so it does not stay pending');
  assert.equal(summary.reportEmpty, true, 'and the record says why');
  const stored = saved(host).find((item: any) => item.id === job.jobId)!;
  assert.equal(stored.reportDelivery, 'delivered', 'the persisted record agrees');
  assert.equal(stored.reportEmpty, true);
  // The one hint the parent sees instead of an empty completion notice.
  const boundary: any = await host.emit('turn_end', { outcome: 'completed', entries: [] });
  const delivered = (boundary?.entries ?? []).map((entry: any) => entry.content).join('\n');
  assert.match(delivered, /已结束·无报告/, `the batch carries the hint instead of an empty report: ${delivered}`);
});

test('ticket56 a real report still waits for delivery and keeps its record protected', { timeout: 20000 }, async (t) => {
  const host = await protocolHost({ cli: rpcFixture, language: 'zh-CN' }); t.after(() => host.close());
  const job = await host.call('subagent_spawn', { task: 'plain result' });
  const summary = await waitTerminal(host, job.jobId);
  assert.equal(summary.reportDelivery, 'pending', 'readable output stays pending');
  assert.equal(summary.reportEmpty, undefined, 'and is not marked empty');
  assert.equal(saved(host).find((item: any) => item.id === job.jobId)!.reportDelivery, 'pending');
});

test('ticket56 a failed attempt keeps its diagnostic instead of reading as an empty report', { timeout: 20000 }, async (t) => {
  const host = await protocolHost({ cli: rpcFixture, language: 'zh-CN' }); t.after(() => host.close());
  const job = await host.call('subagent_spawn', { task: 'ERROR' });
  const summary = await waitTerminal(host, job.jobId);
  assert.equal(summary.status, 'failed');
  assert.equal(summary.reportEmpty, undefined, 'the failure diagnostic is content, not an empty report');
  assert.equal(summary.reportDelivery, 'pending', 'so the failure report still waits to be read');
});

test('ticket56 a blank report never completes the bound Todo', { timeout: 20000 }, async (t) => {
  const host = await protocolHost({ cli: rpcFixture, features: ['todos', 'agents'], language: 'zh-CN' });
  t.after(() => host.close());
  const created = await host.call('todo', { action: 'create', subject: '验证空报告' });
  const todoId = (created.details?.tasks ?? [])[0]?.id ?? 1;
  const job = await host.call('subagent_spawn', { task: 'BLANK', todoId });
  const summary = await waitTerminal(host, job.jobId);
  assert.equal(summary.reportDelivery, 'delivered');
  // The empty-report notice reaches the parent at a turn boundary, carrying no acceptance.
  await host.emit('turn_end', { outcome: 'completed', entries: [] });
  const tasks = host.state().tasks;
  assert.notEqual(tasks.find((task: any) => task.id === todoId)!.status, 'completed', 'acceptance stays with the parent: the empty report completed nothing');
});

test('ticket56 earlier output in the same job is not the current attempt report', { timeout: 25000 }, async (t) => {
  const host = await protocolHost({ cli: rpcFixture, language: 'zh-CN' }); t.after(() => host.close());
  const job = await host.call('subagent_spawn', { task: 'WAIT DIRECTION' });
  // First attempt produced text; a direction then starts a real second attempt that reports nothing.
  for (let attempt = 0; attempt < 200; attempt++) { if ((await host.call('subagent_inspect', { jobId: job.jobId, output: true, timeout: 0 })).output.includes('earlier attempt output')) break; await delay(10); }
  // An interrupting direction is what retires the old attempt: outputStart moves past it.
  await host.call('subagent_send', { recipient: job.jobId, message: 'QUIET', interrupt: true });
  for (let attempt = 0; attempt < 300; attempt++) { if ((await host.call('subagent_inspect', { jobId: job.jobId })).jobs[0].status === 'completed') break; await delay(10); }
  const summary = (await host.call('subagent_inspect', { jobId: job.jobId })).jobs[0];
  assert.equal(summary.status, 'completed');
  assert.equal(summary.reportEmpty, true, 'the old attempt text is history, not this report');
  assert.equal(summary.reportDelivery, 'delivered');
});

test('ticket56 a restored blank pending record leaves the default rows and a readable one keeps its place', { timeout: 20000 }, async (t) => {
  const host = await protocolHost({ entries: [{ type: 'custom', customType: AGENTS_TYPE, data: { version: 1, jobs: [
    { id: 'a1', profile: 'p', model: { provider: 'fixture', id: 'scripted' }, thinking: 'off', tools: [], status: 'completed', startedAt: 1, endedAt: 2, output: '   \n', reportDelivery: 'pending', reportVersion: 1 },
    { id: 'a2', profile: 'p', model: { provider: 'fixture', id: 'scripted' }, thinking: 'off', tools: [], status: 'completed', startedAt: 3, endedAt: 4, output: 'real report\n', reportDelivery: 'pending', reportVersion: 1 },
  ] } }] });
  t.after(() => host.close());
  const blank = (await host.call('subagent_inspect', { jobId: 'a1' })).jobs[0];
  const readable = (await host.call('subagent_inspect', { jobId: 'a2' })).jobs[0];
  assert.equal(blank.reportDelivery, 'delivered', 'a legacy blank report does not stay in the default rows');
  assert.equal(blank.reportEmpty, true);
  assert.equal(readable.reportDelivery, 'pending', 'a non-empty undelivered report keeps its protection');
  assert.equal(readable.reportEmpty, undefined);
});
}

// ticket56 (Round 76): an unread failure is protected even with an empty body, and a blank report
// event is not a report.
{
test('ticket56 a live deadline failure stays unread and keeps the bound Todo and record', { timeout: 30000 }, async (t) => {
  const host = await protocolHost({ cli: rpcFixture, features: ['todos', 'agents'], language: 'zh-CN' });
  t.after(() => host.close());
  const created = await host.call('todo', { action: 'create', subject: '截止时间失败' });
  const todoId = (created.details?.tasks ?? [])[0]?.id ?? 1;
  // The child never finishes; the native deadline fires with only an `error`, no diagnostic body.
  const job = await host.call('subagent_spawn', { task: 'HOLD', todoId, timeout: 0.4 });
  const summary = await waitTerminal(host, job.jobId);
  assert.equal(summary.status, 'failed', 'the deadline failed the job');
  assert.match(String(summary.error), /deadline/, 'the diagnostic is on the summary');
  assert.equal(summary.reportDelivery, 'pending', `an unread failure keeps its delivery debt: ${JSON.stringify(summary)}`);
  assert.equal(summary.reportEmpty, undefined, 'and it is not an empty report');
  // Unread: cleanup must not take the bound task or the record away.
  const kept = await host.call('todo', { action: 'clear', scope: 'closed' });
  assert.equal(kept.isError, undefined);
  assert.equal(host.state().tasks.some((task: any) => task.id === todoId), true, 'the bound task survives an unread failure');
  assert.equal(host.jobs().some((item: any) => item.id === job.jobId), true, 'and so does the Job record');
  // Reading the report acknowledges it; from then on the ordinary rules apply.
  const read = await host.call('subagent_inspect', { jobId: job.jobId, output: true, timeout: 0 });
  assert.equal(read.reportDelivery, 'delivered');
  await host.call('todo', { action: 'clear', scope: 'closed' });
  assert.equal(host.state().tasks.some((task: any) => task.id === todoId), false, 'once delivered, the failure is cleaned like any closed record');
});

test('ticket56 a restored failed record with an empty body keeps its debt, while delivered and legacy ones do not', { timeout: 20000 }, async (t) => {
  const state = { version: 1, tasks: [{ id: 1, subject: '绑定任务', status: 'in_progress', blockedBy: [] }], nextId: 2, plan: false, planTools: [], visible: true, view: 'list', treeStyle: 'paths' };
  const record = (id: string, extra: Record<string, unknown>) => ({ id, profile: 'p', model: { provider: 'fixture', id: 'scripted' }, thinking: 'off', tools: [], status: 'failed', startedAt: 1, endedAt: 2, output: '', error: 'Agent deadline exceeded', ...extra });
  const host = await protocolHost({ features: ['todos', 'agents'], language: 'zh-CN', entries: [
    { type: 'custom', customType: 'pi-dag-workflow.state', data: state },
    { type: 'custom', customType: AGENTS_TYPE, data: { version: 1, jobs: [
      record('a1', { todoId: 1, reportDelivery: 'pending' }),
      record('a2', { reportDelivery: 'delivered' }),
      record('a3', {}),
    ] } },
  ] });
  t.after(() => host.close());
  const pending = (await host.call('subagent_inspect', { jobId: 'a1' })).jobs[0];
  assert.equal(pending.reportDelivery, 'pending', 'a restored blank failure keeps its unread state');
  assert.equal(pending.reportEmpty, undefined, 'and is not marked as an empty report');
  assert.equal((await host.call('subagent_inspect', { jobId: 'a2' })).jobs[0].reportDelivery, 'delivered', 'an already delivered failure is not resurrected as debt');
  assert.equal((await host.call('subagent_inspect', { jobId: 'a3' })).jobs[0].reportDelivery, undefined, 'and no record invents a debt it never had');
  const kept = await host.call('todo', { action: 'clear', scope: 'closed' });
  assert.equal(kept.isError, undefined);
  assert.equal(host.state().tasks.some((task: any) => task.id === 1), true, 'the unread failure protects its bound task');
  assert.equal(host.jobs().some((item: any) => item.id === 'a1'), true, 'and its record');
});

test('ticket56 a blank report event is not a report', { timeout: 20000 }, async (t) => {
  const host = await protocolHost({ cli: rpcFixture, language: 'zh-CN' }); t.after(() => host.close());
  const job = await host.call('subagent_spawn', { task: 'BLANK NOTICE' });
  const summary = await waitTerminal(host, job.jobId);
  assert.equal(summary.status, 'completed');
  assert.equal(summary.reportEmpty, true, `a whitespace-only notify is protocol decoration, not a body: ${JSON.stringify(summary)}`);
  assert.equal(summary.reportDelivery, 'delivered');
});

test('ticket56 a real report event with a blank final message is still a report', { timeout: 20000 }, async (t) => {
  const host = await protocolHost({ cli: rpcFixture, language: 'zh-CN' }); t.after(() => host.close());
  const job = await host.call('subagent_spawn', { task: 'REAL NOTICE' });
  const summary = await waitTerminal(host, job.jobId);
  assert.equal(summary.status, 'completed');
  assert.equal(summary.reportEmpty, undefined, 'the notify carried real text');
  assert.equal(summary.reportDelivery, 'pending', 'so it still waits to be read');
  const output = await host.call('subagent_inspect', { jobId: job.jobId, output: true, timeout: 0 });
  assert.match(String(output.output), /verified the change/, 'and the text is in the record');
});
}

// ticket66: the Profile panel edits the four user-owned fields and can create a minimal Profile.
test('ticket66 a Profile panel edits model, thinking, tools and isolate and creates a minimal Profile', { timeout: 20000 }, async t => {
  const host = await protocolHost({ features: ['agents'], language: 'zh-CN' }); t.after(() => host.close());
  await host.profiles([{ name: 'review', model: { provider: 'dag-test', id: 'reasoned' }, instructions: 'keep me' }]);
  host.ctx.hasUI = true; host.ctx.mode = 'tui'; host.ctx.ui.theme = { style: (text: string) => text, fg: (_color: string, text: string) => text };
  const panels = recordPanels(host.ctx);
  const file = join(host.directory, 'pi-dag-workflow-profile.json');
  const profiles = async (): Promise<any[]> => JSON.parse(await readFile(file, 'utf8')).profiles;
  const until = async (predicate: () => Promise<boolean>, what: string) => {
    for (let attempt = 0; attempt < 400; attempt += 1) { if (await predicate()) return; await delay(10); }
    throw new Error(`timed out waiting for ${what}: ${JSON.stringify(host.notifications.slice(-3))}`);
  };
  const review = async () => (await profiles()).find(profile => profile.name === 'review');
  host.commands.get('agents').handler('', host.ctx);
  await panels.wait(() => panels.live() === 1);
  const type = async (text: string, waitForSave = true) => {
    const paints = panels.forces.length;
    await panels.press('\x01'); await panels.press('\x0b'); for (const char of text) await panels.press(char); await panels.press('\r');
    // A changed file is visible before the menu finishes its async reload. Wait for choose's forced
    // redraw (the input gate is open again), not merely for the write, before navigating to the next field.
    if (waitForSave) await panels.wait(() => panels.forces.slice(paints).some(Boolean));
  };
  await panels.focus('review'); await panels.press('l');
  // Model: the id keeps its own slashes; only the first slash separates provider from id.
  await panels.focus('模型'); await panels.press('\r'); await type('dag-test/family/reasoned');
  await until(async () => (await review())?.model?.id === 'family/reasoned', 'the new model');
  assert.deepEqual((await review()).model, { provider: 'dag-test', id: 'family/reasoned' }, 'the model keeps the slashes of its id');
  assert.equal((await review()).instructions, 'keep me', 'the untouched field survives the edit');
  // Thinking: an explicit level.
  await panels.focus('thinking'); await panels.press('\r'); await type('high');
  await until(async () => (await review())?.thinking === 'high', 'the thinking level');
  // Tools: an explicit list, then the empty set, then inherit — three different saved values.
  await panels.focus('工具（tools）');
  assert.match(panels.frame().find(line => /^[ │]*> /.test(line)) ?? '', /继承父会话内置工具/, 'the tools row is the profile field');
  await panels.press('\r'); await type('read,bash');
  await until(async () => Array.isArray((await review())?.tools), 'the tool list');
  assert.deepEqual((await review()).tools, ['read', 'bash']);
  await panels.focus('工具（tools）'); await panels.press('\r'); await type('none');
  await until(async () => (await review())?.tools?.length === 0, 'the empty tool set');
  assert.deepEqual((await review()).tools, [], 'none is the empty set, not inherit');
  await panels.focus('工具（tools）'); await panels.press('\r'); await type('inherit');
  await until(async () => !('tools' in (await review())), 'the inherited tools');
  assert.equal('tools' in (await review()), false, 'inherit removes the field instead of storing []');
  // An unknown model is refused and nothing is written.
  await panels.focus('模型'); await panels.press('\r'); await type('dag-test/not-registered', false);
  await panels.wait(() => /Unknown model|not-registered/.test(panels.frame().join('\n')));
  assert.deepEqual((await review()).model, { provider: 'dag-test', id: 'family/reasoned' }, 'the refused model never reached the file');
  // The menu re-mounts between edits, so its own promise may never settle here; the host teardown in t.after
  // closes the panel instead of waiting on a mount that is already gone.
  panels.finish();
});

test('ticket66 a new Profile inherits everything and never silently overwrites an existing one', { timeout: 20000 }, async t => {
  const host = await protocolHost({ features: ['agents'], language: 'zh-CN' }); t.after(() => host.close());
  await host.profiles([{ name: 'review', model: { provider: 'dag-test', id: 'reasoned' }, thinking: 'high', tools: ['read'], instructions: 'keep me' }]);
  host.ctx.hasUI = true; host.ctx.mode = 'tui'; host.ctx.ui.theme = { style: (text: string) => text, fg: (_color: string, text: string) => text, bold: (text: string) => text };
  const panels = recordPanels(host.ctx);
  const file = join(host.directory, 'pi-dag-workflow-profile.json');
  const profiles = async (): Promise<any[]> => JSON.parse(await readFile(file, 'utf8')).profiles;
  const until = async (predicate: () => Promise<boolean>, what: string) => {
    for (let attempt = 0; attempt < 300; attempt += 1) { if (await predicate()) return; await delay(10); }
    throw new Error(`timed out waiting for ${what}: ${JSON.stringify(host.notifications.slice(-2))}`);
  };
  host.commands.get('agents').handler('', host.ctx);
  await panels.wait(() => panels.live() === 1);
  const type = async (text: string) => { await panels.press('\x01'); await panels.press('\x0b'); for (const char of text) await panels.press(char); await panels.press('\r'); };
  // Isolate is a toggle on the same saved Profile; a fresh panel is used so the row is on a known page.
  const review = async () => (await profiles()).find(profile => profile.name === 'review');
  await panels.focus('review'); await panels.press('l');
  await panels.focus('隔离'); await panels.press('\r');
  await until(async () => (await review())?.isolate === true, 'the isolate flag');
  assert.equal((await review()).isolate, true, 'the toggle is saved on the profile');
  // A brand-new name: only the name is written, everything else is inherited.
  await panels.focus('新建 Profile'); await panels.press('\r'); await type('fresh');
  await until(async () => (await profiles()).some(profile => profile.name === 'fresh'), 'the new profile');
  assert.deepEqual(Object.keys((await profiles()).find(profile => profile.name === 'fresh')).sort(), ['name'], 'a new Profile starts with nothing but its name');
  // The same name again: `set` would upsert and wipe the saved fields, so the panel refuses instead.
  const before = createHash('sha256').update(await readFile(file)).digest('hex');
  await panels.focus('新建 Profile'); await panels.press('\r'); await type('review');
  await panels.wait(() => /review 已存在/.test(panels.frame().join('\n')));
  assert.equal(createHash('sha256').update(await readFile(file)).digest('hex'), before, 'a duplicate name leaves the file byte-identical');
  assert.deepEqual((await profiles()).find(profile => profile.name === 'review'), { name: 'review', model: { provider: 'dag-test', id: 'reasoned' }, thinking: 'high', tools: ['read'], instructions: 'keep me', isolate: true }, 'the existing Profile keeps every field');
  panels.finish();
});
