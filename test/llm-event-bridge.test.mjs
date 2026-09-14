// test/llm-event-bridge.test.mjs — node:test unit tests for lib/llm-event-bridge.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { LLMStreamBridge, mapStopReason } from "../lib/llm-event-bridge.mjs";

// --- helpers --------------------------------------------------------------

/**
 * Build an async iterable from a plain array. Lets tests express streams as
 * literals without hand-rolling async generators.
 */
function asyncFromArray(items) {
  return (async function* () {
    for (const item of items) yield item;
  })();
}

/** Test helper that throws on first chunk pull. */
function asyncThatThrows(message) {
  return (async function* () {
    throw new Error(message);
    // eslint-disable-next-line no-unreachable
    yield; // unreachable, satisfies generator syntax
  })();
}

// --- constructor ---------------------------------------------------------

test("LLMStreamBridge: requires onUpdate callback", () => {
  assert.throws(() => new LLMStreamBridge({}), /onUpdate/);
  assert.throws(() => new LLMStreamBridge({ onUpdate: null }), /onUpdate/);
});

test("LLMStreamBridge: starts with empty emittedCount and no usage/finishReason", () => {
  const b = new LLMStreamBridge({ onUpdate: () => {} });
  assert.equal(b.emittedCount, 0);
  assert.equal(b.mapperState.nextId, 1);
  assert.equal(b.mapperState.indexMap.size, 0);
});

// --- pump: happy path -----------------------------------------------------

test("pump: emits sessionUpdates in chunk order", async () => {
  const emitted = [];
  const b = new LLMStreamBridge({ onUpdate: async (u) => { emitted.push(u); } });
  const stream = asyncFromArray([
    { type: "block-start", index: 0, blockType: "text" },
    { type: "text-delta", index: 0, text: "Hi" },
    { type: "block-end", index: 0, block: { type: "text", text: "Hi" } },
    { type: "finish", reason: { kind: "stop" } },
  ]);
  const result = await b.pump(stream);
  // 3 sessionUpdates (block-start, text-delta, block-end); finish returns null
  assert.equal(b.emittedCount, 3);
  assert.equal(emitted.length, 3);
  assert.equal(emitted[0].sessionUpdate, "agent_message_chunk");
  assert.equal(emitted[1].sessionUpdate, "agent_message_chunk");
  assert.equal(emitted[2].sessionUpdate, "agent_message_chunk");
  assert.equal(result.stopReason, "end_turn");
  assert.equal(result.finishReason.kind, "stop");
  assert.equal(result.usage, null);
});

test("pump: captures usage from usage chunk", async () => {
  const b = new LLMStreamBridge({ onUpdate: () => {} });
  const stream = asyncFromArray([
    { type: "block-start", index: 0, blockType: "text" },
    { type: "usage", usage: { inputTokens: 5, outputTokens: 3, totalTokens: 8 } },
    { type: "finish", reason: { kind: "stop" } },
  ]);
  const result = await b.pump(stream);
  assert.equal(result.usage.totalTokens, 8);
});

test("pump: reasoning stream surfaces as agent_thought_chunk", async () => {
  const emitted = [];
  const b = new LLMStreamBridge({ onUpdate: async (u) => { emitted.push(u); } });
  const stream = asyncFromArray([
    { type: "block-start", index: 0, blockType: "reasoning" },
    { type: "reasoning-delta", index: 0, text: "thinking..." },
    { type: "block-end", index: 0, block: { type: "reasoning", text: "thinking..." } },
    { type: "finish", reason: { kind: "stop" } },
  ]);
  const result = await b.pump(stream);
  assert.equal(b.emittedCount, 3);
  assert.ok(emitted.every((u) => u.sessionUpdate === "agent_thought_chunk"));
  assert.equal(result.stopReason, "end_turn");
});

test("pump: tool-call stream produces in_progress then completed", async () => {
  const emitted = [];
  const b = new LLMStreamBridge({ onUpdate: async (u) => { emitted.push(u); } });
  const stream = asyncFromArray([
    { type: "tool-call-delta", index: 2, id: "tc1", name: "Read", argumentsDelta: '{"p":' },
    { type: "tool-call-delta", index: 2, id: "tc1", argumentsDelta: '"x"}' },
    { type: "block-end", index: 2, block: { type: "tool-call", toolCallId: "tc1", toolCallName: "Read" } },
    { type: "finish", reason: { kind: "stop" } },
  ]);
  const result = await b.pump(stream);
  // Only deltas + block-end produce updates (block-start for tool-call → null)
  assert.equal(b.emittedCount, 3);
  assert.equal(emitted[0].status, "in_progress");
  assert.equal(emitted[1].status, "in_progress");
  assert.equal(emitted[2].status, "completed");
  assert.deepEqual(emitted[2].rawInput, { p: "x" });
  assert.equal(result.stopReason, "end_turn");
});

// --- pump: error path -----------------------------------------------------

