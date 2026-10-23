import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripTerminalSequences } from '@earendil-works/pi-tui';
import { loadPublic } from './public-host.ts';
import { AGENTS_TYPE, STATE_TYPE, emptyState, retainedJobs, type Feature, type WorkflowState } from './public-records.ts';

/** Public extension registration, native records and an optional OS child-process transport fixture. */
export async function protocolHost(options: { root?: string; state?: WorkflowState; entries?: any[]; features?: Feature[]; idle?: boolean; wakeFails?: boolean; cli?: string; language?: 'en' | 'zh-CN'; tools?: () => any[]; thinking?: () => string; activeTools?: () => string[]; childProvider?: string | false } = {}) {
  const root = options.root ?? await mkdtemp(join(tmpdir(), 'dag-protocol-public-'));
  const oldDirectory = process.env.PI_CODING_AGENT_DIR;
  const oldLocale = process.env.LC_ALL;
  const oldLog = process.env.PI_DAG_TEST_CHILD_CONTEXT_LOG;
  const directory = join(root, 'agent', 'pi-dag-workflow');
  process.env.PI_CODING_AGENT_DIR = join(root, 'agent');
  process.env.LC_ALL = options.language ?? 'en';
  const log = join(root, 'child-context.jsonl');
  process.env.PI_DAG_TEST_CHILD_CONTEXT_LOG = log;
  await mkdir(directory, { recursive: true });
  const events = new Map<string, Function[]>(), tools = new Map<string, any>(), commands = new Map<string, any>();
  const entries: any[] = structuredClone(options.entries ?? (options.state ? [{ type: 'custom', customType: STATE_TYPE, data: options.state }] : []));
  const appended: any[] = [], notifications: string[] = [], sent: any[] = [], userMessages: string[] = [], widgets = new Map<string, string[]>();
  let leaf = 0;
  const append = (entry: any) => { entries.push(structuredClone(entry)); appended.push(structuredClone(entry)); leaf++; };
  const originalSpawn = childProcess.spawn;
  if (options.cli) {
    childProcess.spawn = ((command: string, args: string[], settings: any) => originalSpawn(command, [options.cli!, ...args.slice(1)], settings)) as typeof childProcess.spawn;
    syncBuiltinESMExports();
  }
  const model = { provider: 'dag-test', id: 'scripted' };
  const pi: any = {
    on(name: string, handler: Function) { events.set(name, [...events.get(name) ?? [], handler]); return () => {}; },
    registerTool(tool: any) { tools.set(tool.name, tool); }, registerCommand(name: string, command: any) { commands.set(name, command); },
    registerFlag() {}, getFlag: (name: string) => name === 'dag-workflow-test-child-provider' ? (options.childProvider === false ? undefined : options.childProvider ?? fileURLToPath(new URL('./offline-model.ts', import.meta.url))) : undefined,
    appendEntry(customType: string, data: unknown) { append({ type: 'custom', customType, data }); },
    sendMessage(message: any, settings: any) {
      sent.push({ message, settings });
      if (options.wakeFails) throw new Error('wake transport unavailable');
      append({ type: 'custom_message', ...message });
      for (const handler of events.get('context') ?? []) handler({ messages: [{ role: 'custom', ...message }] }, ctx);
    }, sendUserMessage(text: string) { userMessages.push(text); },
    getThinkingLevel: () => options.thinking?.() ?? 'off', getActiveTools: () => options.activeTools?.() ?? ['read'],
    getAllTools: options.tools ?? (() => ['read', 'grep', 'find', 'ls', 'bash', 'write', 'edit', 'powershell'].map(name => ({ name, description: name, sourceInfo: { path: `builtin:${name}` } }))),
    setActiveTools() {},
  };
  const ctx: any = { cwd: root, mode: 'rpc', hasUI: false, model, isIdle: () => options.idle ?? false,
    modelRegistry: { find: (provider: string, id: string) => provider === 'dag-test' && ['scripted', 'reasoned', 'family/reasoned'].includes(id) ? { provider, id, reasoning: id !== 'scripted', api: 'dag-test-api' } : undefined, getAvailable: () => [model] },
    sessionManager: { getBranch: () => [...entries], getLeafId: () => String(leaf), getSessionFile: () => undefined },
    ui: {
      notify(message: string) { notifications.push(message); },
      // The widget is rendered for real here: a test that changes the view can read what the host would draw.
      setWidget(key: string, content: any) {
        if (typeof content !== 'function') { widgets.set(key, Array.isArray(content) ? content : []); return; }
        try {
          const component = content({ terminal: { columns: 100, rows: 30 }, requestRender() {} }, undefined);
          widgets.set(key, component.render(100).map((line: string) => stripTerminalSequences(line)));
        } catch (cause) { if (process.env.DBG_WIDGET) console.error('WIDGET-ERR', String(cause)); widgets.set(key, []); }
      },
      confirm: async () => false, select: async () => undefined,
    },
  };
  await loadPublic(pi, options.features ?? ['agents']);
  async function emit(name: string, event: any = {}) {
    let result: any;
    for (const handler of events.get(name) ?? []) { const next = await handler(event, ctx); if (next) { Object.assign(event, next); result = next; } }
    return result;
  }
  const execute = (name: string, args: any) => tools.get(name).execute('protocol-test', args, undefined, undefined, ctx);
  async function call(name: string, args: any) {
    const result = await execute(name, args);
    if (result.isError) throw new Error(result.content.map((item: any) => item.text ?? '').join('\n'));
    return result.details;
  }
  await emit('session_start');
  return { root, directory, log, pi, ctx, tools, commands, events, entries, appended, notifications, sent, userMessages, widgets, options, emit, execute, call,
    jobs: (): any[] => retainedJobs(entries).records,
    state: (): WorkflowState => entries.findLast(entry => entry.customType === STATE_TYPE)?.data ?? emptyState(),
    async profiles(value: any[]) { await writeFile(join(directory, 'pi-dag-workflow-profile.json'), JSON.stringify({ profiles: value })); },
    async restore(jobs: any[], nextId?: number) { append({ type: 'custom', customType: AGENTS_TYPE, data: { version: 1, jobs, ...(nextId === undefined ? {} : { nextId }) } }); await emit('session_tree'); },
    async accept(boundary: any, visible = true) { for (const entry of boundary.entries) append(entry); await emit('context', { messages: visible ? boundary.entries.map((entry: any) => ({ role: 'custom', ...entry })) : [] }); },
    async close() {
      try { await emit('session_shutdown'); } finally {
        childProcess.spawn = originalSpawn; syncBuiltinESMExports();
        for (const [key, value] of [['PI_CODING_AGENT_DIR', oldDirectory], ['LC_ALL', oldLocale], ['PI_DAG_TEST_CHILD_CONTEXT_LOG', oldLog]]) { if (value === undefined) delete process.env[key!]; else process.env[key!] = value; }
        if (!options.root) await rm(root, { recursive: true, force: true });
      }
    },
  };
}
