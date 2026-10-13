import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CORE_TOOLS, ProfileStore, type ResolvedProfile, type ThinkingLevel } from "../src/agents/profiles.ts";

const model = { provider: "local", id: "exact-model" };
const registry = { find: (provider: string, id: string) => provider === model.provider && id === model.id ? { reasoning: true } : undefined };

test("default profile inherits an exact registered model and read-only core tools", () => {
  const store = new ProfileStore({ registry });
  assert.deepEqual(store.resolve(undefined, model), { name: "inherit", model, thinking: "off", tools: [...CORE_TOOLS] });
  assert.throws(() => store.resolve(), /parent model/);
  assert.throws(() => store.resolve(undefined, { provider: "local", id: "model" }), /Unknown model/);
});
test('inherit accepts its explicit name and captures thinking and only active supported built-ins', () => {
  const store = new ProfileStore({ registry, trustedTools: ['bash', 'write', 'powershell'] });
  const parent = { thinking: 'high' as const, tools: ['read', 'bash', 'write', 'powershell', 'custom_search', 'subagent_spawn'] };
  const resolved = store.resolve(undefined, model, undefined, parent);
  assert.deepEqual(resolved, { name: 'inherit', model, thinking: 'high', tools: ['read', 'bash', 'write', 'powershell'] });
  assert.deepEqual(store.resolve('inherit', model, undefined, parent), resolved);
  assert.deepEqual(store.resolve('inherit', model, [], parent).tools, []);
  assert.deepEqual(store.resolve(undefined, model, undefined, { tools: [] }).tools, []);
  store.set({ name: 'partial' });
  assert.deepEqual(store.resolve('partial', model, undefined, parent), { ...resolved, name: 'partial' });
  store.set({ name: 'explicit', thinking: 'off', tools: ['read'] });
  assert.equal(store.resolve('explicit', model, undefined, parent).thinking, 'off');
  assert.deepEqual(store.resolve('explicit', model, ['write'], parent).tools, ['write']);
  const nonReasoning = new ProfileStore({ registry: { find: () => ({ reasoning: false }) } });
  assert.equal(nonReasoning.resolve(undefined, model, undefined, parent).thinking, 'off');
});

test("named profiles validate thinking, exact model names and unknown fields", () => {
  const store = new ProfileStore({ registry });
  store.set({ name: "reader", model, thinking: "low" });
  assert.equal(store.resolve("reader").thinking, "low");
  assert.throws(() => store.set({ name: "bad", model: { ...model, id: "exact" } }), /Unknown model/);
  assert.throws(() => store.set({ name: "bad", thinking: "wild" as "low" }), /thinking/);
  assert.throws(() => store.set({ name: "bad", extra: "ignored" } as never), /Unknown profile field/);
  assert.throws(() => store.set({ name: "inherit" }), /reserved/);
  assert.throws(() => store.resolve("missing", model), /Unknown profile/);
});
test("child tools are explicit trusted built-ins; unknown and parent custom tools rejected", () => {
  const untrusted = new ProfileStore({ registry });
  assert.throws(() => untrusted.set({ name: "writer", tools: ["write"] }), /not trusted/);
  const trusted = new ProfileStore({ registry, trustedTools: ["write", "bash"] });
  trusted.set({ name: "writer", tools: ["read", "write", "write"] });
  assert.deepEqual(trusted.resolve("writer", model).tools, ["read", "write"]);
  assert.deepEqual(trusted.resolve("writer", model, []).tools, []);
  assert.throws(() => trusted.resolve("writer", model, ["subagent_spawn"]), /not trusted/);
  assert.throws(() => new ProfileStore({ registry, trustedTools: ["custom_search"] }), /Unsupported/);
});
test("profile getters and resolved objects cannot mutate stored configuration", () => {
  const store = new ProfileStore({ registry });
  const profile = { name: "reader", model, tools: ["read"] };
  store.set(profile);
  profile.tools.push("write");
  store.get("reader")!.tools!.push("write");
  store.list()[0]!.model!.id = "invalid";
  assert.deepEqual(store.resolve("reader").tools, ["read"]);
  assert.equal(store.resolve("reader").model.id, model.id);
  assert.equal(store.delete("reader"), true);
  assert.equal(store.get("reader"), undefined);
});
const alternateModel = { provider: "local", id: "alternate-model" };
const plainModel = { provider: "local", id: "plain-model" };
const dispatchRegistry = {
  find: (provider: string, id: string) => provider === "local" && [model.id, alternateModel.id, plainModel.id].includes(id)
    ? { reasoning: id !== plainModel.id } : undefined,
};
const snapshot = (): ResolvedProfile => ({
  name: "old", model: { ...model }, thinking: "high", tools: ["read"],
  skills: ["old.md"], instructions: "Preserve this guidance.",
});

