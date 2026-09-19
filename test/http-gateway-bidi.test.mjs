// test/http-gateway-bidi.test.mjs — P3.0 tool-call fix integration test.
//
// This mounts the REAL HTTP gateway (lib/http-gateway.mjs) on a real
// node:http server and drives the FULL bidirectional permission round-trip
// over actual sockets + fetch. It proves the wiring that the module-level
// unit tests cannot:
//   - handleSessionPrompt swaps rt._liveAcpClient for a per-prompt client
//   - long-runtime's request() emits an SSE "request" event
//   - handlePermissionResponse routes the reply back by sessionId+correlationId
//   - the pending Promise resolves and the turn emits "result"
//
// We reach into the long-runtime MODULE singleton and stub its prompt() to
// deterministically call _liveAcpClient.request(...) (simulating a
// permission-gated tool call), then return a normal result.

import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { registerHttpGateway } from "../lib/http-gateway.mjs";
import { getLongRuntime, resetLongRuntime } from "../lib/long-runtime.mjs";

/** Minimal webServer shim that stores handlers by exact path. */
function makeWebServerShim() {
  const handlers = new Map();
  return {
    handlers,
    register(spec) {
      handlers.set(spec.path, spec.handler);
    },
  };
}

/**
 * Mount the real gateway on a real http.Server and return { baseUrl, close }.
 * Also seeds the long-runtime singleton with a stubbed prompt() that performs
 * a permission round-trip when asked.
 *
 * @param {object} [stub] - override what the stubbed prompt() does. Default:
 *   calls rt._liveAcpClient.request("session/request_permission", ...) and
 *   records the result.
 */
async function mountGateway(stub) {
  resetLongRuntime();
  const rt = getLongRuntime();
  rt._initialized = true;
  rt.prompt = stub ?? (async ({ sessionId }) => {
    const permissionResult = await rt._liveAcpClient.request(
      "session/request_permission",
      { toolCallId: "tc1", title: "Edit" },
    );
    // Record on the singleton so the test can assert the answer reached
    // long-runtime (the round-trip's endpoint).
    rt._lastPermissionResult = permissionResult;
    return { stopReason: "end_turn", usage: { totalTokens: 5 } };
  });

  const wsShim = makeWebServerShim();
  const bridge = registerHttpGateway(
    { logger: { info() {}, error() {}, warn() {} } },
    wsShim,
  );

  const server = http.createServer(async (req, res) => {
    const handler = wsShim.handlers.get(req.url?.split("?")[0]);
    if (handler) {
      try {
        await handler(req, res);
      } catch (e) {
        if (!res.writableEnded) res.end(String(e?.message ?? e));
      }
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: false, error: "not found" }));
  });

  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;
  const close = () => new Promise((r) => server.close(r));
  return { baseUrl, close, bridge, rt };
}

/** Read the SSE stream from a fetch Response body as raw text. */
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

test("bidi: full permission round-trip over real HTTP — request → onRequest → permission-response → result", async () => {
  const { baseUrl, close, rt } = await mountGateway();

  try {
    // Spin up forwardPromptViaHttp-style client manually: read the SSE stream,
    // watch for a "request" event, answer it via a POST, continue.
    // We use fetch + a body reader to mirror lib/proxy-mode.mjs exactly.
    const fetchPromise = (async () => {
      const res = await fetch(`${baseUrl}/acp/proxy/session/prompt`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          sessionId: "sess-integ-1",
          prompt: "do a tool call",
          model: "jl-token/DeepSeek-V4-Flash",
        }),
      });
      assert.equal(res.status, 200);
      const text = await readSseText(res);
      return text;
    })();

    // We can't see the SSE text until the stream finishes, but the permission
    // request is emitted BEFORE the turn returns. To answer it, we poll the
    // bridge state — simpler: the fetch resolves once the server ends the
    // stream. But the server only ends after request() resolves, which never
    // happens until we POST. So we must POST from a parallel path.
    //
    // Route: the server's writer emitted an SSE "request" event carrying a
    // correlationId. We discover that id by inspecting the bridge's writer
    // registry (the real handlePermissionResponse would too).
    const sseTextPromise = fetchPromise;

    // Wait for the writer to be attached and for a pending request to appear.
    // This is the real server-side state transition the client would trigger.
    const writer = await waitForRequestEvent(rt, 5000);

    // Client-side simulation: at this point lib/proxy-mode.mjs would have:
    //   1. seen the SSE "request" event with correlationId
    //   2. called onRequest → got { outcome: { optionId: "allow_once" } }
    //   3. POSTed to /acp/proxy/permission-response with ok=true
    const reply = await fetch(`${baseUrl}/acp/proxy/permission-response`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ok: true,
        sessionId: "sess-integ-1",
        correlationId: writer._observedCorrelationId,
        result: { outcome: { optionId: "allow_once" } },
      }),
    });
    const replyJson = await reply.json();
    assert.equal(replyJson.ok, true, "server should acknowledge the permission reply");

    // Now the turn resolves and the stream ends with a "result" event.
    const sseText = await sseTextPromise;
    assert.match(sseText, /event: request\n/);
    assert.match(sseText, /correlationId/, "SSE request event must carry correlationId");
    assert.match(sseText, /event: result\n/);

    // Confirm the permission result actually reached the stubbed prompt()'s
    // request() call — the tool call was allowed and the turn completed.
    assert.deepEqual(
      rt._lastPermissionResult,
      { outcome: { optionId: "allow_once" } },
      "long-runtime must receive the answered permission result",
    );
    assert.match(sseText, /stopReason.*end_turn/);
  } finally {
    await close();
    resetLongRuntime();
  }
});

