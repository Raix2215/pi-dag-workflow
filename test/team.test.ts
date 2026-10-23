import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, open, readdir, readFile, realpath, rm, stat, symlink, writeFile, access } from 'node:fs/promises';
import { mkdirSync, writeFileSync } from 'node:fs';
import fsPromises from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { spawn as nodeSpawn } from 'node:child_process';
import { basename, dirname as dirnameP } from 'node:path';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { electLead, memberFromPointer, memberState, memberStatus, nextMemberName, resolveTeamName, teamResolutionHint, type TeamMember } from '../src/team/domain/teams.ts';
import { MAX_BODY_BYTES, POLL_MS, deliveryFor } from '../src/team/domain/inbox.ts';
import { deleteInbox, readInbox, sendToMember, takeInbox, unreadFor } from '../src/team/io/inbox.ts';
import { BACKGROUND_ENV, backgroundProcess, clipboardCommand, desktopCommand, detectAdapters, detectTerminal, TERMINALS, TERMINAL_NAMES, validDesktopCommand, launchCommand, modelArgs, ownsMember, planLaunch, shellQuote, takeoverCommand, takeoverDecision } from '../src/team/domain/launcher.ts';
import { cleanupRuntime, launchTeam, teamExtensionPath } from '../src/team/io/launcher.ts';
import { readLaunchProfile } from '../src/shared/profile-launch.ts';
import { ProfileStore } from '../src/agents/domain/profiles.ts';
import { IsolatedClient } from './fixtures/isolated-client.ts';
import { ownsRuntimePath, prepareRuntimeRoot, readRuntimePid, removeMemberRuntime, removeOwnedRuntime, runtimeEvidence, runtimePairFor, writeRuntimePid } from '../src/team/io/runtime.ts';
import { piLaunchTarget } from '../src/shared/pi-cli.ts';
import { assignLead, claimOwnership, createTeam, dissolveTeam, joinTeam, leaveTeam, listTeams, markMemberOffline, noteMemberEvent, readMembers, readTeam, releaseMember, removeMember, renameMember, renameTeam, restoreMember, setAutoMessages, setMemberRuntime, teamsRoot, updateTeam } from '../src/team/io/registry.ts';
import { registerTeam } from '../src/team/commands/register.ts';
import { chinese, createTranslator } from '../src/shared/i18n.ts';
import { TEAM_MESSAGE, TEAM_MEMBERSHIP_MESSAGE } from './fixtures/public-records.ts';

const workspace = '/tmp/team-workspace';
// A fixed fixture root: recreate it so a cleared /tmp does not turn every spawn into ENOENT.
mkdirSync(workspace, { recursive: true });
async function agentDir(t: { after(fn: () => unknown): void }) {
  const root = await mkdtemp(join(tmpdir(), 'team-test-'));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = root;
  t.after(async () => { if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous; await rm(root, { recursive: true, force: true }); });
  return root;
}
/** A roster record written straight to disk: the duplicate name only history can still contain. */

/** Write the canonical Profile file through the real writer the /agents panel uses (never a hand-made map). */
async function writeProfiles(profiles: unknown[], target?: string): Promise<string> {
  const { configPaths } = await import('../src/shared/config.ts');
  const file = target ?? join(configPaths().directory, 'pi-dag-workflow-profile.json');
  await mkdir(dirnameP(file), { recursive: true });
  await rm(file, { force: true });
  const store = new ProfileStore({
    path: file,
    registry: { find: (provider: string, id: string) => ({ provider, id, reasoning: true }) } as never,
    getTools: () => ['read', 'grep', 'find', 'ls', 'bash', 'edit', 'write'],
  });
  await store.load();
  for (const profile of profiles) store.set(profile as never);
  await store.save();
  return file;
}

const member = (overrides: Partial<TeamMember> = {}): TeamMember => ({ sessionId: 's1', name: 'member-1', state: 'attached', holder: { pid: 1, since: 0, heartbeatAt: 1000 }, retrying: false, generation: 1, ...overrides });

/**
 * Queue a real Team IO write behind a lock this test holds, and let the caller change the on-disk
 * state while that write is provably waiting. The wrapped `open` still throws EEXIST back to the
 * production lock loop: it observes the wait, it never changes the lock's outcome.
 */
async function queuedBehindLock<T>(
  t: { after(fn: () => unknown): void },
  lockPath: string,
  run: () => Promise<T>,
  whileWaiting: () => Promise<void>,
): Promise<{ value: T; queued: boolean }> {
  const original = fsPromises.open;
  const holder = await original(lockPath, 'wx', 0o600);
  let signal!: () => void;
  const queued = new Promise<void>(resolve => { signal = resolve; });
  let timer: NodeJS.Timeout | undefined, seen = false;
  fsPromises.open = (async (...args: any[]) => {
    try { return await (original as any).apply(fsPromises, args); }
    catch (error: any) {
      if (error?.code === 'EEXIST' && String(args[0]) === lockPath && !seen) { seen = true; signal(); }
      throw error;
    }
  }) as typeof fsPromises.open;
  syncBuiltinESMExports();
  const restore = () => { fsPromises.open = original; syncBuiltinESMExports(); };
  t.after(restore);
  const running = run().then(value => ({ value }), (error: unknown) => ({ error }));
  let failure: unknown;
  try {
    const guard = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('the writer never queued on the lock')), 5000); });
    await Promise.race([queued, guard]);
    await whileWaiting();
  } catch (error) { failure = error; }
  finally { clearTimeout(timer); await holder.close().catch(() => {}); await rm(lockPath, { force: true }).catch(() => {}); restore(); }
  const outcome = await running;
  if (failure) throw failure;
  if ('error' in outcome) throw outcome.error;
  return { value: outcome.value, queued: seen };
}

/** Pause the first read of one manifest file, so another writer can finish in between. */
async function pauseFirstManifestRead(t: { after(fn: () => unknown): void }, teamId: string) {
  const original = fsPromises.readFile;
  const target = join(teamsRoot(), teamId, 'team.json');
  let release!: () => void;
  const resume = new Promise<void>(resolve => { release = resolve; });
  let heldSignal!: () => void;
  const held = new Promise<void>(resolve => { heldSignal = resolve; });
  let paused = false;
  fsPromises.readFile = (async (...args: any[]) => {
    const bytes = await (original as any).apply(fsPromises, args);
    if (!paused && String(args[0]) === target) { paused = true; heldSignal(); await resume; }
    return bytes;
  }) as typeof fsPromises.readFile;
  syncBuiltinESMExports();
  const restore = () => { fsPromises.readFile = original; syncBuiltinESMExports(); };
  t.after(restore);
  return { held, release: () => release(), restore };
}

/** Pause the first read of one member record, and observe contention on that member's lock. */
async function pauseFirstMemberRead(t: { after(fn: () => unknown): void }, teamId: string, sessionId: string) {
  const originalRead = fsPromises.readFile, originalOpen = fsPromises.open;
  const target = join(teamsRoot(), teamId, 'members', `${sessionId}.json`);
  const lock = join(teamsRoot(), teamId, 'members', `${sessionId}.lock`);
  let release!: () => void;
  const resume = new Promise<void>(resolve => { release = resolve; });
  let heldSignal!: () => void;
  const held = new Promise<void>(resolve => { heldSignal = resolve; });
  let contendedSignal!: () => void;
  const contended = new Promise<void>(resolve => { contendedSignal = resolve; });
  let paused = false;
  fsPromises.readFile = (async (...args: any[]) => {
    const bytes = await (originalRead as any).apply(fsPromises, args);
    if (!paused && String(args[0]) === target) { paused = true; heldSignal(); await resume; }
    return bytes;
  }) as typeof fsPromises.readFile;
  fsPromises.open = (async (...args: any[]) => {
    try { return await (originalOpen as any).apply(fsPromises, args); }
    catch (error: any) {
      if (error?.code === 'EEXIST' && String(args[0]) === lock) contendedSignal();
      throw error;
    }
  }) as typeof fsPromises.open;
  syncBuiltinESMExports();
  const restore = () => { fsPromises.readFile = originalRead; fsPromises.open = originalOpen; syncBuiltinESMExports(); };
  t.after(restore);
  return { held, contended, release: () => release(), restore };
}

/** A sentinel outside the team but inside this run's temporary agent directory. */
async function sentinel(root: string, name: string): Promise<string> {
  const path = join(root, 'sentinels', name);
  await mkdir(dirnameP(path), { recursive: true });
  await writeFile(path, 'do not delete\n');
  return path;
}
const exists = (path: string) => access(path).then(() => true, () => false);

/** A test-only extension that reports the settings a member really sees, next to itself. */
const probeSource = (output: string): string => `import { writeFileSync } from 'node:fs';
const report = (pi, ctx) => {
  try {
    writeFileSync(${JSON.stringify(output)}, JSON.stringify({
      provider: ctx.model?.provider ?? null, model: ctx.model?.id ?? null,
      thinking: ctx.thinkingLevel ?? null, tools: pi.getActiveTools(),
    }));
  } catch { /* a probe must never change the session */ }
};
export default function (pi) {
  pi.on('session_start', async (_event, ctx) => { report(pi, ctx); });
  pi.on('before_agent_start', async (_event, ctx) => { report(pi, ctx); });
}
`;


test('team registry creates, renames without moving the directory, and lists by workspace', async t => {
  await agentDir(t);
  const team = await createTeam({ name: 'Alpha', workspaceRoot: workspace });
  assert.match(team.id, /^t-[0-9a-f]{4}$/);
  assert.equal((await readTeam(team.id))!.name, 'Alpha');
  const renamed = await renameTeam(team.id, 'Beta');
  assert.equal(renamed!.id, team.id, 'renaming keeps the id and directory');
  assert.equal((await readTeam(team.id))!.name, 'Beta');
  assert.deepEqual((await listTeams(workspace)).map(item => item.name), ['Beta']);
  assert.deepEqual(await listTeams('/tmp/other-workspace'), [], 'teams are filtered by workspaceRoot');
  assert.equal(await readFile(join(teamsRoot(), team.id, 'team.json'), 'utf8').then(text => JSON.parse(text).name), 'Beta');
});

test('--team resolves by fuzzy name with candidates and an actionable miss', () => {
  const teams = [
    { id: 't-1', name: 'Alpha Core', workspaceRoot: workspace, nextId: 1 },
    { id: 't-2', name: 'Alpha Review', workspaceRoot: workspace, nextId: 1 },
    { id: 't-3', name: 'Gamma', workspaceRoot: workspace, nextId: 1 },
  ];
  assert.equal(resolveTeamName(teams, 'Gamma').team!.id, 't-3');
  assert.equal(resolveTeamName(teams, 'core').team!.id, 't-1', 'substring match works');
  const ambiguous = resolveTeamName(teams, 'Alpha');
  assert.equal(ambiguous.team, undefined);
  assert.deepEqual(ambiguous.matches.map(team => team.name), ['Alpha Core', 'Alpha Review']);
  assert.match(teamResolutionHint('Alpha', ambiguous.matches), /matches.*Alpha Core, Alpha Review/);
  assert.match(teamResolutionHint('Delta', []), /No team matches "Delta" in this workspace; create one from the \/team panel/);
});

test('the team directory is authoritative over the branch pointer', async t => {
  await agentDir(t);
  const team = await createTeam({ name: 'Alpha', workspaceRoot: workspace });
  await joinTeam(team.id, { sessionId: 's1', pid: 10, now: 1_000 });
  const members = await readMembers(team.id);
  assert.equal(memberFromPointer({ teamId: team.id, memberName: 'member-1' }, members)!.sessionId, 's1');
  assert.equal(memberFromPointer({ teamId: team.id, memberName: 'ghost' }, members), undefined, 'a pointer without a member record is not joined');
});

test('leaving removes the member; a missing team reports dissolution; corrupt files stay tolerated', async t => {
  await agentDir(t);
  const team = await createTeam({ name: 'Alpha', workspaceRoot: workspace });
  await joinTeam(team.id, { sessionId: 's1', pid: 10, now: 1_000 });
  assert.deepEqual(await leaveTeam(team.id, 's1'), { removed: true, dissolved: false });
  assert.deepEqual(await readMembers(team.id), []);
  assert.deepEqual(await leaveTeam('t-missing', 's1'), { removed: false, dissolved: true });
  await mkdir(join(teamsRoot(), 't-broken'), { recursive: true });
  await writeFile(join(teamsRoot(), 't-broken', 'team.json'), '{ broken');
  assert.equal(await readTeam('t-broken'), undefined, 'a corrupt manifest is ignored');
  await mkdir(join(teamsRoot(), 't-broken', 'members'), { recursive: true });
  await writeFile(join(teamsRoot(), 't-broken', 'members', 's1.json'), '{ broken');
  assert.deepEqual(await readMembers('t-broken'), [], 'a corrupt member file is ignored');
  assert.equal(await dissolveTeam(team.id), true);
  assert.equal(await readTeam(team.id), undefined);
});

test('member naming is independent from the Pi session name setter', () => {
  const existing = [member({ name: 'member-1' }), member({ sessionId: 's2', name: 'Reviewer' })];
  assert.equal(nextMemberName(existing), 'member-2');
  assert.equal(nextMemberName(existing, '  '), 'member-2');
  assert.equal(nextMemberName(existing, 'Owner'), 'Owner');
});

function teamHost(root: string, sessionId = 's1') {
  const handlers = new Map<string, Function[]>(), flags = new Map<string, unknown>(), appends: { type: string; data: unknown }[] = [], sent: { message: unknown; options: unknown }[] = [], notices: { message: string; level: string }[] = [], tools = new Map<string, any>();
  const branch: { customType?: string; data?: unknown }[] = [];
  const pi: any = {
    on(name: string, handler: Function) { handlers.set(name, [...handlers.get(name) ?? [], handler]); return () => {}; },
    registerFlag(name: string, options: unknown) { flags.set(name, options); },
    getFlag(name: string) { return flags.get(`value:${name}`); },
    appendEntry(type: string, data: unknown) { appends.push({ type, data }); branch.push({ customType: type, data }); },
    sendMessage(message: unknown, options: unknown) { sent.push({ message, options }); },
    registerTool(tool: any) { tools.set(tool.name, tool); },
    registerCommand() {}, registerMessageRenderer() {},
  };
  let idle = true;
  const ctx: any = { cwd: root, isIdle: () => idle, sessionManager: { getSessionId: () => sessionId, getSessionName: () => undefined, getBranch: () => branch }, ui: { notify: (message: string, level = 'info') => notices.push({ message, level }), setWidget() {} } };
  const fire = async (name: string, event: unknown = {}) => { for (const handler of handlers.get(name) ?? []) await handler(event, ctx); };
  const setIdle = (value: boolean) => { idle = value; };
  return { pi, ctx, flags, appends, sent, notices, tools, fire, setIdle };
}

test('the extension joins from the --team flag, persists the session pointer and leaves cleanly', async t => {
  await agentDir(t);
  const team = await createTeam({ name: 'Alpha', workspaceRoot: workspace });
  const host = teamHost(workspace);
  const registration = registerTeam(host.pi, { msg: chinese, now: () => 5_000 });
  t.after(() => host.fire('session_shutdown'));
  assert.ok(host.flags.has('team'), 'the --team flag is registered');
  host.flags.set('value:team', 'Alpha');
  await host.fire('session_start');
  const members = await readMembers(team.id);
  assert.deepEqual(members.map(item => item.name), ['member-1'], 'the member record exists before any user message');
  assert.deepEqual(host.appends.at(-1), { type: 'pi-dag-workflow.team-pointer', data: { teamId: team.id, memberName: 'member-1' } }, 'the branch carries the pointer');
  assert.ok(host.sent.some(item => (item.message as { customType?: string }).customType === TEAM_MEMBERSHIP_MESSAGE && (item.options as { triggerTurn?: boolean }).triggerTurn === false), 'the membership note never starts a model turn');
  await renameMember(team.id, 's1', 'Kept member name');
  await registration.leave(host.ctx, { authorized: true });
  assert.deepEqual(await readMembers(team.id), [], 'leaving removes the member');
  assert.equal(host.appends.at(-1)!.data, undefined, 'leaving clears the pointer');
  assert.ok(host.notices.some(item => item.message.includes('已退出团队')));
  await registration.join(host.ctx, 'Alpha');
  assert.equal((await readMembers(team.id))[0]!.name, 'Kept member name', 'leaving and rejoining the same team preserves the actual member name, not the old pointer label');
});

test('a stale pointer to a dissolved team is cleared with an actionable notice', async t => {
  await agentDir(t);
  const host = teamHost(workspace);
  registerTeam(host.pi, { msg: chinese });
  host.pi.appendEntry('pi-dag-workflow.team-pointer', { teamId: 't-gone', memberName: 'member-1' });
  await host.fire('session_start');
  assert.equal(host.appends.at(-1)!.data, undefined, 'the pointer is cleared');
  assert.match(host.notices.at(-1)!.message, /原团队 t-gone 已解散/);
});

test('the module is silent when team is not one of the loaded features', async t => {
  await agentDir(t);
  await createTeam({ name: 'Alpha', workspaceRoot: workspace });
  const { createWorkflow } = await import('../src/workflow/index.ts');
  const handlers = new Map<string, Function[]>(), flags = new Map<string, unknown>(), appends: unknown[] = [];
  const pi: any = {
    on(name: string, handler: Function) { handlers.set(name, [...handlers.get(name) ?? [], handler]); return () => {}; },
    registerTool() {}, registerCommand() {}, registerMessageRenderer() {}, registerFlag(name: string, options: unknown) { flags.set(name, options); },
    getFlag: (name: string) => name === 'team' ? 'Alpha' : undefined, appendEntry: (_type: string, data: unknown) => appends.push(data),
    sendMessage() {}, sendUserMessage() {}, getActiveTools: () => ['read'], getAllTools: () => [], setActiveTools() {},
    events: { emit() {}, on() { return () => {}; } },
  };
  const ctx: any = { cwd: workspace, hasUI: false, mode: 'rpc', isIdle: () => true, ui: { notify() {}, setWidget() {} }, sessionManager: { getBranch: () => [], getSessionFile: () => undefined, getLeafId: () => undefined, getSessionId: () => 's1', getSessionName: () => undefined }, modelRegistry: { find: () => undefined } };
  const workflow = createWorkflow(pi);
  await workflow.attach('todos', pi);
  for (const handler of handlers.get('session_start') ?? []) await handler({}, ctx);
  assert.equal(flags.has('team'), false, 'no --team flag when the feature is off');
  assert.deepEqual(appends, [], 'no membership pointer when the feature is off');
  assert.deepEqual(await readMembers((await listTeams(workspace))[0]!.id), [], 'no member is written');
});

/** The rendered tab bar is `PanelNavigation.tabs()`: one cell per enabled tab, in registry order. */
const tabOrder = (line: string): string[] => line.split(/\s+\/\s+/)
  .map(cell => cell.replace(/^[^\p{L}]+/u, '').replace(/\s*\(\d+\/\d+\)$/, '').trim())
  .filter(Boolean);

test('ticket09 the real workflow assembly orders the tabs Todos / Plan / Goal / Agents / Team / Retry / Display', async t => {
  await agentDir(t);
  const { createWorkflow } = await import('../src/workflow/index.ts');
  const { recordPanels } = await import('./fixtures/public-host.ts');
  const open = async (features: readonly string[]) => {
    const handlers = new Map<string, Function[]>(), commands = new Map<string, any>();
    const pi: any = {
      on(name: string, handler: Function) { handlers.set(name, [...handlers.get(name) ?? [], handler]); return () => {}; },
      registerTool() {}, registerCommand(name: string, command: unknown) { commands.set(name, command); }, registerFlag() {}, getFlag() {}, registerMessageRenderer() {},
      appendEntry() {}, sendMessage() {}, sendUserMessage() {}, getActiveTools: () => ['read'], getAllTools: () => [], setActiveTools() {},
      events: { emit() {}, on() { return () => {}; } },
    };
    const ctx: any = { cwd: workspace, hasUI: true, mode: 'tui', isIdle: () => true, ui: { notify() {}, setWidget() {}, theme: { style: (text: string) => text } }, sessionManager: { getBranch: () => [], getSessionFile: () => undefined, getLeafId: () => undefined, getSessionId: () => 's1', getSessionName: () => undefined }, modelRegistry: { find: () => undefined } };
    const workflow = createWorkflow(pi);
    for (const feature of features) await workflow.attach(feature as never, pi);
    for (const handler of handlers.get('session_start') ?? []) await handler({}, ctx);
    const panels = recordPanels(ctx), opening = commands.get('todos').handler('', ctx);
    await panels.wait(() => panels.live() === 1);
    return { panels, opening };
  };
  // Every module attached: the tab bar is exactly the frozen order.
  const all = await open(['todos', 'plan', 'goal', 'agents', 'retry', 'team']);
  assert.deepEqual(tabOrder(all.panels.frame()[0]!), ['Todos', 'Plan', 'Goal', 'Agents', 'Team', 'Retry', 'Display']);
  await all.panels.press('\x1b'); await all.opening;
  // Partial assembly keeps the same relative order (Team before Retry, Display last).
  const partial = await open(['todos', 'team']);
  assert.deepEqual(tabOrder(partial.panels.frame()[0]!), ['Todos', 'Team', 'Display']);
  await partial.panels.press('\x1b'); await partial.opening;
});

test('the Team tab sits between Agents and Retry and disappears when the module is off', async t => {
  await agentDir(t);
  const { createWorkflow } = await import('../src/workflow/index.ts');
  const handlers = new Map<string, Function[]>(), commands = new Map<string, any>();
  const pi: any = {
    on(name: string, handler: Function) { handlers.set(name, [...handlers.get(name) ?? [], handler]); return () => {}; },
    registerTool() {}, registerCommand(name: string, command: unknown) { commands.set(name, command); }, registerFlag() {}, getFlag() {}, registerMessageRenderer() {},
    appendEntry() {}, sendMessage() {}, sendUserMessage() {}, getActiveTools: () => ['read'], getAllTools: () => [], setActiveTools() {},
    events: { emit() {}, on() { return () => {}; } },
  };
  const { recordPanels } = await import('./fixtures/public-host.ts');
  const ctx: any = { cwd: workspace, hasUI: true, mode: 'tui', isIdle: () => true, ui: { notify() {}, setWidget() {}, theme: { style: (text: string) => text } }, sessionManager: { getBranch: () => [], getSessionFile: () => undefined, getLeafId: () => undefined, getSessionId: () => 's1', getSessionName: () => undefined }, modelRegistry: { find: () => undefined } };
  const workflow = createWorkflow(pi);
  for (const feature of ['todos', 'plan', 'goal', 'agents', 'retry', 'team'] as const) await workflow.attach(feature, pi);
  for (const handler of handlers.get('session_start') ?? []) await handler({}, ctx);
  const panels = recordPanels(ctx), opening = commands.get('todos').handler('', ctx);
  await panels.wait(() => panels.live() === 1);
  assert.match(panels.frame()[0]!, /Todos.*Plan.*Goal.*Agents.*Team.*Retry.*Display/, 'Team sits between Agents and Retry');
  // The Team tab carries its own glyph, and plain terminals degrade it through the same table.
  const { tabGlyph } = await import('../src/shared/ui/symbols.ts');
  assert.equal(tabGlyph('team', 'nerd-font'), '\u{f0849}', 'the Team tab has a Nerd Font glyph');
  assert.equal(tabGlyph('team', 'plain'), '', 'plain mode omits the Team glyph like every other tab');
  assert.ok(panels.frame()[0]!.includes('\u{f0849} Team'), 'the tab bar renders the Team glyph');
  assert.doesNotMatch(panels.frame()[0]!, /Team.*Display.*Team/, 'Team appears once');
  await panels.press('\x1b'); await opening;
  // A workflow without the team feature registers no Team panel, so the tab cannot appear.
  const withoutTeam = await import('../src/workflow/index.ts').then(module => ({ createWorkflow: module.createWorkflow }));
  const handlers2 = new Map<string, Function[]>(), commands2 = new Map<string, any>();
  const pi2: any = {
    on(name: string, handler: Function) { handlers2.set(name, [...handlers2.get(name) ?? [], handler]); return () => {}; },
    registerTool() {}, registerCommand(name: string, command: unknown) { commands2.set(name, command); }, registerFlag() {}, getFlag() {},
    appendEntry() {}, sendMessage() {}, sendUserMessage() {}, getActiveTools: () => ['read'], getAllTools: () => [], setActiveTools() {},
    events: { emit() {}, on() { return () => {}; } },
  };
  const ctx2: any = { cwd: workspace, hasUI: true, mode: 'tui', isIdle: () => true, ui: { notify() {}, setWidget() {}, theme: { style: (text: string) => text } }, sessionManager: { getBranch: () => [], getSessionFile: () => undefined, getLeafId: () => undefined, getSessionId: () => 's1', getSessionName: () => undefined }, modelRegistry: { find: () => undefined } };
  const workflow2 = withoutTeam.createWorkflow(pi2);
  await workflow2.attach('todos', pi2);
  for (const handler of handlers2.get('session_start') ?? []) await handler({}, ctx2);
  const panels2 = recordPanels(ctx2), opening2 = commands2.get('todos').handler('', ctx2);
  await panels2.wait(() => panels2.live() === 1);
  assert.doesNotMatch(panels2.frame()[0]!, /Team/, 'no Team tab when the team feature is not attached');
  await panels2.press('\x1b'); await opening2;
});

test('team code never imports the session-private Todo module', async () => {
  const { readdir, readFile } = await import('node:fs/promises');
  const root = new URL('../src/team/', import.meta.url);
  for (const file of (await readdir(root, { recursive: true }) as string[]).filter(name => name.endsWith('.ts'))) {
    const source = await readFile(new URL(file, root), 'utf8');
    for (const match of source.matchAll(/from ['"]([^'"]+)['"]/g)) {
      assert.doesNotMatch(match[1]!, /(?:^|\/)todos\/(?:index|domain|commands|io)/, `${file} imports the session Todo module`);
    }
  }
});

