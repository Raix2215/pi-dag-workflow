import assert from "node:assert/strict";
import { test } from "node:test";
import childCommunication, { CHILD_GUIDANCE_TYPE } from "../src/agents/child.ts";

interface Entry { type: string; customType?: string; content?: string; display?: boolean; details?: { checkpointId?: string } }

/** Fake Pi that records handlers and never runs a model, so these are pure simulated events. */
function harness(env: NodeJS.ProcessEnv) {
  const handlers = new Map<string, ((event: any, ctx: any) => any)[]>();
  const sent: unknown[] = [];
  const pi: any = {
    registerTool() {},
    registerProvider() {},
    on(name: string, handler: any) { const list = handlers.get(name) ?? []; list.push(handler); handlers.set(name, list); },
    sendMessage(...args: unknown[]) { sent.push(args); },
    sendUserMessage(...args: unknown[]) { sent.push(args); },
  };
  const keys = ["PI_DAG_AGENT_PROFILE_PROMPT", "PI_DAG_AGENT_CONTEXT", "PI_DAG_AGENT_MODEL_BOOTSTRAP"];
  const saved = keys.map((key) => [key, process.env[key]] as const);
  for (const key of keys) delete process.env[key];
  Object.assign(process.env, env);
  try { childCommunication(pi); } finally {
    for (const key of keys) delete process.env[key];
    for (const [key, value] of saved) if (value !== undefined) process.env[key] = value;
  }
  const entries: Entry[] = [];
  const ctx: any = { sessionManager: { getBranch: () => entries }, isIdle: () => true };
  const fire = (name: string, event: any = {}) => (handlers.get(name) ?? []).map((handler) => handler(event, ctx));
  const start = () => {
    const event: any = { type: "before_agent_start", systemPromptOptions: { sections: {} } };
    const result = fire("before_agent_start", event)[0];
    return { event, result };
  };
  // Only Pi persistence (message_end -> appendCustomMessageEntry) makes a draft saved.
  const persist = (message: any) => entries.push({ type: "custom_message", customType: message.customType, content: message.content, display: message.display, details: message.details });
  return { sent, entries, fire, start, persist };
}

const PROFILE = "PROFILE-FULL-TEXT: stay read-only unless the assignment says otherwise.";
const FRAGMENT = "FRAGMENT-FULL-TEXT: browser-check run 1, step 2 of 3.";

test("selected guidance leaves the system prompt and the fixed child safety contract stays", () => {
  const h = harness({ PI_DAG_AGENT_PROFILE_PROMPT: PROFILE, PI_DAG_AGENT_CONTEXT: FRAGMENT });
  const { event, result } = h.start();
  assert.equal(event.systemPromptOptions.sections.dag_profile, undefined);
  assert.equal(event.systemPromptOptions.sections.dag_context, undefined);
  assert.match(event.systemPromptOptions.sections.dag_child, /one-tier child agent/);
  assert.match(event.systemPromptOptions.sections.dag_child, /Never delegate, spawn another Pi agent/);
  assert.ok(result.message, "the selected guidance still reaches the child");
});

test("both selected inputs arrive whole as one passive custom message, never as a report copy", () => {
  const h = harness({ PI_DAG_AGENT_PROFILE_PROMPT: PROFILE, PI_DAG_AGENT_CONTEXT: FRAGMENT });
  const message = h.start().result.message;
  assert.equal(message.customType, CHILD_GUIDANCE_TYPE);
  assert.equal(message.display, false);
  assert.ok(message.details.checkpointId);
  assert.ok(message.content.includes(PROFILE), "profile text is complete, not an index");
  assert.ok(message.content.includes(FRAGMENT), "fragment text is complete, not a summary");
  assert.match(message.content, /not a new user authorization/);
  assert.match(message.content, /does not override later explicit direction/);
  assert.equal(h.sent.length, 0, "no sendMessage means no extra turn");
  assert.equal(h.entries.length, 0);
});

test("a saved message is not repeated, and long selected text is not truncated", () => {
  const long = "长".repeat(1500);
  const h = harness({ PI_DAG_AGENT_PROFILE_PROMPT: long });
  const first = h.start().result.message;
  assert.ok(first.content.includes(long));
  h.persist(first);
  assert.equal(h.start().result, undefined);
  const saved = h.entries.filter((entry) => entry.customType === CHILD_GUIDANCE_TYPE);
  assert.equal(saved.length, 1, "guidance persists exactly once");
  assert.equal(saved[0]!.details!.checkpointId, first.details.checkpointId);
  assert.equal(h.sent.length, 0, "no wake or turn from persistence");
});

test("an unsaved draft is reproposed with the same checkpoint until Pi saves it", () => {
  const h = harness({ PI_DAG_AGENT_CONTEXT: FRAGMENT });
  const first = h.start().result.message;
  const retry = h.start().result.message;
  assert.ok(first && retry);
  assert.equal(retry.details.checkpointId, first.details.checkpointId);
  assert.equal(h.entries.length, 0, "a draft is not persistence");
  h.persist(retry);
  assert.equal(h.start().result, undefined);
});

test("compaction appends the guidance once at the first context and the next boundary persists it", () => {
  const h = harness({ PI_DAG_AGENT_PROFILE_PROMPT: PROFILE, PI_DAG_AGENT_CONTEXT: FRAGMENT });
  const first = h.start().result.message;
  h.persist(first);
  assert.equal(h.start().result, undefined);

  h.fire("session_compact", { type: "session_compact", reason: "threshold" });
  const contextEvent: any = { type: "context", messages: [] };
  const recovered = h.fire("context", contextEvent)[0];
  assert.ok(recovered?.messages, "the first context after compaction appends the guidance");
  assert.equal(recovered.messages.length, 1);
  const appended = recovered.messages[0];
  assert.equal(appended.role, "custom");
  assert.equal(appended.customType, CHILD_GUIDANCE_TYPE);
  assert.ok(appended.content.includes(PROFILE) && appended.content.includes(FRAGMENT));
  assert.deepEqual(contextEvent.messages, [], "old messages are not rewritten");
  assert.equal(h.fire("context", { type: "context", messages: recovered.messages })[0], undefined, "only the first context appends");

  const boundary = h.start().result.message;
  assert.ok(boundary, "the next normal boundary persists the same message");
  assert.equal(boundary.details.checkpointId, appended.details.checkpointId);
  assert.equal(h.sent.length, 0);
});

test("no environment guidance keeps normal child behavior", () => {
  const h = harness({});
  const { event, result } = h.start();
  assert.equal(result, undefined, "no passive message without selected env");
  assert.match(event.systemPromptOptions.sections.dag_child, /one-tier child agent/);
  h.fire("session_compact", { type: "session_compact" });
  assert.equal(h.fire("context", { type: "context", messages: [] })[0], undefined, "no compaction recovery without selected env");
  assert.equal(h.fire("context", { type: "context", messages: [] })[0], undefined);
  assert.equal(h.entries.length, 0);
  assert.equal(h.sent.length, 0);
});

test("profile-only and context-only selections stay complete", () => {
  const profileOnly = harness({ PI_DAG_AGENT_PROFILE_PROMPT: PROFILE }).start().result.message;
  assert.ok(profileOnly.content.includes(PROFILE));
  assert.equal(profileOnly.content.includes(FRAGMENT), false);
  const contextOnly = harness({ PI_DAG_AGENT_CONTEXT: FRAGMENT }).start().result.message;
  assert.ok(contextOnly.content.includes(FRAGMENT));
  assert.equal(contextOnly.content.includes(PROFILE), false);
});
