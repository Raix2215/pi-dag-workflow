import { readFile } from 'node:fs/promises';
import { chinese, type Translator } from '../../shared/i18n.ts';
import { SessionManager, CURRENT_SESSION_VERSION, migrateSessionEntries, parseSessionEntries, type FileEntry, type SessionEntry, type SessionTreeNode } from '@earendil-works/pi-coding-agent';
import { stripTerminalSequences } from '@earendil-works/pi-tui';

export interface HistoryEntry { readonly id: string; readonly label: string; readonly text: string }
export interface HistorySnapshot {
  readonly state: 'ok' | 'missing' | 'invalid';
  readonly reason?: string;
  readonly entries: readonly HistoryEntry[];
  readonly tree: readonly SessionTreeNode[];
  readonly leafId: string | null;
  readonly skipped: number;
}
const empty = (state: HistorySnapshot['state'], reason?: string): HistorySnapshot => ({ state, ...(reason ? { reason } : {}), entries: [], tree: [], leafId: null, skipped: 0 });

/** Strip terminal commands, not user content or indentation. No size/depth limit on saved text. */
export const safeHistoryText = (text: string): string => stripTerminalSequences(text.replace(/\u009b/g, '\x1b[').replace(/\u009d/g, '\x1b]').replace(/\u009c/g, '\x1b\\'))
  .replace(/[\p{Cc}\p{Bidi_Control}]/gu, char => char === '\n' || char === '\t' ? char : '');

/** JSON records can be arbitrarily deep. Walk them without recursion or clipping their values. */
function displayValue(value: unknown): unknown {
  if (typeof value === 'string') return safeHistoryText(value);
  if (!value || typeof value !== 'object') return value;
  const root: any = Array.isArray(value) ? [] : Object.create(null);
  const stack: { source: object; target: any }[] = [{ source: value, target: root }];
  const seen = new WeakMap<object, any>([[value, root]]);
  while (stack.length) {
    const { source, target } = stack.pop()!;
    for (const [key, item] of Object.entries(source)) {
      const name = safeHistoryText(key);
      if (item && typeof item === 'object') {
        let child = seen.get(item);
        if (!child) { child = Array.isArray(item) ? [] : Object.create(null); seen.set(item, child); stack.push({ source: item, target: child }); }
        target[name] = child;
      } else target[name] = typeof item === 'string' ? safeHistoryText(item) : item;
    }
  }
  return root;
}

/** Serialize parsed JSON iteratively too: JSON.stringify itself can overflow on a deep saved argument. */
function jsonText(value: unknown): string {
  const chunks: string[] = [];
  const stack: { value?: unknown; literal?: string }[] = [{ value }];
  while (stack.length) {
    const next = stack.pop()!;
    if (next.literal !== undefined) { chunks.push(next.literal); continue; }
    const item = next.value;
    if (!item || typeof item !== 'object') { chunks.push(JSON.stringify(item) ?? 'null'); continue; }
    const array = Array.isArray(item), pairs = Object.entries(item);
    chunks.push(array ? '[' : '{');
    stack.push({ literal: array ? ']' : '}' });
    for (let at = pairs.length - 1; at >= 0; at--) {
      const [key, child] = pairs[at]!;
      stack.push({ value: child });
      if (!array) stack.push({ literal: `${JSON.stringify(key)}:` });
      if (at) stack.push({ literal: ',' });
    }
  }
  return chunks.join('');
}
function entryText(entry: SessionEntry): string {
  const record = entry as unknown as Record<string, any>;
  if (record.type === 'message' || record.type === 'custom_message') {
    const content = record.type === 'message' ? record.message?.content : record.content;
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) return content.map(item => {
      if (!item || typeof item !== 'object') return jsonText(item);
      if (item.type === 'text') return item.text ?? '';
      if (item.type === 'thinking') return item.thinking ?? '';
      if (item.type === 'toolCall' || item.type === 'tool_use') return `[tool ${item.name ?? ''}] ${jsonText(item.arguments ?? item.input ?? null)}`;
      return jsonText(item);
    }).join('\n');
  }
  return jsonText(record);
}

/**
 * Read the entire saved session, then let the public in-memory SessionManager resolve the native tree,
 * labels, timestamps and leaf. Never open the source through SessionManager.open: it can migrate/write it.
 */
