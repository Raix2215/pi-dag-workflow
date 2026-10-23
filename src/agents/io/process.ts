import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import type { RpcRecord } from './contracts.ts';
interface PendingCommand { resolve: (record: RpcRecord) => void; reject: (error: Error) => void; cleanup: () => void }

/** The resolver lives in shared because team spawns children too; re-exported for existing callers. */
export { resolvePiCli } from '../../shared/pi-cli.ts';

export class RpcPipe {
  readonly child: ChildProcessWithoutNullStreams;
  readonly closed: Promise<void>;
  private pending = new Map<string, PendingCommand>();
  private sequence = 0;
  private buffer = "";
  stderr = "";
  private dead = false;
  private stopping = false;
  private stopPromise: Promise<void> | undefined;
  constructor(cli: string, args: string[], cwd: string, env: NodeJS.ProcessEnv, onRecord: (record: RpcRecord) => void, onFailure: (error: Error) => void, sanitize: (value: string) => string) {
    this.child = spawn(process.execPath, [cli, ...args], { cwd, env, detached: process.platform !== "win32", stdio: "pipe" });
    this.closed = new Promise((resolveClosed) => this.child.once("close", () => resolveClosed()));
    const fail = (error: Error) => {
      if (this.dead) return;
      this.dead = true;
      for (const pending of this.pending.values()) { pending.cleanup(); pending.reject(error); }
      this.pending.clear();
      if (!this.stopping) onFailure(new Error(sanitize(`${error.message}${this.stderr ? `; stderr: ${this.stderr}` : ''}`)));
    };
    this.child.stdout.setEncoding("utf8");
    this.child.stderr.setEncoding("utf8");
    this.child.stderr.on("data", (chunk: string) => { this.stderr = (this.stderr + chunk).slice(-8192); });
    this.child.stdin.on("error", (error) => fail(error));
    this.child.on("error", (error) => fail(error));
    this.child.on("close", (code, signal) => fail(new Error(`Pi exited before completion (${signal ?? code ?? "unknown"})`)));
    this.child.stdout.on("data", (chunk: string) => {
      if (this.dead) return;
      this.buffer += chunk;
      let at: number;
      while ((at = this.buffer.indexOf("\n")) >= 0) {
        const line = this.buffer.slice(0, at).replace(/\r$/, "");
        this.buffer = this.buffer.slice(at + 1);
        if (!line) continue;
        let record: RpcRecord;
        try { record = JSON.parse(line) as RpcRecord; if (!record || typeof record.type !== "string") throw new Error("Invalid record"); }
        catch { fail(new Error("Invalid Pi RPC JSONL record")); return; }
        if (record.type === "response" && record.id) {
          const pending = this.pending.get(record.id);
          if (pending) {
            pending.cleanup(); this.pending.delete(record.id);
            if (record.success) pending.resolve(record); else pending.reject(new Error(String(record.error ?? "Pi command failed")));
          }
        } else {
          try { onRecord(record); }
          catch { fail(new Error("Invalid Pi RPC event")); return; }
        }
      }
    });
  }
  command(type: string, fields: Record<string, unknown> = {}, signal?: AbortSignal): Promise<RpcRecord> {
    if (signal?.aborted) return Promise.reject(new Error(`Pi ${type} command aborted`));
    if (this.dead || this.stopping) return Promise.reject(new Error("Pi process is closed"));
    if (this.pending.size >= 32) return Promise.reject(new Error("Too many outstanding child commands"));
    const id = `rpc-${++this.sequence}`;
    return new Promise((resolveCommand, reject) => {
      const fail = (error: Error) => { const pending = this.pending.get(id); if (!pending) return; pending.cleanup(); this.pending.delete(id); reject(error); };
      const abort = () => fail(new Error(`Pi ${type} command aborted`));
      const timer = setTimeout(() => fail(new Error(`Pi ${type} command timed out`)), 15000);
      const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); };
      this.pending.set(id, { resolve: resolveCommand, reject, cleanup });
      signal?.addEventListener('abort', abort, { once: true });
      this.write({ type, ...fields, id }).catch(fail);
    });
  }
  async write(record: Record<string, unknown>): Promise<void> {
    if (this.dead || this.stopping) throw new Error("Pi process is closed");
    await new Promise<void>((resolveWrite, reject) => this.child.stdin.write(`${JSON.stringify(record)}\n`, (error) => error ? reject(error) : resolveWrite()));
  }
  stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    this.stopping = true;
    this.stopPromise = (async () => {
      for (const pending of this.pending.values()) { pending.cleanup(); pending.reject(new Error("Pi process stopped")); }
      this.pending.clear();
      // Each Unix child owns a new process group. Kill that group, including shell tools.
      // On Windows detached groups are not safe to address with negative PIDs.
      const signal = (name: NodeJS.Signals) => {
        if (!this.child.pid) return;
        try { if (process.platform !== "win32") process.kill(-this.child.pid, name); else this.child.kill(name); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") this.child.kill(name); }
      };
      this.child.stdin.end();
      signal("SIGTERM");
      const timer = setTimeout(() => signal("SIGKILL"), 1000);
      await this.closed;
      clearTimeout(timer);
      // A shell descendant can retain the group after the Pi leader exits.
      signal("SIGKILL");
    })();
    return this.stopPromise;
  }
}
