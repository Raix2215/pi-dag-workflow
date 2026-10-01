import { ScrollView, matchesKey, truncateToWidth, type Component } from '@earendil-works/pi-tui';
import type { Theme } from '@earendil-works/pi-coding-agent';
import { chinese, type Translator } from '../shared/i18n.ts';

/** Reuse Pi's scroll state; keep header/footer pinned in regular and fullscreen terminals. */
export function detailView(lines: (width: number) => string[], rows: () => number, requestRender: () => void, done: () => void, theme?: Theme, msg: Translator = chinese): Component {
  const scroll = new ScrollView({ render: () => [], invalidate() {} }, { scrollbar: 'hidden', follow: 'none' });
  let page = 1;
  let cachedWidth = -1;
  let cachedHeader = msg('暂无任务');
  let cachedBody: string[] = [];
  return {
    render(width) {
      if (cachedWidth !== width) { const output = lines(width); cachedHeader = output[0] ?? msg('暂无任务'); cachedBody = output.slice(1); cachedWidth = width; }
      const header = cachedHeader;
      const body = cachedBody;
      page = Math.max(1, Math.floor(rows()) - 6);
      scroll.updateLayout(body.length, page, requestRender);
      const start = scroll.scrollTop;
      const position = body.length ? `${Math.min(start + 1, body.length)}–${Math.min(start + page, body.length)}/${body.length}` : '0/0';
      const footer = msg`Esc 返回 · ↑/↓ PgUp/PgDn Home/End · ${position}`;
      return [header, ...body.slice(start, start + page), truncateToWidth(theme ? theme.fg('dim', footer) : footer, width)];
    },
    invalidate() { cachedWidth = -1; },
    handleInput(data) {
      if (matchesKey(data, 'escape') || matchesKey(data, 'ctrl+c')) { done(); return; }
      if (matchesKey(data, 'up')) scroll.scrollBy(-1);
      else if (matchesKey(data, 'down')) scroll.scrollBy(1);
      else if (matchesKey(data, 'pageUp')) scroll.scrollBy(-page);
      else if (matchesKey(data, 'pageDown')) scroll.scrollBy(page);
      else if (matchesKey(data, 'home')) scroll.scrollToStart();
      else if (matchesKey(data, 'end')) scroll.scrollToEnd();
    },
  };
}
