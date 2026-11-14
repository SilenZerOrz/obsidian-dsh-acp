// test/acp-official-router.test.mjs — Phase 2 first-cut: single-session 直通.
//
// Validates lib/acp-official-router.mjs against the REAL apply() (boot via the
// Spike fixtures: runProfile + stub LlmAdapter). This is the "green" that the
// http-gateway official branch will build on:
//   - a client sessionId (a LABEL) transparently maps to apply()'s UUID
//   - one prompt runs end-to-end, notifications flow, result returns stopReason
//   - no auto-fallback (mount failure throws — asserted in a separate test)
//
// This exercises the ROUTER directly (not the full SSE gateway) — the first cut
// keeps router↔gateway wiring as the next micro-step after this passes.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";

import { createOfficialAcpRouter } from "../lib/acp-official-router.mjs";
import { StubLlmAdapter, STUB_PROVIDER, STUB_MODEL, STUB_FIXTURE_TEXT } from "./fixtures/spike-llm-stub.mjs";
import { bootSpikeContext } from "./fixtures/spike-bootstrap.mjs";

let bootHandle;
let ctx;
let router;

before(async () => {
  bootHandle = await bootSpikeContext();
  ctx = bootHandle.ctx;
  ctx.llm.registerAdapter([STUB_PROVIDER], new StubLlmAdapter());
});

after(async () => {
  try { router?.close(); } catch {}
  await bootHandle?.dispose();
});

test("mount apply() + single client session runs a prompt with sessionId translation", async () => {
  router = createOfficialAcpRouter(ctx, { provider: STUB_PROVIDER, model: STUB_MODEL });

  const CLIENT_ID = "http-client-session-1";
  const updates = [];

  // Before any prompt, the clientId has no apply() session yet.
  assert.equal(router.getApplyId(CLIENT_ID), undefined, "mapping should start empty");

  const result = await router.prompt(CLIENT_ID, {
    prompt: [{ type: "text", text: "echo hello" }],
    onUpdate: (params) => updates.push(params),
  });

  // Result resolves with stopReason.
  assert.ok(result.stopReason, `no stopReason: ${JSON.stringify(result)}`);

  // Mapping is now populated: clientId -> apply() UUID.
  const applyId = router.getApplyId(CLIENT_ID);
  assert.ok(typeof applyId === "string" && applyId.length > 0, `no applyId: ${applyId}`);
  assert.match(applyId, /^[0-9a-f]{8}-/, `applyId should be a UUID, got ${applyId}`);

  // Notifications flowed, and each carries the apply() UUID (routed correctly).
  assert.ok(updates.length >= 1, `no updates: ${JSON.stringify(updates)}`);
  const messageChunks = updates.filter((u) => u?.update?.sessionUpdate === "agent_message_chunk");
  assert.ok(messageChunks.length >= 1, `no agent_message_chunk. updates: ${JSON.stringify(updates)}`);
  assert.equal(messageChunks[0].update.content.text, STUB_FIXTURE_TEXT, "stub text should round-trip");

  // Reuse: a second prompt on the SAME clientId reuses the same apply() session.
  const applyId2 = (await router.prompt(CLIENT_ID, {
    prompt: [{ type: "text", text: "again" }],
  }), router.getApplyId(CLIENT_ID));
  assert.equal(applyId2, applyId, "second prompt must reuse the same apply() session");
});

// ─────────────────────────────────────────────────────────────────────────────
// GE-2 (2026-11-15): an upstream JSON-RPC ERROR frame must reach the caller as
// an Error that still carries `code`, `data` and the raw `errorFrame`.
//
// Before GE-2 the router rejected with the bare wire object, so the one field
// that can hold the real diagnosis (`data.details`, when the SDK takes its
// non-RequestError fallback) was effectively unreachable from the gateway's
// `catch (e)` (which only read `e.message`).
//
// Determinism: we swallow the outgoing `session/prompt` request so the real
// apply() never sees it (and therefore never answers), then write the error
// response ourselves. No timing race, no dependence on model behaviour.
// ─────────────────────────────────────────────────────────────────────────────
test("GE-2: an upstream error frame rejects with code/data preserved and message untouched", async () => {
  const r = createOfficialAcpRouter(ctx, { provider: STUB_PROVIDER, model: STUB_MODEL });
  const stream = r._stream;
  const origInboundWrite = stream.inboundWrite;
  let promptId = null;
  stream.inboundWrite = (obj) => {
    if (obj?.method === "session/prompt") { promptId = obj.id; return; } // swallow
    return origInboundWrite(obj);
  };

  try {
    const settled = r.prompt("ge2-client-session", {
      prompt: [{ type: "text", text: "hi" }],
    }).then(
      (value) => ({ resolved: true, value }),
      (err) => ({ resolved: false, err }),
    );

    // Wait until the router has emitted its session/prompt request.
    for (let i = 0; i < 200 && promptId === null; i++) {
      await new Promise((res) => setTimeout(res, 10));
    }
    assert.ok(promptId !== null, "router never emitted session/prompt");

    // Answer it with the exact wire shape the SDK's fallback produces.
    const writer = stream.writable.getWriter();
    await writer.write({
      jsonrpc: "2.0",
      id: promptId,
      error: {
        code: -32603,
        message: "Internal error",
        data: { details: "prompt was not queued: X" },
      },
    });
    writer.releaseLock();

    const out = await settled;
    assert.equal(out.resolved, false, `expected the prompt to reject, got ${JSON.stringify(out.value)}`);
    const err = out.err;

    assert.equal(err.code, -32603, `code must be preserved, got ${JSON.stringify(err.code)}`);
    assert.equal(err.message, "Internal error", "message must pass through VERBATIM (never rewritten)");
    assert.ok(err.data, `data must be attached, got ${JSON.stringify(err.data)}`);
    assert.match(
      String(err.data.details),
      /prompt was not queued/,
      `data.details must carry the real reason, got ${JSON.stringify(err.data)}`,
    );
    assert.ok(err.errorFrame, "the raw frame must be kept for forward-compat");
    assert.equal(err.errorFrame.code, -32603);
  } finally {
    stream.inboundWrite = origInboundWrite;
    r.close();
  }
});
