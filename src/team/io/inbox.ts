import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { configPaths } from '../../shared/config.ts';
import { deliveryBatch, markInflight, markRead, nextMessageId, openRequest, releaseDeadInflight, releaseInflight, requestedBatch, sourceKindOf, validateBody, type SourceKind, type TeamMessage } from '../domain/inbox.ts';
import { withLock } from './lock.ts';
import { readMembers, readTeam } from './registry.ts';

const inboxesDir = (teamId: string) => join(configPaths().directory, 'teams', teamId, 'inboxes');
const inboxPath = (teamId: string, sessionId: string) => join(inboxesDir(teamId), `${sessionId}.json`);
const inboxLock = (teamId: string, sessionId: string) => join(inboxesDir(teamId), `${sessionId}.lock`);
const BUSY = '信箱正被其它进程修改；稍后重试';

/** Every write to one mailbox — send, consume and delete — runs inside that recipient's lock. */
async function withInboxLock<T>(teamId: string, sessionId: string, run: () => Promise<T>): Promise<T> {
  // The first message has no directory yet: create it before the lock, never inside it.
  await mkdir(inboxesDir(teamId), { recursive: true });
  return withLock(inboxLock(teamId, sessionId), run, BUSY);
}

/** A read-only change hint for one wait call; missing inboxes never create directories or locks. */
export async function inboxStamp(teamId: string, sessionId: string): Promise<string> {
  try {
    const value = await stat(inboxPath(teamId, sessionId));
    return `${value.ino}:${value.size}:${value.mtimeMs}:${value.ctimeMs}`;
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return 'missing';
    throw cause;
  }
}

export async function readInbox(teamId: string, sessionId: string): Promise<TeamMessage[]> {
  try {
    const value = JSON.parse(await readFile(inboxPath(teamId, sessionId), 'utf8')) as { messages?: unknown };
    const messages = Array.isArray(value.messages) ? value.messages : [];
    return messages.filter((message): message is TeamMessage => !!message && typeof (message as TeamMessage).body === 'string' && typeof (message as TeamMessage).id === 'number');
  } catch { return []; }
}

