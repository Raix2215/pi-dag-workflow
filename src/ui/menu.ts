import type { ExtensionContext, Theme } from '@earendil-works/pi-coding-agent';
import {
  Input, SelectList, matchesKey, stripTerminalSequences, truncateToWidth, wrapTextWithAnsi,
  type Component, type SelectItem, type SelectListTheme, type TUI,
} from '@earendil-works/pi-tui';
import { chinese, type Translator } from '../shared/i18n.ts';
import { detailView } from './detail.ts';

/** One result row. A `disabledReason` makes the row visible but not executable. */
export interface MenuItem {
  id: string;
  label: string;
  value?: string;
  description?: string;
  disabledReason?: string;
}

/** Caller-owned draft; the component writes back so a reopened menu resumes where it left off. */
export interface MenuCursor {
  query?: string;
  selectedId?: string;
  page?: number;
}

export interface MenuOptions {
  /** Full detail lines for the highlighted item: an array is shared by every item, a function is re-read per selection. */
  lines?: readonly string[] | ((item: MenuItem) => readonly string[]);
  /** Fixed actions, kept outside the result set; their `id` is returned like a result id. */
  actions?: readonly MenuItem[];
  searchable?: boolean;
  cursor?: MenuCursor;
  isCurrent?: () => boolean;
  signal?: AbortSignal;
  msg?: Translator;
}

export interface ReadViewOptions {
  isCurrent?: () => boolean;
  signal?: AbortSignal;
  msg?: Translator;
}

/** Sanitized projection: every user-visible field is stripped of control sequences exactly once. */
interface SafeItem {
  id: string;
  label: string;
  value: string;
  description: string;
  disabledReason: string;
}

const promptOwners = new WeakMap<object, Map<string, number>>();
/** Ownership follows this Pi session, not another SDK session with the same dialog title. */
export const isMenuPrompt = (title: string | undefined, manager: object): boolean => title !== undefined && (promptOwners.get(manager)?.get(title) ?? 0) > 0;
export async function menuPrompt<T>(ctx: ExtensionContext, title: string, run: () => Promise<T>): Promise<T> {
  const manager = ctx.sessionManager ?? ctx.ui, owners = promptOwners.get(manager) ?? new Map<string, number>();
  promptOwners.set(manager, owners); owners.set(title, (owners.get(title) ?? 0) + 1);
  try { return await run(); } finally { const count = owners.get(title) ?? 1; if (count <= 1) owners.delete(title); else owners.set(title, count - 1); }
}
const PAGE_SIZE = 8;
const EXPIRY_POLL_MS = 100;
/** Rows Pi keeps for its own footer/context chrome below the custom component. */
const RESERVED_ROWS = 4;
/** Maximum action-zone lines: keeps the selected action inside a visible window on narrow screens. */
const ACTION_WINDOW_MAX = 3;

function stripControls(text: string): string {
  const escaped = text.replace(/\u009b/g, '\x1b[').replace(/\u009d/g, '\x1b]').replace(/\u009c/g, '\x1b\\');
  return stripTerminalSequences(escaped).replace(/[\p{Cc}\p{Bidi_Control}\u206a-\u206f]/gu, '');
}

/** Single-line projection: control characters collapse to a space. */
function inline(text: string): string {
  return stripControls(text).replace(/[ \t]+/g, ' ').trim();
}

/** Multi-line projection: line breaks survive, every other control character is removed. */
function blockText(text: string): string {
  return text.split('\n').map((line) => stripControls(line).replace(/\t/g, '  ')).join('\n');
}

function sanitizeItem(item: MenuItem): SafeItem {
  return {
    id: item.id,
    label: inline(item.label),
    value: inline(item.value ?? ''),
    description: inline(item.description ?? ''),
    disabledReason: inline(item.disabledReason ?? ''),
  };
}

/** Label shown in list and dialog rows: the current value rides on the same primary column. */
function listLabel(item: SafeItem): string {
  return item.value ? `${item.label}  ${item.value}` : item.label;
}

function matchesQuery(item: SafeItem, query: string): boolean {
  if (!query) return true;
  const needle = query.toLowerCase();
  return [item.label, item.id, item.value, item.description, item.disabledReason]
    .some((value) => value.toLowerCase().includes(needle));
}

function expired(options: { signal?: AbortSignal; isCurrent?: () => boolean }): boolean {
  return options.signal?.aborted === true || options.isCurrent?.() === false;
}

