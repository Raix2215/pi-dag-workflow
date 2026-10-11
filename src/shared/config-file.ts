import { open } from 'node:fs/promises';
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
