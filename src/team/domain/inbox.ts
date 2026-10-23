/** Pure inbox rules: body limit, source provenance, delivery batch and the read-confirmation model. */
export type MessageKind = 'message' | 'question' | 'notice';
/** Stored modes keep their old names; the UI names them Manual / Queued / Priority. */
export type AutoMessages = 'off' | 'background' | 'all';
/** Where a message really came from. Only the panel's own compose path may write `human`. */
export type SourceKind = 'agent' | 'human' | 'unknown';

export interface TeamMessage {
  id: number; from: string; fromId: string; to: string; toId: string; body: string;
  createdAt: number; readAt?: number; acceptedAt?: number; replyTo?: number; kind: MessageKind;
  /** Provenance recorded by the writer, never parsed out of the body. Legacy records carry none. */
  sourceKind?: SourceKind;
  /** This batch is inside the receiver's Pi queue but not yet in a model input; never a read. */
  inflight?: { instanceId: string; pid: number; at: number };
  /**
   * A user's explicit "deliver these messages" request written by the panel: the target holder consumes it
   * and delivers exactly these ids (the old messages keep their own sourceKind).
   */
  deliverIds?: number[];
  /** The message this one is an explicit user request about, when it is not a plain message. */
  request?: 'deliver';
  /** The instance that took the request, so two receivers cannot both honour it. */
  requestTakenBy?: string;
  requestPid?: number;
  /** When the request was honoured; a request is never a chat message and never part of a FIFO batch. */
  requestDoneAt?: number;
}

export const MAX_BODY_BYTES = 8 * 1024;
/** An idle session never reaches turn_end, so the inbox has its own 10 s check. */
export const POLL_MS = 10_000;
/** One batch: the earliest 10 unread messages, never truncated and never re-ordered. */
export const DELIVERY_LIMIT = 10;

/**
 * The one body rule: emptiness is judged on the trimmed text, the 8 KiB cap on the exact bytes that will be
 * stored, and the text comes back untouched. Padding cannot buy space, and nothing is silently rewritten.
 * Oversized bodies are refused with an executable instruction instead of being truncated.
 */
export function validateBody(body: string): string {
  if (!body.trim()) throw new Error('消息正文不能为空；写一句可执行的说明再发送');
  const bytes = Buffer.byteLength(body, 'utf8');
  if (bytes > MAX_BODY_BYTES) throw new Error(`消息正文 ${bytes} 字节超过 8 KiB 上限：拆分要点、附上文件路径，或只发摘要后请对方读取文件`);
  return body;
}

/** Missing or invalid provenance is unknown: history is never promoted to human by guessing. */
export function sourceKindOf(message: Pick<TeamMessage, 'sourceKind'>): SourceKind {
  return message.sourceKind === 'agent' || message.sourceKind === 'human' ? message.sourceKind : 'unknown';
}

/** What a message may authorize: only a human-authored *new* message carries user authority. */
export function authorizes(message: Pick<TeamMessage, 'sourceKind'>): boolean {
  return sourceKindOf(message) === 'human';
}

const isUnread = (message: TeamMessage): boolean => message.readAt === undefined;
/** A delivery request is mailbox metadata: it is honoured by the receiver, never chatted to the model. */
export const isRequest = (message: TeamMessage): boolean => message.request === 'deliver';

/** The next batch: earliest unread, never a request, never one in flight, capped at 10, body untouched. */
export function deliveryBatch(messages: readonly TeamMessage[]): { batch: TeamMessage[]; remaining: number } {
  const pending = messages.filter(message => isUnread(message) && message.inflight === undefined && !isRequest(message));
  const batch = pending.slice(0, DELIVERY_LIMIT);
  return { batch, remaining: Math.max(0, pending.length - batch.length) };
}

/** The earliest open delivery request, honoured before any automatic mode decision. */
export function openRequest(messages: readonly TeamMessage[]): TeamMessage | undefined {
  return messages.find(message => isRequest(message) && message.requestDoneAt === undefined && message.requestTakenBy === undefined);
}

/** The ids a request asks for: FIFO order of the mailbox, in flight skipped, never the request itself, max 10. */
export function requestedBatch(messages: readonly TeamMessage[], ids: readonly number[]): TeamMessage[] {
  const wanted = new Set(ids);
  return messages
    .filter(message => wanted.has(message.id) && !isRequest(message) && isUnread(message) && message.inflight === undefined)
    .slice(0, DELIVERY_LIMIT);
}

/** Mark a batch in flight for one receiver instance. This is not a read and creates no authority. */
export function markInflight(messages: readonly TeamMessage[], ids: ReadonlySet<number>, instanceId: string, pid: number, at: number): TeamMessage[] {
  return messages.map(message => ids.has(message.id) && message.readAt === undefined
    ? { ...message, inflight: { instanceId, pid, at } }
    : message);
}

