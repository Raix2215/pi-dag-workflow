import { open, rm } from 'node:fs/promises';

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Exclusive Team IO lock. One writer per path: the whole read→modify→write runs inside `run`, so a
 * second writer waits instead of overwriting the first one's snapshot. A rename alone only makes the
 * replacement complete, never the transaction.
 */
export async function withLock<T>(path: string, run: () => Promise<T>, busy = '任务目录正被其它进程修改；稍后重试'): Promise<T> {
  for (let attempt = 0; attempt < 300; attempt++) {
    let handle;
    try { handle = await open(path, 'wx', 0o600); }
    catch (cause) { if ((cause as NodeJS.ErrnoException).code !== 'EEXIST') throw cause; await sleep(20); continue; }
    try { return await run(); }
    finally { await handle.close().catch(() => {}); await rm(path, { force: true }).catch(() => {}); }
  }
  throw new Error(busy);
}
