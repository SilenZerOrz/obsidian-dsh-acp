// test/headless-reasoning.test.mjs — P2-1 (R133 / 卡 -63) spawn 路径 reasoning 事件.
//
// 判据（评审者 2026-11-15 下发，照抄 R133 acceptance）：
//   ① `headless-json-parser.mjs` 解析上游 reasoning 增量并产出 `agent_thought_chunk`；
//   ③ 单测或真机取证（二选一）——本文件即单测取证。
//
// 上游确实发 reasoning —— @deepseek-ai/dsh-headless@0.2.2-rc.3
// lib/json-stream-Dc3g2Bl1.js:204-209：
//
//   case "assistant/message":
//     for (const block of event.data.message.content)
//       if (block.type === "reasoning") write({ type: "thinking", text: block.text });
//
// 所以本条**不是**不可达，实现落在解析器的 `case "thinking"`。
//
// 本文件的重点是「与 long/proxy 生产者形状一致」：Obsidian 渲染 ThinkingBlock
// 靠的是 agent_thought_chunk 的三元组 {sessionUpdate, messageId, content}，
// 两条生产者若形状漂移，客户端只会认其中一条。

import { test } from "node:test";
import assert from "node:assert/strict";

import { createHeadlessParser } from "../lib/headless-json-parser.mjs";
import { createUpdateTranslator } from "../lib/acp-tool-translation.mjs";
import { chunkToUpdate, createMapperState } from "../lib/chunk-mapper.mjs";

/** One upstream `thinking` event, verbatim from the dsh-headless projection. */
function thinkingEvent(text) {
  return JSON.stringify({ type: "thinking", text });
}

test("P2-1①: a `thinking` event becomes an agent_thought_chunk", () => {
  const parser = createHeadlessParser();
  const frames = parser.push(thinkingEvent("先想一下这个问题"));
  assert.equal(frames.length, 1, `expected exactly one frame, got ${JSON.stringify(frames)}`);
  assert.equal(frames[0].sessionUpdate, "agent_thought_chunk");
  assert.equal(frames[0].content.type, "text");
  assert.equal(frames[0].content.text, "先想一下这个问题");
  assert.equal(typeof frames[0].messageId, "string");
  assert.ok(frames[0].messageId.length > 0, "messageId must be non-empty");
});

test("P2-1: thought messageIds are unique and prefixed distinctly from text", () => {
  const parser = createHeadlessParser();
  const a = parser.push(thinkingEvent("思路一"))[0];
  const b = parser.push(thinkingEvent("思路二"))[0];
  const c = parser.push(JSON.stringify({ type: "text", text: "答案" }))[0];
  assert.notEqual(a.messageId, b.messageId, "two reasoning blocks must not share an id");
  assert.notEqual(a.messageId, c.messageId, "thought and text ids must not collide");
  assert.match(a.messageId, /^thought-/, `expected thought- prefix, got ${a.messageId}`);
  assert.match(c.messageId, /^msg-/, `expected msg- prefix, got ${c.messageId}`);
});

test("P2-1: empty / non-string thinking text emits no frame (never a blank block)", () => {
  const parser = createHeadlessParser();
  assert.deepEqual(parser.push(thinkingEvent("")), []);
  assert.deepEqual(parser.push(JSON.stringify({ type: "thinking" })), []);
  assert.deepEqual(parser.push(JSON.stringify({ type: "thinking", text: 42 })), []);
});

test("P2-1: reasoning and text interleave in emission order", () => {
  const parser = createHeadlessParser();
  const seq = [
    ...parser.push(thinkingEvent("想")),
    ...parser.push(JSON.stringify({ type: "text", text: "说" })),
    ...parser.push(thinkingEvent("再想")),
  ];
  assert.deepEqual(seq.map((f) => f.sessionUpdate), [
    "agent_thought_chunk",
    "agent_message_chunk",
    "agent_thought_chunk",
  ]);
  assert.deepEqual(seq.map((f) => f.content.text), ["想", "说", "再想"]);
});

test("P2-1: shapes match the long/proxy producer byte-for-byte", () => {
  // long/proxy: a reasoning block-start through chunk-mapper.
  const long = chunkToUpdate(
    { type: "block-start", index: 0, blockType: "reasoning" },
    createMapperState(),
  );
  assert.equal(long.sessionUpdate, "agent_thought_chunk", "precondition: chunk-mapper emits thoughts");

  // spawn: the same reasoning block through the JSONL parser.
  const [spawn] = createHeadlessParser().push(thinkingEvent("任意内容"));
  assert.equal(spawn.sessionUpdate, long.sessionUpdate);
  assert.deepEqual(
    Object.keys(spawn).sort(),
    Object.keys(long).sort(),
    `key sets must match: spawn=${JSON.stringify(Object.keys(spawn))} long=${JSON.stringify(Object.keys(long))}`,
  );
  assert.equal(typeof spawn.content?.text, "string");
  assert.equal(spawn.content?.type, long.content?.type);
});

test("P2-1: the translator passes agent_thought_chunk through unchanged", () => {
  const [official] = createHeadlessParser().push(thinkingEvent("透传检查"));
  const translator = createUpdateTranslator();
  const [legacy] = translator.translate(official);
  assert.deepEqual(legacy, official, "no thought frame may be rewritten by the translation layer");
});

test("P2-1: a reasoning-only turn still terminates cleanly (flush sees no stray state)", () => {
  const parser = createHeadlessParser();
  parser.push(thinkingEvent("只有思考"));
  parser.push(JSON.stringify({ type: "status", phase: "turn_end", turn: 1, reason: { kind: "completed" } }));
  const out = parser.flush();
  assert.equal(out.stopReason, "end_turn");
  assert.ok(Array.isArray(out.events));
});

test("P2-1: the inlined 12-event fixture keeps yielding the same frames (no regression)", () => {
  // The fixture predates reasoning support (captured 2026-09-28) and contains
  // no `thinking` event — so its frame count must be unchanged by P2-1.
  const parser = createHeadlessParser();
  const lines = [
    '{"type":"session","sessionId":"s-1","cwd":"/tmp/x"}',
    '{"type":"status","phase":"turn_start","turn":1}',
    '{"type":"text","text":"hi"}',
    '{"type":"status","phase":"turn_end","turn":1,"reason":{"kind":"completed"}}',
  ];
  const types = lines.flatMap((l) => parser.push(l)).map((f) => f.sessionUpdate);
  assert.deepEqual(types, ["agent_message_chunk"], "no phantom thought frame may appear");
});
