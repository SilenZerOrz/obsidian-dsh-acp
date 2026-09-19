// test/official-bridge-alignment.test.mjs — Phase 2 first-cut ALIGNMENT tests.
//
// NOT a feature test. It pins the two risks the user flagged as the real
// unknowns before any router/mount code is trusted:
//
//   A) sessionId 对齐 — apply() self-generates a UUID sessionId on session/new
//      (verified in dsh-acp source: `randomUUID()`, ignores params.sessionId).
//      The HTTP client's sessionId (a client-owned label today) is therefore
//      NOT equal to apply()'s internal UUID. This test EMPIRICALLY records:
//         - apply() returns a UUID on session/new
//         - passing a client-chosen id to session/prompt on an unknown session
//           is rejected ("unknown session") → proves a mapping layer is required
//
//   B) SSE 字段对比 — capture the session/update (and result/error) frames
//      the official apply() path emits for one stub prompt, and dump them.
//      The Phase-2 mount must forward these verbatim to the SSE writer as
//      {method, params}; the legacy generator dump lives alongside for a
//      JSON.stringify diff.
//
// These run against the REAL apply() via the Spike fixtures (runProfile boot +
// stub LlmAdapter + object-level stream). Written RED first: nothing in
// http-gateway is wired to the official path yet, so any assertion that
// proves an apply() behavior passes on its own (apply() is already live via
// the fixtures) but the gateway-side routing assertions are the ones that
// will fail until Phase 2 code lands.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";

import { apply } from "@deepseek-ai/dsh-acp";

import { makeStreamPair, awaitResponse } from "./fixtures/spike-stream.mjs";
import { StubLlmAdapter, STUB_PROVIDER, STUB_MODEL } from "./fixtures/spike-llm-stub.mjs";
import { bootSpikeContext } from "./fixtures/spike-bootstrap.mjs";

const CWD = "/tmp";
const CLIENT_SESSION_ID = "client-session-1"; // what an HTTP client would send

let bootHandle;
let ctx;
let pair;
const notifications = [];

before(async () => {
  bootHandle = await bootSpikeContext();
  ctx = bootHandle.ctx;
  // Register stub LLM AFTER boot settles so LlmRegistry is mounted.
  ctx.llm.registerAdapter([STUB_PROVIDER], new StubLlmAdapter());
  pair = makeStreamPair();
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

async function rpc(method, params, id, timeoutMs = 15000) {
  const reqId = id ?? Math.floor(Math.random() * 1e6) + 1;
  pair.sink({ jsonrpc: "2.0", id: reqId, method, params });
  return awaitResponse(pair.inbox, reqId, notifications, timeoutMs);
}

// --- A: sessionId 对齐 --------------------------------------------------
// This is the #1 unknown. Empirically confirm apply()'s sessionId model so the
// Phase-2 mapping layer can be spec'd from fact, not assumption.
test("sessionId: apply() self-generates a UUID ≠ client-chosen id", async () => {
  const resp = await rpc("session/new", { cwd: CWD, mcpServers: [], sessionId: CLIENT_SESSION_ID });
  if (resp.error) {
    console.error("full frames:", JSON.stringify(pair.frames, null, 2));
    throw new Error(`session/new failed: ${JSON.stringify(resp.error)}`);
  }
  const generated = resp.result.sessionId;
  assert.ok(typeof generated === "string" && generated.length > 0, `no sessionId: ${JSON.stringify(resp.result)}`);
  // PASS 1: generated id is a UUID (dsh-acp uses randomUUID()).
  assert.match(generated, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/, `expected UUID, got ${generated}`);
  // PASS 2: it does NOT echo the client-chosen id (no pass-through).
  assert.notEqual(generated, CLIENT_SESSION_ID, "apply() echoed client sessionId — reassess mapping need");
  pair.applySessionId = generated;
  console.error("[alignment] apply() generated sessionId:", generated, "≠ client", CLIENT_SESSION_ID);
});

test("sessionId: prompt on an unknown id is rejected (proves mapping layer needed)", async () => {
  const resp = await rpc("session/prompt", {
    sessionId: CLIENT_SESSION_ID, // id the HTTP client would send — unknown to apply()
    prompt: [{ type: "text", text: "echo hello" }],
  });
  assert.ok(resp.error, `expected unknown-session error for client-chosen id, got: ${JSON.stringify(resp)}`);
  const msg = String(resp.error?.message ?? resp.error?.data ?? "");
  assert.ok(/unknown session|session is not|not resumable/i.test(msg), `unexpected error: ${msg}`);
});

// --- B: SSE 字段捕获 (official path reference) --------------------------
// Dump the actual session/update frames apply() emits for a stub prompt.
// Phase-2 gateway must forward these verbatim to the SSE writer as
// {method:"session/update", params}. Captured here as the OFFICIAL side of the
// legacy-vs-official diff.
test("SSE: capture official session/update frames for one stub prompt (reference dump)", async () => {
  if (!pair.applySessionId) {
    const n = await rpc("session/new", { cwd: CWD, mcpServers: [] });
    pair.applySessionId = n.result.sessionId;
  }
  notifications.length = 0;
  const resp = await rpc("session/prompt", {
    sessionId: pair.applySessionId,
    prompt: [{ type: "text", text: "echo hello" }],
  }, Math.floor(Math.random() * 1e6) + 1, 30000);
  if (resp.error) {
    console.error("prompt error:", JSON.stringify(resp.error));
    console.error("notifications:", JSON.stringify(notifications, null, 2));
    throw new Error(`official prompt failed: ${JSON.stringify(resp.error)}`);
  }
  assert.ok(resp.result.stopReason, `no stopReason: ${JSON.stringify(resp.result)}`);

  const updates = notifications.filter((n) => n?.method === "session/update");
  assert.ok(updates.length >= 1, `no session/update. notifications: ${JSON.stringify(notifications, null, 2)}`);

  // Reference dump for the manual legacy-vs-official diff.
  console.error("=== OFFICIAL session/update frames (params), %d total ===", updates.length);
  for (const u of updates.slice(0, 20)) {
    console.error(JSON.stringify(u.params));
  }
  console.error("=== end official dump ===");
  // Sanity: official updates carry a sessionId field.
  assert.ok(updates[0]?.params?.sessionId, `official session/update lacks sessionId: ${JSON.stringify(updates[0])}`);
});
