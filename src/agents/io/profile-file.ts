import { mkdir, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

export async function saveProfileText(path: string, source: string): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, source, { mode: 0o600 });
      await rename(temporary, path);
    } catch (error) {
      const { rm } = await import("node:fs/promises");
      await rm(temporary, { force: true });
      throw error;
    }
}
