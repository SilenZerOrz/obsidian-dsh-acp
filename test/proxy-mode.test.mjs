// test/proxy-mode.test.mjs — node:test unit tests for lib/proxy-mode.mjs
//
// 覆盖范围:
//   - PROXY_DEFAULT_BASE_URL / getProxyBaseUrl() env 覆盖
//   - shouldAttemptProxy() 三态(env 缺省 / opt-out / opt-in)
//   - probeDshWebGateway() — fetch mock,返回 ok/version/mode/longReady
//   - probeDshWebGateway() — 超时与连接拒绝 fallback
//   - parseSseBuffer() 单元:解析单事件 + 多事件 + partial remainder
//   - forwardPromptViaHttp() — fetch mock:sessionUpdate 回调 + result 返回
//   - forwardPromptViaHttp() — error SSE 抛错
//   - forwardPromptViaHttp() — 外部 abort signal 传递

import test from "node:test";
import assert from "node:assert/strict";
import {
  PROXY_DEFAULT_BASE_URL,
  PROBE_TIMEOUT_MS,
  PROMPT_TIMEOUT_MS,
  getProxyBaseUrl,
  shouldAttemptProxy,
  probeDshWebGateway,
  parseSseBuffer,
  forwardPromptViaHttp,
} from "../lib/proxy-mode.mjs";

// --- Constants ------------------------------------------------------------

test("PROXY_DEFAULT_BASE_URL is http://127.0.0.1:3080 (matches launchd dsh-web plist port)", () => {
  assert.equal(PROXY_DEFAULT_BASE_URL, "http://127.0.0.1:3080");
});

test("PROBE_TIMEOUT_MS is short (2s)", () => {
  assert.equal(PROBE_TIMEOUT_MS, 2000);
});

test("PROMPT_TIMEOUT_MS is long (10min)", () => {
  assert.equal(PROMPT_TIMEOUT_MS, 600000);
});

// --- getProxyBaseUrl ------------------------------------------------------

test("getProxyBaseUrl: returns env override when set", () => {
  process.env.DSH_ACP_HTTP_GATEWAY_URL = "http://localhost:3000";
  try {
    assert.equal(getProxyBaseUrl(), "http://localhost:3000");
  } finally {
    delete process.env.DSH_ACP_HTTP_GATEWAY_URL;
  }
});

test("getProxyBaseUrl: returns default when env unset", () => {
  delete process.env.DSH_ACP_HTTP_GATEWAY_URL;
  assert.equal(getProxyBaseUrl(), PROXY_DEFAULT_BASE_URL);
});

// --- shouldAttemptProxy ---------------------------------------------------

test("shouldAttemptProxy: default (no env) opts in", () => {
  delete process.env.DSH_ACP_PROXY_MODE;
  assert.equal(shouldAttemptProxy(), true);
});

test("shouldAttemptProxy: 'false' / '0' / 'no' opt out", () => {
  for (const v of ["false", "0", "no"]) {
    process.env.DSH_ACP_PROXY_MODE = v;
    assert.equal(shouldAttemptProxy(), false, `expected ${v} to opt out`);
  }
});

test("shouldAttemptProxy: 'true' / other values opt in", () => {
  for (const v of ["true", "1", "yes", "weird"]) {
    process.env.DSH_ACP_PROXY_MODE = v;
    assert.equal(shouldAttemptProxy(), true, `expected ${v} to opt in`);
  }
});

// --- parseSseBuffer -------------------------------------------------------

test("parseSseBuffer: single event", () => {
  const { events, remainder } = parseSseBuffer("event: hello\ndata: {\"x\":1}\n\n");
  assert.equal(events.length, 1);
  assert.equal(events[0].event, "hello");
  assert.equal(events[0].data, "{\"x\":1}");
  assert.equal(remainder, "");
});

test("parseSseBuffer: multiple events separated by blank lines", () => {
  const buf =
    "event: a\ndata: 1\n\nevent: b\ndata: 2\n\nevent: c\ndata: 3\n\n";
  const { events, remainder } = parseSseBuffer(buf);
  assert.equal(events.length, 3);
  assert.equal(events[0].event, "a");
  assert.equal(events[0].data, "1");
  assert.equal(events[1].event, "b");
  assert.equal(events[2].event, "c");
  assert.equal(remainder, "");
});