test("pump: stream throwing before finish → cancelled result", async () => {
  const captured = [];
  const b = new LLMStreamBridge({
    onUpdate: async (u) => { captured.push(u); },
    onError: (err) => { captured.push({ err: err.message }); },
  });
  // First emit one update, then throw on the next pull
  const stream = (async function* () {
    yield { type: "block-start", index: 0, blockType: "text" };
    yield { type: "text-delta", index: 0, text: "partial" };
    throw new Error("network down");
  })();
  const result = await b.pump(stream);
  // Emitted the 2 sessionUpdates, captured the error, returned cancelled
  assert.equal(b.emittedCount, 2);
  assert.equal(captured.length, 3);
  assert.equal(captured[2].err, "network down");
  assert.equal(result.stopReason, "cancelled");
  assert.equal(result.finishReason, null);
});

test("pump: onError sink that itself throws does not propagate", async () => {
  const b = new LLMStreamBridge({
    onUpdate: () => {},
    onError: () => { throw new Error("sink failure"); },
  });
  const stream = asyncThatThrows("stream failure");
  const result = await b.pump(stream); // must not throw
  assert.equal(result.stopReason, "cancelled");
});

// --- pump: edge cases -----------------------------------------------------

test("pump: empty stream returns end_turn with null usage", async () => {
  const b = new LLMStreamBridge({ onUpdate: () => {} });
  const result = await b.pump(asyncFromArray([]));
  assert.equal(result.stopReason, "end_turn");
  assert.equal(result.usage, null);
  assert.equal(b.emittedCount, 0);
});

test("pump: onRawChunk hook fires for every chunk", async () => {
  const rawChunks = [];
  const b = new LLMStreamBridge({
    onUpdate: () => {},
    onRawChunk: (c) => { rawChunks.push(c.type); },
  });
  await b.pump(asyncFromArray([
    { type: "block-start", index: 0, blockType: "text" },
    { type: "text-delta", index: 0, text: "x" },
    { type: "usage", usage: { totalTokens: 1 } },
    { type: "finish", reason: { kind: "stop" } },
  ]));
  assert.deepEqual(rawChunks, ["block-start", "text-delta", "usage", "finish"]);
});

test("pump: usage emitted as usage_update sessionUpdate", async () => {
  const emitted = [];
  const b = new LLMStreamBridge({ onUpdate: async (u) => { emitted.push(u); } });
  await b.pump(asyncFromArray([
    { type: "usage", usage: { totalTokens: 42 } },
    { type: "finish", reason: { kind: "stop" } },
  ]));
  assert.equal(emitted[0].sessionUpdate, "usage_update");
  assert.equal(emitted[0].used, 42);
});

// --- mapStopReason --------------------------------------------------------

test("mapStopReason: stop → end_turn", () => {
  assert.equal(mapStopReason({ kind: "stop" }), "end_turn");
});

test("mapStopReason: max-tokens → max_tokens", () => {
  assert.equal(mapStopReason({ kind: "max-tokens" }), "max_tokens");
});

test("mapStopReason: aborted → cancelled", () => {
  assert.equal(mapStopReason({ kind: "aborted" }), "cancelled");
});

test("mapStopReason: error → cancelled (no ACP equivalent)", () => {
  assert.equal(mapStopReason({ kind: "error" }), "cancelled");
});

test("mapStopReason: null/undef/unknown → end_turn (forward-compat)", () => {
  assert.equal(mapStopReason(null), "end_turn");
  assert.equal(mapStopReason(undefined), "end_turn");
  assert.equal(mapStopReason({}), "end_turn");
  assert.equal(mapStopReason({ kind: "future-reason" }), "end_turn");
});

// --- end-to-end: full mixed stream ---------------------------------------

test("end-to-end: reasoning + text + tool + usage + finish returns coherent result", async () => {
  const emitted = [];
  const b = new LLMStreamBridge({ onUpdate: async (u) => { emitted.push(u); } });
  const result = await b.pump(asyncFromArray([
    { type: "block-start", index: 0, blockType: "reasoning" },
    { type: "reasoning-delta", index: 0, text: "Plan: " },
    { type: "reasoning-delta", index: 0, text: "edit" },
    { type: "block-end", index: 0, block: { type: "reasoning", text: "Plan: edit" } },
    { type: "block-start", index: 1, blockType: "text" },
    { type: "text-delta", index: 1, text: "Editing..." },
    { type: "block-end", index: 1, block: { type: "text", text: "Editing..." } },
    { type: "tool-call-delta", index: 2, id: "tc1", name: "Edit", argumentsDelta: '{"f":"a"}' },
    { type: "block-end", index: 2, block: { type: "tool-call", toolCallId: "tc1" } },
    { type: "usage", usage: { inputTokens: 20, outputTokens: 10, totalTokens: 30 } },
    { type: "finish", reason: { kind: "stop" } },
  ]));
  // Expected emissions: 4 reasoning (init + 2 delta + end) + 3 text + 2 tool-call + 1 usage = 10 (finish is null)
  assert.equal(b.emittedCount, 10);
  assert.equal(result.stopReason, "end_turn");
  assert.equal(result.usage.totalTokens, 30);
  assert.equal(result.finishReason.kind, "stop");
  // First emission: reasoning init
  assert.equal(emitted[0].sessionUpdate, "agent_thought_chunk");
  // Tool calls come at end (positions 7, 8); second-to-last in tool-call pair is completed
  assert.equal(emitted[8].status, "completed");
  // Last emission (excluding finish) is the usage_update
  assert.equal(emitted[emitted.length - 1].sessionUpdate, "usage_update");
});