test("bidi: onRequest error → permission-response with ok=false → request() rejects → turn errors", async () => {
  const { baseUrl, close, rt } = await mountGateway(async ({ sessionId }) => {
    try {
      await rt._liveAcpClient.request("session/request_permission", { toolCallId: "tcX" });
      return { stopReason: "end_turn", usage: {}, _never: true };
    } catch (e) {
      // request() rejected — surface as a turn error.
      throw new Error(`permission flow rejected: ${e?.message ?? e}`);
    }
  });

  try {
    const fetchPromise = (async () => {
      const res = await fetch(`${baseUrl}/acp/proxy/session/prompt`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionId: "sess-integ-2", prompt: "x", model: "m" }),
      });
      const text = await readSseText(res);
      return text;
    })();

    const writer = await waitForRequestEvent(rt, 5000);
    await fetch(`${baseUrl}/acp/proxy/permission-response`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ok: false,
        sessionId: "sess-integ-2",
        correlationId: writer._observedCorrelationId,
        error: "user denied",
      }),
    });

    const sseText = await fetchPromise;
    // Turn should have errored (prompt threw because request() rejected).
    assert.match(sseText, /event: error\n/);
    assert.match(sseText, /user denied|permission flow rejected/);
  } finally {
    await close();
    resetLongRuntime();
  }
});

// =====================================================================
// Phase E (2026-09-18): AbortSignal-aware SseWriter + bidi abort paths
// =====================================================================
//
// Without these tests, a silent Obsidian Agent Client could strand the
// SseWriter._pendingRequests Map forever. The emitRequest signal arg +
// the matching client-side abortOnSignal in proxy-mode.mjs are what close
// the loop. These tests lock the contract end-to-end.

import { SseWriter } from "../lib/http-gateway.mjs";

/** Fake http.ServerResponse shim — SseWriter only calls .write(). */
function makeFakeRes() {
  return { write: () => true };
}

test("SseWriter.emitRequest: signal abort mid-flight rejects with AbortError and removes the entry", async () => {
  const writer = new SseWriter(makeFakeRes());
  const ctl = new AbortController();
  const p = writer.emitRequest("session/request_permission", { toolCallId: "tc" }, ctl.signal);
  assert.equal(writer._pendingRequests.size, 1, "pending entry registered");
  ctl.abort();
  await assert.rejects(p, (err) => err && err.name === "AbortError");
  assert.equal(writer._pendingRequests.size, 0, "abort must remove the pending entry");
});

test("SseWriter.emitRequest: pre-aborted signal rejects without registering an entry", async () => {
  const writer = new SseWriter(makeFakeRes());
  const ctl = new AbortController();
  ctl.abort();
  await assert.rejects(
    writer.emitRequest("session/request_permission", {}, ctl.signal),
    (err) => err && err.name === "AbortError",
  );
  assert.equal(writer._pendingRequests.size, 0, "pre-aborted must NOT register a pending entry");
});

