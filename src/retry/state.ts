import { chinese, type Translator } from '../shared/i18n.ts';

export const RETRY_TYPE = 'pi-dag-workflow.retry';
export const RETRY_MESSAGE = 'pi-dag-workflow.retry-request';
export interface RetrySettings { intervals: number[]; count?: number }
export interface RetryModelRef { provider: string; id: string }
export interface RetryModels { enabled: boolean; candidates: RetryModelRef[]; after: number }
export const modelRefText = (model: RetryModelRef): string => `${model.provider}/${model.id}`;
export const defaultRetryModels = (): RetryModels => ({ enabled: false, candidates: [], after: 2 });
export function parseModelRefs(values: readonly string[], msg: Translator = chinese): RetryModelRef[] {
  const refs = values.map((value) => { const slash = value.indexOf('/'); if (slash < 1 || slash === value.length - 1) throw new Error(msg('候选模型需使用 provider/model 格式')); return { provider: value.slice(0, slash), id: value.slice(slash + 1) }; });
  validateRetryModels({ enabled: true, candidates: refs, after: 2 }, msg); return refs;
}
export function validateRetryModels(models: RetryModels, msg: Translator = chinese): void {
  const valid = (text: unknown): text is string => typeof text === 'string' && text.length > 0 && text.length <= 256 && !/[\s\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069]/u.test(text);
  if (!models || typeof models.enabled !== 'boolean' || !Number.isSafeInteger(models.after) || models.after < 1 || !Array.isArray(models.candidates) || models.candidates.length > 8 || models.enabled && !models.candidates.length || models.candidates.some((ref) => !ref || !valid(ref.provider) || ref.provider.includes('/') || !valid(ref.id)) || new Set(models.candidates.map(modelRefText)).size !== models.candidates.length) throw new Error(msg('模型替代设置无效：最多 8 个不同的 provider/model，每模型次数为正整数'));
}
export interface RetryState {
  version: 1; enabled: boolean; settings?: RetrySettings; models?: RetryModels;
  attempts: number; skipped: number; cancelledFailure?: string; failure?: { id: string; scope: string };
}
export const emptyRetryState = (): RetryState => ({ version: 1, enabled: false, attempts: 0, skipped: 0 });

export function validateRetryState(state: RetryState, msg: Translator = chinese): void {
  if (!state || state.version !== 1 || typeof state.enabled !== 'boolean' || !Number.isSafeInteger(state.attempts) || state.attempts < 0 || !Number.isSafeInteger(state.skipped) || state.skipped < 0) throw new Error(msg('重试记录损坏，保留原记录，不自动运行'));
  if (state.cancelledFailure !== undefined && (typeof state.cancelledFailure !== 'string' || !state.cancelledFailure || state.cancelledFailure.length > 256)) throw new Error(msg('重试记录损坏，保留原记录，不自动运行'));
  if (state.failure !== undefined && (!state.failure || typeof state.failure.id !== 'string' || !state.failure.id || state.failure.id.length > 256 || typeof state.failure.scope !== 'string' || !state.failure.scope || state.failure.scope.length > 256)) throw new Error(msg('重试记录损坏，保留原记录，不自动运行'));
  if (state.models !== undefined) validateRetryModels(state.models, msg);
  const settings = state.settings;
  if (state.enabled && !settings || settings !== undefined && (!settings || typeof settings !== 'object' || Array.isArray(settings) || !Array.isArray(settings.intervals) || !settings.intervals.length || settings.intervals.length > 32 || settings.intervals.some((value) => !Number.isSafeInteger(value) || value < 1000 || value % 1000 !== 0) || settings.count !== undefined && (!Number.isSafeInteger(settings.count) || settings.count < 1))) throw new Error(msg('重试设置无效'));
}
export function parseIntervals(source: string, msg: Translator = chinese): number[] {
  const parts = source.split(',');
  if (!parts.length || parts.length > 32) throw new Error(msg('间隔需要 1–32 项，用逗号分隔'));
  return parts.map((part) => {
    const match = /^([1-9]\d*)(s|m|h)$/.exec(part.trim());
    if (!match) throw new Error(msg('间隔使用正整数和 s/m/h，例如 30s,5m,1h'));
    const delay = Number(match[1]) * ({ s: 1000, m: 60000, h: 3600000 }[match[2]!]!);
    if (!Number.isSafeInteger(delay)) throw new Error(msg('重试间隔过大'));
    return delay;
  });
}
export function parseCount(source: string, msg: Translator = chinese): number {
  const count = Number(source);
  if (!/^[1-9]\d*$/.test(source) || !Number.isSafeInteger(count)) throw new Error(msg('count 需要正整数；省略表示不限次数'));
  return count;
}
export function parseRetrySettings(parts: readonly string[], msg: Translator = chinese): RetrySettings {
  if (parts.length !== 1 && (parts.length !== 3 || parts[1] !== 'count')) throw new Error(msg('用法：/retry when-error 5m,30s,10m [count 3]'));
  const settings = { intervals: parseIntervals(parts[0]!, msg), ...(parts.length === 3 ? { count: parseCount(parts[2]!, msg) } : {}) };
  validateRetryState({ ...emptyRetryState(), settings }, msg);
  return settings;
}
export function intervalText(settings: RetrySettings): string {
  return settings.intervals.map((delay) => delay % 3600000 === 0 ? `${delay / 3600000}h` : delay % 60000 === 0 ? `${delay / 60000}m` : `${delay / 1000}s`).join(',');
}
export function retryDelay(state: RetryState): number | undefined {
  return state.settings?.intervals[state.attempts % state.settings.intervals.length];
}
export function retrySpent(state: RetryState): boolean {
  return state.settings?.count !== undefined && state.attempts >= state.settings.count;
}
/** Settings follow the active branch, but restoring records never enables a timer. */
export function restoreRetryState(branch: readonly { type: string; customType?: string; data?: unknown }[], msg: Translator = chinese): RetryState {
  const entry = [...branch].reverse().find((item) => item.type === 'custom' && item.customType === RETRY_TYPE);
  const state = entry ? structuredClone(entry.data) as RetryState : emptyRetryState();
  validateRetryState(state, msg);
  return { ...state, enabled: false };
}
