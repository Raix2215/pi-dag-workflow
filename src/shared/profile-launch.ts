import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { configPaths } from './config.ts';

/** The thinking levels Pi accepts; a `:level` suffix on a model id is only one of these. */
export const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;

/**
 * The launch-relevant subset of one workflow Profile, read from the canonical Agents file.
 *
 * `src/agents/domain/profiles.ts` owns the runtime resolver, but the architecture rule forbids a
 * cross-module import (only `index.ts` entries cross modules), so Team reads the same file with the same
 * field names instead of carrying a second resolver with different semantics. The file is the canonical
 * `{ profiles: [{ name, ... }] }` array; there is no compatibility with an older `profiles[name]` map.
 *
 * Nothing is guessed away: a requested profile that is missing, unparsable or has an unusable launch field
 * throws a `ProfileConfigError`, because silently dropping a field (a duplicated name, an unknown key, a bad
 * `tools` token) would widen what the child may do. Only fields this launch needs are validated strictly;
 * canonical fields Team does not use (`skills`, `instructions`) are accepted and left alone. An omitted name
 * never reads the file at all.
 */
export interface LaunchProfile {
  name: string;
  model?: { provider: string; id: string };
  thinking?: string;
  tools?: readonly string[];
  /** opt-in isolation: `--no-extensions --no-skills` plus one `-e` per named extension. */
  isolate?: boolean;
  childExtensions?: readonly string[];
}

/** The canonical Profile fields; anything else in a selected entry is a broken configuration. */
const PROFILE_FIELDS = ['name', 'model', 'thinking', 'tools', 'skills', 'instructions', 'childExtensions', 'isolate'] as const;
/** A path, not a URL: the same contract the Profile store applies to child extensions. */
const URL_SCHEME = /^[a-zA-Z][a-zA-Z0-9+.-]*:/;
const WINDOWS_DRIVE = /^[a-zA-Z]:[\\/]/;
const CONTROL = /[\p{Cc}\p{Bidi_Control}\u2028\u2029]/u;

export type ProfileProblem = 'unreadable' | 'malformed' | 'missing' | 'duplicate' | 'unknown-field' | 'bad-model' | 'bad-thinking' | 'bad-isolate' | 'bad-tools' | 'bad-extensions';

/** One unusable Profile configuration; the UI maps `problem`/`detail` to a translated message. */
export class ProfileConfigError extends Error {
  readonly problem: ProfileProblem;
  readonly detail: readonly string[];
  constructor(problem: ProfileProblem, detail: readonly string[] = []) {
    super(`Profile 配置不可用：${problem}${detail.length ? `（${detail.join(' / ')}）` : ''}`);
    this.problem = problem;
    this.detail = detail;
  }
}

export const profileFilePath = () => join(configPaths().directory, 'pi-dag-workflow-profile.json');

/** One tool token: a trimmed name, never a comma list, whitespace or a control character. */
const toolTokens = (value: unknown, name: string): string[] => {
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) throw new ProfileConfigError('bad-tools', [name, 'tools']);
  const tokens = (value as string[]).map(item => item.trim());
  for (const token of tokens) if (!token || /[\s,]/.test(token) || CONTROL.test(token)) throw new ProfileConfigError('bad-tools', [name, 'tools', token]);
  return [...new Set(tokens)];
};

/** Local extension entries only; resolution against the configuration directory happens at launch time. */
const extensionEntries = (value: unknown, name: string): string[] => {
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) throw new ProfileConfigError('bad-extensions', [name, '']);
  return [...new Set((value as string[]).map(raw => {
    const entry = raw.trim();
    if (!entry || CONTROL.test(raw) || (URL_SCHEME.test(entry) && !WINDOWS_DRIVE.test(entry))) throw new ProfileConfigError('bad-extensions', [name, raw]);
    return entry;
  }))];
};

export function readLaunchProfile(name: string | undefined, file: string = profileFilePath()): LaunchProfile | undefined {
  // No profile requested: never open the file, so a broken one cannot block a plain launch.
  if (!name) return undefined;
  let text: string;
  try { text = readFileSync(file, 'utf8'); }
  catch (cause) { throw new ProfileConfigError('unreadable', [file, cause instanceof Error ? cause.message : String(cause)]); }
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { throw new ProfileConfigError('malformed', [file]); }
  const profiles = (parsed as { profiles?: unknown } | undefined)?.profiles;
  if (!Array.isArray(profiles)) throw new ProfileConfigError('malformed', [file]);
  // A name that appears twice cannot be resolved by picking one of them: the store refuses it, so do we.
  const names = profiles.map(item => item && typeof item === 'object' ? (item as { name?: unknown }).name : undefined).filter((value): value is string => typeof value === 'string');
  const duplicate = names.find((value, index) => names.indexOf(value) !== index);
  if (duplicate !== undefined) throw new ProfileConfigError('duplicate', [duplicate]);
  const entry = profiles.find(item => !!item && typeof item === 'object' && (item as { name?: unknown }).name === name);
  if (!entry) throw new ProfileConfigError('missing', [name]);
  const source = entry as Record<string, unknown>;
  // The selected entry must be canonical: an unknown key is a typo that would otherwise run with defaults.
  const unknown = Object.keys(source).find(key => !(PROFILE_FIELDS as readonly string[]).includes(key));
  if (unknown) throw new ProfileConfigError('unknown-field', [name, unknown]);
  let model: { provider: string; id: string } | undefined;
  if (source.model !== undefined) {
    const raw = source.model as { provider?: unknown; id?: unknown } | undefined;
    if (!raw || typeof raw !== 'object' || typeof raw.provider !== 'string' || !raw.provider.trim() || typeof raw.id !== 'string' || !raw.id.trim()) {
      throw new ProfileConfigError('bad-model', [name]);
    }
    model = { provider: raw.provider, id: raw.id };
  }
  if (source.thinking !== undefined && !(THINKING_LEVELS as readonly unknown[]).includes(source.thinking)) throw new ProfileConfigError('bad-thinking', [name]);
  if (source.isolate !== undefined && typeof source.isolate !== 'boolean') throw new ProfileConfigError('bad-isolate', [name]);
  return {
    name,
    ...(model ? { model } : {}),
    ...(typeof source.thinking === 'string' ? { thinking: source.thinking } : {}),
    ...(source.tools === undefined ? {} : { tools: toolTokens(source.tools, name) }),
    ...(source.isolate === undefined ? {} : { isolate: source.isolate }),
    ...(source.childExtensions === undefined ? {} : { childExtensions: extensionEntries(source.childExtensions, name) }),
  };
}
