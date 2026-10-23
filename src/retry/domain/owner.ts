import { randomUUID } from 'node:crypto';
import type { ExtensionAPI, ExtensionContext, ExtensionEvent } from '@earendil-works/pi-coding-agent';
import { chinese, type Translator } from '../../shared/i18n.ts';
import { notify } from "../../shared/terminal.ts";
import { normalizeRetrySettings, defaultRetrySettings, defaultRetryModels, modelRefText, type RetryModels, type RetryModelRef, emptyRetryState, intervalText, RETRY_MESSAGE, RETRY_TYPE, restoreRetryState, retryDelay, retrySpent, validateRetryState, type RetryState } from './state.ts';

interface Failure { id: string; stopReason: 'error' | 'aborted'; message: string }
export interface Hooks {
  diagnostic(value: string, limit?: number): string;
  onChanged?(ctx: ExtensionContext): void;
  summary?(): boolean;
  setSummary?(visible: boolean, ctx: ExtensionContext): void;
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
import { retryIO } from '../io/host.ts';
type Handler<Name extends ExtensionEvent['type']> = (event: Extract<ExtensionEvent, { type: Name }>, ctx: ExtensionContext) => unknown;

export function createRetryOwner(pi: ExtensionAPI, hooks: Hooks) {
  const io = retryIO(pi, hooks);
  const safeDiagnostic = hooks.diagnostic;
const msg = hooks.msg ?? chinese;
const { now, setTimer, clearTimer } = io;
let state = emptyRetryState();
let restoredContext: ExtensionContext | undefined;
let error: string | undefined;
let epoch = 0;
let sessionGeneration = 0;
let roundModels: { base: RetryModelRef; used: Map<string, number>; skipped: Set<string> } | undefined;
let startingModel: string | undefined;
let selectedModel: string | undefined;
type SessionModel = Parameters<ExtensionAPI['setModel']>[0];
let switching: { target: SessionModel; previous: SessionModel | undefined; epoch: number; generation: number; thinking: ReturnType<ExtensionAPI['getThinkingLevel']> | undefined } | undefined;
let preferredModel: { model: SessionModel; generation: number; context: ExtensionContext; thinking: ReturnType<ExtensionAPI['getThinkingLevel']> | undefined } | undefined;
let settingsRevision = 0;
let timer: ReturnType<typeof setTimeout> | undefined;
let nextAt: number | undefined;
let failure: Failure | undefined;
let observedError: Failure | undefined;
let deliveryToken: string | undefined;
let dispatching = false;
let owner: string | undefined;
let requestScope: string | undefined;
let retired: string | undefined;
let cancelledFailure: string | undefined;
let phase = 'off';
let reason: string | undefined;
let compacting = false;
// Live compaction may hide a failure before settlement. Never persist this recovery ticket.
let compactionRecovery: { failure: Failure; scope: string; models: typeof roundModels; boundary?: string } | undefined;
const prompts = new Set<string>();
let menuSession: object | undefined;
const ownedPrompts = new Map<string, Set<object>>();
const closeMenu = () => { menuSession = undefined; ownedPrompts.clear(); };
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
      if (entry.type === 'compaction') {
        if (compactionRecovery?.boundary === entry.id && compactionRecovery.scope === hooks.scope()) value = compactionRecovery.failure;
        break;
      }
      if (entry.type !== 'message' || entry.message.role !== 'assistant') continue;
      const item = entry.message;
      if (item.stopReason === 'error' || item.stopReason === 'aborted') value = { id: entry.id, stopReason: item.stopReason, message: safeDiagnostic(item.errorMessage ?? '') };
      break;
    }
    if (leaf !== undefined) cache = { manager, leaf, value };
    return value;
  }
function save(next: RetryState) {
    validateRetryState(next, msg);
    if (next.settings) next = { ...next, settings: normalizeRetrySettings(next.settings) };
    if (JSON.stringify(next) === JSON.stringify(state)) return;
    io.append(RETRY_TYPE, next);
    state = next;
  }
