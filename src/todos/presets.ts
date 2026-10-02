import { readFile } from "node:fs/promises";
import type { Todo } from "./state.ts";

/**
 * A reusable task fragment for workflows that repeat. Definitions live in one user-level file;
 * instantiating one appends real Todos tagged with `metadata.preset`/`run`/`key`, so a fragment
 * can be reopened later without touching the rest of the list.
 */
export interface PresetStep {
  key: string;
  subject: string;
  description?: string;
  activeForm?: string;
  owner?: string;
  after?: string[];
}
export interface Preset { name: string; description?: string; skill?: string; steps: PresetStep[] }
export interface PresetOptions { path?: string }
export interface ExpandedPreset { name: string; skill?: string; run: number; tasks: Todo[]; ids: Map<string, number> }

const MAX_PRESETS = 64;
const MAX_STEPS = 32;
const MAX_FILE_BYTES = 65536;
const NAME = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,47}$/;
const KEY = /^[a-z0-9][a-z0-9_-]{0,31}$/;

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected a preset configuration object");
  return value as Record<string, unknown>;
}
function exactKeys(value: Record<string, unknown>, keys: readonly string[]): void {
  const unknown = Object.keys(value).find((key) => !keys.includes(key));
  if (unknown) throw new Error(`Unknown preset field: ${unknown}`);
}
function text(value: unknown, field: string, max: number, pattern?: RegExp): string {
  if (typeof value !== "string") throw new Error(`Invalid preset ${field}`);
  const clean = value.replace(/[\r\n\t]/g, " ").replace(/[\p{Cc}\p{Cf}]/gu, "").trim();
  if (!clean || clean.length > max || (pattern && !pattern.test(clean))) throw new Error(`Invalid preset ${field}`);
  return clean;
}

