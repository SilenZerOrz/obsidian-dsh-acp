// test/chunk-mapper.test.mjs — node:test unit tests for lib/chunk-mapper.mjs
//
// Verifies the pure-function mapping from dsh LLM StreamChunk (7 types)
// to ACP sessionUpdate payloads, plus state tracking for index allocations.

import test from "node:test";
import assert from "node:assert/strict";
import { chunkToUpdate, createMapperState } from "../lib/chunk-mapper.mjs";

// --- helpers --------------------------------------------------------------

/** Make a chunk of a given type with sensible defaults. */
function mk(type, overrides = {}) {
  return { type, ...overrides };
}

// --- state lifecycle ------------------------------------------------------

test("createMapperState: fresh state has nextId=1 and empty map", () => {
  const s = createMapperState();
  assert.equal(s.nextId, 1);
  assert.ok(s.indexMap instanceof Map);
  assert.equal(s.indexMap.size, 0);
});

test("chunkToUpdate: same state reused across chunks, messageIds monotonic", () => {
  const s = createMapperState();
  // text block at index 0
  const a = chunkToUpdate(mk("block-start", { index: 0, blockType: "text" }), s);
  assert.equal(a.messageId, "msg-1");
  // text block at index 1
  const b = chunkToUpdate(mk("block-start", { index: 1, blockType: "text" }), s);
  assert.equal(b.messageId, "msg-2");
  // reasoning block at index 2 (separate counter space)
  const c = chunkToUpdate(mk("block-start", { index: 2, blockType: "reasoning" }), s);
  assert.equal(c.messageId, "thought-3");
});

// --- block-start (3 sub-types) -------------------------------------------

test("block-start text → initial empty agent_message_chunk", () => {
  const s = createMapperState();
  const u = chunkToUpdate(mk("block-start", { index: 0, blockType: "text" }), s);
  assert.equal(u.sessionUpdate, "agent_message_chunk");
  assert.equal(u.messageId, "msg-1");
  assert.deepEqual(u.content, { type: "text", text: "" });
});

test("block-start reasoning → initial empty agent_thought_chunk", () => {
  const s = createMapperState();
  const u = chunkToUpdate(mk("block-start", { index: 5, blockType: "reasoning" }), s);
  assert.equal(u.sessionUpdate, "agent_thought_chunk");
  assert.equal(u.messageId, "thought-1");
  assert.deepEqual(u.content, { type: "text", text: "" });
});

test("block-start tool-call → null (id arrives with first delta)", () => {
  const s = createMapperState();
  const u = chunkToUpdate(mk("block-start", { index: 7, blockType: "tool-call" }), s);
  assert.equal(u, null);
  // But state reserved the slot
  assert.equal(s.indexMap.get(7).kind, "tool");
  assert.equal(s.indexMap.get(7).messageId, null);
});

test("block-start unknown blockType → null (forward-compat)", () => {
  const s = createMapperState();
  const u = chunkToUpdate(mk("block-start", { index: 0, blockType: "future-type" }), s);
  assert.equal(u, null);
});

// --- text-delta / reasoning-delta ----------------------------------------

test("text-delta appends to messageId from prior block-start", () => {
  const s = createMapperState();
  chunkToUpdate(mk("block-start", { index: 0, blockType: "text" }), s);
  const u = chunkToUpdate(mk("text-delta", { index: 0, text: "Hello" }), s);
  assert.equal(u.sessionUpdate, "agent_message_chunk");
  assert.equal(u.messageId, "msg-1");
  assert.equal(u.content.text, "Hello");
});

test("text-delta without block-start → null (skipped)", () => {
  const s = createMapperState();
  const u = chunkToUpdate(mk("text-delta", { index: 99, text: "orphan" }), s);
  assert.equal(u, null);
});