function clear() {
    if (timer !== undefined) clearTimer(timer);
    timer = undefined; nextAt = undefined;
  }
function retire(label?: string) {
    clear(); epoch++; starting = false; admitted = false; deliveryToken = undefined;
    if (failure) retired = failure.id;
    failure = undefined; owner = undefined; roundModels = undefined; startingModel = undefined; compactionRecovery = undefined; cache = undefined;
    phase = state.enabled ? 'armed' : 'off'; reason = label;
  }
function success() {
    retire();
    if (state.attempts || state.skipped) save({ ...state, attempts: 0, skipped: 0 });
  }
const busy = (ctx: ExtensionContext) => switching !== undefined || !ctx.isIdle() || ctx.hasPendingMessages?.() === true || compacting || menuSession !== undefined || prompts.size > 0;
function schedule(ctx: ExtensionContext) {
    clear();
    const delay = retryDelay(state);
    if (!state.enabled || !failure || error || hooks.protected()) return;
    if (delay === undefined) { phase = 'failed'; reason = msg('未设置重试间隔：使用 /retry when-error 30s,2m 设置并开启'); notify(ctx, reason, 'warning'); hooks.failed?.(ctx, false); hooks.onChanged?.(ctx); return; }
    if (retrySpent(state)) { phase = 'exhausted'; reason = msg('本轮重试次数已用完'); hooks.onChanged?.(ctx); return; }
    if (state.models?.enabled && !nextModel(ctx)) { phase = 'exhausted'; reason = msg('替代模型候选已用完，自动恢复已停止'); notify(ctx, reason, 'warning'); hooks.failed?.(ctx, false); hooks.onChanged?.(ctx); return; }
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
        try { if (busy(ctx)) skip(ctx); else dispatch(); }
        catch (cause) { error = safeDiagnostic(String(cause)); retire(msg('重试记录无法保存，已停止')); phase = 'off'; notify(ctx, error, 'error'); }
        hooks.onChanged?.(ctx);
      }, Math.max(1, Math.min(2147483647, remaining)));
      timer = handle;
    }
    arm(); hooks.onChanged?.(ctx);
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
    try { io.sendUser(`/retry ${deliveryToken}`, { expandPromptTemplates: true }); }
    finally { dispatching = false; }
  }