/** Resolve as soon as the dialog promise settles or the controller aborts. */
function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T | undefined> {
  if (signal.aborted) return Promise.resolve(undefined);
  return new Promise((resolve) => {
    const onAbort = () => resolve(undefined);
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => { signal.removeEventListener('abort', onAbort); resolve(value); },
      () => { signal.removeEventListener('abort', onAbort); resolve(undefined); },
    );
  });
}

/** Only labels that collide on the current page get a stable page-local ordinal; a single id is never displayed. */
function uniquify(labels: readonly string[]): string[] {
  const counts = new Map<string, number>();
  for (const label of labels) counts.set(label, (counts.get(label) ?? 0) + 1);
  const seen = new Map<string, number>();
  return labels.map((label) => {
    if ((counts.get(label) ?? 0) <= 1) return label;
    const ordinal = (seen.get(label) ?? 0) + 1;
    seen.set(label, ordinal);
    return `${label} (${ordinal})`;
  });
}

type Step = { done: true; value: string | undefined } | { done: false };

class MenuComponent implements Component {
  private readonly ctx: ExtensionContext;
  private readonly tui: TUI;
  private readonly theme: Theme;
  private readonly msg: Translator;
  private readonly title: string;
  private readonly items: readonly SafeItem[];
  private readonly options: MenuOptions;
  private readonly cursor: MenuCursor;
  private readonly done: (result: string | undefined) => void;
  private readonly input: Input;
  private readonly cleanup: (() => void)[] = [];
  private list: SelectList;
  private sliceSignature = '';
  private filteredCache: readonly SafeItem[] | undefined;
  private filteredQuery: string | undefined;
  private lastQuery: string;
  private pageSize = PAGE_SIZE;
  private page: number;
  private selectedIndex = 0;
  private actionIndex = 0;
  private detailScroll = 0;
  private detailMaxScroll = 0;
  private zone: 'list' | 'actions' = 'list';
  private detailHeight = 1;
  private focusedState = false;
  private restored = false;
  private finished = false;

  constructor(ctx: ExtensionContext, tui: TUI, theme: Theme, title: string, items: readonly MenuItem[], options: MenuOptions, msg: Translator, done: (result: string | undefined) => void) {
    this.ctx = ctx;
    this.tui = tui;
    this.theme = theme;
    this.msg = msg;
    this.title = title;
    this.items = items.map(sanitizeItem);
    this.options = options;
    this.cursor = options.cursor ?? {};
    this.done = done;
    this.page = Math.max(0, Math.floor(this.cursor.page ?? 0));
    this.lastQuery = this.cursor.query ?? '';
    this.input = new Input({ prompt: msg('搜索：'), placeholder: msg('筛选…') });
    this.input.setValue(this.lastQuery);
    this.list = new SelectList([], PAGE_SIZE, this.listTheme());
    this.installExpiry();
  }

  get focused(): boolean { return this.focusedState; }
  set focused(value: boolean) { this.focusedState = value; this.syncInputFocus(); }

  private listTheme(): SelectListTheme {
    const { theme } = this;
    return {
      selectedPrefix: (text) => theme.fg('accent', text),
      selectedText: (text) => theme.fg('accent', text),
      description: (text) => theme.fg('muted', text),
      scrollInfo: (text) => theme.fg('muted', text),
      noMatch: (text) => theme.fg('muted', text),
    };
  }

  private installExpiry(): void {
    const { signal, isCurrent } = this.options;
    if (signal) {
      const onAbort = () => this.finish(undefined);
      signal.addEventListener('abort', onAbort);
      this.cleanup.push(() => signal.removeEventListener('abort', onAbort));
      if (signal.aborted) { this.finish(undefined); return; }
    }
    if (isCurrent) {
      const timer = setInterval(() => {
        if (!isCurrent()) { this.finish(undefined); return; }
        this.requestRender();
      }, EXPIRY_POLL_MS);
      (timer as { unref?: () => void }).unref?.();
      this.cleanup.push(() => clearInterval(timer));
    }
  }

  private finish(result: string | undefined): void {
    if (this.finished) return;
    this.finished = true;
    this.runCleanup();
    this.done(result);
  }

  private runCleanup(): void {
    while (this.cleanup.length) this.cleanup.pop()!();
  }

  dispose(): void { this.runCleanup(); }

