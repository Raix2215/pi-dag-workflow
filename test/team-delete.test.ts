import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { chinese } from '../src/shared/i18n.ts';
import { claimOwnership, createTeam, dissolveTeam, joinTeam, readMembers, teamsRoot } from '../src/team/io/registry.ts';
import { sendToMember } from '../src/team/io/inbox.ts';
import { withSidLock } from '../src/team/io/sid-lock.ts';
import { deleteSessionFile } from '../src/team/io/session-delete.ts';
import { registerTeam } from '../src/team/commands/register.ts';
import { recordPanels } from './fixtures/public-host.ts';
import { closePanel as closeMountedPanel } from '../src/shared/ui/menu.ts';
import { teamMenu } from '../src/team/commands/menu.ts';

const workspace = '/tmp/team-workspace';

/** A Pi-shaped session file: the header is what proves which SID a path belongs to. */
async function writeSession(root: string, sessionId: string, text = 'saved body'): Promise<string> {
  const file = join(root, 'sessions', 'project', `${sessionId}.jsonl`);
  await mkdir(dirname(file), { recursive: true });
  const header = JSON.stringify({ type: 'session', version: 3, id: sessionId, sessionId, timestamp: '2024-01-01T00:00:00.000Z' });
  const message = JSON.stringify({ type: 'message', id: 'm1', timestamp: '2024-01-01T00:00:01.000Z', message: { role: 'user', content: [{ type: 'text', text }] } });
  await writeFile(file, `${header}\n${message}\n`);
  return file;
}

const exists = (path: string) => stat(path).then(() => true, () => false);

/** A `trash` that behaves exactly as the test says: the panel path really spawns this binary. */
async function fakeTrash(t: { after(fn: () => unknown): void }, behaviour: 'move' | 'fail' | 'none' | 'lie'): Promise<void> {
  const bin = await mkdtemp(join(tmpdir(), 'team-trash-'));
  const previous = process.env.PATH;
  t.after(async () => { process.env.PATH = previous; await rm(bin, { recursive: true, force: true }); });
  if (behaviour !== 'none') {
    const script = join(bin, 'trash');
    const body = behaviour === 'move'
      ? '#!/bin/sh\nrm -f -- "$2"\nexit 0\n'
      : behaviour === 'lie'
        ? '#!/bin/sh\nexit 0\n'
        : '#!/bin/sh\necho "cannot trash" >&2\nexit 1\n';
    await writeFile(script, body, { mode: 0o755 });
    await chmod(script, 0o755);
  }
  process.env.PATH = behaviour === 'none' ? bin : `${bin}:${previous ?? ''}`;
}

function host(root: string, sessionId = 'self-1') {
  const handlers = new Map<string, Function[]>(), notices: { message: string; level: string }[] = [], appends: { type: string; data: unknown }[] = [], tools: string[] = [];
  const branch: { customType?: string; data?: unknown }[] = [];
  const pi: any = {
    on(name: string, handler: Function) { handlers.set(name, [...handlers.get(name) ?? [], handler]); return () => {}; },
    registerTool(tool: { name: string }) { tools.push(tool.name); }, registerCommand() {}, registerMessageRenderer() {}, registerFlag() {}, getFlag() { return undefined; },
    appendEntry(type: string, data: unknown) { appends.push({ type, data }); if (data === undefined) { const last = [...branch].reverse().find(entry => entry.customType === type); if (last) branch.splice(branch.indexOf(last), 1); } else branch.push({ customType: type, data }); },
    sendMessage() {}, setSessionName() {},
  };
  const ctx: any = { cwd: root, sessionManager: { getSessionId: () => sessionId, getSessionName: () => undefined, getBranch: () => branch }, ui: { notify: (message: string, level = 'info') => notices.push({ message, level }), setWidget() {}, theme: new Proxy({}, { get: () => (text: string) => text }) } };
  return { pi, ctx, notices, appends, tools };
}

async function agentDir(t: { after(fn: () => unknown): void }): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'team-delete-'));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = root;
  t.after(async () => {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous;
    await rm(root, { recursive: true, force: true });
  });
  return root;
}

