import { createHash } from 'node:crypto';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import { TEAM_MEMBERSHIP_MESSAGE } from '../../shared/message-types.ts';

type SnapshotDetails = { membershipVersion: 1; after: string | null; afterOccurrence: number; snapshotTime: number };
type CustomMessage = Extract<AgentMessage, { role: 'custom' }>;
export type MembershipSnapshot = CustomMessage & { details: SnapshotDetails };

export const isMembershipMessage = (message: AgentMessage): message is CustomMessage => message.role === 'custom' && message.customType === TEAM_MEMBERSHIP_MESSAGE;
export const isMembershipSnapshot = (message: AgentMessage): message is MembershipSnapshot => {
  if (!isMembershipMessage(message) || typeof message.content !== 'string') return false;
  const details = message.details as Partial<SnapshotDetails> | undefined;
  return details?.membershipVersion === 1 && (details.after === null || typeof details.after === 'string') && typeof details.afterOccurrence === 'number' && Number.isInteger(details.afterOccurrence) && details.afterOccurrence >= 0 && typeof details.snapshotTime === 'number';
};
export const snapshotKey = (message: MembershipSnapshot): string => JSON.stringify([message.content, message.details]);
const fingerprint = (message: AgentMessage): string => createHash('sha256').update(JSON.stringify(message)).digest('hex');

export function membershipSnapshot(messages: AgentMessage[], content: string, timestamp: number): MembershipSnapshot {
  const base = messages.filter(message => !isMembershipMessage(message));
  const anchor = base.at(-1), after = anchor ? fingerprint(anchor) : null;
  const afterOccurrence = after === null ? 0 : base.filter(message => fingerprint(message) === after).length;
  return { role: 'custom', customType: TEAM_MEMBERSHIP_MESSAGE, content, display: false, timestamp,
    details: { membershipVersion: 1, after, afterOccurrence, snapshotTime: timestamp } };
}

/**
 * A context-only send is persisted only after the current assistant/tool turn. Its first-request
 * fallback must stay at the same anchor after that flush, or persistence itself rewrites the prefix.
 * The anchor and timestamp travel with the native custom message, including across reload/tree.
 */
export function projectMembership(messages: AgentMessage[], snapshots: MembershipSnapshot[]): AgentMessage[] {
  const base: AgentMessage[] = [], nativePositions = new Map<string, number>();
  for (const message of messages) {
    if (isMembershipSnapshot(message)) nativePositions.set(snapshotKey(message), base.length);
    if (!isMembershipMessage(message)) base.push(message);
  }
  const anchors = new Set(snapshots.map(snapshot => snapshot.details.after));
  const positions = new Map<string, number[]>();
  if (anchors.size) for (const [index, message] of base.entries()) {
    const hash = fingerprint(message);
    if (anchors.has(hash)) positions.set(hash, [...positions.get(hash) ?? [], index + 1]);
  }
  const inserts = new Map<number, MembershipSnapshot[]>();
  let previousIndex = 0;
  for (const snapshot of snapshots) {
    const details = snapshot.details;
    // An anchor cannot be later than its own native snapshot: after compaction, a newly
    // appended duplicate must not reclaim an expired anchor. Keep snapshot chronology too.
    const nativeIndex = nativePositions.get(snapshotKey(snapshot));
    const anchorIndex = details.after === null ? 0 : positions.get(details.after)?.[details.afterOccurrence - 1];
    const index = Math.max(previousIndex, anchorIndex !== undefined && (nativeIndex === undefined || anchorIndex <= nativeIndex) ? anchorIndex : nativeIndex ?? base.length);
    previousIndex = index;
    const stable = { ...snapshot, timestamp: details.snapshotTime };
    inserts.set(index, [...inserts.get(index) ?? [], stable]);
  }
  const projected: AgentMessage[] = [];
  for (let index = 0; index <= base.length; index++) {
    projected.push(...inserts.get(index) ?? []);
    if (index < base.length) projected.push(base[index]!);
  }
  return projected;
}
