import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Type } from 'typebox';
import { createAssistantMessageEventStream, type AssistantMessage, type Model } from '@earendil-works/pi-ai';
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager, type AgentSession, type ExtensionContext } from '@earendil-works/pi-coding-agent';
import { registerTeam } from '../src/team/commands/register.ts';
import { createTeam, joinTeam, renameMember, setAutoMessages, teamsRoot } from '../src/team/io/registry.ts';
import { requestDelivery, sendFromUser, sendToMember, unreadFor } from '../src/team/io/inbox.ts';
import { TEAM_MESSAGE } from '../src/shared/message-types.ts';

// Real SDK queues and provider-facing context; the provider is local and never opens a connection.
for (const scenario of ['idle', 'manual', 'manual-busy', 'queued', 'priority', 'filtered', 'final-turn', 'human'] as const) {
  test(`ticket58 native SDK ${scenario} confirms only the actual request and honours queue boundaries`, { timeout: 10_000 }, async t => {
    const root = await mkdtemp(join(tmpdir(), 'dag-inbox-sdk-'));
    const previous = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = root;
    let session: AgentSession | undefined;
    let api: ReturnType<typeof registerTeam> | undefined;
    let context: ExtensionContext | undefined;
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
    assert.ok(teamsRoot().startsWith(root));
    const team = await createTeam({ name: 'Fixture', workspaceRoot: root });
    const manager = SessionManager.inMemory(root);
    const sid = manager.getSessionId();
    await joinTeam(team.id, { sessionId: sid, sessionName: 'Receiver', pid: process.pid, now: 1 });
    await joinTeam(team.id, { sessionId: 'sender', sessionName: 'Sender', pid: process.pid + 100, now: 1 });
    await setAutoMessages(team.id, sid, (scenario === 'manual' || scenario === 'manual-busy') ? 'off' : scenario === 'priority' ? 'all' : 'background');
    const marker = 'INBOX-SDK-MARKER\n    原文不翻译';
    const input = { from: 'Sender', fromId: 'sender', toSessionId: sid, body: marker, now: 2 };
    const sent = scenario === 'human' ? await sendFromUser(team.id, input) : await sendToMember(team.id, input);
    const model: Model<'inbox-fixture'> = { id: 'scripted', name: 'Offline inbox fixture', api: 'inbox-fixture', provider: 'inbox-fixture', baseUrl: 'http://offline.invalid', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32_768, maxTokens: 128 };
    let requests = 0, expectedMember = 'Receiver';
    const providerErrors: string[] = [];
    let firstSeen: number | undefined;
    const confirmed: number[] = [];
    const settings = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
    const loader = new DefaultResourceLoader({ cwd: root, agentDir: root, settingsManager: settings, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      extensionFactories: [pi => {
        api = registerTeam(pi, { alive: candidate => candidate === process.pid });
        pi.on('session_start', (_event, ctx) => {
          context = ctx;
          // Register after Team's own startup handler so this fixture does not start a background timer.
          pi.appendEntry('pi-dag-workflow.team-pointer', { teamId: team.id, memberName: 'Receiver' });
        });
        if (scenario === 'filtered') pi.on('context_with_system', event => ({ messages: event.messages.filter(message => !(message.role === 'custom' && message.customType === TEAM_MESSAGE)) }));
        pi.registerProvider('inbox-fixture', { api: 'inbox-fixture', baseUrl: model.baseUrl, apiKey: 'offline-fixture', models: [model],
          streamSimple(selected, input, options) {
            const stream = createAssistantMessageEventStream();
            queueMicrotask(async () => {
              try {
                const request = ++requests;
                const texts = input.messages.map(message => typeof message.content === 'string' ? message.content : message.content.filter(part => part.type === 'text').map(part => part.text).join('\n'));
                assert.ok(texts.some(text => text.includes('Team membership') && text.includes('"team":"Fixture"') && text.includes(`"member":${JSON.stringify(expectedMember)}`) && text.includes(sid)), 'the actual provider input identifies this session’s current team and member without an extra model request');
                const membershipText = texts.find(text => text.startsWith('Team membership ('))!;
                const membership = JSON.parse(membershipText.slice(membershipText.indexOf('{')));
                assert.ok(Buffer.byteLength(membershipText) <= 2048, 'automatic membership context has a total budget');
                assert.equal(membership.total, 2);
                assert.ok(membership.roster.some((member: any) => member.name === expectedMember));
                assert.ok(membership.roster.some((member: any) => member.name === 'Sender'));
                assert.ok(membership.lead === null || membership.roster.some((member: any) => member.name === membership.lead), 'a stale leader label is not presented as a current roster member');
                const contains = texts.some(text => text.includes(marker));
                if (contains) assert.ok(texts.some(text => text.includes(`Source: ${scenario === 'human' ? 'human-authored' : 'agent'} · Sender`) && text.includes('To: Receiver') && text.includes('Body:\n' + marker)), 'trusted English provenance and original body reach actual provider input');
                if (contains && firstSeen === undefined) firstSeen = request;
                if (contains && confirmed.length === 0) assert.equal(await unreadFor(team.id, sid), 1, 'preparing the SDK request does not confirm a read');
                await options?.onPayload?.({ messages: input.messages }, selected);
                if (contains) confirmed.push(await unreadFor(team.id, sid));
                const calls = (scenario === 'queued' || scenario === 'priority' || scenario === 'manual-busy') && request <= 2;
                const reply: AssistantMessage = { role: 'assistant', api: selected.api, provider: selected.provider, model: selected.id, timestamp: Date.now(), content: calls ? [{ type: 'toolCall', id: `gate-${request}`, name: 'gate', arguments: {} }] : [{ type: 'text', text: 'fixture done' }], stopReason: calls ? 'toolUse' : 'stop', usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
                stream.push({ type: 'start', partial: reply });
                stream.push({ type: 'done', reason: calls ? 'toolUse' : 'stop', message: reply });
                stream.end();
              } catch (error) {
                providerErrors.push(String(error));
                const failure: AssistantMessage = { role: 'assistant', api: selected.api, provider: selected.provider, model: selected.id, timestamp: Date.now(), content: [], stopReason: 'error', errorMessage: String(error), usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
                stream.push({ type: 'error', reason: 'error', error: failure });
                stream.end();
              }
            });
            return stream;
          },
        });
      }],
    });
    await loader.reload();
    const modelRuntime = await ModelRuntime.create({ authPath: join(root, 'auth.json'), modelsPath: join(root, 'models.json') });
    let gates = 0;
    ({ session } = await createAgentSession({ cwd: root, agentDir: root, model, modelRuntime, resourceLoader: loader, sessionManager: manager, settingsManager: settings, thinkingLevel: 'off', tools: ['gate'], customTools: [{ name: 'gate', label: 'Fixture gate', description: 'Offline deterministic queue boundary', parameters: Type.Object({}), async execute() { if (++gates === 1) { if (scenario === 'manual-busy') await requestDelivery(team.id, { from: 'Sender', fromId: 'sender', toSessionId: sid, ids: [sent.id], now: 3 }); await api!.poll(context!); } return { content: [{ type: 'text', text: 'gate done' }], details: undefined }; } }] }));
    const errors: string[] = [];
    await session.bindExtensions({ mode: 'rpc', onError: error => { errors.push(error.error); } });
    assert.ok(context);
    assert.ok(api);
    // final-turn emits a normal stop in request 1: only Team's final turn_end can schedule request 2.
    if (scenario === 'queued' || scenario === 'priority' || scenario === 'manual-busy' || scenario === 'final-turn') await session.prompt('RUN FIXTURE');
    else {
      if (scenario === 'manual') {
        await api.poll(context);
        assert.equal(requests, 0, 'Manual does not wake a model without a user request');
        await requestDelivery(team.id, { from: 'Sender', fromId: 'sender', toSessionId: sid, ids: [sent.id], now: 3 });
      }
      await api.poll(context);
      await session.waitForIdle();
    }
    assert.deepEqual(errors, []);
    assert.deepEqual(providerErrors, []);
    assert.equal(firstSeen, scenario === 'filtered' ? undefined : scenario === 'queued' || scenario === 'manual-busy' ? 4 : scenario === 'priority' || scenario === 'final-turn' ? 2 : 1);
    assert.equal(await unreadFor(team.id, sid), scenario === 'filtered' ? 1 : 0);
    if (scenario !== 'filtered') assert.ok(confirmed.length && confirmed.every(value => value === 0), 'the actual provider boundary confirmed each delivered batch');
    if (scenario === 'human') {
      expectedMember = 'Renamed Receiver';
      await renameMember(team.id, sid, expectedMember);
      await session.prompt('CHECK CURRENT MEMBERSHIP');
      assert.deepEqual(providerErrors, [], 'the next request reads the live member name, not the saved pointer label');
    }
  });
}

/**
 * The finish boundary in a real SDK session: `team_inspect until: finish` must return because a real turn in
 * this session ended (the extension's own `turn_end` handler), not because a test helper said so. Aborting the
 * call must return promptly with the snapshot it already had.
 */
test('ticket51 native SDK: finish returns on a real turn end and abort returns promptly', { timeout: 30_000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'dag-inspect-sdk-'));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = root;
  let session: AgentSession | undefined;
  t.after(async () => {
    try { session?.dispose(); } finally {
      if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous;
      await rm(root, { recursive: true, force: true });
    }
  });
  const team = await createTeam({ name: 'Fixture', workspaceRoot: root });
  const manager = SessionManager.inMemory(root);
  const sid = manager.getSessionId();
  await joinTeam(team.id, { sessionId: sid, sessionName: 'Self', pid: process.pid, now: 1 });
  const tools = new Map<string, any>();
  let context: ExtensionContext | undefined;
  const model: Model<'inspect-fixture'> = { id: 'scripted', name: 'Offline inspect fixture', api: 'inspect-fixture', provider: 'inspect-fixture', baseUrl: 'http://offline.invalid', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32_768, maxTokens: 128 };
  const settings = SettingsManager.inMemory({});
  const loader = new DefaultResourceLoader({ cwd: root, agentDir: root, settingsManager: settings, additionalExtensionPaths: [root], noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true, extensionFactories: [{
    name: 'inspect-fixture',
    factory: (pi: any) => {
      pi.registerTool = ((original: any) => (tool: any) => { tools.set(tool.name, tool); return original.call(pi, tool); })(pi.registerTool.bind(pi));
      pi.on('session_start', async (_event: unknown, ctx: any) => {
        context = ctx;
        // The session's own pointer: this is the real join write, not a test-side shortcut.
        pi.appendEntry('pi-dag-workflow.team-pointer', { teamId: team.id, memberName: 'Self' });
      });
      pi.registerProvider('inspect-fixture', { api: 'inspect-fixture', baseUrl: model.baseUrl, apiKey: 'offline-fixture', models: [model],
        streamSimple(selected: any, _input: any) {
          const stream = createAssistantMessageEventStream();
          queueMicrotask(() => {
            // Two requests, so the session really runs a turn and ends it.
            const reply: AssistantMessage = { role: 'assistant', api: selected.api, provider: selected.provider, model: selected.id, timestamp: Date.now(), content: [{ type: 'text', text: 'fixture turn' }], stopReason: 'stop', usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
            stream.push({ type: 'start', partial: reply });
            stream.push({ type: 'done', reason: 'stop', message: reply });
            stream.end();
          });
          return stream;
        } });
      // The real registration: the extension's own turn_end writes the member's boundary.
      registerTeam(pi, { msg: (value: any) => String(value), pid: () => process.pid, alive: () => true });
    },
  }] });
  await loader.reload();
  const modelRuntime = await ModelRuntime.create({ authPath: join(root, 'auth.json'), modelsPath: join(root, 'models.json') });
  ({ session } = await createAgentSession({ cwd: root, agentDir: root, model, modelRuntime, resourceLoader: loader, sessionManager: manager, settingsManager: settings, thinkingLevel: 'off', tools: [] }));
  await session.bindExtensions({ mode: 'rpc', onError: error => { throw new Error(error.error); } });
  // session_start fires on the first prompt; the tool call needs that context, so the prompt starts first.
  const inspect = tools.get('team_inspect');
  assert.ok(inspect, 'the Team tool is registered in this real session');
  // The wait is a real tool call with the session's own context; the turn runs while it waits.
  const prompting = session.prompt('MAKE A TURN');
  for (let attempt = 0; attempt < 200 && !context; attempt += 1) await new Promise(resolve => setTimeout(resolve, 5));
  assert.ok(context, 'the real extension context is available');
  const waiting = inspect.execute('probe', { name: 'Self', until: 'finish', timeout: 20 }, undefined, undefined, context!);
  await prompting;
  await session.waitForIdle();
  const result = JSON.parse((await waiting).content[0].text);
  assert.equal(result.timedOut, undefined, 'the real turn end released the wait, not the clock');
  assert.ok(result.lastActiveAt > 0, 'and the boundary it read is the real one');
  assert.equal(result.member.sessionId, sid, 'the answer is about this session');
  // A second call is cancelled from outside, in this same real session, and returns promptly. The member is
  // marked inside a run first, so the wait cannot answer "already idle" and the cancel path is what returns.
  const { noteMemberEvent } = await import('../src/team/io/registry.ts');
  await noteMemberEvent(team.id, sid, { activity: 'turn_start', alive: true, ownerPid: process.pid });
  const controller = new AbortController();
  const aborted = inspect.execute('probe', { name: 'Self', until: 'finish', timeout: 30 }, controller.signal, undefined, context!);
  setTimeout(() => controller.abort(), 60);
  const startedAt = Date.now();
  const cancelled = JSON.parse((await aborted).content[0].text);
  assert.equal(cancelled.cancelled, true, 'the caller cancels the wait');
  assert.ok(Date.now() - startedAt < 5_000, `and it returns promptly, not at the cap: ${Date.now() - startedAt}ms`);
});
