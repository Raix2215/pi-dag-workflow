import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import type { Feature } from './features.ts';
import { appendViewRecord } from '../io/session.ts';
import { VIEW_TYPE, emptyViewPreferences, restoreViewPreferences } from './view-state.ts';

export function createViewOwner(hooks: { api(): ExtensionAPI; branch(ctx: ExtensionContext): ReturnType<ExtensionContext['sessionManager']['getBranch']>; paint(ctx: ExtensionContext): void }) {
  let preferences = emptyViewPreferences();
  return {
    state: () => preferences,
    reset() { preferences = emptyViewPreferences(); },
    restore(ctx: ExtensionContext) { try { preferences = restoreViewPreferences(hooks.branch(ctx)); } catch { preferences = emptyViewPreferences(); } },
    set(feature: Feature, show: boolean, ctx: ExtensionContext) {
      if ((preferences.visible[feature] !== false) === show) return;
      const next = { ...preferences, visible: { ...preferences.visible, [feature]: show } };
      appendViewRecord(hooks.api(), VIEW_TYPE, next); preferences = next; hooks.paint(ctx);
    },
  };
}