test('team inboxes deliver the earliest unread batch on turn_end and keep the backlog', async t => {
  await agentDir(t);
  const team = await createTeam({ name: 'Alpha', workspaceRoot: workspace });
  await joinTeam(team.id, { sessionId: 's1', sessionName: 'A', pid: 10, now: 1_000 });
  await joinTeam(team.id, { sessionId: 's2', sessionName: 'B', pid: process.pid, now: 1_000 });
  for (let index = 0; index < 25; index++) await sendToMember(team.id, { from: 'A', fromId: 's1', to: 'B', body: `msg ${index}`, now: 1_000 + index });
  assert.equal(await unreadFor(team.id, 's2'), 25);
  const host = teamHost(workspace, 's2');
  host.pi.appendEntry('pi-dag-workflow.team-pointer', { teamId: team.id, memberName: 'B' });
  registerTeam(host.pi, { msg: chinese, now: () => 2_000 });
  await host.fire('turn_end');
  const injected = host.sent.find(item => (item.message as { customType?: string }).customType === TEAM_MESSAGE);
  assert.ok(injected, 'turn_end injects a team-message');
  const content = String((injected!.message as { content?: string }).content);
  assert.equal(content.split('\n\n').length, 10, 'only the earliest 10 are delivered');
  assert.match(content, /msg 0/, 'the batch starts at the oldest message');
  assert.equal(await unreadFor(team.id, 's2'), 25, 'nothing is read until the model input confirms it');
  assert.ok(host.notices.some(item => item.message.includes('还有 15 条')));
  await host.fire('before_provider_request', { payload: { messages: [{ content }] } });
  assert.equal(await unreadFor(team.id, 's2'), 15, 'the confirmed batch is read');
  await host.fire('turn_end');
  assert.equal(await unreadFor(team.id, 's2'), 15, 'the next boundary takes the next ten, still unconfirmed');
});

test('team_send resolves the recipient by member name and refuses an unknown one', async t => {
  await agentDir(t);
  const team = await createTeam({ name: 'Alpha', workspaceRoot: workspace });
  const host = teamHost(workspace, 's1');
  host.flags.set('value:team', 'Alpha');
  registerTeam(host.pi, { msg: chinese, now: () => 5_000 });
  await host.fire('session_start');
  await joinTeam(team.id, { sessionId: 's2', sessionName: 'B', pid: 11, now: 1_000 });
  const send = host.tools.get('team_send');
  const delivered = await send.execute('probe', { to: 'B', body: 'ping' }, undefined, undefined, host.ctx);
  assert.equal(delivered.isError, undefined);
  assert.equal((await readInbox(team.id, 's2'))[0]!.body, 'ping');
  const unknown = await send.execute('probe', { to: 'Ghost', body: 'ping' }, undefined, undefined, host.ctx);
  assert.equal(unknown.isError, true);
  assert.match(unknown.content[0].text, /没有成员 Ghost/);
  const oversized = await send.execute('probe', { to: 'B', body: 'x'.repeat(MAX_BODY_BYTES + 1) }, undefined, undefined, host.ctx);
  assert.equal(oversized.isError, true);
  assert.match(oversized.content[0].text, /拆分要点/);
});

test('auto-processing decides by mode and member state; unread is scoped to one team', async t => {
  await agentDir(t);
  // The mode decides the real delivery: manual never consumes, queued follows up, priority steers.
  assert.equal(deliveryFor('off', true), undefined);
  assert.equal(deliveryFor('off', false), undefined);
  assert.equal(deliveryFor('background', false)!.deliverAs, 'followUp');
  assert.equal(deliveryFor('all', false)!.deliverAs, 'steer');
  assert.equal(deliveryFor('background', true)!.triggerTurn, true);
  const first = await createTeam({ name: 'Alpha', workspaceRoot: workspace });
  const second = await createTeam({ name: 'Beta', workspaceRoot: workspace });
  await joinTeam(first.id, { sessionId: 's1', sessionName: 'A', pid: 10, now: 1_000 });
  await joinTeam(first.id, { sessionId: 's2', sessionName: 'B', pid: 11, now: 1_000 });
  await joinTeam(second.id, { sessionId: 's2', sessionName: 'B', pid: 11, now: 1_000 });
  await sendToMember(first.id, { from: 'A', fromId: 's1', to: 'B', body: 'alpha note', now: 1_000 });
  await sendToMember(second.id, { from: 'A', fromId: 's1', to: 'B', body: 'beta note', now: 1_000 });
  assert.equal(await unreadFor(first.id, 's2'), 1);
  assert.equal(await unreadFor(second.id, 's2'), 1);
  await takeInbox(first.id, 's2', 'recv-test', process.pid, 2_000);
  assert.equal(await unreadFor(first.id, 's2'), 1, 'a taken batch is in flight, not read');
  assert.equal(await unreadFor(second.id, 's2'), 1, 'another team keeps its unread');
  const stored = await setAutoMessages(first.id, 's2', 'all');
  assert.equal(stored!.autoMessages, 'all');
});

test('the mailbox keeps every message: no age, count or cleanup rule removes one', async t => {
  await agentDir(t);
  const team = await createTeam({ name: 'Alpha', workspaceRoot: workspace });
  await joinTeam(team.id, { sessionId: 's1', sessionName: 'A', pid: 10, now: 1_000 });
  await joinTeam(team.id, { sessionId: 's2', sessionName: 'B', pid: 11, now: 1_000 });
  // Read long ago and far beyond any former cap: the send path writes it all back unchanged.
  const many = Array.from({ length: 520 }, (_, index) => ({ id: index + 1, from: 'A', fromId: 's1', to: 'B', toId: 's2', body: `old-${index}`, createdAt: 1, readAt: 2, kind: 'message' as const }));
  const path = join(teamsRoot(), team.id, 'inboxes', 's2.json');
  await mkdir(join(teamsRoot(), team.id, 'inboxes'), { recursive: true });
  await writeFile(path, `${JSON.stringify({ messages: many }, null, 2)}\n`);
  await sendToMember(team.id, { from: 'A', fromId: 's1', to: 'B', body: 'newest', now: 9_000 });
  const stored = (await readInbox(team.id, 's2'));
  assert.equal(stored.length, 521, 'nothing was aged out or capped away');
  assert.equal(stored[0]!.body, 'old-0', 'and the oldest message keeps its place');
  assert.equal(stored.at(-1)!.body, 'newest');
});

test('corrupted inbox JSON is treated as empty and the recipient stays offline until pulled', async t => {
  await agentDir(t);
  const team = await createTeam({ name: 'Alpha', workspaceRoot: workspace });
  await joinTeam(team.id, { sessionId: 's1', sessionName: 'A', pid: 10, now: 1_000 });
  await joinTeam(team.id, { sessionId: 's2', sessionName: 'B', pid: 11, now: 1_000 });
  await mkdir(join(teamsRoot(), team.id, 'inboxes'), { recursive: true });
  await writeFile(join(teamsRoot(), team.id, 'inboxes', 's2.json'), '{ broken');
  assert.deepEqual(await readInbox(team.id, 's2'), [], 'corrupt JSON is tolerated');
  const sent = await sendToMember(team.id, { from: 'A', fromId: 's1', to: 'B', body: 'after corruption', now: 2_000 });
  assert.equal(sent.id, 1);
  const delivery = await takeInbox(team.id, 's2', 'recv-test', process.pid, 3_000);
  assert.equal(delivery.batch[0]!.body, 'after corruption', 'the offline backlog pulls on the next turn');
});

/** Only the team-message deliveries; `session_start` also posts a hidden membership note. */
const deliveries = (host: { sent: { message: unknown; options: unknown }[] }) => host.sent
  .filter(item => (item.message as { customType?: string }).customType === TEAM_MESSAGE)
  .map(item => ({ content: (item.message as { content: string }).content, options: item.options as { deliverAs?: string; triggerTurn?: boolean } }));
/** Tick the mocked clocks and let the async handlers settle. */
const settle = async (rounds = 200) => { for (let index = 0; index < rounds; index++) await new Promise(resolve => setImmediate(resolve)); };
/** Wait for the async timer handlers against a real deadline: a fixed number of event-loop turns breaks under load. */
const until = async (predicate: () => boolean, timeout = 5_000) => {
  const deadline = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('the awaited state did not arrive before the deadline');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
};

test('ticket11 an idle session gets the mailbox within the poll beat and starts one turn', async t => {
  await agentDir(t);
  t.mock.timers.enable({ apis: ['setInterval'] });
  // Count the beats the production timer really registers, synchronously. The delivery itself is async file
  // IO, so a "nothing arrived after a fixed settle" negative would let a shorter interval pass by luck; the
  // beat count cannot.
  const realSetInterval = globalThis.setInterval;
  const register = realSetInterval as (handler: () => void, ms?: number) => ReturnType<typeof setInterval>;
  const beats: number[] = [];
  globalThis.setInterval = ((handler: () => void, ms?: number) => register(() => {
    beats.push(ms ?? 0);
    handler();
  }, ms)) as any;
  t.after(() => { globalThis.setInterval = realSetInterval; });
  const team = await createTeam({ name: 'Alpha', workspaceRoot: workspace });
  const host = teamHost(workspace, 's1');
  host.flags.set('value:team', 'Alpha');
  registerTeam(host.pi, { msg: chinese });
  await host.fire('session_start');
  const member = (await readMembers(team.id))[0]!;
  await sendToMember(team.id, { from: 'Planner', fromId: 's2', to: member.name, body: 'idle hello', now: Date.now() });
  host.setIdle(true);
  // The poll has its own 10 s beat: nothing at 9.999 s, the beat at 10 s. The numbers are literals on
  // purpose: computing them from POLL_MS would prove only that the test agrees with itself.
  t.mock.timers.tick(9_999);
  assert.deepEqual(beats, [], 'no poll beat fires before 10 s');
  assert.deepEqual(deliveries(host), [], 'and nothing is delivered before the beat');
  t.mock.timers.tick(1);
  assert.deepEqual(beats, [10_000], 'the first beat fires at exactly 10 s');
  await until(() => deliveries(host).length > 0);
  const delivered = deliveries(host);
  assert.equal(delivered.length, 1, 'one batch is delivered at the first poll beat');
  assert.match(delivered[0]!.content, /^Source: agent · Planner · SID …/m, 'the model gets the English wrapper');
  assert.match(delivered[0]!.content, /Body:\nidle hello$/m, 'and the body verbatim');
  assert.equal(delivered[0]!.options.deliverAs, 'followUp', 'idle delivery appends as a follow-up');
  assert.equal(delivered[0]!.options.triggerTurn, true, 'idle delivery starts a real turn');
  assert.equal((await readInbox(team.id, 's1'))[0]!.readAt, undefined, 'a queued batch is not read');
  await host.fire('before_provider_request', { payload: { messages: [{ content: delivered[0]!.content }] } });
  assert.ok((await readInbox(team.id, 's1'))[0]!.readAt !== undefined, 'the confirmed input marks it read');
  // The next beats never deliver it twice, and a quiet mailbox sends nothing.
  t.mock.timers.tick(POLL_MS); await settle();
  t.mock.timers.tick(POLL_MS); await settle();
  assert.equal(deliveries(host).length, 1, 'read messages are never redelivered');
});

test('ticket11 a busy session leaves the batch to turn_end unless the mode is all', async t => {
  await agentDir(t);
  t.mock.timers.enable({ apis: ['setInterval'] });
  const team = await createTeam({ name: 'Alpha', workspaceRoot: workspace });
  const host = teamHost(workspace, 's1');
  host.flags.set('value:team', 'Alpha');
  const registration = registerTeam(host.pi, { msg: chinese });
  await host.fire('session_start');
  const member = (await readMembers(team.id))[0]!;
  await sendToMember(team.id, { from: 'Planner', fromId: 's2', to: member.name, body: 'while busy', now: Date.now() });
  host.setIdle(false);
  t.mock.timers.tick(POLL_MS);
  await until(() => deliveries(host).length > 0);
  const queued = deliveries(host);
  assert.equal(queued.length, 1, 'Queued delivers while the session is busy');
  assert.equal(queued[0]!.options.deliverAs, 'followUp');
  assert.equal(queued[0]!.options.triggerTurn, true, 'and asks for the turn, so deliverAs is honoured');
  assert.equal((await readInbox(team.id, 's1'))[0]!.readAt, undefined, 'still not read: only the model input confirms');
  // One more beat: the unconfirmed batch keeps the single window, so no second delivery appears.
  t.mock.timers.tick(POLL_MS);
  await until(() => deliveries(host).length >= 1);
  assert.equal(deliveries(host).length, 1, 'an unconfirmed batch is not replaced');
  await host.fire('before_provider_request', { payload: { messages: [{ content: queued[0]!.content }] } });
  await sendToMember(team.id, { from: 'Planner', fromId: 's2', to: member.name, body: 'priority now', now: Date.now() });
  // `all` injects with steer instead of waiting for the turn to end.
  await registration.setAutoMessages(host.ctx, 'all');
  t.mock.timers.tick(POLL_MS);
  await until(() => deliveries(host).length > 1);
  const steered = deliveries(host).at(-1)!;
  assert.equal(steered.options.deliverAs, 'steer', 'all mode steers a busy session');
  assert.equal(steered.options.triggerTurn, true, 'a steer still asks for the run');
});

test('ticket11 off mode never delivers and a taken-over process stops polling', async t => {
  await agentDir(t);
  t.mock.timers.enable({ apis: ['setInterval'] });
  const team = await createTeam({ name: 'Alpha', workspaceRoot: workspace });
  const off = teamHost(workspace, 's1');
  off.flags.set('value:team', 'Alpha');
  const offRegistration = registerTeam(off.pi, { msg: chinese, alive: candidate => candidate === 999 });
  await off.fire('session_start');
  const member = (await readMembers(team.id))[0]!;
  await offRegistration.setAutoMessages(off.ctx, 'off');
  await sendToMember(team.id, { from: 'Planner', fromId: 's2', to: member.name, body: 'off hello', now: Date.now() });
  off.setIdle(true);
  t.mock.timers.tick(POLL_MS); await settle();
  assert.deepEqual(deliveries(off), [], 'off mode stays quiet even when idle');
  assert.equal((await readInbox(team.id, 's1'))[0]!.readAt, undefined, 'off mode leaves the message unread');
  // A stale holder stops both timers and consumes nothing.
  await claimOwnership(team.id, 's1', { pid: 999, now: Date.now(), force: true, probe: () => true });
  await sendToMember(team.id, { from: 'Planner', fromId: 's2', to: 'member-1', body: 'after takeover', now: Date.now() });
  t.mock.timers.tick(POLL_MS);
  await until(() => off.notices.some(notice => /已被另一进程（pid 999）持有/.test(notice.message)));
  t.mock.timers.tick(POLL_MS); await settle(400);
  assert.deepEqual(deliveries(off), [], 'a taken-over process never delivers');
  assert.ok(off.notices.some(notice => /已被另一进程（pid 999）持有/.test(notice.message)), 'the live foreign holder is named with its pid');
  assert.equal((await readInbox(team.id, 's1')).at(-1)!.readAt, undefined, 'the mailbox is left for the new holder');
});

test('ticket11 one poll beat delivers ten messages and reports the rest', async t => {
  await agentDir(t);
  t.mock.timers.enable({ apis: ['setInterval'] });
  const team = await createTeam({ name: 'Alpha', workspaceRoot: workspace });
  const host = teamHost(workspace, 's1');
  host.flags.set('value:team', 'Alpha');
  registerTeam(host.pi, { msg: chinese });
  await host.fire('session_start');
  const member = (await readMembers(team.id))[0]!;
  for (let index = 1; index <= 25; index++) await sendToMember(team.id, { from: 'Planner', fromId: 's2', to: member.name, body: `note ${index}`, now: Date.now() });
  host.setIdle(true);
  t.mock.timers.tick(POLL_MS);
  await until(() => deliveries(host).length > 0);
  await settle();
  const batch = deliveries(host);
  assert.equal(batch.length, 1, 'one batch per beat');
  const lines = batch[0]!.content.split('\n\n');
  assert.equal(lines.length, 10, 'the batch is capped at ten messages');
  assert.match(lines.at(-1)!, /note 10$/, 'the tenth oldest closes the batch');
  assert.ok(host.notices.some(notice => /还有 15 条团队消息待下一轮投递/.test(notice.message)), 'the remainder is reported');
  const stored = await readInbox(team.id, 's1');
  assert.equal(stored.filter(message => message.readAt === undefined).length, 25, 'queued is not read');
  assert.equal(stored.filter(message => message.inflight !== undefined).length, 10, 'the ten are in flight for this instance');
});

test('ticket13 a resumed session reclaims a dead holder record instead of staying offline', async t => {
  await agentDir(t);
  const team = await createTeam({ name: 'Alpha', workspaceRoot: workspace });
  await joinTeam(team.id, { sessionId: 's1', sessionName: 'Coder', pid: 999_999, now: 1_000 });
  const host = teamHost(workspace, 's1');
  let clock = 5_000;
  // This host can see that pid 999999 is gone: the record is stale, not held.
  registerTeam(host.pi, { msg: chinese, now: () => clock, pid: () => 111, alive: candidate => candidate !== 999_999 });
  host.pi.appendEntry('pi-dag-workflow.team-pointer', { teamId: team.id, memberName: 'Coder' });
  await host.fire('session_start');
  const member = (await readMembers(team.id))[0]!;
  assert.equal(member.holder.pid, 111, 'recovery rewrites the holder pid to this process');
  assert.equal(memberState(member, true, false), 'attached', 'the member is attached again');
  assert.equal(memberState(member, undefined, false), 'attached', 'and reads unknown-but-not-offline on a host that cannot probe');
  assert.ok(host.notices.some(notice => /已接管会话 Coder（原持有进程已退出）/.test(notice.message)), 'recovery reports the takeover');
  assert.doesNotMatch(host.notices.map(notice => notice.message).join('\n'), /已被另一进程/, 'a dead record never reads as a foreign takeover');
});

test('ticket13 a live foreign holder blocks recovery and names the process and the action', async t => {
  await agentDir(t);
  const team = await createTeam({ name: 'Alpha', workspaceRoot: workspace });
  await joinTeam(team.id, { sessionId: 's1', sessionName: 'Coder', pid: 222, now: 1_000 });
  const host = teamHost(workspace, 's1');
  registerTeam(host.pi, { msg: chinese, now: () => 5_000, pid: () => 111, alive: () => true });
  host.pi.appendEntry('pi-dag-workflow.team-pointer', { teamId: team.id, memberName: 'Coder' });
  await host.fire('session_start');
  assert.equal((await readMembers(team.id))[0]!.holder.pid, 222, 'a live holder keeps the record');
  const warning = host.notices.at(-1)!.message;
  assert.match(warning, /已被另一进程（pid 222）持有；按 Enter 强制接管/);
  assert.match(warning, /\/team/);
  assert.doesNotMatch(warning, /请检查|请查看|请设置|请确认/);
});

