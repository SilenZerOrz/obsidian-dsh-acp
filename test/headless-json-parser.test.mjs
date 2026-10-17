// test/headless-json-parser.test.mjs — fixture-driven unit test for
// lib/headless-json-parser.mjs (v2 plan §5.5 0.3.0 工具帧修复, Step A4).
//
// What this covers:
//   1. Every event type in the dsh 0.1.7-rc.1 --json sample maps to the
//      expected OFFICIAL-shaped session/update frame (text, tool_call start,
//      tool_result finish, usage, turn_end, final, session).
//   2. Defensive paths: blank line, malformed JSON, unknown type, missing
//      callId, missing fields — none of them throw.
//   3. Translator integration: feeding the parser's official frames through
//      createUpdateTranslator() produces the legacy SSE shape legacy
//      consumers expect (tool_call_update{in_progress, title},
//      tool_call_update{completed, rawInput backfilled}, etc.).
//   4. Failed tool_result path: error string reaches the legacy
//      tool_call_update{content:[...]} frame (the translator update added
//      forwarding for non-empty content).
//   5. flush() returns sessionId / cwd / stopReason / sawFinal / events.
//
// Pure function — no network, no spawn, no gateway. The fixture
// was the exact bytes dsh emitted on 2026-09-28; tests assert the spec,
// not implementation detail. (Sample now inlined below — see §3.1 note.)

import { test } from "node:test";
import assert from "node:assert/strict";

import { createHeadlessParser } from "../lib/headless-json-parser.mjs";
import { createUpdateTranslator } from "../lib/acp-tool-translation.mjs";

// Inlined sample (previously an external sample file under test/).
// Tests depending on external fixture files may not live in test:unit
// (测试资产规范 §3.1), so the sample is inlined as a de-sensitized constant.
// Paths in the sample use /tmp/test-user (de-sensitized).
const SAMPLE_JSONL = [
  '{"type":"session","sessionId":"session-234ed0db-1f0f-446f-92f2-9e799b4b7104","cwd":"/tmp/test-user"}',
  '{"type":"status","phase":"turn_start","turn":1}',
  '{"type":"status","phase":"step_start","turn":1,"step":1}',
  '{"type":"text","text":"I don\'t have a `get_cwd` tool available. Let me check my current directory using the bash tool instead.\\n\\n"}',
  '{"type":"tool_call","callId":"call_e855e62c49734ea3ba04b9bb","tool":"bash","input":{"command":"pwd","description":"Print current working directory"}}',
  '{"type":"tool_result","callId":"call_e855e62c49734ea3ba04b9bb","status":"completed","result":"/tmp/test-user\\n"}',
  '{"type":"status","phase":"step_end","turn":1,"step":1,"usage":{"inputTokens":7681,"outputTokens":87,"totalTokens":7768}}',
  '{"type":"status","phase":"step_start","turn":1,"step":2}',
  '{"type":"text","text":"当前目录是 `/tmp/test-user`。\\n\\n说明：我这里没有名为 `get_cwd` 的工具，所以我用 `bash` 工具执行了 `pwd` 命令来获取当前目录。"}',
  '{"type":"status","phase":"step_end","turn":1,"step":2,"usage":{"inputTokens":7784,"outputTokens":44,"totalTokens":7828}}',
  '{"type":"status","phase":"turn_end","turn":1,"reason":{"kind":"completed"}}',
  '{"type":"final","text":"当前目录是 `/tmp/test-user`。\\n\\n说明：我这里没有名为 `get_cwd` 的工具，所以我用 `bash` 工具执行了 `pwd` 命令来获取当前目录。"}',
].join("\n");

// --- helper: feed the fixture line-by-line, return per-line frames + flush. -
function parseFixture() {
  const text = SAMPLE_JSONL;
  const lines = text.split("\n").filter((l) => l.length > 0);
  const parser = createHeadlessParser();
  const perLine = [];
  for (const line of lines) perLine.push(parser.push(line));
  const flush = parser.flush();
  return { perLine, flush, lineCount: lines.length };
}

// ============================================================================
// 1. Fixture sanity
// ============================================================================

test("fixture: 12 non-empty JSONL lines parse without error", () => {
  const { lineCount, flush } = parseFixture();
  assert.equal(lineCount, 12, "sample fixture should have 12 events (per §5.5.2 schema)");
  assert.equal(flush.sawFinal, true, "event #12 is a `final` event — must be observed");
  assert.equal(flush.sessionId, "session-234ed0db-1f0f-446f-92f2-9e799b4b7104");
  assert.equal(flush.cwd, "/tmp/test-user");
  assert.equal(flush.stopReason, "end_turn", "turn_end kind:completed → end_turn");
});