test("SseWriter.emitRequest: success resolves and removes the entry (listener cleanup)", async () => {
  const writer = new SseWriter(makeFakeRes());
  const ctl = new AbortController();
  const p = writer.emitRequest("session/request_permission", {}, ctl.signal);
  assert.equal(writer._pendingRequests.size, 1);
  // Grab the correlationId from the registered entry.
  const correlationId = writer._pendingRequests.keys().next().value;
  writer.resolveRequest(correlationId, { ok: true, result: { outcome: "allow_once" } });
  const result = await p;
  assert.deepEqual(result, { outcome: "allow_once" });
  assert.equal(writer._pendingRequests.size, 0, "success branch removes the entry");
  // Trigger abort — should NOT raise an unhandled rejection (listener gone).
  ctl.abort();
});

test("SseWriter.emitRequest: failure (ok:false) removes the entry and rejects", async () => {
  const writer = new SseWriter(makeFakeRes());
  const ctl = new AbortController();
  const p = writer.emitRequest("session/request_permission", {}, ctl.signal);
  const correlationId = writer._pendingRequests.keys().next().value;
  writer.resolveRequest(correlationId, { ok: false, error: "user said no" });
  await assert.rejects(p, /user said no/);
  assert.equal(writer._pendingRequests.size, 0);
  ctl.abort(); // listener cleanup verification — no unhandled rejection
});

test("SseWriter.rejectAllPending: clears _pendingRequests and rejects all", async () => {
  const writer = new SseWriter(makeFakeRes());
  const p1 = writer.emitRequest("session/request_permission", {});
  const p2 = writer.emitRequest("session/request_permission", {});
  assert.equal(writer._pendingRequests.size, 2);
  writer.rejectAllPending("writer going away");
  await assert.rejects(p1, /writer going away/);
  await assert.rejects(p2, /writer going away/);
  assert.equal(writer._pendingRequests.size, 0);
});

test("SseWriter.emitRequest: abort then late-arriving reply is a no-op (404 path is the consumer's job)", async () => {
  const writer = new SseWriter(makeFakeRes());
  const ctl = new AbortController();
  const p = writer.emitRequest("session/request_permission", {}, ctl.signal);
  const correlationId = writer._pendingRequests.keys().next().value;
  ctl.abort();
  await assert.rejects(p, (e) => e.name === "AbortError");
  // Late reply — should resolve to false (no entry to find). This mirrors
  // what handlePermissionResponse would see at the HTTP layer.
  assert.equal(writer.resolveRequest(correlationId, { ok: true, result: "ignored" }), false);
});

/**
 * Poll the long-runtime's registered per-prompt client to discover when an
 * SSE "request" has been emitted, and capture its correlationId. This mirrors
 * what handlePermissionResponse observes through the bridge, but reaches the
 * writer's pending-request registry directly (faster + socket-independent).
 *
 * @returns {Promise<{ _observedCorrelationId: string }>}
 */
function waitForRequestEvent(_rt, timeoutMs) {
  // The server-side writer holds _pendingRequests keyed by correlationId.
  // We look it up from the bridge... but the bridge isn't exposed here. We
  // reconstruct it by finding the writer via the singleton's live client is
  // not possible (per-prompt). Instead we intercept by probing the SSE text
  // won't work (needs the POST first — deadlock).
  //
  // Cleanest: expose the correlationId by having the stubbed prompt() record
  // it. The writer's emitRequest pushes to _pendingRequests; we can't reach
  // it. So we discover the correlationId FROM the emitted SSE payload.
  //
  // Approach: wrap a second connection? No — instead, we read the SSE stream
  // incrementally WITHOUT blocking the POST. We do that by capturing the raw
  // HTTP response stream and scanning for the "request" line.
  //
  // Since we can't easily scan-in-flight here without a real client, this
  // helper instead just resolves with a poller that the caller drives. To
  // keep the test robust and simple, we reimplement the discovery by peeking
  // at the writer set via the singleton's _liveAcpClient — which the real
  // handleSessionPrompt swapped into the stub. That client's writer is the
  // one that holds the pending request.
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const poll = () => {
      const cli = _rt._liveAcpClient;
      if (cli && cli._writer && cli._writer._pendingRequests?.size > 0) {
        const correlationId = cli._writer._pendingRequests.keys().next().value;
        return resolve({ _observedCorrelationId: correlationId });
      }
      if (Date.now() - t0 > timeoutMs) {
        return reject(new Error("timeout waiting for permission request"));
      }
      setTimeout(poll, 10);
    };
    poll();
  });
}
