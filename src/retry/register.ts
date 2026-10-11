import { randomUUID } from 'node:crypto';
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { chinese, type Translator } from '../shared/i18n.ts';
import { completeArguments } from '../shared/completion.ts';
import { notify } from '../ui/render.ts';
import { safeDiagnostic } from '../agents/diagnostics.ts';
import { emptyRetryState, intervalText, parseCount, parseIntervals, parseRetrySettings, RETRY_MESSAGE, RETRY_TYPE, restoreRetryState, retryDelay, retrySpent, validateRetryState, type RetryState } from './state.ts';

interface Failure { id: string; stopReason: 'error' | 'aborted'; message: string }
interface Hooks {
  msg?: Translator;
  branch(ctx: ExtensionContext): ReturnType<ExtensionContext['sessionManager']['getBranch']>;
  scope(): string;
  mode(): 'normal' | 'plan' | 'goal';
  protected(): boolean;
  failed?(ctx: ExtensionContext, waiting: boolean): void;
  prepare?(ctx: ExtensionContext): boolean;
  undoPrepare?(ctx: ExtensionContext): void;
  beforeRetry?(ctx: ExtensionContext): void;
  now?(): number;
  setTimer?(callback: () => void, ms: number): ReturnType<typeof setTimeout>;
  clearTimer?(timer: ReturnType<typeof setTimeout>): void;
}
/** Commands only. No model tool, prompt catalog, background process or fixed-time job. */
export function registerRetry(pi: ExtensionAPI, hooks: Hooks) {
  const msg = hooks.msg ?? chinese;
  const now = hooks.now ?? Date.now;
  const setTimer = hooks.setTimer ?? setTimeout;
  const clearTimer = hooks.clearTimer ?? clearTimeout;
  let state = emptyRetryState();
  let error: string | undefined;
  let epoch = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let nextAt: number | undefined;
  let failure: Failure | undefined;
  let observedError: Failure | undefined;
  let deliveryToken: string | undefined;
  let dispatching = false;
  let noCancelFailure: string | undefined;
  let owner: string | undefined;
  let requestScope: string | undefined;
  let retired: string | undefined;
  let cancelledFailure: string | undefined;
  let phase = 'off';
  let reason: string | undefined;
  let compacting = false;
  const prompts = new Set<string>();
  let menuOpen = false;
  let issuing = false;
  let starting = false;
  let admitted = false;
  let cache: { manager: ExtensionContext['sessionManager']; leaf: string | null; value: Failure | undefined } | undefined;

  function lastFailure(ctx: ExtensionContext): Failure | undefined {
    const manager = ctx.sessionManager;
    const leaf = typeof manager.getLeafId === 'function' ? manager.getLeafId() : undefined;
    if (leaf !== undefined && cache?.manager === manager && cache.leaf === leaf) return cache.value;
    let value: Failure | undefined;
    for (const entry of [...hooks.branch(ctx)].reverse()) {
      if (entry.type === 'compaction') break;
      if (entry.type !== 'message' || entry.message.role !== 'assistant') continue;
      const item = entry.message;
      if (item.stopReason === 'error' || item.stopReason === 'aborted') value = { id: entry.id, stopReason: item.stopReason, message: safeDiagnostic(item.errorMessage ?? '') };
      break;
    }
    if (leaf !== undefined) cache = { manager, leaf, value };
    return value;
  }
  function save(next: RetryState) {
    if (JSON.stringify(next) === JSON.stringify(state)) return;
    validateRetryState(next, msg);
    pi.appendEntry(RETRY_TYPE, next);
    state = next;
  }
  function clear() {
    if (timer !== undefined) clearTimer(timer);
    timer = undefined; nextAt = undefined;
  }
  function retire(label?: string) {
    clear(); epoch++; starting = false; admitted = false; deliveryToken = undefined;
    if (failure) retired = failure.id;
    failure = undefined; owner = undefined;
    phase = state.enabled ? 'armed' : 'off'; reason = label;
  }
  function success() {
    retire();
    if (state.attempts || state.skipped) save({ ...state, attempts: 0, skipped: 0 });
  }
  const busy = (ctx: ExtensionContext) => !ctx.isIdle() || ctx.hasPendingMessages?.() === true || compacting || menuOpen || prompts.size > 0;
  function schedule(ctx: ExtensionContext) {
    clear();
    const delay = retryDelay(state);
    if (!state.enabled || !failure || delay === undefined || error || hooks.protected()) return;
    if (retrySpent(state)) { phase = 'exhausted'; reason = msg('本轮重试次数已用完'); return; }
    const ownEpoch = epoch;
    nextAt = now() + delay;
    if (!Number.isSafeInteger(nextAt)) { retire(msg('重试时间过大')); return; }
    phase = 'waiting'; reason = undefined;
    function arm() {
      const remaining = nextAt! - now();
      const handle = setTimer(() => {
        if (epoch !== ownEpoch || timer !== handle) return;
        timer = undefined;
        // Node's maximum timer length is about 25 days; clock changes can also fire early.
        if (now() < nextAt!) { arm(); return; }
        nextAt = undefined;
        try { dispatch(); }
        catch (cause) { error = safeDiagnostic(String(cause)); retire(msg('重试记录无法保存，已停止')); phase = 'off'; notify(ctx, error, 'error'); }
      }, Math.max(1, Math.min(2147483647, remaining)));
      timer = handle;
    }
    arm();
  }
  function skip(ctx: ExtensionContext) {
    save({ ...state, skipped: state.skipped + 1 });
    schedule(ctx); // Keep both actual count and interval position; never queue an idle wake.
  }
  function dispatch() {
    // Pi can report idle while still awaiting settled handlers. Commands received then are
    // deferred. A private one-use command checks synchronous delivery without using Pi internals.
    deliveryToken = randomUUID();
    dispatching = true;
    try { pi.sendUserMessage(`/retry ${deliveryToken}`, { expandPromptTemplates: true }); }
    finally { dispatching = false; }
  }
  function startFailed(ctx: ExtensionContext) {
    hooks.undoPrepare?.(ctx);
    retire(msg('重试请求未启动，已停止；请检查模型或扩展错误'));
    phase = 'failed'; hooks.failed?.(ctx, false);
  }
  function watchStart(ctx: ExtensionContext) {
    const ownEpoch = epoch;
    const handle = setTimer(() => {
      if (epoch !== ownEpoch || timer !== handle || !starting) return;
      timer = undefined;
      try {
        if (ctx.isIdle() && ctx.hasPendingMessages?.() !== true) startFailed(ctx);
        else watchStart(ctx);
      } catch (cause) { error = safeDiagnostic(String(cause)); retire(msg('重试记录无法保存，已停止')); phase = 'off'; notify(ctx, error, 'error'); }
    }, 1000);
    timer = handle;
  }
  function fire(ctx: ExtensionContext) {
    if (!state.enabled || !failure || owner !== hooks.scope() || hooks.protected() || error) { retire(msg('工作已改变，旧计时已取消')); return; }
    if (lastFailure(ctx)?.id !== failure.id) { retire(msg('原请求已不再需要重试')); return; }
    if (busy(ctx)) { skip(ctx); return; }
    if (hooks.prepare?.(ctx) === false) { retire(msg('当前工作已暂停或达到上限')); return; }
    hooks.beforeRetry?.(ctx);
    if (busy(ctx)) { hooks.undoPrepare?.(ctx); skip(ctx); return; }
    starting = true; admitted = false; phase = 'starting';
    const number = state.attempts + 1;
    const limit = state.settings?.count === undefined ? msg('不限') : String(state.settings.count);
    try {
      issuing = true;
      pi.sendMessage({ customType: RETRY_MESSAGE, content: `The last model request failed. Continue the current unfinished work in its current mode and permissions. Check existing results before repeating actions. This is error recovery, not new user authorization.\n${msg`重试 ${number}/${limit}。`}`, display: true }, { triggerTurn: true });
      issuing = false;
      if (starting) watchStart(ctx);
    } catch (cause) {
      issuing = false; hooks.undoPrepare?.(ctx); retire(msg('无法发送重试请求'));
      notify(ctx, safeDiagnostic(String(cause)), 'error');
    }
  }
  function cancelled(ctx: ExtensionContext, label: string) {
    cancelledFailure = lastFailure(ctx)?.id;
    retire(label);
    if (cancelledFailure) save({ ...state, cancelledFailure });
  }
  function observe(ctx: ExtensionContext, aborted?: boolean) {
    if (aborted === true || ctx.signal?.aborted) { cancelled(ctx, msg('用户中断，计时已取消')); return; }
    const latest = lastFailure(ctx);
    observedError = latest;
    if (!latest) { if (failure || state.attempts || state.skipped) success(); return; }
    if (latest.id === cancelledFailure) { reason = msg('用户中断的请求不会自动恢复'); return; }
    if (starting && failure?.id === latest.id) { startFailed(ctx); return; }
    // Pi 1.0 cannot rule out a late user cancellation for provider-aborted outcomes.
    if (latest.stopReason === 'aborted' && aborted !== false) { cancelled(ctx, msg('无法确认是否为用户取消，不自动重试')); return; }
    if (latest.stopReason === 'aborted') noCancelFailure = latest.id;
    if (compacting || error || hooks.protected()) return;
    const scope = hooks.scope();
    if (requestScope !== undefined && requestScope !== scope || state.failure?.id === latest.id && state.failure.scope !== scope) { retire(msg('工作已改变，旧请求不再重试')); retired = latest.id; return; }
    if (state.failure?.id !== latest.id) save({ ...state, failure: { id: latest.id, scope } });
    hooks.failed?.(ctx, state.enabled && !retrySpent(state));
    if (scope !== hooks.scope()) { retire(msg('当前工作已暂停或达到上限')); retired = latest.id; return; }
    if (!state.enabled || latest.id === retired) return;
    if (failure?.id === latest.id && (timer !== undefined || starting || phase === 'exhausted')) return;
    clear();
    if (!failure && !admitted && (state.attempts || state.skipped)) save({ ...state, attempts: 0, skipped: 0 });
    failure = latest; owner = hooks.scope(); starting = false; admitted = false;
    schedule(ctx);
  }
  function configure(intervals: number[], count: number | undefined, ctx: ExtensionContext, newRound = true) {
    if (error || hooks.protected()) throw new Error(error ?? msg('工作流状态受保护'));
    retire(); retired = undefined; admitted = !newRound;
    save({ ...state, version: 1, enabled: true, settings: { intervals, ...(count ===undefined ? {} : { count }) }, attempts: newRound ? 0 : state.attempts, skipped: newRound ? 0 : state.skipped });
    phase = 'armed'; reason = undefined;
    // An explicit configuration can recover an existing error, but never a user abort.
    const latest = lastFailure(ctx);
    if (latest && (latest.stopReason === 'error' || latest.id === noCancelFailure) && ctx.isIdle() && !compacting && ctx.hasPendingMessages?.() !== true) observe(ctx, false);
  }
  function off(ctx: ExtensionContext) {
    retire(); save({ ...state, enabled: false }); phase = 'off'; reason = undefined;
    const latest = lastFailure(ctx);
    if (!error && latest && latest.id !== cancelledFailure && ctx.isIdle() && ctx.hasPendingMessages?.() !== true && !compacting) hooks.failed?.(ctx, false);
  }
  function snapshot() {
    return { enabled: state.enabled && !error, mode: hooks.mode(), intervals: state.settings ? intervalText(state.settings) : undefined, count: state.settings?.count ?? null, attempts: state.attempts, skipped: state.skipped, phase, ...(nextAt === undefined ? {} : { nextAt }), ...(reason ? { reason } : {}), ...(observedError?.message ? { lastError: observedError.message } : {}), ...(error ? { error } : {}) };
  }
  async function prompt<T>(title: string, run: () => Promise<T>): Promise<T> {
    prompts.add(title);
    try { return await run(); } finally { prompts.delete(title); }
  }
  async function menu(ctx: ExtensionCommandContext) {
    if (!ctx.hasUI) throw new Error(msg('当前界面没有菜单，请使用 /retry when-error、off 或 status'));
    if (menuOpen) throw new Error(msg('重试菜单已打开'));
    const ownEpoch = epoch;
    menuOpen = true;
    try {
      const toggle = state.enabled ? msg('关闭自动重试') : msg('开启自动重试');
      const editIntervals = msg('修改间隔'); const editCount = msg('修改次数'); const status = msg('查看状态');
      const title = msg`重试恢复 · ${state.enabled ? msg('开启') : msg('关闭')} · ${state.settings ? intervalText(state.settings) : msg('未设置间隔')} · ${state.settings?.count ?? msg('不限')} 次`;
      const choice = await prompt(title, () => ctx.ui.select(title, [toggle, editIntervals, editCount, status, msg('返回')]));
      if (ownEpoch !== epoch || choice === undefined) return;
      if (choice === status) { notify(ctx, JSON.stringify(snapshot(), null, 2), 'info'); return; }
      if (choice === toggle && state.enabled) { off(ctx); return; }
      let intervals = state.settings?.intervals;
      let count = state.settings?.count;
      if (choice === editIntervals || choice === toggle && !intervals) {
        const inputTitle = msg('错误后等待多久？用逗号分隔，例如 5m,30s,10m');
        const input = await prompt(inputTitle, () => ctx.ui.input(inputTitle, state.settings ? intervalText(state.settings) : ''));
        if (input === undefined || ownEpoch !== epoch) return;
        intervals = parseIntervals(input, msg);
      } else if (choice === editCount) {
        const inputTitle = msg('每轮最多重试几次？输入正整数，留空表示不限');
        const input = await prompt(inputTitle, () => ctx.ui.input(inputTitle, count === undefined ? '' : String(count)));
        if (input === undefined || ownEpoch !== epoch) return;
        count = input.trim() ? parseCount(input.trim(), msg) : undefined;
      } else if (choice !== toggle) return;
      if (!intervals) throw new Error(msg('请先设置重试间隔'));
      const confirmTitle = msg('确认重试设置？');
      const enabled = choice === toggle || state.enabled;
      const accepted = await prompt(confirmTitle, () => ctx.ui.confirm(confirmTitle, msg`间隔：${intervalText({ intervals })}；次数：${count ?? msg('不限')}；${enabled ? msg('开启') : msg('关闭')}`));
      if (!accepted || ownEpoch !== epoch) return;
      if (enabled) configure(intervals, count, ctx, choice === toggle);
      else save({ ...state, settings: { intervals, ...(count === undefined ? {} : { count }) } });
    } finally { menuOpen = false; }
  }
  function restore(ctx: ExtensionContext) {
    retire(); cache = undefined; observedError = undefined; error = undefined; retired = undefined; cancelledFailure = undefined; noCancelFailure = undefined; requestScope = undefined; prompts.clear(); menuOpen = false; compacting = false;
    try { state = restoreRetryState(hooks.branch(ctx), msg); cancelledFailure = state.cancelledFailure; phase = 'off'; reason = state.settings ? msg('会话恢复后重试保持关闭') : undefined; }
    catch (cause) { state = emptyRetryState(); error = safeDiagnostic(String(cause)); phase = 'off'; notify(ctx, error, 'error'); }
  }
  pi.registerCommand('retry', {
    description: msg('出错后重试：when-error 间隔列表 [count 次数]、off、status'),
    getArgumentCompletions: (text) => completeArguments(text, { actions: [{ action: 'when-error', description: msg('设置并开启出错后重试') }, { action: 'off', description: msg('关闭并取消计时') }, { action: 'status', description: msg('查看重试状态') }], freeText: ['when-error'] }),
    handler: async (args, ctx) => {
      let internal = false;
      try {
        const [action, ...parts] = args.trim().split(/\s+/);
        if (deliveryToken && action === deliveryToken && !parts.length) {
          internal = true; deliveryToken = undefined;
          if (!state.enabled || !failure) return;
          if (!dispatching) { skip(ctx); return; } // Treat a deferred command as a busy skip.
          fire(ctx); return;
        }
        // A previously cancelled internal command can still be delivered by Pi; ignore it.
        if (action && !parts.length && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(action)) return;
        if (!args.trim()) { await menu(ctx); return; }
        if (action === 'when-error') { const settings = parseRetrySettings(parts, msg); configure(settings.intervals, settings.count, ctx); }
        else if (action === 'off' && !parts.length) off(ctx);
        else if (action !== 'status' || parts.length) throw new Error(msg('用法：/retry [when-error 5m,30s,10m [count 3] | off | status]'));
        notify(ctx, JSON.stringify(snapshot(), null, 2), 'info');
      } catch (cause) {
        if (internal) {
          error = safeDiagnostic(String(cause)); retire(msg('重试记录无法保存，已停止')); phase = 'off';
          try { hooks.undoPrepare?.(ctx); } catch { /* Failed storage cannot be repaired by another write. */ }
        }
        notify(ctx, safeDiagnostic(String(cause)), 'error');
      }
    },
  });
  pi.on('agent_settled', (event, ctx) => observe(ctx, (event as { aborted?: boolean }).aborted));
  pi.on('turn_start', () => {
    requestScope = hooks.scope();
    if (!starting) return;
    clear(); starting = false; admitted = true; phase = 'running';
    save({ ...state, attempts: state.attempts + 1 });
  });
  pi.on('turn_end', (event, ctx) => {
    if (event.outcome === 'aborted' && ctx.signal?.aborted) { cancelled(ctx, msg('用户中断，计时已取消')); return; }
    if (event.outcome === 'completed') { observedError = undefined; if (failure || state.attempts || state.skipped) success(); }
  });
  pi.on('agent_end', (_event, ctx) => { if (ctx.signal?.aborted) cancelled(ctx, msg('用户中断，计时已取消')); });
  pi.on('input', (event) => { if (!issuing && event.source !== 'extension' && !/^\/retry(?:\s|$)/.test(event.text.trim())) retire(msg('收到新输入，旧计时已取消')); });
  pi.on('ui_prompt_start', (event) => { prompts.add(event.title ?? ''); });
  pi.on('ui_prompt_end', (event) => { prompts.delete(event.title ?? ''); });
  pi.on('session_before_compact', () => { compacting = true; clear(); });
  pi.on('session_compact', () => { compacting = false; retire(msg('上下文已改变，旧计时已取消')); cache = undefined; });
  pi.on('session_compact_failed', () => { compacting = false; retire(msg('压缩未完成，旧计时已取消')); });
  const navigation = () => retire(msg('会话已改变，旧计时已取消'));
  pi.on('session_before_switch', navigation);
  pi.on('session_before_fork', navigation);
  pi.on('session_before_tree', navigation);
  pi.on('session_tree', (_event, ctx) => restore(ctx));
  pi.on('session_shutdown', () => { retire(); state = emptyRetryState(); prompts.clear(); menuOpen = false; });
  return { restore, cancel: (label?: string) => retire(label), refreshScope: () => { if (owner !== undefined && owner !== hooks.scope()) retire(msg('工作已改变，旧计时已取消')); }, snapshot, isPrompt: (title: string | undefined) => title !== undefined && prompts.has(title), pending: () => failure !== undefined && (timer !== undefined || deliveryToken !== undefined || starting || admitted) };
}
