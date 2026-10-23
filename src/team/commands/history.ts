import { BorderedLoader, copyToClipboard, DynamicBorder, TreeSelectorComponent, type ExtensionContext, type Theme } from '@earendil-works/pi-coding-agent';
import { matchesKey, ScrollView, Text, truncateToWidth, visibleWidth, type Component } from '@earendil-works/pi-tui';
import { displayTree, entryBody, readHistory, safeHistoryText, type HistorySnapshot } from '../io/session-history.ts';
import { withNativeScreen } from '../../shared/ui/menu.ts';
import { chinese, type Translator } from '../../shared/i18n.ts';

export interface HistoryTarget { readonly name: string; readonly sessionId: string; readonly file: string | undefined; readonly reason?: string }

/**
 * The native /tree component, not a second tree renderer or a plugin panel. Enter reads a node instead of
 * navigating this session; labels cannot be edited. All native search/filter/fold keys stay native.
 */
export function historyComponent(options: {
  target: HistoryTarget; rows: number | (() => number); snapshot: HistorySnapshot;
  done: () => void; repaint?: (force?: boolean) => void; copy?: (text: string | undefined) => void;
  theme?: Pick<Theme, 'fg'>; msg?: Translator;
}): Component & { focused: boolean; treeSelector(): TreeSelectorComponent; handleInput(data: string): void; render(width: number): string[] } {
  const rows = () => typeof options.rows === 'function' ? options.rows() : options.rows;
  const snapshot = options.snapshot, msg = options.msg ?? chinese, border = new DynamicBorder();
  // Match the native tree's compact viewport, leaving room for the same screen identity and a return cue.
  const bodyRoom = () => Math.max(1, Math.min(Math.floor(rows() / 2), rows() - 5));
  let height = rows(), body: Text | undefined, scroll: ScrollView | undefined, closed = false;
  const finish = () => { closed = true; options.done(); };
  const makeTree = (selected?: string, query = '') => {
    const tree = new TreeSelectorComponent(displayTree(snapshot.tree), snapshot.leafId, height,
      id => {
        body = new Text(safeHistoryText(entryBody(snapshot, id) ?? ''), 0, 0);
        scroll = new ScrollView(body, { scrollbar: 'auto' });
      }, finish, undefined, selected, 'default');
    delete (tree.getTreeList() as { onLabelEdit?: unknown }).onLabelEdit;
    tree.onCopy = text => options.copy?.(text);
    for (const key of query) tree.handleInput(key);
    return tree;
  };
  let tree = makeTree();
  return {
    treeSelector: () => tree,
    get focused() { return tree.focused; }, set focused(value: boolean) { tree.focused = value; },
    invalidate() { tree.invalidate(); body?.invalidate(); },
    handleInput(data: string) {
      if (!body || !scroll) {
        tree.handleInput(data);
        if (!closed) options.repaint?.(body !== undefined);
        return;
      }
      if (matchesKey(data, 'escape') || matchesKey(data, 'ctrl+c')) { body = undefined; scroll = undefined; options.repaint?.(true); return; }
      if (matchesKey(data, 'up') || data === 'k') scroll.scrollBy(-1);
      else if (matchesKey(data, 'down') || data === 'j') scroll.scrollBy(1);
      else if (matchesKey(data, 'pageUp')) scroll.scrollBy(-bodyRoom());
      else if (matchesKey(data, 'pageDown')) scroll.scrollBy(bodyRoom());
      else if (matchesKey(data, 'home')) scroll.scrollToStart();
      else if (matchesKey(data, 'end')) scroll.scrollToEnd();
      options.repaint?.();
    },
    render(width) {
      if (body && scroll) {
        const lines = body.render(width), room = bodyRoom();
        scroll.updateLayout(lines.length, room, options.repaint ?? (() => {}));
        const full = msg('↑/↓ 滚动 · PgUp/PgDn 翻页 · Esc 返回树'), short = msg('↑/↓ 滚动 · Esc 返回树');
        const hint = visibleWidth(full) <= width ? full : visibleWidth(short) <= width ? short : msg('Esc 返回树');
        const title = truncateToWidth('Session Tree', width, '…'), keys = truncateToWidth(hint, width, '…');
        return [options.theme?.fg('accent', title) ?? title, ...border.render(width), ...lines.slice(scroll.scrollTop, scroll.scrollTop + room), ...border.render(width), options.theme?.fg('dim', keys) ?? keys];
      }
      if (height !== rows()) {
        height = rows();
        tree = makeTree(tree.getTreeList().getSelectedNode()?.entry.id, tree.getTreeList().getSearchQuery());
      }
      // Do not rewrap, decorate or clip native rows. Pi mounts this in the same inline area as /tree.
      return tree.render(width);
    },
  };
}

export async function openMemberHistory(ctx: ExtensionContext, target: HistoryTarget, msg: Translator = chinese, isCurrent: () => boolean = () => true): Promise<void> {
  if (!ctx.hasUI || ctx.mode !== 'tui') { ctx.ui.notify(msg('会话历史需要在终端界面查看'), 'info'); return; }
  // One owner of the editor area throughout loading and reading. Use Pi's cancellable loader rather
  // than leaving a dead plugin panel over a potentially large file read. No byte/record limit is imposed.
  await withNativeScreen(ctx, async () => {
    const snapshot = await ctx.ui.custom<HistorySnapshot | undefined>((tui, theme, _keys, done) => {
      const loader = new BorderedLoader(tui, theme, 'Loading...');
      let closed = false;
      loader.onAbort = () => { closed = true; done(undefined); };
      void readHistory(target.file, target.reason, loader.signal, msg).then(value => {
        if (closed) return;
        closed = true; done(isCurrent() ? value : undefined);
      }).catch(() => { if (!closed) { closed = true; done(undefined); } });
      return loader;
    });
    if (!snapshot || !isCurrent()) return;
    if (snapshot.state !== 'ok') { const reason = snapshot.reason ?? msg('尚未保存'); ctx.ui.notify(msg`无法查看会话历史：${reason}`, 'warning'); return; }
    if (!snapshot.tree.length) { ctx.ui.notify(msg('这个会话没有可显示的条目：文件可能是空的。'), 'info'); return; }
    await ctx.ui.custom<void>((tui, theme, _keys, done) => historyComponent({
      target, snapshot, rows: () => tui.terminal.rows, done, theme, msg, repaint: force => tui.requestRender(force),
      copy: text => {
        if (!text) { ctx.ui.notify(msg('选中的条目没有可复制的文本。'), 'warning'); return; }
        void copyToClipboard(text).catch(() => { if (isCurrent()) ctx.ui.notify(msg('无法复制到剪贴板'), 'warning'); });
      },
    }));
  });
}