test("reasoning-delta emits agent_thought_chunk", () => {
  const s = createMapperState();
  chunkToUpdate(mk("block-start", { index: 0, blockType: "reasoning" }), s);
  const u = chunkToUpdate(mk("reasoning-delta", { index: 0, text: "thinking..." }), s);
  assert.equal(u.sessionUpdate, "agent_thought_chunk");
  assert.equal(u.messageId, "thought-1");
  assert.equal(u.content.text, "thinking...");
});

// --- tool-call-delta (delta-only protocol tolerated) --------------------

test("tool-call-delta with no prior block-start binds id from chunk (P0-1: first delta = tool_call start)", () => {
  const s = createMapperState();
  const u = chunkToUpdate(
    mk("tool-call-delta", { index: 3, id: "tool-abc", name: "Read", argumentsDelta: '{"path' }),
    s,
  );
  // P0-1 (2026-10-14): the FIRST delta now emits the ACP `tool_call` START
  // frame (status pending) instead of a tool_call_update.
  assert.equal(u.sessionUpdate, "tool_call");
  assert.equal(u.toolCallId, "tool-abc");
  assert.equal(u.status, "pending");
  assert.equal(u.title, "Read");
  // P0-3: kind inferred from name.
  assert.equal(u.kind, "read");
  // state accumulated
  assert.equal(s.indexMap.get(3).rawInputAccum, '{"path');
});

test("tool-call-delta accumulates argumentsDelta across calls", () => {
  const s = createMapperState();
  chunkToUpdate(mk("tool-call-delta", { index: 0, id: "t1", argumentsDelta: '{"p' }), s);
  chunkToUpdate(mk("tool-call-delta", { index: 0, id: "t1", argumentsDelta: 'ath":' }), s);
  chunkToUpdate(mk("tool-call-delta", { index: 0, id: "t1", argumentsDelta: '"x"}' }), s);
  assert.equal(s.indexMap.get(0).rawInputAccum, '{"path":"x"}');
});

test("tool-call-delta name omitted → no title field", () => {
  const s = createMapperState();
  const u = chunkToUpdate(
    mk("tool-call-delta", { index: 0, id: "t1", argumentsDelta: "{}" }),
    s,
  );
  assert.equal("title" in u, false);
});

// --- block-end -----------------------------------------------------------

// P3.1 C1 fix: when deltas were already streamed, block-end returns null
// (the deltas ARE the canonical text). The previous behavior of re-emitting
// the assembled snapshot caused the client to see the same text twice
// (verified empirically in P2 E 套件 hasSnapshotDup=true, hasDoubled=true).
test("block-end text after deltas → null (P3.1 C1 dedup)", () => {
  const s = createMapperState();
  chunkToUpdate(mk("block-start", { index: 0, blockType: "text" }), s);
  chunkToUpdate(mk("text-delta", { index: 0, text: "Hel" }), s);
  chunkToUpdate(mk("text-delta", { index: 0, text: "lo" }), s);
  const u = chunkToUpdate(
    mk("block-end", { index: 0, block: { type: "text", text: "Hello" } }),
    s,
  );
  assert.equal(u, null);
});

// Fallback: single-frame producers (no deltas) must still get the snapshot
// so legacy / mock LLMs that emit only block-start + block-end keep working.
test("block-end text WITHOUT deltas → snapshot (fallback for single-frame producers)", () => {
  const s = createMapperState();
  chunkToUpdate(mk("block-start", { index: 0, blockType: "text" }), s);
  const u = chunkToUpdate(
    mk("block-end", { index: 0, block: { type: "text", text: "whole text in one shot" } }),
    s,
  );
  assert.equal(u.sessionUpdate, "agent_message_chunk");
  assert.equal(u.messageId, "msg-1");
  assert.equal(u.content.text, "whole text in one shot");
});

test("block-end reasoning after deltas → null (P3.1 C1 dedup, thought variant)", () => {
  const s = createMapperState();
  chunkToUpdate(mk("block-start", { index: 0, blockType: "reasoning" }), s);
  chunkToUpdate(mk("reasoning-delta", { index: 0, text: "thin" }), s);
  chunkToUpdate(mk("reasoning-delta", { index: 0, text: "king" }), s);
  const u = chunkToUpdate(
    mk("block-end", { index: 0, block: { type: "reasoning", text: "thinking" } }),
    s,
  );
  assert.equal(u, null);
});

