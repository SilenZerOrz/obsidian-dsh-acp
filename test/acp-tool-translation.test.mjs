// test/acp-tool-translation.test.mjs — #95 Session A: 翻译层纯函数单测.
//
// Feeds RAW session/update frames straight into createUpdateTranslator() and
// asserts the translated output frame-by-frame, in isolation from the gateway.
// Covers the 4 classes the integration (http-gateway-tool-translation) test
// reaches end-to-end, plus the defensive no-start backfill and failed-status
// mapping that a real multi-turn round could hit:
//   1. official "tool_call" start → legacy tool_call_update in_progress (+cache)
//   2. official "tool_call_update" finish → legacy completed (+rawInput backfill,
//      empty content:[] dropped)
//   3. finish WITHOUT a prior start (defensive: rawInput:{} fallback, no crash)
//   4. non-tool frames pass through VERBATIM (zero side effects)
//
// Pure function — no network, no ctx, no gateway.

import { test } from "node:test";
import assert from "node:assert/strict";

import { createUpdateTranslator } from "../lib/acp-tool-translation.mjs";

const CALL_ID = "tool-abc-123";
const START = {
  sessionUpdate: "tool_call",
  toolCallId: CALL_ID,
  title: "get_cwd",
  kind: "other",
  status: "in_progress",
  rawInput: { cwd: "/workspace" },
};
const FINISH = { sessionUpdate: "tool_call_update", toolCallId: CALL_ID, status: "completed", content: [] };

// Feed DELTA-equivalent message/thought frames (the ones that must be untouched).
const MSG = Object.freeze({
  sessionUpdate: "agent_message_chunk",
  messageId: "m1",
  content: { type: "text", text: "hello" },
});
const THOUGHT = Object.freeze({
  sessionUpdate: "agent_thought_chunk",
  messageId: "t1",
  content: { type: "text", text: "reasoning" },
});
const USAGE = Object.freeze({ sessionUpdate: "usage_update", used: 5, size: 0 });

test("translate: official tool_call start → legacy tool_call_update in_progress (title retained, rawInput cached)", () => {
  const t = createUpdateTranslator();
  const [out] = t.translate(START);
  assert.equal(out.sessionUpdate, "tool_call_update");
  assert.equal(out.status, "in_progress");
  assert.equal(out.toolCallId, CALL_ID);
  assert.equal(out.title, "get_cwd");
  // in_progress frame carries NO rawInput (it is cached for the finish backfill).
  assert.equal(out.rawInput, undefined);
  assert.equal(t._seenToolFrame(), true);
});

test("translate: official tool_call_update finish → legacy completed (rawInput backfilled, empty content dropped)", () => {
  const t = createUpdateTranslator();
  t.translate(START); // populate the cache
  const [out] = t.translate(FINISH);
  assert.equal(out.sessionUpdate, "tool_call_update");
  assert.equal(out.status, "completed");
  assert.equal(out.toolCallId, CALL_ID);
  // rawInput backfilled from the START frame (official finish omits it).
  assert.deepEqual(out.rawInput, { cwd: "/workspace" });
  // Empty content array from the official finish is DROPPED (no content key).
  assert.equal(out.content, undefined);
  // Cache is consumed on finish — no leak across turns.
  assert.equal(t._rawInputByToolCall.has(CALL_ID), false);
});

test("translate: finish WITHOUT a prior start — defensive rawInput:{} fallback, no crash", () => {
  const t = createUpdateTranslator();
  // No start frame fed first — the simulated anomaly / dropped-frame path.
  const [out] = t.translate(FINISH);
  assert.equal(out.sessionUpdate, "tool_call_update");
  assert.equal(out.status, "completed");
  assert.equal(out.content, undefined, "empty content dropped even in defensive path");
  assert.deepEqual(out.rawInput, {}, "rawInput falls back to {} when no start was cached");
});

test("translate: failed finish is mapped through as failed (no rawInput crash)", () => {
  const t = createUpdateTranslator();
  const [out] = t.translate({ sessionUpdate: "tool_call_update", toolCallId: CALL_ID, status: "failed", content: [] });
  assert.equal(out.sessionUpdate, "tool_call_update");
  assert.equal(out.status, "failed"); // spec rule 2: failed mapping stays failed
  assert.deepEqual(out.rawInput, {}, "defensive {} when failed finish follows no start");
});

test("translate: non-tool frames pass through VERBATIM (zero side effects, frame-identical)", () => {
  const t = createUpdateTranslator();
  // Push a tool round first to prove non-tool frames are untouched by any tool state.
  t.translate(START);
  t.translate(FINISH);
  // Exactly-equal (not just deepEqual): object identity preserved → same reference.
  assert.equal(t.translate(MSG)[0], MSG, "agent_message_chunk must be returned by reference");
  assert.equal(t.translate(THOUGHT)[0], THOUGHT, "agent_thought_chunk must be returned by reference");
  assert.equal(t.translate(USAGE)[0], USAGE, "usage_update must be returned by reference");
  // A future/unknown frame type also passes through untouched (translation must
  // never intercept what it doesn't understand).
  const unknown = Object.freeze({ sessionUpdate: "brand_new_frame", x: 1 });
  assert.equal(t.translate(unknown)[0], unknown, "unknown frame passed through by reference");
});

test("translate: two interleaved tool calls keep separate rawInput caches by toolCallId", () => {
  const t = createUpdateTranslator();
  const idA = "call-A";
  const idB = "call-B";
  t.translate({ ...START, toolCallId: idA, rawInput: { a: 1 } });
  t.translate({ ...START, toolCallId: idB, rawInput: { b: 2 } });
  const [finA] = t.translate({ ...FINISH, toolCallId: idA });
  assert.deepEqual(finA.rawInput, { a: 1 }, "A backfills its own start.rawInput");
  const [finB] = t.translate({ ...FINISH, toolCallId: idB });
  assert.deepEqual(finB.rawInput, { b: 2 }, "B backfills its own start.rawInput");
  assert.equal(t._rawInputByToolCall.size, 0, "both caches consumed → no leak");
});