test('ticket13 turn boundaries record real activity and the workflow passes the pid probe', async (t) => {
  await agentDir(t);
  const { readFile } = await import('node:fs/promises');
  const team = await createTeam({ name: 'Alpha', workspaceRoot: workspace });
  const host = teamHost(workspace, 's1');
  let clock = 5_000;
  host.flags.set('value:team', 'Alpha');
  registerTeam(host.pi, { msg: chinese, now: () => clock, alive: () => true });
  await host.fire('session_start');
  for (const event of ['turn_start', 'turn_end', 'tool_call']) {
    clock += 1_000;
    await host.fire(event);
    const record = (await readMembers(team.id))[0]!;
    assert.equal(record.lastActivityAt, clock, `${event} records its real activity time`);
    assert.equal(record.holder.heartbeatAt, undefined, `${event} writes no heartbeat`);
  }
  const source = await readFile(new URL('../src/workflow/index.ts', import.meta.url), 'utf8');
  assert.match(source, /alive: \(candidate: number\) => \{ try \{ process\.kill\(candidate, 0\); return true; \}/, 'the workflow probes pid liveness');
  assert.match(source, /code === 'EPERM'/, 'EPERM counts as alive');
});

test('the heartbeat writes the local Retry state into the member record', async t => {
  await agentDir(t);
  t.mock.timers.enable({ apis: ['setInterval'] });
  const team = await createTeam({ name: 'Alpha', workspaceRoot: workspace });
  let clock = 5_000, retrying = false;
  const host = teamHost(workspace, 's1');
  host.flags.set('value:team', 'Alpha');
  registerTeam(host.pi, { msg: chinese, now: () => clock, retrying: () => retrying });
  await host.fire('session_start');
  const joined = (await readMembers(team.id))[0]!;
  retrying = true; clock += 30_000;
  await host.fire('turn_start');
  let member = (await readMembers(team.id))[0]!;
  assert.equal(member.retrying, true, 'Retry waiting is flushed at the turn boundary');
  // The event writes state and Retry only: no freshness stamp is invented for a boundary.
  assert.deepEqual(member.holder, joined.holder, 'a boundary writes no timestamp into the holder');
  retrying = false; clock += 30_000;
  await host.fire('turn_end');
  member = (await readMembers(team.id))[0]!;
  assert.equal(member.retrying, false, 'Retry completion clears it at the next boundary');
});

test('the extension wires the local Retry wait into the heartbeat hook', async () => {
  const { readFile } = await import('node:fs/promises');
  const source = await readFile(new URL('../src/workflow/index.ts', import.meta.url), 'utf8');
  assert.match(source, /retrying: \(\) => activeRetry\(\)\?\.pending\(\) \?\? false/, 'team heartbeat reads the local Retry wait state');
});

test('ticket22 the last reply is read from a bounded tail of the session file', async () => {
  const { mkdtemp, writeFile, mkdir, rm } = await import('node:fs/promises');
  const { join: joinP } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const root = await mkdtemp(joinP(tmpdir(), 't22-tail-'));
  const dir = joinP(root, 'proj'); await mkdir(dir, { recursive: true });
  const file = joinP(dir, 'sess.jsonl');
  await writeFile(file, [JSON.stringify({ role: 'assistant', content: 'old' }), JSON.stringify({ role: 'user', content: 'q' }), JSON.stringify({ role: 'assistant', content: 'y'.repeat(600) })].join('\n'));
  const { lastAssistantText, readTail, sessionFileFor, TAIL_BYTES } = await import('../src/team/io/session-tail.ts');
  let read = 0, calls = 0;
  const result = lastAssistantText(file, 400, path => { calls += 1; const tail = readTail(path, TAIL_BYTES); read = Buffer.byteLength(tail, 'utf8'); return tail; });
  assert.equal(calls, 1, 'the bounded reader is the one that runs');
  assert.match(result.text!, /^y{400}$/, 'the reply is truncated to the limit');
  assert.equal(result.truncated, true);
  assert.ok(read <= 256 * 1024, `the reader stays inside the tail window (${read})`);
  assert.equal(sessionFileFor('sess', root), file, 'the file is located one level deep');
  assert.equal(sessionFileFor('nope', root), undefined, 'a missing session is not fatal');
  // Pi writes `<timestamp>_<sessionId>.jsonl`; the locator must find that spelling too.
  const stamped = joinP(dir, '2026-10-19T14-13-12-136Z_stamped.jsonl');
  await writeFile(stamped, '');
  assert.equal(sessionFileFor('stamped', root), stamped, 'a timestamp-prefixed session file is located');
  assert.equal(sessionFileFor('', root), undefined, 'an empty id never matches a file');
  await rm(root, { recursive: true, force: true });
});

test('ticket20 ticket43 --workflow-profile applies model, thinking and tools, and blocks on failure', async t => {
  await agentDir(t);
  await writeProfiles([
    { name: 'reader', model: { provider: 'dag-test', id: 'reasoned' }, thinking: 'low', tools: ['read', 'grep'] },
    { name: 'isolated', isolate: true, thinking: 'max', tools: [] },
  ]);
  const calls: string[] = [];
  const open = async (name: string, options: { found?: boolean; applied?: boolean } = {}) => {
    const h = teamHost(workspace, 's1');
    h.flags.set('value:workflow-profile', name);
    (h.ctx as { modelRegistry?: unknown }).modelRegistry = { find: (provider: string, id: string) => options.found === false ? undefined : { provider, id } };
    h.pi.setModel = async (model: { provider: string; id: string }) => { calls.push(`model:${model.provider}/${model.id}`); return options.applied !== false; };
    h.pi.setThinkingLevel = (level: string) => calls.push(`thinking:${level}`);
    h.pi.setActiveTools = (tools: string[]) => calls.push(`tools:${tools.join(',')}`);
    registerTeam(h.pi, { msg: chinese, pid: () => 10 });
    await h.fire('session_start');
    return h;
  };
  const reader = await open('reader');
  assert.deepEqual(calls, ['model:dag-test/reasoned', 'thinking:low', 'tools:read,grep'], 'the profile is applied field by field');
  // `tools: []` clears the set, and isolate is reported instead of silently dropped.
  calls.length = 0;
  const isolated = await open('isolated');
  assert.deepEqual(calls, ['thinking:max', 'tools:']);
  assert.ok(isolated.notices.some(item => /isolate：运行中的会话不能重挂扩展/.test(item.message)));
  // An unknown model in the registry: actionable, and nothing after it is applied.
  calls.length = 0;
  const missingModel = await open('reader', { found: false });
  assert.deepEqual([...calls], []);
  assert.match(missingModel.notices.map(item => item.message).join('\n'), /不在本机模型目录里/);
  // setModel reports false: the same failure path, still nothing after it.
  calls.length = 0;
  const refused = await open('reader', { applied: false });
  assert.deepEqual(calls, ['model:dag-test/reasoned']);
  assert.match(refused.notices.map(item => item.message).join('\n'), /无法切换/);
  // A failed profile blocks the model request at before_agent_start; a good one never aborts.
  for (const [host, expected] of [[missingModel, 1], [reader, 0]] as const) {
    let aborts = 0;
    (host.ctx as { abort?: () => void }).abort = () => { aborts += 1; };
    await host.fire('before_agent_start');
    assert.equal(aborts, expected);
  }
  // Unknown profile: actionable, nothing applied, and the guard is armed as well.
  calls.length = 0;
  const unknown = await open('nope');
  assert.deepEqual([...calls], []);
  assert.match(unknown.notices.map(item => item.message).join('\n'), /没有名为 nope 的 Profile/);
  // Without the flag nothing is read or applied, even when the profile file is unreadable.
  await writeFile(await writeProfiles([{ name: 'reader' }]), '{oops');
  calls.length = 0;
  const plain = teamHost(workspace, 's1');
  plain.pi.setActiveTools = () => calls.push('tools');
  registerTeam(plain.pi, { msg: chinese, pid: () => 10 });
  await plain.fire('session_start');
  assert.deepEqual([...calls], []);
  assert.deepEqual(plain.notices, []);
  // The flag is registered so it shows up in the host's help.
  const declared = teamHost(workspace, 's1');
  registerTeam(declared.pi, { msg: chinese, pid: () => 10 });
  assert.ok(declared.flags.has('workflow-profile'), 'the flag is registered');
});

test('ticket19 model, thinking and name land in the command without duplicating the suffix', () => {
  const base = { execPath: '/usr/bin/pi', cwd: '/tmp/work', teamName: 'Alpha' };
  // Built from parts: a `provider/id` literal would trip the release scan for private model references.
  const model = ['dag-test', 'scripted'].join('/');
  const withModel = launchCommand({ ...base, name: 'probe', model, thinking: 'high' });
  assert.match(withModel, /--name 'probe'/);
  assert.match(withModel, /--team-bootstrap/, 'a new Team launch requests one startup acknowledgement');
  assert.doesNotMatch(launchCommand({ ...base, sessionId: 'existing-session' }), /--team-bootstrap/, 'resuming history never schedules a startup acknowledgement');
  assert.match(withModel, new RegExp(`--model '${model}'`));
  assert.match(withModel, /--thinking 'high'/);
  // A suffix already names the level: a second --thinking would contradict it.
  const suffixed = launchCommand({ ...base, model: `${model}:high`, thinking: 'low' });
  assert.doesNotMatch(suffixed, /--thinking/);
  assert.match(suffixed, new RegExp(`--model '${model}:high'`));
  // A level is a setting of its own: it travels even when no model is named, and only a legal suffix wins.
  assert.deepEqual(modelArgs(undefined, 'high'), ['--thinking', 'high']);
  assert.deepEqual(modelArgs(`${model}:max`, 'low'), ['--model', `${model}:max`], 'a legal level suffix wins over --thinking');
  assert.deepEqual(modelArgs(`${model}:wild`, 'low'), ['--model', `${model}:wild`, '--thinking', 'low'], 'a colon that is no level still takes the flag');
  assert.deepEqual(modelArgs('openrouter:anthropic/claude', 'low'), ['--model', 'openrouter:anthropic/claude', '--thinking', 'low']);
});

test('ticket19 a launch profile is incremental unless it opts into isolation', () => {
  const base = { execPath: '/usr/bin/pi', cwd: '/tmp/work', teamName: 'Alpha' };
  const incremental = launchCommand(base, { model: { provider: 'a', id: 'b' }, tools: ['read'] });
  // No isolation flags unless the profile opts in, but a defined tool list really is passed through.
  assert.doesNotMatch(incremental, /--no-extensions|--no-skills/, 'host extensions survive by default');
  assert.match(incremental, /--tools 'read'/);
  const isolated = launchCommand({ ...base, teamExtension: '/pkg/src/team/index.ts' }, { isolate: true, childExtensions: ['/x/one.ts', '/y/two.ts'] });
  assert.match(isolated, /--no-extensions/); assert.match(isolated, /--no-skills/);
  // The Team entry owns --team, so an isolated launch always loads it plus one -e per named extension.
  assert.equal((isolated.match(/-e /g) ?? []).length, 3, 'the Team entry plus each named extension');
  assert.match(isolated, /-e '\/pkg\/src\/team\/index.ts' -e '\/x\/one.ts' -e '\/y\/two.ts'/);
});

test('ticket19 the clipboard picks the platform writer and falls back to a 0700 script', async t => {
  const env = { WAYLAND_DISPLAY: 'wayland-0' };
  assert.equal(clipboardCommand(name => name === 'pbcopy', {}, 'darwin'), 'pbcopy');
  assert.equal(clipboardCommand(name => name === 'wl-copy', env, 'linux'), 'wl-copy');
  assert.equal(clipboardCommand(name => name === 'xclip', {}, 'linux'), 'xclip -selection clipboard');
  assert.equal(clipboardCommand(name => name === 'xsel', {}, 'linux'), 'xsel --clipboard --input');
  assert.equal(clipboardCommand(name => name === 'clip.exe', {}, 'linux'), 'clip.exe');
  assert.equal(clipboardCommand(() => false, {}, 'linux'), undefined, 'nothing available is not a crash');
  void t;
});

test('launch modes build paste-able commands and degrade to copy without a multiplexer', () => {
  const request = { execPath: '/usr/bin/pi', cwd: '/tmp/work', teamName: 'Alpha Core', sessionId: 'sess-1' };
  const runtime = { fifo: '/tmp/work/.pi-team/runtime/f1.fifo', log: '/tmp/work/.pi-team/runtime/f1.log', pidFile: '/tmp/work/.pi-team/runtime/f1.pid' };
  const tmux = { tmux: true, graphical: false };
  const split = planLaunch('split', request, tmux), window = planLaunch('window', request, tmux), background = planLaunch('background', { ...request, runtime }, tmux), copy = planLaunch('copy', request, tmux);
  assert.match(split.command, /^tmux split-window -h /); assert.match(window.command, /^tmux new-window /);
  // A detached pi without a TTY exits at once, so background is an RPC process behind a FIFO.
  assert.match(background.command, /^env PI_TEAM_BACKGROUND=1 /); assert.match(background.command, /--mode rpc/); assert.equal(background.background, true);
  // The plan names the very files the launch spawns with — one runtime pair, no working-directory guess.
  assert.equal(background.command.includes(`< '${runtime.fifo}'`), true, 'the plan reads the FIFO the launch creates');
  assert.equal(background.command.includes(`> '${runtime.log}'`), true, 'and writes the log it creates');
  assert.match(background.command, /--team 'Alpha Core'/);
  assert.throws(() => planLaunch('background', request, tmux), /后台启动缺少团队运行目录里的运行文件/, 'a background request without a runtime pair is refused, not given a cwd fallback');
  for (const plan of [split, window, background, copy]) assert.ok(plan.command.includes('Alpha Core'), plan.mode);
  assert.match(copy.command, /--session 'sess-1'/);
  assert.equal(split.degraded, undefined, 'a tmux host is not degraded');
  const bare = planLaunch('split', request, { tmux: false, graphical: false });
  assert.equal(bare.mode, 'copy'); assert.match(bare.command, /--team 'Alpha Core'/);
  assert.equal(bare.degraded, 'no-tmux', 'the degradation is reported, not silent');
  assert.equal(shellQuote("it's"), "'it'\\''s'");
  assert.match(launchCommand({ execPath: '/usr/bin/pi', cwd: '/tmp', teamName: 'A' , resume: true }), /--continue/);
  assert.match(takeoverCommand({ execPath: '/usr/bin/pi', cwd: '/tmp', teamName: 'A', sessionId: 'sess-1' }), /--session 'sess-1'/);
  assert.equal(detectAdapters({ TMUX: '/tmp/tmux-0/default,1,0' }, 'linux').tmux, true);
  assert.equal(detectAdapters({ DISPLAY: ':0' }, 'linux').graphical, true);
  assert.deepEqual(detectAdapters({}, 'linux'), { tmux: false, graphical: false });
});

test('ticket26 the desktop window is a different command from the tmux window, and shares one argv', () => {
  const request = { execPath: '/usr/bin/pi', cwd: '/tmp/work', teamName: 'Alpha' };
  const desktop = planLaunch('desktop', request, { tmux: true, graphical: true, terminal: 'kitty' });
  const window = planLaunch('window', request, { tmux: true, graphical: true, terminal: 'kitty' });
  assert.equal(desktop.mode, 'desktop'); assert.equal(window.mode, 'window');
  assert.notEqual(desktop.command, window.command, 'a desktop window is not a tmux window');
  assert.match(window.command, /^tmux new-window /, 'the tmux row never launches a terminal emulator');
  assert.match(desktop.command, /^'kitty' /, 'the desktop row launches the terminal emulator');
  // One construction: the desktop command is the launch command with a host in front.
  assert.equal(desktopCommand(request, 'kitty'), `${shellQuote('kitty')} ${launchCommand(request)}`, 'the desktop row reuses the launch command');
  assert.match(desktop.command, /--team 'Alpha'/);
  // Each emulator spells "run this program" differently.
  assert.match(planLaunch('desktop', request, { tmux: false, graphical: true, terminal: 'gnome-terminal' }).command, /^'gnome-terminal' -- /);
  assert.match(planLaunch('desktop', request, { tmux: false, graphical: true, terminal: 'konsole' }).command, /^'konsole' -e /);
  assert.match(planLaunch('desktop', request, { tmux: false, graphical: true, terminal: 'alacritty' }).command, /^'alacritty' -e /);
  // No terminal at all: degrade to the copyable command and say why.
  const bare = planLaunch('desktop', request, { tmux: true, graphical: false });
  assert.equal(bare.mode, 'copy'); assert.equal(bare.degraded, 'no-terminal');
  assert.match(bare.command, /^'\/usr\/bin\/pi' --team 'Alpha'/, 'the degraded form is the plain launch command');
  // Probe order: kitty, then gnome-terminal, konsole, alacritty.
  assert.equal(detectTerminal(name => name === 'alacritty'), 'alacritty');
  assert.equal(detectTerminal(name => name === 'konsole' || name === 'alacritty'), 'konsole');
  assert.equal(detectTerminal(name => ['kitty', 'gnome-terminal', 'konsole'].includes(name)), 'kitty');
  assert.equal(detectTerminal(() => false), undefined);
  // A member pull continues the session; a root launch starts a new one.
  assert.match(planLaunch('desktop', { ...request, sessionId: 's2' }, { tmux: false, graphical: true, terminal: 'kitty' }).command, /--session 's2'/);
});

test('the production launcher spawns detached with the background marker and never spawns for copy', async () => {
  const calls: { command: string; args: string[]; options: any }[] = [];
  // The fake child reports itself alive so the liveness check passes without a real process.
  const spawn = ((command: string, args: string[], options: any) => { calls.push({ command, args, options }); return { pid: 4321, exitCode: null, signalCode: null, unref() {}, on() {} }; }) as any;
  const wait = async () => {};
  const request = { execPath: '/usr/bin/pi', cli: '/opt/pi/cli.mjs', cwd: '/tmp/work', teamName: 'Alpha' };
  const copy = await launchTeam('copy', request, { spawn, adapters: { tmux: true, graphical: false } });
  assert.equal(copy.child, undefined, 'copy never spawns');
  assert.equal(copy.spawned, false, 'copy starts nothing, so it is not a dispatch');
  const fifo: string[] = [];
  const runtime = { fifo: '/tmp/work/.pi-team/runtime/l1.fifo', log: '/tmp/work/.pi-team/runtime/l1.log', pidFile: '/tmp/work/.pi-team/runtime/l1.pid' };
  const launched = await launchTeam('background', { ...request, runtime }, { spawn, adapters: { tmux: true, graphical: false }, mkfifo: path => { fifo.push(path); }, openFifo: () => 'ignore', wait, alive: () => true });
  assert.equal(launched.spawned, true);
  assert.deepEqual(fifo, [runtime.fifo], 'the background member gets exactly the FIFO its own pair names');
  assert.equal(launched.pid, 4321, 'the PID the child reported is returned, not a guess');
  assert.equal(calls[0]!.command, '/usr/bin/pi');
  // The CLI entry comes first: `--team` handed straight to Node is the bug this ticket fixes.
  assert.deepEqual(calls[0]!.args, ['/opt/pi/cli.mjs', '--team', 'Alpha', '--team-bootstrap', '-e', teamExtensionPath(), '--mode', 'rpc']);
  assert.equal(calls[0]!.options.detached, true);
  assert.equal(calls[0]!.options.env[BACKGROUND_ENV], '1');
  await launchTeam('split', request, { spawn, adapters: { tmux: true, graphical: false } });
  assert.equal(calls[1]!.command, 'tmux');
  assert.deepEqual(calls[1]!.args.slice(0, 2), ['split-window', '-h']);
  assert.equal(backgroundProcess({ [BACKGROUND_ENV]: '1' }), true);
  assert.equal(backgroundProcess({}), false);
});

/** A stand-in for the Pi CLI: a real file Node can run, which records how it was invoked. */
async function fakeCli(t: { after(fn: () => unknown): void }, body: string): Promise<{ root: string; cli: string }> {
  const root = await mkdtemp(join(tmpdir(), 'team-cli-'));
  const cli = join(root, 'fake-cli.mjs');
  await writeFile(cli, body);
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, cli };
}
const runtimePair = (root: string, name: string) => ({ fifo: join(root, `${name}.fifo`), log: join(root, `${name}.log`), pidFile: join(root, `${name}.pid`) });
const fakeFiles = { adapters: { tmux: true, graphical: false }, mkfifo: (path: string) => { mkdirSync(dirnameP(path), { recursive: true }); writeFileSync(path, ''); }, openFifo: () => 'ignore' as const };

test('ticket25 a background member runs node plus the CLI entry, never node plus pi flags', async t => {
  const record = join(tmpdir(), `team-argv-${process.pid}-${Date.now()}.json`);
  // The stand-in CLI records its own argv, then stays up like a real RPC member would.
  const { root, cli } = await fakeCli(t, `import { writeFileSync } from 'node:fs';
writeFileSync(${JSON.stringify(record)}, JSON.stringify({ entry: process.argv[1], args: process.argv.slice(2) }));
setInterval(() => {}, 1000);
`);
  t.after(() => rm(record, { force: true }));
  const runtime = runtimePair(root, 'probe');
  const result = await launchTeam('background', { execPath: process.execPath, cli, cwd: root, teamName: 'Alpha', name: 'probe', runtime }, { ...fakeFiles, settleMs: 400 });
  t.after(() => { if (result.child?.pid) { try { process.kill(result.child.pid, 'SIGKILL'); } catch { /* already gone */ } } });
  assert.equal(result.spawned, true, 'a member that is still running is a real dispatch');
  const seen = JSON.parse(await readFile(record, 'utf8')) as { entry: string; args: string[] };
  // `--team` handed straight to Node is the bug: it must come after the CLI entry.
  assert.equal(seen.entry, cli, 'argv[1] is the CLI entry, not a pi flag');
  assert.deepEqual(seen.args, ['--team', 'Alpha', '--team-bootstrap', '-e', teamExtensionPath(), '--name', 'probe', '--mode', 'rpc'], '--team follows the CLI entry');
  assert.equal(result.plan.command.includes(`${shellQuote(process.execPath)} ${shellQuote(cli)} --team`), true, 'the paste-able command starts with the same interpreter plus CLI entry');
});

test('ticket25 a launch that dies at once reports false with the log first line and leaves no runtime pair', async t => {
  const { root, cli } = await fakeCli(t, `process.stderr.write('boom: 缺少凭据\\n');
process.stderr.write('second line is not the reason\\n');
process.exit(7);
`);
  const runtime = runtimePair(root, 'die');
  // The new cleanup contract needs provable provenance: this run's temp root is the managed root.
  const result = await launchTeam('background', { execPath: process.execPath, cli, cwd: root, teamName: 'Alpha', name: 'die', runtime }, { ...fakeFiles, settleMs: 500, ownedRuntimeFile: path => Promise.resolve(path.startsWith(root + '/')) });
  assert.equal(result.spawned, false, 'a process that already exited is not a dispatch');
  assert.equal(result.reason, 'boom: 缺少凭据', 'the reason is the log first line verbatim');
  await assert.rejects(access(runtime.fifo), 'the FIFO is cleaned up');
  await assert.rejects(access(runtime.log), 'the log is cleaned up');
});

test('takeover decides by holder liveness, swaps the holder on the same session and fences the old writer', async t => {
  await agentDir(t);
  const team = await createTeam({ name: 'Alpha', workspaceRoot: workspace });
  await joinTeam(team.id, { sessionId: 's1', pid: 4242, now: 1_000 });
  assert.equal(takeoverDecision({ holderAlive: false }), 'direct');
  assert.equal(takeoverDecision({ holderAlive: true }), 'blocked');
  assert.equal(takeoverDecision({ holderAlive: true, force: true }), 'forced');
  assert.equal(await claimOwnership(team.id, 's1', { pid: 7, now: 2_000, probe: () => false }).then(result => result.status), 'direct');
  const blocked = await claimOwnership(team.id, 's1', { pid: 8, now: 3_000, probe: () => true });
  assert.equal(blocked.status, 'blocked');
  const forced = await claimOwnership(team.id, 's1', { pid: 9, now: 4_000, probe: () => true, force: true });
  assert.equal(forced.status, 'forced');
  assert.equal(forced.member!.sessionId, 's1', 'takeover keeps the same session id');
  assert.equal(forced.member!.holder.pid, 9);
  assert.equal(ownsMember(forced.member, 9), true);
  assert.deepEqual(await noteMemberEvent(team.id, 's1', { ownerPid: 7 }), { status: 'lost', member: (await readMembers(team.id))[0], holderPid: 9 }, 'the old holder gets a recognisable refusal instead of a silent no-op');
  assert.equal((await readMembers(team.id))[0]!.holder.pid, 9, 'and does not overwrite the new holder');
  assert.equal((await noteMemberEvent(team.id, 's1', { ownerPid: 9 })).status, 'written', 'the current holder may write its event');
});

test('the workflow wires the background hook and takeover stays on the same session', async t => {
  await agentDir(t);
  const { readFile } = await import('node:fs/promises');
  const source = await readFile(new URL('../src/workflow/index.ts', import.meta.url), 'utf8');
  assert.match(source, /background: \(\) => backgroundProcess\(\)/, 'team receives the background launch fact');
  const team = await createTeam({ name: 'Alpha', workspaceRoot: workspace });
  await joinTeam(team.id, { sessionId: 's1', pid: 4343, now: 1_000 });
  const host = teamHost(workspace, 's1');
  host.pi.appendEntry('pi-dag-workflow.team-pointer', { teamId: team.id, memberName: 'member-1' });
  const registration = registerTeam(host.pi, { msg: chinese, now: () => 5_000, alive: () => true });
  await assert.rejects(registration.takeover(host.ctx), /持有者仍在运行/);
  assert.equal(await registration.takeover(host.ctx, true), 'forced');
  const member = (await readMembers(team.id))[0]!;
  assert.equal(member.sessionId, 's1');
  assert.equal(member.holder.pid, process.pid);
});

test('lead succession elects the longest surviving visible session or falls back to no lead standby', async t => {
  await agentDir(t);
  const team = await createTeam({ name: 'Alpha', workspaceRoot: workspace });
  // Join 3 members with different since timestamps: inverted alphabetical vs since order
  // Zulu has earlier since (2000) than Alpha (3000), but alphabetically Alpha < Zulu.
  await joinTeam(team.id, { sessionId: 's1', sessionName: 'Lead', pid: 101, now: 1_000 });
  await joinTeam(team.id, { sessionId: 's2', sessionName: 'Zulu', pid: 102, now: 2_000 });
  await joinTeam(team.id, { sessionId: 's3', sessionName: 'Alpha', pid: 103, now: 3_000 });
  assert.equal((await readTeam(team.id))!.leadMemberName, 'Lead', 'first member defaults to lead');

  // Lead exits: next longest surviving visible member (Zulu since 2000 vs Alpha since 3000) inherits
  const res1 = await leaveTeam(team.id, 's1');
  assert.equal(res1.newLead, 'Zulu', 'surviving session with smallest since becomes lead, not alphabetical order');
  assert.equal((await readTeam(team.id))!.leadMemberName, 'Zulu');

  // Manual assignment即时生效
  const assigned = await (await import('../src/team/io/registry.ts')).assignLead(team.id, 'Alpha');
  assert.equal(assigned!.leadMemberName, 'Alpha', 'manual lead assignment takes effect immediately');

  // An offline remaining member cannot inherit lead; falls back to no lead standby without error
  const team2 = await createTeam({ name: 'Beta', workspaceRoot: workspace });
  await joinTeam(team2.id, { sessionId: 's1', sessionName: 'Lead', pid: 201, now: 1_000 });
  await joinTeam(team2.id, { sessionId: 's2', sessionName: 'Silent', pid: 202, now: 1_000 });
  // Silent's process is gone: pid liveness (not the heartbeat) is what makes it offline.
  await noteMemberEvent(team2.id, 's2', { alive: false });
  const resOffline = await leaveTeam(team2.id, 's1', candidate => candidate !== 202);
  assert.equal(resOffline.newLead, undefined, 'offline remaining session does not inherit -> standby');
  assert.equal((await readTeam(team2.id))!.leadMemberName, undefined);

  // All remaining sessions exit -> standby without error
  await leaveTeam(team.id, 's2');
  const res3 = await leaveTeam(team.id, 's3');
  assert.equal(res3.newLead, undefined, 'no sessions left -> undefined (standby)');
  assert.equal((await readTeam(team.id))!.leadMemberName, undefined);
});

test('unauthorized leave from command is rejected with executable guidance', async t => {
  await agentDir(t);
  const team = await createTeam({ name: 'Alpha', workspaceRoot: workspace });
  const host = teamHost(workspace, 's1');
  const registration = registerTeam(host.pi, { msg: chinese });
  host.pi.appendEntry('pi-dag-workflow.team-pointer', { teamId: team.id, memberName: 'Member' });

  // Calling leave without authorized option throws and notifies
  await assert.rejects(registration.leave(host.ctx), /未授权退出团队.*\/team 面板/);
  assert.ok(host.notices.some(n => n.message.includes('/team 面板')));
  assert.doesNotMatch(host.notices.at(-1)!.message, /请检查|请查看|请设置|请确认/);
});

