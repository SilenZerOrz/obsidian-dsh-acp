// test/dsh-acp-apply-spike.test.mjs — Phase 1 Spike for v2 migration.
//
// Plan: docs/实施计划/dsh-acp-official-bridge-v2-migration-plan.md §2
// Path C'': boot dsh-base in-process (isolated DSH_HOME) + stub LLM
// registered via ctx.llm.registerAdapter() AFTER boot settles.
//
// Assertions (v2 §2.3):
//   S1 — initialize handshake + protocolVersion=1
//   S2 — session/new returns non-empty sessionId
//   S3 — session/new returns configOptions array (>= 1 entry)
//   S4a — session/prompt runs end-to-end, >= 1 session/update notification,
//         prompt response has stopReason
//   S6 — session/resume reuse (after close → re-open via persistence)
//   S7 — session/close invalidates; second prompt returns error
//
// S5 (real notification types) and S8 (dispose teardown) collapse into S4/S7
// evidence in this Spike; full coverage is Phase 3 with real LLM.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";

import { apply } from "@deepseek-ai/dsh-acp";

import { makeStreamPair, awaitResponse } from "./fixtures/spike-stream.mjs";
import { StubLlmAdapter, STUB_PROVIDER, STUB_MODEL, STUB_FIXTURE_TEXT } from "./fixtures/spike-llm-stub.mjs";
import { bootSpikeContext } from "./fixtures/spike-bootstrap.mjs";

// Test cwd must be an absolute path (validateWorkspaceParams rejects otherwise).
const CWD = "/tmp";

let bootHandle;
let ctx;
let pair;
let adapter;
const notifications = [];

function dumpFrames() {
  console.error("--- raw frames captured ---");
  for (const f of pair.frames.slice(-20)) {
    console.error(JSON.stringify(f));
  }
  console.error("--- end frames ---");
}

before(async () => {
  bootHandle = await bootSpikeContext();
  ctx = bootHandle.ctx;

  // Register stub LLM AFTER boot settles so LlmRegistry is mounted.
  adapter = new StubLlmAdapter();
  ctx.llm.registerAdapter([STUB_PROVIDER], adapter);

  pair = makeStreamPair();
  // Mount apply() with our custom stream. apply() returns nothing —
  // teardown happens via ctx.fiber.dispose().
  apply(ctx, {
    provider: STUB_PROVIDER,
    model: STUB_MODEL,
    stream: { writable: pair.writable, readable: pair.readable },
  });
});

after(async () => {
  try { pair?.close(); } catch {}
  await bootHandle?.dispose();
});

// --- S1 ----------------------------------------------------------------
test("S1: initialize returns protocolVersion=1 with agentCapabilities", async () => {
  const id = 1;
  pair.sink({
    jsonrpc: "2.0",
    id,
    method: "initialize",
    params: { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: "spike-test", version: "0.0.0" } },
  });
  const resp = await awaitResponse(pair.inbox, id, notifications);
  if (resp.error) { dumpFrames(); throw new Error(`S1 failed: ${JSON.stringify(resp.error)}`); }
  assert.equal(resp.result.protocolVersion, 1, "protocolVersion mismatch");
  assert.ok(resp.result.agentCapabilities, "agentCapabilities missing");
  assert.ok(resp.result.agentCapabilities.promptCapabilities, "promptCapabilities missing");
});

// --- S2 ----------------------------------------------------------------
test("S2: session/new returns a non-empty sessionId", async () => {
  const id = 2;
  pair.sink({
    jsonrpc: "2.0",
    id,
    method: "session/new",
    params: { cwd: CWD, mcpServers: [] },
  });
  const resp = await awaitResponse(pair.inbox, id, notifications);
  if (resp.error) { dumpFrames(); throw new Error(`S2 failed: ${JSON.stringify(resp.error)}`); }
  assert.ok(typeof resp.result.sessionId === "string" && resp.result.sessionId.length > 0, `sessionId missing: ${JSON.stringify(resp.result)}`);
  // Cache for later tests
  pair.firstSessionId = resp.result.sessionId;
  pair.firstConfigOptions = resp.result.configOptions;
});

