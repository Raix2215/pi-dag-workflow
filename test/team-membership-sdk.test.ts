import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Type } from 'typebox';
import { createAssistantMessageEventStream, type AssistantMessage, type Model } from '@earendil-works/pi-ai';
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager, type AgentSession } from '@earendil-works/pi-coding-agent';
import { registerTeam } from '../src/team/commands/register.ts';
import { createTeam, joinTeam, readMember, renameMember, teamsRoot } from '../src/team/io/registry.ts';
import { configPaths } from '../src/shared/config.ts';
import { TEAM_MEMBERSHIP_MESSAGE } from '../src/shared/message-types.ts';

const processPhase = process.env.MEMBERSHIP_TEST_PHASE;
if (processPhase) {
  assert.ok(processPhase === 'seed' || processPhase === 'resume');
  assert.ok(process.env.MEMBERSHIP_TEST_ROOT);
  await runMembershipProcess(process.env.MEMBERSHIP_TEST_ROOT, processPhase);
} else {

// Real Pi lifecycle, projection, deferred custom-message flush, tool pipeline and provider boundary.
// Only the model transport is offline: these are request-prefix assertions, not cache-hit/billing claims.
test('ticket77 real SDK preserves provider prefixes for twelve tool roundtrips, reload and tree', { timeout: 15_000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'membership-sdk-'));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = root;
  let session: AgentSession | undefined;
  let api: ReturnType<typeof registerTeam> | undefined;
  let context: any;
  t.after(async () => {
    try {
      if (session) await session.abort();
      if (api && context) await api.leave(context, { authorized: true });
      session?.dispose();
    } finally {
      if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous;
      await rm(root, { recursive: true, force: true });
    }
  });
  assert.equal(configPaths().directory, join(root, 'pi-dag-workflow'));
  assert.equal(teamsRoot(), join(root, 'pi-dag-workflow', 'teams'));
  const manager = SessionManager.inMemory(root), sid = manager.getSessionId();
  const team = await createTeam({ name: 'Fixture', workspaceRoot: root });
  await joinTeam(team.id, { sessionId: sid, sessionName: 'Self', pid: process.pid, now: 1 });
  manager.appendCustomEntry('pi-dag-workflow.team-pointer', { teamId: team.id, memberName: 'Self' });
  manager.appendCustomMessageEntry(TEAM_MEMBERSHIP_MESSAGE, 'Joined Obsolete as Old', false);
  const fork = manager.appendMessage({ role: 'user', content: 'branch origin', timestamp: 1 });
  const model: Model<'membership-fixture'> = { id: 'offline', name: 'Offline membership fixture', api: 'membership-fixture', provider: 'membership-fixture', baseUrl: 'http://offline.invalid', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 131_072, maxTokens: 128 };
  const requests: any[] = [], errors: string[] = [], expected: string[] = [];
  let expectedMember = 'Self', toolsRemaining = 12;
  const settings = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
  const loader = new DefaultResourceLoader({ cwd: root, agentDir: root, settingsManager: settings, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true, extensionFactories: [pi => {
    api = registerTeam(pi, { alive: candidate => candidate === process.pid });
    pi.on('session_start', (_event, ctx) => { context = ctx; });
    pi.registerProvider('membership-fixture', { api: 'membership-fixture', baseUrl: model.baseUrl, apiKey: 'offline-fixture', models: [model], streamSimple(selected, input, options) {
      const stream = createAssistantMessageEventStream();
      queueMicrotask(async () => {
        try {
          requests.push(structuredClone(input)); expected.push(expectedMember);
          await options?.onPayload?.({ messages: input.messages }, selected);
          const calls = toolsRemaining-- > 0;
          const reply: AssistantMessage = { role: 'assistant', api: selected.api, provider: selected.provider, model: selected.id, timestamp: Date.now(), content: calls ? [{ type: 'toolCall', id: `gate-${requests.length}`, name: 'gate', arguments: {} }] : [{ type: 'text', text: 'done' }], stopReason: calls ? 'toolUse' : 'stop', usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
          stream.push({ type: 'start', partial: reply });
          stream.push({ type: 'done', reason: calls ? 'toolUse' : 'stop', message: reply });
          stream.end();
        } catch (error) { errors.push(String(error)); stream.end(); }
      });
      return stream;
    } });
  }] });
  await loader.reload();
  const modelRuntime = await ModelRuntime.create({ authPath: join(root, 'auth.json'), modelsPath: join(root, 'models.json') });
  ({ session } = await createAgentSession({ cwd: root, agentDir: root, model, modelRuntime, resourceLoader: loader, sessionManager: manager, settingsManager: settings, thinkingLevel: 'off', tools: ['gate'], customTools: [{ name: 'gate', label: 'Fixture', description: 'Offline tool roundtrip', parameters: Type.Object({}), async execute() { return { content: [{ type: 'text', text: 'gate result' }], details: undefined }; } }] }));
  await session.bindExtensions({ mode: 'rpc', onError: error => errors.push(error.error) });
  await session.prompt('RUN');
  assert.equal(requests.length, 13, 'all twelve real SDK tool roundtrips must execute');
  for (let index = 1; index < 13; index++) {
    assert.deepEqual(requests[index].messages.slice(0, requests[index - 1].messages.length), requests[index - 1].messages, `provider request ${index + 1} is pure append`);
    assert.equal(requests[index].systemPrompt, requests[0].systemPrompt);
  }
  assert.equal(manager.getBranch().filter(entry => entry.type === 'custom_message' && entry.customType === TEAM_MEMBERSHIP_MESSAGE && (entry.details as any)?.membershipVersion === 1).length, 1);
  await session.reload();
  await session.prompt('AFTER RELOAD');
  assert.deepEqual(requests[13].messages.slice(0, requests[12].messages.length), requests[12].messages, 'reload does not move the durable snapshot');
  expectedMember = 'Renamed';
  await renameMember(team.id, sid, expectedMember);
  await session.prompt('AFTER RENAME');
  assert.deepEqual(requests[14].messages.slice(0, requests[13].messages.length), requests[13].messages, 'identity change appends without rewriting old snapshots');
  await session.navigateTree(fork);
  await session.prompt('AFTER TREE');
  assert.deepEqual(errors, []);
  assert.equal(requests.length, 16);
  for (const [index, request] of requests.entries()) {
    const texts = request.messages.map((message: any) => typeof message.content === 'string' ? message.content : message.content.filter((part: any) => part.type === 'text').map((part: any) => part.text).join('\n'));
    const membership = texts.filter((text: string) => text.startsWith('Team membership (')).at(-1);
    assert.ok(membership, `provider request ${index + 1} has identity`);
    const current = JSON.parse(membership.slice(membership.indexOf('{')));
    assert.equal(current.member, expected[index], `provider request ${index + 1} has the current, not historical, identity`);
    assert.equal(current.sessionId, sid);
    assert.ok(!texts.includes('Joined Obsolete as Old'));
  }
});