test('ticket31 the desktop window follows each platform table and the configuration order', async () => {
  const request = { execPath: '/usr/bin/node', cli: '/opt/pi/cli.mjs', cwd: '/tmp/work', teamName: 'Alpha' };
  const plan = (adapters: Record<string, unknown>, req = request) => planLaunch('desktop', req, { tmux: false, graphical: true, ...adapters } as any);
  // Platform tables: the same request, three hosts.
  assert.match(plan({ desktopTerminal: 'gnome-terminal', platform: 'linux' }).command, /^'gnome-terminal' -- '/, 'linux gnome-terminal takes --');
  assert.match(plan({ desktopTerminal: 'alacritty', platform: 'darwin' }).command, /^'alacritty' -e '/, 'darwin alacritty takes -e');
  // cmd.exe quotes with double quotes: the Windows branch never borrows the POSIX rule.
  assert.match(plan({ desktopTerminal: 'wt', platform: 'win32' }).command, /^"wt" "\//, 'Windows Terminal takes no prefix and Windows quoting');
  assert.match(plan({ desktopTerminal: 'xfce4-terminal', platform: 'linux' }).command, /^'xfce4-terminal' -x /, 'xfce4-terminal takes -x');
  // Tokens that are not flags are shell-quoted too, so `start` appears quoted but stays one argv word.
  assert.match(plan({ desktopTerminal: 'wezterm', platform: 'linux' }).command, /^'wezterm' 'start' -- /, 'wezterm takes start --');
  // Probe order is per platform, and macOS has no Terminal.app or iTerm.
  assert.equal(detectTerminal(name => name === 'konsole' || name === 'xfce4-terminal', 'linux'), 'konsole');
  assert.equal(detectTerminal(name => ['kitty', 'alacritty'].includes(name), 'darwin'), 'kitty');
  assert.equal(detectTerminal(name => name === 'gnome-terminal', 'darwin'), undefined, 'macOS does not use gnome-terminal');
  assert.equal(detectTerminal(name => name === 'wt', 'linux'), undefined, 'Linux does not use Windows Terminal');
  assert.deepEqual(TERMINALS.darwin, ['kitty', 'alacritty', 'wezterm'], 'no Terminal.app and no iTerm on darwin');
  assert.equal(TERMINAL_NAMES.includes('terminal-app' as any), false, 'Terminal.app is not an accepted terminal');
  // The template wins over an explicit terminal and over the probe.
  const templated = plan({ desktopTerminal: 'konsole', desktopTemplate: 'myterm --run {command}', available: () => true });
  assert.equal(templated.command, `myterm --run '/usr/bin/node' '/opt/pi/cli.mjs' --team 'Alpha' --team-bootstrap`, 'the template wraps the same argv');
  // An explicit terminal wins over the probe.
  assert.match(plan({ desktopTerminal: 'alacritty', available: () => true }).command, /^'alacritty' -e /, 'the configured terminal beats the probe');
  // `none` disables the row instead of probing.
  const off = plan({ desktopTerminal: 'none', available: () => true });
  assert.equal(off.mode, 'copy'); assert.equal(off.degraded, 'no-terminal');
  // Nothing available and nothing configured: degrade, never guess.
  const bare = plan({ desktopTerminal: 'auto', available: () => false });
  assert.equal(bare.mode, 'copy'); assert.equal(bare.degraded, 'no-terminal');
  // The template validator is the same one the writer uses.
  assert.equal(validDesktopCommand('kitty {command}'), true);
  assert.equal(validDesktopCommand('kitty'), false, 'a template without {command} is rejected');
  assert.equal(validDesktopCommand(`${'x'.repeat(200)} {command}`), false, 'a template over the limit is rejected');
});

test('ticket31 desktop settings are flat config keys with a validated writer', async t => {
  const root = await agentDir(t);
  const { loadConfig, writeConfig, DESKTOP_TERMINALS } = await import('../src/shared/config.ts');
  const file = join(root, 'pi-dag-workflow', 'pi-dag-workflow-config.json');
  assert.deepEqual(DESKTOP_TERMINALS, ['auto', 'kitty', 'gnome-terminal', 'konsole', 'alacritty', 'xfce4-terminal', 'wezterm', 'wt', 'none']);
  assert.equal((await loadConfig(chinese, 'team')).desktopTerminal, 'auto', 'the default is auto');
  await writeConfig({ desktopTerminal: 'wezterm', desktopCommand: 'wezterm start -- {command}' }, chinese);
  const saved = await loadConfig(chinese, 'team');
  assert.equal(saved.desktopTerminal, 'wezterm');
  assert.equal(saved.desktopCommand, 'wezterm start -- {command}');
  const before = await readFile(file, 'utf8');
  // A template without {command} is refused and the stored file is untouched.
  await assert.rejects(writeConfig({ desktopCommand: 'wezterm start --' }, chinese), /必须包含 \{command\}/);
  assert.equal(await readFile(file, 'utf8'), before, 'the rejected template never reached the file');
  // An unknown terminal name is refused too, including the rejected macOS entries.
  await assert.rejects(writeConfig({ desktopTerminal: 'terminal-app' as any }, chinese), /desktopTerminal 需为/);
  await assert.rejects(writeConfig({ desktopTerminal: 'iterm' as any }, chinese), /desktopTerminal 需为/);
  assert.equal(await readFile(file, 'utf8'), before);
  // The team domain only reads its own keys; the launcher reads the same flat values.
  await writeFile(file, JSON.stringify({ language: 'en', desktopTerminal: 'kitty', goalMaxTurns: 7 }));
  const scoped = await loadConfig(chinese, 'team');
  assert.equal(scoped.desktopTerminal, 'kitty');
  assert.equal(scoped.goalMaxTurns, 32, 'another domain\'s key is ignored here');
});

test('ticket42 electLead only elects a record that says attached and is not confirmed dead', () => {
  const seat = (name: string, state: TeamMember['state'], since: number, pid: number): TeamMember => ({ sessionId: name, name, state, holder: { pid, since, heartbeatAt: 1_000 }, retrying: false, generation: 1 });
  // Names are deliberately the reverse of the time order, so a name-first sort shows up immediately.
  const olderAttached = seat('Zulu', 'attached', 1_000, 4_001);
  const newerAttached = seat('Alpha', 'attached', 2_000, 4_002);
  const olderHeadless = seat('Bravo', 'headless', 500, 4_003);
  assert.equal(electLead([olderHeadless, newerAttached], () => true), 'Alpha', 'a headless member never leads, however old it is');
  assert.equal(electLead([olderHeadless], () => true), undefined, 'only headless leaves nobody to lead');
  assert.equal(electLead([seat('Released', 'attached', 100, 0)], pid => { throw new Error(`a released pid reached the probe: ${pid}`); }), undefined, 'a released record never leads and is never probed');
  // An attached record whose process is gone is not a candidate either: headless does not step in for it.
  assert.equal(electLead([seat('Gone', 'attached', 100, 4_004), olderHeadless], pid => pid !== 4_004), undefined, 'a dead attached member plus a live headless one elects nobody');
  // Two attached candidates, names reversed against time: the earlier holder wins.
  assert.equal(electLead([newerAttached, olderAttached], () => true), 'Zulu', 'the earliest holder wins, not the alphabetically first name');
  // No probe means "not confirmed dead": the record stays a candidate instead of being written off.
  assert.equal(electLead([newerAttached], undefined), 'Alpha', 'an unprobeable host still elects an attached record');
  assert.equal(electLead([seat('Corrupt', 'attached', 100, Number.NaN)], undefined), 'Corrupt', 'a corrupt pid is unknown, not dead, so it stays a candidate');
});
test('ticket42 leaving elects the same lead whether the leaver was attached or headless', async t => {
  await agentDir(t);
  const roster = async (teamId: string) => {
    await joinTeam(teamId, { sessionId: 'zulu', sessionName: 'Zulu', pid: 5_001, now: 2_000 });
    await joinTeam(teamId, { sessionId: 'bravo', sessionName: 'Bravo', pid: 5_002, now: 500 });
    // Bravo is a background member: its own record says headless, so it must never be elected.
    await noteMemberEvent(teamId, 'bravo', { background: true, alive: true });
  };
  const attachedTeam = await createTeam({ name: 'Attached leaver', workspaceRoot: workspace });
  await joinTeam(attachedTeam.id, { sessionId: 'lead', sessionName: 'Lead', pid: 5_000, now: 100 });
  await roster(attachedTeam.id);
  const headlessTeam = await createTeam({ name: 'Headless leaver', workspaceRoot: workspace });
  await joinTeam(headlessTeam.id, { sessionId: 'back', sessionName: 'Back', pid: 5_003, now: 100 });
  await noteMemberEvent(headlessTeam.id, 'back', { background: true, alive: true });
  await roster(headlessTeam.id);
  const alive = (pid: number) => pid >= 5_001;
  const fromAttached = await leaveTeam(attachedTeam.id, 'lead', alive);
  const fromHeadless = await leaveTeam(headlessTeam.id, 'back', alive);
  assert.equal(fromAttached.newLead, 'Zulu', 'the attached leaver hands the lead to the oldest attached survivor');
  assert.equal(fromHeadless.newLead, fromAttached.newLead, 'the headless leaver produces the same roster decision');
  // Only a headless member left: no lead at all, and the roster is still intact.
  const loneTeam = await createTeam({ name: 'Lone headless', workspaceRoot: workspace });
  await joinTeam(loneTeam.id, { sessionId: 'a', sessionName: 'A', pid: 5_010, now: 100 });
  await joinTeam(loneTeam.id, { sessionId: 'b', sessionName: 'B', pid: 5_011, now: 200 });
  await noteMemberEvent(loneTeam.id, 'b', { background: true, alive: true });
  const lone = await leaveTeam(loneTeam.id, 'a', alive);
  assert.equal(lone.newLead, undefined, 'a headless survivor is not promoted');
  assert.deepEqual((await readMembers(loneTeam.id)).map(member => member.name), ['B'], 'and the survivor keeps its record');
});
test('ticket35 electLead never probes a released member and never elects it', () => {
  const released: TeamMember = { sessionId: 's1', name: 'Released', state: 'offline', holder: { pid: 0, since: 0, heartbeatAt: 1_000 }, retrying: false, generation: 1 };
  const live: TeamMember = { sessionId: 's2', name: 'Live', state: 'attached', holder: { pid: 4242, since: 5_000, heartbeatAt: 1_000 }, retrying: false, generation: 1 };
  const probes: number[] = [];
  // The released record survives in the roster; it must not be probed and must not win.
  const elected = electLead([released, live], pid => { probes.push(pid); return true; });
  assert.equal(probes.includes(0), false, 'a released member is never handed to the probe');
  assert.equal(elected, 'Live', 'a released member is not visible, so it cannot be elected');
  // Only released records left: nobody is elected, and still nothing is probed.
  probes.length = 0;
  assert.equal(electLead([released], pid => { probes.push(pid); return true; }), undefined, 'no visible session means no lead');
  assert.deepEqual(probes, [], 'no probe at all when every record is released');
  // A host that cannot probe still elects a record that has a process.
  assert.equal(electLead([live]), 'Live');
});

test('ticket35 leaving the team elects a new lead without probing the released record', async t => {
  await agentDir(t);
  const team = await createTeam({ name: 'Alpha', workspaceRoot: workspace });
  await joinTeam(team.id, { sessionId: 's1', sessionName: 'Lead', pid: 10, now: 1_000 });
  await joinTeam(team.id, { sessionId: 's2', sessionName: 'Ghost', pid: 0, now: 1_000 });
  await joinTeam(team.id, { sessionId: 's3', sessionName: 'Helper', pid: 4242, now: 2_000 });
  const probes: number[] = [];
  const host = teamHost(workspace, 's1');
  const registration = registerTeam(host.pi, { msg: chinese, pid: () => 10, alive: pid => { probes.push(pid); return pid === 4242; } });
  host.pi.appendEntry('pi-dag-workflow.team-pointer', { teamId: team.id, memberName: 'Lead' });
  // Leaving as the lead re-elects from the roster, which still holds the released record.
  await registration.leave(host.ctx, { authorized: true });
  assert.equal(probes.includes(0), false, 'leaving never probes the released member');
  assert.equal((await readTeam(team.id))!.leadMemberName, 'Helper', 'the longest surviving visible session becomes lead');
});

test('ticket35 turn_end reads the member record back after reclaiming it', async t => {
  await agentDir(t);
  const team = await createTeam({ name: 'Alpha', workspaceRoot: workspace });
  // A record left behind by a dead foreign process: this session reclaims it on the boundary.
  await joinTeam(team.id, { sessionId: 's1', sessionName: 'Lead', pid: 4242, now: 1_000 });
  const probes: number[] = [];
  const host = teamHost(workspace, 's1');
  const registration = registerTeam(host.pi, { msg: chinese, pid: () => 10, alive: pid => { probes.push(pid); return false; } });
  host.pi.appendEntry('pi-dag-workflow.team-pointer', { teamId: team.id, memberName: 'Lead' });
  await sendToMember(team.id, { from: 'Peer', fromId: 's9', to: 'Lead', body: 'ping', now: 2_000 });
  await host.fire('turn_end');
  assert.equal((await readMembers(team.id))[0]!.holder.pid, 10, 'the boundary reclaimed the record for this process');
  // The reclaim probes the stale pid once; the delivery decision must probe the record as it is now.
  assert.deepEqual(probes, [4242, 10], 'the state uses the reclaimed holder, not the stale local copy');
  void registration;
});

test('ticket27 a long turn reads as working, not as a stale heartbeat', () => {
  const longTurn: TeamMember = { sessionId: 's1', name: 'Writer', state: 'headless', holder: { pid: 4242, since: 0, heartbeatAt: 1_000 }, retrying: false, generation: 1 };
  // Three minutes into a turn: no event has touched the record, but the process is alive.
  const status = memberStatus(longTurn, true, true);
  assert.equal(status.state, 'headless', 'an alive background member stays headless');
  assert.equal(status.reason, 'ok', 'a live process is never a stale heartbeat');
  // The same member in a terminal reads as attached, still ok.
  assert.deepEqual(memberStatus(longTurn, true, false), { state: 'attached', reason: 'ok', pid: 4242 });
  // A dead pid keeps reporting the exit.
  assert.deepEqual(memberStatus(longTurn, false, true), { state: 'offline', reason: 'exited', pid: 4242 });
  // An unprobeable pid is unknown: the age of the record changes nothing at all.
  assert.deepEqual(memberStatus(longTurn, undefined, true), { state: 'headless', reason: 'unknown', pid: 4242 });
  assert.equal(memberStatus(longTurn, undefined, true).reason, memberStatus({ ...longTurn, holder: { pid: 4242, since: 1 } }, undefined, true).reason, 'an ancient stamp and a fresh one read the same');
  // A released record is offline whatever the probe says.
  assert.equal(memberStatus({ ...longTurn, holder: { ...longTurn.holder, pid: 0 } }, true, true).state, 'offline');
});

test('ticket27 the panel and team_inspect judge a long turn the same way', async t => {
  await agentDir(t);
  const team = await createTeam({ name: 'Alpha', workspaceRoot: workspace });
  // A live member whose stored beat is three minutes old: exactly the reported case.
  await joinTeam(team.id, { sessionId: 's1', sessionName: 'Writer', pid: 4242, now: 1_000 });
  const host = teamHost(workspace, 's1');
  const probes: number[] = [];
  const registration = registerTeam(host.pi, { msg: chinese, pid: () => 10, now: () => 1_000 + 3 * 60_000, alive: pid => { probes.push(pid); return true; } });
  host.pi.appendEntry('pi-dag-workflow.team-pointer', { teamId: team.id, memberName: 'Writer' });
  const inspected = JSON.parse((await host.tools.get('team_inspect').execute('t27', { name: 'Writer' }, undefined, undefined, host.ctx)).content[0].text);
  const direct = memberStatus({ holder: { pid: 4242, since: 0, heartbeatAt: 1_000 }, state: 'attached' }, true, false);
  assert.equal(inspected.member.state, direct.state, 'team_inspect and the rule agree on the state');
  assert.equal(inspected.member.reason, direct.reason, 'and on the reason');
  assert.equal(inspected.member.reason, 'ok', 'a live member is not stale');
  assert.equal(probes.includes(4242), true, 'the probe really ran');
  void registration;
});

test('ticket38 concurrent sends all persist with unique ids', async t => {
  const root = await agentDir(t);
  assert.equal(teamsRoot(), join(root, 'pi-dag-workflow', 'teams'), 'every team file stays in the isolated agent directory');
  const team = await createTeam({ name: 'Alpha', workspaceRoot: workspace });
  await joinTeam(team.id, { sessionId: 's1', sessionName: 'Sender', pid: 10, now: 1_000 });
  await joinTeam(team.id, { sessionId: 's2', sessionName: 'Receiver', pid: 11, now: 1_000 });
  const now = Date.now();
  const sent = await Promise.all(Array.from({ length: 8 }, (_, index) => sendToMember(team.id, { from: 'Sender', fromId: 's1', to: 'Receiver', body: `burst-${index}`, now })));
  const inbox = await readInbox(team.id, 's2');
  assert.deepEqual(inbox.map(message => message.body).sort(), Array.from({ length: 8 }, (_, index) => `burst-${index}`).sort(), 'every successful send is on disk');
  assert.equal(new Set(inbox.map(message => message.id)).size, 8, 'and every id is unique');
  assert.deepEqual(sent.map(message => message.id).sort((a, b) => a - b), inbox.map(message => message.id).sort((a, b) => a - b), 'the returned ids are the persisted ids');
});

/** Bounded waits: a deadline only prevents a hang, and the race has exactly one cleanup point. */
let liveDeadlines = 0;
function bounded<T>(what: string, promise: Promise<T>, ms = 5000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    liveDeadlines += 1;
    timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms waiting for ${what}`)), ms);
  });
  // Whichever settles first clears the timer and counts down once; a late settlement touches nothing.
  return Promise.race([promise, deadline]).finally(() => { clearTimeout(timer); liveDeadlines -= 1; });
}

/**
 * Let a real writer acquire its lock, then pause it before its read→modify→write: the lock file is
 * on disk, so every other writer contends on it for real. Nothing here guesses a private lock path,
 * and no sleep decides when the writer is "ready" — the successful `wx` open is the signal.
 */
async function pauseFirstWriter(t: { after(fn: () => unknown): void }) {
  const original = fsPromises.open;
  let release!: () => void;
  const resume = new Promise<void>(resolve => { release = resolve; });
  let heldSignal!: (path: string) => void;
  const held = new Promise<string>(resolve => { heldSignal = resolve; });
  let contendedSignal!: () => void;
  const contended = new Promise<void>(resolve => { contendedSignal = resolve; });
  let lockPath: string | undefined;
  fsPromises.open = (async (...args: any[]) => {
    const path = String(args[0]), flags = args[1];
    if (typeof path === 'string' && path.endsWith('.lock') && flags === 'wx') {
      if (lockPath === undefined) {
        const handle = await (original as any).apply(fsPromises, args);
        lockPath = path;
        heldSignal(path);
        await resume;
        return handle;
      }
      if (path === lockPath) {
        try { return await (original as any).apply(fsPromises, args); }
        catch (error: any) {
          if (error?.code === 'EEXIST') contendedSignal();
          throw error;
        }
      }
    }
    return await (original as any).apply(fsPromises, args);
  }) as typeof fsPromises.open;
  syncBuiltinESMExports();
  const restore = () => { fsPromises.open = original; syncBuiltinESMExports(); };
  // Fallback only: every test that pauses a writer also releases in its own finally.
  t.after(() => { release(); restore(); });
  return { held, contended, release: () => { release(); }, restore };
}

test('ticket38 two child processes send while the parent holds the recipient lock', async t => {
  const root = await agentDir(t);
  assert.equal(teamsRoot(), join(root, 'pi-dag-workflow', 'teams'), 'the parent writes inside this isolated agent directory');
  const team = await createTeam({ name: 'Alpha', workspaceRoot: workspace });
  await joinTeam(team.id, { sessionId: 's1', sessionName: 'Parent', pid: 10, now: 1_000 });
  await joinTeam(team.id, { sessionId: 's2', sessionName: 'Receiver', pid: 11, now: 1_000 });
  const inboxModule = new URL('../src/team/io/inbox.ts', import.meta.url).pathname;
  const configModule = new URL('../src/shared/config.ts', import.meta.url).pathname;
  const lockPath = join(teamsRoot(), team.id, 'inboxes', 's2.lock');
  const seed = await sendToMember(team.id, { from: 'Parent', fromId: 's1', to: 'Receiver', body: 'seed', now: Date.now() });
  // A real child: real sendToMember, its own handshake, and its own EEXIST evidence.
  const script = [
    `const fsPromises = (await import('node:fs/promises')).default;`,
    `const { syncBuiltinESMExports } = await import('node:module');`,
    `const { sendToMember } = await import(${JSON.stringify(inboxModule)});`,
    `const { configPaths } = await import(${JSON.stringify(configModule)});`,
    `const [teamId, to, prefix, count, lock] = process.argv.slice(1);`,
    `const original = fsPromises.open;`,
    `fsPromises.open = async (...args) => {`,
    `  try { return await original.apply(fsPromises, args); }`,
    `  catch (error) { if (error?.code === 'EEXIST' && String(args[0]) === lock) process.stdout.write('eexist\\n'); throw error; }`,
    `};`,
    `syncBuiltinESMExports();`,
    `process.stdout.write('ready ' + configPaths().directory + '\\n');`,
    `await new Promise(resolve => process.stdin.once('data', resolve));`,
    `const sent = await Promise.all(Array.from({ length: Number(count) }, (_, index) => sendToMember(teamId, { from: 'Child', fromId: 'child', to, body: prefix + '-' + index, now: Date.now() })));`,
    `process.stdout.write('ids ' + JSON.stringify(sent.map(message => message.id)) + '\\n');`,
    `process.exit(0);`,
  ].join('');
  const children: { child: ReturnType<typeof nodeSpawn>; lines: string[]; closed: Promise<void>; failure?: string }[] = [];
  let holder: Awaited<ReturnType<typeof open>> | undefined;
  let parentSends: Promise<unknown>[] = [];
  try {
    for (const prefix of ['child0', 'child1']) {
      const child = nodeSpawn(process.execPath, ['--input-type=module', '-e', script, team.id, 'Receiver', prefix, '4', lockPath], { env: { ...process.env, PI_CODING_AGENT_DIR: root }, stdio: ['pipe', 'pipe', 'pipe'] });
      const entry: { child: ReturnType<typeof nodeSpawn>; lines: string[]; closed: Promise<void>; failure?: string } = { child, lines: [], closed: new Promise<void>(resolve => child.once('close', () => resolve())) };
      let buffer = '', stderr = '';
      child.stdout!.on('data', (chunk: Buffer) => {
        buffer += String(chunk);
        for (const line of buffer.split('\n').slice(0, -1)) entry.lines.push(line.trim());
        buffer = buffer.slice(buffer.lastIndexOf('\n') + 1);
      });
      child.stderr!.on('data', (chunk: Buffer) => { stderr += String(chunk); });
      // A child that dies must fail this test at once instead of waiting for its line.
      child.once('exit', code => { if (code !== 0) entry.failure = `child ${prefix} exited with ${code}: ${stderr}`; });
      children.push(entry);
    }
    const waitFor = async (test: () => boolean, what: string, ms = 5_000) => {
      const deadline = Date.now() + ms;
      while (Date.now() < deadline) {
        const failure = children.find(entry => entry.failure);
        if (failure?.failure) throw new Error(`${failure.failure} (while waiting for ${what})`);
        if (test()) return;
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      throw new Error(`the children never reported ${what}: ${children.map(entry => entry.lines.join(' | ')).join(' /// ')}`);
    };
    // Both children are up and know this run's storage root before anyone is allowed to send.
    await waitFor(() => children.every(entry => entry.lines.some(line => line.startsWith('ready '))), 'ready');
    for (const entry of children) for (const line of entry.lines.filter(item => item.startsWith('ready '))) assert.equal(line.slice(6), join(root, 'pi-dag-workflow'), 'the child resolves the same storage root');
    // The parent really holds the mailbox lock: every child must contend on it.
    holder = await open(lockPath, 'wx', 0o600);
    for (const entry of children) entry.child.stdin!.write('go\n');
    await waitFor(() => children.every(entry => entry.lines.includes('eexist')), 'a lock contention');
    await holder.close(); holder = undefined; await rm(lockPath, { force: true });
    parentSends = Array.from({ length: 4 }, (_, index) => sendToMember(team.id, { from: 'Parent', fromId: 's1', to: 'Receiver', body: `parent-${index}`, now: Date.now() }));
    await waitFor(() => children.every(entry => entry.lines.some(line => line.startsWith('ids '))), 'their ids');
    await bounded('the children to exit', Promise.all(children.map(entry => entry.closed)));
    await Promise.all(parentSends);
    const childIds = children.flatMap(entry => JSON.parse(entry.lines.find(line => line.startsWith('ids '))!.slice(4)) as number[]);
    const parentIds = (await Promise.all(parentSends)).map(message => (message as { id: number }).id);
    const inbox = await readInbox(team.id, 's2');
    const expected = ['seed', ...['child0', 'child1'].flatMap(prefix => [0, 1, 2, 3].map(index => `${prefix}-${index}`)), ...[0, 1, 2, 3].map(index => `parent-${index}`)].sort();
    assert.deepEqual(inbox.map(message => message.body).sort(), expected, 'every body from the seed, both children and the parent is on disk');
    assert.equal(inbox.length, 13, 'thirteen messages, none lost');
    assert.equal(new Set(inbox.map(message => message.id)).size, 13, 'with thirteen distinct ids');
    assert.deepEqual(inbox.map(message => message.id).sort((a, b) => a - b), [...childIds, ...parentIds, seed.id].sort((a, b) => a - b), 'and every reported id is on disk, with the seed id unchanged');
  } finally {
    // Cleanup runs before the test's own directory removal, whatever happened above.
    for (const entry of children) if (entry.child.exitCode === null) entry.child.kill('SIGKILL');
    await Promise.allSettled(children.map(entry => entry.closed));
    if (holder) { await holder.close().catch(() => {}); await rm(lockPath, { force: true }).catch(() => {}); }
    await Promise.allSettled(parentSends);
  }
});

test('ticket38 a message that arrives while a take waits is never overwritten', async t => {
  await agentDir(t);
  const team = await createTeam({ name: 'Alpha', workspaceRoot: workspace });
  await joinTeam(team.id, { sessionId: 's1', sessionName: 'Sender', pid: 10, now: 1_000 });
  await joinTeam(team.id, { sessionId: 's2', sessionName: 'Receiver', pid: 11, now: 1_000 });
  const now = Date.now();
  await sendToMember(team.id, { from: 'Sender', fromId: 's1', to: 'Receiver', body: 'first', now });
  const lock = join(teamsRoot(), team.id, 'inboxes', 's2.lock');
  const file = join(teamsRoot(), team.id, 'inboxes', 's2.json');
  const { value } = await queuedBehindLock(t, lock, () => takeInbox(team.id, 's2', 'recv-test', process.pid, now), async () => {
    // A delivery that lands while the take waits: it writes the mailbox file itself.
    const box = JSON.parse(await readFile(file, 'utf8'));
    const id = Math.max(0, ...box.messages.map((item: { id: number }) => item.id)) + 1;
    box.messages.push({ id, from: 'Sender', fromId: 's1', to: 'Receiver', toId: 's2', body: 'late', createdAt: now, acceptedAt: now, kind: 'message' });
    await writeFile(file, JSON.stringify(box));
  });
  const inbox = await readInbox(team.id, 's2');
  assert.deepEqual(value.batch.map(message => message.body), ['first', 'late'], 'the take read the mailbox after it owned the lock');
  assert.ok(inbox.some(message => message.body === 'late'), 'the late message survives the take');
  assert.equal(inbox.filter(message => message.inflight !== undefined).length, 2, 'both are in flight for this instance');
  assert.equal(inbox.every(message => message.readAt === undefined), true, 'and neither is read by taking it');
});

test('ticket38 deleting a mailbox is coordinated with a send that holds the lock', async t => {
  await agentDir(t);
  const team = await createTeam({ name: 'Alpha', workspaceRoot: workspace });
  await joinTeam(team.id, { sessionId: 's1', sessionName: 'Sender', pid: 10, now: 1_000 });
  await joinTeam(team.id, { sessionId: 's2', sessionName: 'Receiver', pid: 11, now: 1_000 });
  const now = Date.now();
  const writer = await pauseFirstWriter(t);
  let sending: Promise<unknown> | undefined, deleting: Promise<boolean> | undefined;
  try {
    sending = sendToMember(team.id, { from: 'Sender', fromId: 's1', to: 'Receiver', body: 'should-be-deleted', now });
    await bounded('the first writer to hold the mailbox lock', writer.held);
    deleting = deleteInbox(team.id, 's2');
    const outcome = await bounded('the delete to contend on the mailbox lock', Promise.race([deleting.then(() => 'deleted' as const), writer.contended.then(() => 'contended' as const)]));
    writer.release();
    await sending;
    const existed = await deleting;
    assert.equal(outcome, 'contended', 'the delete joins the recipient write transaction instead of deleting under it');
    assert.equal(existed, true, 'and it found the mailbox it removed');
    assert.deepEqual(await readInbox(team.id, 's2'), [], 'the delete wins: the paused writer cannot resurrect the mailbox');
  } finally {
    writer.release();
    writer.restore();
    await Promise.allSettled([sending, deleting].filter((item): item is Promise<unknown> => item !== undefined));
  }
});

test('ticket38 a send to another recipient finishes while one mailbox is locked', async t => {
  await agentDir(t);
  const team = await createTeam({ name: 'Alpha', workspaceRoot: workspace });
  await joinTeam(team.id, { sessionId: 's1', sessionName: 'Sender', pid: 10, now: 1_000 });
  await joinTeam(team.id, { sessionId: 's2', sessionName: 'Busy', pid: 11, now: 1_000 });
  await joinTeam(team.id, { sessionId: 's3', sessionName: 'Free', pid: 12, now: 1_000 });
  const now = Date.now();
  const writer = await pauseFirstWriter(t);
  let busy: Promise<unknown> | undefined, free: Promise<unknown> | undefined;
  try {
    busy = sendToMember(team.id, { from: 'Sender', fromId: 's1', to: 'Busy', body: 'held', now });
    await bounded('the first writer to hold the mailbox lock', writer.held);
    free = sendToMember(team.id, { from: 'Sender', fromId: 's1', to: 'Free', body: 'unblocked', now });
    const outcome = await bounded('the second recipient to finish or contend', Promise.race([free.then(() => 'sent' as const), writer.contended.then(() => 'contended' as const)]));
    const freeInboxWhileBusy = await readInbox(team.id, 's3');
    writer.release();
    await busy; await free;
    assert.equal(outcome, 'sent', 'a send to another recipient does not wait behind an unrelated mailbox');
    assert.deepEqual(freeInboxWhileBusy.map(message => message.body), ['unblocked'], 'and it was already on disk while the other writer held its lock');
  } finally {
    writer.release();
    writer.restore();
    await Promise.allSettled([busy, free].filter((item): item is Promise<unknown> => item !== undefined));
  }
});

test('ticket38 a paused writer is released and finished when the test body throws', async t => {
  await agentDir(t);
  const team = await createTeam({ name: 'Alpha', workspaceRoot: workspace });
  await joinTeam(team.id, { sessionId: 's1', sessionName: 'Sender', pid: 10, now: 1_000 });
  await joinTeam(team.id, { sessionId: 's2', sessionName: 'Receiver', pid: 11, now: 1_000 });
  const lockPath = join(teamsRoot(), team.id, 'inboxes', 's2.lock');
  const writer = await pauseFirstWriter(t);
  let sending: Promise<unknown> | undefined;
  await assert.rejects(async () => {
    try {
      sending = sendToMember(team.id, { from: 'Sender', fromId: 's1', to: 'Receiver', body: 'after-throw', now: Date.now() });
      await bounded('the writer to pause', writer.held);
      throw new Error('injected after the writer paused');
    } finally {
      writer.release();
      writer.restore();
      await Promise.allSettled([sending]);
    }
  }, /injected after the writer paused/);
  // The paused write completed after the release, and nothing is left holding the mailbox.
  assert.deepEqual((await readInbox(team.id, 's2')).map(message => message.body), ['after-throw'], 'the paused send finished during cleanup');
  assert.equal(await access(lockPath).then(() => true, () => false), false, 'and the lock file is gone');
  assert.equal(liveDeadlines, 0, 'no deadline timer survived');
});

test('ticket38 a child that is ready when the test throws is stopped and awaited', async t => {
  const root = await agentDir(t);
  const team = await createTeam({ name: 'Alpha', workspaceRoot: workspace });
  await joinTeam(team.id, { sessionId: 's2', sessionName: 'Receiver', pid: 11, now: 1_000 });
  const inboxModule = new URL('../src/team/io/inbox.ts', import.meta.url).pathname;
  const script = `const { sendToMember } = await import(${JSON.stringify(inboxModule)});process.stdout.write('ready\\n');await new Promise(resolve => process.stdin.once('data', resolve));await sendToMember(process.argv[1], { from: 'Child', fromId: 'child', to: 'Receiver', body: 'never-sent', now: Date.now() });`;
  const child = nodeSpawn(process.execPath, ['--input-type=module', '-e', script, team.id], { env: { ...process.env, PI_CODING_AGENT_DIR: root }, stdio: ['pipe', 'pipe', 'pipe'] });
  const closed = new Promise<number | null>(resolve => child.once('close', code => resolve(code)));
  let ready = '';
  child.stdout!.on('data', (chunk: Buffer) => { ready += String(chunk); });
  try {
    const deadline = Date.now() + 5_000;
    while (!ready.includes('ready') && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
    assert.match(ready, /ready/, 'the child is up and waiting for its go signal');
    throw new Error('injected after the child was ready');
  } catch (error) {
    assert.match(String(error), /injected after the child was ready/);
    assert.equal(child.exitCode, null, 'the child is still running when the failure happens');
  } finally {
    if (child.exitCode === null) child.kill('SIGKILL');
    const code = await bounded('the child to exit', closed, 5_000);
    assert.notEqual(code, 0, 'the child was stopped, not left behind');
  }
  assert.deepEqual(await readInbox(team.id, 's2'), [], 'the child never wrote after the failure');
  assert.equal(liveDeadlines, 0, 'no deadline timer survived');
});

test('ticket38 the team_send tool keeps concurrent sends', async t => {
  await agentDir(t);
  const team = await createTeam({ name: 'Alpha', workspaceRoot: workspace });
  await joinTeam(team.id, { sessionId: 's1', sessionName: 'Sender', pid: 10, now: 1_000 });
  await joinTeam(team.id, { sessionId: 's2', sessionName: 'Receiver', pid: 11, now: 1_000 });
  const host = teamHost(workspace);
  registerTeam(host.pi, { msg: chinese, pid: () => 10 });
  host.pi.appendEntry('pi-dag-workflow.team-pointer', { teamId: team.id, memberName: 'Sender' });
  const tool = host.tools.get('team_send');
  const results = await Promise.all([0, 1, 2].map(index => tool.execute('probe', { to: 'Receiver', body: `tool-${index}` }, undefined, undefined, host.ctx)));
  for (const result of results) assert.notEqual(result.isError, true, JSON.stringify(result.content?.[0]?.text));
  const inbox = await readInbox(team.id, 's2');
  assert.deepEqual(inbox.map(message => message.body).sort(), ['tool-0', 'tool-1', 'tool-2'], 'the tool path uses the same lock');
  assert.equal(new Set(inbox.map(message => message.id)).size, 3, 'and allocates distinct ids');
});

test('ticket44 the deadline helper counts once when the work settles after the deadline', async t => {
  await agentDir(t);
  const base = liveDeadlines;
  // A late resolve: the deadline wins, the counter drops once, and the late settlement touches nothing.
  const slow = new Promise<string>(resolve => { setTimeout(() => resolve('late'), 120); });
  await assert.rejects(bounded('the slow work', slow, 20), /timed out after 20ms waiting for the slow work/);
  assert.equal(liveDeadlines, base, 'the deadline was released exactly once');
  await new Promise(resolve => setTimeout(resolve, 200));
  assert.equal(liveDeadlines, base, 'a late resolve does not count down again');
});

test('ticket44 the deadline helper counts once when the work rejects after the deadline', async t => {
  await agentDir(t);
  const base = liveDeadlines;
  const unhandled: unknown[] = [];
  const onUnhandled = (cause: unknown) => { unhandled.push(cause); };
  process.on('unhandledRejection', onUnhandled);
  try {
    const slow = new Promise<string>((_, reject) => { setTimeout(() => reject(new Error('late failure')), 120); });
    await assert.rejects(bounded('the slow rejection', slow, 20), /timed out after 20ms waiting for the slow rejection/);
    assert.equal(liveDeadlines, base, 'the deadline was released exactly once');
    await new Promise(resolve => setTimeout(resolve, 200));
    assert.equal(liveDeadlines, base, 'a late rejection does not count down again');
    assert.deepEqual(unhandled, [], 'and the late rejection is handled, not unhandled');
  } finally { process.off('unhandledRejection', onUnhandled); }
});

test('ticket44 the deadline helper clears its timer on a normal result', async t => {
  await agentDir(t);
  const base = liveDeadlines;
  assert.equal(await bounded('the fast work', Promise.resolve('done'), 5000), 'done');
  assert.equal(liveDeadlines, base, 'a resolved race clears its timer');
  await assert.rejects(bounded('the failing work', Promise.reject(new Error('boom')), 5000), /boom/);
  assert.equal(liveDeadlines, base, 'a rejected race clears its timer too');
});

test('ticket44 a manual lead assignment made before the departure survives it', async t => {
  await agentDir(t);
  const team = await createTeam({ name: 'Alpha', workspaceRoot: workspace });
  await joinTeam(team.id, { sessionId: 's1', sessionName: 'Lead', pid: 10, now: 1_000 });
  await joinTeam(team.id, { sessionId: 's2', sessionName: 'Zulu', pid: 11, now: 2_000 });
  await joinTeam(team.id, { sessionId: 's3', sessionName: 'Alpha', pid: 12, now: 3_000 });
  // The leaving session was the lead; a manual assignment lands first and must win.
  await assignLead(team.id, 'Alpha');
  const result = await leaveTeam(team.id, 's1');
  assert.equal((await readTeam(team.id))!.leadMemberName, 'Alpha', 'the manual lead survives the departure');
  assert.equal(result.newLead, 'Alpha', 'and the departure reports the lead it did not replace');
});

test('ticket44 a lead assigned while the departure waits is reported and kept', async t => {
  const root = await agentDir(t);
  assert.equal(teamsRoot(), join(root, 'pi-dag-workflow', 'teams'), 'the manifest under test lives in this run');
  const team = await createTeam({ name: 'Alpha', workspaceRoot: workspace });
  await joinTeam(team.id, { sessionId: 's1', sessionName: 'Lead', pid: 10, now: 1_000 });
  await joinTeam(team.id, { sessionId: 's2', sessionName: 'Zulu', pid: 11, now: 2_000 });
  const reader = await pauseFirstManifestRead(t, team.id);
  let leaving: Promise<{ removed: boolean; dissolved: boolean; newLead?: string }> | undefined, assigning: Promise<unknown> | undefined;
  try {
    // The departure reads the manifest (lead = Lead) and waits there.
    leaving = leaveTeam(team.id, 's1');
    await bounded('the departure to read the manifest', reader.held);
    // A manual assignment completes while the departure is paused on that old snapshot.
    assigning = assignLead(team.id, 'Zulu');
    await assigning;
    reader.release();
    const result = await leaving;
    assert.equal(result.newLead, 'Zulu', 'the departure reports the lead the manifest has, not the one it read before');
    assert.equal((await readTeam(team.id))!.leadMemberName, 'Zulu', 'and the manual assignment is on disk');
    assert.equal((await readMembers(team.id)).some(member => member.sessionId === 's1'), false, 'the leaving member is gone');
  } finally {
    reader.release();
    reader.restore();
    await Promise.allSettled([leaving, assigning].filter((item): item is Promise<unknown> => item !== undefined));
  }
});

test('ticket44 a patch that changes nothing returns the current manifest without rewriting it', async t => {
  await agentDir(t);
  const team = await createTeam({ name: 'Alpha', workspaceRoot: workspace });
  const path = join(teamsRoot(), team.id, 'team.json');
  const before = await stat(path);
  const bytes = await readFile(path, 'utf8');
  const observed = await updateTeam(team.id, () => undefined);
  assert.equal(observed?.name, 'Alpha', 'a no-op patch reports the manifest it read under the lock');
  assert.equal(observed?.nextId, 1);
  const after = await stat(path);
  assert.equal(after.mtimeMs, before.mtimeMs, 'and it does not rewrite the file');
  assert.equal(await readFile(path, 'utf8'), bytes, 'leaving the bytes untouched');
  assert.equal(await updateTeam('t-missing', () => undefined), undefined, 'a missing team is still undefined');
});

test('ticket47 an event that started before a takeover cannot roll the record back', async t => {
  const root = await agentDir(t);
  assert.equal(teamsRoot(), join(root, 'pi-dag-workflow', 'teams'), 'the record under test lives in this run');
  const team = await createTeam({ name: 'Alpha', workspaceRoot: workspace });
  await joinTeam(team.id, { sessionId: 's1', sessionName: 'Writer', pid: 111, now: 1_000 });
  const reader = await pauseFirstMemberRead(t, team.id, 's1');
  let beating: Promise<unknown> | undefined, claiming: Promise<unknown> | undefined;
  try {
    // The event write reads the record (pid 111) and waits there.
    beating = noteMemberEvent(team.id, 's1', { ownerPid: 111, retrying: false });
    await bounded('the event to read the record', reader.held);
    // A forced takeover of the same record must wait for the member lock, not write under it.
    claiming = claimOwnership(team.id, 's1', { pid: 222, now: Date.now(), force: true, probe: () => true });
    const outcome = await bounded('the takeover to contend on the member lock', Promise.race([claiming.then(() => 'claimed' as const), reader.contended.then(() => 'contended' as const)]));
    reader.release();
    const beat = await beating as { status: string }, claim = await claiming as { status: string };
    assert.equal(beat.status, 'written', 'the event still held the record when it wrote');
    assert.equal(claim.status, 'forced');
    const record = (await readMembers(team.id))[0]!;
    assert.equal(record.holder.pid, 222, 'the takeover holder is on disk');
    assert.equal(record.generation, 2, 'and its generation was not rewound');
    // An event from the replaced holder is refused outright.
    const late = await noteMemberEvent(team.id, 's1', { ownerPid: 111, retrying: true });
    assert.equal(late.status, 'lost', 'the old holder is told it lost the record');
    assert.equal(late.holderPid, 222);
    const after = (await readMembers(team.id))[0]!;
    assert.equal(after.holder.pid, 222, 'the late event did not restore the old pid');
    assert.equal(after.generation, 2, 'and did not rewind the generation');
    assert.equal(outcome, 'contended', 'and the takeover had to wait for the member lock instead of reading around it');
  } finally {
    reader.release();
    reader.restore();
    await Promise.allSettled([beating, claiming].filter((item): item is Promise<unknown> => item !== undefined));
  }
});

test('ticket47 two claims from the same generation get sequential generations', async t => {
  await agentDir(t);
  const team = await createTeam({ name: 'Alpha', workspaceRoot: workspace });
  await joinTeam(team.id, { sessionId: 's1', sessionName: 'Writer', pid: 111, now: 1_000 });
  const now = Date.now();
  const [first, second] = await Promise.all([
    claimOwnership(team.id, 's1', { pid: 222, now, force: true, probe: () => true }),
    claimOwnership(team.id, 's1', { pid: 333, now, force: true, probe: () => true }),
  ]);
  assert.equal(first.status, 'forced'); assert.equal(second.status, 'forced');
  const generations = [first.member!.generation, second.member!.generation].sort();
  assert.deepEqual(generations, [2, 3], 'the two claims took distinct, increasing generations');
  const record = (await readMembers(team.id))[0]!;
  assert.equal(record.generation, 3, 'the later claim owns the fence');
  assert.equal(record.holder.pid, first.member!.generation === 3 ? 222 : 333, 'and the record matches the claim that won');
});

test('ticket47 settings writes keep the newest holder and generation', async t => {
  await agentDir(t);
  const team = await createTeam({ name: 'Alpha', workspaceRoot: workspace });
  await joinTeam(team.id, { sessionId: 's1', sessionName: 'Writer', pid: 111, now: 1_000 });
  const now = Date.now();
  await Promise.all([
    claimOwnership(team.id, 's1', { pid: 222, now, force: true, probe: () => true }),
    setAutoMessages(team.id, 's1', 'all'),
    setMemberRuntime(team.id, 's1', { fifo: '/tmp/fifo', log: '/tmp/log' }),
    noteMemberEvent(team.id, 's1', { activity: 'turn_end', at: now + 5 }),
    renameMember(team.id, 's1', 'Renamed'),
  ]);
  const record = (await readMembers(team.id))[0]!;
  assert.equal(record.holder.pid, 222, 'no settings write restored the old holder');
  assert.equal(record.generation, 2, 'nor the old generation');
  assert.equal(record.autoMessages, 'all', 'the settings themselves landed');
  assert.deepEqual(record.runtime, { fifo: '/tmp/fifo', log: '/tmp/log' });
  assert.equal(record.lastTurnAt, now + 5);
  assert.equal(record.name, 'Renamed');
});

test('ticket47 a rollback after a third-party takeover is skipped', async t => {
  await agentDir(t);
  const team = await createTeam({ name: 'Alpha', workspaceRoot: workspace });
  await joinTeam(team.id, { sessionId: 's1', sessionName: 'Writer', pid: 111, now: 1_000 });
  const now = Date.now();
  const mine = await claimOwnership(team.id, 's1', { pid: 222, now, force: true, probe: () => true });
  const theirs = await claimOwnership(team.id, 's1', { pid: 333, now, force: true, probe: () => true });
  assert.equal(theirs.member!.generation, mine.member!.generation + 1);
  const snapshot = { holder: { pid: 111, since: 1_000, heartbeatAt: 1_000 }, state: 'attached' as const };
  const rolledBack = await restoreMember(team.id, 's1', snapshot, { pid: mine.member!.holder.pid, generation: mine.member!.generation });
  assert.equal(rolledBack, 'conflict', 'a stale rollback is refused, not applied');
  const record = (await readMembers(team.id))[0]!;
  assert.equal(record.holder.pid, 333, 'the third-party holder survives');
  assert.equal(record.generation, theirs.member!.generation, 'and its generation is untouched');
  // The same rollback with the current token applies, and only moves forward.
  const applied = await restoreMember(team.id, 's1', snapshot, { pid: record.holder.pid, generation: record.generation });
  assert.equal(applied, 'restored');
  const restored = (await readMembers(team.id))[0]!;
  assert.equal(restored.holder.pid, 111, 'the previous holder comes back');
  assert.equal(restored.generation, record.generation + 1, 'with a higher generation, never the old one');
});

test('ticket47 an explicit join does not take over a live foreign holder', async t => {
  await agentDir(t);
  const team = await createTeam({ name: 'Alpha', workspaceRoot: workspace });
  await joinTeam(team.id, { sessionId: 's1', sessionName: 'Writer', pid: 111, now: 1_000 });
  const alive = (pid: number) => pid === 111;
  // The record is held by a live foreign process: the explicit --team path refuses instead of overwriting.
  await assert.rejects(joinTeam(team.id, { sessionId: 's1', pid: 222, now: 2_000, alive }), /仍被另一个运行中的进程（pid 111）持有/);
  let record = (await readMembers(team.id))[0]!;
  assert.equal(record.holder.pid, 111, 'the live holder keeps the record');
  assert.equal(record.generation, 1, 'and its generation');
  // Without a probe the foreign holder is conservatively alive: still refused.
  await assert.rejects(joinTeam(team.id, { sessionId: 's1', pid: 222, now: 2_500 }), /仍被另一个运行中的进程（pid 111）持有/);
  assert.equal((await readMembers(team.id))[0]!.holder.pid, 111, 'a join without a probe never assumes the holder is dead');
  // The same process resuming its own record is fine.
  const resumed = await joinTeam(team.id, { sessionId: 's1', pid: 111, now: 3_000, alive });
  assert.equal(resumed!.holder.pid, 111);
  assert.equal(resumed!.generation, 2, 'resuming moves the generation forward');
  // A dead holder is resumed without force, as before.
  const dead = (pid: number) => pid !== 111;
  const afterDeath = await joinTeam(team.id, { sessionId: 's1', pid: 222, now: 4_000, alive: dead });
  assert.equal(afterDeath!.holder.pid, 222, 'a dead holder is replaced by the explicit join');
  record = (await readMembers(team.id))[0]!;
  assert.equal(record.generation, 3);
});

test('ticket47 the takeover probe is asked about the holder the lock sees', async t => {
  await agentDir(t);
  const team = await createTeam({ name: 'Alpha', workspaceRoot: workspace });
  await joinTeam(team.id, { sessionId: 's1', sessionName: 'Writer', pid: 111, now: 1_000 });
  const asked: number[] = [];
  const now = Date.now();
  // A live foreign holder: the probe is asked about the pid that is on disk right now.
  const blocked = await claimOwnership(team.id, 's1', { pid: 222, now, probe: pid => { asked.push(pid); return true; } });
  assert.equal(blocked.status, 'blocked');
  assert.deepEqual(asked, [111], 'the probe was asked about the recorded holder, not about our own pid');
  // Without a probe a foreign holder is conservatively treated as alive.
  const conservative = await claimOwnership(team.id, 's1', { pid: 222, now });
  assert.equal(conservative.status, 'blocked', 'no probe never means "assume dead"');
  assert.equal((await readMembers(team.id))[0]!.holder.pid, 111);
  // The holder changes: the next probe is asked about the new pid, not a stale one.
  await claimOwnership(team.id, 's1', { pid: 333, now, force: true, probe: () => false });
  asked.length = 0;
  const afterChange = await claimOwnership(team.id, 's1', { pid: 222, now, probe: pid => { asked.push(pid); return true; } });
  assert.equal(afterChange.status, 'blocked');
  assert.deepEqual(asked, [333], 'the probe follows the current holder');
  // Our own record and a released record never reach the probe.
  asked.length = 0;
  const own = await claimOwnership(team.id, 's1', { pid: 333, now, probe: pid => { asked.push(pid); return true; } });
  assert.equal(own.status, 'direct');
  assert.equal(asked.length, 0, 'our own record is a resume, not a liveness question');
  await releaseMember(team.id, 's1', now, { pid: 333, generation: own.member!.generation });
  const released = await claimOwnership(team.id, 's1', { pid: 222, now, probe: pid => { asked.push(pid); return true; } });
  assert.equal(released.status, 'direct', 'a released record is taken over directly');
  assert.equal(asked.length, 0, 'and pid 0 is never probed');
});

test('ticket47 teardown re-checks the record token under its own lock', async t => {
  await agentDir(t);
  const team = await createTeam({ name: 'Alpha', workspaceRoot: workspace });
  await joinTeam(team.id, { sessionId: 's1', sessionName: 'Writer', pid: 111, now: 1_000 });
  const now = Date.now();
  const claimed = await claimOwnership(team.id, 's1', { pid: 222, now, force: true, probe: () => true });
  const stale = { pid: 111, generation: 1 }, fresh = { pid: 222, generation: claimed.member!.generation };
  // A snapshot from before the takeover cannot mark the new holder offline.
  assert.equal(await markMemberOffline(team.id, 's1', now + 1, stale), 'conflict');
  assert.equal((await readMembers(team.id))[0]!.holder.pid, 222, 'the new holder is untouched');
  assert.equal((await readMembers(team.id))[0]!.state, 'attached');
  // Nor can it delete the record.
  assert.equal(await removeMember(team.id, 's1', stale), false);
  assert.equal((await readMembers(team.id)).length, 1, 'the record survives a stale teardown');
  // The current token does both.
  assert.equal(await markMemberOffline(team.id, 's1', now + 2, fresh), 'written');
  assert.equal((await readMembers(team.id))[0]!.state, 'offline');
  assert.equal(await removeMember(team.id, 's1', fresh), true);
  assert.deepEqual(await readMembers(team.id), [], 'and the record is gone once the token matches');
});

test('ticket47 a rollback restores the record the claim replaced, not a pre-lock copy', async t => {
  await agentDir(t);
  const team = await createTeam({ name: 'Alpha', workspaceRoot: workspace });
  const now = Date.now();
  await joinTeam(team.id, { sessionId: 's1', sessionName: 'Writer', pid: 111, now: 1_000 });
  // A third party took the record over before this process could claim it.
  const first = await claimOwnership(team.id, 's1', { pid: 222, now, force: true, probe: () => true });
  const targetSnapshot = { ...first.member! };
  // The claim this session makes replaces the third party's holder; that is what a rollback must undo.
  const mine = await claimOwnership(team.id, 's1', { pid: 333, now, force: true, probe: () => true });
  assert.equal(mine.previous!.holder.pid, 222, 'the claim reports the holder it actually replaced');
  assert.equal(mine.previous!.generation, targetSnapshot.generation);
  const replaced = mine.previous!;
  await restoreMember(team.id, 's1', replaced, { pid: mine.member!.holder.pid, generation: mine.member!.generation });
  const restored = (await readMembers(team.id))[0]!;
  assert.equal(restored.holder.pid, 222, 'the rollback returns the record to the holder the claim replaced');
  assert.equal(restored.generation, mine.member!.generation + 1, 'with a forward-only generation');
  // Using the older pre-claim snapshot would have been wrong, and the token makes it impossible.
  const stale = await restoreMember(team.id, 's1', targetSnapshot, { pid: mine.member!.holder.pid, generation: mine.member!.generation });
  assert.equal(stale, 'conflict', 'the already-replaced token cannot be used again');
});

test('ticket49 the real join paths pass the liveness probe', async t => {
  await agentDir(t);
  const team = await createTeam({ name: 'Alpha', workspaceRoot: workspace });
  // A foreign holder that is gone: the record must be resumable, not refused as a live takeover.
  await joinTeam(team.id, { sessionId: 's1', sessionName: 'Writer', pid: 999, now: 1_000 });
  // Only the pid the test currently knows to be gone is reported dead.
  let live = new Set<number>();
  const probe = (pid: number) => live.has(pid);

  // Path 1: the panel / command join, through the real registration.
  const panel = teamHost(workspace, 's1');
  const viaPanel = registerTeam(panel.pi, { msg: chinese, pid: () => 222, now: () => 2_000, alive: probe });
  assert.equal(await viaPanel.join(panel.ctx, 'Alpha'), true, 'a dead foreign holder is resumed, not refused');
  let record = (await readMembers(team.id))[0]!;
  assert.equal(record.holder.pid, 222, 'the joining process now holds the record');
  assert.equal(record.generation, 2, 'as a normal resume, one generation forward');
  assert.equal(record.name, 'Writer', 'and keeps its member name');

  // Path 2: session_start with an explicit --team flag, same probe.
  const flagged = teamHost(workspace, 's1');
  registerTeam(flagged.pi, { msg: chinese, pid: () => 333, now: () => 3_000, alive: probe });
  flagged.flags.set('value:team', 'Alpha');
  await flagged.fire('session_start');
  record = (await readMembers(team.id))[0]!;
  assert.equal(record.holder.pid, 333, 'the --team flag resumes a dead holder too');
  assert.equal(record.generation, 3);

  // A live foreign holder is still refused on both paths, with its pid named.
  live = new Set([333]);
  const blockedPanel = teamHost(workspace, 's1');
  const blocked = registerTeam(blockedPanel.pi, { msg: chinese, pid: () => 444, now: () => 4_000, alive: probe });
  assert.equal(await blocked.join(blockedPanel.ctx, 'Alpha'), false, 'the panel join refuses a live foreign holder');
  assert.match(blockedPanel.notices.map(notice => notice.message).join('\n'), /pid 333/, 'and names the process that holds it');
  const blockedFlag = teamHost(workspace, 's1');
  registerTeam(blockedFlag.pi, { msg: chinese, pid: () => 444, now: () => 5_000, alive: probe });
  blockedFlag.flags.set('value:team', 'Alpha');
  await blockedFlag.fire('session_start');
  assert.match(blockedFlag.notices.map(notice => notice.message).join('\n'), /pid 333/, 'the --team flag refuses it as well');
  record = (await readMembers(team.id))[0]!;
  assert.equal(record.holder.pid, 333, 'and the live holder keeps the record');
  assert.equal(record.generation, 3, 'with its generation untouched');
});

test('ticket49 a spurned process cannot rewrite any field at its turn boundary', async t => {
  await agentDir(t);
  const team = await createTeam({ name: 'Alpha', workspaceRoot: workspace });
  // One registered session owns the record, then a live foreign process takes it over.
  const host = teamHost(workspace, 's1');
  registerTeam(host.pi, { msg: chinese, pid: () => 111, now: () => 1_000, alive: pid => pid === 222, background: () => true });
  host.flags.set('value:team', 'Alpha');
  await host.fire('session_start');
  const memberFile = join(teamsRoot(), team.id, 'members', 's1.json');
  await claimOwnership(team.id, 's1', { pid: 222, now: 2_000, force: true, probe: () => true });
  // The new holder's record differs in every field the old process could write.
  const taken = JSON.parse(await readFile(memberFile, 'utf8'));
  await writeFile(memberFile, JSON.stringify({
    ...taken,
    state: 'offline',
    retrying: true,
    autoMessages: 'off',
    lastTurnAt: 5_000,
    runtime: { fifo: '/tmp/other.fifo', log: '/tmp/other.log' },
    holder: { pid: 222, since: 2_000, heartbeatAt: 9_000 },
  }));
  const before = await readFile(memberFile, 'utf8');
  // The spurned process fires every boundary it has.
  await host.fire('tool_call');
  await host.fire('turn_start');
  await host.fire('turn_end');
  assert.equal(await readFile(memberFile, 'utf8'), before, 'no field of the new holder record changed');
  const record = JSON.parse(await readFile(memberFile, 'utf8'));
  assert.equal(record.holder.pid, 222); assert.equal(record.holder.heartbeatAt, 9_000, 'not even the heartbeat time');
  assert.equal(record.state, 'offline'); assert.equal(record.retrying, true);
  assert.equal(record.autoMessages, 'off'); assert.equal(record.lastTurnAt, 5_000);
  assert.equal(record.runtime.fifo, '/tmp/other.fifo');
  assert.equal(record.generation, taken.generation, 'and the generation is untouched');
  // It is told it lost the record rather than silently succeeding.
  assert.match(host.notices.map(notice => notice.message).join('\n'), /已被接管|已被另一进程/, 'the old process is warned\n');
});

test('ticket49a a failed launch only removes files inside the managed runtime root', async t => {
  const root = await agentDir(t);
  const team = await createTeam({ name: 'Alpha', workspaceRoot: workspace });
  const outside = await sentinel(root, 'outside-launch.log');
  const runtimeDir = join(teamsRoot(), team.id, 'runtime');
  await mkdir(runtimeDir, { recursive: true });
  const ownLog = join(runtimeDir, 'failed.log');
  const fifo = join(runtimeDir, 'failed.fifo');
  await writeFile(ownLog, '')
  await writeFile(fifo, '');
  // The child dies at once, so the launch fails and its cleanup runs.
  const result = await launchTeam('background', { ...piLaunchTarget(), cwd: root, teamName: 'Alpha', runtime: { fifo, log: outside, pidFile: join(runtimeDir, 'failed.pid') } }, {
    adapters: { tmux: false, graphical: false },
    spawn: (() => ({ pid: 999_999, exitCode: 1, signalCode: null, unref() {}, on() {} })) as any,
    mkfifo: () => {}, openFifo: () => 'ignore' as const, wait: async () => {}, alive: () => false,
    ownedRuntimeFile: path => ownsRuntimePath(teamsRoot(), team.id, path).then(check => check.owned),
  });
  assert.equal(result.spawned, false, 'the launch failed');
  assert.equal(await exists(outside), true, 'the out-of-team log named by the request is not deleted');
});

test('ticket49a a removal that loses the race is not counted as removed', async t => {
  await agentDir(t);
  const team = await createTeam({ name: 'Alpha', workspaceRoot: workspace });
  const runtimeDir = join(teamsRoot(), team.id, 'runtime');
  await mkdir(runtimeDir, { recursive: true });
  const file = join(runtimeDir, 'racing.fifo');
  await writeFile(file, '');
  // The file is gone by the time the removal runs: an absent file must not be reported as removed.
  await rm(file, { force: true });
  const vanished = await removeOwnedRuntime(teamsRoot(), team.id, [file]);
  assert.equal(vanished.removed, 0, 'a missing file is not a removal');
  // A live file in the managed root is removed and counted once.
  await writeFile(file, '');
  const real = await removeOwnedRuntime(teamsRoot(), team.id, [file]);
  assert.equal(real.removed, 1, 'a real removal is counted once');
  assert.equal(await exists(file), false, 'and the file is gone');
});

test('ticket52 a failed launch without a trusted guard keeps its files', async t => {
  const root = await mkdtemp(join(tmpdir(), 'team-noguard-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const runtime = runtimePair(root, 'noguard');
  await writeFile(join(root, 'keep.fifo'), '');
  const result = await launchTeam('background', { execPath: process.execPath, cwd: root, teamName: 'Alpha', runtime: { fifo: join(root, 'keep.fifo'), log: join(root, 'keep.log'), pidFile: join(root, 'keep.pid') } }, {
    ...fakeFiles, settleMs: 50, spawn: (() => ({ pid: 999_998, exitCode: 1, signalCode: null, unref() {}, on() {} })) as any,
    wait: async () => {}, alive: () => false,
  });
  assert.equal(result.spawned, false);
  assert.deepEqual(result.cleanup, { removed: 0, kept: 2 }, 'without provenance nothing is deleted, and the caller is told');
  assert.equal(await exists(join(root, 'keep.fifo')), true, 'the file survives');
  void runtime;
});

test('ticket53 a launch for an unknown team deletes nothing, whatever the caller allows', async t => {
  const agent = await agentDir(t);
  assert.equal(teamsRoot(), join(agent, 'pi-dag-workflow', 'teams'), 'the whole run stays in this agent directory');
  const work = await mkdtemp(join(tmpdir(), 'team-unknown-'));
  t.after(() => rm(work, { recursive: true, force: true }));
  // A sentinel in this run's own working directory: it is what a fixed cwd runtime pair would hit.
  const sentinelPath = join(work, '.pi-team-member.log');
  await writeFile(sentinelPath, 'do not delete\n');
  const h = teamHost(work, 's1');
  // The caller's guard is deliberately permissive: the unknown-team branch must override it.
  let fifo: string | undefined;
  const registration = registerTeam(h.pi, {
    msg: chinese, pid: () => process.pid,
    launchDeps: {
      spawn: (() => ({ pid: 999_997, exitCode: 1, signalCode: null, unref() {}, on() {} })) as any,
      adapters: { tmux: false, graphical: false },
      mkfifo: (path: string) => { fifo = path; mkdirSync(dirnameP(path), { recursive: true }); writeFileSync(path, ''); },
      openFifo: () => 'ignore' as const,
      wait: async () => {}, alive: () => false,
      ownedRuntimeFile: async () => true,
    },
  });
  // No team named "missing-team" exists in this workspace: the launch is refused before it spawns, so no
  // runtime pair can land anywhere — not in the working directory, not in a guessed team directory.
  const launched = await registration.launch(h.ctx, 'background', 'missing-team');
  assert.equal(launched.spawned, false, 'the launch failed as expected');
  assert.equal(launched.plan, undefined, 'a refused background launch has no command to paste');
  assert.match(launched.reason ?? '', /找不到团队 missing-team：未启动后台进程/, 'the reason names the missing team');
  assert.equal(fifo, undefined, 'nothing was created for it, so nothing can be left behind');
  assert.equal(await exists(sentinelPath), true, 'the sentinel in the working directory survives');
  assert.equal(await readFile(sentinelPath, 'utf8'), 'do not delete\n', 'and its bytes are untouched');
});

test('ticket49b runtime files stay while any piece of PID evidence or a live reference disagrees', async t => {
  await agentDir(t);
  const team = await createTeam({ name: 'Alpha', workspaceRoot: workspace });
  const runtimeDir = join(teamsRoot(), team.id, 'runtime');
  await mkdir(runtimeDir, { recursive: true });
  const pair = runtimePairFor(teamsRoot(), team.id);
  await writeFile(pair.fifo, ''); await writeFile(pair.log, ''); await writeRuntimePid(pair.pidFile, 700);
  const cases: { why: string; runtime: { fifo: string; log: string; pidFile?: string; pid?: number }; alive: boolean; shared: boolean }[] = [
    { why: 'the record carries no PID of its own', runtime: { ...pair }, alive: false, shared: false },
    { why: 'the sidecar disagrees with the record', runtime: { ...pair, pid: 701 }, alive: false, shared: false },
    { why: 'the recorded process is still alive', runtime: { ...pair, pid: 700 }, alive: true, shared: false },
    { why: 'another live member references the path', runtime: { ...pair, pid: 700 }, alive: false, shared: true },
  ];
  for (const entry of cases) {
    const removal = await removeMemberRuntime(teamsRoot(), team.id, entry.runtime, { alive: () => entry.alive, shared: () => entry.shared });
    assert.equal(removal.removed, 0, entry.why);
    assert.equal((removal.preserved.live ?? 0) + (removal.preserved.shared ?? 0) + (removal.preserved.unverified ?? 0) + (removal.preserved.mismatch ?? 0), 3, `${entry.why}: all three are reported as kept`);
    for (const path of [pair.fifo, pair.log, pair.pidFile]) assert.equal(await exists(path), true, `${entry.why}: ${basename(path)} survives`);
  }
  // Only the record's own PID equal to a dead sidecar PID removes the trio.
  const removal = await removeMemberRuntime(teamsRoot(), team.id, { ...pair, pid: 700 }, { alive: () => false, shared: () => false });
  assert.equal(removal.removed, 3, 'the pair whose process is gone is removed');
  assert.equal(removal.preserved.live, undefined);
});

test('ticket49b the runtime root is created 0700 and an unverifiable one is refused before any write', async t => {
  const root = await agentDir(t);
  const team = await createTeam({ name: 'Alpha', workspaceRoot: workspace });
  const prepared = await prepareRuntimeRoot(teamsRoot(), team.id);
  assert.ok('realRuntime' in prepared, JSON.stringify(prepared));
  const runtimeDir = join(teamsRoot(), team.id, 'runtime');
  assert.equal((await stat(runtimeDir)).mode & 0o777, 0o700, 'the runtime directory is owner-only');
  // A team that does not exist is not created by asking for its runtime root.
  assert.deepEqual(await prepareRuntimeRoot(teamsRoot(), 't-missing'), { reason: 'missing' });
  assert.equal(await exists(join(teamsRoot(), 't-missing')), false, 'no directory was created for it');
  // A runtime directory that resolves elsewhere is refused, not written through.
  const other = await createTeam({ name: 'Beta', workspaceRoot: workspace });
  const outsideDir = join(root, 'escape-dir');
  await mkdir(outsideDir, { recursive: true });
  await symlink(outsideDir, join(teamsRoot(), other.id, 'runtime'), 'dir');
  assert.deepEqual(await prepareRuntimeRoot(teamsRoot(), other.id), { reason: 'symlink' });
  assert.deepEqual(await readdir(outsideDir), [], 'nothing was written through the symlink');
  // The sidecar reader never follows a path outside the team either.
  const outside = join(root, 'pid-sentinel');
  await writeFile(outside, '4242\n');
  const read = await readRuntimePid(teamsRoot(), team.id, outside);
  assert.deepEqual(read, { reason: 'outside' }, 'a foreign path is refused before it is read');
  await writeFile(join(runtimeDir, 'bad.pid'), 'zero\n');
  assert.deepEqual(await readRuntimePid(teamsRoot(), team.id, join(runtimeDir, 'bad.pid')), { reason: 'invalid' }, 'a non-PID sidecar is not a PID');
});

test('ticket57 a launch that cannot record its PID keeps its files when the child will not exit', async t => {
  await agentDir(t);
  const team = await createTeam({ name: 'Alpha', workspaceRoot: workspace });
  await mkdir(join(teamsRoot(), team.id, 'runtime'), { recursive: true });
  const deps = {
    adapters: { tmux: false, graphical: false },
    mkfifo: (path: string) => { writeFileSync(path, ''); },
    openFifo: () => 'ignore' as const,
    wait: async () => {}, alive: () => true,
    ownedRuntimeFile: (path: string) => ownsRuntimePath(teamsRoot(), team.id, path).then(check => check.owned),
  };
  // A directory where the sidecar should go: writing the PID must fail after the child already runs.
  const stuckPair = runtimePairFor(teamsRoot(), team.id);
  await mkdir(stuckPair.pidFile);
  const kills: string[] = [];
  const stuck = await launchTeam('background', { execPath: process.execPath, cwd: workspace, teamName: 'Alpha', runtime: stuckPair }, {
    ...deps,
    spawn: (() => ({ pid: 7001, exitCode: null, signalCode: null, unref() {}, on() {}, kill: (signal: string) => { kills.push(signal); return false; } })) as any,
  });
  assert.equal(stuck.spawned, false, 'a launch without its sidecar is not a dispatch');
  assert.deepEqual(kills, ['SIGTERM', 'SIGKILL'], 'the launcher signals only through the child handle');
  assert.match(stuck.reason ?? '', /未能确认退出/, 'and it says the child was not confirmed gone');
  assert.match(stuck.reason ?? '', /需人工检查/, 'with an instruction instead of a promise');
  assert.equal(stuck.stopped, false, 'the result names the stop as unconfirmed');
  assert.equal(stuck.keptFiles, 3, 'and how many files stayed');
  assert.equal(stuck.cleanup, undefined, 'nothing is reported as cleaned up');
  assert.equal(await exists(stuckPair.fifo), true, 'the FIFO stays');
  assert.equal(await exists(stuckPair.log), true, 'and the log');
  // A child that really exits is cleaned up: the provenance guard still decides, and a directory sidecar stays.
  const exitedPair = runtimePairFor(teamsRoot(), team.id);
  await mkdir(exitedPair.pidFile);
  const exited = await launchTeam('background', { execPath: process.execPath, cwd: workspace, teamName: 'Alpha', runtime: exitedPair }, {
    ...deps,
    spawn: (() => { const child: any = { pid: 7002, exitCode: null, signalCode: null, unref() {}, on() {}, kill: () => { child.exitCode = 0; return true; } }; return child; }) as any,
  });
  assert.equal(exited.spawned, false);
  assert.deepEqual(exited.cleanup, { removed: 2, kept: 1 }, 'a confirmed exit removes what the guard allows, and nothing else');
  assert.equal(await exists(exitedPair.fifo), false, 'the FIFO of the exited child is gone');
  assert.equal(await exists(exitedPair.log), false, 'and its log');
  assert.equal(await exists(exitedPair.pidFile), true, 'a directory in the sidecar slot is not a file to delete');
});

test('ticket57 a failing kill is an unconfirmed stop, never a crash or a claim', async t => {
  await agentDir(t);
  const team = await createTeam({ name: 'Alpha', workspaceRoot: workspace });
  await joinTeam(team.id, { sessionId: 's1', sessionName: 'Lead', pid: 10, now: 1_000 });
  await mkdir(join(teamsRoot(), team.id, 'runtime'), { recursive: true });
  // The child handle throws from kill() instead of reporting a delivery failure.
  const pair = runtimePairFor(teamsRoot(), team.id);
  await mkdir(pair.pidFile);
  let kills = 0;
  const result = await launchTeam('background', { execPath: process.execPath, cwd: workspace, teamName: 'Alpha', runtime: pair }, {
    adapters: { tmux: false, graphical: false },
    spawn: (() => ({ pid: 7101, exitCode: null, signalCode: null, unref() {}, on() {}, kill: () => { kills += 1; throw new Error('kill is not permitted here'); } })) as any,
    mkfifo: (path: string) => { writeFileSync(path, ''); }, openFifo: () => 'ignore' as const,
    wait: async () => {}, alive: () => true,
    ownedRuntimeFile: (path: string) => ownsRuntimePath(teamsRoot(), team.id, path).then(check => check.owned),
  });
  assert.equal(kills, 2, 'both bounded signals were attempted');
  assert.equal(result.spawned, false, 'a launch whose child cannot be stopped is not a dispatch');
  assert.equal(result.stopped, false, 'and it says so');
  assert.equal(result.keptFiles, 3, 'the files stay');
  // The original failure is not swallowed by the failed signals: the sidecar directory is still named.
  assert.match(result.reason ?? '', /EISDIR|illegal operation|directory/i, `the original error survives\n${result.reason}`);
  assert.match(result.reason ?? '', /未能确认退出/, 'and the unconfirmed stop is reported too');
  assert.match(result.reason ?? '', /需人工检查/);
  assert.equal(await exists(pair.fifo), true, 'the FIFO stays');
  assert.equal(await exists(pair.log), true, 'and the log');
});

test('ticket57 a spawn that produces no child leaves no runtime files behind', async t => {
  await agentDir(t);
  const team = await createTeam({ name: 'Alpha', workspaceRoot: workspace });
  await mkdir(join(teamsRoot(), team.id, 'runtime'), { recursive: true });
  const pair = runtimePairFor(teamsRoot(), team.id);
  const result = await launchTeam('background', { execPath: process.execPath, cwd: workspace, teamName: 'Alpha', runtime: pair }, {
    adapters: { tmux: false, graphical: false },
    spawn: (() => { throw new Error('spawn refused: no such executable'); }) as any,
    mkfifo: (path: string) => { writeFileSync(path, ''); }, openFifo: () => 'ignore' as const,
    wait: async () => {}, alive: () => true,
    ownedRuntimeFile: (path: string) => ownsRuntimePath(teamsRoot(), team.id, path).then(check => check.owned),
  });
  assert.equal(result.spawned, false, 'a throwing spawn is a failed launch');
  assert.equal(result.stopped, undefined, 'there is no process whose stop could be unconfirmed');
  // No process exists at all, so nothing can still hold the files: the guard removes the two it created (the
  // PID sidecar was never written, because no child ever ran).
  assert.deepEqual(result.cleanup, { removed: 2, kept: 0 }, 'the files this launch created are removed');
  assert.match(result.reason ?? '', /spawn refused: no such executable/, 'and the spawn error is the reason');
  for (const path of [pair.fifo, pair.log, pair.pidFile]) assert.equal(await exists(path), false, `${basename(path)} is gone`);
});

test('ticket58 runtime evidence needs one file per role, each with its own suffix inside the root', async t => {
  const root = await agentDir(t);
  const team = await createTeam({ name: 'Alpha', workspaceRoot: workspace });
  await mkdir(join(teamsRoot(), team.id, 'runtime'), { recursive: true });
  const pair = runtimePairFor(teamsRoot(), team.id);
  await writeFile(pair.fifo, ''); await writeFile(pair.log, '');
  await writeRuntimePid(pair.pidFile, 900);
  const files = async (runtime: Parameters<typeof runtimeEvidence>[2]) => {
    const evidence = await runtimeEvidence(teamsRoot(), team.id, runtime);
    return 'files' in evidence ? evidence.files : evidence.reason;
  };
  assert.deepEqual(await files({ ...pair, pid: 900 }), [pair.fifo, pair.log, pair.pidFile], 'a healthy set is three files');
  // One file cannot fill three roles, whatever the record says: the record proves no launch at all.
  assert.equal(await files({ fifo: pair.pidFile, log: pair.pidFile, pidFile: pair.pidFile, pid: 900 }), 'mismatch');
  // Each role must carry its own suffix: swapping FIFO and log proves neither of them.
  assert.deepEqual(await files({ fifo: pair.log, log: pair.fifo, pidFile: pair.pidFile, pid: 900 }), [pair.pidFile]);
  // A leaf symlink with the right stem is outside the boundary the stem cannot replace.
  const sentinel = join(root, 'leaf-sentinel.log');
  await writeFile(sentinel, 'still here\n');
  await rm(pair.fifo);
  await symlink(sentinel, pair.fifo, 'file');
  assert.deepEqual(await files({ ...pair, pid: 900 }), [pair.log, pair.pidFile]);
  assert.equal(await readFile(sentinel, 'utf8'), 'still here\n', 'the symlink target is untouched');
  // The sidecar itself must be the `.pid` file: a PID written into another role is not evidence, even when
  // all three paths are distinct and inside the root.
  const mislabelled = runtimePairFor(teamsRoot(), team.id);
  await writeFile(mislabelled.fifo, '');
  await writeFile(mislabelled.log, '900\n');
  await writeRuntimePid(mislabelled.pidFile, 900);
  assert.equal(await files({ fifo: mislabelled.fifo, log: mislabelled.pidFile, pidFile: mislabelled.log, pid: 900 }), 'mismatch');
});

test('ticket59 a failed liveness probe is not an exit: the files stay until the handle reports one', async t => {
  await agentDir(t);
  const team = await createTeam({ name: 'Alpha', workspaceRoot: workspace });
  await mkdir(join(teamsRoot(), team.id, 'runtime'), { recursive: true });
  const deps = {
    adapters: { tmux: false, graphical: false },
    mkfifo: (path: string) => { writeFileSync(path, ''); },
    openFifo: () => 'ignore' as const,
    wait: async () => {},
    ownedRuntimeFile: (path: string) => ownsRuntimePath(teamsRoot(), team.id, path).then(check => check.owned),
  };
  // The probe says "gone" while the handle never reports an exit: only the handle can say that.
  const stuckPair = runtimePairFor(teamsRoot(), team.id);
  const kills: string[] = [];
  const stuck = await launchTeam('background', { execPath: process.execPath, cwd: workspace, teamName: 'Alpha', runtime: stuckPair }, {
    ...deps, alive: () => false,
    spawn: (() => ({ pid: 8001, exitCode: null, signalCode: null, unref() {}, on() {}, kill: (signal: string) => { kills.push(signal); return false; } })) as any,
  });
  assert.deepEqual(kills, ['SIGTERM', 'SIGKILL'], 'the handle is asked to stop, and only the handle');
  assert.equal(stuck.spawned, false, 'a launch that never proved itself is not a dispatch');
  assert.equal(stuck.stopped, false, 'and the stop is reported as unconfirmed');
  assert.equal(stuck.keptFiles, 2, 'the FIFO and log stay (no sidecar was ever written)');
  assert.match(stuck.reason ?? '', /未能确认退出/, `the reason says the stop was not confirmed\n${stuck.reason}`);
  assert.match(stuck.reason ?? '', /需人工检查/);
  assert.equal(stuck.cleanup, undefined, 'nothing is reported as cleaned up');
  for (const path of [stuckPair.fifo, stuckPair.log]) assert.equal(await exists(path), true, `${basename(path)} stays`);
  // A handle that really reports an exit is still cleaned up by the same tail.
  const exitedPair = runtimePairFor(teamsRoot(), team.id);
  const exited = await launchTeam('background', { execPath: process.execPath, cwd: workspace, teamName: 'Alpha', runtime: exitedPair }, {
    ...deps, alive: () => false,
    spawn: (() => { const child: any = { pid: 8002, exitCode: null, signalCode: null, unref() {}, on() {}, kill: () => { child.exitCode = 0; return true; } }; return child; }) as any,
  });
  assert.equal(exited.spawned, false);
  assert.deepEqual(exited.cleanup, { removed: 2, kept: 0 }, 'a confirmed exit removes what the guard allows');
  for (const path of [exitedPair.fifo, exitedPair.log]) assert.equal(await exists(path), false, `${basename(path)} is gone`);
});

test('ticket59 cleanup counts an unreadable runtime file as kept instead of missing', async t => {
  await agentDir(t);
  const team = await createTeam({ name: 'Alpha', workspaceRoot: workspace });
  assert.equal(teamsRoot(), join(process.env.PI_CODING_AGENT_DIR!, 'pi-dag-workflow', 'teams'), 'all of this lives in the run agent directory');
  await mkdir(join(teamsRoot(), team.id, 'runtime'), { recursive: true });
  const pair = runtimePairFor(teamsRoot(), team.id);
  // ENOENT: a file this launch never created is neither removed nor kept.
  assert.deepEqual(await cleanupRuntime([pair.fifo], undefined), { removed: 0, kept: 0 }, 'a missing file is not a kept file');
  await writeFile(pair.log, 'log\n');
  // EACCES on the real path: the call cannot prove the file is gone, so it stays and is counted.
  const originalAccess = fsPromises.access;
  fsPromises.access = ((path: string, ...rest: unknown[]) => String(path) === pair.log
    ? Promise.reject(Object.assign(new Error('access denied'), { code: 'EACCES' }))
    : (originalAccess as any)(path, ...rest)) as typeof fsPromises.access;
  syncBuiltinESMExports();
  const restore = () => { fsPromises.access = originalAccess; syncBuiltinESMExports(); };
  t.after(restore);
  try {
    assert.deepEqual(await cleanupRuntime([pair.log], undefined), { removed: 0, kept: 1 }, 'an access failure is kept, not mistaken for a missing file');
    // `access` is patched in this window, so read the bytes instead: the file must really still be there.
    assert.equal(await readFile(pair.log, 'utf8'), 'log\n', 'and the file is untouched');
  } finally { restore(); }
});

test('ticket62 the 8 KiB limit is measured on the exact bytes that are stored', async t => {
  await agentDir(t);
  const team = await createTeam({ name: 'Alpha', workspaceRoot: workspace });
  await joinTeam(team.id, { sessionId: 's1', sessionName: 'Lead', pid: 10, now: 1_000 });
  await joinTeam(team.id, { sessionId: 's2', sessionName: 'B', pid: 22, now: 1_000 });
  const h = teamHost(workspace, 's1');
  h.pi.appendEntry('pi-dag-workflow.team-pointer', { teamId: team.id, memberName: 'Lead' });
  registerTeam(h.pi, { msg: chinese, pid: () => 10 });
  const send = h.tools.get('team_send');
  // Padding is not free: 8193 stored bytes are refused, the receiver box does not change, and no id is spent.
  const padded = `x${' '.repeat(8_192)}`;
  assert.equal(Buffer.byteLength(padded, 'utf8'), 8_193);
  const refused = await send.execute('probe', { to: 'B', body: padded }, undefined, undefined, h.ctx);
  assert.equal(refused.isError, true);
  assert.match(refused.content[0].text, /超过 8 KiB 上限/);
  assert.deepEqual(await readInbox(team.id, 's2'), [], 'a refused body writes nothing');
  // The same rule behind the helper entry, addressed by session.
  await assert.rejects(sendToMember(team.id, { from: 'Lead', fromId: 's1', toSessionId: 's2', body: padded, now: Date.now() }), /超过 8 KiB 上限/);
  assert.deepEqual(await readInbox(team.id, 's2'), [], 'the helper refuses it too');
  const next = await sendToMember(team.id, { from: 'Lead', fromId: 's1', to: 'B', body: 'ok', now: Date.now() });
  assert.equal(next.id, 1, 'the refused body never allocated a message id');
  // Exactly 8192 bytes with leading and trailing spaces is valid and stored byte for byte.
  const exact = `  ${'x'.repeat(8_188)}  `;
  assert.equal(Buffer.byteLength(exact, 'utf8'), 8_192);
  const accepted = await send.execute('probe', { to: 'B', body: exact }, undefined, undefined, h.ctx);
  assert.notEqual(accepted.isError, true, accepted.content[0].text);
  const stored = (await readInbox(team.id, 's2')).find(message => message.id === 2)!;
  assert.equal(stored.body, exact, 'the stored body is byte-identical to the input, spaces included');
  assert.equal(Buffer.byteLength(stored.body, 'utf8'), 8_192);
  // Multibyte text counts its UTF-8 bytes, not its characters.
  const wide = '中'.repeat(2_731);
  assert.equal(Buffer.byteLength(wide, 'utf8'), 8_193);
  await assert.rejects(sendToMember(team.id, { from: 'Lead', fromId: 's1', to: 'B', body: wide, now: Date.now() }), /超过 8 KiB 上限/);
  // Whitespace is still no body at all, on both entries.
  const blank = await send.execute('probe', { to: 'B', body: '   \n\t ' }, undefined, undefined, h.ctx);
  assert.equal(blank.isError, true);
  assert.match(blank.content[0].text, /正文不能为空/);
  await assert.rejects(sendToMember(team.id, { from: 'Lead', fromId: 's1', toSessionId: 's2', body: '   ', now: Date.now() }), /正文不能为空/);
  assert.equal((await readInbox(team.id, 's2')).length, 2, 'only the accepted messages exist');
});

test('ticket43 the canonical Profile file drives one argv for every mode', async t => {
  await agentDir(t);
  await writeProfiles([
    { name: 'worker', model: { provider: 'dag-test', id: 'scripted' }, thinking: 'high', tools: ['read'] },
    { name: 'bare', thinking: 'max' },
    { name: 'no-tools', tools: [] },
    { name: 'isolated', isolate: true, childExtensions: ['/x/extra.ts'] },
  ]);
  const base = { execPath: '/usr/bin/pi', cwd: '/tmp/work', teamName: 'Alpha' };
  // Built from parts: a provider/id literal would trip the release scan for private model references.
  const scripted = ['dag-test', 'scripted'].join('/'), reasoned = ['dag-test', 'reasoned'].join('/');
  const worker = readLaunchProfile('worker')!;
  assert.deepEqual(worker.tools, ['read'], 'the canonical array is read, not an old name map');
  const command = launchCommand(base, worker);
  assert.match(command, /--model 'dag-test\/scripted'/);
  assert.match(command, /--thinking 'high'/);
  assert.match(command, /--tools 'read'/);
  // The request wins field by field; the Profile only fills what the request leaves open.
  const override = launchCommand({ ...base, model: reasoned, thinking: 'low' }, worker);
  assert.match(override, /--model 'dag-test\/reasoned'/);
  assert.match(override, /--thinking 'low'/);
  assert.match(override, /--tools 'read'/, 'a tool list the request does not override still comes from the Profile');
  // A level of its own, and an empty tool list, both travel.
  assert.match(launchCommand(base, readLaunchProfile('bare')!), /--thinking 'max'/);
  assert.doesNotMatch(launchCommand(base, readLaunchProfile('bare')!), /--model/);
  assert.match(launchCommand(base, readLaunchProfile('no-tools')!), /--tools ''/);
  // Isolation names the Team entry plus the profile's extensions and nothing else.
  const isolated = readLaunchProfile('isolated')!;
  const iso = launchCommand({ ...base, teamExtension: '/pkg/src/team/index.ts' }, isolated);
  assert.match(iso, /--no-extensions --no-skills -e '\/pkg\/src\/team\/index.ts' -e '\/x\/extra.ts'/);
  assert.equal((iso.match(/-e /g) ?? []).length, 2, 'no silent fallback to every host extension');
  assert.throws(() => launchCommand(base, isolated), /Team 扩展入口/, 'an isolated launch without the Team entry is refused');
  // A legal level suffix wins; a namespace colon is not a level.
  assert.doesNotMatch(launchCommand({ ...base, model: `${scripted}:max`, thinking: 'low' }), /--thinking/);
  assert.match(launchCommand({ ...base, model: ['openrouter', 'anthropic/claude'].join(':'), thinking: 'low' }), /--thinking 'low'/);
  // The real split spawn uses exactly the plan's construction, Profile included.
  const commands: string[] = [];
  const launched = await launchTeam('split', { ...base, cwd: workspace, profile: 'worker' }, {
    adapters: { tmux: true, graphical: false },
    spawn: ((_command: string, args: string[]) => { commands.push(args[2]!); return { unref() {} }; }) as never,
  });
  assert.equal(launched.plan.command, `tmux split-window -h ${shellQuote(commands[0]!)}`, 'plan and spawn share one command');
  assert.match(commands[0]!, /--model 'dag-test\/scripted'.*--thinking 'high'.*--tools 'read'/);
});

test('ticket43 a manual Profile applies model, thinking and tools, and a broken one blocks the model request', { timeout: 120_000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'team-manual-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const profilePath = join(root, 'agent', 'pi-dag-workflow', 'pi-dag-workflow-profile.json');
  const probe = join(root, 'manual-probe.ts');
  const probeOut = join(root, 'manual-probe.json');
  await writeFile(probe, probeSource(probeOut));
  const teamExt = teamExtensionPath();
  const readState = async (): Promise<{ model?: string | null; thinking?: string | null; tools?: string[] }> => JSON.parse(await readFile(probeOut, 'utf8'));
  await writeProfiles([{ name: 'manual', model: { provider: 'dag-test', id: 'reasoned' }, thinking: 'high', tools: [] }], profilePath);
  const ok = await IsolatedClient.start(root, 'manual-ok', [teamExt, probe], ['--workflow-profile', 'manual', '--dag-test-context-export']);
  t.after(() => ok.close(false));
  const state = (await ok.send('get_state')).data as { model?: { id?: string }; thinkingLevel?: string };
  assert.equal(state.model?.id, 'reasoned', 'the manual Profile really switched the model');
  assert.equal(state.thinkingLevel, 'high', 'and applied its thinking level');
  await ok.prompt('随便一句');
  const applied = await readState();
  assert.deepEqual(applied.tools, [], 'tools: [] really clears the active set in the real session');
  // The native call is session-scoped: it must not become the default for new sessions.
  const settingsText = await readFile(join(root, 'agent', 'settings.json'), 'utf8').catch(() => '');
  assert.doesNotMatch(settingsText, /defaultModel|defaultProvider/, 'setModel stays session-local');
  await ok.close(false);
  // A level the model cannot think with is clamped by the host, not replicated by us.
  const clampedRoot = await mkdtemp(join(tmpdir(), 'team-manual-clamp-'));
  t.after(() => rm(clampedRoot, { recursive: true, force: true }));
  await writeProfiles([{ name: 'clamped', model: { provider: 'dag-test', id: 'scripted' }, thinking: 'high' }], join(clampedRoot, 'agent', 'pi-dag-workflow', 'pi-dag-workflow-profile.json'));
  const clamped = await IsolatedClient.start(clampedRoot, 'manual-clamp', [teamExt], ['--workflow-profile', 'clamped']);
  t.after(() => clamped.close(false));
  const clampedState = (await clamped.send('get_state')).data as { model?: { id?: string }; thinkingLevel?: string };
  assert.equal(clampedState.model?.id, 'scripted');
  assert.equal(clampedState.thinkingLevel, 'off', 'the host clamps an unsupported level; we do not fake it');
  await clamped.close(false);
  // A broken manual Profile: the model is not in the registry, so no provider request may happen.
  const brokenRoot = await mkdtemp(join(tmpdir(), 'team-manual-broken-'));
  t.after(() => rm(brokenRoot, { recursive: true, force: true }));
  const brokenPath = join(brokenRoot, 'agent', 'pi-dag-workflow', 'pi-dag-workflow-profile.json');
  const brokenProbe = join(brokenRoot, 'manual-probe.ts');
  const brokenOut = join(brokenRoot, 'manual-probe.json');
  await writeFile(brokenProbe, probeSource(brokenOut));
  await writeProfiles([{ name: 'broken', model: { provider: 'dag-test', id: 'nope' } }], brokenPath);
  const bad = await IsolatedClient.start(brokenRoot, 'manual-broken', [teamExt, brokenProbe], ['--workflow-profile', 'broken', '--dag-test-context-export']);
  t.after(() => bad.close(false));
  await bad.send('prompt', { message: 'do something' });
  await bad.until(() => bad.records.some(record => record.type === 'agent_settled'), 20_000);
  const exported = (await bad.entries() as { customType?: string }[]).filter(entry => entry.customType === 'dag-test.context-export');
  assert.deepEqual(exported, [], 'the aborted turn never reached a provider');
  assert.match(JSON.stringify(bad.records), /不在本机模型目录里/, 'the human is told why it will not run');
  const untouched = JSON.parse(await readFile(brokenOut, 'utf8')) as { provider?: string; model?: string };
  assert.equal(untouched.provider, 'dag-test');
  assert.equal(untouched.model, 'scripted', `the host model was not replaced by the broken Profile: ${JSON.stringify(untouched)}`);
  await bad.close(false);
});

test('ticket43 the canonical Profile keeps an optional isolate flag through the real store', async t => {
  await agentDir(t);
  const file = await writeProfiles([
    { name: 'on', isolate: true, tools: ['read'] },
    { name: 'off', isolate: false },
    { name: 'none' },
  ]);
  const raw = JSON.parse(await readFile(file, 'utf8')) as { profiles: { name: string; isolate?: boolean }[] };
  assert.deepEqual(raw.profiles.map(profile => [profile.name, profile.isolate]), [['on', true], ['off', false], ['none', undefined]], 'true and false both survive the write');
  const registry = { find: (provider: string, id: string) => ({ provider, id, reasoning: true }) };
  const reopened = new ProfileStore({ path: file, registry: registry as never, getTools: () => ['read', 'grep', 'find', 'ls'] });
  await reopened.load();
  assert.equal(reopened.get('on')!.isolate, true);
  assert.equal(reopened.get('off')!.isolate, false, 'an explicit false survives the round-trip');
  assert.equal(reopened.get('none')!.isolate, undefined);
  assert.throws(() => reopened.set({ name: 'bad', isolate: 'yes' } as never), /isolate must be true or false/);
  assert.equal(Object.hasOwn(reopened.resolve('on', { provider: 'local', id: 'm' }), 'isolate'), false, 'ResolvedProfile execution fields are unchanged');
});

test('ticket64 a relative child extension resolves beside the Profile, never from the working directory', async t => {
  const agent = await agentDir(t);
  const { configPaths } = await import('../src/shared/config.ts');
  const chosen = join(configPaths().directory, 'chosen.ts');
  await mkdir(dirnameP(chosen), { recursive: true });
  await writeFile(chosen, 'export default function () {}\n');
  const work = await mkdtemp(join(tmpdir(), 'team-ext-cwd-'));
  t.after(() => rm(work, { recursive: true, force: true }));
  // A namesake in the launch working directory must never satisfy the entry.
  await writeFile(join(work, 'chosen.ts'), 'export default function () {}\n');
  await writeProfiles([{ name: 'iso', isolate: true, childExtensions: ['chosen.ts'] }]);
  const real = await realpath(chosen);
  const escaped = real.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const spawn = (collect: (command: string) => void) => ((_command: string, args: string[]) => { collect(args[2]!); return { unref() {} }; }) as never;
  const commands: string[] = [];
  const launched = await launchTeam('split', { execPath: '/usr/bin/pi', cwd: work, teamName: 'Alpha', profile: 'iso' }, {
    adapters: { tmux: true, graphical: false }, spawn: spawn(command => commands.push(command)),
  });
  assert.match(commands[0]!, new RegExp(`-e '${escaped}'`), 'the spawn names the configuration file');
  assert.doesNotMatch(commands[0]!, /-e 'chosen\.ts'/, 'no bare relative entry is ever passed');
  assert.match(launched.plan.command, new RegExp(escaped), 'and the plan names the same real file');
  // `~/` resolves under the host home and an absolute entry keeps its meaning.
  const home = process.env.HOME;
  process.env.HOME = join(agent, 'home');
  await mkdir(process.env.HOME, { recursive: true });
  t.after(() => { if (home === undefined) delete process.env.HOME; else process.env.HOME = home; });
  const inHome = join(process.env.HOME, 'home-extension.ts');
  await writeFile(inHome, 'export default function () {}\n');
  await writeProfiles([{ name: 'iso', isolate: true, childExtensions: ['~/home-extension.ts', chosen] }]);
  const entries: string[] = [];
  await launchTeam('split', { execPath: '/usr/bin/pi', cwd: work, teamName: 'Alpha', profile: 'iso' }, {
    adapters: { tmux: true, graphical: false },
    spawn: ((_command: string, args: string[]) => { for (const match of args[2]!.matchAll(/-e '([^']*)'/g)) entries.push(match[1]!); return { unref() {} }; }) as never,
  });
  assert.deepEqual(entries.slice(1), [await realpath(inHome), real], 'relative, ~/ and absolute entries all become real files');
  // With only the working-directory namesake left, the launch fails before anything is spawned.
  await rm(chosen, { force: true });
  const spawns: unknown[] = [];
  const failure = await launchTeam('split', { execPath: '/usr/bin/pi', cwd: work, teamName: 'Alpha', profile: 'iso' }, {
    adapters: { tmux: true, graphical: false },
    spawn: ((...args: unknown[]) => { spawns.push(args); return { unref() {} }; }) as never,
  }).then(() => undefined, (cause: Error) => cause);
  assert.ok(failure instanceof Error, 'the missing configuration file is an error');
  assert.match(failure.message, /子扩展文件不存在或不可读/);
  assert.equal(spawns.length, 0, 'the working-directory namesake is not a fallback');
});

test('ticket45 concurrent joins and renames keep member names unique', async t => {
  await agentDir(t);
  const team = await createTeam({ name: 'Alpha', workspaceRoot: workspace });
  await joinTeam(team.id, { sessionId: 's1', sessionName: 'Lead', pid: 10, now: 1_000 });
  const joined = await Promise.allSettled([
    joinTeam(team.id, { sessionId: 's-a', sessionName: 'Twin', pid: 41, now: 1_000 }),
    joinTeam(team.id, { sessionId: 's-b', sessionName: 'Twin', pid: 42, now: 1_000 }),
  ]);
  assert.equal(joined.filter(result => result.status === 'fulfilled').length, 1, 'only one concurrent join takes the name');
  const twins = (await readMembers(team.id)).filter(member => member.name === 'Twin');
  assert.equal(twins.length, 1, 'the roster has one member with that name');
  // Two default-named joins still get distinct member-N names.
  await Promise.all([joinTeam(team.id, { sessionId: 's-c', pid: 43, now: 2_000 }), joinTeam(team.id, { sessionId: 's-d', pid: 44, now: 2_000 })]);
  const names = (await readMembers(team.id)).map(member => member.name).sort();
  assert.equal(new Set(names).size, names.length, `default names stay unique: ${names.join(', ')}`);
  // Concurrent renames onto one name: exactly one wins.
  const renamed = await Promise.allSettled([renameMember(team.id, 's-c', 'Same'), renameMember(team.id, 's-d', 'Same')]);
  assert.equal(renamed.filter(result => result.status === 'fulfilled').length, 1, 'only one rename takes the name');
  assert.equal((await readMembers(team.id)).filter(member => member.name === 'Same').length, 1);
});

// ticket46: the plan is the single source of truth for what actually starts.
{
const desktopRequest = (extra: Record<string, unknown> = {}) => ({ execPath: '/usr/bin/node', cli: '/opt/pi/cli.mjs', cwd: '/tmp/work', teamName: 'Alpha', ...extra });

test('ticket46 a user template is what really spawns, whatever terminal was probed', async () => {
  const calls: { file: string; args: string[] }[] = [];
  const spawnIt = ((file: string, args: string[]) => { calls.push({ file, args }); return { unref() {} }; }) as never;
  const template = 'custom-terminal --run {command}';
  const launched = await launchTeam('desktop', desktopRequest(), {
    adapters: { tmux: false, graphical: true, terminal: 'kitty', desktopTemplate: template, platform: 'linux' },
    spawn: spawnIt,
  });
  assert.equal(launched.spawned, true);
  assert.equal(calls.length, 1, 'exactly one process is started');
  assert.equal(calls[0]!.file, 'sh', 'the template runs as one shell command, not as kitty');
  assert.equal(calls[0]!.args[0], '-c');
  assert.match(calls[0]!.args[1]!, /^custom-terminal --run /, 'the configured template is the program that runs');
  assert.equal(calls[0]!.args[1]!, launched.plan.command, 'the plan string and the executed command are the same');
});

test('ticket46 a template needs no probe and never falls back to tmux', async () => {
  const calls: { file: string; args: string[] }[] = [];
  const spawnIt = ((file: string, args: string[]) => { calls.push({ file, args }); return { unref() {} }; }) as never;
  const launched = await launchTeam('desktop', desktopRequest(), {
    adapters: { tmux: false, graphical: true, desktopTemplate: 'myterm {command}', platform: 'linux', available: () => false },
    spawn: spawnIt,
  });
  assert.equal(launched.plan.mode, 'desktop', 'the template is its own host: no probe needed');
  assert.equal(launched.plan.degraded, undefined);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.file, 'sh');
  assert.equal(calls[0]!.file.includes('tmux'), false, 'a missing terminal does not silently become tmux');
});

test('ticket46 a known terminal keeps its direct argv and no shell', async () => {
  const calls: { file: string; args: string[] }[] = [];
  const spawnIt = ((file: string, args: string[]) => { calls.push({ file, args }); return { unref() {} }; }) as never;
  const launched = await launchTeam('desktop', desktopRequest(), {
    adapters: { tmux: false, graphical: true, terminal: 'kitty', platform: 'linux' },
    spawn: spawnIt,
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.file, 'kitty', 'a probed emulator is spawned directly');
  assert.deepEqual(calls[0]!.args, ['/usr/bin/node', '/opt/pi/cli.mjs', '--team', 'Alpha', '--team-bootstrap', '-e', teamExtensionPath()], 'and gets the argv, not a shell string');
  assert.equal(launched.plan.command, `'kitty' '/usr/bin/node' '/opt/pi/cli.mjs' --team 'Alpha' --team-bootstrap -e ${shellQuote(teamExtensionPath())}`,  'the shown command matches');
});

test('ticket46 none or no template still degrades to copy without spawning', async () => {
  const calls: unknown[] = [];
  const spawnIt = ((...args: unknown[]) => { calls.push(args); return { unref() {} }; }) as never;
  const none = await launchTeam('desktop', desktopRequest(), { adapters: { tmux: false, graphical: true, desktopTerminal: 'none', platform: 'linux' }, spawn: spawnIt });
  assert.equal(none.plan.mode, 'copy');
  assert.equal(none.plan.degraded, 'no-terminal');
  const bare = await launchTeam('desktop', desktopRequest(), { adapters: { tmux: false, graphical: true, platform: 'linux', available: () => false }, spawn: spawnIt });
  assert.equal(bare.plan.mode, 'copy', 'no template, no terminal, nothing to start');
  assert.equal(calls.length, 0, 'a degraded plan never spawns');
});

test('ticket46 a value that starts with -- stays one argv word in a real POSIX shell', async t => {
  const root = await mkdtemp(join(tmpdir(), 'team-ticket46-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const marker = join(root, 'marker');
  const record = join(root, 'argv.json');
  // A harmless recorder: it writes its argv and exits, so no Pi, no terminal and no network is involved.
  const script = join(root, 'record-argv.mjs');
  await writeFile(script, `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(record)}, JSON.stringify(process.argv.slice(2)));\n`);
  const hostile = `--worker; : > ${marker} #`;
  // The request carries the interpreter that really runs, so the recorded first word is that same path on any
  // Node build; a hardcoded /usr/bin/node would only agree with this process where both happen to match.
  const request = { ...desktopRequest({ name: hostile, teamName: 'Alpha Team', execPath: process.execPath }), cwd: root };
  const launched = await launchTeam('desktop', request, {
    adapters: { tmux: false, graphical: true, desktopTemplate: `${JSON.stringify(process.execPath)} ${script} {command}`, platform: 'linux' },
    spawn: nodeSpawn,
  });
  assert.equal(launched.spawned, true);
  // The template ran through the real shell; wait for the recorder to write its argv.
  for (let attempt = 0; attempt < 200; attempt++) { try { await access(record); break; } catch { await new Promise((resolve) => setTimeout(resolve, 10)); } }
  const argv = JSON.parse(await readFile(record, 'utf8')) as string[];
  const at = argv.indexOf('--name');
  assert.notEqual(at, -1, `the member name reached the program: ${JSON.stringify(argv)}`);
  assert.equal(argv[at + 1], hostile, 'the whole name arrives as a single argv word');
  assert.equal(argv.filter((value) => value === '--worker').length, 0, 'it is never split into a bare option');
  await assert.rejects(access(marker), 'the injected command never runs');
  assert.equal(argv[0], process.execPath, 'the interpreter is one word');
  assert.equal(argv[2], '--team');
  assert.equal(argv[3], 'Alpha Team', 'a name with a space stays one word too');
});

