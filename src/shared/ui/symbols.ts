/**
 * One glyph table for every outlet (panel, menu, widget, tool results, notifications).
 * `nerd` is the Nerd Font rendering; `plain` is what a plain terminal may show instead
 * (an empty string means "omit the glyph"). Consumers never branch on glyph codepoints
 * themselves: they ask for a symbol by name and the table decides.
 */
export type IconStyle = 'nerd-font' | 'plain';
export interface SymbolEntry { readonly nerd: string; readonly plain: string }

export const SYMBOLS = {
  todos: { nerd: '\u{f0279}', plain: '' },
  plan: { nerd: '\u{f03eb}', plain: '' },
  goal: { nerd: '\u{f04fe}', plain: '' },
  agents: { nerd: '\u{f000e}', plain: '' },
  retry: { nerd: '\u{f046e}', plain: '' },
  display: { nerd: '\u{f0379}', plain: '' },
  team: { nerd: '\u{f0849}', plain: '' },
  fold: { nerd: '\u{f0140}', plain: '▾' },
  unfold: { nerd: '\u{f0142}', plain: '▸' },
  input: { nerd: '\u{f03eb}', plain: '✎' },
  cycle: { nerd: '\u{f0450}', plain: '⟳' },
  group: { nerd: '\u{f000f}', plain: '' },
  filter: { nerd: '\u{f0232}', plain: '' },
  graph: { nerd: '\u{f0645}', plain: '' },
  presets: { nerd: '\u{f027b}', plain: '' },
  summary: { nerd: '\u{f0208}', plain: '' },
  mode: { nerd: '\u{f03eb}', plain: '' },
  restrictions: { nerd: '\u{f033e}', plain: '' },
  'config-tools': { nerd: '\u{f0493}', plain: '' },
  'session-tools': { nerd: '\u{f018d}', plain: '' },
  settings: { nerd: '\u{f08bb}', plain: '' },
  models: { nerd: '\u{f06a9}', plain: '' },
  candidates: { nerd: '\u{f048b}', plain: '' },
  stop: { nerd: '\u{f04db}', plain: '' },
  toggle: { nerd: '\u{f040a}', plain: '' },
  pause: { nerd: '\u{f03e4}', plain: '' },
  read: { nerd: '\u{f0208}', plain: '' },
  edit: { nerd: '\u{f03eb}', plain: '' },
  complete: { nerd: '\u{f012c}', plain: '' },
  delete: { nerd: '\u{f01b4}', plain: '' },
  new: { nerd: '\u{f0415}', plain: '' },
  spawn: { nerd: '\u{f0415}', plain: '' },
  wait: { nerd: '\u{f0154}', plain: '' },
  autoresearch: { nerd: '\u{f0456}', plain: '' },
  nopause: { nerd: '\u{f0238}', plain: '' },
  nolimit: { nerd: '\u{f084f}', plain: '' },
  profiles: { nerd: '\u{f000e}', plain: '' },
  catalog: { nerd: '\u{f048b}', plain: '' },
  extensions: { nerd: '\u{f0a66}', plain: '' },
  delivery: { nerd: '\u{f009a}', plain: '' },
  intervals: { nerd: '\u{f0154}', plain: '' },
  count: { nerd: '\u{f084f}', plain: '' },
  phase: { nerd: '\u{f0154}', plain: '' },
  status: { nerd: '\u{f0154}', plain: '' },
  entry: { nerd: '\u{f012c}', plain: '' },
  output: { nerd: '\u{f0208}', plain: '' },
  send: { nerd: '\u{f018d}', plain: '' },
  answer: { nerd: '\u{f018d}', plain: '' },
  cancel: { nerd: '\u{f04db}', plain: '' },
  remove: { nerd: '\u{f01b4}', plain: '' },
  redispatch: { nerd: '\u{f0456}', plain: '' },
  loaded: { nerd: '\u{f0415}', plain: '' },
  manual: { nerd: '\u{f0415}', plain: '' },
  instructions: { nerd: '\u{f03eb}', plain: '' },
  skills: { nerd: '\u{f018d}', plain: '' },
  up: { nerd: '\u{f005d}', plain: '' },
  down: { nerd: '\u{f0045}', plain: '' },
  done: { nerd: '\u{f012c}', plain: '' },
  clear: { nerd: '\u{f01b4}', plain: '' },
  starting: { nerd: '\u{f04e6}', plain: '' },
  running: { nerd: '\u{f0954}', plain: '' },
  waiting: { nerd: '\u{f02d7}', plain: '' },
  verify: { nerd: '\u{f0954}', plain: '' },
  failed: { nerd: '\u{f0159}', plain: '' },
  interrupted: { nerd: '\u{f0666}', plain: '' },
  thinking: { nerd: '\u{f09d1}', plain: '' },
  tool: { nerd: '\u{f018d}', plain: '' },
  'group-fold': { nerd: '\u{f0140}', plain: '' },
  'group-unfold': { nerd: '\u{f0142}', plain: '' },
  launch: { nerd: '\u{f14de}', plain: '' },
  'retry-armed': { nerd: '\u{f0565}', plain: '' },
  'retry-active': { nerd: '\u{f04e6}', plain: '' },
  timer: { nerd: '\u{f13ab}', plain: '' },
  'clock-fast': { nerd: '\u{f0152}', plain: '' },
  counter: { nerd: '\u{f0199}', plain: '' },
} as const satisfies Readonly<Record<string, SymbolEntry>>;

