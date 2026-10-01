import { stripTerminalSequences, type AutocompleteItem } from '@earendil-works/pi-tui';

/** One supported sub-action of a slash command and its short Chinese hint. */
export interface CompletionAction { action: string; description: string }
/** One dynamic second-token candidate (e.g. a live Todo/Goal/Agent id). */
export interface CompletionToken { token: string; label?: string; description?: string }
export interface CompletionSpec {
  /** Root sub-actions the command accepts. */
  actions: readonly CompletionAction[];
  /** Fixed second-level choices for a given action, e.g. `view` -> list/dag. */
  subActions?: Readonly<Record<string, readonly CompletionAction[]>>;
  /** Live second-token candidates for a given action; `null` means none. */
  tokens?: (action: string) => readonly CompletionToken[] | null;
  /** Actions whose next argument is free text: never replace what the user typed. */
  freeText?: readonly string[];
}

const CONTROL = /[\u0000-\u001f\u007f-\u009f]/g;
const PICTOGRAPH = /[\p{Extended_Pictographic}\uFE0F\u200D]/gu;

/** Completion text must be a single clean line: no control characters or emoji. */
export function safeCompletionText(value: string): string {
  return stripTerminalSequences(value).replace(CONTROL, ' ').replace(/[\p{Bidi_Control}\u206a-\u206f]/gu, '').replace(PICTOGRAPH, '').replace(/\s+/g, ' ').trim();
}

function makeItem(value: string, label: string, description?: string): AutocompleteItem | undefined {
  const safeValue = safeCompletionText(value);
  if (!safeValue) return undefined;
  const safeLabel = safeCompletionText(label) || safeValue;
  const safeDescription = description ? safeCompletionText(description) : '';
  return { value: safeValue, label: safeLabel, ...(safeDescription ? { description: safeDescription } : {}) };
}

/** True when a candidate token still matches the partially typed second argument. */
export function tokenMatches(token: string, typed: string): boolean {
  if (!typed) return true;
  const bare = (value: string) => value.replace(/^#/, '');
  return token.startsWith(typed) || bare(token).startsWith(bare(typed));
}

function completeRoot(spec: CompletionSpec, typed: string): AutocompleteItem[] | null {
  const items = spec.actions
    .filter((entry) => entry.action.startsWith(typed))
    .map((entry) => makeItem(entry.action, entry.action, entry.description))
    .filter((item): item is AutocompleteItem => item !== undefined);
  return items.length ? items : null;
}

function completeSecond(spec: CompletionSpec, free: ReadonlySet<string>, action: string, typed: string): AutocompleteItem[] | null {
  if (free.has(action)) return null;
  // Unknown actions never produce candidates, even when a tokens callback is provided.
  if (!spec.actions.some((entry) => entry.action === action)) return null;
  const subs = spec.subActions?.[action];
  if (subs) {
    const items = subs
      .filter((entry) => entry.action.startsWith(typed))
      .map((entry) => makeItem(`${action} ${entry.action}`, entry.action, entry.description))
      .filter((item): item is AutocompleteItem => item !== undefined);
    return items.length ? items : null;
  }
  const tokens = spec.tokens?.(action);
  if (!tokens?.length) return null;
  const items = tokens
    .filter((entry) => tokenMatches(entry.token, typed))
    .map((entry) => makeItem(`${action} ${entry.token}`, entry.label ?? entry.token, entry.description))
    .filter((item): item is AutocompleteItem => item !== undefined);
  return items.length ? items : null;
}

/**
 * Suggest slash-command arguments without model calls or side effects.
 *
 * The returned `value` always contains the full argument text (action plus the
 * candidate token, e.g. `start #41`) so Pi can replace the argument prefix
 * without dropping the command the user already typed. Free-text positions and
 * unmatched input return `null`, leaving the user's text untouched.
 */
export function completeArguments(text: string, spec: CompletionSpec): AutocompleteItem[] | null {
  const raw = typeof text === 'string' ? text : '';
  const trimmed = raw.trim();
  const tokens = trimmed ? trimmed.split(/\s+/) : [];
  const trailing = raw.length > 0 && /\s$/.test(raw);
  const free = new Set(spec.freeText ?? []);

  // The user is still typing the action name (or nothing yet).
  if (tokens.length === 0) return completeRoot(spec, '');
  if (tokens.length === 1) return trailing ? completeSecond(spec, free, tokens[0]!, '') : completeRoot(spec, tokens[0]!);

  // Only the second argument position has candidates; anything later is free text.
  if (tokens.length === 2 && !trailing) return completeSecond(spec, free, tokens[0]!, tokens[1]!);
  return null;
}