const inboxOf = (teamId: string, sessionId: string) => join(teamsRoot(), teamId, 'inboxes', `${sessionId}.json`);

/**
 * Two teams holding a mailbox for the same SID: one active, one dissolved in place. A second member with its
 * own mailbox sits beside it, and a team carrier (tasks, archived manifest) must survive the whole thing.
 */
async function world(t: { after(fn: () => unknown): void }, options: { alive?: (pid: number) => boolean } = {}) {
  const root = await agentDir(t);
  const active = await createTeam({ name: 'Alpha', workspaceRoot: workspace });
  const archived = await createTeam({ name: 'Beta', workspaceRoot: workspace });
  const target = await joinTeam(active.id, { sessionId: 'target-sid', pid: 900_001, now: 1_000 });
  await joinTeam(active.id, { sessionId: 'other-sid', sessionName: 'Other', pid: 900_002, now: 1_000 });
  await joinTeam(archived.id, { sessionId: 'target-sid', sessionName: 'Target', pid: 900_001, now: 1_000 });
  // The mailboxes are written through the real send path, so their shape is the production one.
  await sendToMember(active.id, { from: 'Other', fromId: 'other-sid', to: 'Target', toSessionId: 'target-sid', body: 'for the target', now: 2_000 });
  await sendToMember(active.id, { from: 'Target', fromId: 'target-sid', to: 'Other', toSessionId: 'other-sid', body: 'for the other member', now: 2_000 });
  await sendToMember(archived.id, { from: 'Target', fromId: 'target-sid', to: 'Target', toSessionId: 'target-sid', body: 'archived residue', now: 2_000 });
  // A historic carrier in the dissolved team: the delete must not take the whole directory with it.
  await writeFile(join(teamsRoot(), archived.id, 'todos-legacy.json'), '{"kept":true}\n');
  await dissolveTeam(archived.id);

  const file = await writeSession(root, 'target-sid');
  const h = host(workspace);
  const registration = registerTeam(h.pi, { msg: chinese, ...(options.alive ? { alive: options.alive } : {}) });
  await registration.join(h.ctx, 'Alpha');
  const self = (await readMembers(active.id)).find(member => member.sessionId !== 'target-sid' && member.name !== 'Other');
  assert.ok(self, 'the current session joined the active team');
  return { root, active, archived, target: target!, file, h, registration, self: self! };
}

test('ticket60 a trashed session takes this SID\'s mailboxes in every team and nothing else', async t => {
  const w = await world(t, { alive: () => false });
  await fakeTrash(t, 'move');
  await w.registration.deleteSession(w.h.ctx, 'member-1');
  assert.equal(await exists(w.file), false, 'the session file went to the trash');
  assert.equal(await exists(inboxOf(w.active.id, 'target-sid')), false, 'the active team mailbox is gone');
  assert.equal(await exists(inboxOf(w.archived.id, 'target-sid')), false, 'the dissolved team mailbox is gone too');
  assert.equal(await exists(inboxOf(w.active.id, 'other-sid')), true, 'another recipient keeps its mailbox');
  assert.match(await readFile(inboxOf(w.active.id, 'other-sid'), 'utf8'), /for the other member/, 'and its message is untouched');
  assert.equal(await exists(join(teamsRoot(), w.archived.id, 'todos-legacy.json')), true, 'the dissolved team keeps its historic carrier');
  assert.equal(await exists(join(teamsRoot(), w.archived.id, 'team.archived.json')), true, 'and its archived manifest');
  const notice = w.h.notices.map(item => item.message).join('\n');
  assert.match(notice, /移入回收站/, 'the report names the method that really ran');
  assert.match(notice, /删除 2、本来没有 0、失败 0/, 'and counts every mailbox it looked at');
  assert.equal((await readMembers(w.active.id)).some(member => member.sessionId === 'target-sid'), false, 'the acting team no longer lists the deleted session');
  assert.equal((await readMembers(w.archived.id)).some(member => member.sessionId === 'target-sid'), true, 'the dissolved team keeps its own residue record');
  assert.match(notice, /成员记录已移除/, 'and the report says the record went with it');
  assert.deepEqual(w.h.tools.sort(), ['team_inspect', 'team_send'], 'deleting a session is user-only: no model tool was added');
});

