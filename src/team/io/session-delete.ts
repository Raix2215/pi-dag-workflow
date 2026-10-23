/**
 * Deleting a saved Pi session on the user's behalf, and with it every mailbox that belonged to that session.
 *
 * Pi's own `/resume` delete lives in the interactive layer (`deleteSessionFile` in session-selector) and is not
 * exported, so this module implements the same two-step strategy itself — `trash` first (with `--`, so a path
 * that starts with a dash is data), `unlink` as the fallback — and reports which one actually ran. Nothing here
 * touches the Pi host, `/resume`, or a session's contents: it removes the file, or it reports failure.
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readdir, stat, unlink } from 'node:fs/promises';
import { archivedManifestPath, readTeam, teamsRoot } from './registry.ts';
import { dropInbox } from './inbox.ts';

/** How the file actually went away. `failed` means it is still there (or unverified), so nothing else may run. */
export type SessionDeleteMethod = 'trashed' | 'unlinked' | 'failed';

export interface SessionDeleteOutcome {
  readonly method: SessionDeleteMethod;
  readonly file: string;
  /** Why it failed, or why `trash` was not the method that ran. */
  readonly reason?: string;
}

const TRASH_HINT = 200;

/** Everything `trash` printed, trimmed to one line: enough to explain the fallback, never unbounded. */
function trashHint(result: { error?: Error; stderr?: string | null; status?: number | null }): string {
  const parts: string[] = [];
  if (result.error) parts.push(result.error.message);
  const stderr = result.stderr?.trim();
  if (stderr) parts.push(stderr.split('\n')[0] ?? stderr);
  if (!parts.length && result.status !== null && result.status !== undefined) parts.push(`退出码 ${result.status}`);
  return `trash: ${parts.join(' · ').slice(0, TRASH_HINT)}`;
}

/**
 * `trash -- <file>`, then `unlink` when that did not work.
 *
 * A zero exit from `trash` only counts when the file is really gone afterwards — a stub or a broken trash that
 * claims success while leaving the file is not a deletion. The fallback is a permanent delete, which is why the
 * caller must have confirmed with the user first and why the method is reported instead of assumed.
 */
export async function deleteSessionFile(file: string): Promise<SessionDeleteOutcome> {
  if (!existsSync(file)) return { method: 'failed', file, reason: '会话文件不存在（未删除任何信箱）' };
  // `--` always: a member's session path can legitimately begin with a dash, and it is data, not a flag.
  const trashed = spawnSync('trash', ['--', file], { encoding: 'utf8' });
  const hint = trashHint(trashed);
  if (trashed.status === 0 && !existsSync(file)) return { method: 'trashed', file };
  try {
    await unlink(file);
    return { method: 'unlinked', file, reason: trashed.status === 0 ? `trash 报告成功但文件仍在（${hint}）` : hint };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { method: 'failed', file, reason: `${message}（${hint}）` };
  }
}

/** One mailbox's fate: this file only, never another recipient's copy and never a whole directory. */
export interface InboxDrop {
  readonly teamId: string;
  /** The team was dissolved in place; its mailbox file still lived there, so it is included. */
  readonly archived: boolean;
  readonly outcome: 'deleted' | 'missing' | 'failed';
  readonly reason?: string;
}

/** A team directory whose manifest is gone but whose archived carrier is still there: a dissolved team. */
async function isArchivedTeam(teamId: string): Promise<boolean> {
  try { await stat(archivedManifestPath(teamId)); return true; } catch { return false; }
}

/** Every team that could hold a mailbox for this SID: active ones and dissolved ones, nothing else. */
export async function teamsHoldingData(): Promise<{ teamId: string; archived: boolean }[]> {
  const root = teamsRoot();
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  const teams: { teamId: string; archived: boolean }[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith('t-')) continue;
    const active = await readTeam(entry.name);
    if (active) { teams.push({ teamId: entry.name, archived: false }); continue; }
    if (await isArchivedTeam(entry.name)) teams.push({ teamId: entry.name, archived: true });
  }
  return teams;
}

/**
 * Remove `inboxes/<sid>.json` in every team that has one. Called only after the session file is confirmed gone:
 * a session that still exists keeps its mail, because those messages are still deliverable to it.
 */
export async function deleteInboxesForSid(sessionId: string): Promise<InboxDrop[]> {
  const drops: InboxDrop[] = [];
  for (const team of await teamsHoldingData()) {
    const outcome = await dropInbox(team.teamId, sessionId);
    drops.push({ teamId: team.teamId, archived: team.archived, ...outcome });
  }
  return drops;
}