test('ticket77 new Pi process resumes disk history and reconciles identity on its very first request', { timeout: 40_000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'membership-resume-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const fixture = fileURLToPath(import.meta.url);
  for (const phase of ['seed', 'resume']) {
    const child = spawnSync(process.execPath, [fixture], { timeout: 15_000, encoding: 'utf8', env: { ...process.env, HOME: root, PI_CODING_AGENT_DIR: root, MEMBERSHIP_TEST_ROOT: root, MEMBERSHIP_TEST_PHASE: phase } });
    assert.equal(child.error, undefined, `${phase}: ${child.error}`);
    assert.equal(child.status, 0, `${phase}: ${child.stderr}\n${child.stdout}`);
  }
  const seed = JSON.parse(await readFile(join(root, 'seed.json'), 'utf8'));
  const resumed = JSON.parse(await readFile(join(root, 'resume.json'), 'utf8'));
  assert.notEqual(seed.pid, resumed.pid, 'independent process, not extension re-registration');
  assert.equal(seed.sid, resumed.sid, 'real disk restore keeps the session ID');
  assert.equal(seed.file, resumed.file);
  assert.deepEqual(resumed.snapshots[0], seed.snapshots[0], 'old durable snapshot retains entry, anchor occurrence and timestamp');
  assert.equal(resumed.snapshots.length, 2, 'changed name appends exactly one snapshot');
  const contexts = [...seed.contexts, ...resumed.contexts];
  const requests = [...seed.requests, ...resumed.requests];
  assert.equal(requests.length, 10);
  for (let index = 0; index < requests.length; index++) {
    const snapshots = contexts[index].filter((message: any) => message.role === 'custom' && message.customType === TEAM_MEMBERSHIP_MESSAGE);
    const text = snapshots.at(-1).content;
    assert.equal(JSON.parse(text.slice(text.indexOf('{'))).member, index < seed.requests.length ? 'Original' : 'Restored', 'first request after real resume already has the current identity');
    assert.ok(!contexts[index].some((message: any) => message.content === 'Joined Obsolete as Old'));
    if (index === 0) continue;
    assert.deepEqual(contexts[index].slice(0, contexts[index - 1].length), contexts[index - 1], `full context request ${index + 1} is pure append, including resume`);
    assert.deepEqual(requests[index].messages.slice(0, requests[index - 1].messages.length), requests[index - 1].messages, `provider request ${index + 1} is pure append, including resume`);
    assert.equal(requests[index].systemPrompt, requests[0].systemPrompt);
  }
});
}

