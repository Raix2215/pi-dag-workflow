/** CLI priority: PI_DAG_TEST_CLI → managed host Pi (~/.pi/agent/install/current-version) → repository-locked CLI. */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm, mkdir, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { FEATURE_NAMES } from "./public-records.ts";

export interface RpcRecord { type: string; id?: string; command?: string; success?: boolean; data?: unknown; error?: string; [key: string]: unknown }

/**
 * The core five entries every non-package test loads with `-e`. It is a *subset* on purpose — the shipped
 * package declares six (see `sourcePackage`), so a test that needs the real selection matrix must use the
 * package, not this list.
 */
export const sourceEntries = ['todos', 'plan', 'agents', 'goal', 'retry'].map(name => fileURLToPath(new URL(`../../src/${name}/index.ts`, import.meta.url)));

/** Native package filters exercise source resources independently of the publication manifest. */
export async function sourcePackage(root: string): Promise<string> {
  const directory = join(root, 'source-package');
  await mkdir(directory);
  await symlink(fileURLToPath(new URL('../../src/', import.meta.url)), join(directory, 'src'), 'dir');
  // The package declares every module the product has, derived from the same list the matrix iterates: a
  // hand-written subset here silently made the Team combinations load nothing at all.
  await writeFile(join(directory, 'package.json'), JSON.stringify({ name: 'pi-dag-workflow-source-test', type: 'module', pi: { extensions: FEATURE_NAMES.map(name => `./src/${name}/index.ts`) } }));
  return directory;
}

function testCli(): string {
  const override = process.env.PI_DAG_TEST_CLI?.trim();
  if (override) return override;
  const install = join(homedir(), '.pi', 'agent', 'install');
  const current = join(install, 'current-version');
  if (existsSync(current)) {
    const cli = join(install, 'releases', readFileSync(current, 'utf8').trim(), 'node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js');
    if (existsSync(cli)) return cli;
  }
  return fileURLToPath(new URL('../../node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js', import.meta.url));
}

/** Opt-in live tests require a caller-selected model; no personal provider defaults. */
export function liveModel() {
  const reference = process.env.PI_DAG_TEST_MODEL?.trim() ?? '';
  const split = reference.indexOf('/');
  if (split < 1 || split === reference.length - 1) throw new Error('Set PI_DAG_TEST_MODEL to a registered provider/model before running a live test');
  return { provider: reference.slice(0, split), id: reference.slice(split + 1), thinking: process.env.PI_DAG_TEST_THINKING ?? 'off' };
}

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
  static async start(root?: string, session = "m1-test", extraExtensions: string[] = [], extraArgs: string[] = [], configuredPackage = false, entries?: string[], language = 'zh-CN', sessionDir?: string): Promise<IsolatedClient> {
    const home = root ?? await mkdtemp(join(tmpdir(), "pi-dag-m1-"));
    const cli = testCli();
    const model = fileURLToPath(new URL("./offline-model.ts", import.meta.url));
    const child = spawn(process.execPath, [cli, "--mode", "rpc", "--offline", ...configuredPackage ? [] : ['--no-extensions', ...(entries ?? sourceEntries).flatMap((path) => ['-e', path])], "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files", ...extraArgs.includes('--approve') ? [] : ['--no-approve'], ...sessionDir ? ["--session-dir", sessionDir] : [], "--session-id", session, "--provider", "dag-test", "--model", "scripted", "-e", model, ...extraExtensions.flatMap((path) => ["-e", path]), ...extraArgs], {
      cwd: home,
      env: { PATH: process.env.PATH ?? "", HOME: home, PI_CODING_AGENT_DIR: join(home, "agent"), PI_CODING_AGENT_SESSION_DIR: sessionDir ?? join(home, "sessions"), PI_OFFLINE: "1", TERM: "xterm-256color", LANGUAGE: language },
      stdio: "pipe",
    });
    const client = new IsolatedClient(child, home);
    await client.send("get_state");
    return client;
  }
  static async startFlash(extraTools: string[] = [], extraExtensions: string[] = []): Promise<IsolatedClient> {
    const model = liveModel();
    const root = await mkdtemp(join(tmpdir(), "pi-dag-live-"));
    const cli = testCli();
    const entry = fileURLToPath(new URL("../../", import.meta.url));
    const child = spawn(process.execPath, [cli, "--mode", "rpc", "--offline", "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files", "--no-approve", "--session-dir", join(root, "sessions"), "--provider", model.provider, "--model", model.id, "--thinking", model.thinking, "--tools", ["todo", "read", "grep", "find", "ls", "write", ...extraTools].join(","), "-e", entry, ...extraExtensions.flatMap((path) => ['-e', path])], {
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