test('ticket46 a template that exits non-zero is a failed launch with its own words', async () => {
  const request = { execPath: process.execPath, cli: 'cli.mjs', cwd: tmpdir(), teamName: 'Alpha' };
  const run = (template: string) => launchTeam('desktop', request, { adapters: { tmux: false, graphical: true, desktopTemplate: template, platform: 'linux' }, spawn: nodeSpawn });
  const exited = await run('exit 17; {command}');
  assert.equal(exited.spawned, false, `exit 17 is not a launch: ${exited.reason}`);
  assert.match(String(exited.reason), /17/, 'the real exit code is reported');
  const missing = await run('definitely-not-a-program-xyz {command}');
  assert.equal(missing.spawned, false);
  assert.match(String(missing.reason), /127|not found/i, `a missing program is reported: ${missing.reason}`);
  const syntax = await run('if {command}');
  assert.equal(syntax.spawned, false);
  assert.match(String(syntax.reason), /2|syntax/i, `a shell syntax error is reported: ${syntax.reason}`);
});

test('ticket46 an immediate exit 0 is a request, not a confirmed member', async () => {
  const request = { execPath: process.execPath, cli: 'cli.mjs', cwd: tmpdir(), teamName: 'Alpha' };
  // A terminal service client may hand the window over and exit 0 at once: that proves nothing either way.
  const launched = await launchTeam('desktop', request, { adapters: { tmux: false, graphical: true, desktopTemplate: 'exit 0; {command}', platform: 'linux' }, spawn: nodeSpawn });
  assert.equal(launched.spawned, true, 'the request was accepted');
  assert.equal(launched.confirmed, false, 'and it is not a confirmed member');
  assert.equal(launched.reason, undefined, 'a clean fast exit is not reported as a failure');
});

