/**
 * Bounded, read-only activity summaries from a member's saved session file.
 *
 * The records are the *native* Pi ones: `{ type: 'message', timestamp, message: { role, content } }`, with tool
 * calls inside `assistant.content[]` as `{ type: 'toolCall', name }` and their outcome as a `toolResult`
 * message carrying `toolName`, `isError`, `toolCallId` and `content`. Entries stay in file order (never sorted
 * by timestamp), the read is the same bounded 256 KiB tail the reply reader uses, and a partial or failed read
 * is reported as such instead of being guessed into history.
 */
import { anySessionsRootExists, readTail, sessionFileFor } from './session-tail.ts';

/** One saved record, reduced to what a reader may see: when, what, how it ended, a short text. */
export interface ActivityEntry {
  /** The record's own timestamp: a legal ISO string or a legacy number, kept verbatim (never re-sorted). */
  at?: string | number;
  /** The record type, or `tool_call <name>` / `tool_result <name>` for the native message shapes. */
  event: string;
  /** A result status only when the record states one (`isError`, or an explicit status field). */
  status?: string;
  /** A tool error type/code, only when the record itself provides it. */
  error?: string;
  /** Short reply or error text, capped at ACTIVITY_TEXT_LIMIT. */
  text?: string;
  truncated?: boolean;
}

export const ACTIVITY_TEXT_LIMIT = 160;
export const ACTIVITY_EVENT_LIMIT = 60;
export const ACTIVITY_DEFAULT = 3;
export const ACTIVITY_MAX = 10;

/** Why an activity window is empty: a missing file is not "no activity". */
export type ActivitySource = 'tail' | 'unsaved' | 'unlocatable' | 'unreadable';

/** A limit outside 1..10 is refused instead of being clamped into a different question. */
export function activityLimit(value: unknown): number {
  if (value === undefined) return ACTIVITY_DEFAULT;
  const limit = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > ACTIVITY_MAX) {
    throw new Error(`activity.limit 必须是 1-${ACTIVITY_MAX} 的整数；不传则默认 ${ACTIVITY_DEFAULT}`);
  }
  return limit;
}

/** Control characters in saved data are stripped, never rendered: the panel and the model both read this. */
const safe = (text: string): string => text.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, ' ');

const textOf = (content: unknown): string | undefined => {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return undefined;
  const parts = content
    .filter(part => part && typeof part === 'object' && (part as { type?: string }).type === 'text')
    .map(part => String((part as { text?: string }).text ?? ''));
  return parts.length ? parts.join('\n') : undefined;
};

/** One line of text, at most ACTIVITY_TEXT_LIMIT Unicode characters, with an explicit truncation flag. */
function summarize(text: string): { text: string; truncated?: boolean } {
  const single = safe(text).replace(/\s+/g, ' ').trim();
  const characters = [...single];
  if (characters.length <= ACTIVITY_TEXT_LIMIT) return { text: single };
  return { text: characters.slice(0, ACTIVITY_TEXT_LIMIT).join(''), truncated: true };
}

/** A tool name is bounded too: a hostile or huge name must not become the summary. */
const eventName = (prefix: string, name: unknown): string => {
  const raw = typeof name === 'string' && name.trim() ? safe(name).trim() : '?';
  const bounded = [...raw].slice(0, ACTIVITY_EVENT_LIMIT).join('');
  return `${prefix} ${bounded}`;
};

const atOf = (record: any): string | number | undefined => {
  const value = record?.timestamp;
  if (typeof value === 'string') return Number.isNaN(Date.parse(value)) ? undefined : value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const legacy = record?.message?.timestamp;
  if (typeof legacy === 'number' && Number.isFinite(legacy)) return legacy;
  return undefined;
};