function startFailed(ctx: ExtensionContext) {
    hooks.undoPrepare?.(ctx);
    retire(msg('重试请求未启动，已停止；使用 /retry status 查看原因，/retry off 停止自动重试'));
    phase = 'failed'; hooks.failed?.(ctx, false); hooks.onChanged?.(ctx);
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
function needsImages(ctx: ExtensionContext): boolean {
    const branch = hooks.branch(ctx), compaction = branch.findLast((entry) => entry.type === 'compaction');
    const first = compaction?.type === 'compaction' ? branch.findIndex((entry) => entry.id === compaction.firstKeptEntryId) : 0;
    return branch.slice(Math.max(0, first)).some((entry) => entry.type === 'message' && 'content' in entry.message && Array.isArray(entry.message.content) && entry.message.content.some((part) => part.type === 'image'));
  }
function nextModel(ctx: ExtensionContext): SessionModel | undefined {
    if (!state.models?.enabled || !ctx.model) return;
    roundModels ??= { base: { provider: ctx.model.provider, id: ctx.model.id }, used: new Map(), skipped: new Set() };
    const candidates = [roundModels.base, ...state.models.candidates], seen = new Set<string>();
    for (const ref of candidates) {
      const key = modelRefText(ref);
      if (seen.has(key) || roundModels.skipped.has(key) || (roundModels.used.get(key) ?? 0) >= state.models.after) continue;
      seen.add(key);
      const model = ctx.modelRegistry.find(ref.provider, ref.id);
      const why = !model ? msg('模型已不存在') : !ctx.modelRegistry.hasConfiguredAuth(model) ? msg('未配置模型鉴权') : !model.input.includes('image') && needsImages(ctx) ? msg('模型不支持当前图像输入') : undefined;
      if (why) { roundModels.skipped.add(key); notify(ctx, msg`跳过替代模型 ${key}：${why}`, 'warning'); continue; }
      return model;
    }
    return;
  }
async function reconcileCancelledSwitch(ticket: NonNullable<typeof switching>, ctx: ExtensionContext) {
    // Each public setter can itself be superseded. Re-read the latest selection after every
    // await, using the current event context, not the original branch's model. Bound this
    // metadata-only compensation; it never re-arms recovery or consumes model attempts.
    for (let attempt = 0; attempt < 4; attempt++) {
      const preferred = preferredModel?.generation === sessionGeneration ? preferredModel : undefined;
      const current = preferred?.context ?? ctx;
      const replacement = preferred?.model ?? (ticket.generation === sessionGeneration ? ticket.previous : undefined);
      if (!replacement || current.model !== ticket.target || current.model === replacement) return;
      ticket.target = replacement;
      try {
        if (!await io.setModel(replacement)) { notify(ctx, msg('无法恢复用户模型选择；自动恢复保持停止，请核对当前模型'), 'warning'); return; }
      } catch { notify(ctx, msg('无法恢复用户模型选择；自动恢复保持停止，请核对当前模型'), 'warning'); return; }
      if (preferred === preferredModel && (preferred?.generation ?? ticket.generation) === sessionGeneration && current.model === replacement) {
        const thinking = preferred ? preferred.thinking : ticket.thinking;
        if (thinking !== undefined) io.setThinking(thinking);
        return;
      }
    }
    notify(ctx, msg('模型切换被连续抢占；自动恢复保持停止，请核对当前模型'), 'warning');
  }
async function selectRecoveryModel(ctx: ExtensionContext): Promise<boolean> {
    const ownEpoch = epoch;
    for (let tried = 0; tried <= 8; tried++) {
      const model = nextModel(ctx);
      if (!model) { phase = 'exhausted'; reason = msg('替代模型候选已用完，自动恢复已停止'); notify(ctx, reason, 'warning'); hooks.failed?.(ctx, false); return false; }
      if (modelRefText(model) === (ctx.model && modelRefText(ctx.model))) { startingModel = modelRefText(model); return true; }
      const ticket = { target: model, previous: ctx.model, epoch: ownEpoch, generation: sessionGeneration, thinking: io.thinking() };
      switching = ticket; phase = 'switching'; hooks.onChanged?.(ctx);
      try {
        const selected = await io.setModel(model);
        if (epoch !== ownEpoch || ticket.generation !== sessionGeneration) {
          await reconcileCancelledSwitch(ticket, ctx);
          return false;
        }
        if (!selected) throw new Error(msg('未配置模型鉴权'));
        if (ticket.thinking !== undefined) io.setThinking(ticket.thinking);
        startingModel = modelRefText(model);
        notify(ctx, msg`重试已切换到 ${modelRefText(model)} · ${io.thinking() ?? '-'}`, 'info');
        return true;
      } catch (cause) {
        if (epoch !== ownEpoch || ticket.generation !== sessionGeneration) return false;
        roundModels?.skipped.add(modelRefText(model)); notify(ctx, msg`跳过替代模型 ${modelRefText(model)}：${safeDiagnostic(String(cause))}`, 'warning');
      } finally { if (switching === ticket) switching = undefined; }
    }
    return false;
  }
async function fire(ctx: ExtensionContext) {
    if (!state.enabled || !failure || owner !== hooks.scope() || hooks.protected() || error) { retire(msg('工作已改变，旧计时已取消')); return; }
    if (lastFailure(ctx)?.id !== failure.id) { retire(msg('原请求已不再需要重试')); return; }
    if (busy(ctx)) { skip(ctx); return; }
    if (state.models?.enabled) {
      const ownEpoch = epoch, ownFailure = failure.id;
      if (!await selectRecoveryModel(ctx)) return;
      if (ownEpoch !== epoch || failure?.id !== ownFailure || owner !== hooks.scope() || !state.enabled || hooks.protected() || error) return;
      if (retrySpent(state)) { phase = 'exhausted'; reason = msg('本轮重试次数已用完'); hooks.failed?.(ctx, false); return; }
      if (busy(ctx)) { startingModel = undefined; skip(ctx); return; }
    }
    if (hooks.prepare?.(ctx) === false) { retire(msg('当前工作已暂停或达到上限')); return; }
    hooks.beforeRetry?.(ctx);
    if (busy(ctx)) { hooks.undoPrepare?.(ctx); skip(ctx); return; }
    starting = true; admitted = false; phase = 'starting'; hooks.onChanged?.(ctx);
    const number = state.attempts + 1;
    const limit = state.settings?.count === undefined ? 'unlimited' : String(state.settings.count);
    try {
      issuing = true;
      io.send({ customType: RETRY_MESSAGE, content: `The last model request failed. Continue the current unfinished work in its current mode and permissions. Check existing results before repeating actions. This is error recovery, not new user authorization.\nRetry attempt ${number}/${limit}.`, display: true }, { triggerTurn: true });
      issuing = false;
      if (starting) watchStart(ctx);
    } catch (cause) {
      issuing = false; hooks.undoPrepare?.(ctx); retire(msg('无法发送重试请求'));
      notify(ctx, safeDiagnostic(String(cause)), 'error'); hooks.onChanged?.(ctx);
    }
  }
function cancelled(ctx: ExtensionContext, label: string) {
    cancelledFailure = lastFailure(ctx)?.id;
    retire(label);
    if (cancelledFailure) save({ ...state, cancelledFailure });
    hooks.onChanged?.(ctx);
  }
function observe(ctx: ExtensionContext, aborted?: boolean) {
    if (ctx.signal?.aborted) { cancelled(ctx, msg('用户中断，计时已取消')); return; }
    if (compacting) return;
    const latest = lastFailure(ctx);
    observedError = latest; selectedModel = ctx.model ? modelRefText(ctx.model) : undefined;
    if (!latest) { if (aborted === true) cancelled(ctx, msg('无法确认是否为用户取消，不自动重试')); else if (failure || state.attempts || state.skipped) success(); return; }
    if (latest.id === cancelledFailure) { reason = msg('用户中断的请求不会自动恢复'); return; }
    if (starting && failure?.id === latest.id) { startFailed(ctx); return; }
    // A provider may label a broken stream as aborted. Only an empty outcome is ambiguous.
    if (!latest.message.trim()) { cancelled(ctx, msg('无法确认是否为用户取消，不自动重试')); return; }
    if (compacting || error || hooks.protected()) return;
    const scope = hooks.scope();
    if (requestScope !== undefined && requestScope !== scope || state.failure?.id === latest.id && state.failure.scope !== scope) { retire(msg('工作已改变，旧请求不再重试')); retired = latest.id; hooks.failed?.(ctx, false); return; }
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
    settingsRevision++; retire(); retired = undefined; admitted = !newRound;
    save({ ...state, version: 1, enabled: true, settings: { intervals, ...(count ===undefined ? {} : { count }), resumeAfterCompaction: normalizeRetrySettings(state.settings).resumeAfterCompaction }, attempts: newRound ? 0 : state.attempts, skipped: newRound ? 0 : state.skipped });
    phase = 'armed'; reason = undefined;
    // An explicit configuration can recover an existing error, but never a user abort.
    const latest = lastFailure(ctx);
    if (latest && ctx.isIdle() && !compacting && ctx.hasPendingMessages?.() !== true) observe(ctx);
    hooks.onChanged?.(ctx);
  }
function off(ctx: ExtensionContext) {
    settingsRevision++; retire(); save({ ...state, enabled: false }); phase = 'off'; reason = undefined;
    const latest = lastFailure(ctx);
    if (!error && latest && latest.id !== cancelledFailure && ctx.isIdle() && ctx.hasPendingMessages?.() !== true && !compacting) hooks.failed?.(ctx, false);
    hooks.onChanged?.(ctx);
  }
function snapshot() {
    return { enabled: state.enabled && !error, mode: hooks.mode(), resumeAfterCompaction: normalizeRetrySettings(state.settings).resumeAfterCompaction, ...(state.models ? { models: { ...structuredClone(state.models), current: selectedModel, attemptsInModel: roundModels ? Object.fromEntries(roundModels.used) : {} } } : {}), intervals: state.settings ? intervalText(state.settings) : undefined, count: state.settings?.count ?? null, attempts: state.attempts, skipped: state.skipped, phase, ...(nextAt === undefined ? {} : { nextAt }), ...(reason ? { reason } : {}), ...(observedError?.message ? { lastError: observedError.message } : {}), ...(error ? { error } : {}) };
  }
async function prompt<T>(title: string, run: () => Promise<T>): Promise<T> {
    const ticket = {}; const owners = ownedPrompts.get(title) ?? new Set<object>();
    owners.add(ticket); ownedPrompts.set(title, owners);
    try { return await run(); } finally {
      owners.delete(ticket);
      if (ownedPrompts.get(title) === owners && !owners.size) ownedPrompts.delete(title);
    }
  }
function editSettings(intervals: number[], count: number | undefined, ctx: ExtensionContext, resumeAfterCompaction = normalizeRetrySettings(state.settings).resumeAfterCompaction) {
    if (error || hooks.protected()) throw new Error(error ?? msg('工作流状态受保护'));
    const intervalChanged = !state.settings || state.settings.intervals.length !== intervals.length || state.settings.intervals.some((value, index) => value !== intervals[index]);
    if (!intervalChanged && state.settings?.count === count && state.settings?.resumeAfterCompaction === resumeAfterCompaction) return;
    save({ ...state, settings: { intervals, ...(count === undefined ? {} : { count }), resumeAfterCompaction } }); settingsRevision++;
    if (state.enabled && failure && !starting && !admitted) {
      if (retrySpent(state)) { clear(); phase = 'exhausted'; reason = msg('本轮重试次数已用完'); hooks.failed?.(ctx, false); }
      else if (intervalChanged || phase === 'exhausted') schedule(ctx);
    }
    hooks.onChanged?.(ctx);
  }
function restore(ctx: ExtensionContext) {
    restoredContext = ctx;
    sessionGeneration++; preferredModel = undefined; selectedModel = ctx.model ? modelRefText(ctx.model) : undefined; retire(); cache = undefined; observedError = undefined; error = undefined; retired = undefined; cancelledFailure = undefined; requestScope = undefined; prompts.clear(); closeMenu(); compacting = false;
    try { state = restoreRetryState(hooks.branch(ctx), msg); if (state.settings || state.enabled) save({ ...state, settings: state.settings ?? defaultRetrySettings() }); cancelledFailure = state.cancelledFailure; phase = state.enabled ? 'armed' : 'off'; reason = undefined; }
    catch (cause) { state = emptyRetryState(); error = safeDiagnostic(String(cause)); phase = 'off'; notify(ctx, error, 'error'); }
    hooks.onChanged?.(ctx);
  }
const navigation = () => { sessionGeneration++; closeMenu(); retire(msg('会话已改变，旧计时已取消')); };

  function setModels(next: RetryModels, ctx: ExtensionContext) { save({ ...state, models: structuredClone(next) }); settingsRevision++; selectedModel = ctx.model ? modelRefText(ctx.model) : undefined;
    roundModels?.skipped.clear();
    // Policy edits keep global usage and the remaining countdown. Only an exhausted chain
    // with newly available allowance needs another interval; cancelled work never rearms.
    if (failure && state.enabled && phase === 'exhausted' && !retrySpent(state)) schedule(ctx);
    hooks.onChanged?.(ctx);
 }
  function disableModels(ctx: ExtensionContext) { const before = state.models ?? defaultRetryModels();       if (error || hooks.protected()) throw new Error(error ?? msg('工作流状态受保护'));
      save({ ...state, models: { ...before, enabled: false } }); settingsRevision++;
      if (switching) retire(msg('模型替代已关闭，旧恢复已取消'));
      else if (failure && state.enabled && phase === 'exhausted' && !retrySpent(state)) schedule(ctx);
      hooks.onChanged?.(ctx);
 }
  function openMenu() {
    if (menuSession) throw new Error(msg('重试菜单已打开'));
    const session = {}, scope = hooks.scope(); menuSession = session;
    return { active: () => menuSession === session && scope === hooks.scope(), close() { if (menuSession === session) menuSession = undefined; } };
  }

return { restore, cancel: (label?: string) => { retire(label); if (restoredContext) hooks.onChanged?.(restoredContext); }, refreshScope: (ctx?: ExtensionContext) => { if (owner !== undefined && owner !== hooks.scope()) { retire(msg('工作已改变，旧计时已取消')); if (ctx) hooks.failed?.(ctx, false); } }, snapshot, isPrompt: (title: string | undefined) => title !== undefined && (ownedPrompts.get(title)?.size ?? 0) > 0, pending: () => failure !== undefined && (timer !== undefined || deliveryToken !== undefined || starting || admitted || switching?.epoch === epoch) ,
    get state() { return state; }, get error() { return error; }, get settingsRevision() { return settingsRevision; }, get sessionGeneration() { return sessionGeneration; }, get starting() { return starting; }, get admitted() { return admitted; }, get switching() { return switching; }, get failure() { return failure; },
    configure, off, editSettings, setModels, disableModels, openMenu, prompt,
    enable(ctx: ExtensionContext) { if (!state.enabled || !state.settings) { const settings = state.settings ?? defaultRetrySettings(); configure(settings.intervals, settings.count, ctx); } },
    stop(ctx: ExtensionContext) { cancelled(ctx, msg('用户停止本轮恢复')); hooks.failed?.(ctx, false); hooks.onChanged?.(ctx); },
    isDelivery(action: string | undefined, parts: string[]) { return !!deliveryToken && action === deliveryToken && !parts.length; },
    async deliver(ctx: ExtensionContext) { deliveryToken = undefined; if (!state.enabled || !failure) return; if (!dispatching) { skip(ctx); return; } await fire(ctx); },
    internalFailed(cause: unknown, ctx: ExtensionContext) { error = safeDiagnostic(String(cause)); retire(msg('重试记录无法保存，已停止')); phase = 'off'; try { hooks.undoPrepare?.(ctx); } catch {} hooks.onChanged?.(ctx); },
    onAgentSettled: ((event, ctx) => { observe(ctx, event.aborted); hooks.onChanged?.(ctx); }) satisfies Handler<'agent_settled'>,
    onTurnStart: ((_event, ctx) => {
    requestScope = hooks.scope();
    compactionRecovery = undefined; cache = undefined;
    if (!starting) return;
    clear(); starting = false; admitted = true; phase = 'running';
    save({ ...state, attempts: state.attempts + 1 });
    if (roundModels && startingModel) roundModels.used.set(startingModel, (roundModels.used.get(startingModel) ?? 0) + 1);
    startingModel = undefined; hooks.onChanged?.(ctx);
  }) satisfies Handler<'turn_start'>,
    onTurnEnd: ((event, ctx) => {
    if (event.outcome === 'aborted' && ctx.signal?.aborted) { cancelled(ctx, msg('用户中断，计时已取消')); return; }
    if (event.outcome === 'completed') { observedError = undefined; if (failure || state.attempts || state.skipped) success(); }
    hooks.onChanged?.(ctx);
  }) satisfies Handler<'turn_end'>,
    onAgentEnd: ((_event, ctx) => { if (ctx.signal?.aborted) cancelled(ctx, msg('用户中断，计时已取消')); }) satisfies Handler<'agent_end'>,
    onInput: ((event, ctx) => { if (!issuing && event.source !== 'extension' && !/^\/retry(?:\s|$)/.test(event.text.trim())) { closeMenu(); retire(msg('收到新输入，旧计时已取消')); retired = lastFailure(ctx)?.id; hooks.onChanged?.(ctx); } }) satisfies Handler<'input'>,
    onModelSelect: ((event, ctx) => {
    selectedModel = modelRefText(ctx.model ?? event.model);
    if (event.source === 'set' && switching?.target === event.model) {
      // A late setter in a newly restored branch may be the first model event there.
      // Its actual previousModel is that branch's selection, not our saved old baseline.
      if (switching.generation !== sessionGeneration && preferredModel?.generation !== sessionGeneration && event.previousModel) preferredModel = { model: event.previousModel, generation: sessionGeneration, context: ctx, thinking: undefined };
      return;
    }
    preferredModel = { model: event.model, generation: sessionGeneration, context: ctx, thinking: io.thinking() };
    retire(msg('模型已手动切换，旧恢复已取消')); retired = lastFailure(ctx)?.id; hooks.onChanged?.(ctx);
  }) satisfies Handler<'model_select'>,
    onUiPromptStart: ((event) => { prompts.add(event.title ?? ''); }) satisfies Handler<'ui_prompt_start'>,
    onUiPromptEnd: ((event) => { prompts.delete(event.title ?? ''); }) satisfies Handler<'ui_prompt_end'>,
    onSessionBeforeCompact: ((_event, ctx) => {
      const latest = lastFailure(ctx);
      // Active/handed-off Goals already own their compaction continuation; do not add a second driver.
      compactionRecovery = state.enabled && hooks.mode() !== 'goal' && !ctx.signal?.aborted && latest?.message.trim() && latest.id !== retired && latest.id !== cancelledFailure
        ? { failure: latest, scope: hooks.scope(), models: roundModels } : undefined;
      closeMenu(); compacting = true; clear(); hooks.onChanged?.(ctx);
    }) satisfies Handler<'session_before_compact'>,
    onSessionCompact: ((event, ctx) => {
      compacting = false;
      if (compactionRecovery?.boundary && compactionRecovery.boundary === event.compactionEntry?.id) return;
      const recovery = compactionRecovery;
      retire(msg('上下文已改变，旧计时已取消'));
      if (recovery && !event.willRetry && state.enabled && normalizeRetrySettings(state.settings).resumeAfterCompaction && recovery.scope === hooks.scope() && !ctx.signal?.aborted) {
        compactionRecovery = { ...recovery, boundary: event.compactionEntry.id };
        failure = recovery.failure; owner = recovery.scope; roundModels = recovery.models; retired = undefined;
        observe(ctx);
      }
      hooks.onChanged?.(ctx);
    }) satisfies Handler<'session_compact'>,
    onSessionCompactFailed: ((_event, ctx) => { compacting = false; retire(msg('压缩未完成，旧计时已取消')); hooks.onChanged?.(ctx); }) satisfies Handler<'session_compact_failed'>,
    onSessionBeforeSwitch: (navigation) satisfies Handler<'session_before_switch'>,
    onSessionBeforeFork: (navigation) satisfies Handler<'session_before_fork'>,
    onSessionBeforeTree: (navigation) satisfies Handler<'session_before_tree'>,
    onSessionTree: ((_event, ctx) => restore(ctx)) satisfies Handler<'session_tree'>,
    onSessionShutdown: (() => { restoredContext = undefined; sessionGeneration++; preferredModel = undefined; selectedModel = undefined; retire(); state = emptyRetryState(); prompts.clear(); closeMenu(); }) satisfies Handler<'session_shutdown'>
  };
}
