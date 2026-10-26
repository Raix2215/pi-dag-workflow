import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import { stripTerminalSequences, truncateToWidth, visibleWidth, Editor } from '@earendil-works/pi-tui';
import { chinese, type Translator } from '../i18n.ts';
import type { IconStyle } from './symbols.ts';
import { createPanel, filterPanelRows, type PanelInfo, type PanelMemory, type PanelPage, type PanelResult, type PanelRow, type PanelUpperSource, type PanelInput, middleTruncate, valueToneFor } from './panel.ts';

type MenuTone = 'accent' | 'success' | 'warning' | 'error' | 'muted';
export interface MenuItem { id: string; label: string; compactLabel?: string; value?: string; values?: readonly { text: string; tone?: NonNullable<PanelRow['valueTone']> }[]; description?: string; disabledReason?: string; tone?: MenuTone; valueTone?: MenuTone | 'dim'; kind?: NonNullable<PanelRow['kind']>; checked?: boolean; choices?: readonly string[]; input?: NonNullable<PanelRow['input']>; run?: (value: unknown) => unknown; destructive?: boolean; confirmation?: NonNullable<PanelRow['confirmation']>; path?: boolean; icon?: string; children?: readonly MenuItem[]; prefix?: string }
/** A builder is evaluated on each idle refresh; arrays retain snapshot semantics. */
type MenuSource = readonly MenuItem[] | (() => readonly MenuItem[]);
export interface PanelTab { id: string; label: string }
export interface PanelNavigation {
  register(open: (ctx: ExtensionContext) => Promise<void>): void;
  open(ctx: ExtensionContext, initial?: (ctx: ExtensionContext) => Promise<void>): Promise<void>;
  tabs(): readonly PanelTab[];
  memory(): Map<string, PanelMemory> | undefined;
  /** Live icon style: read on every render so a settings change applies immediately. */
  style?(): IconStyle;
  request(id: string): void;
  requested(): boolean;
  input(options: PanelDialogOptions): Promise<string | undefined>;
  edit(options: PanelDialogOptions): Promise<string | undefined>;
  confirm(options: PanelDialogOptions): Promise<boolean>;
}
export interface PanelDialogOptions extends PanelInput { ctx: ExtensionContext; isCurrent?: () => boolean; multiline?: boolean; msg?: Translator }
interface MenuPanelOptions { id: string; title?: string; section?: PanelTab; lines?: readonly string[]; /** Band entries, rebuilt per refresh when given as a function. */ info?: readonly PanelInfo[] | (() => readonly PanelInfo[]); tabs?: readonly PanelTab[]; onSwitch?: (id: string) => void; memory?: Map<string, PanelMemory>; upper?: PanelUpperSource; itemsZone?: 'upper' | 'lower'; iconStyle?: 'nerd-font' | 'plain' | (() => IconStyle); single?: boolean }
export function panelOptions(navigation: PanelNavigation | undefined, section: PanelTab, id: string, lines: readonly string[] = []): MenuPanelOptions {
  const memory = navigation?.memory();
  return { id, title: section.label, section, lines, single: true, ...(navigation ? { tabs: navigation.tabs(), onSwitch: navigation.request } : {}), ...(memory ? { memory } : {}), ...(navigation?.style ? { iconStyle: navigation.style } : {}) };
}
export interface MenuCursor { query?: string; selectedId?: string; page?: number; handled?: boolean; /** The panel went away mid-call: callers must stop looping, not retry. */ closed?: boolean; kind?: NonNullable<PanelRow['kind']>; value?: unknown }
interface MenuOptions {
  /** Short, explicitly selected state only. Complete requirements belong in readView. */
  lines?: readonly string[] | ((item: MenuItem) => readonly string[]);
  actions?: MenuSource; searchable?: boolean; cursor?: MenuCursor;
  /** Refresh external facts only while visibly waiting, never during editing or confirmation. */
  refreshInterval?: number;
  /** Text-client root menus can distinguish leaving the module from returning from an expanded group. */
  backLabel?: string;
  isCurrent?: () => boolean; signal?: AbortSignal; msg?: Translator; panel?: MenuPanelOptions;
}
interface ReadViewOptions { isCurrent?: () => boolean; signal?: AbortSignal; msg?: Translator; tone?: MenuTone; panel?: MenuPanelOptions }
interface DisplayScope { depth: number; changed: () => void }
const scopes = new WeakMap<object, DisplayScope>();
const promptOwners = new WeakMap<object, Map<string, number>>();
interface PanelRun { depth: number; memory: Map<string, PanelMemory>; mounted?: MountedPanel | undefined; native?: boolean }
interface MountedPanel {
  component: ReturnType<typeof createPanel>; closed: Promise<void>; repaint: (force?: boolean) => void; switchTo: ((id: string) => void) | undefined;
  /** The mounted component is gone: a later `wait` must never hang on it. */
  disposed: () => boolean;
  wait: (setup: () => void, signal: AbortSignal, force?: boolean) => Promise<PanelResult>; close: () => void;
  /** Re-render the current page with fresh rows; never touches the waiter or the input gate. */
  refresh(): void;
  /** Set per call: the page to re-render in place. */
  onRefresh: (() => void) | undefined;
}
const panelRuns = new WeakMap<object, PanelRun>();
/** Whether a live panel is still mounted for this context: the registry's staleness probe. */
export function panelAlive(ctx: ExtensionContext): boolean {
  const run = panelRuns.get(manager(ctx)), mounted = run?.mounted;
  return run?.native === true || Boolean(mounted) && !mounted!.disposed();
}
const manager = (ctx: ExtensionContext): object => ctx.sessionManager ?? ctx.ui;
/**
 * Close the mounted panel from inside a row action. A session switch must not happen under an open
 * panel: the component is unmounted (and its `wait` settled) before the caller swaps the session file.
 */