test("fixture: produces 6 official frames (2 text + 2 tool + 2 usage)", () => {
  const { flush } = parseFixture();
  const types = flush.events.map((f) => f.sessionUpdate);
  assert.deepEqual(types, [
    "agent_message_chunk",
    "tool_call",
    "tool_call_update",
    "usage_update",
    "agent_message_chunk",
    "usage_update",
  ]);
});

// ============================================================================
// 2. Per-event-type shape assertions
// ============================================================================

test("text event → agent_message_chunk with non-empty content.text", () => {
  const { perLine } = parseFixture();
  // Lines 4 and 9 in the fixture are text events (1-indexed → push[3], push[8]).
  const line4 = perLine[3];
  assert.equal(line4.length, 1);
  assert.equal(line4[0].sessionUpdate, "agent_message_chunk");
  assert.match(line4[0].messageId, /^msg-\d+$/);
  assert.equal(line4[0].content.type, "text");
  assert.match(line4[0].content.text, /don't have a `get_cwd` tool/);

  const line9 = perLine[8];
  assert.equal(line9[0].sessionUpdate, "agent_message_chunk");
  assert.match(line9[0].content.text, /当前目录是/);
  // Each text event gets a fresh messageId — they belong to different
  // agent steps (separated by tool round-trips).
  assert.notEqual(line4[0].messageId, line9[0].messageId, "different steps → different messageIds");
});

test("tool_call event → official tool_call frame (title + rawInput)", () => {
  const { perLine } = parseFixture();
  // Line 5 (push[4]) is the tool_call event.
  const [frame] = perLine[4];
  assert.equal(frame.sessionUpdate, "tool_call");
  assert.equal(frame.toolCallId, "call_e855e62c49734ea3ba04b9bb");
  assert.equal(frame.title, "bash");
  // P0-3: kind inferred from tool name (bash → execute).
  assert.equal(frame.kind, "execute", "kind inferred from name (was hardcoded 'other')");
  // P0-1: start frame now carries the ACP pending status.
  assert.equal(frame.status, "pending");
  assert.deepEqual(frame.rawInput, {
    command: "pwd",
    description: "Print current working directory",
  });
});

test("tool_result (completed) → tool_call_update carries result in content + rawOutput (P1-4)", () => {
  const { perLine } = parseFixture();
  // Line 6 (push[5]) is the tool_result event (result = "/tmp/test-user\n").
  const [frame] = perLine[5];
  assert.equal(frame.sessionUpdate, "tool_call_update");
  assert.equal(frame.toolCallId, "call_e855e62c49734ea3ba04b9bb");
  assert.equal(frame.status, "completed");
  // P1-4 (2026-10-14): the completed frame now carries the tool result.
  assert.equal(frame.rawOutput, "/tmp/test-user\n");
  assert.deepEqual(frame.content, [
    { type: "content", content: { type: "text", text: "/tmp/test-user\n" } },
  ]);
});

test("status.step_end.usage → usage_update with used/size/inputTokens/outputTokens", () => {
  const { perLine } = parseFixture();
  // Lines 7 and 10 (push[6], push[9]) are step_end events with usage.
  const [u1] = perLine[6];
  assert.equal(u1.sessionUpdate, "usage_update");
  assert.equal(u1.used, 7768);
  assert.equal(u1.size, 0);
  assert.equal(u1.inputTokens, 7681);
  assert.equal(u1.outputTokens, 87);

  const [u2] = perLine[9];
  assert.equal(u2.used, 7828);
  assert.equal(u2.inputTokens, 7784);
  assert.equal(u2.outputTokens, 44);
});

test("status.turn_end with kind:completed → stopReason:end_turn (no frame emitted)", () => {
  const { perLine } = parseFixture();
  // Line 11 (push[10]) is the turn_end event — must NOT emit a frame.
  assert.deepEqual(perLine[10], [], "turn_end is internal pacing, no session/update frame");
});

test("status.session (event #1) emits no frame but captures sessionId+cwd", () => {
  const { perLine, flush } = parseFixture();
  assert.deepEqual(perLine[0], [], "session is metadata, not a sessionUpdate");
  assert.match(flush.sessionId, /^session-/);
  assert.match(flush.cwd, /^\//, "absolute path");
});

test("final event is silently dropped (duplicate of last text + tool result)", () => {
  const { perLine, flush } = parseFixture();
  // Line 12 (push[11]) is the final event.
  assert.deepEqual(perLine[11], []);
  assert.equal(flush.sawFinal, true);
});

// ============================================================================
// 3. Defensive paths
// ============================================================================

test("push: empty string returns [] and does not throw", () => {
  const p = createHeadlessParser();
  assert.deepEqual(p.push(""), []);
  assert.deepEqual(p.push("   "), []);
});

test("push: malformed JSON returns [] and does not throw", () => {
  const p = createHeadlessParser();
  assert.deepEqual(p.push("{not-json"), []);
  assert.deepEqual(p.push("null"), []); // JSON-valid but not an object
  assert.deepEqual(pushNonObject(p, '"plain-string"'), []);
  function pushNonObject(parser, line) {
    // "plain-string" is valid JSON but not an object event.
    return parser.push(line);
  }
});

test("push: unknown event type is silently dropped", () => {
  const p = createHeadlessParser();
  assert.deepEqual(p.push(JSON.stringify({ type: "future_event", x: 1 })), []);
});

test("push: tool_call without callId is dropped (defensive — no cache poisoning)", () => {
  const p = createHeadlessParser();
  const frames = p.push(JSON.stringify({ type: "tool_call", tool: "bash", input: {} }));
  assert.deepEqual(frames, [], "missing callId → no frame, no crash");
});

test("push: tool_result without callId is dropped", () => {
  const p = createHeadlessParser();
  const frames = p.push(JSON.stringify({ type: "tool_result", status: "completed", result: "{}" }));
  assert.deepEqual(frames, []);
});

test("push: text event with empty string content is dropped (no empty messageId burned)", () => {
  const p = createHeadlessParser();
  const before = parserEventCount(p);
  p.push(JSON.stringify({ type: "text", text: "" }));
  assert.equal(parserEventCount(p), before, "empty text must not allocate a messageId");
});
function parserEventCount(p) {
  // peek into flush().events without polluting state
  const snap = p.flush();
  return snap.events.length;
}

test("push: non-string input (number/object/buffer) is rejected silently", () => {
  const p = createHeadlessParser();
  assert.deepEqual(p.push(42), []);
  assert.deepEqual(p.push({}), []);
  assert.deepEqual(p.push(null), []);
  assert.deepEqual(p.push(undefined), []);
});

// ============================================================================
// 4. Translator integration: parser → official → legacy
// ============================================================================

test("integration: parser → translator emits tool_call START (pending) + completed with rawInput backfilled", () => {
  const text = SAMPLE_JSONL;
  const lines = text.split("\n").filter(Boolean);
  const parser = createHeadlessParser();
  const translator = createUpdateTranslator();
  const legacy = [];
  for (const line of lines) {
    for (const f of parser.push(line)) for (const t of translator.translate(f)) legacy.push(t);
  }
  // P0-1 (2026-10-14): the start frame is now passed through as `tool_call`
  // (status pending), NOT downgraded to tool_call_update{in_progress}.
  const start = legacy.find(
    (f) => f.sessionUpdate === "tool_call" && f.status === "pending",
  );
  const completed = legacy.find(
    (f) => f.sessionUpdate === "tool_call_update" && f.status === "completed",
  );
  assert.ok(start, "must produce a passthrough tool_call{pending} start frame");
  assert.ok(completed, "must produce a tool_call_update{completed}");
  assert.equal(start.title, "bash", "title passes through verbatim");
  assert.equal(start.toolCallId, "call_e855e62c49734ea3ba04b9bb");
  assert.equal(start.kind, "execute", "P0-3: kind inferred (bash → execute)");
  assert.deepEqual(start.rawInput, {
    command: "pwd",
    description: "Print current working directory",
  });
  // rawInput IS on completed — backfilled from the parser's official tool_call.
  assert.deepEqual(completed.rawInput, {
    command: "pwd",
    description: "Print current working directory",
  });
  // P1-4 (2026-10-14): the completed frame now carries the tool result —
  // content + rawOutput (translator forwards non-empty content verbatim).
  assert.equal(completed.rawOutput, "/tmp/test-user\n");
  assert.deepEqual(completed.content, [
    { type: "content", content: { type: "text", text: "/tmp/test-user\n" } },
  ]);
});

test("integration: usage_update passes through the translator verbatim (extra fields preserved)", () => {
  const parser = createHeadlessParser();
  const translator = createUpdateTranslator();
  const official = parser.push(JSON.stringify({
    type: "status",
    phase: "step_end",
    usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
  }))[0];
  const [legacy] = translator.translate(official);
  assert.equal(legacy.sessionUpdate, "usage_update");
  assert.equal(legacy.used, 150);
  assert.equal(legacy.size, 0);
  assert.equal(legacy.inputTokens, 100, "extra keys preserved for clients that read them");
  assert.equal(legacy.outputTokens, 50);
});

// ============================================================================
// 5. Failed tool_result path — error string reaches the legacy consumer
// ============================================================================

test("tool_result failed → official frame carries content:[] with error → translator forwards to legacy", () => {
  // Simulate a failed tool_result by hand-injecting a line into a fresh parser.
  const parser = createHeadlessParser();
  const translator = createUpdateTranslator();
  const callId = "call-fail-xyz";
  // Start: tool_call
  parser.push(JSON.stringify({
    type: "tool_call", callId, tool: "bash", input: { command: "false" },
  }));
  // Fail: tool_result{status:"failed", result:"bash: false: command not found"}
  const failFrames = parser.push(JSON.stringify({
    type: "tool_result", callId, status: "failed", result: "bash: false: command not found",
  }));
  assert.equal(failFrames.length, 1);
  assert.equal(failFrames[0].sessionUpdate, "tool_call_update");
  assert.equal(failFrames[0].status, "failed");
  assert.equal(failFrames[0].content.length, 1, "failed finish must carry the error message");
  assert.equal(failFrames[0].content[0].type, "content");
  assert.equal(failFrames[0].content[0].content.text, "bash: false: command not found");

  // Translate through to legacy — the translator update forwards non-empty content.
  // First seed a start frame into the translator so its cache matches.
  translator.translate({
    sessionUpdate: "tool_call",
    toolCallId: callId,
    title: "bash",
    kind: "other",
    status: "in_progress",
    rawInput: { command: "false" },
  });
  const [legacy] = translator.translate(failFrames[0]);
  assert.equal(legacy.sessionUpdate, "tool_call_update");
  assert.equal(legacy.status, "failed");
  assert.equal(legacy.rawInput.command, "false", "start's rawInput backfilled into failed finish");
  assert.ok(Array.isArray(legacy.content), "non-empty content forwarded to legacy");
  assert.equal(legacy.content[0].content.text, "bash: false: command not found");
});

// ============================================================================
// 6. turn_end reason mapping
// ============================================================================

test("turn_end reason kinds map to the correct stopReason (table-driven)", () => {
  const cases = [
    [{ kind: "completed" }, "end_turn"],
    [{ kind: "error" }, "refusal"],
    [{ kind: "cancelled" }, "cancelled"],
    [{ kind: "max_tokens" }, "max_tokens"],
    [{ kind: "future_unknown_kind" }, "end_turn"], // unknown → default
  ];
  for (const [reason, expected] of cases) {
    const p = createHeadlessParser();
    p.push(JSON.stringify({ type: "status", phase: "turn_end", turn: 1, reason }));
    assert.equal(p.flush().stopReason, expected, `reason.kind=${reason.kind} → ${expected}`);
  }
});
// --- P1-4 (2026-10-14): completed tool_result carries the result ------------

test("P1-4: completed tool_result → content + rawOutput (object result JSON-stringified)", () => {
  const p = createHeadlessParser();
  const frames = p.push(JSON.stringify({
    type: "tool_result", callId: "tc-p14", status: "completed",
    result: { stdout: "hi", code: 0 },
  }));
  const f = frames.find((x) => x.sessionUpdate === "tool_call_update");
  assert.ok(f, "must emit a tool_call_update");
  assert.equal(f.status, "completed");
  assert.equal(f.rawOutput, JSON.stringify({ stdout: "hi", code: 0 }));
  assert.equal(f.content[0].type, "content");
  assert.equal(f.content[0].content.text, JSON.stringify({ stdout: "hi", code: 0 }));
});

test("P1-4: completed tool_result with NO result keeps content:[] (unchanged)", () => {
  const p = createHeadlessParser();
  const frames = p.push(JSON.stringify({ type: "tool_result", callId: "tc-x", status: "completed" }));
  const f = frames.find((x) => x.sessionUpdate === "tool_call_update");
  assert.deepEqual(f.content, []);
  assert.equal(f.rawOutput, undefined);
});
