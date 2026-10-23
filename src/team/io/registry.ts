import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { configPaths } from '../../shared/config.ts';
import { electLead, holderProcess, memberState, nextMemberName, RELEASED_PID, type AutoMessages, type MemberSettings, type RuntimeRecord, type TeamManifest, type TeamMember } from '../domain/teams.ts';
import { withLock } from './lock.ts';

/** Team data is its own directory shape: never reuse the machine-wide workflow config writer. */
export const teamsRoot = () => join(configPaths().directory, 'teams');
const teamDir = (id: string) => join(teamsRoot(), id);
const manifestPath = (id: string) => join(teamDir(id), 'team.json');
const manifestLock = (id: string) => join(teamDir(id), 'team.lock');
/**
 * One short-lived lock per team for member-name allocation. Two sessions joining or renaming at the same time
 * would otherwise each pick the same free name under their own member lock. Lock order: name, then member.
 */
const nameLock = (id: string) => join(teamDir(id), 'names.lock');
const membersDir = (id: string) => join(teamDir(id), 'members');
const memberPath = (id: string, sessionId: string) => join(membersDir(id), `${sessionId}.json`);
/** Baseline epoch keeps timestamps monotonic and readable without Date in pure callers. */
export const now = () => Date.now();

async function readJson<T>(path: string): Promise<T | undefined> {
  try { return JSON.parse(await readFile(path, 'utf8')) as T; }
  catch { return undefined; }
}
async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(join(path, '..'), { recursive: true });
  const temporary = `${path}.${randomBytes(4).toString('hex')}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, path);
}

export function newTeamId(existing: readonly string[] = []): string {
  for (;;) {
    const id = `t-${randomBytes(2).toString('hex')}`;
    if (!existing.includes(id)) return id;
  }
}

export async function createTeam(input: { name: string; workspaceRoot: string }): Promise<TeamManifest> {
  const existing = (await readdir(teamsRoot()).catch(() => [] as string[])).filter(name => name.startsWith('t-'));
  const manifest: TeamManifest = { id: newTeamId(existing), name: input.name.trim(), workspaceRoot: input.workspaceRoot, nextId: 1 };
  await writeJson(manifestPath(manifest.id), manifest);
  await mkdir(membersDir(manifest.id), { recursive: true });
  return manifest;
}

export async function readTeam(id: string): Promise<TeamManifest | undefined> { return readJson<TeamManifest>(manifestPath(id)); }

/**
 * The only writer of team.json. Every field — name, goal, lead, nextId — goes through this lock, and
 * the patch re-reads the current manifest inside it, so one field can never write back another
 * field's old value. Lock order: the manifest lock is innermost; never wait on a process, a message
 * or another team's files while holding it.
 */
export async function updateTeam(
  id: string,
  patch: (team: TeamManifest) => TeamManifest | undefined | Promise<TeamManifest | undefined>,
): Promise<TeamManifest | undefined> {
  try {
    return await withLock(manifestLock(id), async () => {
      const team = await readTeam(id);
      if (!team) return undefined;
      const next = await patch(team);
      // No write needed: report the manifest as it is now, read under the lock, not a pre-lock copy.
      if (!next) return team;
      await writeJson(manifestPath(id), next);
      return next;
    });
  } catch (cause) {
    // A team that does not exist has no directory to lock in. Report "no such team" instead of
    // leaking the lock's ENOENT, and never create a directory just to take a lock in it.
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT' && !await readTeam(id)) return undefined;
    throw cause;
  }
}

export async function listTeams(workspaceRoot: string): Promise<TeamManifest[]> {
  const ids = (await readdir(teamsRoot()).catch(() => [] as string[])).filter(name => name.startsWith('t-'));
  const manifests = await Promise.all(ids.map(id => readTeam(id)));
  return manifests.filter((team): team is TeamManifest => !!team && team.workspaceRoot === workspaceRoot).sort((a, b) => a.name.localeCompare(b.name));
}

/** Renaming only edits the manifest; the directory keeps its id. */
export async function renameTeam(id: string, name: string): Promise<TeamManifest | undefined> {
  return updateTeam(id, team => ({ ...team, name: name.trim() }));
}

export async function readMembers(id: string): Promise<TeamMember[]> {
  const files = (await readdir(membersDir(id)).catch(() => [] as string[])).filter(name => name.endsWith('.json'));
  const members = await Promise.all(files.map(async file => {
    const member = await readJson<TeamMember>(join(membersDir(id), file));
    return member && typeof member.sessionId === 'string' && typeof member.name === 'string' ? member : undefined;
  }));
  return members.filter((member): member is TeamMember => !!member);
}

/**
 * One member record by its stable session id: a single file read, so a watcher can re-read it cheaply
 * instead of scanning the roster. A missing file is undefined, never a guess.
 */
export async function readMember(id: string, sessionId: string): Promise<TeamMember | undefined> {
  const member = await readJson<TeamMember>(memberPath(id, sessionId));
  return member && typeof member.sessionId === 'string' && typeof member.name === 'string' ? member : undefined;
}

const memberLock = (id: string, sessionId: string) => join(membersDir(id), `${sessionId}.lock`);

/** What a caller last saw: a write only applies while the record still matches it. */
export interface MemberToken { pid: number; generation: number }

/**
 * The only writer of a member record. Every field — holder, state, settings, runtime — goes through
 * this per-member lock, and the patch re-reads the current record inside it, so an old process can
 * never write its pre-takeover holder or generation back. Lock order: a member lock is innermost and
 * never waits on a process, a message, the manifest, or another member.
 */
async function updateMember(
  id: string,
  sessionId: string,
  patch: (member: TeamMember | undefined) => TeamMember | undefined | Promise<TeamMember | undefined>,
): Promise<TeamMember | undefined> {
  // A dissolved team has no active manifest: its old processes may not keep writing member records.
  if (!await readTeam(id)) return undefined;
  try {
    return await withLock(memberLock(id, sessionId), async () => {
      const member = await readJson<TeamMember>(memberPath(id, sessionId));
      const next = await patch(member);
      // No write needed: report the record as it is now, read under the lock.
      if (!next) return member;
      await writeJson(memberPath(id, sessionId), next);
      return next;
    });
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT' && !await readJson<TeamMember>(memberPath(id, sessionId))) return undefined;
    throw cause;
  }
}

export async function joinTeam(id: string, input: { sessionId: string; sessionName?: string; pid: number; role?: string; now: number; alive?: (pid: number) => boolean }): Promise<TeamMember | undefined> {
  const team = await readTeam(id);
  if (!team) return undefined;
  // The whole name allocation runs under the team name lock, so a concurrent join cannot take the same one.
  let blocked: number | undefined;
  let collision: string | undefined;
  const member = await withLock(nameLock(id), () => updateMember(id, input.sessionId, async current => {
    const holderPid = current ? holderProcess(current) : undefined;
    // Without a probe a foreign holder counts as alive: an explicit --team never assumes "dead".
    const live = holderPid !== undefined && (holderPid === input.pid || (input.alive ? input.alive(holderPid) : true));
    // An explicit --team must not silently replace a live foreign holder: the same pid, a dead pid or
    // a released record resumes; a live foreign one follows the existing anti-double-open rule.
    if (current && holderPid !== input.pid && live) { blocked = holderPid; return undefined; }
    // Naming needs the rest of the roster; reading member files waits on no lock.
    const roster = (await readMembers(id)).filter(member => member.sessionId !== input.sessionId);
    const explicit = input.sessionName?.trim();
    // A resumed session keeps its own name; a new one must take the explicit name or an unused default. A
    // collision is refused instead of silently becoming a different name.
    if (!current && explicit && roster.some(member => member.name === explicit)) { collision = explicit; return undefined; }
    const name = current?.name ?? (explicit || nextMemberName(roster));
    return {
      sessionId: input.sessionId,
      name,
      ...(input.role !== undefined ? { role: input.role } : current?.role !== undefined ? { role: current.role } : {}),
      state: 'attached',
      holder: { pid: input.pid, since: input.now },
      retrying: current?.retrying ?? false,
      generation: (current?.generation ?? 0) + 1,
      autoMessages: current?.autoMessages ?? 'background',
      ...(current?.runtime ? { runtime: current.runtime } : {}),
      ...(current?.lastTurnAt !== undefined ? { lastTurnAt: current.lastTurnAt } : {}),
    };
  }));
  if (collision !== undefined) throw new Error(`团队成员名 ${collision} 已被另一个会话使用：换一个名字，或在 /team 里先改名`);
  if (blocked !== undefined) throw new Error(`该会话的成员记录仍被另一个运行中的进程（pid ${blocked}）持有；先停下那个进程，或从 /team 发起接管`);
  if (!member) return undefined;
  // Default to this member as lead only if the manifest still has none, decided under its lock.
  await updateTeam(id, current => current.leadMemberName ? undefined : { ...current, leadMemberName: member.name });
  return member;
}

export async function assignLead(id: string, memberName: string): Promise<TeamManifest | undefined> {
  const members = await readMembers(id);
  const target = members.find(m => m.name === memberName);
  if (!target) return undefined;
  return updateTeam(id, team => ({ ...team, leadMemberName: target.name }));
}

/** The real boundaries a member reports. There is no heartbeat: only these events carry a time. */
export type MemberActivity = 'turn_start' | 'tool_call' | 'turn_end' | 'settled';

/**
 * A member event writes what actually happened: the pid-derived state, the Retry flag, and — for a real
 * boundary — the activity time and the busy fact. No heartbeat is written and no age threshold exists:
 * silence is simply "no event since the last one". Everything here goes through the holder fence, so an
 * event that started before a takeover can neither write the old pid nor the old generation back, and it
 * cannot leave a late timestamp on the new representative.
 */
export async function noteMemberEvent(
  id: string,
  sessionId: string,
  input: { alive?: boolean; retrying?: boolean; background?: boolean; ownerPid?: number; activity?: MemberActivity; at?: number; sessionFile?: string | null; model?: string; thinking?: string; sessionName?: string; instanceId?: string; bootstrap?: TeamMember['bootstrap'] } = {},
): Promise<{ status: 'written' | 'lost' | 'missing'; member?: TeamMember; holderPid?: number }> {
  // The holder check runs inside the member lock: an event that started before a takeover must not
  // write the old pid or an older generation back over the new holder.
  const member = await updateMember(id, sessionId, current => {
    if (!current) return undefined;
    if (input.ownerPid !== undefined && current.holder.pid !== input.ownerPid) return undefined;
    const background = input.background ?? current.state === 'headless';
    const at = input.at ?? Date.now();
    const activity = input.activity;
    return {
      ...current,
      state: memberState(current, input.alive, background),
      ...(input.retrying === undefined ? {} : { retrying: input.retrying }),
      // A real boundary is the only thing that moves activity: turn start and tool calls mean "inside a
      // run", and only a real settlement means "idle again" (turn_end is not full settlement).
      ...(activity === undefined ? {} : { lastActivityAt: at, busy: activity === 'settled' ? false : activity === 'turn_end' ? current.busy ?? true : true }),
      ...(activity === 'turn_end' ? { lastTurnAt: at } : {}),
      // The file fact moves only with a real boundary of the process that really holds the record.
      ...(input.sessionFile === undefined ? {} : { sessionFile: input.sessionFile }),
      ...(input.instanceId === undefined ? {} : { instanceId: input.instanceId }),
      ...(input.model === undefined ? {} : { model: input.model }),
      ...(input.thinking === undefined ? {} : { thinking: input.thinking }),
      ...(input.sessionName === undefined ? {} : { sessionName: input.sessionName }),
      ...(input.bootstrap === undefined ? {} : { bootstrap: input.bootstrap }),
    };
  });
  if (!member) return { status: 'missing' };
  if (input.ownerPid !== undefined && member.holder.pid !== input.ownerPid) return { status: 'lost', member, holderPid: member.holder.pid };
  return { status: 'written', member };
}

/**
 * A stopped process is gone: the record says `offline` outright. `since` is the stop time; no freshness
 * stamp is written, because nothing reads one any more.
 */
export async function markMemberOffline(id: string, sessionId: string, at: number, expected?: MemberToken): Promise<'written' | 'conflict' | 'missing'> {
  let outcome: 'written' | 'conflict' | 'missing' = 'missing';
  const member = await updateMember(id, sessionId, current => {
    if (!current) return undefined;
    if (expected && (current.holder.pid !== expected.pid || current.generation !== expected.generation)) { outcome = 'conflict'; return undefined; }
    outcome = 'written';
    return { ...current, state: 'offline', holder: { pid: current.holder.pid, since: at } };
  });
  return member ? outcome : 'missing';
}

/**
 * A member whose record this process no longer represents: keep the record (its tasks and mail stay
 * readable) but drop the holder, so it reads offline and no heartbeat can revive it.
 */
export async function releaseMember(id: string, sessionId: string, at: number, expected?: MemberToken): Promise<'released' | 'conflict' | 'missing'> {
  let outcome: 'released' | 'conflict' | 'missing' = 'missing';
  const member = await updateMember(id, sessionId, current => {
    if (!current) return undefined;
    if (expected && (current.holder.pid !== expected.pid || current.generation !== expected.generation)) { outcome = 'conflict'; return undefined; }
    outcome = 'released';
    return { ...current, state: 'offline', holder: { pid: RELEASED_PID, since: at } };
  });
  return member ? outcome : 'missing';
}

/**
 * The rollback of a cancelled switch restores only what this attempt changed: the holder and state it
 * replaced, never the whole old object, and never a lower generation. A third party that took the
 * record over in the meantime makes the token mismatch, so the rollback is skipped instead of
 * reviving the previous representative.
 */
export async function restoreMember(
  id: string,
  sessionId: string,
  snapshot: Pick<TeamMember, 'holder' | 'state'>,
  expected?: MemberToken,
): Promise<'restored' | 'conflict' | 'missing'> {
  let outcome: 'restored' | 'conflict' | 'missing' = 'missing';
  const member = await updateMember(id, sessionId, current => {
    if (!current) return undefined;
    if (expected && (current.holder.pid !== expected.pid || current.generation !== expected.generation)) { outcome = 'conflict'; return undefined; }
    outcome = 'restored';
    return { ...current, holder: snapshot.holder, state: snapshot.state, generation: current.generation + 1 };
  });
  return member ? outcome : 'missing';
}

/** Takeover swaps the holder pid on the same session; a live holder needs an explicit force. */
export async function claimOwnership(id: string, sessionId: string, input: { pid: number; now: number; force?: boolean; probe?: (pid: number) => boolean }): Promise<{ status: 'direct' | 'blocked' | 'forced' | 'missing'; member?: TeamMember; previous?: TeamMember }> {
  // Decide, bump and write under one lock: two claimants from the same old generation cannot both
  // report a successful takeover, and the liveness question is asked about the holder this lock sees
  // — never about a record read before it.
  let status: 'direct' | 'blocked' | 'forced' | 'missing' = 'missing';
  let previous: TeamMember | undefined;
  const member = await updateMember(id, sessionId, current => {
    if (!current) return undefined;
    const holderPid = holderProcess(current);
    // A released or corrupted record has no process; our own pid is a resume. Any other holder is
    // asked of the probe, and without one it is conservatively treated as alive.
    const foreign = holderPid !== undefined && holderPid !== input.pid;
    const alive = foreign ? (input.probe ? input.probe(holderPid) : true) : false;
    if (alive && !input.force) { status = 'blocked'; return undefined; }
    status = alive ? 'forced' : 'direct';
    // The record this claim replaces: a rollback restores that, never a snapshot read before the lock.
    previous = { ...current };
    return { ...current, holder: { pid: input.pid, since: input.now }, generation: current.generation + 1 };
  });
  if (!member) return { status: 'missing' };
  return { status, member, ...(previous ? { previous } : {}) };
}

/** Panel ticket owns the three-state switch; this is its write path. */
/** Remember a launched member's runtime files so a panel stop can find and clean them up. */
export async function setMemberRuntime(id: string, sessionId: string, runtime: RuntimeRecord): Promise<TeamMember | undefined> {
  return updateMember(id, sessionId, current => current ? { ...current, runtime } : undefined);
}

/**
 * Attach a launch's runtime files to the member record that launch produced — but only while that record
 * is still held by the PID the launch really started. The check runs inside the member lock, so a record
 * another process took over in the meantime is left alone: nobody writes someone else's channel.
 */
export async function bindMemberRuntime(id: string, sessionId: string, runtime: RuntimeRecord, expectedPid: number): Promise<'bound' | 'conflict' | 'missing'> {
  let outcome: 'bound' | 'conflict' = 'conflict';
  const member = await updateMember(id, sessionId, current => {
    if (!current) return undefined;
    if (holderProcess(current) !== expectedPid) { outcome = 'conflict'; return undefined; }
    outcome = 'bound';
    return { ...current, runtime };
  });
  return member ? outcome : 'missing';
}

/** Remove one member record; the caller decides whether the session file should stay. */
export type RemoveOutcome = 'removed' | 'conflict' | 'missing';

export async function removeMember(
  id: string,
  sessionId: string,
  expected?: MemberToken,
  guard?: { probe?: ((pid: number) => boolean) | undefined; selfPid?: number | undefined },
): Promise<boolean | RemoveOutcome> {
  try {
    return await withLock(nameLock(id), () => withLock(memberLock(id, sessionId), async () => {
      const member = await readJson<TeamMember>(memberPath(id, sessionId));
      if (!member) return guard ? 'missing' as const : false;
      if (expected && (member.holder.pid !== expected.pid || member.generation !== expected.generation)) return guard ? 'conflict' as const : false;
      // The guard decides only when the caller states which process it is: then a record a *different*
      // live process holds is left alone. Without that, the token check above is all we can know.
      const holderPid = holderProcess(member);
      const foreign = guard?.selfPid !== undefined && holderPid !== undefined && holderPid !== guard.selfPid;
      // A foreign holder that cannot be probed is treated as alive: refusal is the safe answer.
      if (foreign && (guard?.probe ? guard.probe(holderPid) : true)) return 'conflict' as const;
      await rm(memberPath(id, sessionId), { force: true });
      return guard ? 'removed' as const : true;
    }));
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT' && !await readJson<TeamMember>(memberPath(id, sessionId))) return guard ? 'missing' as const : false;
    throw cause;
  }
}

export async function setAutoMessages(id: string, sessionId: string, mode: AutoMessages): Promise<TeamMember | undefined> {
  return updateMember(id, sessionId, current => current ? { ...current, autoMessages: mode } : undefined);
}

/**
 * Rename a member's display label. The session id is the identity; no other field changes.
 */
export async function renameMember(id: string, sessionId: string, name: string, expected?: MemberToken & { instanceId?: string }): Promise<TeamMember | undefined> {
  const clean = name.trim();
  if (!clean) return undefined;
  return withLock(nameLock(id), async () => {
    let previous: string | undefined;
    const renamed = await updateMember(id, sessionId, async current => {
    if (!current || expected && (current.holder.pid !== expected.pid || current.generation !== expected.generation || expected.instanceId !== undefined && current.instanceId !== expected.instanceId)) return undefined;
    previous = current.name;
    const roster = await readMembers(id);
    if (roster.some(member => member.sessionId !== sessionId && member.name === clean)) {
      throw new Error(`团队成员名 ${clean} 已被另一个会话使用：换一个名字，或先在 /team 里改那个成员的名字`);
    }
    return { ...current, name: clean };
    });
    if (renamed?.name === clean && previous) await updateTeam(id, team => team.leadMemberName === previous ? { ...team, leadMemberName: clean } : undefined);
    return renamed;
  });
}

/** One pending patch per SID. New edits merge until applied; the holder token fences execution. */
export async function requestMemberControl(id: string, sessionId: string, fromId: string, patch: MemberSettings, expected: MemberToken & { instanceId?: string }): Promise<TeamMember | undefined> {
  let queued = false;
  const member = await updateMember(id, sessionId, current => {
    if (!current || current.holder.pid !== expected.pid || current.generation !== expected.generation || current.instanceId !== expected.instanceId) return undefined;
    queued = true;
    return { ...current, control: {
      id: randomBytes(12).toString('hex'), fromId, pid: current.holder.pid, generation: current.generation, ...(current.instanceId ? { instanceId: current.instanceId } : {}),
      patch: { ...(current.control?.status === 'pending' ? current.control.patch : {}), ...patch }, status: 'pending',
    } };
  });
  return queued ? member : undefined;
}
export async function finishMemberControl(id: string, sessionId: string, requestId: string, expected: MemberToken & { instanceId?: string }, error?: string): Promise<void> {
  await updateMember(id, sessionId, current => current?.control?.id === requestId && current.holder.pid === expected.pid && current.generation === expected.generation && (expected.instanceId === undefined || current.instanceId === expected.instanceId)
    ? { ...current, control: { ...current.control, status: error ? 'failed' : 'applied', ...(error ? { error } : {}) } } : undefined);
}

export async function leaveTeam(id: string, sessionId: string, alive?: (pid: number) => boolean, selfPid?: number): Promise<{ removed: boolean; dissolved: boolean; newLead?: string; conflict?: boolean }> {
  const team = await readTeam(id);
  if (!team) return { removed: false, dissolved: true };
  const members = await readMembers(id);
  const leaving = members.find(m => m.sessionId === sessionId);
  // The record is removed under its own lock and only while it still matches this snapshot: a member
  // that a live foreign process now holds keeps its record.
  const outcome: RemoveOutcome = leaving
    ? await removeMember(id, sessionId, { pid: leaving.holder.pid, generation: leaving.generation }, { probe: alive, selfPid }) as RemoveOutcome
    : 'missing';
  if (outcome === 'conflict') return { removed: false, dissolved: false, conflict: true };
  const remaining = await readMembers(id);
  // Whatever the lead becomes, it is reported from the manifest observed or written under the lock.
  let observedLead = team.leadMemberName;
  if (!remaining.length) {
    const after = await updateTeam(id, current => {
      // A concurrent manual assignment wins: only clear the lead that actually left.
      if (current.leadMemberName === undefined || current.leadMemberName !== leaving?.name) return undefined;
      const { leadMemberName: _lead, ...rest } = current;
      return rest;
    });
    observedLead = after?.leadMemberName;
  } else {
    const elected = electLead(remaining, alive);
    const after = await updateTeam(id, current => {
      // A concurrent manual assignment wins: only replace the lead that actually left.
      if (current.leadMemberName !== leaving?.name) return undefined;
      const { leadMemberName: _lead, ...rest } = current;
      return elected === undefined ? rest : { ...rest, leadMemberName: elected };
    });
    observedLead = after?.leadMemberName;
  }
  return { removed: true, dissolved: false, ...(observedLead !== undefined ? { newLead: observedLead } : {}) };
}

/** The inactive carrier a dissolved team keeps in its own directory: data never moves. */
export const archivedManifestPath = (id: string) => join(teamDir(id), 'team.archived.json');

/**
 * Dissolving only de-registers the team: under the manifest lock the active `team.json` is renamed to
 * `team.archived.json` in the same directory. Nothing moves — the member records, the old task files,
 * the mailboxes and every runtime path keep their absolute location — so a panel action can never
 * destroy or relocate what a member wrote, and the historic goal keeps its bytes in the old manifest.
 * `readTeam`/`listTeams` only accept `team.json`, so the team is no longer active, and its `t-` directory
 * still keeps `createTeam` from reusing the old id.
 */
export async function dissolveTeam(id: string, options: { onlyIfEmpty?: boolean } = {}): Promise<boolean> {
  try {
    // Serialize with joinTeam: no member can arrive between the empty check and archival.
    return await withLock(nameLock(id), () => withLock(manifestLock(id), async () => {
      const team = await readTeam(id);
      if (!team) return false;
      if (options.onlyIfEmpty) {
        const files = await readdir(membersDir(id)).catch((cause: NodeJS.ErrnoException) => {
          if (cause.code === 'ENOENT') return [];
          throw cause;
        });
        if (files.some(file => file.endsWith('.json'))) return false;
      }
      const target = archivedManifestPath(id);
      // A second dissolution (a restored copy) must not overwrite the first carrier.
      let path = target;
      for (let suffix = 1; suffix < 1_000; suffix += 1) {
        try { await stat(path); path = join(teamDir(id), `team.archived.${suffix}.json`); } catch { break; }
      }
      await rename(manifestPath(id), path);
      return true;
    }));
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT' && !await readTeam(id)) return false;
    throw cause;
  }
}
