import assert from "node:assert/strict";
import { test } from "node:test";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { createTranslator } from "../src/shared/i18n.ts";
import { emptyState, type Todo } from "../src/todos/state.ts";
import { renderTasks, type AgentView } from "../src/ui/render.ts";

const task: Todo = { id: 1, subject: "实现解析器", status: "in_progress", blockedBy: [] };
const base = { ...emptyState(), tasks: [task], nextId: 2 };
const locales = ["zh-CN", "en"] as const;

const job = (tool: string | undefined, since: number | undefined): AgentView => ({
  id: "a1", todoId: 1, profile: "coding", status: "running",
  activity: { kind: "tool", ...(tool !== undefined ? { tool } : {}), ...(since !== undefined ? { since } : {}) },
});
const render = (jobs: readonly AgentView[], width: number, locale: (typeof locales)[number]): string[] =>
  renderTasks(base, width, { jobs, maxRows: Infinity, msg: createTranslator(locale) }).map(stripTerminalSequences);

test("elapsed seconds stay unbounded and compact from seconds through hours in both locales", () => {
  const cases: Array<[number, string]> = [
    [45_000, "45s"],       // under a minute keeps plain seconds
    [99_000, "99s"],       // still seconds at the old cap
    [145_000, "2m25s"],    // past it, minutes and seconds
    [725_000, "12m5s"],    // two-digit minutes drop the empty padding
    [3_720_000, "1h2m"],   // the first hour switches to hours and minutes
    [36_000_000, "10h0m"], // long runs stay bounded, never growing a third unit
  ];
  for (const locale of locales) {
    for (const [elapsed, expected] of cases) {
      const line = render([job("bash", Date.now() - elapsed)], 120, locale).join("\n");
      assert.match(line, new RegExp(`󰆍 bash ${expected}`), `${locale} at ${elapsed}ms`);
      assert.doesNotMatch(line, /NaN|Infinity/);
    }
  }
});

test("a backwards clock clamps to zero and non-finite timestamps add no time or NaN", () => {
  for (const locale of locales) {
    const future = render([job("bash", Date.now() + 5_000)], 120, locale).join("\n");
    assert.match(future, /󰆍 bash/);
    assert.doesNotMatch(future, /\d+s|NaN/);
    for (const since of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      const line = render([job("bash", since)], 120, locale).join("\n");
      assert.match(line, /󰆍 bash/);
      assert.doesNotMatch(line, /NaN|Infinity|undefined/);
    }
  }
});

test("locale still drives the surrounding live label while the elapsed format is shared", () => {
  const thinking = (): AgentView => ({ id: "a1", todoId: 1, profile: "coding", status: "running", activity: { kind: "thinking", since: Date.now() - 4000 } });
  assert.match(render([thinking()], 120, "en").join("\n"), /󰧑 Thinking/);
  assert.match(render([thinking()], 120, "zh-CN").join("\n"), /󰧑 思考中/);
});

test("long elapsed labels stay inside every finite width with the ten-column tool clip intact", () => {
  const since = Date.now() - 725_000;
  for (const locale of locales) {
    const wide = render([job("mcp__github__list_repository_files", since)], 120, locale).join("\n");
    assert.match(wide, /󰆍 list_repo… 12m5s/, `${locale} clip + elapsed`);
    for (const width of [0, 1, 8, 12, 20, 28, 34, 42, 60, 80, 120]) {
      for (const line of render([job("mcp__github__list_repository_files", since)], width, locale)) {
        assert.ok(visibleWidth(line) <= width, `${locale} at width ${width}: ${line}`);
        assert.doesNotMatch(line, /NaN|Infinity|undefined/);
      }
    }
  }
});