  private requestRender(): void { this.tui.requestRender(); }

  private syncInputFocus(): void {
    this.input.focused = this.focusedState && this.zone === 'list' && this.options.searchable === true;
  }

  private terminalRows(): number {
    const rows = this.tui.terminal.rows;
    return Number.isFinite(rows) && rows > 0 ? Math.floor(rows) : 24;
  }

  private filtered(): readonly SafeItem[] {
    const query = this.options.searchable ? this.input.getValue() : '';
    if (this.filteredCache !== undefined && this.filteredQuery === query) return this.filteredCache;
    this.filteredQuery = query;
    this.filteredCache = query ? this.items.filter((item) => matchesQuery(item, query)) : this.items;
    return this.filteredCache;
  }

  private pageCount(length: number): number { return Math.max(1, Math.ceil(length / this.pageSize)); }

  private currentSlice(): readonly SafeItem[] {
    const filtered = this.filtered();
    const start = this.page * this.pageSize;
    return filtered.slice(start, start + this.pageSize);
  }

  private ensureRestored(): void {
    if (this.restored) return;
    this.restored = true;
    const selectedId = this.cursor.selectedId;
    if (selectedId === undefined) return;
    const at = this.filtered().findIndex((item) => item.id === selectedId);
    if (at < 0) return;
    this.page = Math.floor(at / this.pageSize);
    this.selectedIndex = at % this.pageSize;
    this.cursor.page = this.page;
  }

  private syncList(slice: readonly SafeItem[]): void {
    const signature = `${this.pageSize}\u0000${slice.map((item) => `${item.id}\u0001${item.label}\u0001${item.value}\u0001${item.description}\u0001${item.disabledReason}`).join('\u0002')}`;
    if (signature !== this.sliceSignature) {
      this.sliceSignature = signature;
      const rows: SelectItem[] = slice.map((item) => {
        const description = item.disabledReason ? this.msg`${item.label} 不可用：${item.disabledReason}` : item.description;
        return description ? { value: item.id, label: listLabel(item), description } : { value: item.id, label: listLabel(item) };
      });
      this.list = new SelectList(rows, Math.max(1, this.pageSize), this.listTheme());
    }
    this.list.setSelectedIndex(this.selectedIndex);
  }

  private detailFor(item: SafeItem): string[] {
    const blocks: string[] = [];
    if (item.disabledReason) blocks.push(this.msg`${item.label} 不可用：${item.disabledReason}`);
    if (item.description) blocks.push(item.description);
    const extra = typeof this.options.lines === 'function' ? this.options.lines(item) : this.options.lines;
    if (extra) blocks.push(...extra);
    return blocks;
  }

  private renderDetail(width: number, slice: readonly SafeItem[], height: number): { header: string; body: string[] } {
    const selected = slice[this.selectedIndex];
    if (!selected) {
      this.detailScroll = 0;
      this.detailMaxScroll = 0;
      return { header: this.theme.fg('dim', this.msg('详情')), body: [] };
    }
    const wrapped = this.detailFor(selected).flatMap((block) => blockText(block).split('\n'))
      .flatMap((line) => wrapTextWithAnsi(line, Math.max(1, width)));
    this.detailMaxScroll = Math.max(0, wrapped.length - height);
    this.detailScroll = Math.max(0, Math.min(this.detailMaxScroll, this.detailScroll));
    const header = wrapped.length > height
      ? this.theme.fg('dim', this.msg`详情 ${this.detailScroll + 1}/${wrapped.length} · Ctrl+↑/↓ 滚动`)
      : this.theme.fg('dim', this.msg('详情'));
    const body = wrapped.slice(this.detailScroll, this.detailScroll + height).map((line) => this.theme.fg('muted', line));
    return { header: truncateToWidth(header, width, '…'), body };
  }

