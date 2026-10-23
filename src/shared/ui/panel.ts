import type { Theme } from '@earendil-works/pi-coding-agent';
import { Input, matchesKey, sliceByColumn, stripTerminalSequences, truncateToWidth, visibleWidth, wrapTextWithAnsi, CURSOR_MARKER, type Editor } from '@earendil-works/pi-tui';
import { chinese, type Translator } from '../i18n.ts';
import { glyph, kindGlyph, rowGlyph, tabGlyph, PRIVATE_USE, PRIVATE_USE_ALL, ROW_SYMBOLS, type IconStyle } from './symbols.ts';

export type PanelTone = 'accent' | 'success' | 'warning' | 'error' | 'muted' | 'dim' | 'text';
const interactiveKinds = ['entity', 'toggle', 'cycle', 'input', 'directory', 'action', 'readonly'] as const;
export type PanelKind = typeof interactiveKinds[number];
export interface PanelConfirmation { title: string; consequences: string; action: string }
export interface PanelRow {
  id: string; label: string; text?: string; compactLabel?: string; value?: string; values?: readonly { text: string; tone?: PanelTone }[]; description?: string; disabledReason?: string;
  tone?: PanelTone; valueTone?: PanelTone; kind: PanelKind | 'heading' | 'tail'; checked?: boolean; choices?: readonly string[]; input?: PanelInput & { multiline?: boolean };
  destructive?: boolean; confirmation?: PanelConfirmation; path?: boolean; payload?: unknown; run?: (value: unknown) => unknown; icon?: string; children?: readonly PanelRow[]; prefix?: string; parentId?: string;
  /** A band row above the upper list: readonly context that keeps its own value tone and no icon. */
  band?: boolean;
  /** A command row rather than data: a search narrows the list but never hides the actions. */
  keepOnSearch?: boolean;
  /** A group heading: Enter/l expands, h collapses, and a non-empty group starts expanded. */
  collapsible?: boolean; groupCount?: number;
}
export interface PanelInfo { label: string; value: string; line: 0 | 1; tone?: PanelTone }
export interface PanelUpper { title?: string; rows: readonly PanelRow[]; info?: readonly PanelInfo[] }
export type PanelUpperSource = (width: number, query: string) => PanelUpper;
export interface PanelSection { id: string; label: string; rows: readonly PanelRow[]; upper?: PanelUpperSource; lines?: readonly string[]; info?: readonly PanelInfo[]; searchable?: boolean; single?: boolean }
export interface PanelPage { id: string; title: string; sections: readonly PanelSection[]; activeId?: string }
interface ZoneMemory { selectedId?: string; index: number; start?: number; query: string; searching: boolean; returnId?: string; returnIndex?: number }
export interface PanelMemory extends ZoneMemory { zone?: 'upper' | 'lower'; upper?: ZoneMemory; expandedId?: string; expandedZone?: 'upper' | 'lower'; /** The child entity expanded inline inside the expanded one; a second level, never a page swap. */ nestedId?: string; /** Open entity ancestry, including deeper inline menus. */ expandedPath?: string[]; /** Explicit group fold state: true = collapsed. */ groups?: Record<string, boolean> }
export interface PanelResult { action: 'selected' | 'back' | 'closed' | 'stale' | 'switch'; id?: string; payload?: unknown; kind?: PanelKind }
export interface PanelSymbols { Todos: string; Plan: string; Goal: string; Agents: string; Retry: string; Display: string; previous: string; next: string }
export interface PanelInput { title: string; value?: string; /** Return an actionable reason to stay in the editor instead of submitting. */ validate?: (value: string) => string | undefined }
export interface PanelConfig extends PanelPage {
  terminalRows: number; theme?: Pick<Theme, 'style'> & Partial<Pick<Theme, 'fg' | 'underline'>>; msg?: Translator; iconStyle?: 'nerd-font' | 'plain' | (() => IconStyle);
  symbols?: Partial<PanelSymbols>; memory?: Map<string, PanelMemory>; onResult?: (result: PanelResult) => void;
  createEditor?: () => Editor;
}
const clean = (value: string) => stripTerminalSequences(value).replace(/[\p{Cc}\p{Bidi_Control}]/gu, ' ');
/** Keep matching descendants together with their ancestry; menus remain searchable after grouping. */
export function filterPanelRows(source: readonly PanelRow[], query: string): PanelRow[] {
  if (!query) return [...source];
  const needle = query.toLowerCase();
  return source.flatMap(row => {
    if ([row.id, row.label, row.value, row.description].some(value => value?.toLowerCase().includes(needle))) return [row];
    const children = row.children ? filterPanelRows(row.children, query) : [];
    // Commands stay reachable while a query narrows the data; only their own children are filtered.
    if (children.length) return [{ ...row, children }];
    return row.keepOnSearch ? [row] : [];
  });
}
export const canDock = (row: PanelRow): boolean => !row.disabledReason && (interactiveKinds.some(kind => kind === row.kind) || row.kind === 'heading' && row.collapsible === true);
export const canExecute = (row: PanelRow): boolean => canDock(row) && row.kind !== 'readonly';
export function dock(rows: readonly PanelRow[], index: number, direction: 1 | -1): number {
  const start = Math.max(0, Math.min(index, rows.length - 1));
  for (let at = start; at >= 0 && at < rows.length; at += direction) if (canDock(rows[at]!)) return at;
  for (let at = start - direction; at >= 0 && at < rows.length; at -= direction) if (canDock(rows[at]!)) return at;
  return -1;
}
export function middleTruncate(value: string, width: number): string {
  if (visibleWidth(value) <= width) return value;
  if (width <= 1) return width > 0 ? '…' : '';
  const tail = Math.ceil((width - 1) * 0.7), head = width - 1 - tail;
  return sliceByColumn(value, 0, head) + '…' + sliceByColumn(value, visibleWidth(value) - tail, tail);
}
export function panelKeys(width: number, executable: boolean, sections: number, twoZones: boolean, msg: Translator = chinese, icons?: { previous: string; next: string }): string {
  const pieces = [msg('j/k 移动'), msg('h/l 层级'), ...(twoZones ? [msg('g/G 跳区')] : []), (icons ? `${icons.previous} ${msg('←/→ 快滚')} ${icons.next}` : msg('←/→ 快滚')), ...(executable ? [msg('Enter 操作')] : []), msg('/ 搜索'), ...(sections > 1 ? [msg('Tab 换模块')] : []), msg('Esc 返回')];
  if (visibleWidth(pieces.join(' · ')) <= width) return pieces.join(' · ');
  const compact = ['j/k', 'h/l', ...(twoZones ? ['g/G'] : []), '←/→', ...(executable ? ['Enter'] : []), '/', ...(sections > 1 ? ['Tab'] : []), 'Esc'];
  for (const optional of ['Tab', '/', 'j/k', '←/→', 'g/G', 'h/l', 'Enter']) {
    if (visibleWidth(compact.join(' · ')) <= width) break;
    const at = compact.indexOf(optional); if (at >= 0) compact.splice(at, 1);
  }
  return compact.join(' · ');
}

const iconStyleOf = (config: PanelConfig): IconStyle => (typeof config.iconStyle === 'function' ? config.iconStyle() : config.iconStyle) === 'plain' ? 'plain' : 'nerd-font';
/** The smallest label prefix worth showing; a marker never takes space from it. */
export const READABLE_LABEL = 4;
/**
 * The single column-allocation rule for every row shape (plain value, `values[]`, expanded child):
 * the label keeps its readable prefix first, then the value takes the rest (middle-truncated by the
 * caller), and a marker only survives when that prefix still fits beside it.
 */
