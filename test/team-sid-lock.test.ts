/**
 * Ticket 50 — one stable SID is managed by one operation at a time, and a takeover only proceeds when the old
 * process is really gone. Every case drives the production path: the registry census, the real lock file, the
 * registered `switchTo`, and the real session-file header.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chinese } from '../src/shared/i18n.ts';
import { configPaths } from '../src/shared/config.ts';
import { claimOwnership, createTeam, dissolveTeam, joinTeam, readMember, readMembers, teamsRoot, archivedManifestPath } from '../src/team/io/registry.ts';
import { holdersOfSid, sidConflict, withSidLock } from '../src/team/io/sid-lock.ts';
import { clearHandoff, sessionSidOf, takeHandoff, wakeIdleRpc, writeHandoff } from '../src/team/io/sid-session.ts';
import { registerTeam } from '../src/team/commands/register.ts';

const workspace = '/tmp/team-workspace';

async function agentDir(t: { after(fn: () => unknown): void }) {
  const root = await mkdtemp(join(tmpdir(), 'team-sid-'));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = root;
  assert.equal(configPaths().directory.startsWith(root), true, `config lives in this run: ${configPaths().directory}`);
  assert.equal(teamsRoot().startsWith(root), true, `team data lives in this run: ${teamsRoot()}`);
  t.after(async () => {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous;
    await rm(root, { recursive: true, force: true });
  });
  return root;
}

function host(root: string, sessionId = 'lead') {
  const tools = new Map<string, any>(), handlers = new Map<string, Function[]>(), branch: { customType?: string; data?: unknown }[] = [];
  const pi: any = {
    on(name: string, handler: Function) { handlers.set(name, [...handlers.get(name) ?? [], handler]); return () => {}; },
    registerFlag() {}, getFlag() { return undefined; },
    appendEntry(type: string, data: unknown) { branch.push({ customType: type, data }); },
    sendMessage() {}, registerTool(tool: any) { tools.set(tool.name, tool); }, registerCommand() {}, registerMessageRenderer() {},
  };
  const ctx: any = { cwd: root, isIdle: () => true, sessionManager: { getSessionId: () => sessionId, getSessionName: () => undefined, getBranch: () => branch }, ui: { notify() {}, setWidget() {} } };
  const fire = async (name: string) => { for (const handler of handlers.get(name) ?? []) await handler({}, ctx); };
  return { pi, ctx, tools, fire };
}

/** A real session file whose native header names this SID. */
async function sessionFile(sessionId: string): Promise<string> {
  const directory = join(configPaths().directory, '..', 'sessions', 'project');
  await mkdir(directory, { recursive: true });
  const file = join(directory, `${sessionId}.jsonl`);
  await writeFile(file, `${JSON.stringify({ type: 'session', version: 3, id: sessionId, timestamp: new Date(1).toISOString(), cwd: workspace })}\n`);
  return file;
}

test('ticket50 the census sees every team, including a dissolved one, and refuses to guess', async t => {
  await agentDir(t);
  const alpha = await createTeam({ name: 'Alpha', workspaceRoot: workspace });
  const beta = await createTeam({ name: 'Beta', workspaceRoot: '/tmp/other-workspace' });
  await joinTeam(alpha.id, { sessionId: 'lead', sessionName: 'Lead', pid: process.pid, now: 1 });
  await joinTeam(beta.id, { sessionId: 'shared', sessionName: 'Elsewhere', pid: 4242, now: 1 });
  const found = await holdersOfSid('shared');
  assert.deepEqual(found.map(holder => holder.teamId), [beta.id], 'a record in another team is found');
  // A dissolved team keeps its records in place: an older Pi may still be running under one.
  await dissolveTeam(beta.id);
  assert.equal(await readFile(archivedManifestPath(beta.id), 'utf8').then(() => true, () => false), true);
  const archived = await holdersOfSid('shared');
  assert.deepEqual(archived.map(holder => [holder.teamId, holder.archived]), [[beta.id, true]], 'the residue still counts, marked archived');
  // Decisions: another team's live process refuses, a released record does not.
  assert.equal(sidConflict(archived, alpha.id, process.pid, () => true)?.conflict, 'other-team-live');
  assert.equal(sidConflict(archived, alpha.id, process.pid, () => false), undefined, 'a dead holder elsewhere does not block');
  assert.equal(sidConflict(archived, alpha.id, process.pid, undefined)?.conflict, 'unknown-holder', 'an unprobeable holder is refused, not called dead');
  // Two different live pids anywhere is not something one takeover may resolve.
  const both = [
    { teamId: alpha.id, archived: false, pid: 11, released: false, member: { sessionId: 's', state: 'attached' } as any },
    { teamId: beta.id, archived: false, pid: 22, released: false, member: { sessionId: 's', state: 'attached' } as any },
  ];
  assert.equal(sidConflict(both, 't-third', 99, () => true)?.conflict, 'multiple-live');
  // A released record (pid 0) is not an unknown holder.
  const released = [{ teamId: alpha.id, archived: false, pid: undefined, released: true, member: { sessionId: 's', state: 'attached' } as any }];
  assert.equal(sidConflict(released, alpha.id, 99, undefined), undefined, 'pid 0 means released, not unprovable');
});

