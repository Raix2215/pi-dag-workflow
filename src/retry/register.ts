import { randomUUID } from 'node:crypto';
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { chinese, type Translator } from '../shared/i18n.ts';
import { completeArguments } from '../shared/completion.ts';
import { notify } from '../ui/render.ts';
import { choose, type MenuCursor } from '../ui/menu.ts';
import { retrySummary } from '../ui/presentation.ts';
import { safeDiagnostic } from '../agents/diagnostics.ts';
import { defaultRetryModels, modelRefText, parseModelRefs, validateRetryModels, type RetryModels, type RetryModelRef, emptyRetryState, intervalText, parseCount, parseIntervals, parseRetrySettings, RETRY_MESSAGE, RETRY_TYPE, restoreRetryState, retryDelay, retrySpent, validateRetryState, type RetryState } from './state.ts';

interface Failure { id: string; stopReason: 'error' | 'aborted'; message: string }
interface Hooks {
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
/** Commands only. No model tool, prompt catalog, background process or fixed-time job. */
export function registerRetry(pi: ExtensionAPI, hooks: Hooks) {
  const msg = hooks.msg ?? chinese;
  const now = hooks.now ?? Date.now;
  const setTimer = hooks.setTimer ?? setTimeout;
  const clearTimer = hooks.clearTimer ?? clearTimeout;
  let state = emptyRetryState();
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
  let noCancelFailure: string | undefined;
  let owner: string | undefined;
  let requestScope: string | undefined;
  let retired: string | undefined;
  let cancelledFailure: string | undefined;
  let phase = 'off';
  let reason: string | undefined;
  let compacting = false;
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
    failure = undefined; owner = undefined; roundModels = undefined; startingModel = undefined;
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
    if (!state.enabled || !failure || delay === undefined || error || hooks.protected()) return;
    if (retrySpent(state)) { phase = 'exhausted'; reason = msg('本轮重试次数已用完'); return; }
    if (state.models?.enabled && !nextModel(ctx)) { phase = 'exhausted'; reason = msg('替代模型候选已用完，自动恢复已停止'); notify(ctx, reason, 'warning'); hooks.failed?.(ctx, false); return; }
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
        if (!await pi.setModel(replacement)) { notify(ctx, msg('无法恢复用户模型选择；自动恢复保持停止，请核对当前模型'), 'warning'); return; }
      } catch { notify(ctx, msg('无法恢复用户模型选择；自动恢复保持停止，请核对当前模型'), 'warning'); return; }
      if (preferred === preferredModel && (preferred?.generation ?? ticket.generation) === sessionGeneration && current.model === replacement) {
        const thinking = preferred ? preferred.thinking : ticket.thinking;
        if (thinking !== undefined) pi.setThinkingLevel(thinking);
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
      const ticket = { target: model, previous: ctx.model, epoch: ownEpoch, generation: sessionGeneration, thinking: pi.getThinkingLevel?.() };
      switching = ticket; phase = 'switching';
      try {
        const selected = await pi.setModel(model);
        if (epoch !== ownEpoch || ticket.generation !== sessionGeneration) {
          await reconcileCancelledSwitch(ticket, ctx);
          return false;
        }
        if (!selected) throw new Error(msg('未配置模型鉴权'));
        if (ticket.thinking !== undefined) pi.setThinkingLevel(ticket.thinking);
        startingModel = modelRefText(model);
        notify(ctx, msg`重试已切换到 ${modelRefText(model)} · ${pi.getThinkingLevel?.() ?? '-'}`, 'info');
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
    observedError = latest; selectedModel = ctx.model ? modelRefText(ctx.model) : undefined;
    if (!latest) { if (failure || state.attempts || state.skipped) success(); return; }
    if (latest.id === cancelledFailure) { reason = msg('用户中断的请求不会自动恢复'); return; }
    if (starting && failure?.id === latest.id) { startFailed(ctx); return; }
    // Pi 1.0 cannot rule out a late user cancellation for provider-aborted outcomes.
    if (latest.stopReason === 'aborted' && aborted !== false) { cancelled(ctx, msg('无法确认是否为用户取消，不自动重试')); return; }
    if (latest.stopReason === 'aborted') noCancelFailure = latest.id;
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
    save({ ...state, version: 1, enabled: true, settings: { intervals, ...(count ===undefined ? {} : { count }) }, attempts: newRound ? 0 : state.attempts, skipped: newRound ? 0 : state.skipped });
    phase = 'armed'; reason = undefined;
    // An explicit configuration can recover an existing error, but never a user abort.
    const latest = lastFailure(ctx);
    if (latest && (latest.stopReason === 'error' || latest.id === noCancelFailure) && ctx.isIdle() && !compacting && ctx.hasPendingMessages?.() !== true) observe(ctx, false);
  }
  function off(ctx: ExtensionContext) {
    settingsRevision++; retire(); save({ ...state, enabled: false }); phase = 'off'; reason = undefined;
    const latest = lastFailure(ctx);
    if (!error && latest && latest.id !== cancelledFailure && ctx.isIdle() && ctx.hasPendingMessages?.() !== true && !compacting) hooks.failed?.(ctx, false);
  }
  function snapshot() {
    return { enabled: state.enabled && !error, mode: hooks.mode(), ...(state.models ? { models: { ...structuredClone(state.models), current: selectedModel, attemptsInModel: roundModels ? Object.fromEntries(roundModels.used) : {} } } : {}), intervals: state.settings ? intervalText(state.settings) : undefined, count: state.settings?.count ?? null, attempts: state.attempts, skipped: state.skipped, phase, ...(nextAt === undefined ? {} : { nextAt }), ...(reason ? { reason } : {}), ...(observedError?.message ? { lastError: observedError.message } : {}), ...(error ? { error } : {}) };
  }
  async function prompt<T>(title: string, run: () => Promise<T>): Promise<T> {
    const ticket = {}; const owners = ownedPrompts.get(title) ?? new Set<object>();
    owners.add(ticket); ownedPrompts.set(title, owners);
    try { return await run(); } finally {
      owners.delete(ticket);
      if (ownedPrompts.get(title) === owners && !owners.size) ownedPrompts.delete(title);
    }
  }
  /** Editing is separate from enabling: unchanged values never rearm or refill recovery. */
  function editSettings(intervals: number[], count: number | undefined, ctx: ExtensionContext) {
    if (error || hooks.protected()) throw new Error(error ?? msg('工作流状态受保护'));
    const intervalChanged = !state.settings || state.settings.intervals.length !== intervals.length || state.settings.intervals.some((value, index) => value !== intervals[index]);
    if (!intervalChanged && state.settings?.count === count) return;
    save({ ...state, settings: { intervals, ...(count === undefined ? {} : { count }) } }); settingsRevision++;
    if (state.enabled && failure && !starting && !admitted) {
      if (retrySpent(state)) { clear(); phase = 'exhausted'; reason = msg('本轮重试次数已用完'); hooks.failed?.(ctx, false); }
      else if (intervalChanged || phase === 'exhausted') schedule(ctx);
    }
  }
  async function confirmModels(next: RetryModels, ctx: ExtensionCommandContext, active: () => boolean = () => true): Promise<boolean> {
    validateRetryModels(next, msg);
    if (JSON.stringify(next) === JSON.stringify(state.models)) return true;
    if (starting || admitted || switching) throw new Error(msg('模型请求正在恢复，请稍后修改替代设置'));
    if (error || hooks.protected()) throw new Error(error ?? msg('工作流状态受保护'));
    const revision = settingsRevision, generation = sessionGeneration, scope = hooks.scope();
    const title = msg('确认替代模型设置？');
    if (!ctx.hasUI) throw new Error(msg('替代模型设置需要交互确认，请使用 /retry models 菜单'));
    const accepted = await prompt(title, () => ctx.ui.confirm(title, msg`候选：${next.candidates.map(modelRefText).join(' → ') || '-'}；每模型 ${next.after} 次；${next.enabled ? msg('开启') : msg('关闭')}。跨服务会发送当前上下文，可能增加费用和缓存开销；成功后保留替代模型，不改全局默认。`));
    if (!active() || generation !== sessionGeneration || scope !== hooks.scope()) return false;
    if (revision !== settingsRevision) { notify(ctx, msg('重试设置已改变，未保存过期输入'), 'warning'); return false; }
    if (!accepted) return false;
    if (starting || admitted || switching) throw new Error(msg('模型请求正在恢复，请稍后修改替代设置'));
    save({ ...state, models: structuredClone(next) }); settingsRevision++; selectedModel = ctx.model ? modelRefText(ctx.model) : undefined;
    roundModels?.skipped.clear();
    // Policy edits keep global usage and the remaining countdown. Only an exhausted chain
    // with newly available allowance needs another interval; cancelled work never rearms.
    if (failure && state.enabled && phase === 'exhausted' && !retrySpent(state)) schedule(ctx);
    return true;
  }
  async function modelsCommand(parts: string[], ctx: ExtensionCommandContext) {
    if (!parts.length) { await menu(ctx, true); return; }
    const before = state.models ?? defaultRetryModels();
    if (parts[0] === 'off' && parts.length === 1) {
      if (error || hooks.protected()) throw new Error(error ?? msg('工作流状态受保护'));
      save({ ...state, models: { ...before, enabled: false } }); settingsRevision++;
      if (switching) retire(msg('模型替代已关闭，旧恢复已取消'));
      else if (failure && state.enabled && phase === 'exhausted' && !retrySpent(state)) schedule(ctx);
    } else if (parts[0] === 'after' && parts.length === 2) await confirmModels({ ...before, after: parseCount(parts[1]!, msg) }, ctx);
    else {
      const candidates = parseModelRefs(parts, msg);
      for (const ref of candidates) if (!ctx.modelRegistry.find(ref.provider, ref.id)) throw new Error(msg`找不到模型 ${modelRefText(ref)}`);
      await confirmModels({ ...before, candidates, enabled: true }, ctx);
    }
    notify(ctx, retrySummary(snapshot(), msg).join('\n'), 'info');
  }
  async function modelsMenu(ctx: ExtensionCommandContext, active: () => boolean) {
    const title = msg('替代模型'), editOrder = msg('修改候选顺序'), editAfter = msg('修改每模型次数'), back = msg('返回');
    while (active()) {
      const before = state.models ?? defaultRetryModels(), revision = settingsRevision;
      const toggle = msg(before.enabled ? '关闭模型替代' : '开启模型替代');
      const choice = await prompt(title, () => choose(ctx, title, [{ id: toggle, label: toggle }, { id: editOrder, label: editOrder, value: msg`${before.candidates.length} 个候选` }, { id: editAfter, label: editAfter, value: String(before.after) }], { msg, isCurrent: active, lines: () => retrySummary(snapshot(), msg) }));
      if (!active() || choice === undefined || choice === back) return;
      if (revision !== settingsRevision) continue;
      try {
        if (choice === toggle && before.enabled) { await modelsCommand(['off'], ctx); return; }
        if (choice === editOrder || choice === toggle && !before.candidates.length) {
          let candidates = [...before.candidates];
          const done = msg('保存候选顺序'), clear = msg('清空候选'), add = msg('添加候选…');
          const cursor: MenuCursor = {}, pickerCursor: MenuCursor = {};
          while (active() && revision === settingsRevision) {
            const orderTitle = msg('候选顺序 · 草稿');
            const selected = await prompt(orderTitle, () => choose(ctx, orderTitle, candidates.map((ref, index) => ({ id: modelRefText(ref), label: `${index + 1}  ${ref.id}`, value: ref.provider })), { msg, cursor, isCurrent: () => active() && revision === settingsRevision, lines: [msg('选择候选可上移、下移或移除；保存前不会改变运行设置。')], actions: [{ id: add, label: add, ...(candidates.length >= 8 ? { disabledReason: msg('最多八个候选模型') } : {}) }, { id: done, label: done }, { id: clear, label: clear }] }));
            if (!active() || revision !== settingsRevision || selected === undefined) break;
            if (selected === clear) { candidates = []; continue; }
            if (selected === done) {
              if (choice === toggle && !candidates.length) { notify(ctx, msg('请先选择候选模型'), 'warning'); continue; }
              if (await confirmModels({ ...before, candidates, enabled: candidates.length > 0 && (before.enabled || choice === toggle) }, ctx, active)) return;
              break;
            }
            if (selected === add) {
              const available = ctx.modelRegistry.getAvailable().filter((model) => !candidates.some((ref) => modelRefText(ref) === modelRefText(model))).sort((a, b) => modelRefText(a).localeCompare(modelRefText(b)));
              const title = msg('添加候选模型');
              const picked = await prompt(title, () => choose(ctx, title, available.map((model) => ({ id: modelRefText(model), label: model.id, value: model.provider, description: model.name })), { msg, cursor: pickerCursor, searchable: true, isCurrent: () => active() && revision === settingsRevision, lines: (item) => { const model = available.find((value) => modelRefText(value) === item.id); return model ? [modelRefText(model), model.name, model.input.includes('image') ? msg('支持图像') : msg('仅文字'), msg('选择候选不会立即切换当前模型')] : []; } }));
              if (picked && active() && revision === settingsRevision && candidates.length < 8) candidates.push(...parseModelRefs([picked], msg));
              continue;
            }
            const index = candidates.findIndex((ref) => modelRefText(ref) === selected);
            if (index >= 0) {
              const title = msg('调整候选位置');
              const action = await prompt(title, () => choose(ctx, title, [{ id: 'up', label: msg('上移'), ...(index === 0 ? { disabledReason: msg('已是第一个') } : {}) }, { id: 'down', label: msg('下移'), ...(index === candidates.length - 1 ? { disabledReason: msg('已是最后一个') } : {}) }, { id: 'remove', label: msg('移除此候选') }], { msg, isCurrent: () => active() && revision === settingsRevision, lines: [selected] }));
              if (!active() || revision !== settingsRevision) break;
              if (action === 'remove') candidates.splice(index, 1);
              if (action === 'up' && index > 0) [candidates[index - 1], candidates[index]] = [candidates[index]!, candidates[index - 1]!];
              if (action === 'down' && index < candidates.length - 1) [candidates[index + 1], candidates[index]] = [candidates[index]!, candidates[index + 1]!];
            }
          }
        } else if (choice === editAfter) {
          const inputTitle = msg('每个模型最多尝试几次？输入正整数'), base = String(before.after); let draft = base;
          while (active() && revision === settingsRevision) {
            const input = await prompt(inputTitle, () => ctx.ui.editor(inputTitle, draft));
            if (!active() || revision !== settingsRevision || input === undefined) break;
            draft = input; let after: number;
            try { after = parseCount(input.trim(), msg); } catch (cause) { notify(ctx, safeDiagnostic(String(cause)), 'error'); continue; }
            if (await confirmModels({ ...before, after }, ctx, active)) return; break;
          }
        } else if (choice === toggle) { if (await confirmModels({ ...before, enabled: true }, ctx, active)) return; }
      } catch (cause) { if (active()) notify(ctx, safeDiagnostic(String(cause)), 'error'); }
    }
  }
  async function menu(ctx: ExtensionCommandContext, initialModels = false) {
    if (!ctx.hasUI) throw new Error(msg('当前界面没有菜单，请使用 /retry when-error、off 或 status'));
    if (menuSession) throw new Error(msg('重试菜单已打开'));
    const session = {}, scope = hooks.scope(); menuSession = session;
    const active = () => menuSession === session && scope === hooks.scope();
    const settings = msg('重试设置'), models = msg('替代模型'), back = msg('返回'), exit = msg('退出菜单');
    const editIntervals = msg('修改间隔'), editCount = msg('修改次数');
    const current = (base: typeof state.settings, enabled: boolean, revision: number) => {
      if (!active()) return false;
      if (base === state.settings && enabled === state.enabled && revision === settingsRevision) return true;
      notify(ctx, msg('重试设置已改变，未保存过期输入'), 'warning'); return false;
    };
    async function edit(kind: 'intervals' | 'count', enabling = false): Promise<boolean> {
      const base = state.settings, enabled = state.enabled, revision = settingsRevision;
      if (kind === 'count' && !base) { notify(ctx, msg('请先设置重试间隔'), 'warning'); return false; }
      const title = kind === 'intervals' ? msg('错误后等待多久？用逗号分隔，例如 5m,30s,10m') : msg('每轮最多重试几次？输入正整数，留空表示不限');
      let draft = kind === 'intervals' ? base ? intervalText(base) : '' : base?.count === undefined ? '' : String(base.count);
      while (active()) {
        // input() only offers a placeholder; editor() actually preserves editable text.
        const input = await prompt(title, () => ctx.ui.editor(title, draft));
        if (input === undefined || !current(base, enabled, revision)) return false;
        draft = input;
        let intervals = base?.intervals, count = base?.count;
        try { if (kind === 'intervals') intervals = parseIntervals(input, msg); else count = input.trim() ? parseCount(input.trim(), msg) : undefined; }
        catch (cause) { notify(ctx, safeDiagnostic(String(cause)), 'error'); continue; }
        if (!intervals) return false;
        const same = base && count === base.count && intervals.length === base.intervals.length && intervals.every((value, index) => value === base.intervals[index]);
        if (same && !enabling) return true;
        const confirmTitle = msg('确认重试设置？');
        const accepted = await prompt(confirmTitle, () => ctx.ui.confirm(confirmTitle, msg`间隔：${intervalText({ intervals })}；次数：${count ?? msg('不限')}；${enabling || enabled ? msg('开启') : msg('关闭')}`));
        if (!current(base, enabled, revision) || !accepted) return false;
        if (enabling) configure(intervals, count, ctx); else editSettings(intervals, count, ctx);
        return true;
      }
      return false;
    }
    async function settingsMenu() {
      while (active()) {
        const choice = await prompt(settings, () => choose(ctx, settings, [{ id: editIntervals, label: editIntervals, value: state.settings ? intervalText(state.settings) : msg('未设置间隔') }, { id: editCount, label: editCount, value: String(state.settings?.count ?? msg('不限')) }], { msg, isCurrent: active, lines: () => retrySummary(snapshot(), msg) }));
        if (!active() || choice === undefined || choice === back) return;
        if (choice === editIntervals || choice === editCount) { if (await edit(choice === editIntervals ? 'intervals' : 'count')) return; }
      }
    }
    try {
      if (initialModels) await modelsMenu(ctx, active);
      while (active()) {
        const enabled = state.enabled, base = state.settings, revision = settingsRevision;
        const toggle = msg(enabled ? '关闭自动重试' : '开启自动重试');
        const title = msg`重试恢复 · ${enabled ? msg('开启') : msg('关闭')} · ${base ? intervalText(base) : msg('未设置间隔')} · ${base?.count ?? msg('不限')} 次`;
        const choice = await prompt(title, () => choose(ctx, title, [{ id: toggle, label: toggle }, { id: settings, label: settings, value: base ? intervalText(base) : msg('未设置间隔') }, { id: models, label: models, value: state.models?.enabled ? msg('开启') : msg('关闭') }, { id: 'summary', label: msg('显示摘要'), value: hooks.summary?.() !== false ? msg('开启') : msg('关闭') }], { msg, isCurrent: active, lines: () => [...retrySummary(snapshot(), msg), msg('菜单打开期间不会发起重试')], actions: [{ id: 'stop', label: msg('停止本轮恢复'), ...(!failure ? { disabledReason: msg('当前没有待恢复请求') } : {}) }, { id: exit, label: exit }] }));
        if (!active() || choice === undefined || choice === exit) return;
        try {
          if (choice === models) await modelsMenu(ctx, active);
          else if (choice === settings) await settingsMenu();
          else if (choice === 'summary') hooks.setSummary?.(hooks.summary?.() === false, ctx);
          else if (choice === 'stop') { cancelled(ctx, msg('用户停止本轮恢复')); hooks.failed?.(ctx, false); }
          else if (choice === toggle && current(base, enabled, revision)) {
            if (enabled) off(ctx);
            else if (!base) await edit('intervals', true);
            else {
              const title = msg('确认重试设置？');
              const accepted = await prompt(title, () => ctx.ui.confirm(title, msg`间隔：${intervalText(base)}；次数：${base.count ?? msg('不限')}；${msg('开启')}`));
              if (current(base, enabled, revision) && accepted) configure(base.intervals, base.count, ctx);
            }
          }
        } catch (cause) { if (active()) notify(ctx, safeDiagnostic(String(cause)), 'error'); }
      }
    } finally { if (menuSession === session) menuSession = undefined; }
  }
  function restore(ctx: ExtensionContext) {
    sessionGeneration++; preferredModel = undefined; selectedModel = ctx.model ? modelRefText(ctx.model) : undefined; retire(); cache = undefined; observedError = undefined; error = undefined; retired = undefined; cancelledFailure = undefined; noCancelFailure = undefined; requestScope = undefined; prompts.clear(); closeMenu(); compacting = false;
    try { state = restoreRetryState(hooks.branch(ctx), msg); cancelledFailure = state.cancelledFailure; phase = 'off'; reason = state.settings ? msg('会话恢复后重试保持关闭') : undefined; }
    catch (cause) { state = emptyRetryState(); error = safeDiagnostic(String(cause)); phase = 'off'; notify(ctx, error, 'error'); }
  }
  pi.registerCommand('retry', {
    description: msg('出错后重试：when-error 间隔列表 [count 次数]、off、status、models'),
    getArgumentCompletions: (text) => completeArguments(text, { actions: [{ action: 'when-error', description: msg('设置并开启出错后重试') }, { action: 'off', description: msg('关闭并取消计时') }, { action: 'status', description: msg('查看重试状态') }, { action: 'models', description: msg('设置替代模型：models、models 候选列表、models after 次数、models off') }], freeText: ['when-error', 'models'] }),
    handler: async (args, ctx) => {
      let internal = false;
      try {
        const [action, ...parts] = args.trim().split(/\s+/);
        if (deliveryToken && action === deliveryToken && !parts.length) {
          internal = true; deliveryToken = undefined;
          if (!state.enabled || !failure) return;
          if (!dispatching) { skip(ctx); return; } // Treat a deferred command as a busy skip.
          await fire(ctx); return;
        }
        // A previously cancelled internal command can still be delivered by Pi; ignore it.
        if (action && !parts.length && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(action)) return;
        if (!args.trim()) { await menu(ctx); return; }
        if (action === 'show' || action === 'hide') { hooks.setSummary?.(action === 'show', ctx); return; }
        if (action === 'models') { await modelsCommand(parts, ctx); hooks.onChanged?.(ctx); return; }
        if (action === 'when-error') { const settings = parseRetrySettings(parts, msg); configure(settings.intervals, settings.count, ctx); }
        else if (action === 'off' && !parts.length) off(ctx);
        else if (action !== 'status' || parts.length) throw new Error(msg('用法：/retry [when-error 5m,30s,10m [count 3] | off | status | models [provider/model ... | after N | off]]'));
        hooks.onChanged?.(ctx); notify(ctx, retrySummary(snapshot(), msg).join('\n'), 'info');
      } catch (cause) {
        if (internal) {
          error = safeDiagnostic(String(cause)); retire(msg('重试记录无法保存，已停止')); phase = 'off';
          try { hooks.undoPrepare?.(ctx); } catch { /* Failed storage cannot be repaired by another write. */ }
        }
        notify(ctx, safeDiagnostic(String(cause)), 'error');
      }
    },
  });
  pi.on('agent_settled', (event, ctx) => { observe(ctx, (event as { aborted?: boolean }).aborted); hooks.onChanged?.(ctx); });
  pi.on('turn_start', (_event, ctx) => {
    requestScope = hooks.scope();
    if (!starting) return;
    clear(); starting = false; admitted = true; phase = 'running';
    save({ ...state, attempts: state.attempts + 1 });
    if (roundModels && startingModel) roundModels.used.set(startingModel, (roundModels.used.get(startingModel) ?? 0) + 1);
    startingModel = undefined; hooks.onChanged?.(ctx);
  });
  pi.on('turn_end', (event, ctx) => {
    if (event.outcome === 'aborted' && ctx.signal?.aborted) { cancelled(ctx, msg('用户中断，计时已取消')); return; }
    if (event.outcome === 'completed') { observedError = undefined; if (failure || state.attempts || state.skipped) success(); }
    hooks.onChanged?.(ctx);
  });
  pi.on('agent_end', (_event, ctx) => { if (ctx.signal?.aborted) cancelled(ctx, msg('用户中断，计时已取消')); });
  pi.on('input', (event) => { if (!issuing && event.source !== 'extension' && !/^\/retry(?:\s|$)/.test(event.text.trim())) { closeMenu(); retire(msg('收到新输入，旧计时已取消')); } });
  pi.on('model_select', (event, ctx) => {
    selectedModel = modelRefText(ctx.model ?? event.model);
    if (event.source === 'set' && switching?.target === event.model) {
      // A late setter in a newly restored branch may be the first model event there.
      // Its actual previousModel is that branch's selection, not our saved old baseline.
      if (switching.generation !== sessionGeneration && preferredModel?.generation !== sessionGeneration && event.previousModel) preferredModel = { model: event.previousModel, generation: sessionGeneration, context: ctx, thinking: undefined };
      return;
    }
    preferredModel = { model: event.model, generation: sessionGeneration, context: ctx, thinking: pi.getThinkingLevel?.() };
    retire(msg('模型已手动切换，旧恢复已取消'));
  });
  pi.on('ui_prompt_start', (event) => { prompts.add(event.title ?? ''); });
  pi.on('ui_prompt_end', (event) => { prompts.delete(event.title ?? ''); });
  pi.on('session_before_compact', () => { closeMenu(); compacting = true; clear(); });
  pi.on('session_compact', () => { compacting = false; retire(msg('上下文已改变，旧计时已取消')); cache = undefined; });
  pi.on('session_compact_failed', () => { compacting = false; retire(msg('压缩未完成，旧计时已取消')); });
  const navigation = () => { sessionGeneration++; closeMenu(); retire(msg('会话已改变，旧计时已取消')); };
  pi.on('session_before_switch', navigation);
  pi.on('session_before_fork', navigation);
  pi.on('session_before_tree', navigation);
  pi.on('session_tree', (_event, ctx) => restore(ctx));
  pi.on('session_shutdown', () => { sessionGeneration++; preferredModel = undefined; selectedModel = undefined; retire(); state = emptyRetryState(); prompts.clear(); closeMenu(); });
  return { restore, cancel: (label?: string) => retire(label), refreshScope: (ctx?: ExtensionContext) => { if (owner !== undefined && owner !== hooks.scope()) { retire(msg('工作已改变，旧计时已取消')); if (ctx) hooks.failed?.(ctx, false); } }, snapshot, isPrompt: (title: string | undefined) => title !== undefined && (ownedPrompts.get(title)?.size ?? 0) > 0, pending: () => failure !== undefined && (timer !== undefined || deliveryToken !== undefined || starting || admitted || switching?.epoch === epoch) };
}
