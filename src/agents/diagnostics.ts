export interface AgentFailure {
  kind: 'quota' | 'auth' | 'network' | 'timeout' | 'process' | 'unknown';
  reason: string;
  retryable: boolean | null;
  recovery: string;
}
/** Diagnostics may contain headers/URLs. Never expose their common credential forms. */
export function safeDiagnostic(value: string, limit = 2048): string {
  const text = value
    .replace(/((?:["']?(?:proxy-authorization|authorization|cookie|set-cookie)["']?)\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\r\n]+)/gi, '$1[redacted]')
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/[\p{Cc}\p{Bidi_Control}]/gu, ' ')
    .replace(/https?:\/\/[^\s/@]+:[^\s/@]+@/gi, (url) => url.replace(/\/\/.*@/, '//[redacted]@'))
    .replace(/\b(?:sk-|ghp_|github_pat_|npm_)[A-Za-z0-9_-]{8,}/g, '[redacted]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+/gi, 'Bearer [redacted]')
    .replace(/([?&](?:api[_-]?key|access[_-]?token|token|secret|password)=)[^&#\s]+/gi, '$1[redacted]')
    .replace(/(["']?(?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|authorization|secret|password)["']?\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;}]+)/gi, '$1[redacted]')
    .replace(/\s+/g, ' ').trim();
  if (text.length <= limit) return text;
  const end = limit - 1;
  return text.slice(0, /[\uD800-\uDBFF]/.test(text.charAt(end - 1)) ? end - 1 : end) + '…';
}
/** Classification informs the parent; it never schedules retries or authorizes replay. */
export function agentFailure(value: string): AgentFailure {
  const reason = safeDiagnostic(value, 300);
  let kind: AgentFailure['kind'] = 'unknown';
  let retryable: boolean | null = null;
  if (/insufficient[_\s-]quota|usage[_\s-]limit[_\s-]reached|usage limit (?:has been )?reached|billing[_\s-](?:hard[_\s-])?limit|billing.{0,60}(?:exhaust|exceed)|payment[_\s-]required|credits?.{0,30}(?:exhaust|insufficient)/i.test(value)) { kind = 'quota'; retryable = false; }
  else if (/invalid[_\s-]api[_\s-]key|authentication|permission[_\s-]denied|(?:HTTP|status|error)\s*[:=]?\s*(?:401|403)\b/i.test(value)) { kind = 'auth'; retryable = false; }
  else if (/deadline|timed?\s*out|ETIMEDOUT/i.test(value)) { kind = 'timeout'; retryable = true; }
  else if (/ECONNRESET|ECONNREFUSED|EAI_AGAIN|network|fetch failed|stream.{0,30}(?:disconnect|closed|interrupt)|connection.{0,30}(?:reset|closed|lost)|\b429\b|rate[_\s-]limit|\b5\d\d\b/i.test(value)) { kind = 'network'; retryable = true; }
  else if (/process|exited|RPC|startup|ENOENT|MODULE_NOT_FOUND/i.test(value)) kind = 'process';
  const recovery = `${kind === 'quota' || kind === 'auth' ? 'Resolve the account/configuration issue or select another configured profile. ' : ''}Inspect partial results and external side effects before an explicit resumeFrom attempt on the same Todo; do not blindly replay or create a replacement Todo.`;
  return { kind, reason, retryable, recovery };
}
