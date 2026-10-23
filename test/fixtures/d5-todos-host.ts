import { loadPublic } from './public-host.ts';
import { STATE_TYPE, emptyState, type WorkflowState, type Feature } from './public-records.ts';

/** Exercise the installed extension's public tool/command/event registration against Pi-shaped records. */
export async function todosHost(initial?: WorkflowState, features: readonly Feature[] = ['todos'], branch?: any[]) {
  const entries: any[] = branch ?? (initial ? [{ type: 'custom', customType: STATE_TYPE, data: structuredClone(initial) }] : []);
  const handlers = new Map<string, Function[]>();
  const tools = new Map<string, any>();
  const commands = new Map<string, any>();
  const sent: { message: any; options?: any }[] = [];
  const notifications: string[] = [];
  let idle = true;
  const pi: any = {
    on(name: string, handler: Function) { handlers.set(name, [...handlers.get(name) ?? [], handler]); return () => {}; },
    registerTool(tool: any) { tools.set(tool.name, tool); },
    registerCommand(name: string, command: any) { commands.set(name, command); },
    registerFlag() {}, getFlag() {},
    appendEntry(customType: string, data: unknown) { entries.push({ type: 'custom', customType, data: structuredClone(data) }); },
    sendMessage(message: any, options?: any) { sent.push({ message, options }); },
    getActiveTools: () => [...tools.keys()], setActiveTools() {}, getAllTools: () => [...tools.values()],
  };
  const ctx: any = {
    cwd: process.cwd(), hasUI: true, mode: 'rpc', isIdle: () => idle,
    sessionManager: { getBranch: () => [...entries], getLeafId: () => String(entries.length), getSessionFile: () => undefined },
    ui: { notify(message: string) { notifications.push(message); }, setWidget() {}, confirm: async () => true, },
  };
  const previousLocale = process.env.LC_ALL;
  process.env.LC_ALL = 'zh-CN';
  try { await loadPublic(pi, features); } finally { if (previousLocale === undefined) delete process.env.LC_ALL; else process.env.LC_ALL = previousLocale; }
  async function emit(name: string, values: Record<string, unknown> = {}) {
    const event = { type: name, ...values };
    const results: unknown[] = [];
    for (const handler of handlers.get(name) ?? []) results.push(await handler(event, ctx));
    return results;
  }
  if (!branch) await emit('session_start');
  const run = async (name: string, params: Record<string, unknown>) => tools.get(name)!.execute('d5-test', params, undefined, undefined, ctx);
  return {
    entries, tools, commands, handlers, sent, notifications, ctx, emit,
    setIdle(value: boolean) { idle = value; },
    state: (): WorkflowState => (entries.findLast(entry => entry.customType === STATE_TYPE)?.data ?? initial ?? emptyState()) as WorkflowState,
    run,
    async call(params: Record<string, unknown>) { return run('todo', params); },
    async command(args: string) { return commands.get('todos').handler(args, ctx); },
    async runCommand(name: string, args: string) { return commands.get(name)!.handler(args, ctx); },
  };
}