// A new real Pi process with disk history and real session_start ownership recovery.
// Only transport is scripted; the parent process collects both full context and provider input.
async function runMembershipProcess(root: string, phase: 'seed' | 'resume'): Promise<void> {
process.env.PI_CODING_AGENT_DIR = root;
assert.equal(configPaths().directory, join(root, 'pi-dag-workflow'));
assert.equal(teamsRoot(), join(root, 'pi-dag-workflow', 'teams'));
const old = phase === 'resume' ? JSON.parse(await readFile(join(root, 'seed.json'), 'utf8')) : undefined;
const manager = old ? SessionManager.open(old.file) : SessionManager.create(root, join(root, 'sessions'));
const sid = manager.getSessionId();
const teamId = old?.teamId ?? (await createTeam({ name: 'Process fixture', workspaceRoot: root })).id;
if (old) await renameMember(teamId, sid, 'Restored');
else {
  await joinTeam(teamId, { sessionId: sid, sessionName: 'Original', pid: process.pid, now: 1 });
  manager.appendCustomEntry('pi-dag-workflow.team-pointer', { teamId, memberName: 'Original' });
  manager.appendCustomMessageEntry(TEAM_MEMBERSHIP_MESSAGE, 'Joined Obsolete as Old', false);
}
const model: Model<'membership-process'> = { id: 'offline', name: 'Offline process fixture', api: 'membership-process', provider: 'membership-process', baseUrl: 'http://offline.invalid', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 131_072, maxTokens: 128 };
const requests: unknown[] = [], contexts: unknown[] = [], errors: string[] = [];
let toolsRemaining = phase === 'seed' ? 6 : 2;
const settings = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
const loader = new DefaultResourceLoader({ cwd: root, agentDir: root, settingsManager: settings, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true, extensionFactories: [pi => {
  registerTeam(pi);
  pi.on('context_with_system', event => { contexts.push(structuredClone(event.messages)); });
  pi.registerProvider('membership-process', { api: 'membership-process', baseUrl: model.baseUrl, apiKey: 'offline-fixture', models: [model], streamSimple(selected, input, options) {
    const stream = createAssistantMessageEventStream();
    queueMicrotask(async () => {
      try {
        requests.push(structuredClone(input));
        await options?.onPayload?.({ messages: input.messages }, selected);
        const calls = toolsRemaining-- > 0;
        const reply: AssistantMessage = { role: 'assistant', api: selected.api, provider: selected.provider, model: selected.id, timestamp: Date.now(), content: calls ? [{ type: 'toolCall', id: `${phase}-${requests.length}`, name: 'gate', arguments: {} }] : [{ type: 'text', text: 'done' }], stopReason: calls ? 'toolUse' : 'stop', usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
        stream.push({ type: 'start', partial: reply });
        stream.push({ type: 'done', reason: calls ? 'toolUse' : 'stop', message: reply });
        stream.end();
      } catch (error) { errors.push(String(error)); stream.end(); }
    });
    return stream;
  } });
}] });
await loader.reload();
const modelRuntime = await ModelRuntime.create({ authPath: join(root, 'auth.json'), modelsPath: join(root, 'models.json') });
const { session } = await createAgentSession({ cwd: root, agentDir: root, model, modelRuntime, resourceLoader: loader, sessionManager: manager, settingsManager: settings, thinkingLevel: 'off', tools: ['gate'], customTools: [{ name: 'gate', label: 'Fixture', description: 'Offline roundtrip', parameters: Type.Object({}), async execute() { return { content: [{ type: 'text', text: 'result' }], details: undefined }; } }] });
await session.bindExtensions({ mode: 'rpc', onError: error => errors.push(error.error) });
await session.prompt(phase);
assert.deepEqual(errors, []);
assert.equal(requests.length, phase === 'seed' ? 7 : 3);
const member = await readMember(teamId, sid);
assert.equal(member?.holder.pid, process.pid, 'fresh process claims the persisted member on session_start');
await writeFile(join(root, `${phase}.json`), JSON.stringify({ pid: process.pid, sid, teamId, file: manager.getSessionFile(), requests, contexts, snapshots: manager.getBranch().filter(entry => entry.type === 'custom_message' && entry.customType === TEAM_MEMBERSHIP_MESSAGE && (entry.details as { membershipVersion?: number })?.membershipVersion === 1) }));
session.dispose();
// Keep the member record: the next process must detect the dead holder and reclaim, like a real resume.
}
