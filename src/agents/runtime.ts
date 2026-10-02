import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getPackageDir } from '@earendil-works/pi-coding-agent';
import { CHILD_NOTICE_PREFIX, CHILD_QUESTION_PREFIX } from "./child.ts";
import { ProfileStore, type ModelRef, type ThinkingLevel } from "./profiles.ts";

export type JobStatus = "starting" | "running" | "waiting" | "completed" | "failed" | "cancelled" | "interrupted";
export interface JobSummary {
  id: string; todoId?: number; profile: string; model: ModelRef; thinking: ThinkingLevel;
  tools: string[]; status: JobStatus; startedAt: number; endedAt?: number; error?: string; pendingRequests: number;
  /** Display-only one-line excerpt of the spawn task; never used for control flow. */
  label?: string;
  /** Terminal jobs stay "pending" until their report is delivered into the parent context. */
  reportDelivery?: "pending" | "delivered";
}
export interface AgentRequest { requestId: string; message: string }
export interface AgentUsage { requests: number; input: number; output: number; estimatedCost: number }
export interface JobResult extends JobSummary { output: string; requests: AgentRequest[]; usage?: AgentUsage; timedOut?: boolean }
export interface AgentNotice { jobId: string; kind: "message" | "question" | "completed" | "failed"; message: string; requestId?: string }
export interface SpawnOptions { task: string; todoId?: number; profile?: string; tools?: string[]; timeout?: number; context?: string }
export interface AgentRuntimeOptions {
  cwd: string; profiles: ProfileStore; getInheritedModel: () => ModelRef | undefined;
  onChanged?: (summaries: JobSummary[]) => void; onNotice?: (notice: AgentNotice) => void; onActivity?: () => void;
  childEnv?: NodeJS.ProcessEnv;
  getModelBootstrap?: (ref: ModelRef) => Promise<{ model: Record<string, unknown>; apiKey?: string; env?: NodeJS.ProcessEnv }>;
  /** Explicit test provider/resource paths only. Production children load only child.ts. */
  testExtensions?: string[];
  /** Test startup/protocol failures with a uniquely named local fixture. */
  testCliPath?: string;
}
interface RpcRecord { type: string; id?: string; success?: boolean; error?: string; [key: string]: unknown }
interface PendingCommand { resolve: (record: RpcRecord) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }
const ACTIVE = new Set<JobStatus>(["starting", "running", "waiting"]);
/** Concurrent child processes; a busy pool reports back instead of queueing work. */
const MAX_ACTIVE_JOBS = 8;
const DEFAULT_TIMEOUT = 600;