test('ticket60 a failing trash falls back to unlink and says so', async t => {
  const w = await world(t, { alive: () => false });
  await fakeTrash(t, 'fail');
  await w.registration.deleteSession(w.h.ctx, 'member-1');
  assert.equal(await exists(w.file), false, 'the file is gone through the fallback');
  assert.match(w.h.notices.map(item => item.message).join('\n'), /永久删除/, 'the report says permanent, not trashed');
});

test('ticket60 no trash on PATH still deletes, and reports the permanent path', async t => {
  const w = await world(t, { alive: () => false });
  await fakeTrash(t, 'none');
  await w.registration.deleteSession(w.h.ctx, 'member-1');
  assert.equal(await exists(w.file), false, 'the file is gone');
  assert.match(w.h.notices.map(item => item.message).join('\n'), /永久删除/);
});

test('ticket60 a trash that claims success but leaves the file is not a deletion', async t => {
  const w = await world(t, { alive: () => false });
  await fakeTrash(t, 'lie');
  await w.registration.deleteSession(w.h.ctx, 'member-1');
  // The stub exits 0 without removing anything, so the fallback runs and the file really disappears.
  assert.equal(await exists(w.file), false, 'the fallback removed it');
  assert.match(w.h.notices.map(item => item.message).join('\n'), /永久删除/, 'and it is not reported as trashed');
});

test('ticket60 a session that cannot be deleted keeps every mailbox', async t => {
  const w = await world(t, { alive: () => false });
  await fakeTrash(t, 'fail');
  const directory = dirname(w.file);
  await chmod(directory, 0o500);
  try {
    await assert.rejects(w.registration.deleteSession(w.h.ctx, 'member-1'), /会话文件删除失败/);
  } finally { await chmod(directory, 0o700); }
  assert.equal(await exists(w.file), true, 'the file is still there');
  assert.equal(await exists(inboxOf(w.active.id, 'target-sid')), true, 'so its mailbox stays');
  assert.equal(await exists(inboxOf(w.archived.id, 'target-sid')), true, 'and so does the dissolved one');
});

test('ticket60 one failing mailbox does not stop the others and is reported', async t => {
  const w = await world(t, { alive: () => false });
  await fakeTrash(t, 'move');
  // An unreadable mailbox directory: the lock cannot be taken there, so that one mailbox fails.
  const blocked = join(teamsRoot(), w.active.id, 'inboxes');
  await chmod(blocked, 0o500);
  try { await w.registration.deleteSession(w.h.ctx, 'member-1'); } finally { await chmod(blocked, 0o700); }
  const notice = w.h.notices.map(item => item.message).join('\n');
  assert.match(notice, /失败 1/, 'the report counts the failure instead of hiding it');
  assert.match(notice, /信箱未删除/, 'and names the mailbox that stayed');
});

test('ticket60 an unsaved session is refused and no mailbox is touched', async t => {
  const w = await world(t, { alive: () => false });
  await rm(w.file, { force: true });
  await assert.rejects(w.registration.deleteSession(w.h.ctx, 'member-1'), /尚未保存或无法定位会话文件/);
  assert.equal(await exists(inboxOf(w.active.id, 'target-sid')), true, 'the mailboxes are untouched');
});

test('ticket60 a file whose header names another session is not deleted', async t => {
  const w = await world(t, { alive: () => false });
  await writeSession(w.root, 'target-sid');
  // Swap the header for a different SID: the path is not this session, so nothing may be removed.
  const other = join(w.root, 'sessions', 'project', 'target-sid.jsonl');
  await writeFile(other, `${JSON.stringify({ type: 'session', version: 3, id: 'someone-else', sessionId: 'someone-else' })}\n`);
  await assert.rejects(w.registration.deleteSession(w.h.ctx, 'member-1'), /会话文件里记录的不是该会话/);
  assert.equal(await exists(other), true);
  assert.equal(await exists(inboxOf(w.active.id, 'target-sid')), true);
});

