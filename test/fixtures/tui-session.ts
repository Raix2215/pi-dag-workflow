/**
 * A real Pi TUI inside its own tmux server.
 *
 * Some seams only exist in the interactive surface: the Team panel is registered for `ctx.mode === 'tui'`
 * only, so a request that a user triggers from the menu cannot be reproduced over RPC. Typing into a real
 * TUI is then the only honest driver — a test-side record of the same request would prove nothing.
 *
 * Isolation follows `IsolatedClient`: its own HOME, agent directory and session directory, only the entries
 * the caller names, and a unique tmux socket, so the user's servers, sessions and config stay untouched. The
 * process' stderr goes to a file instead of the pane, so host errors stay separable from screen evidence.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { testCli } from './isolated-client.ts';

/**
 * Reading limit for a host's stderr log. A log above it fails loudly: the evidence for "no fatal error" is the
 * whole file, so a silent `slice(-n)` would turn an unchecked prefix into a claim nobody made.
 */
const STDERR_LIMIT = 1 << 20;

/** The TUI seams are opt-in: `npm test` must never need tmux, and an explicit run must fail rather than skip. */
export const tuiEnabled = (): boolean => process.env.PI_DAG_TEST_TUI === '1';

/**
 * Where an explicit run's evidence lands. The default is the system temp dir: a test never writes into the
 * repository (let alone a read-only records tree), and `PI_DAG_TEST_EVIDENCE_DIR` is the one way to keep it.
 */
export const evidenceDir = (name: string): string => join(process.env.PI_DAG_TEST_EVIDENCE_DIR ?? join(tmpdir(), 'pi-dag-test-evidence'), name);

export interface PersistedFile { name: string; bytes: number; sha256: string }

/** Writes the run's raw evidence and reports what was written; a request that writes nothing is an error. */
export async function persistEvidence(dir: string, files: { name: string; text: string }[]): Promise<PersistedFile[]> {
  await mkdir(dir, { recursive: true });
  const written: PersistedFile[] = [];
  for (const file of files) {
    const text = file.text;
    await writeFile(join(dir, file.name), text);
    written.push({ name: file.name, bytes: Buffer.byteLength(text), sha256: createHash('sha256').update(text).digest('hex') });
  }
  if (!written.length) throw new Error('evidence was requested but no file was written');
  return written;
}

export interface TuiSession {
  readonly socket: string;
  readonly stderrFile: string;
  /** Types text as the user would: literal characters, never keystroke names. */
  sendText(text: string): void;
  /** Presses named keys (Enter, Tab, Escape, j, l, ...). */
  press(...keys: string[]): void;
  /** The pane as plain text (`capture-pane -p`). */
  text(): string;
  /** The pane with its ANSI attributes (`capture-pane -p -e`), for colour/glyph evidence. */
  ansi(): string;
  until(predicate: (screen: string) => boolean, timeout?: number, what?: string): Promise<string>;
  stderrText(): string;
  close(): Promise<void>;
}

function tmux(socket: string, args: string[], input?: string): string {
  return execFileSync('tmux', ['-L', socket, ...args], { encoding: 'utf8', ...(input === undefined ? {} : { input }) });
}

export async function startTui(input: {
  root: string;
  sessionId: string;
  /** Extension entries to load; the caller names the exact set, nothing is discovered. */
  entries: string[];
  args?: string[];
  width?: number;
  height?: number;
  language?: string;
  /** `false` starts the host without the scripted offline provider (for a native HTTP adapter instead). */
  scripted?: boolean;
  provider?: string;
  model?: string;
}): Promise<TuiSession> {
  if (!tuiEnabled()) throw new Error('startTui needs PI_DAG_TEST_TUI=1: the TUI seams are opt-in so the default suite never requires tmux');
  try { execFileSync('tmux', ['-V'], { encoding: 'utf8' }); }
  catch { throw new Error('PI_DAG_TEST_TUI=1 was set but tmux is not runnable: an explicit TUI run must fail, never skip'); }
  const socket = `pi-dag-tui-${process.pid}-${Math.random().toString(36).slice(2, 10)}`;
  const stderrFile = join(input.root, `tui-${input.sessionId}.stderr.log`);
  const scripted = input.scripted === false ? [] : ['-e', fileURLToPath(new URL('./offline-model.ts', import.meta.url))];
  const argv = [
    process.execPath, testCli(),
    '--offline', '--no-extensions', ...input.entries.flatMap(entry => ['-e', entry]),
    '--no-skills', '--no-prompt-templates', '--no-themes', '--no-context-files', '--no-approve',
    '--session-id', input.sessionId,
    '--provider', input.provider ?? 'dag-test', '--model', input.model ?? 'scripted',
    ...scripted, ...(input.args ?? []),
  ];
  // A launcher script keeps the argv out of shell quoting: every path stays one argument, byte for byte.
  const launcher = join(input.root, `tui-${input.sessionId}.sh`);
  // The working directory is part of the isolation: a team is resolved inside its own workspace, and the
  // repository's project resources must not leak into this host.
  await writeFile(launcher, [
    '#!/bin/sh',
    `cd ${JSON.stringify(input.root)} || exit 1`,
    `exec env -i PATH=${JSON.stringify(process.env.PATH ?? '')} HOME=${JSON.stringify(input.root)} PI_CODING_AGENT_DIR=${JSON.stringify(join(input.root, 'agent'))} PI_CODING_AGENT_SESSION_DIR=${JSON.stringify(join(input.root, 'sessions'))} PI_OFFLINE=1 TERM=xterm-256color LANGUAGE=${JSON.stringify(input.language ?? 'zh-CN')} \\`,
    `  ${argv.map(argument => JSON.stringify(argument)).join(' ')} 2>${JSON.stringify(stderrFile)}`,
    '',
  ].join('\n'), { mode: 0o755 });
  tmux(socket, ['-f', '/dev/null', 'new-session', '-d', '-s', 'sender', '-x', String(input.width ?? 170), '-y', String(input.height ?? 50), `sh ${JSON.stringify(launcher)}`]);
  const session: TuiSession = {
    socket,
    stderrFile,
    sendText: text => { tmux(socket, ['send-keys', '-t', 'sender', '-l', '--', text]); pause(); },
    press: (...keys) => { for (const key of keys) { tmux(socket, ['send-keys', '-t', 'sender', key]); pause(); } },
    text: () => { try { return tmux(socket, ['capture-pane', '-p', '-t', 'sender']); } catch { return ''; } },
    ansi: () => { try { return tmux(socket, ['capture-pane', '-p', '-e', '-t', 'sender']); } catch { return ''; } },
    until: async (predicate, timeout = 15_000, what = 'screen') => {
      const deadline = Date.now() + timeout;
      for (;;) {
        const screen = session.text();
        if (predicate(screen)) return screen;
        if (Date.now() > deadline) throw new Error(`TUI timeout waiting for ${what}; pane=${JSON.stringify(screen.slice(-1200))}`);
        await new Promise(resolve => setTimeout(resolve, 200));
      }
    },
    stderrText: () => {
      if (!existsSync(stderrFile)) return '';
      const { size } = statSync(stderrFile);
      if (size > STDERR_LIMIT) throw new Error(`the TUI stderr log is ${size} bytes, above the ${STDERR_LIMIT}-byte limit: read it whole or raise the limit, never truncate`);
      return readFileSync(stderrFile, 'utf8');
    },
    close: async () => { try { tmux(socket, ['kill-server']); } catch { /* an already gone server is the goal */ } },
  };
  return session;
}

/** Keystrokes need a beat for the TUI to redraw before the next one is interpreted. */
function pause(ms = 130): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
