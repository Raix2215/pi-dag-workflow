import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface RpcRecord { type: string; id?: string; command?: string; success?: boolean; data?: unknown; error?: string; [key: string]: unknown }

/** Actual isolated Pi process, using only the new package and an offline test provider. */
export class IsolatedClient {
  readonly records: RpcRecord[] = [];
  private sequence = 0;
  private stderr = "";
  private buffer = "";
  private listeners = new Set<() => void>();
  readonly child: ChildProcessWithoutNullStreams;
  readonly root: string;
  private constructor(child: ChildProcessWithoutNullStreams, root: string) {
    this.child = child;
    this.root = root;
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      this.buffer += chunk;
      let at: number;
      while ((at = this.buffer.indexOf("\n")) >= 0) {
        const line = this.buffer.slice(0, at).replace(/\r$/, "");
        this.buffer = this.buffer.slice(at + 1);
        if (line) this.records.push(JSON.parse(line));
      }
      for (const listener of this.listeners) listener();
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => { this.stderr = (this.stderr + chunk).slice(-8192); });
    child.on("error", () => { for (const listener of this.listeners) listener(); });
    child.on("close", () => { for (const listener of this.listeners) listener(); });
  }
  static async start(root?: string, session = "m1-test", extraExtensions: string[] = [], extraArgs: string[] = []): Promise<IsolatedClient> {
    const home = root ?? await mkdtemp(join(tmpdir(), "pi-dag-m1-"));
    const cli = resolve(fileURLToPath(new URL("../../node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js", import.meta.url)));
    const entry = fileURLToPath(new URL("../../src/index.ts", import.meta.url));
    const model = fileURLToPath(new URL("./offline-model.ts", import.meta.url));
    const child = spawn(process.execPath, [cli, "--mode", "rpc", "--offline", "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files", "--no-approve", "--session-id", session, "--provider", "dag-test", "--model", "scripted", "-e", entry, "-e", model, ...extraExtensions.flatMap((path) => ["-e", path]), ...extraArgs], {
      cwd: home,
      env: { PATH: process.env.PATH ?? "", HOME: home, PI_CODING_AGENT_DIR: join(home, "agent"), PI_CODING_AGENT_SESSION_DIR: join(home, "sessions"), PI_OFFLINE: "1", TERM: "xterm-256color" },
      stdio: "pipe",
    });
    const client = new IsolatedClient(child, home);
    await client.send("get_state");
    return client;
  }
  static async startFlash(extraTools: string[] = []): Promise<IsolatedClient> {
    const root = await mkdtemp(join(tmpdir(), "pi-dag-flash-"));
    const cli = fileURLToPath(new URL("../../node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js", import.meta.url));
    const entry = fileURLToPath(new URL("../../src/index.ts", import.meta.url));
    const child = spawn(process.execPath, [cli, "--mode", "rpc", "--offline", "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files", "--no-approve", "--session-dir", join(root, "sessions"), "--provider", "example-provider", "--model", "example-model", "--thinking", "low", "--tools", ["todo", "read", "grep", "find", "ls", "write", ...extraTools].join(","), "-e", entry], {
      cwd: root,
      env: { ...process.env, PI_OFFLINE: "1", PI_CODING_AGENT_SESSION_DIR: join(root, "sessions") },
      stdio: "pipe",
    });
    const client = new IsolatedClient(child, root);
    await client.send("get_state");
    return client;
  }
  async until(predicate: () => boolean, timeout = 15000): Promise<void> {
    if (predicate()) return;
    await new Promise<void>((resolvePromise, reject) => {
      const timer = setTimeout(() => finish(new Error(`RPC timeout; stderr=${this.stderr}`)), timeout);
      const check = () => {
        if (predicate()) finish();
        else if (this.child.exitCode !== null || this.child.signalCode !== null) finish(new Error(`Pi exited; stderr=${this.stderr}`));
      };
      const finish = (error?: Error) => { clearTimeout(timer); this.listeners.delete(check); error ? reject(error) : resolvePromise(); };
      this.listeners.add(check);
      check();
    });
  }
  async send(type: string, fields: Record<string, unknown> = {}): Promise<RpcRecord> {
    const id = `test-${++this.sequence}`;
    this.child.stdin.write(`${JSON.stringify({ type, ...fields, id })}\n`);
    await this.until(() => this.records.some((record) => record.type === "response" && record.id === id));
    const reply = this.records.find((record) => record.type === "response" && record.id === id)!;
    if (!reply.success) throw new Error(reply.error ?? `RPC ${type} failed`);
    return reply;
  }
  async prompt(message: string, timeout = 15000): Promise<RpcRecord[]> {
    const start = this.records.length;
    const response = await this.send("prompt", { message });
    if ((response.data as { disposition?: string })?.disposition !== "handled") await this.until(() => {
      // Child-report runs may settle concurrently. Correlate to this prompt's user message.
      const delivered = this.records.findIndex((record, index) => {
        if (index < start || record.type !== "message_start") return false;
        const item = record.message as { role?: string; content?: string | { type: string; text?: string }[] };
        const text = typeof item?.content === "string" ? item.content : item?.content?.filter((part) => part.type === "text").map((part) => part.text ?? "").join("\n");
        return item?.role === "user" && text === message;
      });
      return delivered >= 0 && this.records.slice(delivered).some((record) => record.type === "agent_settled");
    }, timeout);
    return this.records.slice(start);
  }
  async entries(): Promise<unknown[]> { return ((await this.send("get_entries")).data as { entries: unknown[] }).entries; }
  async close(remove = true): Promise<void> {
    this.child.stdin.end();
    if (this.child.exitCode === null) {
      const ended = new Promise<void>((resolvePromise) => this.child.once("close", () => resolvePromise()));
      const timeout = setTimeout(() => this.child.kill("SIGKILL"), 3000);
      await ended;
      clearTimeout(timeout);
    }
    if (remove) await rm(this.root, { recursive: true, force: true });
  }
}
