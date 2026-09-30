import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import extension from "../src/index.ts";

test("the package exposes the actual Pi extension entry and has no host runtime dependency", () => {
  const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.deepEqual(manifest.pi.extensions, ["./src/index.ts"]);
  assert.equal(manifest.private, true);
  assert.equal(manifest.peerDependencies["@earendil-works/pi-coding-agent"], "*");
  assert.equal(manifest.dependencies, undefined);
});

test("the entry exports a factory; actual registration is checked by the Pi loader test", () => {
  assert.equal(typeof extension, "function");
});
