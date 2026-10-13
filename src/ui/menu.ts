import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import { stripTerminalSequences, truncateToWidth, wrapTextWithAnsi, visibleWidth } from '@earendil-works/pi-tui';
import { chinese, type Translator } from '../shared/i18n.ts';

export type MenuTone = 'accent' | 'success' | 'warning' | 'error' | 'muted';
export interface MenuItem { id: string; label: string; value?: string; description?: string; disabledReason?: string; tone?: MenuTone; valueTone?: MenuTone | 'dim' }
export interface MenuCursor { query?: string; selectedId?: string; page?: number }
export interface MenuOptions {
  /** Short, explicitly selected state only. Complete requirements belong in readView. */
  lines?: readonly string[] | ((item: MenuItem) => readonly string[]);
  actions?: readonly MenuItem[]; searchable?: boolean; cursor?: MenuCursor;
  isCurrent?: () => boolean; signal?: AbortSignal; msg?: Translator;
}
export interface ReadViewOptions { isCurrent?: () => boolean; signal?: AbortSignal; msg?: Translator; tone?: MenuTone }
interface DisplayScope { depth: number; changed: () => void }
const scopes = new WeakMap<object, DisplayScope>();
const promptOwners = new WeakMap<object, Map<string, number>>();
const manager = (ctx: ExtensionContext): object => ctx.sessionManager ?? ctx.ui;
export function bindMenuDisplay(ctx: ExtensionContext, changed: () => void): () => void {
  const key = manager(ctx), scope = { depth: 0, changed }; scopes.set(key, scope);
  return () => { if (scopes.get(key) === scope) scopes.delete(key); };
}
export const menuDisplayOpen = (ctx: ExtensionContext): boolean => (scopes.get(manager(ctx))?.depth ?? 0) > 0;
/** The whole command, including nested dialogs, temporarily withdraws only our summary. */
export async function withMenuScope<T>(ctx: ExtensionContext, run: () => Promise<T>): Promise<T> {
  const key = manager(ctx), scope = scopes.get(key);
  if (!scope) return run();
  scope.depth++; if (scope.depth === 1) scope.changed();
  try { return await run(); }
  finally { scope.depth--; if (!scope.depth && scopes.get(key) === scope) scope.changed(); }
}
export const isMenuPrompt = (title: string | undefined, key: object): boolean => title !== undefined && (promptOwners.get(key)?.get(title) ?? 0) > 0;
export async function menuPrompt<T>(ctx: ExtensionContext, title: string, run: () => Promise<T>): Promise<T> {
  const key = manager(ctx), owners = promptOwners.get(key) ?? new Map<string, number>();
  promptOwners.set(key, owners); owners.set(title, (owners.get(title) ?? 0) + 1);
  try { return await withMenuScope(ctx, run); }
  finally { const count = owners.get(title) ?? 1; if (count <= 1) owners.delete(title); else owners.set(title, count - 1); }
}
const PAGE_SIZE = 8;
function clean(text: string): string {
  return stripTerminalSequences(text.replace(/\u009b/g, '\x1b[').replace(/\u009d/g, '\x1b]').replace(/\u009c/g, '\x1b\\'))
    .replace(/[\p{Cc}\p{Bidi_Control}\u206a-\u206f]/gu, ' ').replace(/[ \t]+/g, ' ').trim();
}
function block(text: string): string[] {
  return text.split('\n').map(line => stripTerminalSequences(line.replace(/\u009b/g, '\x1b[').replace(/\u009d/g, '\x1b]').replace(/\u009c/g, '\x1b\\'))
    .replace(/\t/g, '  ').replace(/[\p{Cc}\p{Bidi_Control}\u206a-\u206f]/gu, ''));
}
function available(ctx: ExtensionContext): boolean { return ctx.hasUI && !['print', 'json'].includes(ctx.mode as string); }
function current(options: ReadViewOptions): boolean { return !options.signal?.aborted && options.isCurrent?.() !== false; }
function styled(ctx: ExtensionContext, text: string, tone: MenuTone | 'dim' | 'text', bold = false): string {
  return ctx.mode === 'tui' ? ctx.ui.theme.style(text, { fg: tone, bold }) : text;
}
export function statusTone(value: string, msg: Translator = chinese): MenuTone {
  if (['失败', '已耗尽', '状态受保护：是', '状态损坏', '启动失败'].some(key => value.includes(msg(key)))) return 'error';
  if (['等待回复', '待交付', '待核验', '等待重试', 'Plan 只读', '暂停'].some(key => value.includes(msg(key)))) return 'warning';
  if (['已完成', '已关闭', '已取消', '关闭'].some(key => value.includes(msg(key)))) return 'muted';
  if (['运行中', '进行中', '活动', '启动中', '开启'].some(key => value.includes(msg(key)))) return 'accent';
  if (['已验证', '核验通过'].some(key => value.includes(msg(key)))) return 'success';
  return 'muted';
}
function infoLine(ctx: ExtensionContext, line: string, msg: Translator): string {
  const tone = /^(?:错误|最近错误|Error|Last error)[:：]/.test(line) ? 'error' : /^(?:已验证进展|Verified findings)[:：]/.test(line) && !/(?:暂无|none yet)/.test(line) ? 'success' : /^(?:下一步|Next action)[:：]/.test(line) ? 'accent' : statusTone(line, msg);
  const important = /^(?:状态|阶段|错误|最近错误|未满足依赖|自动重试|Status|Recovery|Error|Last error|Unmet prerequisites|Automatic retry)[:：]/.test(line) || line.startsWith(msg('Plan 只读'));
  if (important) return styled(ctx, line, tone === 'muted' && !line.includes(msg('已完成')) && !line.includes(msg('关闭')) ? 'text' : tone, true);
  const colon = line.indexOf('：') >= 0 ? line.indexOf('：') : line.indexOf(':');
  if (colon > 0 && colon < 24) return styled(ctx, line.slice(0, colon + 1), tone === 'success' ? 'success' : 'accent', true) + styled(ctx, line.slice(colon + 1), 'text');
  return styled(ctx, line, 'text');
}
function dimensions(ctx: ExtensionContext): { width: number; rows: number } {
  return { width: ctx.mode === 'tui' ? Math.max(16, (process.stdout.columns ?? 80) - 4) : 76, rows: ctx.mode === 'tui' ? Math.max(12, process.stdout.rows ?? 24) : 24 };
}
function unique(labels: string[]): string[] {
  const counts = new Map<string, number>(), used = new Set<string>(), reserved = new Set(labels);
  for (const label of labels) counts.set(label, (counts.get(label) ?? 0) + 1);
  return labels.map(label => {
    let result = label, n = 0;
    if ((counts.get(label) ?? 0) > 1) do { result = `${label} (${++n})`; } while (used.has(result) || reserved.has(result));
    used.add(result); return result;
  });
}
async function guarded<T>(options: ReadViewOptions, run: (signal: AbortSignal) => Promise<T>): Promise<T | undefined> {
  if (!current(options)) return undefined;
  const controller = new AbortController(), abort = () => controller.abort();
  options.signal?.addEventListener('abort', abort, { once: true });
  const timer = options.isCurrent ? setInterval(() => { if (!current(options)) abort(); }, 100) : undefined;
  timer?.unref?.();
  let onAbort: () => void = () => {};
  const aborted = new Promise<undefined>(resolve => { onAbort = () => resolve(undefined); controller.signal.addEventListener('abort', onAbort, { once: true }); });
  try { return await Promise.race([run(controller.signal), aborted]); }
  finally { if (timer) clearInterval(timer); controller.signal.removeEventListener('abort', onAbort); options.signal?.removeEventListener('abort', abort); }
}

