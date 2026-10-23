import { spawn as nodeSpawn, execFileSync, type ChildProcess } from 'node:child_process';
import { closeSync, mkdirSync, openSync, readFileSync } from 'node:fs';
import { access, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BACKGROUND_ENV, detectAdapters, detectTerminal, memberArgs, planLaunch, type LaunchAdapters, type LaunchMode, type LaunchPlan, type LaunchRequest, type LaunchRuntime, type TerminalApp } from '../domain/launcher.ts';
import { writeRuntimePid } from './runtime.ts';
import { readLaunchProfile, type LaunchProfile } from '../../shared/profile-launch.ts';
import { resolveChildExtensionPaths } from '../../shared/config.ts';

export interface LaunchDeps {
  spawn?: typeof nodeSpawn;
  adapters?: LaunchAdapters;
  /** Tests replace the FIFO maker and opener so nothing touches the filesystem. */
  mkfifo?: (path: string) => void;
  openFifo?: (path: string) => number | 'ignore';
  /** How long a background member gets to prove it is alive; tests skip the wait. */
  settleMs?: number;
  wait?: (ms: number) => Promise<void>;
  alive?: (pid: number) => boolean;
  /** Provenance check for the files a failed launch removes: only a path it approves is deleted. */
  ownedRuntimeFile?: (path: string) => Promise<boolean>;
}

export interface LaunchResult {
  plan: LaunchPlan;
  child?: ChildProcess;
  profile?: LaunchProfile;
  /** True only after the process is confirmed alive; `spawn()` returning means nothing. */
  spawned: boolean;
  /** Why a `background` launch is not running; carries the log's first line verbatim. */
  reason?: string;
  /** What a failed background launch did with its runtime files: kept files were refused, not cleaned. */
  cleanup?: { removed: number; kept: number };
  /** True only where this launch verified the member itself (background binding); a window is a request. */
  confirmed?: boolean;
  /** The PID the child process really reported, and the three files this launch owns. */
  pid?: number;
  runtime?: LaunchRuntime;
  /** Set when the child this launch started never reported an exit: `spawned` is false and these files stayed. */
  stopped?: false;
  keptFiles?: number;
}

const makeFifo = (path: string) => {
  // The runtime directory is ours: created 0700, and the host umask is never changed for it. The mode is
  // set on the FIFO explicitly, so a runtime file is owner-only like the log and the PID sidecar.
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  execFileSync('mkfifo', ['-m', '600', path]);
};

/**
 * tmux is an environment fact; a desktop terminal has to exist on PATH. The configuration decides
 * first: an explicit terminal is used as-is, `none` disables the row, `auto` walks the platform table.
 */
export function detectLaunchAdapters(config: { terminal?: TerminalApp | 'auto' | 'none'; template?: string } = {}, env: NodeJS.ProcessEnv = process.env, platform: string = process.platform): LaunchAdapters {
  const available = (name: string) => { try { execFileSync('sh', ['-c', `command -v ${name}`], { stdio: 'ignore' }); return true; } catch { return false; } };
  const wanted = config.terminal ?? 'auto';
  const terminal = wanted === 'none' ? undefined : wanted === 'auto' ? detectTerminal(available, platform) : wanted;
  return {
    ...detectAdapters(env, platform),
    ...(terminal ? { terminal } : {}),
    ...(config.terminal ? { desktopTerminal: config.terminal } : {}),
    ...(config.template ? { desktopTemplate: config.template } : {}),
    available, platform,
  };
}
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));const firstLine = (path: string): string | undefined => {
  try { return readFileSync(path, 'utf8').split('\n').map(line => line.trim()).find(Boolean); } catch { return undefined; }
};

/**
 * Terminate only the child this launch started, through its own handle, and report whether it really exited.
 * Two bounded signals (SIGTERM, then SIGKILL) and never a PID: a handle whose `kill()` fails, or that never
 * reports an exit, has not been stopped — so the caller must keep the runtime files instead of deleting them.
 */
