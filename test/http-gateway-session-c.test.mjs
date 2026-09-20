// test/http-gateway-session-c.test.mjs — #95 Session C, C1 (RED then green).
//
// ERROR PROPAGATION at the gateway layer. apply() single-flights all prompts on
// one router (dsh behavior), and the router's single drain loop + pending map
// are SHARED across sessions. The Session C risk: a session whose prompt errors
// could leave the shared router state dirty and poison a later session's prompt.
//
// C1 drives ONE shared gateway/router with TWO HTTP prompts on the same
// provider — session A's prompt text contains "boom" (FailingLlmAdapter throws
// mid-turn), session B's is normal:
//   - A's SSE writer receives an `error` event.
//   - B's SSE writer (a DIFFERENT writer, same router) still completes with a
//     `result` + sessionUpdate and NO error.
// That proves one session's failure is contained to its own writer and does not
// wedge the shared router for a subsequent session.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";

import { registerHttpGateway } from "../lib/http-gateway.mjs";
import { FAIL_PROVIDER, FAIL_MODEL, makeFailingStub } from "./fixtures/spike-llm-stub.mjs";
import { bootSpikeContext } from "./fixtures/spike-bootstrap.mjs";

let bootHandle;
let ctx;

before(async () => {
  bootHandle = await bootSpikeContext();
  ctx = bootHandle.ctx;
  ctx.llm.registerAdapter([FAIL_PROVIDER], makeFailingStub());
});

after(async () => {
  await bootHandle?.dispose();
});

function makeMockWebServer() {
  const handlers = new Map();
  return { handlers, register: (spec) => handlers.set(spec.path, spec.handler) };
}

function makeMockReqRes({ body = "" } = {}) {
  const req = Object.assign(new EventEmitter(), { method: "POST", headers: {}, destroy: () => {} });
  const writes = [];
  const res = {
    writeHead() {},
    write(chunk) { writes.push(String(chunk)); },
    end(chunk) {
      if (chunk !== undefined) writes.push(String(chunk));
      req.emit("__res_ended__");
    },
  };
  queueMicrotask(() => {
    if (body) req.emit("data", Buffer.from(body));
    req.emit("end");
  });
  return { req, res, writes };
}

function parseSse(writes) {
  const out = [];
  let cur = null;
  for (const w of writes) {
    for (const line of w.split("\n")) {
      if (line.startsWith("event: ")) cur = { event: line.slice(7), data: null };
      else if (line.startsWith("data: ") && cur) { cur.data = JSON.parse(line.slice(6)); out.push(cur); cur = null; }
    }
  }
  return out;
}

async function drive(handler, sessionId, text) {
  const body = JSON.stringify({ sessionId, prompt: [{ type: "text", text }] });
  const { req, res, writes } = makeMockReqRes({ body });
  const ended = new Promise((r) => req.on("__res_ended__", r));
  await handler(req, res);
  await Promise.race([ended, new Promise((_, rej) => setTimeout(() => rej(new Error("SSE never ended")), 30000))]);
  return parseSse(writes);
}

test("C1: one session's prompt error is contained to its writer; a later session on the same router still succeeds", async () => {
  const ws = makeMockWebServer();
  registerHttpGateway(ctx, ws, {
    officialEnabled: true,
    officialMountConfig: { provider: FAIL_PROVIDER, model: FAIL_MODEL },
  });
  const promptHandler = ws.handlers.get("/acp/proxy/session/prompt");
  assert.ok(promptHandler, "prompt route should be registered");

  // Session A: text says "boom" → FailingLlmAdapter.stream throws mid-turn.
  const eventsA = await drive(promptHandler, "sess-C1-A", "boom now");
  const errorsA = eventsA.filter((e) => e.event === "error");
  assert.ok(errorsA.length >= 1, `session A should error; got events: ${JSON.stringify(eventsA.map((e) => e.event))}`);
  // The error must carry A's OWN failure (the boom), not some shared/collapsed
  // error — proving the router routed the failure precisely to A's writer.
  const aErrMsg = errorsA.map((e) => e.data?.message ?? "").join(" ");
  assert.match(aErrMsg, /boom/, `A's error should name its own failing turn; got: "${aErrMsg}"`);
  assert.equal(
    eventsA.some((e) => e.event === "result"),
    false,
    `A must NOT emit a result (it failed); got ${JSON.stringify(eventsA.map((e) => e.event))}`,
  );

  // Session B: normal text on the SAME router → must still complete successfully.
  const eventsB = await drive(promptHandler, "sess-C1-B", "ok proceed");
  const errorsB = eventsB.filter((e) => e.event === "error");
  const resultsB = eventsB.filter((e) => e.event === "result");
  assert.equal(errorsB.length, 0, `session B must NOT error (A's failure leaked); got ${JSON.stringify(eventsB.map((e) => e.event))}`);
  assert.equal(resultsB.length, 1, `session B should produce one result; got ${JSON.stringify(eventsB.map((e) => e.event))}`);
  assert.ok(eventsB.some((e) => e.event === "sessionUpdate"), "session B should stream sessionUpdate frames");
});