/** A confirmed delivery is the only thing that marks read; it clears the same instance's marker. */
export function markRead(messages: readonly TeamMessage[], ids: ReadonlySet<number>, instanceId: string, at: number): TeamMessage[] {
  return messages.map((message) => {
    if (!ids.has(message.id) || message.readAt !== undefined || message.inflight?.instanceId !== instanceId) return message;
    // Drop the marker rather than writing `undefined`: the field is optional, not nullable.
    const { inflight: _inflight, ...rest } = message;
    return { ...rest, readAt: at };
  });
}

/** A reload or exit drops that instance's markers: unconfirmed messages become unread again. */
export function releaseInflight(messages: readonly TeamMessage[], instanceId: string): TeamMessage[] {
  return messages.map((message) => {
    if (message.requestTakenBy === instanceId && message.requestDoneAt === undefined) {
      const { requestTakenBy: _request, requestPid: _pid, ...rest } = message;
      return rest;
    }
    if (message.inflight?.instanceId !== instanceId) return message;
    const { inflight: _inflight, ...rest } = message;
    return rest;
  });
}

/** Markers left by a process that is gone (a crash, not a shutdown) are released without touching a live one. */
export function releaseDeadInflight(messages: readonly TeamMessage[], alive: (pid: number) => boolean, keepInstance?: string): { messages: TeamMessage[]; released: number } {
  let released = 0;
  const next = messages.map((message) => {
    if (message.requestTakenBy && message.requestDoneAt === undefined && message.requestTakenBy !== keepInstance && Number.isSafeInteger(message.requestPid) && message.requestPid! > 0 && !alive(message.requestPid!)) {
      released += 1;
      const { requestTakenBy: _request, requestPid: _pid, ...rest } = message;
      return rest;
    }
    const marker = message.inflight;
    if (!marker || marker.instanceId === keepInstance || !Number.isSafeInteger(marker.pid) || marker.pid <= 0 || alive(marker.pid)) return message;
    released += 1;
    const { inflight: _inflight, ...rest } = message;
    return rest;
  });
  return { messages: next, released };
}

/** A message that was delivered but never confirmed is not read: the count says so. */
export const unreadCount = (messages: readonly TeamMessage[]): number => messages.filter(message => isUnread(message) && !isRequest(message)).length;
export const inflightCount = (messages: readonly TeamMessage[]): number => messages.filter(message => isUnread(message) && message.inflight !== undefined).length;

/** The real Pi delivery for one mode: idle wakes the model, busy follows up or steers per policy. */
export type Delivery = { deliverAs: 'followUp' | 'steer'; triggerTurn: true };
export function deliveryFor(mode: AutoMessages, idle: boolean): Delivery | undefined {
  // Manual never consumes on its own; Queued follows up (a busy turn keeps its tool chain), Priority steers.
  if (mode === 'off') return undefined;
  if (idle) return { deliverAs: 'followUp', triggerTurn: true };
  return mode === 'all' ? { deliverAs: 'steer', triggerTurn: true } : { deliverAs: 'followUp', triggerTurn: true };
}

export function nextMessageId(messages: readonly TeamMessage[]): number {
  return messages.reduce((max, message) => Math.max(max, message.id), 0) + 1;
}

/** A name is data: a newline or a fake header in it must never break the trusted Source line. */
export function safeField(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, ' ').replace(/\s+/g, ' ').trim();
}

/** Display-only SID: the last 8 characters, extended until two shown ids differ. */
export function shortSid(sessionId: string, others: readonly string[] = []): string {
  if (!sessionId) return '?';
  const width = Math.min(sessionId.length, 8);
  let length = width;
  const clash = (candidate: number) => others.some(other => other !== sessionId && other.slice(-candidate) === sessionId.slice(-candidate));
  while (length < sessionId.length && clash(length)) length += 1;
  return sessionId.slice(-length);
}

/**
 * The one English wrapper the model sees. It is built from recorded metadata only — never from text in
 * the body — so a body that claims to be human or quotes a header changes nothing.
 */
export function modelText(batch: readonly TeamMessage[], others: (message: TeamMessage) => readonly string[] = () => []): string {
  return batch.map((message) => {
    const source = sourceKindOf(message) === 'human' ? 'human-authored' : sourceKindOf(message) === 'agent' ? 'agent' : 'unknown';
    const from = `${safeField(message.from ?? '?')} · SID …${shortSid(message.fromId ?? '', others(message))}`;
    const to = `${safeField(message.to ?? '?')} · SID …${shortSid(message.toId ?? '', others(message))}`;
    return [
      `Source: ${source} · ${from}`,
      `To: ${to}`,
      `Message: ${message.id} · ${message.kind}`,
      'Body:',
      message.body,
    ].join('\n');
  }).join('\n\n');
}