test("parseSseBuffer: partial trailing event kept in remainder", () => {
  const buf = "event: a\ndata: 1\n\nevent: partial\n";
  const { events, remainder } = parseSseBuffer(buf);
  assert.equal(events.length, 1);
  assert.equal(events[0].event, "a");
  assert.equal(remainder, "event: partial\n");
});

test("parseSseBuffer: lines without 'data:' are silently dropped (keepalive)", () => {
  const buf = ": keepalive\n\nevent: a\ndata: {\"x\":1}\n\n";
  const { events, remainder } = parseSseBuffer(buf);
  assert.equal(events.length, 1);
  assert.equal(events[0].event, "a");
  assert.equal(remainder, "");
});

test("parseSseBuffer: empty input → no events, empty remainder", () => {
  const { events, remainder } = parseSseBuffer("");
  assert.equal(events.length, 0);
  assert.equal(remainder, "");
});

// --- probeDshWebGateway (with fetch mock) --------------------------------

/**
 * Replace global fetch with a stub for the duration of a single test.
 * Returns a setter that lets the test pick the response per call.
 */
function withMockFetch(handler) {
  const original = globalThis.fetch;
  globalThis.fetch = handler;
  return () => { globalThis.fetch = original; };
}

test("probeDshWebGateway: ok=true parses body fields", async () => {
  const restore = withMockFetch(async () =>
    new Response(JSON.stringify({ ok: true, version: "0.2.6-dev", mode: "long", longReady: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  );
  try {
    const r = await probeDshWebGateway("http://example.test");
    assert.equal(r.ok, true);
    assert.equal(r.version, "0.2.6-dev");
    assert.equal(r.mode, "long");
    assert.equal(r.longReady, true);
    assert.equal(r._baseUrl, "http://example.test");
  } finally {
    restore();
  }
});

test("probeDshWebGateway: ok=true but mode=spawn-hint still ok", async () => {
  const restore = withMockFetch(async () =>
    new Response(JSON.stringify({ ok: true, mode: "spawn-hint", longReady: false }), { status: 200 }),
  );
  try {
    const r = await probeDshWebGateway();
    assert.equal(r.ok, true);
    assert.equal(r.mode, "spawn-hint");
    assert.equal(r.longReady, false);
  } finally {
    restore();
  }
});

test("probeDshWebGateway: HTTP 500 → ok=false reason=http-500", async () => {
  const restore = withMockFetch(async () => new Response("oops", { status: 500 }));
  try {
    const r = await probeDshWebGateway();
    assert.equal(r.ok, false);
    assert.equal(r.reason, "http-500");
  } finally {
    restore();
  }
});

test("probeDshWebGateway: connection refused → ok=false reason=...refused", async () => {
  const restore = withMockFetch(async () => {
    throw new TypeError("fetch failed ECONNREFUSED 127.0.0.1:1");
  });
  try {
    const r = await probeDshWebGateway("http://127.0.0.1:1");
    assert.equal(r.ok, false);
    assert.match(r.reason, /ECONNREFUSED/);
  } finally {
    restore();
  }
});

test("probeDshWebGateway: malformed JSON body → ok=false reason=probe-body-invalid", async () => {
  const restore = withMockFetch(async () => new Response("not-json", { status: 200 }));
  try {
    const r = await probeDshWebGateway();
    assert.equal(r.ok, false);
    // Response.json() will throw — wrapped as probe-body-invalid
    assert.match(r.reason, /probe-body-invalid|JSON/);
  } finally {
    restore();
  }
});

// --- forwardPromptViaHttp (with fetch mock) -------------------------------

/**
 * Build a fake Response whose body streams the given SSE chunks. Each chunk
 * is encoded as UTF-8 and pushed via ReadableStream.
 *
 * @param {string[]} chunks
 */
function sseResponse(chunks, status = 200) {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      for (const c of chunks) controller.enqueue(encoder.encode(c));
      controller.close();
    },
  });
  return new Response(stream, { status, headers: { "content-type": "text/event-stream" } });
}