test('ticket50 the SID lock serialises one session without blocking another', async t => {
  await agentDir(t);
  const order: string[] = [];
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  let entered!: () => void;
  const enteredFirst = new Promise<void>(resolve => { entered = resolve; });
  const first = withSidLock('sid-a', async () => { order.push('first-in'); entered(); await held; order.push('first-out'); });
  // Wait for the first holder to really be inside the lock; starting both at once would race the mkdir.
  await enteredFirst;
  // A second operation on the same SID waits; a different SID does not.
  const second = withSidLock('sid-a', async () => { order.push('second'); });
  await withSidLock('sid-b', async () => { order.push('other'); });
  assert.deepEqual(order, ['first-in', 'other'], 'a different SID runs while the first is held');
  release();
  await Promise.all([first, second]);
  assert.deepEqual(order, ['first-in', 'other', 'first-out', 'second'], 'the same SID is serialised');
});

test('ticket50 a takeover refuses another team’s live holder and leaves both records alone', async t => {
  await agentDir(t);
  const alpha = await createTeam({ name: 'Alpha', workspaceRoot: workspace });
  const beta = await createTeam({ name: 'Beta', workspaceRoot: '/tmp/other-workspace' });
  await joinTeam(alpha.id, { sessionId: 'lead', sessionName: 'Lead', pid: process.pid, now: 1 });
  await joinTeam(alpha.id, { sessionId: 'target', sessionName: 'Worker', pid: 999_001, now: 1 });
  await joinTeam(beta.id, { sessionId: 'target', sessionName: 'Worker', pid: 424_242, now: 1 });
  await sessionFile('target');
  const h = host(workspace);
  h.pi.appendEntry('pi-dag-workflow.team-pointer', { teamId: alpha.id, memberName: 'Lead' });
  let switches = 0, clock = 1_000;
  const registration = registerTeam(h.pi, {
    msg: chinese, pid: () => process.pid, alive: pid => pid === 424_242 || pid === 999_001,
    // The host is real enough to count a switch; it must never be reached here.
    now: () => clock,
    wait: async () => { clock += 10_000; },
  });
  (h.ctx as any).switchSession = async () => { switches += 1; return { cancelled: false }; };
  await assert.rejects(registration.switchTo(h.ctx, 'Worker', true), /同一会话现在不能接管/);
  assert.equal(switches, 0, 'no session file is opened for a refused takeover');
  assert.equal((await readMember(beta.id, 'target'))!.holder.pid, 424_242, "the other team's record is untouched");
  assert.equal((await readMember(alpha.id, 'target'))!.holder.pid, 999_001, 'and so is the local one');
});

