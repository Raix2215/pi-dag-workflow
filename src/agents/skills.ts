import { access, realpath, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { homedir } from 'node:os';
import { extname, resolve } from 'node:path';

export const CHILD_SKILLS_ENV = 'PI_DAG_AGENT_SKILLS';
/** Explicit file entries only. No discovery, frontmatter loading, scripts or tool activation. */
export async function skillFiles(paths: readonly string[] | undefined, cwd: string, tools: readonly string[], signal?: AbortSignal): Promise<string[]> {
  if (!paths?.length) return [];
  if (!tools.includes('read')) throw new Error('Profile skills require the read tool; skills cannot add tools');
  if (paths.length > 8) throw new Error('Profile skills accepts at most 8 files');
  const result = new Set<string>();
  for (const [index, path] of paths.entries()) {
    if (signal?.aborted) throw new Error('Skill validation aborted');
    if (typeof path !== 'string' || !path.trim() || path.length > 2048 || /[\p{Cc}\p{Bidi_Control}\u2028\u2029]/u.test(path) || /^(?![a-z]:[\\/])[a-z][\w+.-]*:/i.test(path)) throw new Error(`Invalid local skill path at entry ${index + 1}`);
    const expanded = path.startsWith('~/') || path.startsWith('~\\') ? resolve(homedir(), path.slice(2)) : resolve(cwd, path);
    if (extname(expanded).toLowerCase() !== '.md') throw new Error(`Skill entry ${index + 1} must name a Markdown file, not a directory or package`);
    try {
      const canonical = await realpath(expanded);
      if (extname(canonical).toLowerCase() !== '.md') throw new Error('Expected a Markdown target');
      const info = await stat(canonical);
      if (!info.isFile() || !info.size || info.size > 65536 || canonical.length > 2048 || /[\p{Cc}\p{Bidi_Control}\u2028\u2029]/u.test(canonical)) throw new Error('Expected a nonempty regular file no larger than 64 KiB');
      await access(canonical, constants.R_OK);
      if (signal?.aborted) throw new Error('Skill validation aborted');
      result.add(canonical);
    } catch (cause) {
      // Do not expose paths or host errors for requested resources in failure summaries.
      throw new Error(`Skill entry ${index + 1} is not a readable local Markdown file (1–65536 bytes)${signal?.aborted ? '; validation aborted' : ''}`, { cause });
    }
  }
  const selected = [...result];
  if (Buffer.byteLength(JSON.stringify(selected)) > 20000) throw new Error('Selected skill path entries exceed 20 KiB');
  return selected;
}

/** The child consumes and removes only the selected entries; it does not inspect their bodies. */
export function takeSkillFiles(env: NodeJS.ProcessEnv = process.env): string[] {
  const raw = env[CHILD_SKILLS_ENV];
  delete env[CHILD_SKILLS_ENV];
  if (raw === undefined) return [];
  if (Buffer.byteLength(raw) > 20000) throw new Error('Invalid child skill entries');
  let files: unknown;
  try { files = JSON.parse(raw); } catch { throw new Error('Invalid child skill entries'); }
  if (!Array.isArray(files) || files.length > 8 || files.some((file) => typeof file !== 'string' || !file || file.length > 2048 || /[\p{Cc}\p{Bidi_Control}\u2028\u2029]/u.test(file))) throw new Error('Invalid child skill entries');
  return [...new Set(files as string[])];
}
