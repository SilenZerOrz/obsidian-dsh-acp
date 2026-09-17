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