  private actionEntries(): { id: string; label: string; run: () => void }[] {
    const entries: { id: string; label: string; run: () => void }[] = [];
    const pageCount = this.pageCount(this.filtered().length);
    if (this.page > 0) entries.push({ id: '__prev', label: this.msg('上一页'), run: () => this.changePage(-1, pageCount) });
    if (this.page < pageCount - 1) entries.push({ id: '__next', label: this.msg('下一页'), run: () => this.changePage(1, pageCount) });
    if (this.options.searchable) entries.push({ id: '__search', label: this.msg('搜索…'), run: () => { this.zone = 'list'; this.syncInputFocus(); } });
    for (const action of this.options.actions ?? []) {
      const label = listLabel(sanitizeItem(action));
      entries.push({
        id: action.id,
        label: action.disabledReason ? this.msg`${label}（不可用：${inline(action.disabledReason)}）` : label,
        run: () => {
          if (action.disabledReason) { this.ctx.ui.notify(this.msg`${label} 不可用：${inline(action.disabledReason)}`, 'info'); return; }
          this.finish(action.id);
        },
      });
    }
    entries.push({ id: '__back', label: this.msg('返回'), run: () => this.finish(undefined) });
    return entries;
  }

  private renderActions(width: number, maxLines: number): string[] {
    const entries = this.actionEntries();
    if (!entries.length) return [];
    this.actionIndex = Math.max(0, Math.min(entries.length - 1, this.actionIndex));
    const visible = Math.max(1, Math.min(ACTION_WINDOW_MAX, maxLines, entries.length));
    const start = Math.max(0, Math.min(this.actionIndex - Math.floor(visible / 2), entries.length - visible));
    const lines: string[] = [];
    for (let index = start; index < start + visible; index++) {
      const entry = entries[index]!;
      const selected = this.zone === 'actions' && index === this.actionIndex;
      lines.push(truncateToWidth(selected ? this.theme.fg('accent', `→ ${this.theme.bold(entry.label)}`) : `  ${entry.label}`, width, '…'));
    }
    return lines;
  }

  private confirmSelected(): void {
    const item = this.currentSlice()[this.selectedIndex];
    if (!item) return;
    if (item.disabledReason) {
      this.ctx.ui.notify(this.msg`${item.label} 不可用：${item.disabledReason}`, 'info');
      return;
    }
    this.cursor.selectedId = item.id;
    this.finish(item.id);
  }

  private setSelection(index: number, slice: readonly SafeItem[]): void {
    if (!slice.length) return;
    this.selectedIndex = Math.max(0, Math.min(slice.length - 1, index));
    this.detailScroll = 0;
    const item = slice[this.selectedIndex];
    if (item) this.cursor.selectedId = item.id;
  }

  private changePage(delta: number, pageCount: number): void {
    const next = Math.max(0, Math.min(pageCount - 1, this.page + delta));
    if (next === this.page) return;
    this.page = next;
    this.cursor.page = next;
    this.selectedIndex = 0;
    this.detailScroll = 0;
    const first = this.currentSlice()[0];
    if (first) this.cursor.selectedId = first.id;
  }

  private scrollDetail(delta: number): void {
    this.detailScroll = Math.max(0, Math.min(this.detailMaxScroll, this.detailScroll + delta));
  }

  private applyQuery(): void {
    const query = this.input.getValue();
    if (query === this.lastQuery) return;
    this.lastQuery = query;
    this.cursor.query = query;
    this.page = 0;
    this.cursor.page = 0;
    this.selectedIndex = 0;
    this.detailScroll = 0;
    this.sliceSignature = '';
    const first = this.filtered()[0];
    if (first) this.cursor.selectedId = first.id;
  }

  private handleActionKey(data: string): void {
    const entries = this.actionEntries();
    if (!entries.length) return;
    this.actionIndex = Math.max(0, Math.min(entries.length - 1, this.actionIndex));
    if (matchesKey(data, 'up')) this.actionIndex = (this.actionIndex + entries.length - 1) % entries.length;
    else if (matchesKey(data, 'down')) this.actionIndex = (this.actionIndex + 1) % entries.length;
    else if (matchesKey(data, 'home')) this.actionIndex = 0;
    else if (matchesKey(data, 'end')) this.actionIndex = entries.length - 1;
    else if (matchesKey(data, 'enter') || matchesKey(data, 'return')) entries[this.actionIndex]?.run();
    else return;
    this.requestRender();
  }

