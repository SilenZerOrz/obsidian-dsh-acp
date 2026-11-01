// test/acp-official-router-session-c.test.mjs — #95 Session C (RED).
//
// Router-level assertions for the 4 Session C concerns, at the layer that owns
// the clientId→applyId mapping / notifier registry / per-prompt translator:
//
//   C2  detach cleanup   : forgetSession(clientId) removes the session from
//                          clientToApply + applyToClient + notifiers, so a
//                          disconnected client's map no longer leaks (and a
//                          reused clientId re-creates cleanly instead of
//                          colliding with a stale applyId).
//   C3  cross-turn       : a fresh prompt on the SAME clientId warns/behaves
//                          correctly even after a prior turn (translator is
//                          per-prompt, not reused — but that's gateway-level;
//                          here we pin the SESSION mapping lifetime).
//   C4  queue pressure   : maxSessions option caps the number of live mapped
//                          sessions; exceeding it REJECTS new sessions instead
//                          of growing the map unbounded.
//
// These methods (forgetSession / sessionCount / maxSessions) DO NOT EXIST yet
// on createOfficialAcpRouter — this test is RED by design. Session C implements
// them in lib/acp-official-router.mjs to turn it green.
//
// apply() single-flight note: prompts on this router serialize (dsh behavior).
// C2/C3/C4 don't need concurrency — they assert mapping lifetime + bounds,
// which hold under serial execution.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";

import { createOfficialAcpRouter } from "../lib/acp-official-router.mjs";
import { STUB_PROVIDER, STUB_MODEL, STUB_NOOP_TOOL, makeConcurrentToolCallStub } from "./fixtures/spike-llm-stub.mjs";
import { bootSpikeContext } from "./fixtures/spike-bootstrap.mjs";

let bootHandle;
let ctx;

before(async () => {
  bootHandle = await bootSpikeContext();
  ctx = bootHandle.ctx;
  ctx.llm.registerAdapter([STUB_PROVIDER], makeConcurrentToolCallStub());
  ctx.tools.register({ ...STUB_NOOP_TOOL });
});

after(async () => {
  await bootHandle?.dispose();
});

function makeRouter(cfg = {}) {
  return createOfficialAcpRouter(ctx, { provider: STUB_PROVIDER, model: STUB_MODEL, ...cfg });
}

test("C2 red: forgetSession(clientId) clears the session mapping on disconnect", async () => {
  const router = makeRouter();
  const sid = "client-C2";

  // Run one turn to map sid → applyId.
  await router.prompt(sid, { prompt: [{ type: "text", text: "setup" }], model: STUB_MODEL });
  const applyId = router.getApplyId(sid);
  assert.ok(applyId, "session should be mapped after a prompt");
  assert.equal(router.sessionCount(), 1, "one mapped session after one prompt");

  // Gateway calls forgetSession on client disconnect — must drop the mapping.
  router.forgetSession(sid);
  assert.equal(router.sessionCount(), 0, "forgetSession must clear the mapping");
  assert.equal(router.getApplyId(sid), undefined, "clientId no longer resolves after forgetSession");

  // Reusing the same clientId afterwards must re-create a FRESH apply mapping
  // (no stale applyId collision).
  await router.prompt(sid, { prompt: [{ type: "text", text: "reuse" }], model: STUB_MODEL });
  assert.equal(router.sessionCount(), 1, "reuse re-maps exactly one session");
  router.close();
});

test("C4 red: maxSessions caps live mapped sessions (rejects overflow)", async () => {
  const router = makeRouter({ maxSessions: 2 });

  await router.prompt("c4-a", { prompt: [{ type: "text", text: "a" }], model: STUB_MODEL });
  await router.prompt("c4-b", { prompt: [{ type: "text", text: "b" }], model: STUB_MODEL });
  assert.equal(router.sessionCount(), 2, "two sessions fit under maxSessions=2");

  // Third distinct session must be REJECTED, not silently added.
  await assert.rejects(
    router.prompt("c4-c", { prompt: [{ type: "text", text: "c" }], model: STUB_MODEL }),
    /maxSessions|too many|limit/i,
    "exceeding maxSessions must reject the new session",
  );
  assert.equal(router.sessionCount(), 2, "map must not grow past maxSessions");
  router.close();
});

test("C3 red: mapped session survives across turns (no premature drop); forgetSession is explicit", async () => {
  const router = makeRouter();
  const sid = "client-C3";

  await router.prompt(sid, { prompt: [{ type: "text", text: "turn1" }], model: STUB_MODEL });
  await router.prompt(sid, { prompt: [{ type: "text", text: "turn2" }], model: STUB_MODEL });
  // Two turns on the SAME clientId share ONE mapping (the session persists).
  assert.equal(router.sessionCount(), 1, "persistent session maps once across turns");
  const applyIdAfterTwoTurns = router.getApplyId(sid);
  assert.ok(applyIdAfterTwoTurns, "session mapping survives across turns (persistent)");
  router.close();
});