test('ticket60 a live holder in another team refuses the delete', async t => {
  const alivePids = new Set<number>();
  const w = await world(t, { alive: pid => alivePids.has(pid) });
  // The same SID is held by a live process in the *dissolved* team: that is still a running session.
  alivePids.add(900_001);
  await assert.rejects(w.registration.deleteSession(w.h.ctx, 'member-1'), /不能删除/);
  assert.equal(await exists(w.file), true, 'the session file stays');
  assert.equal(await exists(inboxOf(w.active.id, 'target-sid')), true, 'and the mailboxes stay');
});

test('ticket60 a holder this host cannot vouch for is refused', async t => {
  const root = await agentDir(t);
  const team = await createTeam({ name: 'Alpha', workspaceRoot: workspace });
  await joinTeam(team.id, { sessionId: 'target-sid', pid: 900_003, now: 1_000 });
  const file = await writeSession(root, 'target-sid');
  const h = host(workspace);
  // No `alive` hook: the host cannot probe, so a recorded pid is unverifiable and the delete must refuse.
  const registration = registerTeam(h.pi, { msg: chinese });
  await registration.join(h.ctx, 'Alpha');
  await assert.rejects(registration.deleteSession(h.ctx, 'member-1'), /不能删除/);
  assert.equal(await exists(file), true);
});

test('ticket60 the current session cannot delete itself', async t => {
  const w = await world(t, { alive: () => false });
  await assert.rejects(w.registration.deleteSession(w.h.ctx, w.self.name), /不能删除当前正在使用的会话/);
  assert.equal(await exists(w.file), true);
});

test('ticket60 the delete waits for the SID lock and refuses when the roster changes while it waits', async t => {
  const alivePids = new Set<number>();
  const w = await world(t, { alive: pid => alivePids.has(pid) });
  await fakeTrash(t, 'move');
  let release!: () => void;
  const held = withSidLock('target-sid', () => new Promise<void>(resolve => { release = resolve; }));
  await delay(100);
  const deletion = w.registration.deleteSession(w.h.ctx, 'member-1');
  await delay(150);
  // While the delete is queued, the record changes hands: the lock-internal re-read must notice.
  await claimOwnership(w.active.id, 'target-sid', { pid: 900_004, now: 2_000, force: true });
  alivePids.add(900_004);
  release();
  await held;
  await assert.rejects(deletion, /该会话现在不能删除/);
  assert.equal(await exists(w.file), true, 'nothing was deleted after the takeover');
  assert.equal(await exists(inboxOf(w.active.id, 'target-sid')), true, 'and no mailbox was touched');
});

test('ticket60 the session file helper reports how the file really went away', async t => {
  const root = await agentDir(t);
  const notThere = join(root, 'sessions', 'project', 'gone.jsonl');
  assert.deepEqual((await deleteSessionFile(notThere)).method, 'failed', 'a missing file is not a successful deletion');
  const file = await writeSession(root, 'gone-sid');
  await fakeTrash(t, 'move');
  const trashed = await deleteSessionFile(file);
  assert.equal(trashed.method, 'trashed', 'the trash path is reported when it really ran');
});