test('ticket50 a forced takeover waits for the old process and only then switches', async t => {
  await agentDir(t);
  const alpha = await createTeam({ name: 'Alpha', workspaceRoot: workspace });
  await joinTeam(alpha.id, { sessionId: 'lead', sessionName: 'Lead', pid: process.pid, now: 1 });
  await joinTeam(alpha.id, { sessionId: 'target', sessionName: 'Worker', pid: 515_151, now: 1 });
  const file = await sessionFile('target');
  const h = host(workspace);
  h.pi.appendEntry('pi-dag-workflow.team-pointer', { teamId: alpha.id, memberName: 'Lead' });
  let aliveChecks = 0, clock = 1_000, switchedPath: string | undefined, switchedBeforeExit = false;
  const registration = registerTeam(h.pi, {
    msg: chinese, pid: () => process.pid,
    // The old process survives two probes, then exits: the switch must happen only after that.
    alive: pid => (pid === 515_151 ? aliveChecks++ < 2 : false),
    now: () => clock,
    wait: async () => { clock += 10_000; },
  });
  const originalSwitch = async (path: string) => { switchedPath = path; switchedBeforeExit = aliveChecks < 3; return { cancelled: false }; };
  (h.ctx as any).switchSession = originalSwitch;
  assert.equal(await registration.switchTo(h.ctx, 'Worker', true), 'switched');
  assert.equal(switchedPath, file, 'the verified target file is what the host opened');
  assert.equal(switchedBeforeExit, false, 'the switch happened only after the old process exited');
  assert.equal((await readMember(alpha.id, 'target'))!.holder.pid, process.pid, 'the record now names this process');
});

test('ticket50 a process that never exits refuses the takeover and rolls the claim back', async t => {
  await agentDir(t);
  const alpha = await createTeam({ name: 'Alpha', workspaceRoot: workspace });
  await joinTeam(alpha.id, { sessionId: 'lead', sessionName: 'Lead', pid: process.pid, now: 1 });
  await joinTeam(alpha.id, { sessionId: 'target', sessionName: 'Worker', pid: 616_161, now: 1 });
  await sessionFile('target');
  const before = (await readMember(alpha.id, 'target'))!;
  const h = host(workspace);
  h.pi.appendEntry('pi-dag-workflow.team-pointer', { teamId: alpha.id, memberName: 'Lead' });
  let clock = 1_000, switches = 0;
  const registration = registerTeam(h.pi, {
    msg: chinese, pid: () => process.pid,
    alive: pid => pid === 616_161,                    // it never exits
    now: () => clock,
    wait: async () => { clock += 10_000; },           // one action window passes quickly
  });
  (h.ctx as any).switchSession = async () => { switches += 1; return { cancelled: false }; };
  await assert.rejects(registration.switchTo(h.ctx, 'Worker', true), /未在 30 秒内退出/);
  assert.equal(switches, 0, 'the target file is never opened');
  const after = (await readMember(alpha.id, 'target'))!;
  assert.equal(after.holder.pid, before.holder.pid, 'the holder is restored');
  assert.ok(after.generation > before.generation, 'and the generation only moves forward');
  assert.equal((await readMember(alpha.id, 'lead'))!.holder.pid, process.pid, 'the source record was never released');
});

test('ticket50 a session file is only opened when its own header names the target SID', async t => {
  await agentDir(t);
  const alpha = await createTeam({ name: 'Alpha', workspaceRoot: workspace });
  await joinTeam(alpha.id, { sessionId: 'lead', sessionName: 'Lead', pid: process.pid, now: 1 });
  await joinTeam(alpha.id, { sessionId: 'target', sessionName: 'Worker', pid: 717_171, now: 1 });
  const directory = join(configPaths().directory, '..', 'sessions', 'project');
  await mkdir(directory, { recursive: true });
  // A file that belongs to another session entirely.
  const wrong = join(directory, 'target.jsonl');
  await writeFile(wrong, `${JSON.stringify({ type: 'session', version: 3, id: 'someone-else', timestamp: new Date(1).toISOString(), cwd: workspace })}\n`);
  assert.equal(sessionSidOf(wrong), 'someone-else');
  const h = host(workspace);
  h.pi.appendEntry('pi-dag-workflow.team-pointer', { teamId: alpha.id, memberName: 'Lead' });
  let switches = 0, clock = 1_000;
  const registration = registerTeam(h.pi, { msg: chinese, pid: () => process.pid, alive: () => true, now: () => clock, wait: async () => { clock += 10_000; } });
  (h.ctx as any).switchSession = async () => { switches += 1; return { cancelled: false }; };
  await assert.rejects(registration.switchTo(h.ctx, 'Worker', true), /记录的会话是 someone-else/);
  assert.equal(switches, 0);
  assert.equal((await readMembers(alpha.id)).find(member => member.sessionId === 'target')!.holder.pid, 717_171, 'nothing was claimed');
});