test("dispatch overrides win over named profile and parent, including empty replacement lists", () => {
  const store = new ProfileStore({ registry: dispatchRegistry, trustedTools: ["write"] });
  store.set({ name: "writer", model: alternateModel, thinking: "low", tools: ["write"], skills: ["profile.md"], instructions: "Profile guidance." });
  const parent = { thinking: "medium" as const, tools: ["read", "custom_search"] };
  assert.deepEqual(store.resolve("writer", model, undefined, parent), {
    name: "writer", model: alternateModel, thinking: "low", tools: ["write"], skills: ["profile.md"], instructions: "Profile guidance.",
  });
  assert.deepEqual(store.resolve("writer", model, [" read ", "read"], parent, {
    model, thinking: "high", skills: [" override.md ", "override.md"],
  }), { name: "writer", model, thinking: "high", tools: ["read"], skills: ["override.md"], instructions: "Profile guidance." });
  assert.deepEqual(store.resolve("writer", model, [], parent, { thinking: "off", skills: [] }), {
    name: "writer", model: alternateModel, thinking: "off", tools: [], skills: [], instructions: "Profile guidance.",
  });
});

test("dispatch model override starts without a parent model and rejects misspellings", () => {
  const store = new ProfileStore({ registry: dispatchRegistry });
  assert.deepEqual(store.resolve(undefined, undefined, undefined, { thinking: "medium", tools: [] }, { model }), {
    name: "inherit", model, thinking: "medium", tools: [],
  });
  assert.throws(() => store.resolve(undefined, model, undefined, undefined, { model: { ...model, id: "exact-modle" } }), /Unknown model/);
  assert.throws(() => store.resolve(undefined, model, undefined, undefined, { model: { ...model, provider: "locla" } }), /Unknown model/);
});

test("resume uses the full snapshot without looking up modified or deleted old profiles", () => {
  const store = new ProfileStore({ registry: dispatchRegistry, trustedTools: ["write"] });
  const previous = snapshot();
  store.set({ name: "old", model: alternateModel, thinking: "off", tools: ["write"], skills: ["changed.md"], instructions: "Changed." });
  const parent = { thinking: "low" as const, tools: ["write"] };
  assert.deepEqual(store.resolve(undefined, alternateModel, undefined, parent, undefined, previous), previous);
  store.delete("old");
  assert.deepEqual(store.resolve(undefined, undefined, undefined, undefined, undefined, previous), previous);
  assert.throws(() => store.resolve("old", alternateModel, undefined, parent, undefined, previous), /Unknown profile/);
  const resolved = store.resolve(undefined, alternateModel, undefined, parent, undefined, previous);
  resolved.model.id = "mutated";
  resolved.tools.push("write");
  resolved.skills!.push("mutated.md");
  assert.deepEqual(previous, snapshot());
});

test("resume applies only explicit fields of a named profile even when its name is unchanged", () => {
  const store = new ProfileStore({ registry: dispatchRegistry, trustedTools: ["write"] });
  const previous = snapshot();
  store.set({ name: "old", thinking: "low" });
  assert.deepEqual(store.resolve("old", alternateModel, undefined, { tools: ["write"] }, undefined, previous), { ...previous, thinking: "low" });
  store.set({ name: "partial", tools: [], skills: [] });
  assert.deepEqual(store.resolve("partial", alternateModel, undefined, undefined, undefined, previous), { ...previous, name: "partial", tools: [], skills: [] });
  store.set({ name: "full", model: alternateModel, thinking: "low", tools: ["write"], skills: ["new.md"], instructions: "New guidance." });
  assert.deepEqual(store.resolve("full", undefined, undefined, undefined, undefined, previous), {
    name: "full", model: alternateModel, thinking: "low", tools: ["write"], skills: ["new.md"], instructions: "New guidance.",
  });
  assert.deepEqual(store.resolve("full", undefined, [], undefined, { model, thinking: "off", skills: [] }, previous), {
    name: "full", model, thinking: "off", tools: [], skills: [], instructions: "New guidance.",
  });
});

