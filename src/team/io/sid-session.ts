/** Session-file identity and the one supported way to wake an idle RPC member. */
import { closeSync, openSync, readFileSync, readSync, statSync, unlinkSync, writeSync, constants } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { runtimeEvidence } from './runtime.ts';
import { teamsRoot } from './registry.ts';
import type { TeamMember } from '../domain/teams.ts';

/**
 * The SID a saved session file really belongs to, read from its own header.
 *
 * This is a plain bounded read: \`SessionManager.open\` is never used here because opening a legacy file can
 * migrate and rewrite it, and a takeover must never change the file it is about to load.
 */
export function sessionSidOf(path: string, limit = 8 * 1024): string | undefined {
  let fd: number | undefined;
  try {
    fd = openSync(path, 'r');
    const buffer = Buffer.alloc(limit);
    const read = readSync(fd, buffer, 0, limit, 0);
    const head = buffer.subarray(0, read).toString('utf8').split('\n')[0] ?? '';
    const record = JSON.parse(head) as { type?: unknown; sessionId?: unknown; id?: unknown };
    // Only a real session header names a session; any other first line proves nothing about this file.
    if (record?.type !== 'session') return undefined;
    if (typeof record.sessionId === 'string' && record.sessionId) return record.sessionId;
    if (typeof record.id === 'string' && record.id) return record.id;
    return undefined;
  } catch {
    // A header that cannot be read or parsed proves nothing; the caller treats that as "unverified".
    return undefined;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/**
 * Ask an idle RPC member to look at its input again, so it can notice the boundary and leave.
 *
 * Only a runtime pair this team's own evidence proves (three files, matching sidecar PID, and that PID being
 * the old holder) is written to, one non-blocking control line, never a model request. A member without such a
 * channel is left alone: the takeover then waits out its window and reports a manual stop.
 */
export async function wakeIdleRpc(teamId: string, member: TeamMember | undefined): Promise<boolean> {
  if (!member?.runtime) return false;
  const evidence = await runtimeEvidence(teamsRoot(), teamId, member.runtime);
  if ('reason' in evidence || evidence.files.length !== 3) return false;
  if (evidence.pid !== member.holder?.pid) return false;
  let fd: number | undefined;
  try {
    // A regular file wearing a `.fifo` name is not this member's channel: never write into it.
    if (!statSync(member.runtime.fifo).isFIFO()) return false;
    // Opening a FIFO with O_NONBLOCK never waits for a reader, and never creates one.
    fd = openSync(member.runtime.fifo, constants.O_WRONLY | constants.O_NONBLOCK);
    writeSync(fd, `${JSON.stringify({ type: 'get_state' })}\n`);
    return true;
  } catch {
    return false;
  } finally {
    if (fd !== undefined) try { closeSync(fd); } catch { /* already closed */ }
  }
}

/**
 * The one managed operation a runtime replacement is still finishing.
 *
 * `switchSession` builds a new extension runtime, so a variable in the old factory's closure cannot reach the
 * new one. This is therefore one short-lived file per SID, under the SID operation lock, naming the process and
 * session that may consume it exactly once. It is not a queue and not a second source of membership truth: it
 * only stops the previous CLI flags from deciding the target's team and Profile.
 */
export interface SidHandoff { teamId: string; sessionId: string; memberName: string; pid: number; token: number; at: number }

const HANDOFF_TTL_MS = 120_000;
const handoffPath = (sessionId: string) => join(teamsRoot(), '.sid-handoff', `${sessionId}.json`);

export async function writeHandoff(value: SidHandoff): Promise<void> {
  await mkdir(join(teamsRoot(), '.sid-handoff'), { recursive: true });
  await writeFile(handoffPath(value.sessionId), `${JSON.stringify(value)}\n`, { mode: 0o600 });
}

export async function clearHandoff(sessionId: string): Promise<void> {
  await rm(handoffPath(sessionId), { force: true });
}

/** Take this runtime's own handoff once; a stale, foreign-PID or other-session record is discarded. */
export function takeHandoff(sessionId: string, pid: number, now: number): SidHandoff | undefined {
  const path = handoffPath(sessionId);
  let value: SidHandoff;
  try { value = JSON.parse(readFileSync(path, 'utf8')) as SidHandoff; }
  catch { return undefined; }
  const usable = value?.sessionId === sessionId && value.pid === pid
    && Number.isSafeInteger(value.token) && typeof value.teamId === 'string' && typeof value.memberName === 'string'
    && Number.isFinite(value.at) && now - value.at >= 0 && now - value.at <= HANDOFF_TTL_MS;
  if (!usable) return undefined;
  // Only the runtime this record names consumes it; a foreign reader leaves it for the right process.
  try { unlinkSync(path); } catch { /* already gone */ }
  return value;
}
