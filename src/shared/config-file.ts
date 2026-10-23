import { open, access, chmod, mkdir, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { homedir } from 'node:os';
import { getAgentDir } from '@earendil-works/pi-coding-agent';
import { closeSync, fstatSync, openSync, readSync } from 'node:fs';

/** Bound allocation and reads, including files that grow after stat. Preserve symlink/file errors. */
export async function readConfigText(path: string, maxBytes: number, tooLarge: string): Promise<string> {
  const file = await open(path, 'r');
  try {
    const size = (await file.stat()).size;
    if (size > maxBytes) throw new Error(tooLarge);
    let bytes = Buffer.allocUnsafe(Math.min(maxBytes + 1, Math.max(4096, size + 1))), length = 0;
    while (length <= maxBytes) {
      if (length === bytes.length) { const grown = Buffer.allocUnsafe(Math.min(maxBytes + 1, bytes.length * 2)); bytes.copy(grown, 0, 0, length); bytes = grown; }
      const { bytesRead } = await file.read(bytes, length, bytes.length - length, null);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > maxBytes) throw new Error(tooLarge);
    const text = bytes.toString('utf8', 0, length);
    if (Buffer.byteLength(text) > maxBytes) throw new Error(tooLarge);
    return text;
  } finally { await file.close(); }
}

/** The locale loader is synchronous because it also initializes command metadata. */
export function readConfigTextSync(path: string, maxBytes: number, tooLarge: string): string {
  const file = openSync(path, 'r');
  try {
    const size = fstatSync(file).size;
    if (size > maxBytes) throw new Error(tooLarge);
    let bytes = Buffer.allocUnsafe(Math.min(maxBytes + 1, Math.max(4096, size + 1))), length = 0;
    while (length <= maxBytes) {
      if (length === bytes.length) { const grown = Buffer.allocUnsafe(Math.min(maxBytes + 1, bytes.length * 2)); bytes.copy(grown, 0, 0, length); bytes = grown; }
      const count = readSync(file, bytes, length, bytes.length - length, null);
      if (!count) break;
      length += count;
    }
    if (length > maxBytes) throw new Error(tooLarge);
    const text = bytes.toString('utf8', 0, length);
    if (Buffer.byteLength(text) > maxBytes) throw new Error(tooLarge);
    return text;
  } finally { closeSync(file); }
}

export const configPaths = () => {
  const directory = join(getAgentDir(), 'pi-dag-workflow');
  return { directory, config: join(directory, 'pi-dag-workflow-config.json'), profile: join(directory, 'pi-dag-workflow-profile.json'), preset: join(directory, 'pi-dag-workflow-preset.json') };
};
let cachedConfig: { path: string; mtimeMs: number; ctimeMs: number; size: number; source: string } | undefined;
export async function readWorkflowConfig(tooLarge: string): Promise<string | undefined> {
  const path = configPaths().config;
  let source: string;
  try {
    const info = await stat(path);
    if (info.size > 16384) throw new Error(tooLarge);
    if (cachedConfig?.path === path && cachedConfig.mtimeMs === info.mtimeMs && cachedConfig.ctimeMs === info.ctimeMs && cachedConfig.size === info.size) source = cachedConfig.source;
    else {
      source = await readConfigText(path, 16384, tooLarge);
      cachedConfig = { path, mtimeMs: info.mtimeMs, ctimeMs: info.ctimeMs, size: info.size, source };
    }
  } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') { cachedConfig = undefined; return undefined; } throw error; }
  return source;
}

export async function writeWorkflowConfig(patch: object, msg: (message: string) => string, writeError: (cause: unknown, config: string) => Error): Promise<void> {
  const { directory, config } = configPaths();
  let temporary: string | undefined;
  try {
    let source = '{}';
    try { source = await readConfigText(config, 16384, msg('配置超过 16 KiB')); }
    catch (cause) { if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw cause; }
    const value: unknown = JSON.parse(source);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(msg('配置需为 JSON 对象'));
    const output = JSON.stringify({ ...value, ...patch }, null, 2) + '\n';
    if (Buffer.byteLength(output) > 16384) throw new Error(msg('配置超过 16 KiB'));
    await mkdir(directory, { recursive: true });
    temporary = join(directory, `.config-${randomUUID()}.tmp`);
    await writeFile(temporary, output, { mode: 0o600, flag: 'wx' });
    await chmod(temporary, 0o600);
    await readConfigText(temporary, 16384, msg('配置超过 16 KiB'));
    await rename(temporary, config);
    cachedConfig = undefined;
    temporary = undefined;
  } catch (cause) { throw writeError(cause, config); }
  finally { if (temporary) await rm(temporary, { force: true }); }
}

export const childExtensionPath = (entry: string): string => resolve(configPaths().directory, entry.startsWith('~/') ? join(homedir(), entry.slice(2)) : entry);

export async function resolveExtensionPaths(paths: string[] | undefined, unreadable: (entry: string) => string): Promise<string[]> {
  const resolved: string[] = [];
  for (const entry of paths ?? []) {
    // Machine-level configuration must not be satisfied by a namesake file in an arbitrary workspace.
    const path = childExtensionPath(entry);
    try {
      await access(path, constants.R_OK);
      if (!(await stat(path)).isFile()) throw new Error('not a file');
      resolved.push(await realpath(path));
    } catch { throw new Error(unreadable(entry)); }
  }
  return [...new Set(resolved)];
}