  render(width: number): string[] {
    const safeWidth = Number.isFinite(width) && width > 0 ? Math.floor(width) : 1;
    const rows = this.terminalRows();
    const maxRows = Math.max(1, rows - RESERVED_ROWS);
    const searchable = this.options.searchable === true;
    const previousPageSize = this.pageSize;
    const selectedId = this.restored ? this.currentSlice()[this.selectedIndex]?.id : undefined;

    // Conservative budget so prev/next and the page slice stay stable across renders.
    const fixedGuess = 1 + (searchable ? 1 : 0) + 1 + 1 + 1; // title, search, page info, one action, footer
    const bodyGuess = Math.max(2, maxRows - fixedGuess);
    const detailGuess = bodyGuess >= 4 ? Math.max(1, Math.floor((bodyGuess - 1) / 3)) : 0;
    const listGuess = Math.max(1, bodyGuess - (detailGuess > 0 ? detailGuess + 1 : 0));
    this.pageSize = Math.max(1, Math.min(PAGE_SIZE, listGuess, Math.max(1, maxRows - 1)));

    this.ensureRestored();
    const filtered = this.filtered();
    if (selectedId !== undefined && previousPageSize !== this.pageSize) {
      const index = filtered.findIndex((item) => item.id === selectedId);
      if (index >= 0) { this.page = Math.floor(index / this.pageSize); this.selectedIndex = index % this.pageSize; this.cursor.page = this.page; }
    }
    const pageCount = this.pageCount(filtered.length);
    if (this.page >= pageCount) { this.page = pageCount - 1; this.cursor.page = this.page; }
    const start = this.page * this.pageSize;
    const slice = filtered.slice(start, start + this.pageSize);
    if (this.selectedIndex >= slice.length) this.selectedIndex = Math.max(0, slice.length - 1);

    let listLines: string[];
    if (slice.length) {
      this.syncList(slice);
      listLines = this.list.render(safeWidth);
    } else {
      listLines = [truncateToWidth(this.theme.fg('muted', this.msg('无匹配项')), safeWidth, '…')];
    }

    const actionRoom = Math.max(1, maxRows - listLines.length);
    const actionLines = this.renderActions(safeWidth, actionRoom);
    const leftover = maxRows - listLines.length - actionLines.length;
    this.detailHeight = Math.max(1, leftover);
    let remaining = leftover;

    const titleLine = truncateToWidth(this.theme.fg('accent', this.theme.bold(inline(this.title) || this.msg('选择'))), safeWidth, '…');
    const searchLines = searchable ? this.input.render(safeWidth) : [];
    const pageInfo = truncateToWidth(this.theme.fg('dim', this.msg`第 ${this.page + 1}/${pageCount} 页 · 共 ${filtered.length} 项`), safeWidth, '…');
    const footer = truncateToWidth(this.theme.fg('dim', this.msg('Esc 取消 · ↑/↓ 选择 · PgUp/PgDn 翻页 · Tab 操作 · Enter 确认')), safeWidth, '…');

    const showTitle = remaining >= 1; if (showTitle) remaining -= 1;
    const showSearch = searchable && searchLines.length > 0 && remaining >= searchLines.length; if (showSearch) remaining -= searchLines.length;
    const showPageInfo = remaining >= 1; if (showPageInfo) remaining -= 1;
    const showFooter = remaining >= 1; if (showFooter) remaining -= 1;
    const detailBodyHeight = remaining >= 2 ? remaining - 1 : 0;
    const detail = detailBodyHeight > 0 ? this.renderDetail(safeWidth, slice, detailBodyHeight) : undefined;

    const out: string[] = [];
    if (showTitle) out.push(titleLine);
    if (showSearch) out.push(...searchLines);
    out.push(...listLines);
    if (showPageInfo) out.push(pageInfo);
    if (detail) { out.push(detail.header); out.push(...detail.body); }
    out.push(...actionLines);
    if (showFooter) out.push(footer);
    // Cover the entire overlay row; otherwise short lines expose the widget underneath.
    return out.slice(0, maxRows).map((line) => truncateToWidth(line, safeWidth, '…', true));
  }

  invalidate(): void { this.sliceSignature = ''; }

