export type FailureKind = 'permanent' | 'transient' | 'unknown';
export interface ModelFailure { id: string; stopReason: 'error' | 'aborted'; kind: FailureKind }

/** Only explicit permanent errors bypass recovery; ambiguous failures remain bounded. */
export function classifyModelError(message: string): FailureKind {
  if (/insufficient[_\s-]quota|usage[_\s-]limit[_\s-]reached|usage limit (?:has been )?reached|billing[_\s-](?:hard[_\s-])?limit|billing.{0,60}(?:exhaust|exceed)|(?:credits?|balance).{0,40}(?:exhaust|insufficient)|(?:insufficient|exhausted).{0,40}(?:credits?|balance)|payment[_\s-]required|invalid[_\s-]api[_\s-]key|authentication[_\s-](?:error|failed)|permission[_\s-]denied|model[_\s-]not[_\s-]found|(?:HTTP|status|error)\s*[:=]?\s*(?:401|403|402)\b/i.test(message)) return 'permanent';
  if (/\b429\b|rate[_\s-]limit|too many requests|\b5\d\d\b|overloaded|temporar|timeout|timed out|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|connection.{0,30}(?:reset|closed|lost)|stream.{0,30}(?:error|interrupt|disconnect|closed)|network|fetch failed/i.test(message)) return 'transient';
  return 'unknown';
}

/** Existing retry count remains authoritative even for an unlimited Goal. */
export function goalRetryDelay(attempts: number): number {
  return Math.min(30000, 1000 * 2 ** Math.min(5, Math.max(0, attempts)));
}