export async function stopChild(child: ChildProcess | undefined, deps: { wait?: (ms: number) => Promise<void> } = {}): Promise<boolean> {
  if (!child) return false;
  // Only the child's own exit code or signal counts. `child.killed` records that a signal was sent, not that
  // the process is gone, so it is never read here.
  const exited = () => child.exitCode !== null || child.signalCode !== null;
  // An exit that is already visible needs no signal; a handle that cannot be signalled is not an exit either.
  if (exited()) return true;
  if (typeof child.kill !== 'function') return false;
  const wait = deps.wait ?? sleep;
  // A kill that throws is not an exit either: it is reported as an unconfirmed stop, never as a crash.
  const signal = (name: NodeJS.Signals) => { try { child.kill(name); } catch { /* unconfirmed below */ } };
  signal('SIGTERM');
  for (let attempt = 0; attempt < 40 && !exited(); attempt += 1) await wait(50);
  if (!exited()) signal('SIGKILL');
  for (let attempt = 0; attempt < 20 && !exited(); attempt += 1) await wait(50);
  return exited();
}

/**
 * Production launcher; tests inject `spawn` so no real Pi process is started.
 * `background` needs `--mode rpc` plus a FIFO on stdin: a detached `pi` without a TTY exits at once.
 * A background launch only counts as spawned while the process is still running; a failure removes
 * the FIFO and log it just created and reports the log's first line instead of a bare "failed".
 */
/** The Team extension entry this package ships: an isolated child has to load it to own `--team`. */
export const teamExtensionPath = (): string => fileURLToPath(new URL('../index.ts', import.meta.url));

