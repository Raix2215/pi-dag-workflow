import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { appendFileSync } from 'node:fs';
import { TEAM_MESSAGE } from './public-records.ts';

/** Bounded request-local omissions. It never edits history, Team state, or provider payloads. */
export default function dropTeamContextOnce(pi: ExtensionAPI): void {
  const token = process.env.PI_DAG_TEST_DROP_TOKEN;
  const record = process.env.PI_DAG_TEST_DROP_RECORD;
  if (!token || !record) throw new Error('the one-shot context fixture requires a token and an observation file');
  let remaining = Number(process.env.PI_DAG_TEST_DROP_COUNT ?? '1');
  if (remaining !== 1 && remaining !== 2) throw new Error('context omission count must be one or two');
  pi.on('context', event => {
    if (remaining === 0) return;
    const messages = event.messages.filter(message => !(message.role === 'custom'
      && message.customType === TEAM_MESSAGE && JSON.stringify(message.content).includes(token)));
    const removed = event.messages.length - messages.length;
    if (!removed) return;
    remaining--;
    appendFileSync(record, `${JSON.stringify({ removed, token, customType: TEAM_MESSAGE })}\n`);
    return { messages };
  });
}
