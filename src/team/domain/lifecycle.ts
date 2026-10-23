/** Member lifecycle rules are pure: who may be stopped, and when a record may be dropped. */
import { holderProcess, RELEASED_PID, type TeamMember } from './teams.ts';

/** How long `stop` waits for SIGTERM before it escalates to SIGKILL. */
export const STOP_GRACE_MS = 2_000;
/**
 * A freshly created runtime file may belong to a launch that has not joined yet. Without PID evidence
 * cleanup keeps it for this long before it reports the file as unverified — never to delete on age.
 */
export const RUNTIME_PREPARE_MS = 30_000;

export type MemberAction = 'stop' | 'leave' | 'evict' | 'cleanup';

/** `stop`/`evict` need a name; `leave`/`cleanup` never do. */
export function actionNeedsName(action: MemberAction): boolean {
  return action === 'stop' || action === 'evict';
}

/** Only the holder's own process, or an explicitly named member, may be stopped. */
export function mayStop(target: TeamMember | undefined, selfName: string | undefined, requested: string | undefined): boolean {
  if (!target) return false;
  return target.name === requested || target.name === selfName;
}

/**
 * Cleanup may drop a record only on positive evidence that its process is gone: an explicit release
 * (pid 0), or a *legal* positive pid this host probed and found dead. Silence, a corrupt pid or an
 * unreachable host is never evidence, so a long turn or a damaged record can never delete anyone.
 */
export function mayDropRecord(member: TeamMember, alive: boolean | undefined): boolean {
  if (member.holder?.pid === RELEASED_PID) return true;
  const pid = holderProcess(member);
  return pid !== undefined && alive === false;
}