// --- S3 ----------------------------------------------------------------
test("S3: session/new response includes configOptions array", async () => {
  assert.ok(pair.firstConfigOptions !== undefined, "firstConfigOptions not set; S2 likely failed silently");
  assert.ok(Array.isArray(pair.firstConfigOptions), `configOptions not array: ${typeof pair.firstConfigOptions}`);
  assert.ok(pair.firstConfigOptions.length >= 1, `configOptions empty: ${JSON.stringify(pair.firstConfigOptions)}`);
});

// --- S4a ---------------------------------------------------------------
test("S4a: session/prompt round-trip with at least one session/update notification", async () => {
  const id = 4;
  const sessionId = pair.firstSessionId;
  notifications.length = 0;
  pair.sink({
    jsonrpc: "2.0",
    id,
    method: "session/prompt",
    params: {
      sessionId,
      prompt: [{ type: "text", text: "echo hello" }],
    },
  });
  const resp = await awaitResponse(pair.inbox, id, notifications, 30000);
  if (resp.error) {
    dumpFrames();
    // Capture full notifications for diagnosis.
    console.error("S4a notifications captured:", JSON.stringify(notifications, null, 2));
    throw new Error(`S4a failed: ${JSON.stringify(resp.error)}`);
  }
  assert.ok(resp.result.stopReason, `stopReason missing: ${JSON.stringify(resp.result)}`);
  // >= 1 session/update notification expected
  const updates = notifications.filter((n) => n?.method === "session/update");
  assert.ok(updates.length >= 1, `expected >=1 session/update notification, got ${updates.length}: ${JSON.stringify(notifications)}`);
});

// --- S6 ----------------------------------------------------------------
test("S6: session/resume reopens after close via persisted state", async () => {
  // First close the live session.
  const closeId = 60;
  pair.sink({
    jsonrpc: "2.0",
    id: closeId,
    method: "session/close",
    params: { sessionId: pair.firstSessionId },
  });
  const closeResp = await awaitResponse(pair.inbox, closeId, notifications, 10000);
  if (closeResp.error) { dumpFrames(); throw new Error(`S6 close failed: ${JSON.stringify(closeResp.error)}`); }

  // Now resume.
  const id = 61;
  notifications.length = 0;
  pair.sink({
    jsonrpc: "2.0",
    id,
    method: "session/resume",
    params: { sessionId: pair.firstSessionId, cwd: CWD, mcpServers: [] },
  });
  const resp = await awaitResponse(pair.inbox, id, notifications, 15000);
  if (resp.error) {
    dumpFrames();
    console.error("S6 notifications:", JSON.stringify(notifications, null, 2));
    throw new Error(`S6 resume failed: ${JSON.stringify(resp.error)}`);
  }
  assert.ok(Array.isArray(resp.result.configOptions), `configOptions missing on resume: ${JSON.stringify(resp.result)}`);
});

// --- S7 ----------------------------------------------------------------
test("S7: session/close invalidates; subsequent prompt returns error", async () => {
  const closeId = 70;
  pair.sink({
    jsonrpc: "2.0",
    id: closeId,
    method: "session/close",
    params: { sessionId: pair.firstSessionId },
  });
  await awaitResponse(pair.inbox, closeId, notifications, 10000);

  const id = 71;
  notifications.length = 0;
  pair.sink({
    jsonrpc: "2.0",
    id,
    method: "session/prompt",
    params: { sessionId: pair.firstSessionId, prompt: [{ type: "text", text: "after close" }] },
  });
  const resp = await awaitResponse(pair.inbox, id, notifications, 10000);
  assert.ok(resp.error, `expected error response after close, got ${JSON.stringify(resp)}`);
  // The apply() source returns `invalidParams("unknown session: ...")` on closed session.
  const errMsg = String(resp.error?.message ?? resp.error?.data ?? "");
  assert.ok(/unknown session|session is not/i.test(errMsg), `unexpected error after close: ${errMsg}`);
});