export function fitRow(labelWidth: number, valueWidth: number, markerWidth: number, capacity: number) {
  const gap = (left: number, right: number) => left > 0 && right > 0 ? 1 : 0;
  const marker = markerWidth > 0 && capacity - markerWidth >= Math.min(labelWidth, READABLE_LABEL) ? markerWidth : 0;
  const label = Math.min(labelWidth, Math.max(0, capacity - marker));
  const value = Math.min(valueWidth, Math.max(0, capacity - label - marker - gap(label, 1)));
  return { label, value, marker };
}
export function dottedColumns(label: string, value: string, width: number) {
  const capacity = Math.max(0, width - 3), fitted = fitRow(visibleWidth(label), visibleWidth(value), 0, capacity);
  const right = middleTruncate(value, fitted.value);
  const left = truncateToWidth(label, Math.max(0, capacity - visibleWidth(right)), '…');
  return { left, leader: '.'.repeat(Math.max(0, width - visibleWidth(left) - visibleWidth(right) - 2)), right };
}
/** Decorative states (running, done, waiting, failed) map to semantic tones; plain text stays muted. */
export function valueToneFor(text: string): Exclude<PanelTone, 'text'> {
  if (/失败|已耗尽|不可用|Failed/i.test(text)) return 'error';
  if (/等待|暂停|待恢复|待交付|只读|待执行|待核验|重试|中断|Waiting|Paused|Read-only|Pending|Interrupted/i.test(text)) return 'warning';
  if (/错误|Error/i.test(text)) return 'error';
  if (/已完成|完成|通过|成功|已交付|已返回|Completed|Delivered|Passed/i.test(text)) return 'success';
  if (/关闭|已关闭|Off\b|Disabled/i.test(text)) return 'dim';
  if (/运行中|进行中|活动|开启|已启用|可进入|Enabled|Running|Active|On\b/i.test(text)) return 'accent';
  if (/^\s*\d+(?:\s|$)/.test(text)) return 'dim';
  return 'muted';
}
/** Keep the tail when a breadcrumb or path does not fit, prefixing the ellipsis. */
export function headTruncate(value: string, width: number): string {
  if (visibleWidth(value) <= width) return value;
  if (width <= 1) return width > 0 ? '…' : '';
  return '…' + sliceByColumn(value, Math.max(0, visibleWidth(value) - (width - 1)), width - 1);
}
export function createPanel(config: PanelConfig) {
  const msg = config.msg ?? chinese, memory = config.memory ?? new Map<string, PanelMemory>();
  let page: PanelPage = config, activeId = config.activeId ?? config.sections[0]!.id, terminalRows = config.terminalRows, width = 80;
  let switching = false, focused = false, armed: string | undefined, armedPrompt: PanelConfirmation | undefined;
  let reading: { title: string; lines: readonly string[]; offset: number; layout?: { width: number; lines: { text: string; paragraph: number; column: number }[] } } | undefined;
  let editing: { control: Input | Editor; title: string; multiline: boolean; search: boolean; id?: string; validate?: (value: string) => string | undefined; error?: string } | undefined;
  let confirmation: { title: string; consequences: string } | undefined;
  const stack: { page: PanelPage; activeId: string; local: boolean }[] = [];
  const section = () => page.sections.find(item => item.id === activeId)!;
  const key = () => `${page.id}/${activeId}`;
  const state = (): PanelMemory => {
    let value = memory.get(key());
    if (!value) { value = { index: 0, query: '', searching: false }; memory.set(key(), value); }
    return value;
  };
  const expansion = (): string[] => state().expandedPath ?? [state().expandedId, state().nestedId].filter((id): id is string => id !== undefined);
  const setExpansion = (path: string[]) => {
    state().expandedPath = path;
    if (path[0]) state().expandedId = path[0]; else { delete state().expandedId; delete state().expandedZone; }
    if (path[1]) state().nestedId = path[1]; else delete state().nestedId;
  };
  const zoneState = (zone: 'upper' | 'lower'): ZoneMemory => zone === 'lower' ? state() : state().upper ??= { index: 0, query: '', searching: false };
  const zone = () => state().zone ?? 'lower';
  // Nerd Font keeps Plane-15 icons; plain mode may not carry private-use codepoints at all.
  const safe = (value: string) => value.replace(iconStyleOf(config) === 'plain' ? PRIVATE_USE_ALL : PRIVATE_USE, '');
  const styled = (value: string, fg: PanelTone, bold = false) => config.theme ? config.theme.style(value, { fg, bold }) : value;
  /** Editing rows borrow the accent (or error for destructive rows) and underline the input area. */
  const editingTone = (row: PanelRow): PanelTone => row.destructive ? 'error' : 'accent';
  const underlined = (value: string) => config.theme?.underline ? config.theme.underline(value) : value;
  const fit = (value: string, columns: number) => truncateToWidth(safe(value), Math.max(0, columns), '…');
  const pad = (value: string) => value + ' '.repeat(Math.max(0, width - visibleWidth(value)));
  let upperFrame: { section: PanelSection; width: number; query: string; value: PanelUpper } | undefined;
  const upper = (): PanelUpper => {
    const current = section(), query = zoneState('upper').searching ? zoneState('upper').query : '';
    if (upperFrame?.section === current && upperFrame.width === width && upperFrame.query === query) return upperFrame.value;
    const projected = current.upper?.(Math.max(0, contentWidth() - 2), query) ?? { rows: (current.lines ?? []).flatMap((line, index) => wrapTextWithAnsi(line, Math.max(1, contentWidth() - 2)).map((text, part) => ({ id: `info:${index}:${part}`, label: clean(text), text: safe(text), kind: 'readonly' as const }))) };
    const value = current.info ? { ...projected, info: current.info } : projected;
    upperFrame = { section: current, width, query, value }; return value;
  };
  // A band is content of the upper zone even without a row source: otherwise the status line would appear
  // and disappear as the list fills up.
  const dual = () => section().single !== true && !!(section().upper || section().lines?.length || section().info?.length);
  /** Sub-screens indent every content row by `│ ` per stack level, so their usable width shrinks. */
  const contentWidth = () => Math.max(1, width - 2 * stack.length);
  const contentIndent = () => stack.length ? styled('│ '.repeat(stack.length), 'dim') : '';
  const contentRow = (line: string, marker?: string) => {
    const safeWidth = contentWidth();
    if (marker) {
      const visible = truncateToWidth(line, safeWidth - 1, '…');
      const body = visible + ' '.repeat(Math.max(0, safeWidth - 1 - visibleWidth(visible))) + styled(marker, 'dim');
      return contentIndent() + body;
    }
    const body = truncateToWidth(line, safeWidth, '…');
    return contentIndent() + body + ' '.repeat(Math.max(0, safeWidth - visibleWidth(body)));
  };
  const bracketedValue = (parts: readonly { text: string; tone?: PanelTone }[], rowTone?: PanelTone, forceTone?: PanelTone): string => parts.map(part => styled('[', 'dim') + styled(safe(part.text), forceTone ?? (part.tone && part.tone !== 'dim' ? part.tone : rowTone && rowTone !== 'dim' ? rowTone : valueToneFor(part.text))) + styled(']', 'dim')).join(' ');
  const valuesOf = (row: PanelRow): readonly { text: string; tone?: PanelTone }[] => row.values?.length ? row.values : row.value ? row.value.split(' · ').map(text => ({ text, tone: row.valueTone && row.valueTone !== 'dim' ? row.valueTone : valueToneFor(text) })) : [];
  const rows = (which: 'upper' | 'lower'): readonly PanelRow[] => {
    const saved = zoneState(which);
    let source = which === 'upper' ? dual() ? [...infoRows(), ...upper().rows] : [] : dual() ? section().rows : [...section().upper ? upper().rows : [], ...section().rows];
    if (saved.searching && saved.query) source = filterPanelRows(source, saved.query);
    source = foldRows(source);
    const searching = saved.searching && saved.query.length > 0;
    if (state().expandedZone !== which && !searching) return source;
    const path = expansion();
    const root = source.find(row => row.id === path[0]);
    // A parent that is filtered away or removed cannot keep an invisible open level: Esc must not be
    // consumed by a row that is no longer on screen.
    if (root?.kind !== 'entity' || !root.children?.length) { setExpansion([]); return source; }
    // Validate the open ancestry against fresh data. Missing descendants collapse, but surviving parents,
    // cursor and scroll remain. A third menu level is still inline, never an accidental directory page.
    const valid = root?.kind === 'entity' ? [root.id] : []; let parent = root;
    for (const id of path.slice(1)) {
      const child: PanelRow | undefined = parent?.children?.find(row => row.id === id && row.kind === 'entity' && row.children?.length);
      if (!child) break;
      valid.push(id); parent = child;
    }
    if (!searching) setExpansion(valid);
    const result: PanelRow[] = [];
    const pending = [...source].reverse().map(row => ({ row, depth: 0 }));
    while (pending.length) {
      const { row, depth } = pending.pop()!;
      result.push(row);
      if ((!searching && row.id !== valid[depth]) || row.kind !== 'entity' || !row.children?.length) continue;
      const fields = row.children.filter(child => child.kind === 'readonly');
      const actions = row.children.filter(child => child.kind !== 'readonly');
      const children: readonly PanelRow[] = fields.length && actions.length
        ? [...fields, { id: `${row.id}/fields-actions-divider`, label: '', kind: 'heading' }, ...actions]
        : row.children;
      for (let at = children.length - 1; at >= 0; at--) {
        const child = children[at]!;
        pending.push({ row: { ...child, parentId: row.id, prefix: child.prefix ?? (depth ? row.prefix ?? '' : '') + '│  ' }, depth: depth + 1 });
      }
    }
    return result;
  };
  const restore = (which: 'upper' | 'lower') => {
    const saved = zoneState(which), items = rows(which), found = items.findIndex(row => row.id === saved.selectedId && canDock(row));
    const near = Math.max(0, Math.min(saved.index, items.length - 1));
    let at = found;
    for (let distance = 0; at < 0 && distance < items.length; distance++) {
      if (items[near + distance] && canDock(items[near + distance]!)) at = near + distance;
      else if (items[near - distance] && canDock(items[near - distance]!)) at = near - distance;
    }
    // The band is context above the list: a fresh zone starts on the first real row, not on it.
    if (found < 0 && !saved.selectedId) { const first = items.findIndex(row => canDock(row) && !row.band); if (first >= 0) at = first; }
    saved.index = at;
    if (items[at]) saved.selectedId = items[at]!.id; else delete saved.selectedId;
  };
  const emit = (result: PanelResult) => config.onResult?.(result);
  const syncFocus = () => { if (editing) editing.control.focused = focused; };
  const cancelSearch = () => {
    const saved = zoneState(zone()); saved.searching = false; saved.query = ''; saved.index = saved.returnIndex ?? saved.index;
    if (saved.returnId) saved.selectedId = saved.returnId; else delete saved.selectedId;
    editing = undefined; restore(zone());
  };
  const setPage = (next: PanelPage, local = false) => {
    upperFrame = undefined;
    const previous = stack.findIndex(item => item.page.id === next.id);
    if (next.id !== page.id) {
      if (previous >= 0) { activeId = stack[previous]!.activeId; stack.splice(previous); }
      else if (next.id.split(':', 1)[0] === page.id.split(':', 1)[0] || (next.activeId ?? next.sections[0]!.id) === activeId) { stack.push({ page, activeId, local }); activeId = next.activeId ?? next.sections[0]!.id; }
      else { stack.length = 0; activeId = next.activeId ?? next.sections[0]!.id; }
    }
    page = next; reading = undefined; editing = undefined; confirmation = undefined; armed = undefined; armedPrompt = undefined; switching = false;
    restore('upper'); restore('lower');
    if (!state().zone) state().zone = zoneState('upper').index >= 0 ? 'upper' : 'lower';
    if (zoneState(zone()).searching) resumeSearch();
  };
  const activate = () => {
    const which = zone(), row = rows(which)[zoneState(which).index];
    if (!row) return;
    if (isGroupHeading(row)) { state().zone = which; toggleGroup(row); restore(which); return; }
    if (!canExecute(row)) return;
    const kind = row.kind as PanelKind;
    if (kind === 'entity') {
      if (!row.children?.length) return;
      const path = state().expandedZone === which ? expansion() : [];
      const at = path.indexOf(row.id);
      if (at >= 0) { setExpansion(path.slice(0, at)); return; }
      const parentAt = row.parentId ? path.indexOf(row.parentId) : -1;
      state().zone = which; state().expandedZone = which;
      setExpansion([...path.slice(0, parentAt + 1), row.id]);
      zoneState(which).selectedId = row.children.find(canDock)?.id ?? row.id;
      restore(which); return;
    }
    const identity = `${which}:${row.id}`;
    if (row.destructive) {
      const prompt = row.confirmation ?? { title: msg`确认${row.label}？`, consequences: row.description ?? '', action: row.label };
      // A changed target or scope starts a fresh confirmation, never executes the newly rendered row.
      if (armed !== identity || JSON.stringify(prompt) !== JSON.stringify(armedPrompt)) { armed = identity; armedPrompt = { ...prompt }; return; }
    }
    armed = undefined; armedPrompt = undefined;
    if (kind === 'input') { beginInput(row.input ?? { title: row.label, value: row.value ?? '' }, row.input?.multiline === true, row.id); return; }
    const payload = kind === 'toggle' ? !row.checked : kind === 'cycle' && row.choices?.length ? row.choices[(row.choices.indexOf(row.value ?? '') + 1) % row.choices.length] : row.payload;
    emit({ action: 'selected', kind, id: row.id, ...(payload !== undefined ? { payload } : {}) });
  };
  /**
   * The leading glyph of a row: the explicit icon, else the id-derived fallback.
   * Only `band` rows and rows without any glyph have none — nothing else may hide it.
   */
  const leadOf = (row: PanelRow): string => {
    if (row.band) return '';
    const name = ROW_SYMBOLS[row.id.split(':').at(-1) ?? ''];
    const fallback = name ? glyph(name, iconStyleOf(config)) : row.path ? glyph('extensions', iconStyleOf(config)) : glyph('config-tools', iconStyleOf(config));
    return rowGlyph(row.icon, iconStyleOf(config)) || fallback;
  };
  const icon = (row: PanelRow) => { const lead = leadOf(row); return lead ? lead + ' ' : ''; };
  const isFieldActionDivider = (row: PanelRow): boolean => row.kind === 'heading' && row.id.endsWith('/fields-actions-divider');
  /** A group heading starts a section; the group folds as one unit and remembers the user's choice. */
  const isGroupHeading = (row: PanelRow): boolean => row.kind === 'heading' && row.collapsible === true;
  const groupFolded = (row: PanelRow): boolean => state().groups?.[row.id] ?? (row.groupCount ?? 0) === 0;
  const toggleGroup = (row: PanelRow) => { state().groups = { ...state().groups, [row.id]: !groupFolded(row) }; };
  /** Rows between a collapsed heading and the next heading are hidden. */
  const foldRows = (source: readonly PanelRow[]): readonly PanelRow[] => {
    const visible: PanelRow[] = []; let hidden = false;
    for (const row of source) {
      if (isGroupHeading(row)) { hidden = groupFolded(row); visible.push(row); continue; }
      if (!hidden) visible.push(row);
    }
    return visible;
  };
  /** A tail marker is dropped when the row already carries the same glyph in front: one glyph, never zero. */
  const tailMarker = (row: PanelRow, name: 'input' | 'cycle'): string => {
    const glyphOf = glyph(name, iconStyleOf(config));
    if (!glyphOf || leadOf(row) === glyphOf) return '';
    return ' ' + glyphOf;
  };
  const marker = (row: PanelRow, which: 'upper' | 'lower'): string => {
    const inlineChild = state().expandedZone === which && row.parentId !== undefined && state().expandedId === row.parentId, entity = state().expandedZone === which && state().expandedId === row.id, style = iconStyleOf(config);
    // A child entity that has children of its own is a second level: it keeps its own open/closed glyph.
    const nested = row.kind === 'entity' && row.parentId !== undefined && !!row.children?.length;
    const searchExpanded = zoneState(which).searching && !!zoneState(which).query && !!row.children?.length;
    if (nested) return kindGlyph('entity', { expanded: searchExpanded || expansion().includes(row.id) }, style) + ' ';
    if (row.kind === 'entity') return inlineChild ? '' : kindGlyph('entity', { expanded: searchExpanded || entity }, style) + ' ';
    if (row.kind === 'input') return tailMarker(row, 'input');
    if (row.kind === 'cycle') return tailMarker(row, 'cycle');
    return '';
  };
  const tabLines = () => {
    const parts = page.sections.map(tab => {
      const id = tab.id.toLowerCase(), base = tab.label.replace(/\s*\([^)]*\)$/, '').toLowerCase();
      const style = iconStyleOf(config);
      const glyph = config.symbols?.[tab.label as keyof PanelSymbols] ?? (tabGlyph(id, style) || tabGlyph(base, style));
      const progress = base === 'todos' && !tab.label.includes('(') ? /Todos\s*(\([^)]*\))/.exec(upper().title ?? '')?.[1] : undefined;
      // A page title that already repeats the tab name must not repeat it again in the crumb
      // ("Todos › Todos · DAG"); the tab keeps its progress suffix, the crumb keeps only the difference.
      const baseLabel = tab.label.replace(/\s*\([^)]*\)$/, '').trim();
      const title = page.title ?? '';
      const trimmed = title === baseLabel ? '' : title.startsWith(baseLabel) ? title.slice(baseLabel.length).replace(/^[\s·›\-/:]+/, '') : title;
      const trail = tab.id === activeId && stack.length > 0 && trimmed ? `${tab.label} › ${trimmed}` : tab.label;
      // The reading body's own title gets the same treatment: "Todos › Todos · DAG" is one Todos too many.
      const readTitle = reading ? reading.title : '';
      const readTrimmed = readTitle === baseLabel ? '' : readTitle.startsWith(baseLabel) ? readTitle.slice(baseLabel.length).replace(/^[\s·›\-/:]+/, '') : readTitle;
      const crumb = tab.id === activeId && readTrimmed ? `${trail} › ${readTrimmed}` : trail;
      const label = crumb + (progress ? ' ' + progress : ''), budget = Math.max(1, width - visibleWidth(glyph) - (glyph ? 1 : 0) - 2);
      return styled((glyph ? glyph + ' ' : '') + headTruncate(label, budget), tab.id === activeId ? 'accent' : 'dim', tab.id === activeId);
    });
    const separator = visibleWidth(parts.join('  /  ')) <= width ? '  /  ' : ' / ';
    const lines: string[] = []; let line = '';
    for (const part of parts) { if (line && visibleWidth(line + separator + part) > width) { lines.push(line); line = part; } else line += (line ? styled(separator, 'dim') : '') + part; }
    lines.push(line); return lines;
  };
  const collapse = () => {
    const path = expansion(), id = path.at(-1); if (!id) return false;
    const which = state().expandedZone ?? zone();
    setExpansion(path.slice(0, -1)); zoneState(which).selectedId = id; restore(which); return true;
  };
  const readingHeight = () => reading ? reading.lines.flatMap(line => wrapTextWithAnsi(line, Math.max(1, contentWidth() - 2))).length : 0;
  const hintRows = (): { text: string; tone?: PanelTone }[] => {
    if (editing?.search) return [{ text: editing.control.render(contentWidth())[0]! }, { text: msg`${rows(zone()).length} 项匹配 · Esc 清除` }];
    if (editing) return [
      { text: editing.error ?? msg`正在编辑「${editing.title}」`, ...(editing.error ? { tone: 'error' as const } : {}) },
      { text: editing.multiline ? msg('Enter 提交 · Shift+Enter 换行 · Esc 取消') : msg('Enter 提交 · Esc 取消') },
    ];
    if (armed) {
      const prompt = activeConfirmation();
      return [prompt?.title ?? '', prompt?.consequences ?? ''].map(text => ({ text: clean(text), tone: 'error' as const }));
    }
    const selected = rows(zone())[zoneState(zone()).index];
    // A refused row explains why in the first slot and still says what it would do in the second: the two
    // answers are different, so this fills the pair instead of repeating one sentence.
    const action = selected?.disabledReason && selected?.description ? `${selected.disabledReason}\n${selected.description.split('\n')[0] ?? ''}` : undefined;
    const lines = (action ?? selected?.disabledReason ?? selected?.description ?? section().lines?.slice(0, 2).join('\n') ?? '').split('\n');
    if (selected?.kind === 'readonly') {
      const value = clean(selected.value?.trim() ?? selected.values?.map(part => part.text).join(' · ') ?? ''), description = (selected.description ?? '').split('\n').map(line => clean(line.trim())).filter(Boolean), candidates = description.filter(line => line !== value);
      return [{ text: value ? msg`只读字段「${clean(selected.label)}」：${value}` : msg`只读字段「${clean(selected.label)}」` }, { text: candidates.length ? candidates[0]! + (candidates.length > 1 ? '…' : '') : msg('只读信息，不更改会话状态。') }];
    }
    if (!lines.some(Boolean) && selected) {
      // No authored description: explain the interaction of this kind instead of saying "run the current operation".
      const cue = selected.kind === 'entity' || selected.kind === 'heading'
        ? msg('Enter 或 l 展开子项；h 或 Esc 收起。')
        : selected.kind === 'directory' ? msg('Enter 打开这一组；Esc 返回。')
        : selected.kind === 'input' ? msg('Enter 编辑当前值；Esc 取消，不保存。')
        : selected.kind === 'toggle' ? msg('Enter 切换；只影响这一项设置。')
        : selected.kind === 'cycle' ? msg('Enter 换个取值；只影响这一项设置。')
        : msg('Enter 执行；Esc 返回上一层。');
      // "当前值：无" is noise on a row that has no value at all (an entity or a plain action).
      const name = clean(selected.label), value = selected.value || selected.values?.map(part => part.text).join(' · ');
      return [{ text: value ? msg`${name} · 当前值：${value}` : name }, { text: cue }];
    }
    return lines.map(text => ({ text }));
  };
  /** The band keeps at most two `line` groups, exactly as the frozen geometry expects. */
  const infoLines = (): readonly (readonly PanelInfo[])[] => {
    if (!dual()) return [];
    const info = upper().info ?? [], lines = [...new Set(info.map(item => item.line))].sort((a, b) => a - b).slice(0, 2);
    return lines.map(line => info.filter(item => item.line === line));
  };
  /** Band entries are ordinary readonly rows: they dock, take the cursor and align with entities. */
  const infoRows = (): readonly PanelRow[] => infoLines().map((items, line) => ({
    id: `band:${line}`, kind: 'readonly' as const, band: true, label: items.map(item => item.label).join(' · '),
    values: items.map(item => ({ text: item.value, tone: item.tone ?? 'dim' as const })),
  }));
  const infoCount = () => infoLines().length;
  const activeConfirmation = (): PanelConfirmation | undefined => confirmation ? { ...confirmation, action: msg('确认') } : armedPrompt;
  const confirmationKeys = () => { const action = activeConfirmation()?.action ?? msg('确认'); return msg`再次 Enter ${action} · Esc 取消`; };
  const confirmationValue = () => `${msg('待确认')} · ${confirmationKeys()}`;
  /** Content grows into the live terminal budget; short lists never pad to the maximum height. */
  const geometry = () => {
    const zones = dual(), tabs = tabLines().length;
    const extra = editing && !editing.search ? Math.min(6, editing.multiline ? (editing.control as Editor).getLines().length : 1) - 1 : 0;
    const editingZone = editing && !editing.search ? zone() : undefined;
    const bands = infoCount();
    const upperNeed = Math.max(1, rows('upper').length) + (editingZone === 'upper' ? extra : 0);
    // A reader scrolls in the lower zone; the upper zone keeps its rows and the divider.
    const lowerNeed = Math.max(1, reading ? readingHeight() : rows('lower').length) + (editingZone === 'lower' ? extra : 0);
    if (terminalRows <= 10) {
      // A reader needs the body: the upper zone keeps only the band and the rest scrolls below it.
      if (reading) return { compact: true, hints: 0, slots: ['afterTabs'], upper: zones ? bands : 0, lower: Math.max(1, terminalRows - 4 - (zones ? bands : 0)) };
      if (zones && bands) { const upper = bands + (zone() === 'upper' ? 1 : 0); return { compact: true, hints: 0, slots: ['afterTabs'], upper, lower: zone() === 'lower' ? 1 : 0 }; }
      const upper = zones && zone() === 'upper' ? 1 : 0;
      return { compact: true, hints: 0, slots: ['afterTabs'], upper, lower: upper ? 0 : 1 };
    }
    const budget = Math.max(9, terminalRows - 6), minBody = zones ? 2 + bands : 1;
    // Degrade in the frozen order: compress the viewports to minBody, then hints 2→1→0, then rules
    // 4→3→2. Rules are dropped afterHints → afterZones → between, so the zone separator goes last.
    const allSlots = ['afterTabs', ...(zones ? ['between'] : []), 'afterZones', 'afterHints'], dropped: string[] = [];
    let hints = 2;
    const kept = () => allSlots.filter(slot => !dropped.includes(slot) && !(slot === 'afterHints' && hints === 0));
    const total = () => tabs + kept().length + hints + 1 + minBody;
    const hintFloor = editing?.error ? 1 : 0;
    while (total() > budget) {
      if (hints > hintFloor) hints -= 1;
      else if (!dropped.includes('afterZones')) dropped.push('afterZones');
      else if (zones && !dropped.includes('between')) dropped.push('between');
      else break;
    }
    const slots = kept(), rules = slots.length, body = Math.max(minBody, budget - tabs - rules - hints - 1);
    if (!zones) return { compact: false, hints, slots, upper: 0, lower: Math.min(lowerNeed, body) };
    if (upperNeed + lowerNeed <= body) return { compact: false, hints, slots, upper: upperNeed, lower: lowerNeed };
    // A reader owns the lower zone; the upper list keeps a minimal slice instead of halving the body.
    if (reading) { const upper = Math.min(upperNeed, Math.max(bands + 1, body - lowerNeed)); return { compact: false, hints, slots, upper, lower: Math.min(lowerNeed, Math.max(1, body - upper)) }; }
    // Both zones keep a floor: the config zone holds at least a third of the body (or all of its own
    // rows, whichever is smaller) and the entity zone takes the rest, so neither an expanded entity nor
    // a long config list can squeeze the other to a single row. Overflow stays inside the viewport (↑/↓).
    const configFloor = Math.max(1, Math.min(lowerNeed, Math.ceil(body / 3)));
    const upper = Math.min(upperNeed, Math.max(bands + 1, body - configFloor));
    return { compact: false, hints, slots, upper, lower: Math.min(lowerNeed, Math.max(1, body - upper)) };
  };
  const move = (direction: 1 | -1) => {
    const which = zone(), saved = zoneState(which), items = rows(which);
    let next = -1;
    for (let at = saved.index + direction; at >= 0 && at < items.length; at += direction) if (canDock(items[at]!)) { next = at; break; }
    if (next >= 0) { saved.index = next; saved.selectedId = items[next]!.id; return; }
    const other = which === 'upper' ? 'lower' : 'upper';
    if (direction === 1 && which === 'upper' || direction === -1 && which === 'lower') {
      const others = rows(other), at = dock(others, direction === 1 ? 0 : others.length - 1, direction);
      if (at >= 0) { state().zone = other; zoneState(other).index = at; zoneState(other).selectedId = others[at]!.id; }
    }
  };
  const viewport = (which: 'upper' | 'lower', capacity: number) => {
    const saved = zoneState(which), total = rows(which).length;
    let start = Math.max(0, Math.min(saved.start ?? 0, Math.max(0, total - capacity)));
    if (saved.index >= 0 && saved.index < start) start = saved.index;
    if (saved.index >= start + capacity) start = saved.index - capacity + 1;
    saved.start = start; return start;
  };
  const resumeSearch = () => {
    const saved = zoneState(zone()), control = new Input({ prompt: msg('搜索：') });
    control.setValue(saved.query); control.handleInput('\x05');
    control.onSubmit = () => { editing = undefined; activate(); };
    editing = { control, title: msg('搜索：'), multiline: false, search: true }; syncFocus();
  };
  const beginInput = (options: PanelInput, multiline: boolean, id = '$input') => {
    const control = multiline ? config.createEditor!() : new Input();
    if (multiline) (control as Editor).setText(options.value ?? '');
    else { (control as Input).setValue(options.value ?? ''); control.handleInput('\x05'); }
    const current: NonNullable<typeof editing> = { control, title: options.title, multiline, search: false, ...(id === '$input' ? {} : { id }), ...(options.validate ? { validate: options.validate } : {}) };
    editing = current;
    control.onSubmit = value => {
      // A rejected submit keeps the draft and the cursor; the reason replaces the editing hint.
      const failure = current.validate?.(value);
      if (failure) { current.error = failure; return; }
      editing = undefined; emit({ action: 'selected', kind: 'input', id, payload: value });
    };
    armed = undefined; syncFocus();
  };
  restore('upper'); restore('lower');
  if (!state().zone) state().zone = zoneState('upper').index >= 0 ? 'upper' : 'lower';
  if (zoneState(zone()).searching) resumeSearch();
  return {
    memory,
    row(id: string, kind?: PanelKind) { return [...rows('upper'), ...rows('lower')].find(row => row.id === id && (!kind || row.kind === kind)); },
    get focused() { return focused; }, set focused(value: boolean) { focused = value; syncFocus(); },
    setPage,
    resize(rows: number) { terminalRows = rows; },
    input: (options: PanelInput) => beginInput(options, false),
    edit: (options: PanelInput) => beginInput(options, true),
    confirm(title: string, consequences: string) { confirmation = { title, consequences }; armed = `${zone()}:${zoneState(zone()).selectedId ?? '$confirm'}`; },
    read(title: string, lines: readonly string[]) { reading = { title, lines, offset: 0 }; editing = undefined; confirmation = undefined; armed = undefined; },
    cancelInput() { editing = undefined; confirmation = undefined; armed = undefined; armedPrompt = undefined; },
    invalidate() { editing?.control.invalidate(); },
    /** A data refresh may not steal drafts, confirmations, search or an open body. */
    canRefresh() { return !editing && !reading && !confirmation && !armed && !switching; },
    render(columns: number): string[] {
      upperFrame = undefined;
      width = Math.max(0, columns); restore('upper'); restore('lower');
      const sizes = geometry(), rule = styled('─'.repeat(width), 'dim');
      const keep = new Set(sizes.slots);
      const overflowAt = (index: number, start: number, capacity: number, total: number): string | undefined => {
        const above = index === 0 && start > 0, below = index === capacity - 1 && start + capacity < total;
        return above && below ? '↕' : above ? '↑' : below ? '↓' : undefined;
      };
      const output = tabLines().map(line => pad(fit(line, width)));
      if (keep.has('afterTabs')) output.push(rule);
      if (dual()) {
        const items = rows('upper'), itemCapacity = Math.max(0, sizes.upper); let start = viewport('upper', Math.max(1, itemCapacity));
        if (editing && !editing.search && zone() === 'upper') { const height = Math.min(Math.max(1, itemCapacity), 6, editing.multiline ? (editing.control as Editor).getLines().length : 1); start = Math.max(start, zoneState('upper').index + height - Math.max(1, itemCapacity)); zoneState('upper').start = start; }
        const upperLines: string[] = [], rowWidth = contentWidth();
        for (let index = 0; index < itemCapacity; index++) {
          const absolute = start + index, row = items[absolute], selected = zone() === 'upper' && absolute === zoneState('upper').index;
          const overflow = overflowAt(index, start, itemCapacity, items.length), available = rowWidth - (overflow ? 1 : 0);
          if (!row) { if (!items.length) upperLines.push(contentRow(styled(msg('暂无内容'), 'dim'), overflow)); continue; }
          const cursor = selected ? styled('> ', 'accent') : '  ', tree = row.parentId ? styled(row.prefix ?? '   ', 'dim') : '';
          const treeLead = row.parentId ? '  ' + tree : '';
          if (isFieldActionDivider(row)) {
            const inner = Math.max(1, rowWidth - visibleWidth(treeLead) - visibleWidth(cursor) - 2);
            upperLines.push(contentRow(treeLead + cursor + styled('─'.repeat(inner), 'dim'), overflow)); continue;
          }
          if (isGroupHeading(row)) {
            const glyph = kindGlyph('heading', { folded: groupFolded(row) }, iconStyleOf(config));
            const text = `${glyph ? glyph + ' ' : ''}${clean(row.label)}${row.groupCount === undefined ? '' : ` (${row.groupCount})`}`;
            upperLines.push(contentRow(treeLead + cursor + styled(text, 'muted'), overflow)); continue;
          }
          const kindMarker = marker(row, 'upper');
          let prefixMarker = row.kind === 'entity' && row.text === undefined ? kindMarker : '';
          let suffixMarker = row.kind === 'entity' || row.kind === 'readonly' ? '' : kindMarker;
          const isArmed = armed === `upper:${row.id}`;
          const rawValue = isArmed ? confirmationValue() : row.value ?? '';
          const editBudget = Math.max(0, available - visibleWidth(cursor) - visibleWidth(treeLead) - visibleWidth(prefixMarker) - visibleWidth(suffixMarker));
          if (editing && !editing.search && selected) {
            const tone = editingTone(row);
            const leaderText = truncateToWidth(clean(row.label), Math.max(0, editBudget - 10), '…');
            const leader = styled(leaderText, tone) + '  ';
            const inputWidth = Math.max(1, editBudget - visibleWidth(leader));
            let lines = editing.control.render(inputWidth); if (editing.multiline) lines = lines.slice(1, -1);
            const editHeight = Math.min(sizes.upper, 6, editing.multiline ? (editing.control as Editor).getLines().length : 1);
            const cursorLine = Math.max(0, lines.findIndex(line => line.includes(CURSOR_MARKER))), offset = Math.max(0, cursorLine - editHeight + 1);
            for (let at = 0; at < Math.min(editHeight, sizes.upper - index); at++) {
              const inputLine = underlined(styled(lines[offset + at] ?? '', tone));
              upperLines.push(contentRow(treeLead + (at ? '  ' : cursor) + (at ? ' '.repeat(visibleWidth(leader)) : leader) + inputLine, at === 0 ? overflow : undefined));
            }
            index += editHeight - 1; continue;
          }
          if (row.text !== undefined && row.value === undefined && !row.parentId) {
            const query = zoneState('upper').searching ? zoneState('upper').query : '';
            const narrower = overflow ? section().upper?.(Math.max(0, available - 2), query).rows.find(candidate => candidate.id === row.id)?.text : undefined;
            const text = narrower ?? row.text;
            upperLines.push(contentRow(cursor + (config.iconStyle === 'plain' ? safe(text) : text), overflow));
            continue;
          }
          const label = icon(row) + clean(row.label), labelTone: PanelTone = row.kind === 'readonly' ? 'muted' : row.disabledReason ? 'dim' : isArmed || row.destructive ? 'error' : row.tone ?? 'text';
          const values = isArmed ? [{ text: rawValue, tone: 'error' as const }] : valuesOf(row);
          const value = isArmed ? styled(rawValue, 'error') : bracketedValue(values, row.valueTone, row.kind === 'readonly' && !row.band ? 'dim' : undefined);
          const baseBudget = Math.max(0, available - visibleWidth(cursor) - visibleWidth(treeLead));
          if (prefixMarker && visibleWidth(value) + 2 + visibleWidth(prefixMarker) > baseBudget && visibleWidth(value) + 2 <= baseBudget) prefixMarker = '';
          if (suffixMarker && visibleWidth(value) + 2 + visibleWidth(suffixMarker) > baseBudget && visibleWidth(value) + 2 <= baseBudget) suffixMarker = '';
          const budget = Math.max(0, baseBudget - visibleWidth(prefixMarker) - visibleWidth(suffixMarker));
          if (row.parentId && (row.kind === 'readonly' || values.length > 0) && !isArmed) {
            const childWidth = Math.max(0, budget - visibleWidth(treeLead) - 2);
            const cols = dottedColumns(label, value, childWidth);
            upperLines.push(contentRow(treeLead + cursor + prefixMarker + styled(cols.left, labelTone) + ' ' + styled(cols.leader, 'dim') + ' ' + cols.right + suffixMarker, overflow));
          } else if (row.parentId) {
            const childText = isArmed ? `${label}  ${rawValue}` : label;
            upperLines.push(contentRow(treeLead + cursor + prefixMarker + styled(truncateToWidth(childText, budget, '…'), isArmed ? 'error' : labelTone) + suffixMarker, overflow));
          } else {
            const cols = dottedColumns(label, value, budget);
            upperLines.push(contentRow(cursor + prefixMarker + styled(cols.left, labelTone) + ' ' + styled(cols.leader, 'dim') + ' ' + cols.right + suffixMarker, overflow));
          }
        }
        output.push(...upperLines);
        if (keep.has('between')) output.push(rule);
      }
      if (reading) {
        if (reading.layout?.width !== contentWidth()) {
          const anchor = reading.layout?.lines[reading.offset];
          const lines = reading.lines.flatMap((line, paragraph) => { let column = 0; return wrapTextWithAnsi(safe(line), Math.max(1, contentWidth() - 2)).map(text => { const row = { text, paragraph, column }; column += visibleWidth(text); return row; }); });
          if (anchor) reading.offset = Math.max(0, lines.findLastIndex(row => row.paragraph === anchor.paragraph && row.column <= anchor.column));
          reading.layout = { width: contentWidth(), lines };
        }
        reading.offset = Math.max(0, Math.min(reading.offset, Math.max(0, reading.layout.lines.length - 1)));
        // The viewport is padded to its own height: reaching the last line never shortens the panel.
        for (let index = 0; index < sizes.lower; index++) {
          const line = reading.layout.lines[reading.offset + index]; output.push(contentRow(line ? '  ' + line.text : ''));
        }
      }
      const items = reading ? [] : rows('lower');
      let start = viewport('lower', sizes.lower);
      if (editing && !editing.search && zone() === 'lower') {
        const height = editing.multiline ? Math.min(6, (editing.control as Editor).getLines().length) : 1;
        start = Math.max(start, zoneState('lower').index + height - sizes.lower);
        zoneState('lower').start = start;
      }
      const rowWidth = contentWidth();
      const labels = items.map(row => row.compactLabel && visibleWidth(clean(row.label)) + visibleWidth(row.value ?? '') + 4 > rowWidth ? row.compactLabel : row.label).map((label, index) => icon(items[index]!) + label);
      const labelWidth = Math.min(Math.max(0, rowWidth - (items.some(row => row.value || row.values?.length || row.disabledReason) ? 10 : 4)), labels.reduce((maximum, label) => Math.max(maximum, visibleWidth(clean(label))), 0));
      const valueAt = labelWidth + 2;
      const lower: string[] = [];
      for (let index = start; index < items.length && lower.length < sizes.lower; index++) {
        const local = lower.length, row = items[index]!, selected = zone() === 'lower' && index === zoneState('lower').index;
        const overflow = overflowAt(local, start, sizes.lower, items.length);
        const available = rowWidth - (overflow ? 1 : 0);
        const label = row.path ? middleTruncate(clean(labels[index]!), Math.min(labelWidth, available)) : fit(clean(labels[index]!), Math.min(labelWidth, available));
        const tree = row.parentId ? '  ' + (row.prefix ?? '│  ') : '';
        const cursor = selected ? styled('> ', 'accent') : '  ';
        if (isFieldActionDivider(row)) {
          const inner = Math.max(1, available - visibleWidth(tree) - visibleWidth(cursor) - 2);
          lower.push(contentRow(tree + cursor + styled('─'.repeat(inner), 'dim'), overflow)); continue;
        }
        if (isGroupHeading(row)) {
          const glyph = kindGlyph('heading', { folded: groupFolded(row) }, iconStyleOf(config));
          const text = `${glyph ? glyph + ' ' : ''}${clean(row.label)}${row.groupCount === undefined ? '' : ` (${row.groupCount})`}`;
          lower.push(contentRow(tree + cursor + styled(text, 'muted'), overflow)); continue;
        }
        const kindMarker = marker(row, 'lower'), prefixMarker = row.kind === 'entity' && row.text === undefined ? kindMarker : '';
        let suffixMarker = row.kind === 'entity' || row.kind === 'readonly' ? '' : kindMarker;
        const editingRow = Boolean(editing && !editing.search && selected);
        const tone = editingRow ? editingTone(row) : undefined;
        const prefix = tree + cursor + prefixMarker + (tone ? styled(label, tone) : label) + ' '.repeat(Math.max(0, Math.min(valueAt - visibleWidth(prefixMarker), available) - visibleWidth(label)));
        if (editing && !editing.search && selected) {
          const inputWidth = Math.max(1, available - visibleWidth(prefix));
          let editorLines = editing.control.render(inputWidth);
          if (editing.multiline) editorLines = editorLines.slice(1, -1);
          const height = Math.min(6, editing.multiline ? (editing.control as Editor).getLines().length : 1);
          const cursor = Math.max(0, editorLines.findIndex(line => line.includes(CURSOR_MARKER)));
          const offset = Math.max(0, cursor - height + 1);
          lower.push(...editorLines.slice(offset, offset + height).map((line, at) => contentRow((at ? ' '.repeat(visibleWidth(prefix)) : prefix) + underlined(styled(line, tone!)), at === 0 ? overflow : undefined)));
        } else {
          const isArmed = armed === `lower:${row.id}`;
          const value = isArmed ? confirmationValue() : [row.value, row.disabledReason].filter(Boolean).join(' · ');
          const labelTone: PanelTone = row.kind === 'readonly' ? 'muted' : row.disabledReason ? 'dim' : isArmed || row.destructive || row.tone === 'error' ? 'error' : 'text';
          const valueTone: PanelTone = row.kind === 'readonly' ? 'dim' : isArmed ? 'error' : row.disabledReason ? 'dim' : row.valueTone && row.valueTone !== 'dim' ? row.valueTone : valueToneFor(value);
          if ((row.parentId && (row.kind === 'readonly' || row.value !== undefined) || row.values?.length) && !isArmed) {
            const valueBlock = bracketedValue(row.values?.length ? row.values : valuesOf(row), row.valueTone ?? 'muted', row.kind === 'readonly' ? 'dim' : undefined);
            const columnWidth = Math.max(0, available - visibleWidth(tree) - visibleWidth(cursor) - visibleWidth(prefixMarker) - 4 - visibleWidth(suffixMarker));
            const columnLabel = row.parentId ? icon(row) + clean(row.label) : clean(labels[index]!);
            const columns = dottedColumns(columnLabel, valueBlock, columnWidth);
            lower.push(contentRow(tree + cursor + prefixMarker + styled(columns.left, labelTone) + ' ' + styled(columns.leader, 'dim') + ' ' + columns.right + suffixMarker, overflow));
          } else if (!row.parentId && !isArmed) {
            // Column alignment is kept whenever the row fits; only the overflow case re-flows the row.
            if (visibleWidth(prefix) + visibleWidth(value) + visibleWidth(suffixMarker) <= available) {
              lower.push(contentRow(styled(prefix, labelTone) + styled(safe(value), valueTone) + suffixMarker, overflow));
            } else {
              const base = tree + cursor + prefixMarker, capacity = Math.max(0, available - visibleWidth(base));
              const parts = fitRow(visibleWidth(clean(labels[index]!)), visibleWidth(value), visibleWidth(suffixMarker), capacity);
              const compact = truncateToWidth(clean(labels[index]!), parts.label, '…'), fittedValue = fit(value, parts.value);
              lower.push(contentRow(styled(base + compact, labelTone) + (compact && fittedValue ? ' ' : '') + styled(fittedValue, valueTone) + (parts.marker ? suffixMarker : ''), overflow));
            }
          } else {
            const childLabel = row.parentId ? tree + cursor + icon(row) + clean(row.label) : prefix;
            lower.push(contentRow(styled(childLabel, labelTone) + styled(fit(value, Math.max(0, available - visibleWidth(childLabel) - visibleWidth(suffixMarker))), valueTone) + suffixMarker, overflow));
          }
        }
      }
      if (editing && !editing.search && !items.length) {
        let editorLines = editing.control.render(Math.max(1, rowWidth)); if (editing.multiline) editorLines = editorLines.slice(1, -1);
        const cursor = Math.max(0, editorLines.findIndex(line => line.includes(CURSOR_MARKER)));
        const offset = Math.max(0, cursor - sizes.lower + 1);
        lower.push(...editorLines.slice(offset, offset + sizes.lower).map(line => contentRow('  ' + line)));
      }
      if (!items.length && !editing && !reading && !dual()) lower.push(contentRow(styled(msg('暂无内容'), 'dim')));
      output.push(...lower.slice(0, sizes.lower));
      if (keep.has('afterZones')) output.push(rule);
      if (sizes.hints) {
        const hints = hintRows();
        output.push(...Array.from({ length: sizes.hints }, (_, index) => {
          const hint = hints[index];
          return contentRow(styled(fit(reading ? '' : hint?.text ?? '', contentWidth()), hint?.tone ?? (armed ? 'error' : 'muted')));
        }));
      }
      if (keep.has('afterHints')) output.push(rule);
      const twoZones = dual() && rows('upper').some(canDock) && items.some(canDock);
      const keys = armed
        ? [confirmationKeys(), msg('Enter 确认 · Esc 取消'), msg('Esc 取消'), 'Esc'].find(text => visibleWidth(text) <= Math.max(3, width - 1)) ?? 'Esc'
        : sizes.compact ? msg('Esc 返回') : reading ? msg('j/k 滚动 · Esc 返回') : panelKeys(width, [...rows('upper'), ...items].some(canExecute), page.sections.length, twoZones, msg);
      // The first blank is the neutral gutter; the entire visible legend itself carries dim SGR.
      output.push(' ' + styled(fit(keys, Math.max(0, width - 1)), 'dim') + ' '.repeat(Math.max(0, width - visibleWidth(keys) - 1)));
      const limit = Math.max(1, terminalRows - 1);
      return output.length > limit ? output.slice(0, limit) : output;
    },
    handleInput(data: string) {
      if (switching) return;
      upperFrame = undefined;
      const enter = matchesKey(data, 'enter'), escape = matchesKey(data, 'escape') || matchesKey(data, 'ctrl+c');
      if (editing?.search && page.sections.length > 1 && (matchesKey(data, 'tab') || matchesKey(data, 'shift+tab'))) {
        const at = page.sections.findIndex(entry => entry.id === activeId), delta = matchesKey(data, 'shift+tab') ? -1 : 1;
        switching = true; emit({ action: 'switch', id: page.sections[(at + delta + page.sections.length) % page.sections.length]!.id }); return;
      }
      if (editing?.search && (matchesKey(data, 'up') || matchesKey(data, 'down'))) {
        const which = zone(), saved = zoneState(which), items = rows(which), direction = matchesKey(data, 'up') ? -1 : 1;
        const at = dock(items, saved.index + direction, direction); saved.index = at;
        if (items[at]) saved.selectedId = items[at]!.id;
        return;
      }
      if (editing) {
        if (escape) {
          if (editing.search) cancelSearch();
          else { const id = editing.id; editing = undefined; if (!id) emit({ action: 'back', payload: 'input' }); }
          return;
        }
        const active = editing;
        delete active.error;
        active.control.handleInput(data);
        if (active.search && editing === active) { const saved = zoneState(zone()); saved.query = (active.control as Input).getValue(); delete saved.selectedId; saved.index = 0; restore(zone()); }
        return;
      }
      if (confirmation) {
        confirmation = undefined; armed = undefined; armedPrompt = undefined;
        emit({ action: 'selected', kind: 'action', id: '$confirm', payload: enter }); return;
      }
      if (armed && !enter) { armed = undefined; armedPrompt = undefined; if (escape) return; }
      if (matchesKey(data, 'tab') || matchesKey(data, 'shift+tab')) {
        if (page.sections.length < 2) return;
        const at = page.sections.findIndex(entry => entry.id === activeId), delta = matchesKey(data, 'shift+tab') ? -1 : 1;
        switching = true; emit({ action: 'switch', id: page.sections[(at + delta + page.sections.length) % page.sections.length]!.id }); return;
      }
      if (reading) {
        // The offset stays inside the wrapped body: `j` at the last line is a no-op, never a taller panel.
        const last = () => Math.max(0, (reading?.layout?.lines.length ?? 1) - 1), pageSize = () => Math.max(1, geometry().lower);
        if (escape) { reading = undefined; if (zoneState(zone()).searching) resumeSearch(); emit({ action: 'back', payload: 'read' }); }
        else if (data === 'j' || matchesKey(data, 'down')) reading.offset = Math.min(reading.offset + 1, last());
        else if (data === 'k' || matchesKey(data, 'up')) reading.offset = Math.max(0, reading.offset - 1);
        else if (matchesKey(data, 'right')) reading.offset = Math.min(reading.offset + pageSize(), last());
        else if (matchesKey(data, 'left')) reading.offset = Math.max(0, reading.offset - pageSize());
        return;
      }
      if (escape) {
        if (collapse()) return;
        if (zoneState(zone()).searching) { cancelSearch(); return; }
        const parent = stack.pop();
        if (parent) { page = parent.page; activeId = parent.activeId; if (!parent.local) emit({ action: 'back' }); }
        else emit({ action: 'closed' });
        return;
      }
      if (data === 'j' || matchesKey(data, 'down')) { move(1); return; }
      if (data === 'k' || matchesKey(data, 'up')) { move(-1); return; }
      if (data === 'g' || data === 'G') {
        const target = data === 'g' ? 'upper' : 'lower', items = rows(target), at = dock(items, 0, 1);
        if (at < 0) return;
        state().zone = target; zoneState(target).index = at; zoneState(target).selectedId = items[at]!.id; return;
      }
      if (data === 'h') {
        if (collapse()) return;
        const which = zone(), items = rows(which), index = zoneState(which).index;
        const group = items.slice(0, Math.max(0, index) + 1).reverse().find(isGroupHeading);
        if (group && !groupFolded(group)) { toggleGroup(group); restore(which); return; }
        const parent = stack.pop();
        if (parent) { page = parent.page; activeId = parent.activeId; if (!parent.local) emit({ action: 'back' }); }
        return;
      }
      if (data === 'l') {
        const which = zone(), row = rows(which)[zoneState(which).index];
        if (!row) return;
        if (isGroupHeading(row)) { if (groupFolded(row)) { toggleGroup(row); restore(which); } return; }
        // `l` is layer +1 only: an expanded entity has nowhere deeper to go and stays open (h collapses).
        if (row.kind === 'entity' && state().expandedZone === which && expansion().includes(row.id)) return;
        if (row.kind === 'entity' || row.kind === 'directory') activate();
        return;
      }
      if (matchesKey(data, 'right') || matchesKey(data, 'left')) {
        const which = zone(), items = rows(which), saved = zoneState(which), direction = matchesKey(data, 'right') ? 1 : -1;
        const at = dock(items, saved.index + direction * geometry()[which], direction);
        saved.start = Math.max(0, Math.min(Math.max(0, items.length - geometry()[which]), (saved.start ?? 0) + direction * geometry()[which]));
        saved.index = at; if (items[at]) saved.selectedId = items[at]!.id; return;
      }
      if (enter) { activate(); return; }
      if (data === '/' && section().searchable !== false) {
        // Search filters the zone that owns dockable rows; the other zone keeps its content.
        const which = rows(zone()).some(canDock) ? zone() : zone() === 'upper' ? 'lower' : 'upper'; state().zone = which;
        const saved = zoneState(which); saved.searching = true; saved.returnIndex = saved.index;
        if (saved.selectedId) saved.returnId = saved.selectedId;
        resumeSearch();
      }
    },
  };
}
