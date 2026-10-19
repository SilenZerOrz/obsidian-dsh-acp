// test/notify-live-client.test.mjs — 0.3.6 regression gate for the notify
// outlet (which client long-runtime._notifyUpdate() writes sessionUpdates to).
//
// Background (commit 9462c8e, shipped in 0.3.4 + 0.3.5):
//   index.mjs pre-initializes the LongRuntime singleton at boot with a no-op
//   stub (`acpClient: { notify: async () => {} }`) because init() has to run
//   before the cordis services exist ([H1] long-mode pre-init, startLong()).
//   That pre-init sets `_initialized`, so the HTTP gateway's
//   ensureLongRuntime() early-returned and never installed its bridge-backed
//   client; _notifyUpdate() read the stub and dropped EVERY sessionUpdate.
//   Result: the proxy/long path — the Obsidian plugin's default — streamed
//   only the terminal `result` frame, so the panel looked frozen and silent.
//
// These cases pin both halves of the fix:
//   1. _notifyUpdate() prefers _liveAcpClient (per-turn client), falls back to
//      acpClient;
//   2. ensureLongRuntime() re-points a pre-initialized runtime's fallback slot
//      at a request-capable client instead of leaving the boot stub;
//   3. end-to-end: with the runtime pre-initialized exactly as index.mjs does,
//      a real gateway turn still produces >= 1 `sessionUpdate` frame.

import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { registerHttpGateway } from "../lib/http-gateway.mjs";
import { getLongRuntime, resetLongRuntime } from "../lib/long-runtime.mjs";

// --- helpers --------------------------------------------------------------

/** Capture client standing in for the boot stub / a per-turn client. */
function spyClient() {
  const sent = [];
  return {
    sent,
    async notify(method, params) { sent.push({ method, params }); },
    async request() { return null; },
  };
}

/** Boot stub, verbatim shape from index.mjs [H1] / startLong(): notify only. */
function bootStubClient() {
  return { notify: async () => {} };
}

/** Fake cordis ctx whose llm.stream() replays a scripted chunk sequence. */
function fakeCtx(chunksByTurn) {
  let turn = 0;
  return {
    llm: {
      stream(opts) {
        const seq = chunksByTurn[turn++] ?? [];
        return (async function* () {
          for (const c of seq) {
            if (opts && opts.signal && opts.signal.aborted) throw new Error("aborted");
            yield c;
          }
        })();
      },
    },
    off() {},
    on() {},
  };
}

/** Minimal webServer shim (registerHttpGateway only needs .register()). */
function makeWebServerShim() {
  const handlers = new Map();
  return {
    handlers,
    register(spec) { handlers.set(spec.path, spec.handler); },
  };
}

/** The canned turn used by both the unit and the integration case. */
const CANNED_TURN = [
  { type: "block-start", index: 0, blockType: "text" },
  { type: "text-delta", index: 0, text: "Hello " },
  { type: "text-delta", index: 0, text: "world" },
  { type: "block-end", index: 0, block: { type: "text", text: "Hello world" } },
  { type: "usage", usage: { inputTokens: 3, outputTokens: 4, totalTokens: 7 } },
  { type: "finish", reason: { kind: "stop" } },
];

// --- 1. _notifyUpdate outlet priority ------------------------------------

test("_notifyUpdate: prefers _liveAcpClient over the boot stub (H1 order)", async () => {
  resetLongRuntime();
  const rt = getLongRuntime();
  const stub = spyClient();
  await rt.init({ cordisCtx: fakeCtx([]), acpClient: stub, model: "default/m" });

  const live = spyClient();
  rt._liveAcpClient = live;
  await rt._notifyUpdate("s-live", { sessionUpdate: "agent_message_chunk" });

  assert.equal(live.sent.length, 1, "live client must receive the update");
  assert.equal(live.sent[0].method, "session/update");
  assert.equal(live.sent[0].params.sessionId, "s-live");
  assert.equal(stub.sent.length, 0, "boot stub must NOT be the outlet while a live client is installed");
  rt.dispose();
});

