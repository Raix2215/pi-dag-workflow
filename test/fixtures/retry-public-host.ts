import { loadPublic } from './public-host.ts';
import { RETRY_TYPE, type Feature } from './public-records.ts';
import type { TestContext } from 'node:test';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

interface FakeModel { provider: string; id: string; name: string; input: string[]; reasoning: boolean }

/** A Pi-shaped session: all behavior comes from loaded public extension factories. */
export async function retryHost(t: TestContext, features: Feature[] = ['retry'], language: 'zh-CN' | 'en' = 'zh-CN') {
  t.mock.timers.reset();
  t.mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'] });
  const base = Date.now();
  const root = await mkdtemp(join(tmpdir(), 'retry-public-'));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = join(root, 'agent');
  await mkdir(join(root, 'agent', 'pi-dag-workflow'), { recursive: true });
  await writeFile(join(root, 'agent', 'pi-dag-workflow', 'pi-dag-workflow-config.json'), JSON.stringify({ language }));
  t.after(async () => { if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous; await rm(root, { recursive: true, force: true }); });
  const handlers = new Map<string, Function[]>(), commands = new Map<string, any>(), tools = new Map<string, any>();
  const entries: any[] = [], notices: string[] = [], sends: any[] = [], requests: any[] = [], answers: any[] = [];
  let leaf = 0, serial = 0, idle = true, pending = false, deferred = false, sendFails = false, writeFails = false, dropWake = false;
  const queue: (() => void)[] = [];
  const catalog = new Map<string, FakeModel>(); const noAuth = new Set<string>(); const rejected = new Set<string>();
  const modelChanges: string[] = []; let model: FakeModel | undefined, thinking: string | undefined = 'high';
  let modelGate: ((target: string) => Promise<void>) | undefined;
  const ref = (value: FakeModel | undefined) => value ? `${value.provider}/${value.id}` : undefined;
  const flush = async () => { for (let index = 0; index < 12; index++) await Promise.resolve(); };
  const ask = async (method: string, title: string, value: unknown) => {
    requests.push({ method, title, value }); const next = answers.shift();
    const result = typeof next === 'function' ? await next({ method, title, value }) : next;
    if (method !== 'select' || result === undefined || result === null) return result;
    const choices = value as string[];
    const normalize = (text: string) => text.replace(/\s+/g, ' ').trim();
    const chosen = choices.find((item) => item === result || normalize(item) === normalize(String(result)) || normalize(item).startsWith(`${normalize(String(result))} `));
    if (!chosen) throw new Error(`No display choice ${String(result)} in ${JSON.stringify(choices)}`);
    return chosen;
  };
  const ctx: any = {
    cwd: root, mode: 'rpc', hasUI: true, signal: undefined as AbortSignal | undefined, isIdle: () => idle, hasPendingMessages: () => pending,
    get model() { return model; },
    modelRegistry: { find: (provider: string, id: string) => catalog.get(`${provider}/${id}`), getAvailable: () => [...catalog.values()].filter((item) => !noAuth.has(ref(item)!)), hasConfiguredAuth: (item: FakeModel) => !noAuth.has(ref(item)!) },
    sessionManager: { getBranch: () => entries, getLeafId: () => String(leaf), getSessionFile: () => undefined },
    ui: { notify: (text: string) => notices.push(text), setWidget() {},
      select: (title: string, value: string[]) => ask('select', title, value), input: (title: string, value: string) => ask('input', title, value),
      editor: (title: string, value: string) => ask('editor', title, value), confirm: (title: string, value: string) => ask('confirm', title, value) },
  };
  const fire = async (name: string, event: any = {}) => { for (const fn of handlers.get(name) ?? []) await fn(event, ctx); };
  const pi: any = {
    on(name: string, fn: Function) { handlers.set(name, [...handlers.get(name) ?? [], fn]); },
    registerCommand(name: string, command: any) { commands.set(name, command); }, registerTool(tool: any) { tools.set(tool.name, tool); }, registerFlag() {}, getFlag() {},
    appendEntry(customType: string, data: unknown) { if (writeFails) throw new Error('write failed'); entries.push({ type: 'custom', customType, data: structuredClone(data) }); leaf++; },
    sendMessage(message: any, options: any) { if (sendFails) throw new Error('send failed'); if (!dropWake) sends.push({ message, options, at: Date.now() - base, model: ref(model) }); },
    sendUserMessage(text: string) { const run = () => { void commands.get('retry').handler(text.slice('/retry '.length), ctx); }; if (deferred) queue.push(run); else run(); },
    getActiveTools: () => ['read', ...tools.keys()], getAllTools: () => [...tools.values()],
    getThinkingLevel: () => thinking,
    setThinkingLevel(level: string) { thinking = model?.reasoning ? level : 'off'; },
    async setModel(target: FakeModel) {
      const key = ref(target)!;
      if (modelGate) await modelGate(key);
      if (rejected.has(key)) return false;
      const previousModel = model; model = target; thinking = model.reasoning ? 'medium' : 'off'; modelChanges.push(key);
      await fire('model_select', { model: target, previousModel, source: 'set' });
      return true;
    },
  };
  await loadPublic(pi, features);
  await fire('session_start');
  const state = () => entries.filter((entry) => entry.customType === RETRY_TYPE).at(-1)?.data;
  const status = async () => { await commands.get('retry').handler('status', ctx); return notices.at(-1) as string; };
  const failure = async (message = '500 provider failed', aborted: boolean | null = false, stopReason = 'error') => {
    entries.push({ type: 'message', id: `failure-${++serial}`, message: { role: 'assistant', stopReason, errorMessage: message } }); leaf++;
    await fire('agent_settled', aborted === null ? {} : { aborted });
  };
  const success = async () => { entries.push({ type: 'message', id: `success-${++serial}`, message: { role: 'assistant', stopReason: 'stop' } }); leaf++; await fire('turn_end', { outcome: 'completed' }); await fire('agent_settled', { aborted: false }); };
  const installModels = (...refs: string[]) => { for (const value of refs) { const at = value.indexOf('/'); const provider = value.slice(0, at), id = value.slice(at + 1); catalog.set(value, { provider, id, name: id, input: ['text'], reasoning: true }); } model ??= catalog.get(refs[0]!); };
  const manualSelect = async (id: string) => { const previous = model; model = catalog.get(id.includes('/') ? id : `test/${id}`); await fire('model_select', { model, previousModel: previous, source: 'cycle' }); };
  return { pi, ctx, handlers, commands, tools, entries, notices, sends, requests, answers, state, status, failure, success, fire,
    cmd: (value = '') => commands.get('retry').handler(value, ctx), menu: () => commands.get('retry').handler('', ctx),
    tick: (ms: number) => t.mock.timers.tick(ms), setIdle(value: boolean) { idle = value; }, setPending(value: boolean) { pending = value; },
    deferCommands() { deferred = true; }, drainCommands() { deferred = false; for (const run of queue.splice(0)) run(); },
    failSend() { sendFails = true; }, failWrite() { writeFails = true; }, silentSend() { dropWake = true; },
    call: (name: string, params: any) => tools.get(name).execute('public retry test', params, undefined, undefined, ctx),
    flush, catalog, modelChanges, noAuth, rejected, installModels, manualSelect, currentModel: () => ref(model), thinking: () => thinking,
    gateModel(fn?: (target: string) => Promise<void>) { modelGate = fn; },
  };
}