export type SymbolName = keyof typeof SYMBOLS;
const NAMES = Object.keys(SYMBOLS) as SymbolName[];

/** Legacy row ids still map to a symbol name; explicit icons take precedence at the call site. */
export const ROW_SYMBOLS: Readonly<Record<string, SymbolName>> = {
  filter: 'filter', graph: 'graph', presets: 'presets', summary: 'summary', mode: 'mode', restrictions: 'restrictions',
  'config-tools': 'config-tools', 'session-tools': 'session-tools', settings: 'settings', models: 'models', candidates: 'candidates',
  stop: 'stop', toggle: 'toggle', pause: 'pause', read: 'read', edit: 'edit', complete: 'complete', delete: 'delete',
  new: 'new', spawn: 'spawn', wait: 'wait', autoresearch: 'autoresearch', nopause: 'nopause', nolimit: 'nolimit',
  profiles: 'profiles', catalog: 'catalog', extensions: 'extensions', delivery: 'delivery', intervals: 'intervals',
  count: 'count', phase: 'phase', status: 'status', entry: 'entry', output: 'output', send: 'send', answer: 'answer',
  cancel: 'cancel', remove: 'remove', redispatch: 'redispatch', loaded: 'loaded', manual: 'manual',
  instructions: 'instructions', skills: 'skills', up: 'up', down: 'down', done: 'done', clear: 'clear',
};

const TAB_SYMBOLS: Readonly<Record<string, SymbolName>> = { todos: 'todos', plan: 'plan', goal: 'goal', agents: 'agents', team: 'team', retry: 'retry', display: 'display' };

/** Module tab glyphs use the same table as every other outlet. */
export function tabGlyph(id: string, style: IconStyle = 'nerd-font'): string {
  const name = TAB_SYMBOLS[id];
  return name ? glyph(name, style) : '';
}

const PLAIN_BY_NERD = new Map<string, string>(NAMES.map(name => [SYMBOLS[name].nerd, SYMBOLS[name].plain] as const));

/** Every symbol for one style; `''` means the outlet omits it. */
export function glyph(name: SymbolName, style: IconStyle = 'nerd-font'): string {
  return SYMBOLS[name][style === 'plain' ? 'plain' : 'nerd'];
}

/** Row icon: an explicit Nerd Font glyph degrades through the table; unknown glyphs vanish in plain mode. */
export function rowGlyph(icon: string | undefined, style: IconStyle = 'nerd-font'): string {
  if (!icon) return '';
  if (style !== 'plain') return icon;
  return PLAIN_BY_NERD.get(icon) ?? '';
}

/** Kind markers and fold chevrons; plain mode keeps its ASCII marking from the same table. */
export function kindGlyph(kind: string, state: { expanded?: boolean; folded?: boolean } = {}, style: IconStyle = 'nerd-font'): string {
  if (kind === 'entity') return state.expanded ? glyph('fold', style) : glyph('unfold', style);
  if (kind === 'heading') return state.folded ? glyph('group-unfold', style) : glyph('group-fold', style);
  if (kind === 'input') return glyph('input', style);
  if (kind === 'cycle') return glyph('cycle', style);
  return '';
}

/** BMP private use is how both Nerd Font (F0000 plane) and legacy icon fonts leak into text. */
export const PRIVATE_USE = /[\ue000-\uf8ff]/gu;
export const PRIVATE_USE_ALL = /[\ue000-\uf8ff]|[\u{f0000}-\u{ffffd}]/gu;