test("_notifyUpdate: falls back to acpClient when no live client is installed", async () => {
  resetLongRuntime();
  const rt = getLongRuntime();
  const client = spyClient();
  await rt.init({ cordisCtx: fakeCtx([]), acpClient: client, model: "default/m" });

  rt._liveAcpClient = null;
  await rt._notifyUpdate("s-fallback", { sessionUpdate: "usage_update" });

  assert.equal(client.sent.length, 1);
  assert.equal(client.sent[0].params.sessionId, "s-fallback");
  rt.dispose();
});

// --- 2. ensureLongRuntime re-points a pre-initialized fallback slot -------

test("ensureLongRuntime: pre-initialized runtime gets a request-capable fallback client", async () => {
  resetLongRuntime();
  const rt = getLongRuntime();
  await rt.init({ cordisCtx: fakeCtx([]), acpClient: bootStubClient(), model: "default/m" });

  const wsShim = makeWebServerShim();
  registerHttpGateway({ logger: { info() {}, error() {}, warn() {} } }, wsShim);

  // registerHttpGateway's warm-up is deliberately fire-and-forget (bounded to
  // 5s so it can't block plugin apply), so give ensureLongRuntime a bounded
  // moment to settle before asserting. handleSessionPrompt awaits the same
  // call on the first prompt, so this is only about test timing.
  for (let i = 0; i < 100 && typeof rt.acpClient?.request !== "function"; i++) {
    await new Promise((r) => setTimeout(r, 10));
  }

  // The bridge-backed client carries both verbs; the boot stub carried notify
  // only. This is the fix-2 assertion.
  assert.equal(typeof rt.acpClient.notify, "function");
  assert.equal(typeof rt.acpClient.request, "function");
  rt.dispose();
});

// --- 3. end-to-end: H1 pre-init order still streams sessionUpdate ---------

async function readSseText(res) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
  }
  return text;
}

test("e2e: runtime pre-initialized with the boot stub still emits >=1 sessionUpdate", async () => {
  resetLongRuntime();
  const rt = getLongRuntime();
  // Reproduce index.mjs [H1]: the singleton is initialized BEFORE the gateway
  // ever runs, with the no-op stub and the real (fake) cordis ctx.
  await rt.init({ cordisCtx: fakeCtx([CANNED_TURN]), acpClient: bootStubClient(), model: "default/m" });
  assert.equal(rt._initialized, true);

  const wsShim = makeWebServerShim();
  registerHttpGateway({ logger: { info() {}, error() {}, warn() {} } }, wsShim);

  const server = http.createServer(async (req, res) => {
    const handler = wsShim.handlers.get(req.url?.split("?")[0]);
    if (!handler) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "not found" }));
      return;
    }
    try {
      await handler(req, res);
    } catch (e) {
      if (!res.writableEnded) res.end(String(e?.message ?? e));
    }
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address();

  let text;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/acp/proxy/session/prompt`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId: "s-preinit-1", prompt: "hi", model: "default/m" }),
    });
    assert.equal(res.status, 200);
    text = await readSseText(res);
  } finally {
    await new Promise((r) => server.close(r));
    rt.dispose();
  }

  const events = text.split("\n").filter((l) => l.startsWith("event: "));
  const sessionUpdates = events.filter((l) => l.trim() === "event: sessionUpdate");
  assert.ok(
    sessionUpdates.length >= 1,
    `expected >=1 sessionUpdate frame, got ${sessionUpdates.length}\n--- SSE ---\n${text}`,
  );
  assert.match(text, /"sessionUpdate":"agent_message_chunk"/, "text stream must reach the client");
  // usage_update stays schema-valid for the Obsidian client (size = number).
  const usageMatch = text.match(/\{"sessionUpdate":"usage_update"[^}]*\}/);
  assert.ok(usageMatch, "usage_update frame expected");
  const usage = JSON.parse(usageMatch[0]);
  assert.equal(typeof usage.size, "number");
  assert.match(text, /event: result/);
});