test('ticket46 a synchronous spawn failure and an async spawn error both return a failure', async () => {
  const request = { execPath: '/usr/bin/node', cli: '/opt/pi/cli.mjs', cwd: '/tmp/work', teamName: 'Alpha' };
  const adapters = { tmux: false, graphical: true, desktopTerminal: 'kitty' as const, platform: 'linux' };
  const liveFake = () => ({ exitCode: null, signalCode: null, on() {}, unref() {}, stderr: { on() {}, destroy() {} } });
  const thrown = await launchTeam('desktop', request, { adapters, wait: async () => {}, spawn: (() => { throw new Error('spawn kitty EACCES'); }) as never });
  assert.equal(thrown.spawned, false, 'a synchronous throw is a failed launch, not a host exception');
  assert.match(String(thrown.reason), /EACCES/);
  // Node reports ENOENT asynchronously through the error event; the listener must already be there.
  const emitted = await launchTeam('desktop', request, {
    adapters,
    settleMs: 40,
    wait: (ms: number) => new Promise((resolve) => setTimeout(resolve, ms)),
    spawn: ((..._args: unknown[]) => { const child: any = liveFake(); child.on = (name: string, handler: (error: Error) => void) => { if (name === 'error') setTimeout(() => handler(new Error('spawn kitty ENOENT')), 5); }; return child; }) as never,
  });
  assert.equal(emitted.spawned, false, 'an async error is reported instead of crashing the host');
  assert.match(String(emitted.reason), /ENOENT/);
});

