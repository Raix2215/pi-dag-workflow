import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CORE_TOOLS, ProfileStore } from "../src/agents/profiles.ts";

const model = { provider: "local", id: "exact-model" };
const registry = { find: (provider: string, id: string) => provider === model.provider && id === model.id ? { reasoning: true } : undefined };

test("default profile inherits an exact registered model and read-only core tools", () => {
  const store = new ProfileStore({ registry });
  assert.deepEqual(store.resolve(undefined, model), { name: "inherit", model, thinking: "off", tools: [...CORE_TOOLS] });
  assert.throws(() => store.resolve(), /parent model/);
  assert.throws(() => store.resolve(undefined, { provider: "local", id: "model" }), /Unknown model/);
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
