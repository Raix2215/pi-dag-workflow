/** Pure team registry rules: no filesystem, no Pi APIs. */
export type MemberState = 'attached' | 'headless' | 'offline';
/**
 * One launch's runtime files: the FIFO, its log and the PID sidecar, all named by the launch id.
 * `pid`/`pidFile` are the PID evidence that a launch really started that process; records written
 * before they existed stay readable and simply carry no proof.
 */
export interface RuntimeRecord { fifo: string; log: string; pidFile?: string; pid?: number }
export interface TeamHolder {
  pid: number;
  since: number;
  /**
   * Legacy field: older records carry it and it is still read, but nothing writes or decides by it any
   * more. A long turn writes no beat for minutes and is still working, so age is not evidence.
   */
  heartbeatAt?: number;
}
export type AutoMessages = 'off' | 'background' | 'all';
export interface MemberSettings { model?: string; thinking?: string; memberName?: string; sessionName?: string }
export interface MemberControl {
  id: string; fromId: string; pid: number; generation: number; instanceId?: string; patch: MemberSettings;
  status: 'pending' | 'applied' | 'failed'; error?: string;
}
export interface TeamMember {
  /** Observations reported by the owning process; control is one user-UI request, never a chat command. */
  model?: string; thinking?: string; sessionName?: string; instanceId?: string; control?: MemberControl; bootstrap?: 'pending' | 'confirmed' | 'failed';
  sessionId: string; name: string; role?: string; state: MemberState; holder: TeamHolder; retrying: boolean; generation: number; autoMessages?: AutoMessages;
  /** Runtime wiring of a launched member, so it can be stopped and cleaned up. */
  runtime?: RuntimeRecord;
  /** Last `turn_end` observed for this member; kept for the snapshot a 51 reader will consume. */
  lastTurnAt?: number;
  /** The last *real* event this member reported (turn start, tool call, turn end, settlement). */
  lastActivityAt?: number;
  /** Whether that member is inside a run: set on turn start/tool call, cleared only by a real settlement. */
  busy?: boolean;
  /**
   * The session file this member reported at its own holder boundary, straight from the SDK: a path when it
   * has one, `null` when the SDK says there is none yet, absent when an older record never recorded the fact.
   * It is a path fact only — nothing here reads, writes or invents a conversation.
   */
  sessionFile?: string | null;
}
export interface TeamManifest {
  id: string; name: string; workspaceRoot: string;
  /**
   * Historic metadata only. The team goal left the product with the shared todo list; the value older
   * manifests carry stays untouched by every normal manifest update and by dissolution.
   */
  goal?: string;
  nextId: number; leadMemberName?: string;
}
export interface TeamPointer { teamId: string; memberName: string }

/**
 * `holder.pid === 0` means "no holder process": a member whose record this process gave up when it
 * took over another session (one process represents one member). It is never probed and always reads
 * offline, so a released record cannot masquerade as an attached one.
 */
export const RELEASED_PID = 0;
/**
 * The pid a liveness probe may look at, or `undefined` when there is no process to probe.
 * `RELEASED_PID` is 0 and `process.kill(0, 0)` addresses the whole process group, so a released
 * record must never reach a probe: every call site asks here first.
 */
/**
 * Only a real process id may reach a probe or a signal. A released record (pid 0) and any corrupted
 * value — negative, zero, non-integer — has no process: signalling it could hit a whole process group.
 */
export const holderProcess = (member: { holder?: { pid?: unknown } } | undefined): number | undefined => {
  const pid = member?.holder?.pid;
  return Number.isSafeInteger(pid) && (pid as number) > 0 ? pid as number : undefined;
};

/**
 * Nothing here is derived from a timestamp. A process is either probed alive, probed gone, or unknown
 * because this host cannot probe it; a silent long turn is working, not stale.
 */
/** Why a member shows what it shows: the label must name the cause and the action. */
export type MemberReason = 'ok' | 'exited' | 'unknown';
export interface MemberStatus { state: MemberState; reason: MemberReason; /** The pid the verdict is about, when the record has one. */ pid?: number }

/**
 * Three answers, one source: the pid probe. `true`/`false` are facts about that process; `undefined`
 * means this host could not ask, and an unasked question is never reported as an exit. A corrupt holder
 * (negative, zero-width, fractional, missing) is not a released record either: it is *unknown*, so it is
 * never called exited, never dropped as dead and never handed to a probe or a signal.
 */