/** What one saved record says, by its native shape. Nothing is inferred when a field is absent. */
function entryOf(record: any): ActivityEntry | undefined {
  if (!record || typeof record !== 'object') return undefined;
  const at = atOf(record);
  const withAt = (entry: Omit<ActivityEntry, 'at'>): ActivityEntry => ({ ...(at === undefined ? {} : { at }), ...entry });
  const type = typeof record.type === 'string' ? safe(record.type) : undefined;
  const message = record.message;
  if (!message || typeof message !== 'object') {
    // A non-message record says only its type; its data is never stringified into the summary.
    return type ? withAt({ event: [...type].slice(0, ACTIVITY_EVENT_LIMIT).join('') }) : undefined;
  }
  const role = typeof message.role === 'string' ? message.role : undefined;
  if (role === 'assistant') {
    const calls = Array.isArray(message.content)
      ? message.content.filter((part: any) => part && typeof part === 'object' && part.type === 'toolCall')
      : [];
    // A tool call is a *request*: it names the tool and claims no outcome.
    if (calls.length) {
      const names = calls.map((call: any) => eventName('tool_call', call.name)).join(', ');
      const { text: event, ...truncation } = summarize(names);
      return withAt({ event, ...truncation });
    }
    const text = textOf(message.content);
    if (text === undefined) return undefined;
    return withAt({ event: 'message assistant', ...summarize(text) });
  }
  if (role === 'toolResult') {
    const status = message.isError === true ? 'error' : message.isError === false ? 'ok' : undefined;
    const error = typeof message.errorCode === 'string' ? safe(message.errorCode)
      : typeof message.errorType === 'string' ? safe(message.errorType) : undefined;
    // A successful result never returns its body, however short: the summary is the outcome, not the output.
    const body = status === 'error' ? textOf(message.content) : undefined;
    return withAt({
      event: eventName('tool_result', message.toolName),
      ...(status === undefined ? {} : { status }),
      ...(error === undefined ? {} : { error }),
      ...(body === undefined ? {} : summarize(body)),
    });
  }
  if (role === 'user') {
    const text = textOf(message.content);
    if (text === undefined) return undefined;
    return withAt({ event: 'message user', ...summarize(text) });
  }
  if (role) return withAt({ event: eventName('message', role) });
  const status = typeof record.status === 'string' ? safe(record.status) : undefined;
  return type ? withAt({ event: [...type].slice(0, ACTIVITY_EVENT_LIMIT).join(''), ...(status === undefined ? {} : { status }) }) : undefined;
}

export interface ActivityWindow {
  entries: ActivityEntry[];
  source: ActivitySource;
  incomplete?: 'start' | 'end' | 'both';
  /** A short reason when the read failed; never a fallback to a full-file scan. */
  reason?: string;
}

/**
 * The latest `limit` saved records for one member, in file order. A caller that already read the bounded tail
 * for the reply passes it in, so one response reads the file once.
 */
export function activityFromTail(tail: string | undefined, limit: number, source: ActivitySource = tail === undefined ? 'unreadable' : 'tail', reason?: string): ActivityWindow {
  if (tail === undefined) return { entries: [], source, ...(reason === undefined ? {} : { reason }) };
  const lines = tail.split('\n');
  // A bounded tail usually begins mid-line: the first fragment then cannot parse, and that is exactly how
  // "the read started inside a record" is recognised.
  const firstLine = lines[0]?.trim() ?? '';
  const incompleteStart = firstLine.length > 0 && (() => { try { JSON.parse(firstLine); return false; } catch { return true; } })();
  const records: ActivityEntry[] = [];
  const length = lines.length;
  for (let index = incompleteStart ? 1 : 0; index < length; index += 1) {
    const line = lines[index]!;
    if (!line.trim()) continue;
    // The last line without its newline is a record still being written: it is not evidence either.
    if (index === length - 1 && !tail.endsWith('\n')) continue;
    let parsed: unknown;
    try { parsed = JSON.parse(line); } catch { continue; }
    const entry = entryOf(parsed);
    if (entry) records.push(entry);
  }
  const incompleteEnd = !tail.endsWith('\n');
  return {
    entries: records.slice(-limit),
    source: 'tail',
    ...(incompleteStart || incompleteEnd ? { incomplete: incompleteStart && incompleteEnd ? 'both' as const : incompleteStart ? 'start' as const : 'end' as const } : {}),
  };
}

/** Locate and read one member's bounded tail, reporting why nothing could be read. */
export function readActivityTail(sessionId: string, options: { file?: string; recorded?: string | null; read?: (path: string) => string } = {}): { tail?: string; source: ActivitySource; reason?: string } {
  const file = options.file ?? sessionFileFor(sessionId, { ...(options.recorded === undefined ? {} : { recorded: options.recorded }) });
  if (!file) return { source: anySessionsRootExists() ? 'unsaved' : 'unlocatable' };
  try {
    return { tail: (options.read ?? ((path: string) => readTail(path)))(file), source: 'tail' };
  } catch (cause) {
    // A located file that cannot be read is not empty history, and it is never repaired or scanned whole.
    return { source: 'unreadable', reason: cause instanceof Error ? cause.message : String(cause) };
  }
}

/** Convenience for callers that have no tail yet (tests, one-shot reads): locate, read once, summarise. */
export function readActivity(sessionId: string, limit: number, options: { file?: string; recorded?: string | null; read?: (path: string) => string } = {}): ActivityWindow {
  const located = readActivityTail(sessionId, options);
  return activityFromTail(located.tail, limit, located.source, located.reason);
}