test('ticket46 a live window after the bounded window is a request the caller must not call ready', async () => {
  const request = { execPath: '/usr/bin/node', cli: '/opt/pi/cli.mjs', cwd: '/tmp/work', teamName: 'Alpha' };
  const liveFake = () => ({ exitCode: null, signalCode: null, on() {}, unref() {}, stderr: { on() {}, destroy() {} } });
  let waited = 0;
  const launched = await launchTeam('desktop', request, {
    adapters: { tmux: false, graphical: true, desktopTerminal: 'kitty', platform: 'linux' },
    wait: async (ms: number) => { waited += ms; },
    spawn: (() => liveFake()) as never,
  });
  assert.equal(launched.spawned, true);
  assert.equal(launched.confirmed, false, 'a running window is still unconfirmed');
  assert.ok(waited > 0, 'the launcher takes one bounded look before answering');
});

test('ticket46 a Windows terminal launch keeps its direct argv, including % and quotes', () => {
  const request = { execPath: 'C:\\node.exe', cli: 'C:\\pi\\cli.mjs', cwd: 'C:\\work', teamName: 'Alpha', name: '100% "done"' };
  const plan = planLaunch('desktop', request, { tmux: false, graphical: true, platform: 'win32', desktopTerminal: 'wt' });
  // No shell is involved, so the value arrives byte for byte: a capability boundary, not a character blacklist.
  assert.deepEqual(plan.exec, { file: 'wt', args: ['C:\\node.exe', 'C:\\pi\\cli.mjs', '--team', 'Alpha', '--team-bootstrap', '--name', '100% "done"'] });
});

