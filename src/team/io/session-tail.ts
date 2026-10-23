import { closeSync, existsSync, lstatSync, openSync, readdirSync, readSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { configPaths } from '../../shared/config.ts';

/** How much of the session file tail is read: enough for a few messages, never the whole file. */
export const TAIL_BYTES = 256 * 1024;
/** Default truncation of the returned reply text. */
export const REPLY_LIMIT = 240;

const defaultRoot = () => join(configPaths().directory, '..', 'sessions');

/**
 * Every directory Pi may keep sessions in, most specific first. Pi resolves `--session-dir`, then
 * `PI_CODING_AGENT_SESSION_DIR`, then `<agent>/sessions`; a child process inherits the environment variable,
 * which is the one a panelless host can see here. No new configuration parser is introduced for this.
 */
export function sessionsRoots(root?: string): string[] {
  const roots: string[] = [];
  const add = (path: string | undefined) => { const value = path?.trim(); if (value && !roots.includes(value)) roots.push(value); };
  add(root);
  add(process.env.PI_CODING_AGENT_SESSION_DIR);
  add(defaultRoot());
  return roots;
}

/** The directory a session file would live under; a missing one means "not saved yet". */
export const sessionsRootPath = (root?: string): string => sessionsRoots(root)[0]!;

/** Whether any directory Pi may store sessions in exists at all: an absent one means "not saved yet". */
export const anySessionsRootExists = (root?: string): boolean => sessionsRoots(root).some(path => existsSync(path));

/** `<sessionId>.jsonl` or `<timestamp>_<sessionId>.jsonl`: the two spellings Pi uses. */
const namesSession = (path: string, sessionId: string): boolean => {
  const base = path.split(/[\\/]/).at(-1) ?? '';
  return base === `${sessionId}.jsonl` || base.endsWith(`_${sessionId}.jsonl`);
};

/**
 * A candidate is usable only when it is a real regular file reached without a link: `lstat` reports a file.
 * A link can point at an external session or at a directory, so following one would let this locator — and the
 * delete that trusts it — act on something this team never owned. Every branch uses this one rule.
 */
const isSafeFile = (path: string): boolean => { try { return lstatSync(path).isFile(); } catch { return false; } };

/** One root, one level deep: a file straight in the root, or a file in one project directory. */
function scanRoot(root: string, sessionId: string): string | undefined {
  let entries;
  // A host with no sessions directory simply has no such file: locating never throws.
  try { entries = readdirSync(root, { withFileTypes: true }); } catch { return undefined; }
  // Pi may write `<root>/<timestamp>_<sessionId>.jsonl` directly (a custom --session-dir does exactly that).
  // A link's dirent is neither a file nor a directory here, so links are skipped instead of resolved.
  const direct = entries.find(entry => entry.isFile() && namesSession(entry.name, sessionId));
  if (direct) return join(root, direct.name);
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const directory = join(root, entry.name);
    let files;
    try { files = readdirSync(directory, { withFileTypes: true }); } catch { continue; }
    const match = files.find(file => file.isFile() && namesSession(file.name, sessionId));
    if (match) return join(directory, match.name);
  }
  return undefined;
}

/**
 * Locate a member's session file without ever creating, repairing or migrating one.
 *
 * A record that carries the SDK's own path is answered by that path alone: `null` means "there is none", a
 * definite string is either that safe regular file or nothing at all. Falling back to a scan when a *known* path
 * went stale would pick a different file with the same SID — and a delete would then remove the wrong session.
 * Only a record written before that fact existed (`undefined`) is located by scanning, one level deep in each
 * root Pi may use, including a custom `PI_CODING_AGENT_SESSION_DIR`. A valid SDK path may live anywhere.
 */
export function sessionFileFor(sessionId: string, target: string | { root?: string; recorded?: string | null } = {}): string | undefined {
  if (!sessionId) return undefined;
  const options = typeof target === 'string' ? { root: target } : target;
  const recorded = options.recorded;
  if (recorded !== undefined) return recorded !== null && namesSession(recorded, sessionId) && isSafeFile(recorded) ? recorded : undefined;
  for (const root of sessionsRoots(options.root)) {
    const found = scanRoot(root, sessionId);
    if (found) return found;
  }
  return undefined;
}

/** Bounded read of the last `limit` bytes of a file. */
export function readTail(path: string, limit = TAIL_BYTES): string {
  const size = statSync(path).size, start = Math.max(0, size - limit);
  const fd = openSync(path, 'r');
  try {
    const buffer = Buffer.alloc(size - start);
    readSync(fd, buffer, 0, buffer.length, start);
    return buffer.toString('utf8');
  } finally { closeSync(fd); }
}

const textOf = (content: unknown): string | undefined => {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return undefined;
  const parts = content.filter(part => part && typeof part === 'object' && (part as { type?: string }).type === 'text').map(part => String((part as { text?: string }).text ?? ''));
  return parts.length ? parts.join('\n') : undefined;
};

/**
 * The last assistant text in a session file: read a bounded tail, scan it backwards line by line,
 * and stop at the first assistant message. A malformed line is skipped, never thrown.
 */
export function lastAssistantText(path: string, limit = REPLY_LIMIT, read = readTail): { text?: string; truncated?: boolean } {
  return replyFromTail(read(path), limit);
}

/**
 * The same reply reader over a tail a caller already read. A record that is not an object (a bare `null` line,
 * a half line, a string) is skipped like any other malformed line, never dereferenced.
 */
export function replyFromTail(tail: string, limit = REPLY_LIMIT): { text?: string; truncated?: boolean } {
  const lines = tail.split('\n');
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]!.trim();
    if (!line) continue;
    let record: unknown;
    try { record = JSON.parse(line); } catch { continue; }
    if (!record || typeof record !== 'object') continue;
    const entry = record as { type?: string; role?: string; message?: { role?: string; content?: unknown }; content?: unknown };
    if (entry.role !== 'assistant' && entry.message?.role !== 'assistant' && !(entry.type === 'message' && entry.role === 'assistant')) continue;
    const text = textOf(entry.message?.content ?? entry.content)?.trim();
    if (!text) continue;
    const characters = [...text];
    return characters.length > limit ? { text: characters.slice(0, limit).join(''), truncated: true } : { text };
  }
  return {};
}