test("resume overrides replace snapshot fields while retaining its name and instructions", () => {
  const store = new ProfileStore({ registry: dispatchRegistry, trustedTools: ["write"] });
  const previous = snapshot();
  assert.deepEqual(store.resolve(undefined, model, ["write"], undefined, {
    model: alternateModel, thinking: "minimal", skills: ["new.md"],
  }, previous), { ...previous, model: alternateModel, thinking: "minimal", tools: ["write"], skills: ["new.md"] });
  assert.deepEqual(store.resolve(undefined, model, [], undefined, { skills: [] }, previous), { ...previous, tools: [], skills: [] });
});

test("explicit inherit discards the entire snapshot and resets to the current parent", () => {
  const store = new ProfileStore({ registry: dispatchRegistry, trustedTools: ["write"] });
  const previous = snapshot();
  const parent = { thinking: "low" as const, tools: ["write", "custom_search"] };
  assert.deepEqual(store.resolve("inherit", alternateModel, undefined, parent, undefined, previous), {
    name: "inherit", model: alternateModel, thinking: "low", tools: ["write"],
  });
  assert.deepEqual(store.resolve("inherit", alternateModel, [], parent, { model, thinking: "off", skills: [] }, previous), {
    name: "inherit", model, thinking: "off", tools: [], skills: [],
  });
  assert.throws(() => store.resolve("inherit", undefined, undefined, parent, undefined, previous), /parent model/);
  assert.equal(store.resolve("inherit", undefined, undefined, parent, { model }, previous).model.id, model.id);
});

test("only inherited thinking falls back to off on a non-reasoning dispatch model", () => {
  const store = new ProfileStore({ registry: dispatchRegistry });
  store.set({ name: "model-only", model: plainModel });
  store.set({ name: "explicit", thinking: "high" });
  const parent = { thinking: "high" as const };
  assert.equal(store.resolve("model-only", model, undefined, parent).thinking, "off");
  assert.equal(store.resolve(undefined, model, undefined, parent, { model: plainModel }).thinking, "off");
  assert.equal(store.resolve(undefined, undefined, undefined, undefined, { model: plainModel }, snapshot()).thinking, "off");
  assert.equal(store.resolve("model-only", undefined, undefined, undefined, undefined, snapshot()).thinking, "off");
  assert.throws(() => store.resolve(undefined, plainModel, undefined, parent, { thinking: "high" }), /does not support thinking/);
  assert.throws(() => store.resolve(undefined, model, undefined, parent, { model: plainModel, thinking: "low" }, snapshot()), /does not support thinking/);
  assert.throws(() => store.resolve("explicit", plainModel), /does not support thinking/);
  assert.throws(() => store.resolve("explicit", model, undefined, undefined, { model: plainModel }, snapshot()), /does not support thinking/);
  assert.equal(store.resolve("explicit", plainModel, undefined, undefined, { thinking: "off" }).thinking, "off");
  assert.throws(() => store.set({ name: "invalid", model: plainModel, thinking: "high" }), /does not support thinking/);
  assert.throws(() => store.resolve(undefined, model, undefined, undefined, { thinking: "typo" as ThinkingLevel }), /thinking/);
});

test("tool lists trim and deduplicate without granting unsupported or untrusted tools", () => {
  const store = new ProfileStore({ registry, trustedTools: ["write"] });
  store.set({ name: "trimmed", tools: [" read ", "read", " write "] });
  assert.deepEqual(store.resolve("trimmed", model).tools, ["read", "write"]);
  assert.deepEqual(store.resolve(undefined, model, [" read ", "read"]).tools, ["read"]);
  assert.deepEqual(store.resolve(undefined, model, undefined, { tools: ["custom_search"] }).tools, []);
  for (const tool of ["bash", "custom_search", "subagent_spawn", "", "   "]) {
    assert.throws(() => store.resolve(undefined, model, [tool]), /not trusted or supported/);
  }
  assert.throws(() => store.resolve(undefined, model, [1] as unknown as string[]), /supported tool names/);
  assert.throws(() => store.resolve(undefined, model, undefined, undefined, undefined, { ...snapshot(), tools: ["bash"] }), /not trusted or supported/);
});

