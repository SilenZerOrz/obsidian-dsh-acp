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
