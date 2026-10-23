/** Cross-team, per-stable-SID operation lock and the same-SID holder census it protects. */
import { mkdir, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { readTeam, teamsRoot } from './registry.ts';
import { withLock } from './lock.ts';
import type { TeamMember } from '../domain/teams.ts';

/** Every managed SID operation (launch, switch, and a later delete) takes this one short lock. */
const lockPath = (sessionId: string) => join(teamsRoot(), '.sid-locks', `${sessionId}.lock`);

/**
 * One stable SID has one operation at a time across *all* teams. The lock lives outside any single team
 * directory because a session may hold a record in more than one, and because a dissolved team's records stay
 * where they are. Lock order: this lock is outermost; no member or manifest lock is held while waiting.
 */
export async function withSidLock<T>(sessionId: string, run: () => Promise<T>): Promise<T> {
  await mkdir(join(teamsRoot(), '.sid-locks'), { recursive: true });
  return withLock(lockPath(sessionId), run, '该会话正在另一个受管操作里（接管／拉起／删除）；稍后重试');
}

export interface SidHolder {
  teamId: string;
  /** The manifest is gone (dissolved): the record is a residue an older process may still be running. */
  archived: boolean;
  member: TeamMember;
  /** A usable positive pid, or undefined when the record has none. */
  pid: number | undefined;
  /** PID 0 is the explicit release sentinel: no process, and nothing to wait for or stop. */
  released: boolean;
}

/**
 * Every team's record for this stable SID, including teams whose manifest was archived in place. A dissolved
 * team keeps its member records, and an older Pi may still be running under one of them — so it counts too.
 */
export async function holdersOfSid(sessionId: string): Promise<SidHolder[]> {
  const root = teamsRoot();
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  const holders: SidHolder[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith('t-')) continue;
    const teamId = entry.name;
    const active = await readTeam(teamId);
    // A team directory without an active manifest is a dissolved one; its records are still evidence.
    const archived = !active && await readdir(join(root, teamId)).then(names => names.includes('team.archived.json'), () => false);
    if (!active && !archived) continue;
    const files = await readdir(join(root, teamId, 'members')).then(names => names.filter(name => name === `${sessionId}.json`), () => []);
    for (const file of files) {
      const raw = await readFile(join(root, teamId, 'members', file), 'utf8').catch(() => undefined);
      if (!raw) continue;
      let parsed: TeamMember;
      try { parsed = JSON.parse(raw) as TeamMember; } catch { continue; }
      if (typeof parsed?.sessionId !== 'string' || parsed.sessionId !== sessionId) continue;
      const rawPid = parsed.holder?.pid;
      const released = rawPid === 0;
      const pid = Number.isSafeInteger(rawPid) && (rawPid as number) > 0 ? rawPid as number : undefined;
      holders.push({ teamId, archived, member: parsed, pid, released });
    }
  }
  return holders;
}

export type SidConflict = 'other-team-live' | 'multiple-live' | 'unknown-holder';

/**
 * Whether this SID may be managed from `teamId` right now. A live holder in another team, two different live
 * pids, or a holder this host cannot vouch for all refuse: a wrong guess here would stop someone else's
 * process. `undefined` means clear.
 */
export function sidConflict(holders: readonly SidHolder[], teamId: string, selfPid: number, probe: ((pid: number) => boolean) | undefined): { conflict: SidConflict; detail?: string } | undefined {
  const others = holders.filter(holder => holder.teamId !== teamId);
  const usable = (holder: SidHolder) => holder.pid !== undefined && holder.pid !== selfPid;
  const probed = (holder: SidHolder) => holder.pid !== undefined ? (probe ? probe(holder.pid) : undefined) : undefined;
  // Two different live pids anywhere is a state no single takeover can safely resolve.
  const livePids = new Set<number>();
  for (const holder of holders) {
    if (!usable(holder)) continue;
    if (probed(holder) === true) livePids.add(holder.pid!);
  }
  if (livePids.size > 1) return { conflict: 'multiple-live', detail: `同一会话有多个存活进程：${[...livePids].join(', ')}` };
  // A record in another team whose process is alive (or whose liveness cannot be asked) is refused.
  for (const holder of others) {
    if (!usable(holder)) continue;
    const alive = probed(holder);
    if (alive === true) return { conflict: 'other-team-live', detail: `${holder.teamId} 里同一会话仍由 pid ${holder.pid} 持有` };
    if (alive === undefined && !probe) return { conflict: 'unknown-holder', detail: `${holder.teamId} 里同一会话的 pid ${holder.pid} 无法确认` };
  }

  // A record with no usable pid cannot be proven dead: refuse instead of calling it an exit.
  const unusable = holders.find(holder => holder.pid === undefined && !holder.released && holder.member.state !== 'offline');
  if (unusable) return { conflict: 'unknown-holder', detail: '同一会话的记录没有可用 pid，无法确认真实退出' };
  return undefined;
}

export type SidDeleteConflict = 'self-live' | 'live-holder' | 'unknown-holder';

/**
 * Whether this SID's saved session may be destroyed right now. Deleting is stronger than taking over: it needs
 * *no* live holder anywhere (the current session included), and it refuses whenever a holder cannot be probed —
 * the user is told to stop that process by hand instead of guessing that it is gone.
 */
export function sidDeleteConflict(holders: readonly SidHolder[], selfPid: number, probe: ((pid: number) => boolean) | undefined): { conflict: SidDeleteConflict; detail?: string } | undefined {
  for (const holder of holders) {
    if (holder.pid === undefined) {
      // Released means no process; anything else is a record this host cannot vouch for.
      if (!holder.released && holder.member.state !== 'offline') return { conflict: 'unknown-holder', detail: `${holder.teamId} 里的记录没有可用 pid，无法确认进程已退出` };
      continue;
    }
    if (holder.pid === selfPid) return { conflict: 'self-live', detail: `pid ${holder.pid} 就是当前进程（${holder.teamId}）` };
    const alive = probe ? probe(holder.pid) : undefined;
    if (alive === true) return { conflict: 'live-holder', detail: `${holder.teamId} 里同一会话仍由 pid ${holder.pid} 持有` };
    if (alive === undefined) return { conflict: 'unknown-holder', detail: `${holder.teamId} 里同一会话的 pid ${holder.pid} 无法确认是否已退出` };
  }
  return undefined;
}