/** Resolve the running Pi host first; package installs need not carry their own Pi copy. */
export function resolvePiCli(): string {
  const require = createRequire(import.meta.url);
  const folders = [getPackageDir(), ...(require.resolve.paths('@earendil-works/pi-coding-agent') ?? []).map((path) => join(path, '@earendil-works/pi-coding-agent'))];
  for (const folder of folders) {
    try {
      const pkg = JSON.parse(readFileSync(join(folder, "package.json"), "utf8")) as { name?: string; bin?: string | { pi?: string } };
      if (pkg.name === "@earendil-works/pi-coding-agent") {
        const bin = typeof pkg.bin === "string" ? pkg.bin : pkg.bin?.pi;
        if (!bin) throw new Error("Pi package has no CLI bin");
        return resolve(folder, bin);
      }
    } catch (error) { if (!(error instanceof SyntaxError) && (error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  throw new Error("Cannot locate installed Pi package bin");
}

class RpcPipe {
  readonly child: ChildProcessWithoutNullStreams;
  readonly closed: Promise<void>;
  private pending = new Map<string, PendingCommand>();
  private sequence = 0;
  private buffer = "";
  stderr = "";
  private dead = false;
  private stopping = false;
  private stopPromise: Promise<void> | undefined;
  constructor(cli: string, args: string[], cwd: string, env: NodeJS.ProcessEnv, onRecord: (record: RpcRecord) => void, onFailure: (error: Error) => void) {
    this.child = spawn(process.execPath, [cli, ...args], { cwd, env, detached: process.platform !== "win32", stdio: "pipe" });
    this.closed = new Promise((resolveClosed) => this.child.once("close", () => resolveClosed()));
    const fail = (error: Error) => {
      if (this.dead) return;
      this.dead = true;
      for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
      this.pending.clear();
      if (!this.stopping) onFailure(error);
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
            clearTimeout(pending.timer); this.pending.delete(record.id);
            if (record.success) pending.resolve(record); else pending.reject(new Error(String(record.error ?? "Pi command failed")));
          }
        } else onRecord(record);
      }
    });
  }
  command(type: string, fields: Record<string, unknown> = {}): Promise<RpcRecord> {
    if (this.dead || this.stopping) return Promise.reject(new Error("Pi process is closed"));
    if (this.pending.size >= 32) return Promise.reject(new Error("Too many outstanding child commands"));
    const id = `rpc-${++this.sequence}`;
    return new Promise((resolveCommand, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`Pi ${type} command timed out`)); }, 15000);
      this.pending.set(id, { resolve: resolveCommand, reject, timer });
      this.write({ type, ...fields, id }).catch((error: Error) => {
        const pending = this.pending.get(id); if (!pending) return;
        clearTimeout(timer); this.pending.delete(id); reject(error);
      });
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
      for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new Error("Pi process stopped")); }
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
export interface JobActivity { kind: "thinking" | "tool" | "output"; tool?: string; since?: number }
interface LiveJob {
  summary: JobSummary; output: string; requests: Map<string, string>; usage: AgentUsage;
  activity?: JobActivity; activeTools: Map<string, { tool: string; since: number }>; pipe?: RpcPipe; timer?: NodeJS.Timeout; listeners: Set<() => void>; finishing?: Promise<void>;
  sawEnd: boolean; lastStop?: string; lastError?: string; settling: boolean; settleAgain: boolean; generation: number; sends: number;
}
function seconds(value: number | undefined, fallback: number, max: number): number {
  const result = value ?? fallback;
  if (!Number.isFinite(result) || result <= 0 || result > max) throw new Error(`timeout must be greater than 0 and at most ${max} seconds`);
  return result;
}
function message(value: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error("message must contain text");
  return value;
}

/**
 * One clean line for the panel: the spawn task can span lines, carry control characters, or be
 * arbitrarily long, and it is shown next to jobs that are not bound to any Todo.
 */
function jobLabel(task: string): string {
  return task
    // Escape sequences first: without this, removing the control bytes would leave "[31m" behind.
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b[@-Z\\-_]|\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\s+/g, " ")
    .replace(/[\p{Cc}\p{Cf}]/gu, "")
    .trim()
    .slice(0, 80);
}

