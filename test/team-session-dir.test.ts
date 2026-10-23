import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { existsSync, lstatSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chinese } from '../src/shared/i18n.ts';
import { readHistory } from '../src/team/io/session-history.ts';
import { sessionFileFor, sessionsRoots } from '../src/team/io/session-tail.ts';
import { createTeam as createTeamRecord, joinTeam, noteMemberEvent, readMembers, teamsRoot } from '../src/team/io/registry.ts';
import { previewInbox, sendToMember } from '../src/team/io/inbox.ts';
import { configPaths } from '../src/shared/config.ts';
import { registerTeam } from '../src/team/commands/register.ts';
import { IsolatedClient } from './fixtures/isolated-client.ts';

const workspace = '/tmp/team-workspace';

/** A saved session file with the two spellings Pi uses, written directly into `directory`. */
async function writeSession(directory: string, name: string, text = 'saved body', sid = 'sid-x'): Promise<string> {
  const file = join(directory, name);
  await mkdir(directory, { recursive: true });
  const header = JSON.stringify({ type: 'session', version: 3, sessionId: sid, timestamp: '2024-01-01T00:00:00.000Z' });
  const message = JSON.stringify({ type: 'message', id: 'm1', timestamp: '2024-01-01T00:00:01.000Z', message: { role: 'user', content: [{ type: 'text', text }] } });
  await writeFile(file, `${header}\n${message}\n`);
  return file;
}

function host(root: string, sessionId = 'self-1') {
  const handlers = new Map<string, Function[]>(), notices: { message: string; level: string }[] = [];
  const branch: { customType?: string; data?: unknown }[] = [];
  const pi: any = {
    on(name: string, handler: Function) { handlers.set(name, [...handlers.get(name) ?? [], handler]); return () => {}; },
    registerTool() {}, registerCommand() {}, registerMessageRenderer() {}, registerFlag() {}, getFlag() { return undefined; },
    appendEntry(type: string, data: unknown) { if (data === undefined) { const last = [...branch].reverse().find(entry => entry.customType === type); if (last) branch.splice(branch.indexOf(last), 1); } else branch.push({ customType: type, data }); },
    sendMessage() {}, setSessionName() {},
  };
  const ctx: any = {
    cwd: root, hasUI: true, mode: 'tui',
    sessionManager: { getSessionId: () => sessionId, getSessionName: () => undefined, getBranch: () => branch, getSessionFile: () => undefined },
    ui: { notify: (message: string, level = 'info') => notices.push({ message, level }), setWidget() {}, theme: new Proxy({}, { get: () => (text: string) => text }) },
  };
  return { pi, ctx, notices };
}

