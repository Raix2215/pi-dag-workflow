import { lstat, mkdir, readdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { basename, dirname, isAbsolute, join, normalize, relative, resolve, sep } from 'node:path';
import { holderProcess, type RuntimeRecord } from '../domain/teams.ts';

/**
 * Where a team's runtime files may live: `<teamsRoot>/<teamId>/runtime`. Everything that deletes a
 * persisted runtime path goes through here first, so a record (possibly written by another host) can
 * never make this process remove a file outside the team, or follow a symlinked directory out of it.
 */
export const runtimeRootOf = (teamsRoot: string, teamId: string) => join(teamsRoot, teamId, 'runtime');

/**
 * The one place that decides where a team's runtime root really is. Everything that deletes or lists
 * files asks this first, so a check cannot drift between the two callers.
 *
 * The configuration root may be a symlink chosen by the host; below it everything must be real: the
 * team directory must resolve to exactly `<realTeamsRoot>/<teamId>` (an alias to a sibling team is not
 * this team), and the runtime directory must be exactly its child.
 */
/** Only a genuinely absent file is `missing`; a permission or IO failure is reported as `io`. */
const reasonFor = (error: unknown, absent: RefuseReason): RefuseReason => {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === 'ENOENT' ? absent : 'io';
};

async function trustedRuntimeRoot(teamsRoot: string, teamId: string): Promise<{ realRuntime: string } | { reason: RefuseReason }> {
  if (!/^[A-Za-z0-9._-]+$/.test(teamId) || teamId === '.' || teamId === '..') return { reason: 'outside' };
  let realTeamsRoot: string, realTeam: string, realRuntime: string;
  try { realTeamsRoot = await realpath(teamsRoot); } catch (error) { return { reason: reasonFor(error, 'unverified-root') }; }
  try { realTeam = await realpath(join(teamsRoot, teamId)); } catch (error) { return { reason: reasonFor(error, 'missing') }; }
  if (realTeam !== join(realTeamsRoot, teamId)) return { reason: 'symlink' };
  try { realRuntime = await realpath(runtimeRootOf(teamsRoot, teamId)); } catch (error) { return { reason: reasonFor(error, 'missing') }; }
  if (realRuntime !== join(realTeam, 'runtime')) return { reason: 'symlink' };
  return { realRuntime };
}

/** Why a path was refused: callers report the category, never the sensitive path itself. */
export type RefuseReason = 'outside' | 'unverified-root' | 'symlink' | 'missing' | 'io';

/** One launch's three files, all under the team runtime root and named by one random launch id. */
export interface RuntimePair { fifo: string; log: string; pidFile: string }

/**
 * A fresh launch id per background operation. The display name never decides a file name, so a renamed,
 * Chinese or absent member name cannot collide with another launch or point at someone else's files.
 */
export function runtimePairFor(teamsRoot: string, teamId: string, launchId: string = randomUUID()): RuntimePair {
  const root = runtimeRootOf(teamsRoot, teamId);
  return { fifo: join(root, `${launchId}.fifo`), log: join(root, `${launchId}.log`), pidFile: join(root, `${launchId}.pid`) };
}

/** The launch id a runtime file belongs to: the three files of one launch are decided together. */
const runtimeLaunchId = (path: string): string => basename(path).replace(/\.(?:fifo|log|pid)$/, '');

/**
 * The write side of the runtime root: a background launch may only put its FIFO where the read side can
 * later verify it. A missing directory is created with mode 0700 and the global umask is left alone; a
 * team or runtime directory that resolves elsewhere is refused, so nothing is written through it.
 */
export async function prepareRuntimeRoot(teamsRoot: string, teamId: string): Promise<{ realRuntime: string } | { reason: RefuseReason }> {
  if (!/^[A-Za-z0-9._-]+$/.test(teamId) || teamId === '.' || teamId === '..') return { reason: 'outside' };
  let realTeamsRoot: string, realTeam: string;
  try { realTeamsRoot = await realpath(teamsRoot); } catch (error) { return { reason: reasonFor(error, 'unverified-root') }; }
  try { realTeam = await realpath(join(teamsRoot, teamId)); } catch (error) { return { reason: reasonFor(error, 'missing') }; }
  if (realTeam !== join(realTeamsRoot, teamId)) return { reason: 'symlink' };
  const verified = await trustedRuntimeRoot(teamsRoot, teamId);
  if ('realRuntime' in verified) return verified;
  // Anything but an absent directory stays refused: a symlink (or an IO failure) is not something to
  // "create around", and a missing *team* directory is not this call's to create either.
  if (verified.reason !== 'missing') return verified;
  try { await mkdir(runtimeRootOf(teamsRoot, teamId), { mode: 0o700 }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') return { reason: 'io' }; }
  return trustedRuntimeRoot(teamsRoot, teamId);
}

/**
 * The PID sidecar is written once, after the child really started, with the PID that child reported.
 * Only a positive safe integer is ever recorded: a zero or negative value must never reach a signal.
 */
export async function writeRuntimePid(path: string, pid: number): Promise<void> {
  if (!Number.isSafeInteger(pid) || pid <= 0) return;
  await writeFile(path, `${pid}\n`, { mode: 0o600 });
}

/**
 * Read a sidecar only after its own path passed the ownership check: a persisted record may name any
 * path at all, and reading through a symlink would already be the escape 49a closed off.
 */
export async function readRuntimePid(teamsRoot: string, teamId: string, path: string): Promise<{ pid: number } | { reason: RefuseReason | 'invalid' }> {
  const check = await ownsRuntimePath(teamsRoot, teamId, path);
  if (!check.owned) return { reason: check.reason ?? 'outside' };
  try {
    const text = (await readFile(path, 'utf8')).trim();
    const pid = Number(text);
    return /^\d+$/.test(text) && Number.isSafeInteger(pid) && pid > 0 ? { pid } : { reason: 'invalid' };
  } catch (error) { return { reason: reasonFor(error, 'missing') }; }
}

export interface Ownership { owned: boolean; reason?: RefuseReason }

/**
 * Lexical normalization plus the shared real-root check. A `../` escape, an absolute path elsewhere, a
 * look-alike prefix directory (`runtime-old/`), a team or runtime directory that resolves elsewhere, and
 * a symlinked leaf are all refused. It never reads a file's content and never creates anything.
 */
export async function ownsRuntimePath(teamsRoot: string, teamId: string, path: string): Promise<Ownership> {
  if (typeof path !== 'string' || !path || !isAbsolute(path) || normalize(path) !== path) return { owned: false, reason: 'outside' };
  const root = runtimeRootOf(teamsRoot, teamId);
  const inner = relative(root, path);
  if (!inner || inner.startsWith('..') || isAbsolute(inner)) return { owned: false, reason: 'outside' };
  if (!path.startsWith(`${root}${sep}`)) return { owned: false, reason: 'outside' };
  const trusted = await trustedRuntimeRoot(teamsRoot, teamId);
  if (!('realRuntime' in trusted)) return { owned: false, reason: trusted.reason };
  let realParent: string;
  try { realParent = await realpath(dirname(path)); } catch (error) { return { owned: false, reason: reasonFor(error, 'missing') }; }
  if (realParent !== trusted.realRuntime) return { owned: false, reason: 'symlink' };
  let leaf;
  try { leaf = await lstat(path); } catch (error) { return { owned: false, reason: reasonFor(error, 'missing') }; }
  if (leaf.isSymbolicLink()) return { owned: false, reason: 'symlink' };
  return { owned: true };
}

/**
 * Remove only the runtime files this team can prove are its own. Refused paths are reported by count
 * and reason; nothing is deleted before it passes the check.
 */
export async function removeOwnedRuntime(
  teamsRoot: string,
  teamId: string,
  paths: readonly (string | undefined)[],
): Promise<{ removed: number; refused: Partial<Record<RefuseReason, number>> }> {
  let removed = 0;
  const refused: Partial<Record<RefuseReason, number>> = {};
  for (const path of paths) {
    if (!path) continue;
    const check = await ownsRuntimePath(teamsRoot, teamId, path);
    if (!check.owned) {
      const reason = check.reason ?? 'outside';
      // An absent file is not "removed": counting it would let a wrong path look like a cleanup.
      if (reason !== 'missing') refused[reason] = (refused[reason] ?? 0) + 1;
      continue;
    }
    try { await rm(path); removed += 1; }
    // A removal that lost the file to someone else is not a removal, and neither is any other failure:
    // only a call that actually unlinked the file counts.
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') continue;
      refused.io = (refused.io ?? 0) + 1;
    }
  }
  return { removed, refused };
}

/**
 * Files inside this team's runtime root, by resolvable path only. The scan never lists the contents of
 * a runtime root that is itself an unverified symlink.
 */
export interface ScanResult { files: string[]; refused?: RefuseReason; rejected: number }

/**
 * Files inside this team's runtime root, by resolvable path only. A root that cannot be verified is not
 * listed, and the caller is told why: an empty list must never be mistaken for "nothing to do".
 */
export async function scanRuntimeFiles(teamsRoot: string, teamId: string): Promise<ScanResult> {
  const trusted = await trustedRuntimeRoot(teamsRoot, teamId);
  if (!('realRuntime' in trusted)) return { files: [], refused: trusted.reason, rejected: 0 };
  let names: string[];
  // A missing directory is an empty scan; a permission or IO failure is a reason, not "nothing to do".
  try { names = await readdir(runtimeRootOf(teamsRoot, teamId)); }
  catch (error) { const reason = reasonFor(error, 'missing'); return reason === 'missing' ? { files: [], rejected: 0 } : { files: [], refused: reason, rejected: 0 }; }
  const files: string[] = [];
  let rejected = 0;
  for (const name of names) {
    const path = resolve(runtimeRootOf(teamsRoot, teamId), name);
    if ((await ownsRuntimePath(teamsRoot, teamId, path)).owned) files.push(path);
    else rejected += 1;
  }
  return { files, rejected };
}

/** Why a runtime file was kept: the physical evidence says it is not safely deletable. */
export type PreserveReason = 'live' | 'shared' | 'unverified' | 'mismatch';

export interface RuntimeRemoval {
  removed: number;
  refused: Partial<Record<RefuseReason, number>>;
  preserved: Partial<Record<PreserveReason, number>>;
}

const countOf = <T extends string>(map: Partial<Record<T, number>>, key: T, by = 1): void => { map[key] = (map[key] ?? 0) + by; };

/**
 * The one launch-evidence rule every caller shares: a record proves only the launch its own sidecar names,
 * and only the files that fill the three roles for that launch are that launch's channel. Every role must
 * carry its own suffix (`fifo`, `log`, `pid`), the three paths must be distinct, and each one has to pass
 * the root/parent/leaf check itself — a stem never substitutes for that boundary, and three copies of the
 * same PID file are not a launch.
 */
const ROLE_SUFFIX = { fifo: '.fifo', log: '.log', pidFile: '.pid' } as const;

export async function runtimeEvidence(
  teamsRoot: string,
  teamId: string,
  runtime: RuntimeRecord,
): Promise<{ pid: number; files: string[] } | { reason: 'unverified' | 'mismatch' }> {
  const recorded = runtime.pid;
  // No PID of its own: an old or foreign record. It proves nothing, and nothing here may be deleted or adopted.
  if (recorded === undefined || !Number.isSafeInteger(recorded) || recorded <= 0) return { reason: 'unverified' };
  const pidFile = runtime.pidFile;
  // The evidence starts at the sidecar: without a `.pid` file there is no launch to name at all.
  if (!pidFile || !pidFile.endsWith(ROLE_SUFFIX.pidFile)) return { reason: 'mismatch' };
  // Three roles, three files: one file cannot fill two of them, whatever suffix it carries.
  const rolePaths = [runtime.fifo, runtime.log, pidFile];
  if (new Set(rolePaths).size !== rolePaths.length) return { reason: 'mismatch' };
  // The sidecar is read only after its own path passed the ownership check.
  const sidecar = await readRuntimePid(teamsRoot, teamId, pidFile);
  if (!('pid' in sidecar) || sidecar.pid !== recorded) return { reason: 'mismatch' };
  const launchId = runtimeLaunchId(pidFile);
  const roles: [keyof typeof ROLE_SUFFIX, string][] = [['fifo', runtime.fifo], ['log', runtime.log], ['pidFile', pidFile]];
  const files: string[] = [];
  for (const [role, path] of roles) {
    // Each file fills its own role for this launch and is really inside this team's runtime root (a leaf
    // symlink, or a path that resolves elsewhere, is no channel of ours).
    if (!path.endsWith(ROLE_SUFFIX[role]) || runtimeLaunchId(path) !== launchId) continue;
    if (!(await ownsRuntimePath(teamsRoot, teamId, path)).owned) continue;
    files.push(path);
  }
  // A spliced record (A's FIFO and log, B's sidecar) proves only the files carrying the sidecar's own stem,
  // so A's pair stays out of reach of B's dead PID.
  return { pid: recorded, files };
}

/**
 * Remove the runtime files of one member record — but only the files that record can prove are its own.
 *
 * Four independent facts have to hold: the path is inside this team's runtime root (49a), the record's own
 * PID equals the PID its sidecar names, that sidecar's launch id is the path's own launch id, and that PID
 * is no longer alive. A record without a PID, a sidecar that disagrees, a file from another launch, a
 * still-living process or another live member referencing the path keeps the files and says why; the
 * current holder PID is never substituted for the launch's own evidence.
 */
export async function removeMemberRuntime(
  teamsRoot: string,
  teamId: string,
  runtime: RuntimeRecord | undefined,
  deps: { alive: (pid: number) => boolean; shared?: (path: string) => boolean },
): Promise<RuntimeRemoval> {
  const removal: RuntimeRemoval = { removed: 0, refused: {}, preserved: {} };
  if (!runtime) return removal;
  const paths = [runtime.fifo, runtime.log, runtime.pidFile].filter((path): path is string => typeof path === 'string' && path.length > 0);
  const owned: string[] = [];
  for (const path of paths) {
    const check = await ownsRuntimePath(teamsRoot, teamId, path);
    if (check.owned) { owned.push(path); continue; }
    const reason = check.reason ?? 'outside';
    // An absent file needs no decision and must never look like a removal.
    if (reason !== 'missing') countOf(removal.refused, reason);
  }
  const evidence = await runtimeEvidence(teamsRoot, teamId, runtime);
  if ('reason' in evidence) {
    for (const _ of owned) countOf(removal.preserved, evidence.reason);
    return removal;
  }
  // The physical process is still there: its FIFO and log are the live channel, not leftovers.
  if (deps.alive(evidence.pid)) {
    for (const _ of owned) countOf(removal.preserved, 'live');
    return removal;
  }
  for (const path of owned) {
    // A path from another launch is not this sidecar's channel, however the record spells it.
    if (!evidence.files.includes(path)) { countOf(removal.preserved, 'mismatch'); continue; }
    if (deps.shared?.(path)) { countOf(removal.preserved, 'shared'); continue; }
    const one = await removeOwnedRuntime(teamsRoot, teamId, [path]);
    removal.removed += one.removed;
    for (const [reason, count] of Object.entries(one.refused)) countOf(removal.refused, reason as RefuseReason, count ?? 0);
  }
  return removal;
}

export interface RuntimeCleanupReport {
  removed: number;
  /** Files a live process (or a fresh launch) still needs. */
  kept: number;
  /** Files kept although no PID proves them: past the preparation window they are a diagnostic. */
  unverified: number;
  rejected: number;
  rootRefused?: RefuseReason;
  refused: Partial<Record<RefuseReason, number>>;
}

/**
 * Clean up this team's runtime files by launch id and PID evidence, never by file name.
 *
 * One launch id groups its FIFO, log and sidecar. A member record owns the group by naming one of its
 * paths or by carrying the PID the sidecar names; Chinese, renamed and nameless members are therefore
 * invisible to this decision. A live owner, a live sidecar (a producer that has not joined yet) or no
 * PID evidence at all keeps the files — the last case only past the preparation window, and then as an
 * `unverified` diagnostic instead of a silent success.
 */
export async function cleanupRuntimeFiles(
  teamsRoot: string,
  teamId: string,
  members: readonly { sessionId: string; holder: { pid: number }; runtime?: RuntimeRecord }[],
  deps: { alive: (pid: number) => boolean; now: number; prepareMs: number },
): Promise<RuntimeCleanupReport> {
  const scan = await scanRuntimeFiles(teamsRoot, teamId);
  const report: RuntimeCleanupReport = { removed: 0, kept: 0, unverified: 0, rejected: scan.rejected, refused: {}, ...(scan.refused ? { rootRefused: scan.refused } : {}) };
  const groups = new Map<string, { files: string[]; sidecarPid?: number }>();
  for (const file of scan.files) {
    const id = runtimeLaunchId(file);
    let group = groups.get(id);
    if (!group) { group = { files: [] }; groups.set(id, group); }
    group.files.push(file);
    if (file.endsWith('.pid')) {
      const sidecar = await readRuntimePid(teamsRoot, teamId, file);
      if ('pid' in sidecar) group.sidecarPid = sidecar.pid;
    }
  }
  const references = (member: { runtime?: RuntimeRecord }, file: string): boolean =>
    !!member.runtime && [member.runtime.fifo, member.runtime.log, member.runtime.pidFile].includes(file);
  for (const group of groups.values()) {
    const pid = group.sidecarPid;
    // EVERY reference counts: the first record found must not hide a later live one.
    const refs = members.filter(member => group.files.some(file => references(member, file))
      || (pid !== undefined && member.runtime?.pid === pid));
    const holds = (member: { holder: { pid: number } }): boolean => {
      const holder = holderProcess(member);
      return holder !== undefined && deps.alive(holder);
    };
    // A live sidecar PID protects the group before any owner is considered: an old or broken record must
    // not bypass that check.
    if (pid !== undefined && deps.alive(pid)) { report.kept += group.files.length; continue; }
    // Any live member referencing one of the group's paths still uses these files.
    if (refs.some(holds)) { report.kept += group.files.length; continue; }
    // The sidecar PID is dead here (the branch above returned otherwise). Deletion also needs one record,
    // when any still references the group, to carry that same launch's own PID.
    const proven = pid !== undefined && (refs.length === 0 || refs.some(member => member.runtime?.pid === pid));
    if (!proven) {
      // A launch that has not written its sidecar yet is inside its preparation window; anything older
      // stays as well, but is reported instead of being turned into an invisible "nothing to do".
      const ages = await Promise.all(group.files.map(async file => { try { return deps.now - (await stat(file)).mtimeMs; } catch { return undefined; } }));
      const fresh = ages.some(age => age !== undefined && age < deps.prepareMs);
      if (fresh) report.kept += group.files.length; else report.unverified += group.files.length;
      continue;
    }
    const one = await removeOwnedRuntime(teamsRoot, teamId, group.files);
    report.removed += one.removed;
    for (const [reason, count] of Object.entries(one.refused)) countOf(report.refused, reason as RefuseReason, count ?? 0);
  }
  return report;
}