test("dispatch skill overrides use the same bounded local-path validation as profiles", () => {
  const store = new ProfileStore({ registry });
  assert.deepEqual(store.resolve(undefined, model, undefined, undefined, { skills: [" a.md ", "a.md", "~/b.md"] }).skills, ["a.md", "~/b.md"]);
  assert.equal("skills" in store.resolve(undefined, model), false);
  for (const skills of [["https://example.com/a.md"], ["bad\n.md"], ["   "], Array(9).fill("a.md"), ["x".repeat(2049)]]) {
    assert.throws(() => store.resolve(undefined, model, undefined, undefined, { skills }), /[Ss]kill/);
  }
});

test("profile file contains only configuration, load/save validate and load is atomic", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-dag-m2-profile-"));
  try {
    const path = join(root, "profiles.json");
    const store = new ProfileStore({ registry, path });
    await store.load();
    store.set({ name: "reader", model });
    await store.save();
    assert.deepEqual(JSON.parse(await readFile(path, "utf8")), { profiles: [{ name: "reader", model }] });
    const restored = new ProfileStore({ registry, path });
    await restored.load();
    assert.deepEqual(restored.list(), store.list());
    await writeFile(path, JSON.stringify({ profiles: [{ name: "unknown", model: { ...model, id: "missing" } }] }));
    await assert.rejects(restored.load(), /Unknown model/);
    assert.deepEqual(restored.list(), store.list());
    await writeFile(path, JSON.stringify({ profiles: [{ name: "one" }, { name: "one" }] }));
    await assert.rejects(restored.load(), /Duplicate/);
    await writeFile(path, JSON.stringify({ profiles: [], jobs: [] }));
    await assert.rejects(restored.load(), /Unknown profile field/);
    await assert.rejects(new ProfileStore({ registry }).save(), /No profile/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("profile instructions are normalized, bounded and carried into the resolved profile", () => {
  const store = new ProfileStore({ registry });
  store.set({ name: "browser", model, thinking: "high", instructions: "First line.\r\nSecond line.  " });
  assert.equal(store.get("browser")!.instructions, "First line.\nSecond line.");
  assert.equal(store.resolve("browser").instructions, "First line.\nSecond line.");
  // Profiles without instructions stay exactly as before.
  store.set({ name: "plain", model });
  assert.equal("instructions" in store.resolve("plain"), false);
  assert.throws(() => store.set({ name: "bad", instructions: "" }), /contain text/);
  assert.throws(() => store.set({ name: "bad", instructions: "   " }), /contain text/);
  assert.throws(() => store.set({ name: "bad", instructions: 42 as unknown as string }), /must be text/);
  assert.throws(() => store.set({ name: "bad", instructions: "x".repeat(2001) }), /at most 2000/);
  assert.equal(store.resolve("browser").thinking, "high");
});

test("instructions survive a save/load round trip and never leak into other profiles", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-dag-profiles-"));
  try {
    const path = join(root, "profile.json");
    const first = new ProfileStore({ path, registry });
    first.set({ name: "browser", model, instructions: "Stay read-only unless asked otherwise." });
    first.set({ name: "other", model });
    await first.save();
    const reloaded = new ProfileStore({ path, registry });
    await reloaded.load();
    assert.equal(reloaded.get("browser")!.instructions, "Stay read-only unless asked otherwise.");
    assert.equal("instructions" in reloaded.get("other")!, false);
    // A profile re-saved through the command path keeps the text that was already stored.
    const existing = reloaded.get("browser")!.instructions;
    reloaded.set({ name: "browser", model, thinking: "xhigh", ...(existing ? { instructions: existing } : {}) });
    await reloaded.save();
    const again = new ProfileStore({ path, registry });
    await again.load();
    assert.equal(again.get("browser")!.instructions, "Stay read-only unless asked otherwise.");
    assert.equal(again.get("browser")!.thinking, "xhigh");
  } finally { await rm(root, { recursive: true, force: true }); }
});