export async function launchTeam(mode: LaunchMode, baseRequest: LaunchRequest, deps: LaunchDeps = {}, profile: LaunchProfile | undefined = undefined): Promise<LaunchResult> {
  const adapters = deps.adapters ?? detectAdapters(process.env), spawn = deps.spawn ?? nodeSpawn;
  const selected = profile ?? readLaunchProfile(baseRequest.profile);
  // An isolated launch resolves its extension entries against the configuration directory once, before the
  // plan and before the spawn: a relative entry must never be satisfied by a namesake file in the working
  // directory. Entries a caller already resolved come back as the same real path.
  const resolved = selected?.isolate
    ? { ...selected, childExtensions: await resolveChildExtensionPaths([...(selected.childExtensions ?? [])]) }
    : selected;
  // The plan and the spawn must name the same extension entries, so an isolated launch gets its own Team
  // entry here, once, before anything is planned or started.
  const request = baseRequest.teamExtension ? baseRequest : { ...baseRequest, teamExtension: teamExtensionPath() };
  const plan = planLaunch(mode, request, adapters, resolved);
  const withProfile = resolved ? { profile: resolved } : {};
  if (mode === 'copy' || plan.mode === 'copy') return { plan, spawned: false, ...withProfile };
  // Interpreter, then CLI entry, then the same member args the paste-able command uses.
  const args = [...(request.cli ? [request.cli] : []), ...memberArgs(request, resolved)];
  if (mode === 'background') {
    // The caller generated this pair once for this launch: the plan, the spawned process and the member
    // binding that follows all name the same three files inside the team runtime root. There is no
    // working-directory fallback — a fixed file per display name is exactly what collided before.
    const runtime = request.runtime;
    if (!runtime) throw new Error('后台启动缺少团队运行目录里的运行文件：拒绝启动，不在工作目录里留固定文件');
    (deps.mkfifo ?? makeFifo)(runtime.fifo);
    mkdirSync(dirname(runtime.log), { recursive: true, mode: 0o700 });
    // `r+` keeps a write end open inside the child, so RPC never sees EOF on stdin.
    const stdin = (deps.openFifo ?? ((path: string) => openSync(path, 'r+')))(runtime.fifo);
    // The log is a runtime file too: created 0600, not world readable through the host umask.
    const out = openSync(runtime.log, 'a', 0o600);
    let child: ChildProcess | undefined;
    let spawnError: string | undefined;
    try {
      child = spawn(request.execPath, [...args, '--mode', 'rpc'], { cwd: request.cwd, detached: true, stdio: [stdin, out, out], env: { ...process.env, [BACKGROUND_ENV]: '1' } });
      // A detached member must not keep us alive, and an ENOENT on execPath must not crash the host.
      child.on('error', (error: Error) => { spawnError = error.message; });
      child.unref?.();
    } catch (error) {
      // spawn() itself can throw; that is still a failed launch, not a reason to leave its files behind.
      spawnError = error instanceof Error ? error.message : String(error);
    } finally { if (typeof stdin === 'number') closeSync(stdin); if (typeof out === 'number') closeSync(out); }
    if (!child) {
      // No process exists at all, so nothing can still hold these files: the provenance guard decides.
      const cleaned = await cleanupRuntime([runtime.fifo, runtime.log, runtime.pidFile], deps.ownedRuntimeFile);
      return { plan, spawned: false, ...withProfile, cleanup: cleaned, ...(spawnError ? { reason: spawnError } : {}) };
    }
    const alive = deps.alive ?? ((target: number) => { try { process.kill(target, 0); return true; } catch { return false; } });
    await (deps.wait ?? sleep)(deps.settleMs ?? 800);
    const pid = typeof child.pid === 'number' ? child.pid : undefined;
    const running = child.exitCode === null && child.signalCode === null && pid !== undefined && alive(pid);
    if (running) {
      try {
        // Only a process that really runs gets a PID written: it is the evidence a stop and a cleanup read
        // later, and a pre-made or guessed PID would prove nothing about this pair.
        await writeRuntimePid(runtime.pidFile, pid);
        return { plan, child, spawned: true, pid, runtime, ...withProfile };
      } catch (error) {
        // Without its sidecar this launch has no PID evidence at all, so the child this call started has to
        // go. If it does not actually report an exit, the files stay: deleting them would remove the channel
        // of a process nobody can vouch for, and "stopped" would be a claim this call cannot make.
        const exited = await stopChild(child, { ...(deps.wait ? { wait: deps.wait } : {}) });
        if (!exited) {
          const kept = await cleanupRuntime([runtime.fifo, runtime.log, runtime.pidFile], undefined);
          return {
            plan, spawned: false, ...withProfile, stopped: false, keptFiles: kept.kept,
            reason: `${error instanceof Error ? error.message : String(error)}；未能确认退出，运行文件保留 ${kept.kept} 个，需人工检查`,
          };
        }
        const cleaned = await cleanupRuntime([runtime.fifo, runtime.log, runtime.pidFile], deps.ownedRuntimeFile);
        return { plan, spawned: false, ...withProfile, cleanup: cleaned, reason: error instanceof Error ? error.message : String(error) };
      }
    }
    const line = firstLine(runtime.log) ?? spawnError;
    // A failed liveness probe is not an exit: the child's own handle has to report one before its files may
    // go. This is the same rule and the same narrow stop helper as the sidecar failure above — a dead probe,
    // a missing sidecar or a short settle never stands in for a confirmed exit.
    const exited = await stopChild(child, { ...(deps.wait ? { wait: deps.wait } : {}) });
    if (!exited) {
      const kept = await cleanupRuntime([runtime.fifo, runtime.log, runtime.pidFile], undefined);
      const keptNote = kept.kept ? `未能确认退出，运行文件保留 ${kept.kept} 个，需人工检查` : '未能确认退出，需人工检查';
      return { plan, spawned: false, ...withProfile, stopped: false, keptFiles: kept.kept, reason: line ? `${line}；${keptNote}` : keptNote };
    }
    const cleaned = await cleanupRuntime([runtime.fifo, runtime.log, runtime.pidFile], deps.ownedRuntimeFile);
    // Files the provenance check refused are reported: "kept" is not "cleaned up".
    return { plan, spawned: false, ...withProfile, cleanup: cleaned, ...(line ? { reason: line } : {}) };
  }
  // The plan already decided how this window starts: a user template goes to the platform shell,
  // a known emulator gets its argv directly, and a degraded plan never reaches a spawn at all.
  if (plan.exec) {
    const desktop = mode === 'desktop';
    const wait = deps.wait ?? sleep, settleMs = deps.settleMs ?? 500;
    let spawnError: string | undefined, diagnostics = '';
    let child: ChildProcess;
    try {
      child = spawn(plan.exec.file, plan.exec.args, { cwd: request.cwd, ...(desktop ? { detached: true } : {}), stdio: ['ignore', 'ignore', 'pipe'] });
    } catch (error) {
      // A synchronous spawn failure is a failed launch, not an exception for the host to take.
      return { plan, spawned: false, ...withProfile, reason: spawnFailure(error) };
    }
    // The listener stays for the process lifetime: a spawn that fails later must never be an uncaught 'error'.
    // A handle supplied through `deps.spawn` may carry no streams; a real ChildProcess always has them.
    child.on?.('error', (error: Error) => { spawnError = error.message; });
    // The cap is enforced on every append, so one huge chunk cannot grow the buffer past it. `capturing`
    // only stops collecting; the pipe keeps being drained, so the child never meets a closed stderr.
    let capturing = true;
    child.stderr?.on?.('data', (chunk: Buffer | string) => {
      if (!capturing) return;
      diagnostics = (diagnostics + String(chunk)).slice(0, STDERR_LIMIT);
    });
    child.unref?.();
    await wait(settleMs);
    // Diagnostics are the child's own text: reading them as a file path would both lose the message and let
    // a same-named file in the working directory stand in for it.
    const captured = bounded(diagnostics);
    capturing = false;
    // Stop collecting without touching the pipe: `destroy()` here used to hand a still-running child EPIPE.
    // A real pipe is a socket and can be unref'd; a handle that cannot be is simply left draining.
    (child.stderr as unknown as { unref?: () => void } | undefined)?.unref?.();
    // A failure that is already visible is reported with its own words instead of a claim of success.
    if (spawnError !== undefined) return { plan, spawned: false, ...withProfile, reason: bounded(spawnError) };
    // Only an exit that was actually observed counts: a handle without exit state has reported nothing.
    if ('exitCode' in child && (child.exitCode !== null || child.signalCode !== null)) {
      const ended = child.exitCode !== null ? `退出码 ${child.exitCode}` : `信号 ${child.signalCode}`;
      // A terminal emulator is a service client: it may hand the window over and exit 0 immediately, so a
      // clean fast exit proves nothing either way. Any non-zero exit is a launch that did not start.
      if (child.exitCode !== 0) return { plan, spawned: false, ...withProfile, reason: captured ? `${ended}：${captured}` : ended };
      return { plan, spawned: true, confirmed: false, ...withProfile };
    }
    // Still running after the bounded window: the request was accepted, the member is not verified here.
    return { plan, child, spawned: true, confirmed: false, ...withProfile };
  }
  return { plan, spawned: false, ...withProfile };
}