test("block-end reasoning WITHOUT deltas → snapshot (fallback)", () => {
  const s = createMapperState();
  chunkToUpdate(mk("block-start", { index: 0, blockType: "reasoning" }), s);
  const u = chunkToUpdate(
    mk("block-end", { index: 0, block: { type: "reasoning", text: "thought" } }),
    s,
  );
  assert.equal(u.sessionUpdate, "agent_thought_chunk");
  assert.equal(u.content.text, "thought");
});

test("block-end tool-call emits completed status with parsed rawInput", () => {
  const s = createMapperState();
  chunkToUpdate(
    mk("tool-call-delta", { index: 0, id: "tc1", name: "Edit", argumentsDelta: '{"file":' }),
    s,
  );
  chunkToUpdate(
    mk("tool-call-delta", { index: 0, id: "tc1", argumentsDelta: '"x.md"}' }),
    s,
  );
  const u = chunkToUpdate(
    mk("block-end", {
      index: 0,
      block: { type: "tool-call", toolCallId: "tc1", toolCallName: "Edit" },
    }),
    s,
  );
  assert.equal(u.sessionUpdate, "tool_call_update");
  assert.equal(u.toolCallId, "tc1");
  assert.equal(u.status, "completed");
  assert.deepEqual(u.rawInput, { file: "x.md" });
});

test("block-end tool-call with malformed JSON falls back to rawInput string", () => {
  const s = createMapperState();
  chunkToUpdate(
    mk("tool-call-delta", { index: 0, id: "tc1", argumentsDelta: "{broken" }),
    s,
  );
  const u = chunkToUpdate(
    mk("block-end", {
      index: 0,
      block: { type: "tool-call", toolCallId: "tc1", toolCallName: "Edit" },
    }),
    s,
  );
  assert.equal(typeof u.rawInput, "string");
  assert.equal(u.rawInput, "{broken");
});

test("block-end tool-call surfaces content as ACP content list", () => {
  const s = createMapperState();
  chunkToUpdate(
    mk("tool-call-delta", { index: 0, id: "tc1", argumentsDelta: "{}" }),
    s,
  );
  const u = chunkToUpdate(
    mk("block-end", {
      index: 0,
      block: {
        type: "tool-call",
        toolCallId: "tc1",
        content: [{ type: "text", text: "result line 1" }, { type: "text", text: "line 2" }],
      },
    }),
    s,
  );
  assert.ok(Array.isArray(u.content));
  assert.equal(u.content.length, 2);
  assert.equal(u.content[0].type, "content");
  assert.equal(u.content[0].content.text, "result line 1");
});

test("block-end without prior block-start → null", () => {
  const s = createMapperState();
  const u = chunkToUpdate(mk("block-end", { index: 0, block: { type: "text", text: "" } }), s);
  assert.equal(u, null);
});

// --- usage --------------------------------------------------------------

test("usage chunk emits usage_update with totalTokens", () => {
  const s = createMapperState();
  const u = chunkToUpdate(
    mk("usage", { usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } }),
    s,
  );
  assert.equal(u.sessionUpdate, "usage_update");
  assert.equal(u.used, 15);
  assert.equal(u.size, 0);
});

test("usage chunk with missing totalTokens → used=0", () => {
  const s = createMapperState();
  const u = chunkToUpdate(mk("usage", { usage: {} }), s);
  assert.equal(u.used, 0);
});