  handleInput(data: string): void {
    if (this.finished) return;
    if (matchesKey(data, 'escape') || matchesKey(data, 'ctrl+c')) { this.finish(undefined); return; }
    if (matchesKey(data, 'tab')) {
      this.zone = this.zone === 'list' ? 'actions' : 'list';
      this.syncInputFocus();
      this.requestRender();
      return;
    }
    if (this.zone === 'actions') { this.handleActionKey(data); return; }

    const filtered = this.filtered();
    const pageCount = this.pageCount(filtered.length);
    const slice = this.currentSlice();
    if (matchesKey(data, 'up')) this.setSelection(this.selectedIndex - 1, slice);
    else if (matchesKey(data, 'down')) this.setSelection(this.selectedIndex + 1, slice);
    else if (matchesKey(data, 'pageUp')) this.changePage(-1, pageCount);
    else if (matchesKey(data, 'pageDown')) this.changePage(1, pageCount);
    else if (matchesKey(data, 'home')) this.setSelection(0, slice);
    else if (matchesKey(data, 'end')) this.setSelection(slice.length - 1, slice);
    else if (matchesKey(data, 'enter') || matchesKey(data, 'return')) this.confirmSelected();
    else if (matchesKey(data, 'ctrl+up')) this.scrollDetail(-1);
    else if (matchesKey(data, 'ctrl+down')) this.scrollDetail(1);
    else if (matchesKey(data, 'ctrl+pageUp')) this.scrollDetail(-this.detailHeight);
    else if (matchesKey(data, 'ctrl+pageDown')) this.scrollDetail(this.detailHeight);
    else if (this.options.searchable) { this.input.handleInput(data); this.applyQuery(); }
    else return;
    this.requestRender();
  }
}

async function chooseTui(ctx: ExtensionContext, title: string, items: readonly MenuItem[], options: MenuOptions, msg: Translator): Promise<string | undefined> {
  return ctx.ui.custom<string | undefined>((tui, theme, _keybindings, done) =>
    new MenuComponent(ctx, tui, theme, title, items, options, msg, done), { overlay: true, overlayOptions: { width: '100%', maxHeight: '95%', anchor: 'center' } });
}

async function chooseRpc(ctx: ExtensionContext, title: string, items: readonly MenuItem[], options: MenuOptions, msg: Translator): Promise<string | undefined> {
  const safeItems = items.map(sanitizeItem);
  const cursor = options.cursor ?? {};
  let query = cursor.query ?? '';
  let page = Math.max(0, Math.floor(cursor.page ?? 0));
  // Internal controller combines the public signal with isCurrent() expiry so an in-flight dialog can be dismissed.
  const controller = new AbortController();
  const outer = options.signal;
  const onOuterAbort = () => controller.abort();
  if (outer) {
    if (outer.aborted) return undefined;
    outer.addEventListener('abort', onOuterAbort);
  }
  let poll: ReturnType<typeof setInterval> | undefined;
  if (options.isCurrent) {
    const isCurrent = options.isCurrent;
    poll = setInterval(() => { if (!isCurrent()) controller.abort(); }, EXPIRY_POLL_MS);
    (poll as { unref?: () => void }).unref?.();
  }
  const cleanup = () => {
    if (poll) clearInterval(poll);
    outer?.removeEventListener('abort', onOuterAbort);
  };
  const active = (): boolean => !controller.signal.aborted && outer?.aborted !== true && options.isCurrent?.() !== false;
  const dialogOptions = { signal: controller.signal };
  try {
    for (;;) {
      if (!active()) return undefined;
      const filtered = query ? safeItems.filter((item) => matchesQuery(item, query)) : safeItems;
      const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
      page = Math.min(page, pageCount - 1);
      const slice = filtered.slice(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE);
      const entries: { label: string; run: () => Step | Promise<Step> }[] = [];
      for (const item of slice) entries.push({
        label: item.disabledReason ? msg`${item.label}（不可用：${item.disabledReason}）` : listLabel(item),
        run: () => {
          if (item.disabledReason) { ctx.ui.notify(msg`${item.label} 不可用：${item.disabledReason}`, 'info'); return { done: false }; }
          cursor.selectedId = item.id;
          return { done: true, value: item.id };
        },
      });
      if (page > 0) entries.push({ label: msg('上一页'), run: () => { page -= 1; cursor.page = page; return { done: false }; } });
      if (page < pageCount - 1) entries.push({ label: msg('下一页'), run: () => { page += 1; cursor.page = page; return { done: false }; } });
      if (options.searchable) entries.push({
        label: msg('搜索…'),
        run: async () => {
          const next = await raceAbort(menuPrompt(ctx, msg('搜索：'), () => ctx.ui.input(msg('搜索：'), query || msg('筛选…'), dialogOptions)), controller.signal);
          if (!active()) return { done: true, value: undefined };
          if (next === undefined) return { done: false };
          query = next; cursor.query = next; page = 0; cursor.page = 0;
          return { done: false };
        },
      });
      for (const action of options.actions ?? []) {
        const label = listLabel(sanitizeItem(action));
        entries.push({
          label: action.disabledReason ? msg`${label}（不可用：${inline(action.disabledReason)}）` : label,
          run: () => {
            if (action.disabledReason) { ctx.ui.notify(msg`${label} 不可用：${inline(action.disabledReason)}`, 'info'); return { done: false }; }
            return { done: true, value: action.id };
          },
        });
      }
      entries.push({ label: msg('返回'), run: () => ({ done: true, value: undefined }) });
      if (!filtered.length) entries.unshift({ label: msg('无匹配项'), run: () => ({ done: false }) });
      const labels = uniquify(entries.map((entry) => inline(entry.label)));
      const details = typeof options.lines === 'function' ? (slice.find((item) => item.id === cursor.selectedId) ?? slice[0]) : undefined;
      const summary = typeof options.lines === 'function' ? details ? options.lines(details) : [] : options.lines ?? [];
      const heading = [title, msg`第 ${page + 1}/${pageCount} 页 · 共 ${filtered.length} 项`, ...summary.slice(0, 8).map(blockText)].join('\n');
      const picked = await raceAbort(menuPrompt(ctx, heading, () => ctx.ui.select(heading, labels, dialogOptions)), controller.signal);
      if (!active() || picked === undefined) return undefined;
      const index = labels.indexOf(picked);
      if (index < 0) continue;
      const step = await entries[index]!.run();
      if (!active()) return undefined;
      if (step.done) return step.value;
    }
  } finally {
    cleanup();
  }
}

