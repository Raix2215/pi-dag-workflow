import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { withMenuScope, panelInput, panelEdit, panelConfirm, panelAlive, type PanelNavigation, type PanelTab } from '../../shared/ui/menu.ts';
import type { Feature } from '../domain/features.ts';
import type { PanelMemory } from '../../shared/ui/panel.ts';
import type { IconStyle } from '../../shared/ui/symbols.ts';
import type { createWorkflow } from '../index.ts';
import { chinese, type Translator } from '../../shared/i18n.ts';
import { notify } from '../../shared/terminal.ts';

const CHANNEL = 'pi-dag-workflow:coordinator:v1';
interface Request { workflow?: ReturnType<typeof createWorkflow> }

/** Pi's runtime-owned bus subscriptions are removed on invalidation/reload.
 * No global singleton, required core entry, or dependency on factory load order. */
export async function connectFeature(pi: ExtensionAPI, feature: Feature): Promise<void> {
  const request: Request = {};
  pi.events.emit(CHANNEL, request);
  if (!request.workflow) {
    const { createWorkflow } = await import('../index.ts');
    pi.events.emit(CHANNEL, request);
    if (!request.workflow) {
      const workflow = createWorkflow(pi);
      const off = pi.events.on(CHANNEL, (data) => { (data as Request).workflow ??= workflow; });
      workflow.onDispose(off);
      request.workflow = workflow;
    }
  }
  await request.workflow.attach(feature, pi);
}

export function createPanelRegistry(order: readonly string[], enabled: (id: string) => boolean, generation: () => number, todoProgress?: () => string, msg: Translator = chinese) {
  const panels = new Map<string, { tab: PanelTab; open: (ctx: ExtensionContext) => Promise<void> }>();
  // Panel memory belongs to the module, not to one open: Esc and reopen restore the cursor, folds and search.
  const memories = new Map<string, Map<string, PanelMemory>>();
  const memoryOf = (id: string) => { let memory = memories.get(id); if (!memory) memories.set(id, memory = new Map()); return memory; };
  /** `STALE_FLIGHT_MS`: how long a flight may sit with no live panel before the registry reclaims it. */
  const STALE_FLIGHT_MS = 2_000;
  let flight: { current: string; next?: string; since: number } | undefined;
  return {
    module(tab: PanelTab, style?: () => IconStyle): PanelNavigation {
      return {
        register(open) { panels.set(tab.id, { tab, open }); },
        ...(style ? { style } : {}),
        input: panelInput, edit: panelEdit, confirm: panelConfirm,
        tabs: () => order.filter(id => enabled(id) && panels.has(id)).map(id => ({ ...panels.get(id)!.tab, label: panels.get(id)!.tab.label + (id === 'todos' && todoProgress ? ` ${todoProgress()}` : '') })),
        memory: () => flight?.current === tab.id ? memoryOf(tab.id) : undefined,
        request(id) { if (flight?.current === tab.id) flight.next = id; },
        requested: () => flight?.current === tab.id && flight.next !== undefined,
        async open(ctx, initial) {
          // A second panel never opens silently on top of an unfinished one, and never blocks silently.
          if (flight) {
            const held = panels.get(flight.current)?.tab.label ?? flight.current;
            // A flight whose panel is already gone must not hold the registry hostage: reclaim it.
            if (!panelAlive(ctx) && Date.now() - flight.since > STALE_FLIGHT_MS) {
              notify(ctx, msg`上一个面板（${held}）已关闭但未释放：已自动恢复，继续打开；若仍异常请 /reload 重载插件`, 'warning');
              flight = undefined;
            } else {
              notify(ctx, msg`另一个面板尚未关闭：先按 Esc 关闭它，或 /reload 重载插件（当前占用：${held}）`, 'warning');
              return;
            }
          }
          const ticket: { current: string; next?: string; since: number } = { current: tab.id, since: Date.now() }, epoch = generation();
          flight = ticket;
          try {
            let target: string | undefined = tab.id;
            while (target && epoch === generation()) {
              ticket.current = target; delete ticket.next;
              const open = initial ?? panels.get(target)!.open; initial = undefined;
              await withMenuScope(ctx, () => open(ctx));
              if (epoch !== generation()) return;
              target = ticket.next;
            }
          } finally {
            // Every close path (Esc, /reload, shutdown, takeover) must leave the registry free again.
            if (flight === ticket) flight = undefined;
          }
        },
      };
    },
  };
}
