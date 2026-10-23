import { EventEmitter } from 'node:events';
import { stripTerminalSequences } from '@earendil-works/pi-tui';
import todos from '../../src/todos/index.ts';
import plan from '../../src/plan/index.ts';
import goal from '../../src/goal/index.ts';
import agents from '../../src/agents/index.ts';
import retry from '../../src/retry/index.ts';
import team from '../../src/team/index.ts';
import type { Feature } from './public-records.ts';

/** Assemble only public extension factories on the caller's mock Pi API. */
export async function loadPublic(pi: any, features: readonly Feature[], locale?: 'en' | 'zh-CN'): Promise<void> {
  const bus = new EventEmitter();
  pi.events = {
    emit: (name: string, value: unknown) => bus.emit(name, value),
    on(name: string, handler: (...args: any[]) => void) { bus.on(name, handler); return () => bus.off(name, handler); },
  };
  const factories = { todos, plan, goal, agents, retry, team };
  const previousLocale = process.env.LC_ALL;
  try {
    if (locale) process.env.LC_ALL = locale;
    for (const feature of features) await factories[feature](pi);
  } finally {
    if (locale) { if (previousLocale === undefined) delete process.env.LC_ALL; else process.env.LC_ALL = previousLocale; }
  }
}

/** Drive the actual component through keys; native dialogs keep their existing test drivers. */
export function recordPanels(ctx: any) {
  let component: any, hidden = false, mounts = 0, disposed = 0;
  const forces: boolean[] = [], finishes: (() => void)[] = [];
  const settled = () => new Promise<void>(resolve => setImmediate(resolve));
  const terminal = { rows: 30, columns: 100 };
  ctx.ui.custom = (factory: any, options?: any) => new Promise(resolve => {
    mounts++;
    let settledOnce = false;
    const done = (value: unknown) => { if (settledOnce) return; settledOnce = true; disposed++; resolve(value); };
    finishes.push(() => done(undefined));
    component = factory({ terminal, requestRender(force = false) { forces.push(force); } }, ctx.ui.theme, {}, done);
    component.focused = true;
    options?.onHandle?.({ setHidden(value: boolean) { hidden = value; } });
  });
  const frame = (width = 96): string[] => component.render(width).map(stripTerminalSequences);
  const press = async (data: string) => {
    await wait(() => component && !hidden);
    const before = frame(), rules = before.flatMap((line, index) => /^─+$/.test(line) ? [index] : []), paints = forces.length;
    const localCancel = before.slice(rules.at(-2)! + 1, rules.at(-1)!).some(line => /搜索：|Search:|正在编辑|Editing/.test(line)) || before.some(line => /待确认|Awaiting confirmation|再按一次|Press again/.test(line));
    component.handleInput(data); await settled();
    if (data === '\x1b' && !localCancel) {
      const expandedChild = before.some(line => /^ +> |^ +[│ ]*│ {2,}(?:> | )|^ {5,}\p{Co}/u.test(line.replace(/^(?:│ )+/, '')));
      await wait(() => forces.length > paints || mounts === disposed || expandedChild && frame().join('\n') !== before.join('\n'));
    }
  };
  const wait = async (predicate: () => boolean) => {
    const deadline = performance.now() + 5000;
    while (!predicate()) { if (performance.now() > deadline) throw new Error('Panel driver timeout'); await settled(); }
  };
  const focus = async (word: string) => {
    await wait(() => component && !hidden);
    // j/k cross zones, so a single downward scan from the first row reaches every dockable row.
    component.handleInput('g');
    for (let at = 0; at < 64; at++) component.handleInput('\x1b[A');
    for (let at = 0; at < 2048; at++) {
      const before = frame(), selected = before.find(line => /^[ │]*> /.test(line));
      if (selected?.includes(word)) return;
      component.handleInput('\x1b[B');
      if (frame().join('\n') === before.join('\n')) throw new Error(`No selectable panel row ${word}: ${before.join('\n')}`);
    }
    throw new Error(`Panel navigation exceeded the row bound: ${word}`);
  };
  const finish = () => { finishes.at(-1)?.(); };
  return { frame, finish, active: () => stripTerminalSequences(component.render(96)[0]?.match(/\x1b\[1m([^\x1b]+)/)?.[1] ?? ''), press, focus, wait, settled, forces, live: () => mounts - disposed, mounts: () => mounts,
    rows: (value: number) => { terminal.rows = value; },
    body: () => { const rendered = frame(), rules = rendered.flatMap((line, index) => /^─+$/.test(line) ? [index] : []); return rendered.slice(rules[0]! + 1, rules.at(-1)!).filter(line => !/^─+$/.test(line)).map(line => line.slice(2).trimEnd()); },
    select: async (word: string) => { await focus(word); const before = frame(), paints = forces.length, parent = before.some(line => /^[ │]*> /.test(line) && line.includes(word)); await press('\r'); await wait(() => forces.length > paints || mounts === disposed || frame().some(line => /待确认|Awaiting confirmation|再按一次确认|Press again to confirm/.test(line)) || parent && frame().join('\n') !== before.join('\n') && frame().some(line => /^[ │]+> |正在编辑|Editing/.test(line))); },
  };
}
