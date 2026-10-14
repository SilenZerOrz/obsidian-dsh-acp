// test/p0-frame-alignment.test.mjs — P0 帧对齐 (tool_call start / kind / rawOutput)
import test from "node:test";
import assert from "node:assert/strict";

import { chunkToUpdate, createMapperState, inferToolKind } from "../lib/chunk-mapper.mjs";
import { createUpdateTranslator } from "../lib/acp-tool-translation.mjs";

function mk(type, extra) { return { type, ...extra }; }

// ---- P0-3: inferToolKind ----
test("P0-3 inferToolKind: maps tool names to ACP kinds", () => {
  assert.equal(inferToolKind("Bash"), "execute");
  assert.equal(inferToolKind("bash"), "execute");
  assert.equal(inferToolKind("Read"), "read");
  assert.equal(inferToolKind("view_file"), "read");
  assert.equal(inferToolKind("Grep"), "search");
  assert.equal(inferToolKind("web_search"), "search");
  assert.equal(inferToolKind("Edit"), "edit");
  assert.equal(inferToolKind("Write"), "edit");
  assert.equal(inferToolKind("WebFetch"), "fetch");
  assert.equal(inferToolKind("Delete"), "delete");
  assert.equal(inferToolKind("Move"), "move");
  assert.equal(inferToolKind(""), "other");
  assert.equal(inferToolKind(undefined), "other");
  assert.equal(inferToolKind("zzz_unknown"), "other");
});

// ---- P0-1: tool_call start frame ----
test("P0-1 chunk-mapper: first tool-call-delta emits tool_call{status:pending,kind}", () => {
  const s = createMapperState();
  const u = chunkToUpdate(mk("tool-call-delta", { index: 0, id: "t1", name: "Bash", argumentsDelta: "{}" }), s);
  assert.equal(u.sessionUpdate, "tool_call");
  assert.equal(u.status, "pending");
  assert.equal(u.toolCallId, "t1");
  assert.equal(u.name, "Bash");
  assert.equal(u.kind, "execute");
});

test("P0-1 chunk-mapper: subsequent deltas refine with tool_call_update{in_progress}", () => {
  const s = createMapperState();
  chunkToUpdate(mk("tool-call-delta", { index: 0, id: "t1", name: "Bash", argumentsDelta: "{" }), s);
  const u2 = chunkToUpdate(mk("tool-call-delta", { index: 0, id: "t1", name: "Bash", argumentsDelta: "}" }), s);
  assert.equal(u2.sessionUpdate, "tool_call_update");
  assert.equal(u2.status, "in_progress");
});

test("P0-1 acp-tool-translation: passes through tool_call start (not downgraded)", () => {
  const t = createUpdateTranslator();
  const [out] = t.translate({ sessionUpdate: "tool_call", toolCallId: "x", title: "Read", kind: "read", status: "pending", rawInput: { p: "a" } });
  assert.equal(out.sessionUpdate, "tool_call");
  assert.equal(out.status, "pending");
  assert.equal(out.kind, "read");
});

// ---- P0-2: rawOutput on completion ----
test("P0-2 chunk-mapper: completion frame carries rawOutput (result) + rawInput (back-compat)", () => {
  const s = createMapperState();
  chunkToUpdate(mk("tool-call-delta", { index: 0, id: "t1", name: "Bash", argumentsDelta: '{"command":"pwd"}' }), s);
  const done = chunkToUpdate(mk("block-end", { index: 0, block: { type: "tool-call", toolCallId: "t1", toolCallName: "Bash", content: [{ type: "text", text: "/workspace" }] } }), s);
  assert.equal(done.sessionUpdate, "tool_call_update");
  assert.equal(done.status, "completed");
  assert.deepEqual(done.rawInput, { command: "pwd" }, "rawInput = request params (back-compat)");
  assert.equal(done.rawOutput, "/workspace", "rawOutput = result text");
  assert.equal(done.kind, "execute", "P0-3: kind retained on completion");
});

test("P0-2 acp-tool-translation: finish with content → rawOutput set", () => {
  const t = createUpdateTranslator();
  t.translate({ sessionUpdate: "tool_call", toolCallId: "x", title: "Bash", kind: "execute", status: "pending", rawInput: { c: "pwd" } });
  const [out] = t.translate({ sessionUpdate: "tool_call_update", toolCallId: "x", status: "completed", content: [{ type: "text", text: "boom" }] });
  assert.equal(out.status, "completed");
  assert.equal(out.rawOutput, "boom");
  assert.deepEqual(out.rawInput, { c: "pwd" });
});