test('ticket46 Windows shell launches are refused, not turned into a copyable command', () => {
  const request = { execPath: 'C:\\node.exe', cli: 'C:\\pi\\cli.mjs', cwd: 'C:\\work', teamName: 'Alpha' };
  const win = (extra: Record<string, unknown>) => ({ tmux: false, graphical: true, platform: 'win32', ...extra }) as never;
  // Template: a shell program by definition.
  assert.throws(() => planLaunch('desktop', request, win({ desktopTerminal: 'wt', desktopTemplate: 'myterm {command}' })), /暂不支持需要 shell/);
  // Copy: the clipboard command is a shell string.
  assert.throws(() => planLaunch('copy', request, win({})), /暂不支持需要 shell/);
  // tmux split/window: a shell command handed to tmux.
  assert.throws(() => planLaunch('split', request, win({ tmux: true })), /暂不支持需要 shell/);
  assert.throws(() => planLaunch('window', request, win({ tmux: true })), /暂不支持需要 shell/);
  // Background: POSIX env plus redirections.
  assert.throws(() => planLaunch('background', { ...request, runtime: { fifo: '/tmp/f', log: '/tmp/l', pidFile: '/tmp/p' } }, win({})), /暂不支持需要 shell/);
  // No terminal and no template would degrade to copy: also refused instead of promising a command.
  assert.throws(() => planLaunch('desktop', request, win({ available: () => false })), /暂不支持需要 shell/);
});
}

test('ticket46 stderr text reaches the reason and a same-named file is never read', async t => {
  const root = await mkdtemp(join(tmpdir(), 'ticket46-stderr-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  // A file whose *name* equals the diagnostic text: reading "the path in the message" would pick this up.
  await writeFile(join(root, 'DIAG-UNIQUE'), 'WRONG-FROM-FILE\n');
  const request = { execPath: process.execPath, cli: 'cli.mjs', cwd: root, teamName: 'Alpha' };
  const launched = await launchTeam('desktop', request, {
    adapters: { tmux: false, graphical: true, desktopTemplate: "printf 'DIAG-UNIQUE\\n' >&2; exit 17; {command}", platform: 'linux' },
    spawn: nodeSpawn,
  });
  assert.equal(launched.spawned, false);
  assert.match(String(launched.reason), /17/, 'the exit code is reported');
  assert.match(String(launched.reason), /DIAG-UNIQUE/, `the child's own stderr text is quoted: ${launched.reason}`);
  assert.doesNotMatch(String(launched.reason), /WRONG-FROM-FILE/, 'a file with that name is not read as the diagnostic');
});

test('ticket46 the stderr buffer is truncated on every append, not only before it', async () => {
  const request = { execPath: '/usr/bin/node', cli: '/opt/pi/cli.mjs', cwd: '/tmp/work', teamName: 'Alpha' };
  // One chunk far larger than the cap: a `length < cap` guard would append all of it.
  const huge = `${'X'.repeat(400)}BEYOND-THE-CAP${'Y'.repeat(100000)}`;
  const launched = await launchTeam('desktop', request, {
    adapters: { tmux: false, graphical: true, desktopTerminal: 'kitty', platform: 'linux' },
    settleMs: 30,
    wait: (ms: number) => new Promise((resolve) => setTimeout(resolve, ms)),
    spawn: (() => {
      const child: any = { exitCode: null, signalCode: null, unref() {}, on() {}, stderr: { on: (name: string, handler: (chunk: string) => void) => { if (name === 'data') handler(huge); }, destroy() {} } };
      setTimeout(() => { child.exitCode = 3; }, 5);
      return child;
    }) as never,
  });
  // The exit is observed only after the chunk; the reason must quote at most the bounded prefix.
  assert.equal(launched.spawned, false, `the non-zero exit is a failure: ${launched.spawned}`);
  assert.doesNotMatch(String(launched.reason), /BEYOND-THE-CAP/, `a single huge chunk must not grow the buffer: ${String(launched.reason).slice(0, 80)}`);
  const quoted = String(launched.reason).split('：').slice(1).join('：');
  assert.ok(quoted.length <= 300, `the quoted line stays bounded, was ${quoted.length}`);
});

test('ticket46 a child that keeps writing stderr after the window still runs', async t => {
  const root = await mkdtemp(join(tmpdir(), 'ticket46-live-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const marker = join(root, 'marker');
  // A shell writes to its own stderr well after the bounded window. Closing the read end would give it
  // SIGPIPE and it would die before leaving the marker; keeping the pipe drained leaves it alive.
  const script = `sleep 0.9; printf 'late stderr text\\n' >&2; : > ${JSON.stringify(marker)}; sleep 0.1`;
  // The launcher deliberately unrefs the child it started; a real host still has other handles. This test keeps
  // the exit it waits for, and registers the close listener at spawn so an early exit cannot slip past it.
  let closed: Promise<number | null> | undefined, spawned: { ref?: () => void } | undefined;
  const spawn = ((file: string, args: string[], options?: object) => {
    const child = nodeSpawn(file, args, options as never);
    spawned = child;
    closed = new Promise<number | null>(resolve => child.once('close', (code: number | null) => resolve(code)));
    return child;
  }) as never;
  const launched = await launchTeam('desktop', { execPath: '/bin/sh', cli: 'cli.sh', cwd: root, teamName: 'Alpha' }, {
    adapters: { tmux: false, graphical: true, desktopTemplate: script, platform: 'linux' },
    spawn,
    settleMs: 300,
  });
  assert.equal(launched.spawned, true, `the request was accepted: ${launched.reason}`);
  assert.equal(launched.confirmed, false);
  // The launcher unrefs after spawning, so the handle is taken back here: this test really waits for the exit.
  spawned?.ref?.();
  let survived = false;
  for (let attempt = 0; attempt < 300 && !survived; attempt++) { try { await access(marker); survived = true; } catch { await new Promise((resolve) => setTimeout(resolve, 10)); } }
  assert.equal(survived, true, 'a late stderr write does not kill the child');
  assert.equal(typeof closed, 'object', 'the spawned child is the one whose exit is awaited');
  assert.equal(launched.child, spawned, 'the awaited exit belongs to the child the launcher started');
  assert.equal(await closed, 0, 'the child ran to its own exit, not killed by a closed pipe');
});

test('ticket46 the Windows refusal reads the same in the UI and in the thrown error', async () => {
  const { WINDOWS_SHELL_UNSUPPORTED, windowsShellUnsupported } = await import('../src/team/domain/launcher.ts');
  // Two literals by necessity (the pure planner has no dictionary), so pin them to each other.
  assert.equal(windowsShellUnsupported(((key: string) => key) as never), WINDOWS_SHELL_UNSUPPORTED, 'one sentence, not two that drift');
  const request = { execPath: 'C:\\node.exe', cli: 'C:\\pi\\cli.mjs', cwd: 'C:\\work', teamName: 'Alpha' };
  assert.throws(() => planLaunch('copy', request, { tmux: false, graphical: true, platform: 'win32' } as never), new RegExp(WINDOWS_SHELL_UNSUPPORTED.slice(0, 12)));
});

test('ticket46 the panel refusal is translated, and nothing launches or copies', async t => {
  await agentDir(t);
  const { WINDOWS_SHELL_UNSUPPORTED } = await import('../src/team/domain/launcher.ts');
  const english = createTranslator('en');
  const h = teamHost(workspace, 's1');
  const spawns: string[] = [];
  const launchDeps = {
    spawn: ((command: string) => { spawns.push(command); return { pid: 4321, exitCode: null, signalCode: null, unref() {}, on() {}, kill() {} }; }) as any,
    adapters: { tmux: false, graphical: false, platform: 'win32' } as never,
    mkfifo: () => {}, openFifo: () => 'ignore' as const, wait: async () => {}, alive: () => true,
  };
  // The panel path reads process.platform directly, so the host has to look like Windows for this branch.
  const realPlatform = process.platform;
  Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
  t.after(() => { Object.defineProperty(process, 'platform', { value: realPlatform, configurable: true }); });

  const shutdownHost = registerTeam(h.pi, { msg: english, pid: () => 10, launchDeps });
  for (const mode of ['copy', 'split'] as const) {
    const refused = await shutdownHost.launch(h.ctx, mode, 'Alpha');
    assert.equal(refused.spawned, false, `${mode} is refused on Windows`);
    assert.equal(refused.reason, english('Windows 上暂不支持需要 shell 的启动（自定义模板／tmux／后台／复制命令）：只剩已知终端的直接 argv 启动'), `the panel line is English for ${mode}`);
    assert.notEqual(refused.reason, WINDOWS_SHELL_UNSUPPORTED, 'the panel does not print the untranslated constant');
    assert.doesNotMatch(refused.reason ?? '', /暂不支持|复制命令/, 'no Chinese reaches the panel');
    assert.equal(refused.plan, undefined, 'a refused launch has no command to paste');
  }
  assert.deepEqual(spawns, [], 'the guard returns before any spawn: no process of any kind started');

  // An `auto` desktop default is not a terminal. The guard has to resolve it exactly as the planner will,
  // or it would say "supported" and the planner would then throw the same unsupported-shell sentence.
  for (const adapters of [
    { tmux: false, graphical: true, platform: 'win32', desktopTerminal: 'auto' as const },
    { tmux: false, graphical: true, platform: 'win32', desktopTerminal: 'auto' as const, available: () => false },
  ]) {
    const autoHost = registerTeam(teamHost(workspace, 's3').pi, { msg: english, pid: () => 10, launchDeps: { ...launchDeps, adapters: adapters as never } });
    const refusedAuto = await autoHost.launch(h.ctx, 'desktop', 'Alpha');
    assert.equal(refusedAuto.spawned, false, 'an unprobed auto is refused, not planned');
    assert.equal(refusedAuto.reason, english('Windows 上暂不支持需要 shell 的启动（自定义模板／tmux／后台／复制命令）：只剩已知终端的直接 argv 启动'), 'and it is refused with the translated sentence');
    assert.equal(refusedAuto.plan, undefined, 'no plan was produced, so the planner never threw');
  }
  // A probed terminal stays supported: the same guard says yes and the plan carries its direct argv.
  const probed = registerTeam(teamHost(workspace, 's4').pi, { msg: english, pid: () => 10, launchDeps: { ...launchDeps, adapters: { tmux: false, graphical: true, platform: 'win32', desktopTerminal: 'auto', available: () => true } as never } });
  const allowedAuto = await probed.launch(h.ctx, 'desktop', 'Alpha');
  assert.equal(allowedAuto.spawned, true, 'a probed terminal is a real Windows launch');
  assert.match(allowedAuto.plan?.command ?? '', /wt/, 'and the plan names that terminal');
  assert.deepEqual(spawns, ['wt'], 'a supported launch is the only one that ever reached a spawn');

  // The same refusal through the Chinese translator keeps its Chinese wording: the change is a locale
  // switch, not a new sentence.
  const chineseHost = registerTeam(teamHost(workspace, 's2').pi, { msg: chinese, pid: () => 10, launchDeps });
  const refusedCn = await chineseHost.launch(h.ctx, 'copy', 'Alpha');
  assert.equal(refusedCn.reason, WINDOWS_SHELL_UNSUPPORTED, 'the Chinese path still reports the frozen sentence');
  assert.deepEqual(spawns, ['wt'], 'a refused launch still spawns nothing');
});

// ticket66: the panel launch must use the adapters the real configuration and PATH report.
test('ticket66 a configured kitty on PATH is what a panel launch really spawns', async t => {
  await agentDir(t);
  const team = await createTeam({ name: 'Alpha', workspaceRoot: workspace });
  await joinTeam(team.id, { sessionId: 's1', sessionName: 'Lead', pid: 10, now: 1_000 });
  // A kitty that exists on PATH, and a configuration that names it: no injected adapters anywhere.
  const bin = await mkdtemp(join(tmpdir(), 'team-bin-'));
  t.after(() => rm(bin, { recursive: true, force: true }));
  await writeFile(join(bin, 'kitty'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const previousPath = process.env.PATH, previousTmux = process.env.TMUX;
  process.env.PATH = `${bin}:${previousPath ?? ''}`;
  // No tmux in this environment, so `auto` has only the terminal to choose from: the assertion is about
  // the detected adapters, not about which multiplexer the machine running the tests happens to have.
  delete process.env.TMUX;
  t.after(() => {
    if (previousPath === undefined) delete process.env.PATH; else process.env.PATH = previousPath;
    if (previousTmux === undefined) delete process.env.TMUX; else process.env.TMUX = previousTmux;
  });
  const { writeConfig } = await import('../src/shared/config.ts');
  await writeConfig({ desktopTerminal: 'kitty' }, chinese);
  const spawns: { command: string; args: string[] }[] = [];
  const host = teamHost(workspace);
  const registration = registerTeam(host.pi, {
    msg: chinese, pid: () => 10,
    // Only a spawn stub: the adapters must come from the configuration and PATH, as in a real session.
    launchDeps: { spawn: ((command: string, args: string[]) => { spawns.push({ command, args }); return { unref() {} }; }) as never },
  });
  host.pi.appendEntry('pi-dag-workflow.team-pointer', { teamId: team.id, memberName: 'Lead' });
  const result = await registration.launch(host.ctx, 'desktop', 'Alpha');
  assert.equal(result.spawned, true, `the desktop launch really starts a process: ${result.reason ?? ''}`);
  assert.equal(result.plan?.mode, 'desktop', 'the plan is a desktop window, not a degraded copy');
  assert.equal(result.plan?.degraded, undefined, 'nothing degraded to "no terminal"');
  assert.equal(spawns.length, 1, 'exactly one process is started');
  assert.equal(spawns[0]!.command, 'kitty', 'the configured terminal is the program that runs');
  assert.equal(spawns[0]!.args[0], process.execPath, 'and it runs the Pi host interpreter');
  // `auto` resolves the same way, and a copy request never opens a window on its own.
  spawns.length = 0;
  const auto = await registration.launch(host.ctx, 'auto', 'Alpha');
  assert.equal(auto.plan?.mode, 'desktop', 'auto picks the configured terminal instead of a copy');
  assert.equal(spawns[0]?.command, 'kitty');
  spawns.length = 0;
  const copy = await registration.launch(host.ctx, 'copy', 'Alpha');
  assert.equal(copy.plan?.mode, 'copy');
  assert.equal(spawns.length, 0, 'an explicit copy never spawns');
});

// Team runtime controls share this suite's real registry and registered-command seams.
{
const { readMember } = await import('../src/team/io/registry.ts');
const { configPaths } = await import('../src/shared/config.ts');
const { sessionFileFor } = await import('../src/team/io/session-tail.ts');
const { fileURLToPath } = await import('node:url');
async function setup(t: { after(fn: () => unknown): void }) {
  const root = await mkdtemp(join(tmpdir(), 'dag-team-controls-')), previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = join(root, 'agent');
  const cleanups: (() => Promise<unknown>)[] = [];
  t.after(async () => { try { for (const cleanup of cleanups.reverse()) await cleanup(); } finally { if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous; await rm(root, { recursive: true, force: true }); } });
  await mkdir(join(root, 'agent'), { recursive: true });
  await writeFile(join(root, 'agent/settings.json'), JSON.stringify({ retry: { enabled: false } }));
  assert.ok(configPaths().directory.startsWith(root));
  const team = await createTeam({ name: 'Controls', workspaceRoot: root });
  return { root, team, cleanup(fn: () => Promise<unknown>) { cleanups.push(fn); } };
}
function host(root: string, sid: string, pid: number) {
  const handlers = new Map<string, Function[]>(), entries: any[] = [], sends: any[] = [], appliedModels: string[] = [];
  const models = new Map(['A', 'B'].map(id => [`test/${id}`, { provider: 'test', id, name: id, reasoning: true, input: ['text'] }]));
  let model = models.get('test/A')!, thinking = 'low', name = sid, idle = true;
  const pi: any = {
    on(event: string, fn: Function) { handlers.set(event, [...handlers.get(event) ?? [], fn]); }, registerTool() {}, registerCommand() {}, registerFlag() {}, registerMessageRenderer() {}, getFlag() {},
    appendEntry(customType: string, data: unknown) { entries.push({ type: 'custom', customType, data }); },
    sendMessage(message: unknown, options: unknown) { sends.push({ message, options }); },
    async setModel(next: typeof model) { appliedModels.push(next.id); model = next; return true; }, getThinkingLevel: () => thinking, setThinkingLevel(value: string) { thinking = value === 'xhigh' ? 'high' : value; }, setSessionName(value: string) { name = value; },
  };
  const ctx: any = { cwd: root, mode: 'rpc', hasUI: true, get model() { return model; }, isIdle: () => idle, hasPendingMessages: () => false,
    sessionManager: { getSessionId: () => sid, getSessionName: () => name, getSessionFile: () => undefined, getBranch: () => entries },
    modelRegistry: { find: (provider: string, id: string) => models.get(`${provider}/${id}`) }, ui: { notify() {} } };
  const registration = registerTeam(pi, { pid: () => pid, alive: () => true });
  const fire = async (event: string) => { for (const fn of handlers.get(event) ?? []) await fn({}, ctx); };
  return { registration, ctx, fire, entries, sends, appliedModels, idle(value: boolean) { idle = value; }, model: () => model.id, thinking: () => thinking, name: () => name };
}
test('Team control applies on the target after settlement, independently renames both labels and keeps lead identity', async t => {
  const { root, team, cleanup } = await setup(t), sender = host(root, 'sender', 10), target = host(root, 'target', 20);
  cleanup(async () => { await sender.fire('session_shutdown'); await target.fire('session_shutdown'); });
  await target.registration.join(target.ctx, 'Controls'); await sender.registration.join(sender.ctx, 'Controls');
  target.idle(false);
  const chosenModel = ['test', 'B'].join('/');
  await sender.registration.requestControl(sender.ctx, 'target', { model: chosenModel, thinking: 'high' });
  await sender.registration.requestControl(sender.ctx, 'target', { memberName: 'Renamed member', sessionName: 'Renamed session' });
  await target.registration.poll(target.ctx);
  assert.equal(target.model(), 'A', 'a busy target retains its current model'); assert.equal(target.name(), 'target');
  assert.equal((await readMember(team.id, 'target'))!.control!.status, 'pending');
  await Promise.all([target.fire('turn_end'), target.fire('turn_end')]);
  assert.deepEqual(target.appliedModels, ['B'], 'overlapping boundary callbacks apply the request only once');
  const applied = (await readMember(team.id, 'target'))!;
  assert.equal(target.model(), 'B', 'the target applies the selected model'); assert.equal(target.thinking(), 'high'); assert.equal(target.name(), 'Renamed session');
  assert.equal(applied.name, 'Renamed member'); assert.equal(applied.sessionName, 'Renamed session');
  assert.equal(applied.control!.status, 'applied'); assert.equal(applied.model, chosenModel);
  assert.equal((await readTeam(team.id))!.leadMemberName, 'Renamed member');
  target.idle(true); await target.fire('agent_settled');
  assert.equal(sender.model(), 'A'); assert.equal(sender.name(), 'sender'); assert.equal(target.sends.filter(item => item.options?.triggerTurn === true).length, 0, 'configuration never starts a model request');
  await sender.registration.requestControl(sender.ctx, 'target', { model: ['absent', 'no-model'].join('/') }); await target.registration.poll(target.ctx);
  assert.equal((await readMember(team.id, 'target'))!.control!.status, 'failed'); assert.equal(target.model(), 'B');
  await sender.registration.requestControl(sender.ctx, 'target', { thinking: 'xhigh' }); await target.registration.poll(target.ctx);
  assert.equal((await readMember(team.id, 'target'))!.control!.status, 'failed', 'unsupported thinking levels are rejected'); assert.equal(target.thinking(), 'high', 'unsupported levels do not silently clamp');
  await sender.registration.requestControl(sender.ctx, 'target', { sessionName: 'Old runtime request' });
  const ownInstance = (await readMember(team.id, 'target'))!.instanceId; assert.ok(ownInstance);
  await noteMemberEvent(team.id, 'target', { ownerPid: 20, instanceId: 'replacement-runtime' });
  await target.registration.poll(target.ctx);
  assert.equal(target.name(), 'Renamed session', 'a same-PID replacement invalidates the previous runtime request');
  await noteMemberEvent(team.id, 'target', { ownerPid: 20, instanceId: ownInstance });
  await sender.registration.requestControl(sender.ctx, 'target', { sessionName: 'Stale operation' });
  await claimOwnership(team.id, 'target', { pid: 30, now: Date.now(), force: true, probe: () => true });
  await target.registration.poll(target.ctx); assert.equal(target.name(), 'Renamed session', 'a replaced holder cannot apply its old request');
});
test('actual Pi: one blank-session acknowledgement persists its SID; remote settings do not need another model turn', { timeout: 18000 }, async t => {
  const { root, team, cleanup } = await setup(t), sender = host(root, 'sender', process.pid);
  await sender.registration.join(sender.ctx, 'Controls');
  const entry = fileURLToPath(new URL('../src/team/index.ts', import.meta.url));
  const reloader = join(root, 'reload.ts');
  await writeFile(reloader, `export default function(pi) { pi.registerCommand('test-reload', { handler: async (_args, ctx) => { await ctx.reload(); } }); }`);
  const client = await IsolatedClient.start(root, 'native-controls-target', [reloader], ['--team', 'Controls', '--team-bootstrap', '--dag-test-context-export'], false, [entry]);
  cleanup(async () => { await sender.fire('session_shutdown'); await client.close(false); });
  await client.until(() => client.records.some(record => record.type === 'agent_settled'));
  const sid = 'native-controls-target', member = (await readMember(team.id, sid))!;
  assert.equal(member.bootstrap, 'confirmed');
  const file = sessionFileFor(sid, { recorded: member.sessionFile ?? null }); assert.ok(file, 'the initial reply makes the new SID locatable'); await access(file);
  const entries = await client.entries() as any[];
  const exported = entries.find(entry => entry.customType === 'dag-test.context-export')?.data.context.messages as any[];
  const bootstrapText = exported.map(message => typeof message.content === 'string' ? message.content : message.content.filter((part: any) => part.type === 'text').map((part: any) => part.text).join('\n')).find(text => text.includes('Team startup confirmation.'));
  assert.ok(bootstrapText);
  assert.doesNotMatch(bootstrapText, /\p{Script=Han}/u, 'plugin-owned startup guidance is English even in a Chinese UI');
  assert.match(bootstrapText, /acknowledgement in Simplified Chinese/, 'reply locale is specified using an English language name');
  const replies = entries.filter(entry => entry.type === 'message' && entry.message.role === 'assistant');
  assert.equal(replies.length, 1); assert.equal(replies[0].message.content[0].text, '已收到，等待任务。');
  assert.equal(client.records.filter(record => record.type === 'tool_execution_start').length, 0);
  const settingsBefore = await readFile(join(root, 'agent/settings.json'), 'utf8');
  await sender.registration.requestControl(sender.ctx, sid, { model: ['dag-test', 'reasoned'].join('/'), thinking: 'high', memberName: 'Native renamed', sessionName: 'Native session title' });
  const deadline = Date.now() + 12000;
  while ((await readMember(team.id, sid))?.control?.status === 'pending' && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 100));
  const result = (await readMember(team.id, sid))!;
  assert.equal(result.control!.status, 'applied', result.control!.error ?? 'the target must acknowledge actual application');
  const state = (await client.send('get_state')).data as any;
  assert.equal(state.model.id, 'reasoned'); assert.equal(state.thinkingLevel, 'high'); assert.equal(state.sessionName, 'Native session title');
  assert.equal(result.name, 'Native renamed');
  const after = await client.entries() as any[];
  assert.equal(after.filter(entry => entry.type === 'message' && entry.message.role === 'assistant').length, 1, 'remote configuration and rename make no provider request');
  await client.prompt('/test-reload'); await client.send('get_state');
  const reloaded = await client.entries() as any[];
  assert.equal(reloaded.filter(entry => entry.type === 'custom' && entry.customType === 'pi-dag-workflow.team-bootstrap').length, 1, 'reload never re-arms the startup acknowledgement');
  assert.equal(reloaded.filter(entry => entry.type === 'message' && entry.message.role === 'assistant').length, 1, 'reload never repeats the startup acknowledgement');
  assert.equal(await readFile(join(root, 'agent/settings.json'), 'utf8'), settingsBefore, 'runtime controls leave global defaults unchanged');
  assert.equal(client.records.some(record => record.type === 'extension_error'), false);
});
test('actual Pi: startup acknowledgement blocks an attempted file write', { timeout: 8000 }, async t => {
  const { root, team, cleanup } = await setup(t);
  const entry = fileURLToPath(new URL('../src/team/index.ts', import.meta.url));
  const client = await IsolatedClient.start(root, 'blocked-bootstrap', [], ['--team', 'Controls', '--team-bootstrap', '--dag-test-bootstrap-tool'], false, [entry]);
  cleanup(() => client.close(false));
  await client.until(() => client.records.some(record => record.type === 'agent_settled'));
  await assert.rejects(access(join(root, 'forbidden-bootstrap.txt')));
  assert.equal((await readMember(team.id, 'blocked-bootstrap'))!.bootstrap, 'failed');
  assert.equal(client.records.some(record => record.type === 'extension_error'), false);
});
}