// 0.3.6: `size` is the context-window ceiling. dsh TokenUsage has none, so the
// default stays 0 (unknown) — but the frame must keep a NUMBER (the Obsidian
// agent-client's zod schema requires size; omitting it throws on parse), and an
// operator (or a future producer) can supply a real ceiling.
test("usage chunk: DSH_ACP_CONTEXT_WINDOW supplies the size ceiling", () => {
  const prev = process.env.DSH_ACP_CONTEXT_WINDOW;
  process.env.DSH_ACP_CONTEXT_WINDOW = "128000";
  try {
    const u = chunkToUpdate(mk("usage", { usage: { totalTokens: 15 } }), createMapperState());
    assert.equal(u.used, 15);
    assert.equal(u.size, 128000);
  } finally {
    if (prev === undefined) delete process.env.DSH_ACP_CONTEXT_WINDOW;
    else process.env.DSH_ACP_CONTEXT_WINDOW = prev;
  }
});

test("usage chunk: a producer-supplied ceiling wins over the env override", () => {
  const prev = process.env.DSH_ACP_CONTEXT_WINDOW;
  process.env.DSH_ACP_CONTEXT_WINDOW = "128000";
  try {
    const u = chunkToUpdate(
      mk("usage", { usage: { totalTokens: 15, contextWindow: 200000 } }),
      createMapperState(),
    );
    assert.equal(u.size, 200000);
  } finally {
    if (prev === undefined) delete process.env.DSH_ACP_CONTEXT_WINDOW;
    else process.env.DSH_ACP_CONTEXT_WINDOW = prev;
  }
});

test("usage chunk: unparsable ceilings fall back to size=0 (never dropped)", () => {
  const prev = process.env.DSH_ACP_CONTEXT_WINDOW;
  process.env.DSH_ACP_CONTEXT_WINDOW = "not-a-number";
  try {
    const u = chunkToUpdate(mk("usage", { usage: { totalTokens: 15 } }), createMapperState());
    assert.equal(typeof u.size, "number");
    assert.equal(u.size, 0);
  } finally {
    if (prev === undefined) delete process.env.DSH_ACP_CONTEXT_WINDOW;
    else process.env.DSH_ACP_CONTEXT_WINDOW = prev;
  }
});

// --- finish -------------------------------------------------------------

test("finish chunk returns null (bridge synthesizes result)", () => {
  const s = createMapperState();
  const u = chunkToUpdate(mk("finish", { reason: { kind: "stop" } }), s);
  assert.equal(u, null);
});

// --- end-to-end stream simulation ----------------------------------------