export async function closePanel(ctx: ExtensionContext): Promise<boolean> {
  const run = panelRuns.get(manager(ctx));
  const mounted = run?.mounted;
  if (!run || !mounted) return false;
  run.mounted = undefined;
  mounted.close();
  try { await mounted.closed; } catch { /* teardown never blocks the caller */ }
  return true;
}
/** A native reading screen keeps the registry occupied even though the plugin panel is unmounted. */
export async function withNativeScreen<T>(ctx: ExtensionContext, run: () => Promise<T>): Promise<T> {
  return withMenuScope(ctx, async () => {
    const owner = panelRuns.get(manager(ctx))!;
    await closePanel(ctx); owner.native = true;
    try { return await run(); } finally { owner.native = false; }
  });
}
export function bindMenuDisplay(ctx: ExtensionContext, changed: () => void): () => void {
  const key = manager(ctx), scope = { depth: 0, changed }; scopes.set(key, scope);
  return () => { if (scopes.get(key) === scope) scopes.delete(key); };
}
export const menuDisplayOpen = (ctx: ExtensionContext): boolean => (scopes.get(manager(ctx))?.depth ?? 0) > 0;
/** The whole command, including nested dialogs, temporarily withdraws only our summary. */
export async function withMenuScope<T>(ctx: ExtensionContext, run: () => Promise<T>): Promise<T> {
  const key = manager(ctx), scope = scopes.get(key);
  let panelRun = panelRuns.get(key);
  if (!panelRun) { panelRun = { depth: 0, memory: new Map() }; panelRuns.set(key, panelRun); }
  panelRun.depth++;
  if (scope) { scope.depth++; if (scope.depth === 1) scope.changed(); }
  try { return await run(); }
  finally {
    if (scope) { scope.depth--; if (!scope.depth && scopes.get(key) === scope) scope.changed(); }
    if (!--panelRun.depth) {
      // Detach before awaiting: a scope that starts during the teardown must mount its own panel
      // instead of inheriting (and being closed by) the one that is going away.
      const mounted = panelRun.mounted;
      panelRun.mounted = undefined;
      if (panelRuns.get(key) === panelRun) panelRuns.delete(key);
      mounted?.close();
      try { await mounted?.closed; } catch { /* teardown never blocks the caller */ }
    }
  }
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
function statusTone(value: string, msg: Translator = chinese): MenuTone {
  if ([msg('失败'), msg('已耗尽'), msg('状态受保护：是'), '状态损坏', msg('启动失败')].some(label => value.includes(label))) return 'error';
  if ([msg('等待回复'), msg('待交付'), '待核验', msg('等待重试'), msg('Plan 只读'), msg('暂停')].some(label => value.includes(label))) return 'warning';
  if ([msg('已完成'), msg('已关闭'), msg('已取消'), msg('关闭')].some(label => value.includes(label))) return 'muted';
  if ([msg('运行中'), msg('进行中'), msg('活动'), msg('启动中'), msg('开启')].some(label => value.includes(label))) return 'accent';
  if (['已验证', '核验通过'].some(label => value.includes(label))) return 'success';
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

async function nativeSelect(ctx: ExtensionContext, title: string, options: string[], signal: AbortSignal): Promise<string | undefined> {
  if (signal.aborted || ctx.mode === 'tui') return undefined;
  return menuPrompt(ctx, title, () => ctx.ui.select(title, options, { signal }));
}

function mountPanel(ctx: ExtensionContext, page: PanelPage, run: PanelRun, msg: Translator, iconStyle?: 'nerd-font' | 'plain' | (() => IconStyle)): MountedPanel {
  let resolve: ((result: PanelResult) => void) | undefined, reject: ((cause: unknown) => void) | undefined;
  let finish = () => {}, repaint = (_force?: boolean) => {}, hidden = true, activeTheme = ctx.ui.theme;
  let refreshPage: (() => void) | undefined;
  let editorFactory: () => Editor;
  const component = createPanel({ ...page, terminalRows: dimensions(ctx).rows, memory: run.memory, msg, ...(iconStyle ? { iconStyle } : {}),
    theme: { style: (value, options) => activeTheme.style(value, options), fg: (color, value) => activeTheme.fg ? activeTheme.fg(color, value) : activeTheme.style(value, { fg: color }), ...(activeTheme.underline ? { underline: (value: string) => activeTheme.underline(value) } : {}) },
    createEditor: () => editorFactory(),
    onResult(result) { hidden = true; resolve?.(result); resolve = undefined; reject = undefined; },
  });
  let disposed = false;
  const closed = ctx.ui.custom<void>((tui, theme, _keys, done) => {
    activeTheme = theme; finish = () => done(); repaint = (force = false) => tui.requestRender(force);
    const dim = (text: string) => theme.style(text, { fg: 'dim' });
    editorFactory = () => new Editor(tui, { borderColor: dim, selectList: { selectedPrefix: text => theme.style(text, { fg: 'accent' }), selectedText: text => theme.style(text, { fg: 'accent' }), description: dim, scrollInfo: dim, noMatch: dim } }, { paddingX: 0 });
    return {
      get focused() { return component.focused; }, set focused(value: boolean) { component.focused = value; },
      render(width) { component.resize(tui.terminal.rows); return component.render(width); },
      handleInput(data) { if (!hidden) component.handleInput(data); },
      invalidate() { component.invalidate(); },
    };
    // Inline mounting: no options, so the component replaces the editor and Pi restores it on close.
  }).catch(cause => { reject?.(cause); }).finally(() => { disposed = true; });
  const api: MountedPanel = {
    component, closed, repaint: force => repaint(force), switchTo: undefined, disposed: () => disposed,
    wait(setup, signal, force = true) {
      resolve?.({ action: 'stale' });
      return new Promise<PanelResult>((accept, fail) => {
        // A closed component can never answer, so the waiter settles instead of hanging the caller.
        const abandon = () => { resolve = undefined; reject = undefined; accept({ action: 'closed' }); };
        const abort = () => { hidden = true; component.cancelInput(); signal.removeEventListener('abort', abort); abandon(); };
        resolve = result => { signal.removeEventListener('abort', abort); accept(result); };
        reject = cause => { signal.removeEventListener('abort', abort); fail(cause); };
        signal.addEventListener('abort', abort, { once: true });
        if (disposed) { abandon(); return; }
        void closed.then(() => { if (resolve) { signal.removeEventListener('abort', abort); abandon(); } });
        setup(); hidden = false; repaint(force);
        if (signal.aborted) abort();
      });
    },
    // A refresh re-renders in place: the waiter, the input gate and the cursor are untouched, so a key
    // pressed at the same moment can never be lost or replayed.
    refresh: () => { if (!hidden && component.canRefresh()) { api.onRefresh?.(); repaint(false); } },
    get onRefresh() { return refreshPage; }, set onRefresh(value) { refreshPage = value; },
    close() { resolve?.({ action: 'closed' }); resolve = undefined; finish(); repaint(true); },
  };
  return api;
}
export function panelRow(item: MenuItem): PanelRow {
  const { children, ...row } = item;
  return { ...row, kind: row.kind ?? 'action', ...(children ? { children: children.map(panelRow) } : {}) };
}
async function panelChoose(ctx: ExtensionContext, title: string, source: MenuSource, options: MenuOptions): Promise<string | undefined> {
  /** Rows are read per build so an in-place refresh can reflect current data. */
  const items = () => typeof source === 'function' ? source() : source;
  const panel = options.panel!, msg = options.msg ?? chinese, cursor = options.cursor;
  // A flag from a previous call belongs to that call: never let it steer this one.
  if (cursor) { delete cursor.handled; delete cursor.closed; }
  const settled = (value: string | undefined, closed: boolean) => {
    // A row that ran keeps `handled` so the module redraws; a panel that went away never leaves one.
    if (!cursor) return value;
    if (closed) { delete cursor.handled; cursor.closed = true; }
    return value;
  };
  const value = await withMenuScope(ctx, () => guarded(options, async signal => {
    const run = panelRuns.get(manager(ctx))!, section = panel.section ?? { id: panel.id, label: panel.title ?? title };
    if (panel.memory) run.memory = panel.memory;
    const buildPage = (): PanelPage => {
      const rowsNow = items(), actions = typeof options.actions === 'function' ? options.actions() : options.actions ?? [];
      const upperItems = panel.itemsZone === 'upper' ? rowsNow : [];
      // Command rows are marked so a search narrows the list without hiding the actions themselves.
      const rows: PanelRow[] = [...panel.itemsZone === 'upper' ? [] : rowsNow, ...actions.map(item => ({ ...item, kind: item.kind ?? 'action' as const, keepOnSearch: true }))].map(item => ({ ...panelRow(item), valueTone: item.valueTone && item.valueTone !== 'dim' ? item.valueTone : item.value ? valueToneFor(item.value) : 'dim' }));
      const lines = panel.lines?.length ? panel.lines : typeof options.lines === 'function' ? rowsNow.length ? options.lines(rowsNow.find(item => item.id === options.cursor?.selectedId) ?? rowsNow[0]!) : [] : options.lines ?? [];
      const upper: PanelUpperSource | undefined = panel.upper ?? (upperItems.length ? (width, query) => ({ rows: filterPanelRows(upperItems.map(panelRow), query).map(item => {
        const text = block(item.label).join(' '), budget = Math.max(0, width - (item.value ? visibleWidth(item.value) + 6 : 0));
        const label = item.path ? middleTruncate(text, budget) : truncateToWidth(text, budget, '…');
        const valueTone = item.valueTone && item.valueTone !== 'dim' ? item.valueTone : item.value ? valueToneFor(item.value) : 'dim';
        const { value, ...rest } = item;
        const values = item.values?.length ? item.values : value ? [{ text: clean(value), tone: valueTone }] : undefined;
        return { ...rest, label, ...(values ? { values } : {}), tone: item.tone ?? 'text', valueTone };
      }) }) : undefined);
      return { id: panel.id, title, activeId: section.id, sections: (panel.tabs ?? [section]).map(tab => ({ ...tab, rows: tab.id === section.id ? rows : [], ...(tab.id === section.id ? { lines, single: panel.single ?? !upper, ...(panel.info ? { info: typeof panel.info === 'function' ? panel.info() : panel.info } : {}), ...(upper ? { upper } : {}) } : {}), searchable: options.searchable !== false })) };
    };
    const page = buildPage();
    const memoryKey = `${page.id}/${section.id}`;
    if (!run.memory.has(memoryKey) && options.cursor) run.memory.set(memoryKey, { index: 0, query: options.cursor.query ?? '', searching: Boolean(options.cursor.query), ...(options.cursor.selectedId ? { selectedId: options.cursor.selectedId } : {}) });
    // A panel that already closed must not be reused: its `wait` would never resolve.
    if (run.mounted?.disposed()) run.mounted = undefined;
    const mounted = run.mounted ??= mountPanel(ctx, page, run, msg, panel.iconStyle);
    mounted.switchTo = panel.onSwitch;
    // Refresh rebuilds this page in place: no second choose call, no waiter hand-off, no lost key.
    mounted.onRefresh = () => {
      if (!current(options) || signal.aborted) return;
      try { mounted.component.setPage(buildPage()); }
      catch { /* Keep the last page while the runtime is protected or being replaced. */ }
    };
    const timer = options.refreshInterval ? setInterval(() => mounted.refresh(), options.refreshInterval) : undefined;
    timer?.unref?.();
    let result: PanelResult;
    try { result = await mounted.wait(() => mounted.component.setPage(page), signal); }
    finally { if (timer) clearInterval(timer); }
    // A disposed component answers `closed`; anything else here means the caller moved on.
    const gone = result.action === 'closed' || result.action === 'stale';
    if (!current(options) || signal.aborted) return CLOSED;
    if (gone) return CLOSED;
    const memory = run.memory.get(memoryKey);
    if (options.cursor && memory) {
      delete options.cursor.handled;
      options.cursor.query = memory.query;
      if (memory.selectedId) options.cursor.selectedId = memory.selectedId; else delete options.cursor.selectedId;
    }
    if (result.action === 'switch' && result.id) mounted.switchTo?.(result.id);
    if (result.action === 'selected' && result.id) {
      if (options.cursor && result.kind) { options.cursor.kind = result.kind; options.cursor.value = result.payload; }
      const row = mounted.component.row(result.id, result.kind);
      if (row?.run) {
        try { await row.run(result.payload); }
        catch (cause) { ctx.ui.notify(cause instanceof Error ? cause.message : String(cause), 'error'); }
        if (options.cursor) options.cursor.handled = true;
      }
    }
    return result.action === 'selected' ? result.id : undefined;
  }));
  // `guarded` may win its abort race without ever entering the callback, so decide here too:
  // a caller that went stale is as closed as a component that was disposed.
  const closed = value === CLOSED || !current(options);
  return settled(value === CLOSED ? undefined : value, closed);
}

/** Internal marker: the panel component is gone, so the caller must stop looping instead of retrying. */
const CLOSED = Symbol('panel-closed');
/** Non-TUI clients retain Pi's native selector. */
export async function choose(ctx: ExtensionContext, title: string, items: MenuSource, options: MenuOptions = {}): Promise<string | undefined> {
  const rowsNow = () => typeof items === 'function' ? items() : items;
  if (!available(ctx) || !current(options)) return undefined;
  if (ctx.mode === 'tui') return panelChoose(ctx, title, items, { ...options, panel: options.panel ?? { id: title, title } });
  const msg = options.msg ?? chinese, cursor = options.cursor ?? {};
  delete cursor.handled; delete cursor.closed;
  const listed = rowsNow(), extraActions = typeof options.actions === 'function' ? options.actions() : options.actions ?? [];
  const projected = !listed.length ? options.panel?.upper?.(dimensions(ctx).width, '').rows ?? [] : [];
  const source = listed.length ? listed : projected as readonly MenuItem[];
  const safe = source.map(item => ({ ...item, label: clean(item.label), value: clean(item.value ?? ''), description: clean(item.description ?? '') }));
  return withMenuScope(ctx, () => guarded(options, async signal => {
    let query = cursor.query ?? '', page = Math.max(0, cursor.page ?? 0);
    let keepOpen = false;
    const confirmItem = async (item: MenuItem): Promise<boolean> => {
      if (!current(options) || signal.aborted) return false;
      return !item.destructive || await menuPrompt(ctx, item.label, () => ctx.ui.confirm(item.confirmation?.title ?? item.label, item.confirmation?.consequences ?? item.description ?? '', { signal }));
    };
    const pickItem = async (item: MenuItem): Promise<string | undefined> => {
      if (item.disabledReason || item.kind === 'readonly' || item.kind === 'heading' || item.kind === 'tail') return undefined;
      cursor.selectedId = item.id;
      if (item.children?.length) return choose(ctx, item.label, item.children, { ...options, actions: [], cursor, backLabel: msg('返回') });
      if (!item.run) {
        if (!await confirmItem(item)) { keepOpen = true; return undefined; }
        return current(options) && !signal.aborted ? item.id : undefined;
      }
      let value: unknown;
      if (item.kind === 'input' && item.input) {
        let draft = item.input.value ?? '';
        for (;;) {
          const entered = await menuPrompt(ctx, item.input.title, () => ctx.ui.editor(item.input!.title, draft));
          if (!current(options)) return undefined;
          if (entered === undefined) { keepOpen = true; return undefined; }
          draft = entered; const error = item.input.validate?.(entered);
          if (error) { ctx.ui.notify(error, 'error'); continue; }
          value = entered; break;
        }
      } else if (item.kind === 'toggle') value = !item.checked;
      else if (item.kind === 'cycle' && item.choices?.length) value = item.choices[(item.choices.indexOf(item.value ?? '') + 1) % item.choices.length];
      if (!await confirmItem(item)) { keepOpen = true; return undefined; }
      if (!current(options)) return undefined;
      await item.run(value); cursor.handled = true; cursor.value = value;
      return item.id;
    };
    for (;;) {
      if (!current(options) || signal.aborted) return undefined;
      const actions = safe.filter(item => item.kind !== 'readonly' && item.kind !== 'heading' && item.kind !== 'tail');
      const filtered = query ? actions.filter(item => [item.label, item.value, item.description, item.id].some(text => text.toLowerCase().includes(query.toLowerCase()))) : actions;
      const { width } = dimensions(ctx);
      const contextLines = typeof options.lines === 'function' && !options.searchable && safe[0] ? options.lines(safe[0]) : Array.isArray(options.lines) ? options.lines : [];
      const summary = [...safe.filter(item => item.kind === 'readonly').map(item => `${item.label}: ${item.value || item.description}`), ...contextLines];
      const alerts = summary.filter(line => /^(?:状态|阶段|错误|最近错误|说明|报告交付|Status|Recovery|Error|Last error|Note|Report)[:：]/.test(line) || /^(?:Task #\d+ (?:验收|acceptance))[:：]/.test(line));
      const short = [...alerts, ...summary.filter(line => !alerts.includes(line))].slice(0, 3).map(line => truncateToWidth(clean(line), width, '…'));
      const size = PAGE_SIZE;
      const pages = Math.max(1, Math.ceil(filtered.length / size)); page = Math.min(page, pages - 1);
      const entries: { label: string; tone?: MenuTone; valueTone?: MenuTone | 'dim'; pick: () => Promise<string | undefined> | string | undefined; done: boolean }[] = [];
      for (const item of filtered.slice(page * size, page * size + size)) {
        const id = /^(#\d+|a\d+)\s/.exec(item.label)?.[1];
        const prefix = id ? `${id} [${item.value}] ` : '', suffix = !id && item.value ? `  ${item.value}` : '';
        const room = Math.max(1, width - visibleWidth(prefix || suffix));
        const text = prefix ? item.label.slice(id!.length).trim() : item.label;
        const shown = item.path ? middleTruncate(text, room) : truncateToWidth(text, room, '…');
        const label = prefix ? prefix + shown : shown + suffix;
        entries.push({ label: item.disabledReason ? msg`${label}（不可用：${clean(item.disabledReason)}）` : label, tone: item.disabledReason ? 'muted' : item.tone ?? statusTone(item.value, msg), ...(item.valueTone ? { valueTone: item.valueTone } : {}), done: !item.disabledReason && !item.children?.length && item.kind !== 'readonly' && item.kind !== 'heading' && item.kind !== 'tail', pick: () => pickItem(item) });
      }
      if (page > 0) entries.push({ label: msg('上一页'), done: false, pick: () => { page--; cursor.page = page; return undefined; } });
      if (page < pages - 1) entries.push({ label: msg('下一页'), done: false, pick: () => { page++; cursor.page = page; return undefined; } });
      if (options.searchable) entries.push({ label: msg('搜索'), done: false, pick: async () => { const next = await panelInput({ ctx, title: msg('搜索：'), value: query || msg('筛选'), isCurrent: () => current(options) && !signal.aborted }); if (next !== undefined && current(options)) { query = next; cursor.query = next; page = 0; cursor.page = 0; } return undefined; } });
      for (const action of extraActions) entries.push({ label: clean(action.label) + (action.value ? `  ${clean(action.value)}` : '') + (action.disabledReason ? msg`（不可用：${clean(action.disabledReason)}）` : ''), ...(action.disabledReason ? { tone: 'muted' as const } : action.tone ? { tone: action.tone } : {}), ...(action.valueTone ? { valueTone: action.valueTone } : {}), done: !action.disabledReason && !action.children?.length, pick: () => pickItem(action) });
      entries.push({ label: options.backLabel ?? msg('返回'), done: true, pick: () => undefined });
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
      if (!current(options) || signal.aborted || picked === undefined) return undefined;
      const index = labels.indexOf(picked); if (index < 0) continue;
      const entry = entries[index]!; keepOpen = false;
      let value: string | undefined;
      try { value = await entry.pick(); }
      catch (cause) { ctx.ui.notify(cause instanceof Error ? cause.message : String(cause), 'error'); keepOpen = true; }
      if (!current(options) || signal.aborted) return undefined;
      if (entry.done && !keepOpen || value !== undefined) return value;
    }
  }));
}

function ensurePanel(ctx: ExtensionContext, options: ReadViewOptions, title: string): MountedPanel {
  const run = panelRuns.get(manager(ctx))!, panel = options.panel ?? { id: title, title }, section = panel.section ?? { id: panel.id, label: panel.title ?? title };
  if (panel.memory) run.memory = panel.memory;
  if (run.mounted?.disposed()) run.mounted = undefined;
  if (!run.mounted) {
    const page: PanelPage = { id: panel.id, title: panel.title ?? title, activeId: section.id, sections: (panel.tabs ?? [section]).map(tab => ({ ...tab, rows: tab.id === section.id ? [{ id: '$dialog', label: title, kind: 'action' }] : [], ...(tab.id === section.id ? { lines: panel.lines ?? [], single: panel.single ?? true, ...(panel.upper ? { upper: panel.upper } : {}) } : {}) })) };
    run.mounted = mountPanel(ctx, page, run, options.msg ?? chinese, panel.iconStyle);
    run.mounted.switchTo = panel.onSwitch;
  }
  return run.mounted;
}
async function nativeDialog(options: PanelDialogOptions, kind: 'input' | 'editor' | 'confirm'): Promise<string | boolean | undefined> {
  const { ctx, title } = options;
  if (ctx.mode === 'tui' || !current(options)) return undefined;
  try {
    const result = await menuPrompt<string | boolean | undefined>(ctx, title, () => ctx.ui[kind](title, options.value ?? ''));
    return current(options) ? result : undefined;
  } finally {
    // The runtime may have been replaced while the dialog was open: a stale ctx cannot be read.
    try { panelRuns.get(manager(ctx))?.mounted?.repaint(true); } catch { /* replaced runtime */ }
  }
}
async function inlineDialog(options: PanelDialogOptions, kind: 'input' | 'edit' | 'confirm'): Promise<string | boolean | undefined> {
  if (!current(options)) return undefined;
  if (options.ctx.mode !== 'tui') return nativeDialog(options, kind === 'edit' ? 'editor' : kind);
  return withMenuScope(options.ctx, () => guarded(options, async signal => {
    const mounted = ensurePanel(options.ctx, options, options.title);
    const result = await mounted.wait(() => {
      if (kind === 'confirm') mounted.component.confirm(options.title, options.value ?? '');
      else mounted.component[kind === 'edit' && options.multiline === false ? 'input' : kind](options);
    }, signal);
    if (!current(options) || signal.aborted) return undefined;
    return result.action === 'selected' ? result.payload as string | boolean : undefined;
  }));
}
export async function panelInput(options: PanelDialogOptions): Promise<string | undefined> { return await inlineDialog(options, 'input') as string | undefined; }
export async function panelEdit(options: PanelDialogOptions): Promise<string | undefined> { return await inlineDialog(options, 'edit') as string | undefined; }
export async function panelConfirm(options: PanelDialogOptions): Promise<boolean> { return await inlineDialog(options, 'confirm') === true; }

export async function readView(ctx: ExtensionContext, title: string, text: string, options: ReadViewOptions = {}): Promise<void> {
  if (!current(options)) return;
  if (!ctx.hasUI || ctx.mode !== 'tui') { ctx.ui.notify(block(text).join('\n'), 'info'); return; }
  await withMenuScope(ctx, () => guarded(options, async signal => {
    const mounted = ensurePanel(ctx, options, title);
    const result = await mounted.wait(() => mounted.component.read(title, block(text)), signal);
    if (!current(options) || signal.aborted) return;
    if (result.action === 'switch' && result.id) mounted.switchTo?.(result.id);
  }));
}