test('ticket60 the panel offers its own delete row and really deletes through it', async t => {
  const w = await world(t, { alive: () => false });
  await fakeTrash(t, 'move');
  w.h.ctx.hasUI = true;
  w.h.ctx.mode = 'tui';
  const memory = new Map();
  const panel = { register() {}, request() {}, tabs: () => [{ id: 'todos', label: 'Todos' }, { id: 'team', label: 'Team' }], memory: () => memory } as any;
  const panels = recordPanels(w.h.ctx);
  const opening = teamMenu(w.h.ctx, {
    msg: chinese, panel, currentTeamId: () => w.active.id, setCurrentTeam: () => {},
    pointer: w.registration.pointer, join: w.registration.join, leave: w.registration.leave, takeover: w.registration.takeover, switchTo: w.registration.switchTo,
    create: w.registration.create, launch: w.registration.launch, evict: w.registration.evict, stop: w.registration.stop, deleteSession: w.registration.deleteSession,
    desktop: w.registration.desktop, setDesktop: w.registration.setDesktop, history: w.registration.history, resumeCommand: w.registration.resumeCommand,
    pid: w.registration.pid, ...(w.registration.alive ? { alive: w.registration.alive } : {}), renameSession: () => {},
  });
  await panels.wait(() => panels.live() === 1);
  // A tall terminal, so a member's whole child list is on screen when it is expanded.
  panels.rows(80);
  const frame = () => panels.frame().join('\n');
  const focused = () => panels.frame().find((line: string) => /^[ │]*> /.test(line)) ?? '';
  const focus = async (word: string) => { for (const key of ['j', 'k']) for (let step = 0; step < 80; step++) { if (focused().includes(word)) return; await panels.press(key); } throw new Error(`row not found: ${word}\n${frame()}`); };
  // The delete row is its own entry under the member, next to (not inside) stop and evict.
  await focus('member-1'); await panels.press('l');
  await focus('成员管理'); await panels.press('l');
  await focus('删除会话与信箱');
  const description = frame();
  assert.match(description, /target-sid/, 'the confirmation on screen names the session');
  assert.match(description, /所有团队/, 'and the exact scope of the destruction');
  assert.match(description, /再按一次确认删除/, 'and it is a two-press destructive row');
  // The first press only arms it: nothing is deleted yet.
  await panels.press('\r');
  assert.equal(await exists(w.file), true, 'the first press does not delete anything');
  // The second press performs it through the same hook, and the report is the real one.
  const before = w.h.notices.length;
  await panels.press('\r');
  await panels.wait(() => w.h.notices.length > before);
  assert.match(w.h.notices.map(item => item.message).join('\n'), /移入回收站/, 'the panel report names the method that really ran');
  assert.equal(await exists(w.file), false, 'the panel path removed the session file');
  assert.equal(await exists(inboxOf(w.active.id, 'target-sid')), false, 'and that SID\'s mailbox with it');
  // The current session cannot delete itself: the hook refuses, and the panel cannot destroy the file either.
  await focus('member-2'); await panels.press('l');
  await assert.rejects(w.registration.deleteSession(w.h.ctx, w.self.name), /不能删除当前正在使用的会话/);
  for (let step = 0; step < 6; step += 1) await panels.press('\r');
  assert.equal(await exists(join(w.root, 'sessions', 'project', 'self-1.jsonl')), false, 'this session never had a file, and none was created');
  assert.equal(await exists(w.file), false, 'the deleted session stays deleted');
  await closeMountedPanel(w.h.ctx);
  await opening;
});

test('ticket60 a pull-up launch and a delete serialise on the same SID lock', async t => {
  const w = await world(t, { alive: () => false });
  await fakeTrash(t, 'move');
  let release!: () => void;
  const held = withSidLock('target-sid', () => new Promise<void>(resolve => { release = resolve; }));
  await delay(100);
  // A pull-up continues this session, so it must wait for the same lock a delete takes.
  let launched = false;
  const launching = w.registration.launch(w.h.ctx, 'copy', 'Alpha', 'target-sid').then(result => { launched = true; return result; });
  await delay(200);
  assert.equal(launched, false, 'the pull-up did not run while the SID lock was held');
  const deletion = w.registration.deleteSession(w.h.ctx, 'member-1');
  await delay(150);
  assert.equal(await exists(w.file), true, 'and the delete did not slip in either');
  release();
  await held;
  const plan = await launching;
  assert.equal(launched, true, 'the pull-up ran once the lock was free');
  assert.match(JSON.stringify(plan), /--session/, 'and it really continues that session');
  await deletion;
  assert.equal(await exists(w.file), false, 'the delete then removed the file');
});