test("end-to-end: text + reasoning + tool-call stream emits coherent updates", () => {
  const s = createMapperState();
  const updates = [];

  // Reasoning block
  updates.push(chunkToUpdate(mk("block-start", { index: 0, blockType: "reasoning" }), s));
  updates.push(chunkToUpdate(mk("reasoning-delta", { index: 0, text: "Plan: " }), s));
  updates.push(chunkToUpdate(mk("reasoning-delta", { index: 0, text: "read file" }), s));
  // P3.1 C1: block-end with prior deltas → null (snapshot dedup)
  updates.push(chunkToUpdate(mk("block-end", { index: 0, block: { type: "reasoning", text: "Plan: read file" } }), s));

  // Text block (assistant message)
  updates.push(chunkToUpdate(mk("block-start", { index: 1, blockType: "text" }), s));
  updates.push(chunkToUpdate(mk("text-delta", { index: 1, text: "I will read " }), s));
  updates.push(chunkToUpdate(mk("text-delta", { index: 1, text: "the file." }), s));
  // P3.1 C1: block-end with prior deltas → null (snapshot dedup)
  updates.push(chunkToUpdate(mk("block-end", { index: 1, block: { type: "text", text: "I will read the file." } }), s));

  // Tool call
  updates.push(chunkToUpdate(mk("tool-call-delta", { index: 2, id: "tc1", name: "Read", argumentsDelta: '{"p":"a"}' }), s));
  updates.push(chunkToUpdate(mk("block-end", { index: 2, block: { type: "tool-call", toolCallId: "tc1", toolCallName: "Read" } }), s));

  // Usage + finish
  updates.push(chunkToUpdate(mk("usage", { usage: { totalTokens: 42 } }), s));
  updates.push(chunkToUpdate(mk("finish", { reason: { kind: "stop" } }), s));

  // Filter nulls
  const real = updates.filter(Boolean);

  // P3.1 C1: reasoning + text block-ends now return null (deltas already
  // streamed). New expected count: 1 reasoning-start + 2 reasoning-deltas
  // + 1 text-start + 2 text-deltas + 2 tool updates + 1 usage = 9 real.
  assert.equal(real.length, 9);
  // First update: agent_thought_chunk (msg-1 was allocated for reasoning first)
  assert.equal(real[0].sessionUpdate, "agent_thought_chunk");
  assert.equal(real[0].messageId, "thought-1");
  // Reasoning deltas share the messageId
  assert.equal(real[1].sessionUpdate, "agent_thought_chunk");
  assert.equal(real[1].content.text, "Plan: ");
  assert.equal(real[2].content.text, "read file");
  // P3.1 C1: reasoning block-end → null → no real[3] of reasoning snapshot
  // Text block
  assert.equal(real[3].sessionUpdate, "agent_message_chunk");
  assert.equal(real[3].messageId, "msg-2");
  assert.equal(real[4].content.text, "I will read ");
  assert.equal(real[5].content.text, "the file.");
  // P3.1 C1: text block-end → null → no real[6] of text snapshot
  // Tool call — P0-1: first delta emits the `tool_call` START frame (pending).
  assert.equal(real[6].sessionUpdate, "tool_call");
  assert.equal(real[6].status, "pending");
  assert.equal(real[6].toolCallId, "tc1");
  assert.equal(real[6].kind, "read"); // P0-3
  // completion frame carries rawInput (back-compat) + kind
  assert.equal(real[7].status, "completed");
  assert.deepEqual(real[7].rawInput, { p: "a" });
  assert.equal(real[7].kind, "read");
  // Usage
  assert.equal(real[8].sessionUpdate, "usage_update");
  assert.equal(real[8].used, 42);
});

// P3.1 C1: end-to-end WITHOUT deltas preserves the snapshot path so legacy
// / mock LLM producers (single-frame block-start + block-end) keep working.
test("end-to-end no-deltas: snapshot path preserved for single-frame producers", () => {
  const s = createMapperState();
  const updates = [];

  // text block: only block-start + block-end (no deltas)
  updates.push(chunkToUpdate(mk("block-start", { index: 0, blockType: "text" }), s));
  updates.push(chunkToUpdate(mk("block-end", { index: 0, block: { type: "text", text: "whole" } }), s));

  const real = updates.filter(Boolean);
  assert.equal(real.length, 2);
  assert.equal(real[0].content.text, ""); // initial empty
  assert.equal(real[1].sessionUpdate, "agent_message_chunk");
  assert.equal(real[1].content.text, "whole"); // snapshot preserved
});

// P3.1 C1: deltasSent is a per-slot flag, not a global one. Two text
// blocks side-by-side: one with deltas (snapshot dedup), one without
// (snapshot preserved).
test("block-end: per-slot deltasSent — only the delta'd block is deduped", () => {
  const s = createMapperState();

  // block 0: has deltas
  chunkToUpdate(mk("block-start", { index: 0, blockType: "text" }), s);
  chunkToUpdate(mk("text-delta", { index: 0, text: "A" }), s);
  // block 1: no deltas (single-frame)
  chunkToUpdate(mk("block-start", { index: 1, blockType: "text" }), s);

  // block 0 end: dedup → null
  const u0 = chunkToUpdate(mk("block-end", { index: 0, block: { type: "text", text: "A" } }), s);
  assert.equal(u0, null);
  // block 1 end: keep snapshot
  const u1 = chunkToUpdate(mk("block-end", { index: 1, block: { type: "text", text: "B" } }), s);
  assert.equal(u1.sessionUpdate, "agent_message_chunk");
  assert.equal(u1.content.text, "B");
});