test("forwardPromptViaHttp: forwards sessionUpdate + resolves with result envelope", async () => {
  const sse =
    "event: sessionUpdate\n" +
    "data: {\"method\":\"session/update\",\"params\":{\"sessionUpdate\":\"agent_message_chunk\",\"content\":{\"type\":\"text\",\"text\":\"hello \"}}}\n\n" +
    "event: sessionUpdate\n" +
    "data: {\"method\":\"session/update\",\"params\":{\"sessionUpdate\":\"agent_message_chunk\",\"content\":{\"type\":\"text\",\"text\":\"world\"}}}\n\n" +
    "event: result\n" +
    "data: {\"stopReason\":\"end_turn\",\"usage\":{\"totalTokens\":42,\"inputTokens\":10,\"outputTokens\":32}}\n\n";

  const restore = withMockFetch(async () => sseResponse([sse]));
  try {
    const updates = [];
    const result = await forwardPromptViaHttp({
      baseUrl: "http://example.test",
      sessionId: "sess-1",
      prompt: "hello world",
      onUpdate: (method, params) => {
        updates.push({ method, params });
      },
    });
    assert.equal(updates.length, 2);
    assert.equal(updates[0].params.content.text, "hello ");
    assert.equal(updates[1].params.content.text, "world");
    assert.equal(result.stopReason, "end_turn");
    assert.equal(result.usage.totalTokens, 42);
  } finally {
    restore();
  }
});

test("forwardPromptViaHttp: error SSE event throws", async () => {
  const sse =
    "event: sessionUpdate\n" +
    "data: {\"method\":\"session/update\",\"params\":{\"sessionUpdate\":\"agent_message_chunk\",\"content\":{\"type\":\"text\",\"text\":\"hi\"}}}\n\n" +
    "event: error\n" +
    "data: {\"message\":\"long-runtime init failed\"}\n\n";

  const restore = withMockFetch(async () => sseResponse([sse]));
  try {
    await assert.rejects(
      forwardPromptViaHttp({
        baseUrl: "http://example.test",
        sessionId: "sess-1",
        prompt: "x",
        onUpdate: () => {},
      }),
      /long-runtime init failed/,
    );
  } finally {
    restore();
  }
});

test("forwardPromptViaHttp: HTTP 503 throws", async () => {
  const restore = withMockFetch(async () => new Response("boom", { status: 503 }));
  try {
    await assert.rejects(
      forwardPromptViaHttp({
        baseUrl: "http://example.test",
        sessionId: "sess-1",
        prompt: "x",
        onUpdate: () => {},
      }),
      /prompt http 503/,
    );
  } finally {
    restore();
  }
});

test("forwardPromptViaHttp: stream ends without result → graceful end_turn", async () => {
  const sse = "event: sessionUpdate\ndata: {\"method\":\"session/update\",\"params\":{\"x\":1}}\n\n";
  const restore = withMockFetch(async () => sseResponse([sse]));
  try {
    const result = await forwardPromptViaHttp({
      baseUrl: "http://example.test",
      sessionId: "sess-1",
      prompt: "x",
      onUpdate: () => {},
    });
    assert.equal(result.stopReason, "end_turn");
  } finally {
    restore();
  }
});

test("forwardPromptViaHttp: pre-aborted signal aborts immediately", async () => {
  // Real fetch mock that honors AbortSignal like native fetch.
  const restore = withMockFetch(async (_url, init = {}) => {
    if (init.signal?.aborted) {
      const e = new Error("aborted");
      e.name = "AbortError";
      throw e;
    }
    return new Response("x", { status: 200 });
  });
  try {
    const ctl = new AbortController();
    ctl.abort();
    await assert.rejects(
      forwardPromptViaHttp({
        baseUrl: "http://example.test",
        sessionId: "sess-1",
        prompt: "x",
        onUpdate: () => {},
        signal: ctl.signal,
      }),
      /aborted|abort/i,
    );
  } finally {
    restore();
  }
});

// --- forwardPromptViaHttp SSE "request" event (P3.0 tool-call fix) ------