async function writeInbox(teamId: string, sessionId: string, messages: readonly TeamMessage[]): Promise<void> {
  await mkdir(inboxesDir(teamId), { recursive: true });
  const path = inboxPath(teamId, sessionId), temporary = `${path}.${randomBytes(4).toString('hex')}.tmp`;
  await writeFile(temporary, `${JSON.stringify({ messages }, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, path);
}

/**
 * Delivery is a write into the recipient inbox; online state never blocks the send.
 * `toSessionId` addresses one exact session, so a rename — or a second member with the same display name —
 * cannot take a message that was written for that session. The body is stored as the sender wrote it:
 * `validateBody` refuses an unusable body, it does not rewrite one.
 */
export async function sendToMember(teamId: string, input: { from: string; fromId: string; to?: string; toSessionId?: string; body: string; kind?: TeamMessage['kind']; replyTo?: number; now: number; sourceKind?: SourceKind }): Promise<TeamMessage> {
  // The one validation rule returns the text it validated, so what is checked is exactly what is stored.
  const body = validateBody(input.body);
  // A dissolved team is de-registered, not deleted: its leftover records must not accept new mail.
  if (!await teamExists(teamId)) throw new Error(`团队 ${teamId} 已解散；消息未写入`);
  const members = await readMembers(teamId);
  const recipient = input.toSessionId === undefined
    ? undefined
    : members.find(member => member.sessionId === input.toSessionId);
  // A display name is not an identity: when history left two members with one name, the send is refused
  // instead of picking the first of them.
  const sameName = input.toSessionId === undefined ? members.filter(member => member.name === input.to) : [];
  if (input.toSessionId === undefined && sameName.length > 1) throw new Error(`名册里有多个成员叫 ${input.to}：名字无法确定收件人，请用 /team 面板按会话发送`);
  const target = recipient ?? sameName[0];
  if (!target) throw new Error(input.toSessionId === undefined
    ? `团队里没有成员 ${input.to ?? ''}；用 /team 面板或成员名册确认收件人`
    : `团队里没有会话 ${input.toSessionId}；名册可能已变化，重新确认成员`);
  const sender = members.find(member => member.sessionId === input.fromId);
  // Read, allocate, retain and write under one lock: two senders must never overwrite each other.
  return withInboxLock(teamId, target.sessionId, async () => {
    const inbox = await readInbox(teamId, target.sessionId);
    // Provenance is recorded here, from the writing path — a body can never supply it later.
    const message: TeamMessage = { id: nextMessageId(inbox), from: sender?.name ?? input.from, fromId: input.fromId, to: target.name, toId: target.sessionId, body, createdAt: input.now, acceptedAt: input.now, ...(input.replyTo === undefined ? {} : { replyTo: input.replyTo }), kind: input.kind ?? 'message', sourceKind: input.sourceKind ?? 'agent' };
    await writeInbox(teamId, target.sessionId, [...inbox, message]);
    return message;
  });
}

/**
 * Take the next batch: the earliest unread messages that are not already in flight, capped at 10, bodies
 * untouched. They are marked in flight for this receiver instance only — being queued in Pi is not a read,
 * and only the confirmed model input is (see `confirmInbox`). A message already in flight is skipped, so
 * two paths can never deliver it twice.
 */
export async function takeInbox(teamId: string, sessionId: string, instanceId: string, pid: number, now: number, options: { onlyIds?: readonly number[] } = {}): Promise<{ batch: TeamMessage[]; remaining: number }> {
  return withInboxLock(teamId, sessionId, async () => {
    const inbox = await readInbox(teamId, sessionId);
    // A user request names ids: only those are taken, FIFO, in flight skipped, request itself excluded.
    if (options.onlyIds?.length) {
      const batch = requestedBatch(inbox, options.onlyIds);
      if (!batch.length) return { batch: [], remaining: 0 };
      await writeInbox(teamId, sessionId, markInflight(inbox, new Set(batch.map(message => message.id)), instanceId, pid, now));
      return { batch, remaining: 0 };
    }
    const delivery = deliveryBatch(inbox);
    if (!delivery.batch.length) return { batch: [], remaining: delivery.remaining };
    const ids = new Set(delivery.batch.map(message => message.id));
    await writeInbox(teamId, sessionId, markInflight(inbox, ids, instanceId, pid, now));
    return { batch: delivery.batch, remaining: delivery.remaining };
  });
}

/**
 * Confirm that these messages reached the target's real model input. Only then are they read; a message
 * that is no longer in flight (released by a reload, taken by another instance) is left alone.
 */
export async function confirmInbox(teamId: string, sessionId: string, instanceId: string, ids: readonly number[], now: number): Promise<number> {
  if (!ids.length) return 0;
  return withInboxLock(teamId, sessionId, async () => {
    const inbox = await readInbox(teamId, sessionId);
    // The whole batch must still be in flight *for this instance*: a released or re-taken batch is not ours.
    const mine = ids.filter(id => inbox.some(message => message.id === id && message.readAt === undefined && message.inflight?.instanceId === instanceId));
    if (mine.length !== ids.length) return 0;
    await writeInbox(teamId, sessionId, markRead(inbox, new Set(mine), instanceId, now));
    return mine.length;
  });
}

/** Release markers whose process is gone (a crash has no shutdown), never one of a live instance. */
export async function releaseDeadMarkers(teamId: string, sessionId: string, alive: (pid: number) => boolean, keepInstance: string): Promise<number> {
  return withInboxLock(teamId, sessionId, async () => {
    const inbox = await readInbox(teamId, sessionId);
    const swept = releaseDeadInflight(inbox, alive, keepInstance);
    if (swept.released) await writeInbox(teamId, sessionId, swept.messages);
    return swept.released;
  });
}

/** A reload or an exit drops this instance's markers: what it never confirmed is unread again. */
export async function releaseInbox(teamId: string, sessionId: string, instanceId: string): Promise<number> {
  return withInboxLock(teamId, sessionId, async () => {
    const inbox = await readInbox(teamId, sessionId);
    const released = inbox.filter(message => message.inflight?.instanceId === instanceId || (message.requestTakenBy === instanceId && message.requestDoneAt === undefined)).length;
    if (released) await writeInbox(teamId, sessionId, releaseInflight(inbox, instanceId));
    return released;
  });
}

/** Unread for one inbox: a delivered-but-unconfirmed message still counts as unread. */
export async function unreadFor(teamId: string, sessionId: string): Promise<number> {
  const inbox = await readInbox(teamId, sessionId);
  return inbox.filter(message => message.readAt === undefined && message.request !== 'deliver').length;
}

/** The panel's read-only preview: never marks read, never crosses into the viewer's own context. */
export async function previewInbox(teamId: string, sessionId: string): Promise<TeamMessage[]> {
  return readInbox(teamId, sessionId);
}

/**
 * A user's delivery request: metadata in the target mailbox, not a chat message. It is claimed by exactly one
 * receiver instance under the mailbox lock, so two pollers cannot both honour it, and it never enters the
 * FIFO batch the model sees.
 */
export async function claimDeliveryRequest(teamId: string, sessionId: string, instanceId: string, now: number): Promise<{ request: TeamMessage; batch: TeamMessage[] } | undefined> {
  return withInboxLock(teamId, sessionId, async () => {
    const inbox = await readInbox(teamId, sessionId);
    const request = openRequest(inbox);
    if (!request) return undefined;
    const batch = requestedBatch(inbox, request.deliverIds ?? []);
    const next = inbox.map(message => message.id === request.id ? { ...message, requestTakenBy: instanceId, requestPid: process.pid } : message);
    await writeInbox(teamId, sessionId, batch.length ? markInflight(next, new Set(batch.map(message => message.id)), instanceId, process.pid, now) : next);
    return { request, batch };
  });
}

/** The request is done once its messages were handed over; the request itself never becomes a chat message. */
export async function finishDeliveryRequest(teamId: string, sessionId: string, requestId: number, now: number): Promise<boolean> {
  return withInboxLock(teamId, sessionId, async () => {
    const inbox = await readInbox(teamId, sessionId);
    const next = inbox.map(message => message.id === requestId ? { ...message, requestDoneAt: now } : message);
    await writeInbox(teamId, sessionId, next);
    return true;
  });
}

/** The panel writes a delivery request: metadata only, no chat body, no new human-authored message. */
export async function requestDelivery(teamId: string, input: { from: string; fromId: string; toSessionId: string; ids: readonly number[]; now: number }): Promise<TeamMessage> {
  if (!await teamExists(teamId)) throw new Error(`团队 ${teamId} 已解散；未写入投递请求`);
  const wanted = [...new Set(input.ids)].slice(0, 10);
  if (!wanted.length) throw new Error('没有可投递的消息：请求未写入');
  return withInboxLock(teamId, input.toSessionId, async () => {
    const inbox = await readInbox(teamId, input.toSessionId);
    const request: TeamMessage = {
      id: nextMessageId(inbox), from: input.from, fromId: input.fromId, to: input.toSessionId, toId: input.toSessionId,
      body: '', createdAt: input.now, kind: 'notice', sourceKind: 'human', request: 'deliver', deliverIds: wanted,
    };
    await writeInbox(teamId, input.toSessionId, [...inbox, request]);
    return request;
  });
}

/** A human write from the panel is the only source of `human`; it is a new message, never a relabel. */
export async function sendFromUser(teamId: string, input: { from: string; fromId: string; toSessionId: string; body: string; kind?: TeamMessage['kind']; replyTo?: number; now: number; deliverIds?: number[] }): Promise<TeamMessage> {
  const { deliverIds, ...rest } = input;
  const sent = await sendToMember(teamId, { ...rest, sourceKind: 'human' });
  if (!deliverIds?.length) return sent;
  // The request is one message; the ids it names stay untouched, so their provenance is never rewritten.
  return withInboxLock(teamId, input.toSessionId, async () => {
    const inbox = await readInbox(teamId, input.toSessionId);
    const next = inbox.map(message => message.id === sent.id ? { ...message, request: 'deliver' as const, deliverIds: [...deliverIds] } : message);
    await writeInbox(teamId, input.toSessionId, next);
    return next.find(message => message.id === sent.id) ?? sent;
  });
}

export { sourceKindOf };

export async function memberNames(teamId: string): Promise<string[]> {
  return (await readMembers(teamId)).map(member => member.name);
}

export async function teamExists(teamId: string): Promise<boolean> { return !!(await readTeam(teamId)); }

/** Kept for the inbox listing shape the panel ticket will consume. */
export async function inboxFiles(teamId: string): Promise<string[]> {
  return (await readdir(inboxesDir(teamId)).catch(() => [] as string[])).filter(name => name.endsWith('.json'));
}

/** Removing a member removes its mailbox: nothing else may read it once the record is gone. */
export async function deleteInbox(teamId: string, sessionId: string): Promise<boolean> {
  return withInboxLock(teamId, sessionId, async () => {
    const path = inboxPath(teamId, sessionId);
    const present = await readFile(path, 'utf8').then(() => true, () => false);
    await rm(path, { force: true });
    return present;
  });
}

/**
 * Remove one mailbox file, exactly `<sid>.json` for that SID in that team — never another recipient's copy and
 * never the directory. The recipient's own lock serialises this against a send that is being written.
 */
export async function dropInbox(teamId: string, sessionId: string): Promise<{ outcome: 'deleted' | 'missing' | 'failed'; reason?: string }> {
  // Ask before locking: the lock directory is created on demand, and a team with no mailbox must stay untouched.
  const present = await stat(inboxPath(teamId, sessionId)).then(() => true, (error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return false;
    throw error;
  }).catch((error: NodeJS.ErrnoException) => ({ unreadable: error.code ?? 'read error' }));
  if (present === false) return { outcome: 'missing' };
  if (typeof present === 'object') return { outcome: 'failed', reason: String(present.unreadable) };
  try {
    return await withInboxLock(teamId, sessionId, async () => {
      const path = inboxPath(teamId, sessionId);
      const stillThere = await readFile(path, 'utf8').then(() => true, () => false);
      if (!stillThere) return { outcome: 'missing' as const };
      await rm(path);
      return { outcome: 'deleted' as const };
    });
  } catch (error) {
    return { outcome: 'failed', reason: error instanceof Error ? error.message : String(error) };
  }
}