/** In-memory presets, reloaded from disk before every use so edits apply without a restart. */
export class PresetStore {
  private presets = new Map<string, Preset>();
  private readonly options: PresetOptions;
  constructor(options: PresetOptions = {}) { this.options = options; }
  private step(value: unknown, seen: Set<string>): PresetStep {
    const record = object(value);
    exactKeys(record, ["key", "subject", "description", "activeForm", "owner", "after"]);
    const key = text(record.key, "step key", 32, KEY);
    if (seen.has(key)) throw new Error(`Duplicate preset step key: ${key}`);
    seen.add(key);
    const after = record.after === undefined ? undefined : (Array.isArray(record.after) ? record.after.map((item) => text(item, "step dependency", 32, KEY)) : (() => { throw new Error("Invalid preset step dependencies"); })());
    return {
      key,
      subject: text(record.subject, "step subject", 200),
      ...(record.description === undefined ? {} : { description: text(record.description, "step description", 400) }),
      ...(record.activeForm === undefined ? {} : { activeForm: text(record.activeForm, "step activeForm", 200) }),
      ...(record.owner === undefined ? {} : { owner: text(record.owner, "step owner", 48, NAME) }),
      ...(after && after.length ? { after } : {}),
    };
  }
  private preset(value: unknown): Preset {
    const record = object(value);
    exactKeys(record, ["name", "description", "skill", "steps"]);
    const name = text(record.name, "name", 48, NAME);
    if (!Array.isArray(record.steps) || !record.steps.length || record.steps.length > MAX_STEPS) throw new Error(`Preset ${name} needs 1-${MAX_STEPS} steps`);
    const seen = new Set<string>();
    const steps = record.steps.map((item) => this.step(item, seen));
    for (const step of steps) for (const dependency of step.after ?? []) {
      if (dependency === step.key) throw new Error(`Preset ${name}: step ${step.key} depends on itself`);
      if (!seen.has(dependency)) throw new Error(`Preset ${name}: step ${step.key} depends on unknown key ${dependency}`);
    }
    // Any order the definition uses must be resolvable: reject cycles before they reach a session.
    const order = new Map(steps.map((step) => [step.key, step.after ?? []]));
    const done = new Set<string>();
    while (done.size < order.size) {
      const ready = [...order.keys()].filter((key) => !done.has(key) && (order.get(key) ?? []).every((dependency) => done.has(dependency)));
      if (!ready.length) throw new Error(`Preset ${name} has a dependency cycle`);
      for (const key of ready) done.add(key);
    }
    return {
      name,
      ...(record.description === undefined ? {} : { description: text(record.description, "description", 200) }),
      ...(record.skill === undefined ? {} : { skill: text(record.skill, "skill", 64, NAME) }),
      steps,
    };
  }
  get(name: string): Preset | undefined { const preset = this.presets.get(name); return preset ? structuredClone(preset) : undefined; }
  list(): Preset[] { return structuredClone([...this.presets.values()]); }
  /** Replace the loaded set from the configuration file; a missing file means no presets. */
  async load(): Promise<void> {
    if (!this.options.path) { this.presets.clear(); return; }
    let source: string;
    try { source = await readFile(this.options.path, "utf8"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") { this.presets.clear(); return; } throw error; }
    if (Buffer.byteLength(source) > MAX_FILE_BYTES) throw new Error("Preset configuration exceeds 64 KiB");
    const config = object(JSON.parse(source));
    exactKeys(config, ["presets"]);
    if (!Array.isArray(config.presets) || config.presets.length > MAX_PRESETS) throw new Error(`presets must contain at most ${MAX_PRESETS} presets`);
    const validated = config.presets.map((item) => this.preset(item));
    if (new Set(validated.map((preset) => preset.name)).size !== validated.length) throw new Error("Duplicate preset name");
    this.presets = new Map(validated.map((preset) => [preset.name, preset]));
  }
}

const PLACEHOLDER = /\{([a-zA-Z0-9_]+)\}/g;

/** Fill `{name}` placeholders from the caller's variables; a missing value is an error, never a guess. */
export function fill(text: string, vars: Readonly<Record<string, string>> | undefined, where: string): string {
  return text.replace(PLACEHOLDER, (_match, name: string) => {
    const value = vars?.[name];
    if (value === undefined) throw new Error(`${where} needs a value for {${name}}`);
    return value;
  });
}

/** The next run number for a preset: instances never reuse ids, so runs only ever grow. */
export function nextRun(tasks: readonly Todo[], name: string): number {
  return tasks.reduce((max, task) => task.metadata?.preset === name && typeof task.metadata.run === "number" ? Math.max(max, task.metadata.run) : max, 0) + 1;
}

/** Turn a definition into concrete Todos; dependencies resolve to the ids this run creates. */
export function expand(preset: Preset, run: number, startId: number, vars?: Readonly<Record<string, string>>): ExpandedPreset {
  const ids = new Map<string, number>();
  const created: Todo[] = [];
  let nextId = startId;
  for (const step of preset.steps) {
    const id = nextId++;
    ids.set(step.key, id);
    created.push({
      id,
      subject: fill(step.subject, vars, `preset ${preset.name} step ${step.key}`),
      status: "pending",
      blockedBy: (step.after ?? []).map((key) => {
        const dependency = ids.get(key);
        if (dependency === undefined) throw new Error(`preset ${preset.name} step ${step.key} depends on ${key} before it is created`);
        return dependency;
      }),
      ...(step.description === undefined ? {} : { description: fill(step.description, vars, `preset ${preset.name} step ${step.key}`) }),
      ...(step.activeForm === undefined ? {} : { activeForm: step.activeForm }),
      ...(step.owner === undefined ? {} : { owner: step.owner }),
      metadata: { preset: preset.name, run, key: step.key },
    });
  }
  return { name: preset.name, ...(preset.skill === undefined ? {} : { skill: preset.skill }), run, tasks: created, ids };
}

/** One instantiated fragment on the current list, newest run first. */
export function instances(tasks: readonly Todo[], name: string, run?: number): number[] {
  const runs = tasks.filter((task) => task.metadata?.preset === name && typeof task.metadata.run === "number").map((task) => task.metadata!.run as number);
  if (!runs.length) return [];
  const wanted = run ?? Math.max(...runs);
  return tasks.filter((task) => task.metadata?.preset === name && task.metadata.run === wanted).map((task) => task.id);
}

/**
 * Ids a reset has to reopen: the requested step (or the whole instance) plus every task that
 * depends on it, so a reopened step can never leave a finished successor behind.
 */
export function resetClosure(tasks: readonly Todo[], name: string, step?: string, run?: number): number[] {
  const target = new Set(instances(tasks, name, run));
  if (!target.size) return [];
  if (step !== undefined) {
    const start = tasks.find((task) => target.has(task.id) && task.metadata?.key === step);
    if (!start) return [];
    const wanted = new Set([start.id]);
    let grew = true;
    while (grew) {
      grew = false;
      for (const task of tasks) {
        if (wanted.has(task.id) || !task.blockedBy.some((id) => wanted.has(id))) continue;
        wanted.add(task.id);
        grew = true;
      }
    }
    return [...wanted];
  }
  return [...target];
}