/** A spawn error is data, never an exception the host has to survive. */
const spawnFailure = (error: unknown): string => bounded(error instanceof Error ? error.message : String(error));
/** How much of a child's stderr a failed launch may quote back. */
const STDERR_LIMIT = 400;
/** The first non-blank line of *text*; never a filesystem read. */
const firstLineOf = (text: string): string | undefined => text.split(/\r?\n/).map((line) => line.trim()).find(Boolean);
/** Diagnostics are bounded: the first line, at most 300 characters, never a whole log. */
const bounded = (text: string): string => { const line = firstLineOf(text) ?? ''; return line.slice(0, 300); };

/**
 * A failed launch leaves nothing behind — but only files that are provably inside this team's runtime
 * root. There is no "no guard" mode: without a provenance check nothing is deleted, and the caller is
 * told the files that were kept instead of being told the launch cleaned up after itself. A file this
 * launch never created (the sidecar of a child that died before it ran) is not a kept file.
 */
export async function cleanupRuntime(
  paths: readonly (string | undefined)[],
  guard: ((path: string) => Promise<boolean>) | undefined,
): Promise<{ removed: number; kept: number }> {
  let removed = 0, kept = 0;
  for (const path of paths) {
    if (!path) continue;
    // Only an absent file is nothing to clean. Any other access failure (permission, IO) means this call
    // cannot prove the file is gone, so it stays and is reported as kept instead of vanishing silently.
    try { await access(path); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') kept += 1;
      continue;
    }
    if (!guard || !await guard(path)) { kept += 1; continue; }
    try { await rm(path); removed += 1; } catch { kept += 1; }
  }
  return { removed, kept };
}