export async function readHistory(file: string | undefined, reason?: string, signal?: AbortSignal, msg: Translator = chinese): Promise<HistorySnapshot> {
  if (!file) return empty('missing', reason);
  let text: string;
  try { text = await readFile(file, { encoding: 'utf8', ...(signal ? { signal } : {}) }); }
  catch (error) { return empty('missing', (error as NodeJS.ErrnoException).code === 'ENOENT' ? msg('尚未保存') : msg('会话文件不可读')); }
  const parsed = (parseSessionEntries(text) as unknown[]).filter((item): item is FileEntry => !!item && typeof item === 'object' && typeof (item as { type?: unknown }).type === 'string');
  const header = parsed[0];
  if (!header || header.type !== 'session') return empty('invalid', msg('不是 Pi 会话文件'));
  if ((header.version ?? 1) < CURRENT_SESSION_VERSION) migrateSessionEntries(parsed);
  const unique = new Map<string, SessionEntry>();
  for (const entry of parsed.slice(1)) {
    if (entry.type === 'session') continue;
    if (entry.type === 'message' && (!entry.message || typeof entry.message.role !== 'string')) continue;
    if ('id' in entry && typeof entry.id === 'string') { unique.delete(entry.id); unique.set(entry.id, entry as SessionEntry); }
  }
  // Invalid cycles must not hang native ancestor traversal. Repair only the in-memory parent links.
  const parents = new Map<string, string>();
  for (const entry of unique.values()) if (entry.parentId && entry.parentId !== entry.id && unique.has(entry.parentId)) parents.set(entry.id, entry.parentId);
  const visited = new Set<string>();
  for (const id of unique.keys()) {
    const path = new Set<string>(); let cursor: string | undefined = id;
    while (cursor && !visited.has(cursor)) {
      if (path.has(cursor)) { parents.delete(cursor); break; }
      path.add(cursor); cursor = parents.get(cursor);
    }
    for (const key of path) visited.add(key);
  }
  const entries = [...unique.values()].map(entry => ({ ...entry, parentId: parents.get(entry.id) ?? null }));
  const session = SessionManager.inMemory(header.cwd, undefined, [header, ...entries]);
  return {
    state: 'ok', tree: session.getTree(), leafId: session.getLeafId(),
    // Bodies are formatted only when opened, rather than serializing every tool result on entry.
    entries: entries.map(entry => ({ id: entry.id, label: entry.type === 'message' ? String((entry.message as { role?: string }).role ?? 'message') : entry.type, get text() { return entryText(entry); } })),
    skipped: Math.max(0, text.split('\n').filter(line => line.trim()).length - 1 - entries.length),
  };
}
export const entryBody = (snapshot: HistorySnapshot, id: string): string | undefined => snapshot.entries.find(item => item.id === id)?.text;

/** Native custom-tool previews call recursive JSON.stringify. Preserve deeply nested arguments as a
 * complete JSON string in the display copy only; this is not a history/body size or depth cutoff. */
function nativeArgument(value: unknown): unknown {
  const stack: { value: unknown; depth: number }[] = [{ value, depth: 0 }];
  while (stack.length) {
    const item = stack.pop()!;
    if (!item.value || typeof item.value !== 'object') continue;
    if (item.depth > 512) return jsonText(value);
    for (const child of Object.values(item.value)) stack.push({ value: child, depth: item.depth + 1 });
  }
  return value;
}

/** A complete, terminal-safe display copy. Traversal is iterative; saved source bytes are never changed. */
export function displayTree(tree: readonly SessionTreeNode[]): SessionTreeNode[] {
  const roots: SessionTreeNode[] = [], seen = new Set<SessionTreeNode>();
  const stack = [...tree].reverse().map(node => ({ node, target: roots, parentId: null as string | null }));
  while (stack.length) {
    const { node, target, parentId } = stack.pop()!;
    if (seen.has(node)) continue;
    seen.add(node);
    const entry = displayValue(node.entry) as SessionEntry;
    if (entry.type === 'message' && entry.message.role === 'assistant' && Array.isArray(entry.message.content)) {
      for (const block of entry.message.content) {
        if (block && block.type === 'toolCall' && !['read', 'write', 'edit', 'bash', 'grep', 'find', 'ls'].includes(block.name)) block.arguments = nativeArgument(block.arguments) as typeof block.arguments;
      }
    }
    const clone: SessionTreeNode = { entry: { ...entry, id: node.entry.id, parentId }, children: [], ...(node.label === undefined ? {} : { label: safeHistoryText(node.label) }), ...(node.labelTimestamp === undefined ? {} : { labelTimestamp: node.labelTimestamp }) };
    target.push(clone);
    for (let at = node.children.length - 1; at >= 0; at--) stack.push({ node: node.children[at]!, target: clone.children, parentId: clone.entry.id });
  }
  return roots;
}