export function memberStatus(member: Pick<TeamMember, 'holder' | 'state'>, alive: boolean | undefined, background: boolean): MemberStatus {
  // Only the explicit release sentinel means "no process, gone on purpose".
  if (member.holder?.pid === RELEASED_PID) return { state: 'offline', reason: 'exited' };
  const pid = holderProcess(member);
  // Anything else without a legal positive pid is a corrupt record: unknown, kept, never deleted, and never
  // reported as an exit just because the record is damaged.
  if (pid === undefined) return { state: member.state ?? 'attached', reason: 'unknown' };
  if (alive === false) return { state: 'offline', reason: 'exited', pid };
  // No probe: the record keeps its last known shape, and the reason says the process was not confirmed.
  if (alive === undefined) return { state: member.state, reason: 'unknown', pid };
  return { state: background ? 'headless' : 'attached', reason: 'ok', pid };
}

export function memberState(member: Pick<TeamMember, 'holder' | 'state'>, alive: boolean | undefined, background: boolean): MemberState {
  return memberStatus(member, alive, background).state;
}

/** Next free member name: Pi session name when given, otherwise member-N within the team. */
export function nextMemberName(existing: readonly TeamMember[], sessionName?: string): string {
  const name = sessionName?.trim();
  if (name) return name;
  let max = 0;
  for (const member of existing) {
    const match = /^member-(\d+)$/.exec(member.name);
    if (match) max = Math.max(max, Number(match[1]));
  }
  return `member-${max + 1}`;
}

/** Fuzzy match by name inside one workspace: exact first, then substring; ambiguity keeps candidates. */
export function resolveTeamName(teams: readonly TeamManifest[], query: string): { team?: TeamManifest; matches: TeamManifest[] } {
  const text = query.trim().toLowerCase();
  if (!text) return { matches: [...teams] };
  const exact = teams.filter(team => team.name.toLowerCase() === text);
  if (exact.length === 1) return { team: exact[0]!, matches: exact };
  const partial = teams.filter(team => team.name.toLowerCase().includes(text));
  return partial.length === 1 ? { team: partial[0]!, matches: partial } : { matches: partial };
}

/** The team directory is authoritative: the branch pointer only names a member record. */
export function memberFromPointer(pointer: TeamPointer | undefined, members: readonly TeamMember[]): TeamMember | undefined {
  if (!pointer) return undefined;
  return members.find(member => member.name === pointer.memberName) ?? undefined;
}

/** Actionable resolution message for `--team`, never a vague "please check". */
export function teamResolutionHint(query: string, candidates: readonly TeamManifest[], listHint = 'create one from the /team panel or pass an existing name'): string {
  if (candidates.length > 1) return `Team "${query}" matches ${candidates.map(team => team.name).join(', ')}; pass the full name`;
  return `No team matches "${query}" in this workspace; ${listHint}`;
}

/**
 * Elect the longest surviving **attached** member: holder.since ascending, name only as a stable tie-break.
 *
 * A candidate is decided from its own record, never from a caller-wide flag: the record must say `attached`,
 * and it must not be confirmed dead. `alive === false` drops it; `alive === undefined` means this host cannot
 * probe, which is not an exit, so the candidate stays. A released record (pid 0) has no process at all: it is
 * excluded and its pid never reaches the probe. A headless member is never elected — it has no foreground
 * session to lead from. No candidate returns undefined ("无领队待命"), which is the state the panel already
 * shows; nothing new is invented here.
 */
export function electLead(members: readonly TeamMember[], alive?: (pid: number) => boolean): string | undefined {
  const candidates = members.filter(member => {
    if (member.state !== 'attached') return false;
    if (member.holder?.pid === RELEASED_PID) return false;
    // A corrupt pid cannot be probed either: unconfirmed is not dead, so the record stays a candidate.
    const probePid = holderProcess(member);
    const probed = probePid === undefined ? undefined : alive?.(probePid);
    return probed !== false;
  });
  if (!candidates.length) return undefined;
  const sorted = [...candidates].sort((a, b) => a.holder.since - b.holder.since || a.name.localeCompare(b.name));
  return sorted[0]!.name;
}