/** Point this test process at the same agent root and session directory the real child uses. */
async function isolate(t: { after(fn: () => unknown): void }, customDir: string | undefined): Promise<{ root: string; agent: string }> {
  const root = await mkdtemp(join(tmpdir(), 'team-session-dir-'));
  const agent = join(root, 'agent');
  await mkdir(agent, { recursive: true });
  const previous = { agent: process.env.PI_CODING_AGENT_DIR, sessions: process.env.PI_CODING_AGENT_SESSION_DIR };
  process.env.PI_CODING_AGENT_DIR = agent;
  if (customDir === undefined) delete process.env.PI_CODING_AGENT_SESSION_DIR; else process.env.PI_CODING_AGENT_SESSION_DIR = customDir;
  // Before any test writes Team or config state: this run is under the temporary root, not the user's.
  assert.equal(configPaths().directory, join(agent, 'pi-dag-workflow'), 'the extension directory is the temporary root');
  assert.equal(teamsRoot(), join(agent, 'pi-dag-workflow', 'teams'), 'the teams root is inside the temporary root');
  t.after(async () => {
    if (previous.agent === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous.agent;
    if (previous.sessions === undefined) delete process.env.PI_CODING_AGENT_SESSION_DIR; else process.env.PI_CODING_AGENT_SESSION_DIR = previous.sessions;
    await rm(root, { recursive: true, force: true });
  });
  return { root, agent };
}

test('ticket62 the locator honours PI_CODING_AGENT_SESSION_DIR and finds a file straight in that root', async t => {
  const custom = await mkdtemp(join(tmpdir(), 'team-session-dir-custom-'));
  t.after(() => rm(custom, { recursive: true, force: true }));
  await isolate(t, custom);
  // Pi writes `<custom>/<timestamp>_<sessionId>.jsonl` when `--session-dir` points here: no project bucket.
  const file = await writeSession(custom, '2026-01-01T00-00-00-000Z_sid-direct.jsonl');
  assert.deepEqual(sessionsRoots()[0], custom, 'the environment override is the most specific root');
  assert.equal(sessionFileFor('sid-direct'), file, 'the file is found in the custom directory');
  assert.equal(sessionFileFor('sid-direct', { root: custom }), file, 'and an explicit root still works');
  assert.equal(sessionFileFor('sid-direct', { recorded: file }), file, 'the record path is used when it names the SID');
  const snapshot = await readHistory(file);
  assert.equal(snapshot.state, 'ok', 'the located file is readable as history');
  assert.match(snapshot.entries.map(entry => entry.text).join('\n'), /saved body/);
});

test('ticket62 the record path wins over a same-named file that a scan would find first', async t => {
  const custom = await mkdtemp(join(tmpdir(), 'team-session-dir-custom-'));
  const elsewhere = await mkdtemp(join(tmpdir(), 'team-session-dir-recorded-'));
  t.after(async () => { await rm(custom, { recursive: true, force: true }); await rm(elsewhere, { recursive: true, force: true }); });
  const { agent } = await isolate(t, custom);
  // A decoy sits in the root that is scanned first; the SDK's real path lives somewhere else entirely.
  const decoy = await writeSession(custom, 'sid-both.jsonl', 'DECOY-BODY');
  const recorded = await writeSession(elsewhere, 'sid-both.jsonl', 'RECORDED-BODY');
  assert.equal(sessionFileFor('sid-both', { recorded }), recorded, 'the SDK path wins over the first scanned root');
  assert.equal(sessionFileFor('sid-both'), decoy, 'without the fact the env root is scanned first');
  assert.equal(sessionFileFor('sid-both', { recorded: null }), undefined, 'an explicit "no file" never falls back to a guess');
  // A known path that does not name this SID is refused outright: a known path never turns into a scan.
  assert.equal(sessionFileFor('sid-both', { recorded: join(elsewhere, 'other-sid.jsonl') }), undefined, 'a recorded path naming another SID is refused, not replaced by the decoy');
  // With no override at all, the default root still answers exactly as before.
  const plain = await isolate(t, undefined);
  const plainFile = await writeSession(join(plain.agent, 'sessions', 'project'), 'sid-plain.jsonl');
  assert.equal(sessionFileFor('sid-plain'), plainFile, 'the default root still locates a session');
  void agent;
});
test('ticket62 a deleted file stays unfound and only one level is scanned', async t => {
  const custom = await mkdtemp(join(tmpdir(), 'team-session-dir-custom-'));
  t.after(() => rm(custom, { recursive: true, force: true }));
  await isolate(t, custom);
  const file = await writeSession(custom, 'sid-gone.jsonl');
  assert.equal(sessionFileFor('sid-gone'), file);
  await rm(file);
  assert.equal(sessionFileFor('sid-gone'), undefined, 'an externally deleted file is reported missing, not recreated');
  // Two levels deep is not a location this locator accepts: it never walks an arbitrary tree.
  await writeSession(join(custom, 'a', 'b'), 'sid-deep.jsonl');
  assert.equal(sessionFileFor('sid-deep'), undefined, 'a deeper path is not guessed');
});

test('ticket62 real Pi with a custom --session-dir: locate, read history, inspect lastReply, delete', { timeout: 90_000 }, async t => {
  const custom = await mkdtemp(join(tmpdir(), 'team-session-dir-real-'));
  const { root } = await isolate(t, custom);
  t.after(() => rm(custom, { recursive: true, force: true }));
  const team = await createTeamRecord({ name: 'Alpha', workspaceRoot: root });
  const sessionId = 'custom-dir-sid';
  const entries = ['todos', 'plan', 'agents', 'goal', 'retry', 'team'].map(name => fileURLToPath(new URL(`../src/${name}/index.ts`, import.meta.url)));
  // The child inherits the same custom directory through both routes the card names.
  const client = await IsolatedClient.start(root, sessionId, [], ['--team', 'Alpha', '--name', 'Probe'], false, entries, 'zh-CN', custom);
  let member;
  try {
    const records = await client.prompt('第一次真实对话');
    assert.equal(records.some(record => record.type === 'extension_error'), false);
    // The file really landed in the custom directory, with Pi's timestamped spelling.
    const saved = (await import('node:fs/promises')).readdir;
    const names = (await saved(custom)).filter(name => name.endsWith('.jsonl'));
    assert.equal(names.length >= 1, true, `a session file was written under the custom directory (${names.join(',')})`);
    member = (await readMembers(team.id)).find(item => item.sessionId === sessionId);
    assert.ok(member, 'the member record exists');
    assert.equal(typeof member!.sessionFile, 'string', 'the boundary recorded the SDK path');
    assert.equal(sessionFileFor(sessionId, member!.sessionFile === null || member!.sessionFile === undefined ? {} : { recorded: member!.sessionFile }), member!.sessionFile, 'the recorded path locates the file');
    // The same file is found with no record fact at all: the environment override is a real fallback.
    assert.equal(sessionFileFor(sessionId), member!.sessionFile, 'the fallback roots find the custom directory');
    const snapshot = await readHistory(sessionFileFor(sessionId));
    assert.equal(snapshot.state, 'ok', 'history opens the custom-directory file');
    assert.match(snapshot.entries.map(entry => entry.text).join('\n'), /第一次真实对话/, 'and its body is readable');
    // team_inspect reads the last reply from that same file.
    const inspected = await client.prompt(`TEST CALL team_inspect ${JSON.stringify({ name: 'Probe', activity: { limit: 3 } })}`);
    const event = inspected.find(record => record.type === 'tool_execution_end' && record.toolName === 'team_inspect');
    assert.ok(event, 'team_inspect returned');
    const details = (event as any).result?.details ?? {};
    assert.equal(typeof details.lastReply, 'string', `team_inspect carries a lastReply (${JSON.stringify(details).slice(0, 200)})`);
    assert.equal(String(details.lastReply).length > 0, true, 'and it is not empty');
    assert.equal(Array.isArray(details.activity), true, 'the activity window was read from the same file');
  } finally { await client.close(false); }
  // Now that the process is gone, the panel's delete finds and removes the custom-directory file.
  const h = host(workspace);
  const registration = registerTeam(h.pi, { msg: chinese, alive: () => false });
  const self = await joinTeam(team.id, { sessionId: 'self-1', sessionName: 'Self', pid: 9_000_777, now: 1_000 });
  assert.ok(self, 'the acting session joined');
  h.pi.appendEntry('pi-dag-workflow.team-pointer', { teamId: team.id, memberName: 'Self' });
  const file = member!.sessionFile!;
  assert.equal(existsSync(file), true, 'the file is on disk before the delete');
  await registration.deleteSession(h.ctx, 'Probe');
  assert.equal(existsSync(file), false, 'the delete removed the custom-directory file');
  assert.equal(h.notices.some(item => /移入回收站|永久删除/.test(item.message)), true, 'and reported how it went');
});

test('ticket62 a link or a directory is never accepted as a session file', async t => {
  const custom = await mkdtemp(join(tmpdir(), 'team-session-dir-custom-'));
  const external = await mkdtemp(join(tmpdir(), 'team-session-dir-external-'));
  t.after(async () => { await rm(custom, { recursive: true, force: true }); await rm(external, { recursive: true, force: true }); });
  const { agent } = await isolate(t, custom);
  const bucket = join(agent, 'sessions', 'project');
  // Every link below points at a genuine session file of the same SID: only the *candidate* is unsafe.
  const target = await writeSession(external, 'real.jsonl', 'REAL-BODY', 'sid-link');
  const recordedLink = join(custom, 'sid-link.jsonl');
  await mkdir(custom, { recursive: true });
  await symlink(target, recordedLink);
  assert.equal(sessionFileFor('sid-link', { recorded: recordedLink }), undefined, 'a recorded path that is a link is refused');
  assert.equal(sessionFileFor('sid-link'), undefined, 'a link straight in the root is refused');
  // The same rule for both spellings inside a project bucket.
  await mkdir(bucket, { recursive: true });
  const exactLink = join(bucket, 'sid-bexact.jsonl');
  await symlink(target, exactLink);
  assert.equal(sessionFileFor('sid-bexact'), undefined, 'a bucket <sid>.jsonl link is refused');
  const suffixLink = join(bucket, '2024-01-01T00-00-00-000Z_sid-bsuffix.jsonl');
  await symlink(target, suffixLink);
  assert.equal(sessionFileFor('sid-bsuffix'), undefined, 'a bucket <ts>_<sid>.jsonl link is refused');
  // A directory wearing a session file's name is not a file either.
  const fakeDir = join(bucket, 'sid-fakedir.jsonl');
  await mkdir(fakeDir);
  assert.equal(sessionFileFor('sid-fakedir'), undefined, 'a directory named like a session file is refused');
  assert.equal(sessionFileFor('sid-fakedir', { recorded: fakeDir }), undefined, 'and so is a recorded path that is a directory');
  // Positive control: a real regular file in the same places is still located.
  const real = await writeSession(bucket, 'sid-real.jsonl', 'REAL', 'sid-real');
  assert.equal(sessionFileFor('sid-real'), real, 'a real regular file is still found');
  assert.equal(existsSync(target), true, 'the link target was never touched');
});

test('ticket62 production deleteSession refuses a linked path and keeps file, link, mailbox and record', async t => {
  const custom = await mkdtemp(join(tmpdir(), 'team-session-dir-custom-'));
  const external = await mkdtemp(join(tmpdir(), 'team-session-dir-external-'));
  t.after(async () => { await rm(custom, { recursive: true, force: true }); await rm(external, { recursive: true, force: true }); });
  const { root } = await isolate(t, custom);
  const team = await createTeamRecord({ name: 'Alpha', workspaceRoot: root });
  const victimSid = 'sid-victim-link', victimPid = 9_000_901;
  const target = await writeSession(external, 'real.jsonl', 'REAL-BODY', victimSid);
  const link = join(custom, 'sid-victim-link.jsonl');
  await mkdir(custom, { recursive: true });
  await symlink(target, link);
  assert.ok(await joinTeam(team.id, { sessionId: victimSid, sessionName: 'Probe', pid: victimPid, now: 1_000 }), 'the victim joined');
  assert.equal((await noteMemberEvent(team.id, victimSid, { sessionFile: link, ownerPid: victimPid })).status, 'written', 'the record carries the SDK path');
  await sendToMember(team.id, { from: 'Self', fromId: 'self-1', toSessionId: victimSid, body: '保留我', now: 1_001 });
  const h = host(root);
  const registration = registerTeam(h.pi, { msg: chinese, alive: () => false });
  assert.ok(await joinTeam(team.id, { sessionId: 'self-1', sessionName: 'Self', pid: 9_000_777, now: 1_000 }), 'the acting session joined');
  h.pi.appendEntry('pi-dag-workflow.team-pointer', { teamId: team.id, memberName: 'Self' });
  await assert.rejects(() => registration.deleteSession(h.ctx, 'Probe'), /无法定位/, 'the delete refuses a linked path');
  assert.equal(existsSync(target), true, 'the real session behind the link still exists');
  assert.equal(lstatSync(link).isSymbolicLink(), true, 'the link itself was not removed either');
  assert.equal((await previewInbox(team.id, victimSid)).length, 1, 'the mailbox was not swept');
  assert.equal((await readMembers(team.id)).some(member => member.sessionId === victimSid), true, 'the member record was not removed');
  assert.equal(h.notices.some(item => /移入回收站|永久删除/.test(item.message)), false, 'no delete was reported');
});

test('ticket62 a known path that went stale is refused instead of guessing another file', async t => {
  const custom = await mkdtemp(join(tmpdir(), 'team-session-dir-custom-'));
  t.after(() => rm(custom, { recursive: true, force: true }));
  const { root, agent } = await isolate(t, custom);
  const team = await createTeamRecord({ name: 'Alpha', workspaceRoot: root });
  const victimSid = 'sid-stale', victimPid = 9_000_902;
  const recorded = join(custom, 'sid-stale.jsonl');
  await mkdir(custom, { recursive: true });
  await writeFile(recorded, '');
  await rm(recorded);
  // A perfectly good file with the same SID sits in the default root: it is not this member's file.
  const decoy = await writeSession(join(agent, 'sessions', 'project'), 'sid-stale.jsonl', 'DECOY', victimSid);
  assert.equal(sessionFileFor(victimSid, { recorded }), undefined, 'a stale known path does not fall back to a scan');
  assert.equal(sessionFileFor(victimSid), decoy, 'the decoy is only reachable without a recorded fact');
  assert.ok(await joinTeam(team.id, { sessionId: victimSid, sessionName: 'Probe', pid: victimPid, now: 1_000 }), 'the victim joined');
  assert.equal((await noteMemberEvent(team.id, victimSid, { sessionFile: recorded, ownerPid: victimPid })).status, 'written');
  await sendToMember(team.id, { from: 'Self', fromId: 'self-1', toSessionId: victimSid, body: '保留我', now: 1_001 });
  const h = host(root);
  const registration = registerTeam(h.pi, { msg: chinese, alive: () => false });
  assert.ok(await joinTeam(team.id, { sessionId: 'self-1', sessionName: 'Self', pid: 9_000_777, now: 1_000 }), 'the acting session joined');
  h.pi.appendEntry('pi-dag-workflow.team-pointer', { teamId: team.id, memberName: 'Self' });
  await assert.rejects(() => registration.deleteSession(h.ctx, 'Probe'), /无法定位/, 'the delete refuses rather than deleting the decoy');
  assert.equal(existsSync(decoy), true, 'the same-SID file in another root is untouched');
  assert.equal((await previewInbox(team.id, victimSid)).length, 1, 'the mailbox was not swept');
  assert.equal((await readMembers(team.id)).some(member => member.sessionId === victimSid), true, 'the member record was not removed');
});