test('ticket50 a header that is not a session, a fake fifo and a foreign handoff all prove nothing', async t => {
  await agentDir(t);
  const team = await createTeam({ name: 'Alpha', workspaceRoot: workspace });
  const directory = join(configPaths().directory, '..', 'sessions', 'project');
  await mkdir(directory, { recursive: true });
  // A first line that names an id but is not a session header: a takeover must not trust it.
  const impostor = join(directory, 'impostor.jsonl');
  await writeFile(impostor, `${JSON.stringify({ type: 'message', id: 'impostor' })}\n`);
  assert.equal(sessionSidOf(impostor), undefined, 'only a session header names the session of a file');
  // A regular file wearing the channel's name is not the member's FIFO and must never be written to.
  const fake = join(teamsRoot(), team.id, 'runtime', 'launch-x.fifo');
  await mkdir(join(teamsRoot(), team.id, 'runtime'), { recursive: true });
  await writeFile(fake, 'not a fifo\n');
  assert.equal(await wakeIdleRpc(team.id, { runtime: { fifo: fake, log: fake.replace('.fifo', '.log'), pidFile: fake.replace('.fifo', '.pid'), pid: process.pid }, holder: { pid: process.pid } } as never), false);
  assert.equal(await readFile(fake, 'utf8'), 'not a fifo\n', 'the regular file keeps its bytes');
  // The managed handoff is consumed exactly once, and only by the runtime it names.
  const at = Date.now();
  await writeHandoff({ teamId: team.id, sessionId: 'sid-h', memberName: 'Worker', pid: 4242, token: 7, at });
  assert.equal(takeHandoff('sid-h', 9999, at), undefined, 'another process never consumes it');
  assert.equal(takeHandoff('sid-h', 4242, at)?.token, 7, 'the named runtime takes it');
  assert.equal(takeHandoff('sid-h', 4242, at), undefined, 'and it is gone afterwards');
  await writeHandoff({ teamId: team.id, sessionId: 'sid-old', memberName: 'Worker', pid: 4242, token: 7, at: at - 10 * 60_000 });
  assert.equal(takeHandoff('sid-old', 4242, at), undefined, 'a stale handoff is discarded');
  await writeHandoff({ teamId: team.id, sessionId: 'sid-other', memberName: 'Worker', pid: 4242, token: 7, at });
  assert.equal(takeHandoff('sid-not-this-one', 4242, at), undefined, 'a handoff for another session is not read as this one');
  await clearHandoff('sid-other');
  assert.equal(takeHandoff('sid-other', 4242, at), undefined, 'clearing removes it');
});

test('ticket50 a side that really held the scope leaves at a safe boundary after a takeover', async t => {
  await agentDir(t);
  const team = await createTeam({ name: 'Alpha', workspaceRoot: workspace });
  const h = host(workspace, 'member-1');
  // The ordinary `--team` entry path: join returns early, so held scope must come from the real holder write.
  (h.pi as any).getFlag = (name: string) => name === 'team' ? 'Alpha' : undefined;
  let shutdowns = 0;
  (h.ctx as any).shutdown = () => { shutdowns += 1; };
  registerTeam(h.pi, { msg: chinese, pid: () => process.pid, alive: () => true });
  await h.fire('session_start');
  const joined = await readMember(team.id, 'member-1');
  assert.equal(joined?.holder.pid, process.pid, 'the --team entry really joined as this process');
  // A different live process now holds the record.
  await claimOwnership(team.id, 'member-1', { pid: process.pid + 1, now: Date.now(), force: true, probe: () => true });
  await h.fire('agent_settled');
  assert.equal(shutdowns, 1, 'the replaced side asks its host to leave at the settlement');
  shutdowns = 0;
  // A team that is gone, or a record this process still holds, is never a reason to stop.
  await claimOwnership(team.id, 'member-1', { pid: process.pid, now: Date.now(), force: true, probe: () => true });
  await h.fire('agent_settled');
  assert.equal(shutdowns, 0, 'a record this process holds again does not stop it');
});