/** In-memory live processes, with compact plain summaries exported for native Pi entries. */
export class AgentRuntime {
  private readonly options: AgentRuntimeOptions;
  private jobs = new Map<string, LiveJob>();
  private sequence = 0;
  private unavailable = false;
  private restoring = false;
  constructor(options: AgentRuntimeOptions) { this.options = options; }
  activeCount(): number { return [...this.jobs.values()].filter((job) => ACTIVE.has(job.summary.status) || job.pipe !== undefined).length; }
  /** Model-facing projection: ids, states and progress only, never task text or child output. */
  inspect(jobId?: string): JobSummary[] {
    const plain = (summary: JobSummary): JobSummary => { const { label: _label, ...rest } = summary; return rest; };
    return structuredClone(jobId ? [plain(this.job(jobId).summary)] : [...this.jobs.values()].map((job) => plain(job.summary)));
  }
  viewSummaries(): (Pick<JobSummary, 'id' | 'todoId' | 'profile' | 'status' | 'reportDelivery' | 'label'> & { activity?: JobActivity })[] {
    return [...this.jobs.values()].map((job) => ({ id: job.summary.id, profile: job.summary.profile, status: job.summary.status,
      ...(job.summary.todoId !== undefined ? { todoId: job.summary.todoId } : {}),
      ...(job.summary.reportDelivery !== undefined ? { reportDelivery: job.summary.reportDelivery } : {}),
      ...(job.summary.label !== undefined ? { label: job.summary.label } : {}),
      ...(job.activity ? { activity: { ...job.activity } } : {}),
    }));
  }
  exportSummaries(): JobSummary[] { return structuredClone([...this.jobs.values()].map((job) => job.summary)); }
  exportRecords(): JobResult[] { return [...this.jobs.values()].map((job) => this.result(job)); }
  activities(): { jobId: string; activity: JobActivity }[] {
    return [...this.jobs.values()].filter((job): job is LiveJob & { activity: JobActivity } => Boolean(job.activity)).map((job) => ({ jobId: job.summary.id, activity: structuredClone(job.activity) }));
  }
  private job(id: string): LiveJob { const job = this.jobs.get(id); if (!job) throw new Error(`Unknown agent: ${id}`); return job; }
  private changed(job?: LiveJob): void {
    if (job) { job.summary.pendingRequests = job.requests.size; for (const listener of job.listeners) listener(); }
    if (!this.restoring) this.options.onChanged?.(this.exportSummaries());
  }
  private notice(job: LiveJob, notice: Omit<AgentNotice, "jobId">): void {
    if (this.jobs.get(job.summary.id) === job && !job.finishing && !this.restoring) this.options.onNotice?.({ jobId: job.summary.id, ...notice });
  }
  private append(job: LiveJob, text: string): void { job.output += text; }
  async spawn(input: SpawnOptions): Promise<JobSummary> {
    if (this.unavailable) throw new Error("Agent runtime is resetting or shut down");
    if (typeof input.task !== "string" || !input.task.trim() || input.task.length > 65536) throw new Error("task must contain 1–65536 characters");
    if (this.jobs.size >= 128) throw new Error("128 agent records retained. Remove old agents before spawning more.");
    if (this.activeCount() >= MAX_ACTIVE_JOBS) throw new Error(`All ${MAX_ACTIVE_JOBS} agent slots are busy. Wait or cancel an active agent; work is not queued.`);
    if (input.todoId !== undefined && (!Number.isSafeInteger(input.todoId) || input.todoId < 1)) throw new Error("Invalid todoId");
    if (input.todoId !== undefined && [...this.jobs.values()].some((job) => job.summary.todoId === input.todoId && (ACTIVE.has(job.summary.status) || job.pipe))) throw new Error(`Todo #${input.todoId} already has an active agent`);
    const profile = this.options.profiles.resolve(input.profile, this.options.getInheritedModel(), input.tools);
    const timeout = seconds(input.timeout, DEFAULT_TIMEOUT, 86400);
    const label = jobLabel(input.task);
    const summary: JobSummary = { id: `a${++this.sequence}`, ...(input.todoId === undefined ? {} : { todoId: input.todoId }), profile: profile.name, model: profile.model, thinking: profile.thinking, tools: profile.tools, status: "starting", startedAt: Date.now(), pendingRequests: 0, ...(label ? { label } : {}) };
    const job: LiveJob = { summary, output: "", usage: { requests: 0, input: 0, output: 0, estimatedCost: 0 }, requests: new Map(), activeTools: new Map(), listeners: new Set(), sawEnd: false, settling: false, settleAgain: false, generation: 0, sends: 0 };
    this.jobs.set(summary.id, job);
    job.timer = setTimeout(() => { void this.finish(job, "failed", "Agent deadline exceeded"); }, timeout * 1000);
    this.changed(job); // Reserve the slot before the first await; concurrent spawn cannot exceed the limit.
    try {
      if (job.finishing) return structuredClone(job.summary);
      const cli = this.options.testCliPath ?? resolvePiCli();
      let bootstrapEnv: NodeJS.ProcessEnv = {};
      if (this.options.getModelBootstrap) {
        const bootstrap = await this.options.getModelBootstrap(profile.model);
        if (job.finishing) return structuredClone(job.summary);
        bootstrapEnv = { ...bootstrap.env, PI_DAG_AGENT_MODEL_BOOTSTRAP: JSON.stringify({ model: { ...bootstrap.model, provider: profile.model.provider, id: profile.model.id }, ...(bootstrap.apiKey === undefined ? {} : { apiKey: bootstrap.apiKey }) }) };
      }
      const childExtension = fileURLToPath(new URL("./child.ts", import.meta.url));
      const args = ["--mode", "rpc", "--no-session", "--offline", "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-approve", "--provider", profile.model.provider, "--model", profile.model.id, "--tools", [...profile.tools, "subagent_send"].join(","), "-e", childExtension, ...(this.options.testExtensions ?? []).flatMap((path) => ["-e", path])];
      job.pipe = new RpcPipe(cli, args, this.options.cwd, { ...process.env, ...this.options.childEnv, ...bootstrapEnv, ...(profile.instructions ? { PI_DAG_AGENT_PROFILE_PROMPT: profile.instructions } : {}), ...(input.context ? { PI_DAG_AGENT_CONTEXT: input.context } : {}), PI_OFFLINE: "1", PI_DAG_CHILD: "1" }, (record) => this.record(job, record), (error) => { void this.finish(job, "failed", "Child process failed", error.message); });
      await job.pipe.command("get_state");
      if (job.finishing) return structuredClone(job.summary);
      // CLI model lookup permits fuzzy IDs. RPC set_model must resolve the exact registry ID.
      await job.pipe.command("set_model", { provider: profile.model.provider, modelId: profile.model.id });
      const supported = await job.pipe.command("get_available_thinking_levels");
      const levels = (supported.data as { levels?: string[] } | undefined)?.levels;
      if (!levels?.includes(profile.thinking)) throw new Error(`Thinking level ${profile.thinking} is unsupported by selected child model`);
      await job.pipe.command("set_thinking_level", { level: profile.thinking });
      await job.pipe.command("set_auto_retry", { enabled: false });
      if (job.finishing) return structuredClone(job.summary);
      job.summary.status = "running";
      this.changed(job);
      const accepted = await job.pipe.command("prompt", { message: input.task });
      if ((accepted.data as { disposition?: string } | undefined)?.disposition === "handled") throw new Error("Child task was handled without an agent run");
    } catch (error) {
      await this.finish(job, "failed", "Child startup or prompt failed", String(error));
    }
    return structuredClone(job.summary);
  }
  private record(job: LiveJob, record: RpcRecord): void {
    if (job.finishing || this.jobs.get(job.summary.id) !== job) return;
    if (record.type === "message_update") {
      const update = record.assistantMessageEvent as { type?: string } | undefined;
      const kind = update?.type === "thinking_delta" || update?.type === "thinking_start" ? "thinking" : update?.type === "text_delta" || update?.type === "text_start" ? "output" : undefined;
      if (kind && !job.activeTools.size && job.activity?.kind !== kind) { job.activity = { kind, since: Date.now() }; this.options.onActivity?.(); }
    } else if (record.type === "tool_execution_start") {
      job.activeTools.set(String(record.toolCallId ?? record.toolName), { tool: String(record.toolName ?? ""), since: Date.now() });
      this.toolActivity(job);
    } else if (record.type === "tool_execution_end") {
      job.activeTools.delete(String(record.toolCallId ?? record.toolName));
      this.toolActivity(job);
    } else if (record.type === "message_end") {
      const msg = record.message as { role?: string; content?: { type?: string; text?: string }[]; stopReason?: string; errorMessage?: string; usage?: { input?: number; output?: number; cost?: { total?: number } } } | undefined;
      if (msg?.role === "assistant") {
        const number = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
        job.usage.requests++;
        job.usage.input += number(msg.usage?.input); job.usage.output += number(msg.usage?.output);
        job.usage.estimatedCost += number(msg.usage?.cost?.total);
        this.append(job, (msg.content ?? []).filter((block) => block.type === "text").map((block) => block.text ?? "").join("\n") + "\n");
        job.lastStop = msg.stopReason ?? "stop";
        if (msg.errorMessage) job.lastError = msg.errorMessage;
      }
    } else if (record.type === "agent_start") {
      job.sawEnd = false; job.generation++; delete job.activity; job.activeTools.clear(); job.summary.status = job.requests.size ? "waiting" : "running"; this.changed(job);
    } else if (record.type === "agent_end") {
      job.sawEnd = true; delete job.activity; job.activeTools.clear(); this.options.onActivity?.();
    } else if (record.type === "agent_settled") {
      void this.settled(job);
    } else if (record.type === "extension_ui_request") {
      const id = record.id;
      if (record.method === "notify" && typeof record.message === "string" && record.message.startsWith(CHILD_NOTICE_PREFIX)) {
        const text = record.message.slice(CHILD_NOTICE_PREFIX.length);
        this.append(job, `[Report] ${text}\n`); this.notice(job, { kind: "message", message: text });
      } else if (record.method === "input" && id && typeof record.title === "string" && record.title.startsWith(CHILD_QUESTION_PREFIX)) {
        if (job.requests.size >= 16) { void this.finish(job, "failed", "Too many pending child questions"); return; }
        const text = record.title.slice(CHILD_QUESTION_PREFIX.length);
        job.requests.set(id, text); job.summary.status = "waiting"; this.changed(job);
        this.notice(job, { kind: "question", message: text, requestId: id });
      } else if (id && ["input", "select", "confirm", "editor"].includes(String(record.method))) {
        void job.pipe?.write({ type: "extension_ui_response", id, cancelled: true }).catch(() => undefined);
      }
    }
  }
  private toolActivity(job: LiveJob): void {
    const tool = [...job.activeTools.values()].at(-1);
    if (tool) job.activity = { kind: "tool", tool: tool.tool, since: tool.since };
    else delete job.activity;
    this.options.onActivity?.();
  }
  private async settled(job: LiveJob): Promise<void> {
    if (!job.sawEnd || job.finishing || !job.pipe) return;
    if (job.settling) { job.settleAgain = true; return; }
    job.settling = true;
    const generation = job.generation;
    try {
      const state = await job.pipe.command("get_state");
      const data = state.data as { isStreaming?: boolean; pendingMessageCount?: number; isCompacting?: boolean };
      if (job.finishing || generation !== job.generation || job.sends || data.isStreaming || data.isCompacting || data.pendingMessageCount || job.requests.size) return;
      const failed = job.lastStop === "error" || job.lastStop === "aborted";
      await this.finish(job, failed ? "failed" : "completed", failed ? "Child model failed or aborted" : undefined, job.lastError);
    } catch (error) { if (!job.finishing) await this.finish(job, "failed", "Child completion check failed", String(error)); }
    finally {
      job.settling = false;
      if (job.settleAgain) { job.settleAgain = false; void this.settled(job); }
    }
  }
  private finish(job: LiveJob, status: JobStatus, error?: string, diagnostic?: string): Promise<void> {
    if (job.finishing) return job.finishing;
    if (!ACTIVE.has(job.summary.status) && !job.pipe) return Promise.resolve();
    job.finishing = (async () => {
      if (job.timer) clearTimeout(job.timer);
      if (diagnostic) this.append(job, `[Error] ${diagnostic}\n`);
      await job.pipe?.stop();
      delete job.pipe;
      delete job.activity;
      job.activeTools.clear();
      job.requests.clear();
      job.summary.status = status; job.summary.endedAt = Date.now();
      if (status === "completed" || status === "failed") job.summary.reportDelivery = "pending";
      if (error) job.summary.error = error;
      // Queue the terminal notice before the completion paint so a pending report never flashes as returned.
      if (!this.restoring && this.jobs.get(job.summary.id) === job && (status === "completed" || status === "failed")) this.options.onNotice?.({ jobId: job.summary.id, kind: status, message: status === "completed" ? job.output : error ?? "Child failed" });
      this.changed(job);
    })();
    return job.finishing;
  }
  async send(input: { recipient?: string; message: string; requestId?: string }): Promise<void> {
    const text = message(input.message);
    const matches = input.requestId ? [...this.jobs.values()].filter((item) => item.requests.has(input.requestId!)) : [];
    if (!input.recipient && matches.length !== 1) throw new Error("Specify recipient, or a unique pending child requestId");
    const job = input.recipient ? this.job(input.recipient) : matches[0]!;
    if (!ACTIVE.has(job.summary.status) || !job.pipe || job.finishing) throw new Error("Agent is no longer active");
    if (job.summary.status === "starting") throw new Error("Agent is still starting; wait briefly before sending");
    if (input.requestId) {
      if (!job.requests.has(input.requestId)) throw new Error("Unknown or already answered child requestId");
      job.requests.delete(input.requestId);
      try { await job.pipe.write({ type: "extension_ui_response", id: input.requestId, value: text }); }
      catch (error) { await this.finish(job, "failed", "Child reply failed", String(error)); throw error; }
      if (!job.finishing) { job.summary.status = job.requests.size ? "waiting" : "running"; this.changed(job); }
    } else {
      if (job.sends >= 16) throw new Error("Too many pending parent messages; wait for the child to consume them");
      job.sends++; job.generation++;
      try {
        const state = await job.pipe.command("get_state");
        const queued = (state.data as { pendingMessageCount?: number } | undefined)?.pendingMessageCount ?? 0;
        if (queued + job.sends > 16) throw new Error("Child message buffer is full; reply to questions or wait before sending more");
        await job.pipe.command("prompt", { message: text, streamingBehavior: "steer" });
      } finally {
        job.sends--;
        if (job.sawEnd && !job.finishing) void this.settled(job);
      }
    }
  }
  private result(job: LiveJob, timedOut = false): JobResult {
    return { ...structuredClone(job.summary), output: job.output, usage: { ...job.usage }, requests: [...job.requests].map(([requestId, text]) => ({ requestId, message: text })), ...(timedOut ? { timedOut: true } : {}) };
  }
  async wait(jobId: string, options: { timeout?: number; signal?: AbortSignal } = {}): Promise<JobResult> {
    const job = this.job(jobId);
    const timeout = options.timeout === 0 ? 0 : seconds(options.timeout, 30, 300);
    if (options.signal?.aborted) throw new Error("Wait aborted (agent continues)");
    if (timeout === 0 || (!ACTIVE.has(job.summary.status) && !job.pipe) || job.requests.size) return this.result(job);
    return new Promise((resolveWait, reject) => {
      const finish = (timedOut = false, aborted = false) => {
        clearTimeout(timer); job.listeners.delete(check); options.signal?.removeEventListener("abort", abort);
        if (aborted) reject(new Error("Wait aborted (agent continues)")); else resolveWait(this.result(job, timedOut));
      };
      const check = () => { if ((!ACTIVE.has(job.summary.status) && !job.pipe) || job.requests.size) finish(); };
      const abort = () => finish(false, true);
      const timer = setTimeout(() => finish(true), timeout * 1000);
      job.listeners.add(check); options.signal?.addEventListener("abort", abort, { once: true }); check();
    });
  }
  async cancel(jobId: string, options: { remove?: boolean } = {}): Promise<void> {
    const job = this.job(jobId);
    await this.finish(job, "cancelled");
    if (options.remove) { this.jobs.delete(jobId); this.changed(); }
  }
  async remove(jobId: string): Promise<void> { await this.cancel(jobId, { remove: true }); }
  /** Acknowledge that a terminal report reached the parent context. Never revives a process. */
  markReportDelivered(jobId: string): boolean {
    const job = this.jobs.get(jobId);
    if (!job || (job.summary.status !== "completed" && job.summary.status !== "failed") || job.summary.reportDelivery !== "pending") return false;
    job.summary.reportDelivery = "delivered";
    this.changed(job);
    return true;
  }
  async importSummaries(summaries: readonly (JobSummary | JobResult)[]): Promise<void> {
    // Decode untrusted branch entries before touching the live runtime.
    if (!Array.isArray(summaries) || summaries.length > 128) throw new Error("Invalid agent summaries");
    const restored = summaries.map((item) => {
      if (!item || !/^a[1-9]\d{0,8}$/.test(item.id) || ![...ACTIVE, "completed", "failed", "cancelled", "interrupted"].includes(item.status) || !Number.isFinite(item.startedAt) || typeof item.profile !== "string" || !Array.isArray(item.tools) || !item.model || typeof item.model.provider !== "string" || typeof item.model.id !== "string") throw new Error("Invalid agent summary");
      const delivery = (item as { reportDelivery?: unknown }).reportDelivery;
      if (delivery !== undefined && delivery !== "pending" && delivery !== "delivered") throw new Error("Invalid agent summary");
      const terminal = item.status === "completed" || item.status === "failed";
      const summary: JobSummary = {
        id: item.id, ...(Number.isSafeInteger(item.todoId) && item.todoId! > 0 ? { todoId: item.todoId } : {}),
        profile: item.profile.slice(0, 48), model: { provider: item.model.provider.slice(0, 200), id: item.model.id.slice(0, 200) },
        ...(typeof (item as { label?: unknown }).label === "string" ? { label: jobLabel(String((item as { label?: unknown }).label)) } : {}),
        thinking: item.thinking, tools: item.tools.filter((tool: unknown): tool is string => typeof tool === "string").slice(0, 8),
        status: ACTIVE.has(item.status) ? "interrupted" : item.status, startedAt: item.startedAt, pendingRequests: 0,
        ...(typeof item.endedAt === "number" ? { endedAt: item.endedAt } : {}),
        ...(terminal && (delivery === "pending" || delivery === "delivered") ? { reportDelivery: delivery } : {}),
        ...(ACTIVE.has(item.status) ? { endedAt: Date.now(), error: "Interrupted on session restore; process was not revived" } : item.error ? { error: String(item.error).slice(0, 200) } : {}),
      };
      return summary;
    });
    if (new Set(restored.map((item) => item.id)).size !== restored.length) throw new Error("Duplicate restored agent ID");
    this.unavailable = true;
    this.restoring = true;
    try {
      await Promise.all([...this.jobs.values()].map((job) => this.finish(job, "interrupted")));
      this.jobs.clear();
      for (const [index, summary] of restored.entries()) {
        const record = summaries[index] as Partial<JobResult>;
        const output = typeof record.output === "string" ? record.output : "";
        this.sequence = Math.max(this.sequence, Number(summary.id.slice(1)));
        const number = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
        const usage = { requests: number(record.usage?.requests), input: number(record.usage?.input), output: number(record.usage?.output), estimatedCost: number(record.usage?.estimatedCost) };
        this.jobs.set(summary.id, { summary, usage, output, requests: new Map(), activeTools: new Map(), listeners: new Set(), sawEnd: false, settling: false, settleAgain: false, generation: 0, sends: 0 });
      }
    } finally { this.unavailable = false; this.restoring = false; }
    this.changed();
  }
  async shutdown(): Promise<void> {
    this.unavailable = true;
    await Promise.all([...this.jobs.values()].map((job) => this.finish(job, "interrupted")));
  }
}