/**
 * Show a searchable, paginated menu and resolve the chosen id. `undefined` means cancel or expiry.
 * Owns no workflow state: the caller keeps the draft in `options.cursor` and acts on the result.
 */
export async function choose(ctx: ExtensionContext, title: string, items: readonly MenuItem[], options: MenuOptions = {}): Promise<string | undefined> {
  const msg = options.msg ?? chinese;
  if (expired(options)) return undefined;
  const mode = ctx.mode as string | undefined;
  if (mode === 'json' || mode === 'print') return undefined;
  if (mode === 'tui') return chooseTui(ctx, inline(title), items, options, msg);
  if (mode === 'rpc' || ctx.hasUI === true) return chooseRpc(ctx, inline(title), items, options, msg);
  return undefined;
}

/** Show read-only text: a scrollable screen in the TUI, otherwise a plain notification. */
export async function readView(ctx: ExtensionContext, title: string, text: string, options: ReadViewOptions = {}): Promise<void> {
  const msg = options.msg ?? chinese;
  if (expired(options)) return;
  if ((ctx.mode as string | undefined) !== 'tui') {
    ctx.ui.notify(blockText(text), 'info');
    return;
  }
  await ctx.ui.custom<void>((tui, theme, _keybindings, done) => {
    const cleanup: (() => void)[] = [];
    let finished = false;
    const finish = (): void => {
      if (finished) return;
      finished = true;
      while (cleanup.length) cleanup.pop()!();
      done();
    };
    const { signal, isCurrent } = options;
    if (signal) {
      const onAbort = () => finish();
      signal.addEventListener('abort', onAbort);
      cleanup.push(() => signal.removeEventListener('abort', onAbort));
      if (signal.aborted) finish();
    }
    if (isCurrent) {
      const timer = setInterval(() => {
        if (!isCurrent()) { finish(); return; }
        tui.requestRender();
      }, EXPIRY_POLL_MS);
      (timer as { unref?: () => void }).unref?.();
      cleanup.push(() => clearInterval(timer));
    }
    const header = inline(title) || msg('暂无任务');
    const view = detailView(
      (width) => [truncateToWidth(theme.fg('accent', theme.bold(header)), width, '…'), ...blockText(text).split('\n').flatMap((line) => wrapTextWithAnsi(line, Math.max(1, width)))],
      () => tui.terminal.rows,
      () => tui.requestRender(),
      finish,
      theme,
      msg,
    );
    return {
      render: (width: number) => view.render(width).map((line) => truncateToWidth(line, width, '…', true)),
      invalidate: () => view.invalidate(),
      handleInput: (data: string) => view.handleInput?.(data),
      dispose: () => { while (cleanup.length) cleanup.pop()!(); },
    };
  }, { overlay: true, overlayOptions: { width: '100%', maxHeight: '95%', anchor: 'center' } });
}
