import { existsSync } from 'node:fs';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';

type SessionHandler = (event: unknown, ctx: ExtensionContext) => unknown;
export function createWorkflowIO() {
  const handlers: Record<'session_start' | 'session_tree' | 'session_shutdown', SessionHandler[]> = { session_start: [], session_tree: [], session_shutdown: [] };
  let bound = false, warned = false;
  let branchCache: { manager: ExtensionContext['sessionManager']; leaf: string | null; entries: ReturnType<ExtensionContext['sessionManager']['getBranch']> } | undefined;
  const dispatch = async (name: keyof typeof handlers, event: unknown, ctx: ExtensionContext) => {
    let failure: { cause: unknown } | undefined;
    for (const handler of handlers[name]) {
      try { await handler(event, ctx); } catch (cause) { failure ??= { cause }; }
    }
    if (failure) throw failure.cause;
  };
  return {
    resource(owner: ExtensionAPI): ExtensionAPI {
      if (!bound) {
        // Full Pi reload replaces this runtime. Detaching only this first resource
        // would remove all central listeners; partial resource detach is unsupported.
        bound = true;
        owner.on('session_start', (event, ctx) => dispatch('session_start', event, ctx));
        owner.on('session_tree', (event, ctx) => dispatch('session_tree', event, ctx));
        owner.on('session_shutdown', (event, ctx) => dispatch('session_shutdown', event, ctx));
      }
      return { ...owner, on: ((name: string, handler: SessionHandler) => {
        if (!Object.hasOwn(handlers, name)) return (owner.on as unknown as (event: string, callback: SessionHandler) => () => void)(name, handler);
        const selected = handlers[name as keyof typeof handlers]; selected.push(handler);
        return () => { const index = selected.indexOf(handler); if (index >= 0) selected.splice(index, 1); };
      }) as unknown as ExtensionAPI['on'] };
    },
    branch(ctx: ExtensionContext) {
      const manager = ctx.sessionManager, leaf = typeof manager.getLeafId === 'function' ? manager.getLeafId() : undefined;
      if (leaf !== undefined && branchCache?.manager === manager && branchCache.leaf === leaf) return branchCache.entries;
      const entries = manager.getBranch();
      if (leaf !== undefined) branchCache = { manager, leaf, entries };
      return entries;
    },
    invalidate() { branchCache = undefined; },
    reset() { branchCache = undefined; warned = false; },
    ephemeral(ctx: ExtensionContext) {
      const file = ctx.sessionManager.getSessionFile();
      if (!warned && (!file || !existsSync(file))) { warned = true; return { file }; }
      return undefined;
    },
  };
}
export function appendViewRecord(pi: ExtensionAPI, type: string, data: unknown): void { pi.appendEntry(type, data); }