const RESIZED = Symbol('native-dialog-resized');
async function nativeSelect(ctx: ExtensionContext, title: string, options: string[], signal: AbortSignal): Promise<string | undefined | typeof RESIZED> {
  if (signal.aborted) return undefined;
  const controller = new AbortController(), abort = () => controller.abort();
  signal.addEventListener('abort', abort, { once: true });
  const initial = dimensions(ctx); let resized = false;
  const timer = ctx.mode === 'tui' ? setInterval(() => { const next = dimensions(ctx); if (next.width !== initial.width || next.rows !== initial.rows) { resized = true; controller.abort(); } }, 100) : undefined;
  timer?.unref?.();
  try {
    const value = await menuPrompt(ctx, title, () => ctx.ui.select(title, options, { signal: controller.signal }));
    if (resized && !signal.aborted) {
      // Let Pi render the cleared editor slot before replacing a differently sized
      // native dialog; coalescing both swaps leaves regular-mode viewport offsets stale.
      await new Promise(resolve => setTimeout(resolve, 40));
      return RESIZED;
    }
    return value;
  }
  finally { if (timer) clearInterval(timer); signal.removeEventListener('abort', abort); }
}

/** Pi owns focus, borders and keybindings. No custom terminal component or overlay. */
export async function choose(ctx: ExtensionContext, title: string, items: readonly MenuItem[], options: MenuOptions = {}): Promise<string | undefined> {
  if (!available(ctx) || !current(options)) return undefined;
  const msg = options.msg ?? chinese, cursor = options.cursor ?? {};
  const safe = items.map(item => ({ ...item, label: clean(item.label), value: clean(item.value ?? ''), description: clean(item.description ?? '') }));
  return withMenuScope(ctx, () => guarded(options, async signal => {
    let query = cursor.query ?? '', page = Math.max(0, cursor.page ?? 0);
    for (;;) {
      if (!current(options) || signal.aborted) return undefined;
      const filtered = query ? safe.filter(item => [item.label, item.value, item.description, item.id].some(text => text.toLowerCase().includes(query.toLowerCase()))) : safe;
      const { width, rows } = dimensions(ctx);
      const summary = typeof options.lines === 'function' && !options.searchable && safe[0] ? options.lines(safe[0]) : Array.isArray(options.lines) ? options.lines : [];
      const alerts = summary.filter(line => /^(?:状态|阶段|错误|最近错误|说明|报告交付|Status|Recovery|Error|Last error|Note|Report)[:：]/.test(line) || /^(?:Todo #\d+ (?:验收|acceptance))[:：]/.test(line));
      const short = [...alerts, ...summary.filter(line => !alerts.includes(line))].slice(0, 3).map(line => truncateToWidth(clean(line), width, '…'));
      const size = ctx.mode === 'tui' ? Math.max(1, Math.min(PAGE_SIZE, rows - 17 - short.length - (options.actions?.length ?? 0) - (options.searchable ? 1 : 0))) : PAGE_SIZE;
      const pages = Math.max(1, Math.ceil(filtered.length / size)); page = Math.min(page, pages - 1);
      const entries: { label: string; tone?: MenuTone; valueTone?: MenuTone | 'dim'; pick: () => Promise<string | undefined> | string | undefined; done: boolean }[] = [];
      for (const item of filtered.slice(page * size, page * size + size)) {
        const id = /^(#\d+|a\d+)\s/.exec(item.label)?.[1];
        const prefix = id ? `${id} [${item.value}] ` : '', suffix = !id && item.value ? `  ${item.value}` : '';
        const room = Math.max(1, width - visibleWidth(prefix || suffix));
        const label = prefix ? prefix + truncateToWidth(item.label.slice(id!.length).trim(), room, '…') : truncateToWidth(item.label, room, '…') + suffix;
        entries.push({ label: item.disabledReason ? msg`${label}（不可用：${clean(item.disabledReason)}）` : label, tone: item.disabledReason ? 'muted' : item.tone ?? statusTone(item.value, msg), ...(item.valueTone ? { valueTone: item.valueTone } : {}), done: !item.disabledReason, pick: () => { if (item.disabledReason) return undefined; cursor.selectedId = item.id; return item.id; } });
      }
      if (page > 0) entries.push({ label: msg('上一页'), done: false, pick: () => { page--; cursor.page = page; return undefined; } });
      if (page < pages - 1) entries.push({ label: msg('下一页'), done: false, pick: () => { page++; cursor.page = page; return undefined; } });
      if (options.searchable) entries.push({ label: msg('搜索…'), done: false, pick: async () => { const next = await menuPrompt(ctx, msg('搜索：'), () => ctx.ui.input(msg('搜索：'), query || msg('筛选…'), { signal })); if (next !== undefined && current(options)) { query = next; cursor.query = next; page = 0; cursor.page = 0; } return undefined; } });
      for (const action of options.actions ?? []) entries.push({ label: clean(action.label) + (action.value ? `  ${clean(action.value)}` : '') + (action.disabledReason ? msg`（不可用：${clean(action.disabledReason)}）` : ''), ...(action.disabledReason ? { tone: 'muted' as const } : action.tone ? { tone: action.tone } : {}), ...(action.valueTone ? { valueTone: action.valueTone } : {}), done: !action.disabledReason, pick: () => action.disabledReason ? undefined : action.id });
      entries.push({ label: msg('返回'), done: true, pick: () => undefined });
      if (!filtered.length) entries.unshift({ label: msg('无匹配项'), tone: 'muted', done: false, pick: () => undefined });
      const plain = unique(entries.map(item => item.label));
      const labels = plain.map((label, index) => {
        const entry = entries[index]!, match = /^(#\d+|a\d+) (\[[^\]]*\]) (.*)$/.exec(label);
        if (match) return styled(ctx, match[1]!, 'text', true) + ' ' + styled(ctx, match[2]!, entry.valueTone ?? entry.tone ?? 'text', entry.valueTone !== 'dim') + ' ' + match[3];
        const split = label.lastIndexOf('  '), valueTone = entry.valueTone ?? entry.tone;
        if (split >= 0 && valueTone) return label.slice(0, split) + '  ' + styled(ctx, label.slice(split + 2), valueTone, valueTone === 'warning' || valueTone === 'error');
        return entry.tone === 'warning' || entry.tone === 'error' ? styled(ctx, label, entry.tone, true) : label;
      });
      const heading = [styled(ctx, truncateToWidth(clean(title), width, '…'), 'accent', true), styled(ctx, msg`第 ${page + 1}/${pages} 页 · 共 ${filtered.length} 项`, 'muted'), ...short.map(line => infoLine(ctx, line, msg))].join('\n');
      const picked = await nativeSelect(ctx, heading, labels, signal);
      if (picked === RESIZED) continue;
      if (!current(options) || signal.aborted || picked === undefined) return undefined;
      const index = labels.indexOf(picked); if (index < 0) continue;
      const entry = entries[index]!, value = await entry.pick();
      if (!current(options) || signal.aborted) return undefined;
      if (entry.done) return value;
    }
  }));
}

/** Full text is read-only and separately paged inside Pi's native bordered selector. */
export async function readView(ctx: ExtensionContext, title: string, text: string, options: ReadViewOptions = {}): Promise<void> {
  if (!current(options)) return;
  if (!available(ctx) || ctx.mode !== 'tui') { ctx.ui.notify(block(text).join('\n'), 'info'); return; }
  const msg = options.msg ?? chinese;
  await withMenuScope(ctx, () => guarded(options, async signal => {
    let offset = 0, anchor: { paragraph: number; fragment: number } | undefined;
    const paragraphs = block(text);
    while (current(options) && !signal.aborted) {
      const { width, rows } = dimensions(ctx), size = Math.max(1, Math.min(14, rows - 18));
      const lines = paragraphs.flatMap((line, paragraph) => wrapTextWithAnsi(line, width - 2).map((text, fragment) => ({ text, paragraph, fragment })));
      if (anchor) { const at = lines.findIndex(line => line.paragraph === anchor!.paragraph && line.fragment === anchor!.fragment); offset = at >= 0 ? at : Math.max(0, lines.findIndex(line => line.paragraph === anchor!.paragraph)); anchor = undefined; }
      offset = Math.max(0, Math.min(offset, Math.max(0, lines.length - 1)));
      const pages = Math.max(1, Math.ceil(lines.length / size)), page = Math.floor(offset / size);
      const heading = [styled(ctx, truncateToWidth(clean(title), width, '…'), 'accent', true), styled(ctx, msg`第 ${page + 1}/${pages} 页 · ${offset + 1}–${Math.min(offset + size, lines.length)}/${lines.length} 行`, 'muted')].join('\n');
      const actions = [...offset > 0 ? [msg('上一页')] : [], ...offset + size < lines.length ? [msg('下一页')] : [], msg('返回')];
      const body = lines.slice(offset, offset + size).map(line => styled(ctx, '│ ', 'muted') + infoLine(ctx, line.text, msg));
      const selected = await nativeSelect(ctx, heading, [...actions, ...body], signal);
      if (selected === RESIZED) { const first = lines[offset]; if (first) anchor = { paragraph: first.paragraph, fragment: first.fragment }; continue; }
      if (!current(options) || signal.aborted || selected === undefined || selected === msg('返回')) return;
      if (selected === msg('上一页')) offset = Math.max(0, offset - size);
      if (selected === msg('下一页')) offset += size;
      // Body rows are read-only; selecting one changes no data or editor state.
    }
  }));
}