test("forwardPromptViaHttp: SSE 'request' event forwards to onRequest + POSTs reply to /acp/proxy/permission-response", async () => {
  // Server-side story:
  //   1. Emit one sessionUpdate (LLM said "hi")
  //   2. Emit one "request" event (long-runtime needs permission)
  //   3. Expect the proxy client to POST to /acp/proxy/permission-response
  //   4. After the POST, the server (this mock) emits "result" and closes
  //
  // We model the mock fetch to inspect /acp/proxy/permission-response and
  // route the SECOND fetch call there; the FIRST is the prompt stream itself.
  let fetchCallIndex = 0;
  const observedPermissionBodies = [];
  const restore = withMockFetch(async (url, init = {}) => {
    fetchCallIndex++;
    if (url.endsWith("/acp/proxy/session/prompt")) {
      // The session-update + permission request + result stream.
      const sse =
        "event: sessionUpdate\n" +
        "data: {\"method\":\"session/update\",\"params\":{\"x\":1}}\n\n" +
        "event: request\n" +
        "data: {\"correlationId\":\"req-test-1\",\"method\":\"session/request_permission\",\"params\":{\"toolCallId\":\"tc1\"}}\n\n" +
        "event: result\n" +
        "data: {\"stopReason\":\"end_turn\",\"usage\":{\"totalTokens\":1,\"inputTokens\":1,\"outputTokens\":0}}\n\n";
      return sseResponse([sse]);
    }
    if (url.endsWith("/acp/proxy/permission-response")) {
      observedPermissionBodies.push(JSON.parse(init.body));
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    throw new Error("unexpected fetch: " + url);
  });
  try {
    const updates = [];
    let onRequestCalled = null;
    const result = await forwardPromptViaHttp({
      baseUrl: "http://example.test",
      sessionId: "sess-1",
      prompt: "x",
      onUpdate: (method, params) => updates.push({ method, params }),
      onRequest: async (method, params) => {
        onRequestCalled = { method, params };
        return { outcome: { outcome: "selected", optionId: "allow_once" } };
      },
    });
    // sessionUpdate was forwarded
    assert.equal(updates.length, 1);
    assert.equal(updates[0].params.x, 1);
    // onRequest was invoked with the server's method + params
    assert.deepEqual(onRequestCalled, {
      method: "session/request_permission",
      params: { toolCallId: "tc1" },
    });
    // The reply POST carried ok=true + the result + the correlationId
    assert.equal(observedPermissionBodies.length, 1);
    assert.deepEqual(observedPermissionBodies[0], {
      ok: true,
      sessionId: "sess-1",
      correlationId: "req-test-1",
      result: { outcome: { outcome: "selected", optionId: "allow_once" } },
    });
    // Result envelope resolved
    assert.equal(result.stopReason, "end_turn");
  } finally {
    restore();
  }
});

test("forwardPromptViaHttp: onRequest throwing → POST reply with ok=false + error", async () => {
  const observedPermissionBodies = [];
  const restore = withMockFetch(async (url, init = {}) => {
    if (url.endsWith("/acp/proxy/session/prompt")) {
      const sse =
        "event: request\n" +
        "data: {\"correlationId\":\"req-x\",\"method\":\"session/request_permission\",\"params\":{}}\n\n" +
        "event: result\n" +
        "data: {\"stopReason\":\"end_turn\",\"usage\":{\"totalTokens\":0}}\n\n";
      return sseResponse([sse]);
    }
    if (url.endsWith("/acp/proxy/permission-response")) {
      observedPermissionBodies.push(JSON.parse(init.body));
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    }
    throw new Error("unexpected fetch: " + url);
  });
  try {
    await forwardPromptViaHttp({
      baseUrl: "http://example.test",
      sessionId: "sess-1",
      prompt: "x",
      onUpdate: () => {},
      onRequest: async () => {
        throw new Error("no ACP client available");
      },
    });
    assert.equal(observedPermissionBodies.length, 1);
    assert.equal(observedPermissionBodies[0].ok, false);
    assert.match(observedPermissionBodies[0].error, /no ACP client available/);
  } finally {
    restore();
  }
});

test("forwardPromptViaHttp: missing onRequest + 'request' event → reply with default error", async () => {
  const observedPermissionBodies = [];
  const restore = withMockFetch(async (url, init = {}) => {
    if (url.endsWith("/acp/proxy/session/prompt")) {
      const sse =
        "event: request\n" +
        "data: {\"correlationId\":\"req-y\",\"method\":\"session/request_permission\",\"params\":{}}\n\n" +
        "event: result\n" +
        "data: {\"stopReason\":\"end_turn\",\"usage\":{\"totalTokens\":0}}\n\n";
      return sseResponse([sse]);
    }
    if (url.endsWith("/acp/proxy/permission-response")) {
      observedPermissionBodies.push(JSON.parse(init.body));
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    }
    throw new Error("unexpected fetch: " + url);
  });
  try {
    await forwardPromptViaHttp({
      baseUrl: "http://example.test",
      sessionId: "sess-1",
      prompt: "x",
      onUpdate: () => {},
      // onRequest intentionally omitted — proxy should still gracefully reply.
    });
    assert.equal(observedPermissionBodies.length, 1);
    assert.equal(observedPermissionBodies[0].ok, false);
    assert.match(observedPermissionBodies[0].error, /no onRequest handler/);
  } finally {
    restore();
  }
});

test("forwardPromptViaHttp: SSE 'request' missing correlationId logs and skips POST", async () => {
  let fetchCalls = 0;
  const restore = withMockFetch(async (url) => {
    fetchCalls++;
    if (url.endsWith("/acp/proxy/session/prompt")) {
      const sse =
        "event: request\n" +
        "data: {\"method\":\"session/request_permission\",\"params\":{}}\n\n" +
        "event: result\n" +
        "data: {\"stopReason\":\"end_turn\",\"usage\":{\"totalTokens\":0}}\n\n";
      return sseResponse([sse]);
    }
    throw new Error("should not have made a permission-response POST: " + url);
  });
  try {
    await forwardPromptViaHttp({
      baseUrl: "http://example.test",
      sessionId: "sess-1",
      prompt: "x",
      onUpdate: () => {},
      onRequest: async () => ({ outcome: { outcome: "selected", optionId: "allow_once" } }),
    });
    assert.equal(fetchCalls, 1, "only the prompt fetch should fire");
  } finally {
    restore();
  }
});

// =====================================================================
// Phase E (2026-09-18): abort-signal tests for handleServerRequest
// =====================================================================
//
// Without these, a silent Obsidian Agent Client would strand the server's
// pending Promise: the outer 10-minute PROMPT_TIMEOUT_MS would abort the
// fetch but never tell the server "the user cancelled". Phase D threads
// AbortSignal through handleServerRequest; the tests below lock the
// contract:
//   - abort mid-flight → POST {ok:false, error:"aborted: …"} within ms
//   - abort BEFORE onRequest fires → POST {ok:false, error:"aborted"} and
//     onRequest is NEVER invoked
//   - onRequest throwing vs aborting are distinguishable in the POST body

test("forwardPromptViaHttp: handleServerRequest abort mid-flight → POST ok=false with 'aborted:' prefix", async () => {
  const observedPermissionBodies = [];
  const restore = withMockFetch(async (url, init = {}) => {
    if (url.endsWith("/acp/proxy/session/prompt")) {
      const sse =
        "event: request\n" +
        "data: {\"correlationId\":\"req-abort-1\",\"method\":\"session/request_permission\",\"params\":{}}\n\n" +
        "event: result\n" +
        "data: {\"stopReason\":\"end_turn\",\"usage\":{\"totalTokens\":0}}\n\n";
      return sseResponse([sse]);
    }
    if (url.endsWith("/acp/proxy/permission-response")) {
      observedPermissionBodies.push(JSON.parse(init.body));
      return new Response("{}", { status: 200 });
    }
    throw new Error("unexpected fetch: " + url);
  });
  const ctl = new AbortController();
  let onRequestInvoked = false;
  // Fire the abort AFTER the SSE 'request' event has reached
  // handleServerRequest and onRequest is mid-flight. Two ticks covers it.
  setTimeout(() => ctl.abort(), 20);
  try {
    await forwardPromptViaHttp({
      baseUrl: "http://example.test",
      sessionId: "sess-1",
      prompt: "x",
      onUpdate: () => {},
      onRequest: async () => {
        onRequestInvoked = true;
        // Never resolves — relies on abort to free us.
        return new Promise(() => {});
      },
      signal: ctl.signal,
    });
    // After the abort sequence, the reply must have been POSTed.
    assert.equal(observedPermissionBodies.length, 1, "one permission-response POST");
    assert.equal(observedPermissionBodies[0].ok, false);
    assert.equal(observedPermissionBodies[0].correlationId, "req-abort-1");
    assert.match(observedPermissionBodies[0].error, /^aborted:/);
    assert.equal(onRequestInvoked, true, "onRequest was invoked once before the abort");
  } finally {
    if (!ctl.signal.aborted) ctl.abort();
    restore();
  }
});

test("forwardPromptViaHttp: pre-aborted signal before 'request' event → POST ok=false without invoking onRequest", async () => {
  const observedPermissionBodies = [];
  let promptFetchCalled = false;
  // Block the prompt fetch on a controller so we can abort between connect
  // and the SSE 'request' event reaching the client.
  let abortPromptStream;
  const restore = withMockFetch(async (url, init = {}) => {
    if (url.endsWith("/acp/proxy/session/prompt")) {
      promptFetchCalled = true;
      // Stream that yields the 'request' event only after the test signals.
      const encoder = new TextEncoder();
      const stream = new ReadableStream({
        start(controller) {
          abortPromptStream = () => {
            controller.enqueue(
              encoder.encode(
                "event: request\n" +
                  "data: {\"correlationId\":\"req-pre\",\"method\":\"session/request_permission\",\"params\":{}}\n\n" +
                  "event: result\n" +
                  "data: {\"stopReason\":\"end_turn\",\"usage\":{\"totalTokens\":0}}\n\n",
              ),
            );
            controller.close();
          };
        },
      });
      return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
    }
    if (url.endsWith("/acp/proxy/permission-response")) {
      observedPermissionBodies.push(JSON.parse(init.body));
      return new Response("{}", { status: 200 });
    }
    throw new Error("unexpected fetch: " + url);
  });

  const ctl = new AbortController();
  const onRequest = async () => {
    throw new Error("onRequest MUST NOT be invoked when signal is pre-aborted");
  };
  const forwardPromise = forwardPromptViaHttp({
    baseUrl: "http://example.test",
    sessionId: "sess-1",
    prompt: "x",
    onUpdate: () => {},
    onRequest,
    signal: ctl.signal,
  });

  // Abort before the SSE 'request' event is delivered.
  ctl.abort();
  // Now deliver the SSE — the handleServerRequest path will see the
  // aborted signal and short-circuit.
  abortPromptStream?.();

  try {
    await forwardPromise;
    assert.equal(observedPermissionBodies.length, 1, "POST fired with abort error");
    assert.equal(observedPermissionBodies[0].ok, false);
    assert.equal(observedPermissionBodies[0].correlationId, "req-pre");
    assert.match(observedPermissionBodies[0].error, /aborted/);
  } finally {
    if (!promptFetchCalled) ctl.abort();
    restore();
  }
});

test("forwardPromptViaHttp: abort BEFORE forwardPromptViaHttp starts → fetch's signal is already aborted", async () => {
  // fetch() in node honors the signal: with an aborted signal it rejects
  // with an AbortError WITHOUT actually dispatching the request. The mock
  // here simulates that by rejecting with the same shape. The pre-aborted
  // signal still reaches fetch (the proxy's internal ctl propagates), but
  // the network request is never made — that's what matters here.
  const restore = withMockFetch(async (url, init = {}) => {
    if (init?.signal?.aborted) {
      const e = new Error("This operation was aborted");
      e.name = "AbortError";
      throw e;
    }
    throw new Error("fetch should NOT have fired: signal was pre-aborted but mock saw an un-aborted signal");
  });
  const ctl = new AbortController();
  ctl.abort();
  try {
    await assert.rejects(
      forwardPromptViaHttp({
        baseUrl: "http://example.test",
        sessionId: "sess-1",
        prompt: "x",
        onUpdate: () => {},
        signal: ctl.signal,
      }),
      (err) => err && err.name === "AbortError",
    );
  } finally {
    restore();
  }
});

test("forwardPromptViaHttp: abort during onRequest → POST error includes 'aborted:' marker", async () => {
  // Distinguish abort vs onRequest-throw. The proxy-mode.mjs handler
  // prefixes aborts with "aborted:" so the server's SseWriter can reject
  // its pending Promise with the same name. A throw from onRequest must
  // NOT carry that prefix.
  const observedPermissionBodies = [];
  const restore = withMockFetch(async (url, init = {}) => {
    if (url.endsWith("/acp/proxy/session/prompt")) {
      const sse =
        "event: request\n" +
        "data: {\"correlationId\":\"req-distinguish\",\"method\":\"session/request_permission\",\"params\":{}}\n\n" +
        "event: result\n" +
        "data: {\"stopReason\":\"end_turn\",\"usage\":{\"totalTokens\":0}}\n\n";
      return sseResponse([sse]);
    }
    if (url.endsWith("/acp/proxy/permission-response")) {
      observedPermissionBodies.push(JSON.parse(init.body));
      return new Response("{}", { status: 200 });
    }
    throw new Error("unexpected fetch");
  });

  const ctl = new AbortController();
  setTimeout(() => ctl.abort(), 20);

  try {
    await forwardPromptViaHttp({
      baseUrl: "http://example.test",
      sessionId: "sess-1",
      prompt: "x",
      onUpdate: () => {},
      onRequest: () => new Promise(() => {}), // never settles
      signal: ctl.signal,
    });
    const body = observedPermissionBodies[0];
    assert.equal(body.ok, false);
    assert.match(body.error, /^aborted:/, "abort errors must be distinguishable from onRequest throws");
    assert.doesNotMatch(body.error, /^aborted:aborted/, "no double-prefix");
  } finally {
    ctl.abort();
    restore();
  }
});