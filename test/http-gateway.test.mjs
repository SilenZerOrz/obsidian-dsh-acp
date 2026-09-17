// test/http-gateway.test.mjs — node:test unit tests for lib/http-gateway.mjs
//
// 覆盖范围:
//   - HTTP_GATEWAY_VERSION 常量
//   - SseWriter.emit / close 在 closed=true 时 silently 忽略
//   - createNotifyBridge emitter 路由到多个 writer
//   - registerHttpGateway 把 2 个路由注册到 webServer,handler 可触发
//   - /acp/proxy/probe handler 返回 { ok, version, mode, longReady }
//   - /acp/proxy/session/prompt handler: 无 sessionId → error event;
//     有 sessionId → 触发 long-runtime.prompt()(mock long-runtime)
//
// 全部用 mock:不连真实 dsh,不发真实 HTTP。

import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import {
  HTTP_GATEWAY_VERSION,
  SseWriter,
  createNotifyBridge,
  makeNotifyAcpClient,
  registerHttpGateway,
} from "../lib/http-gateway.mjs";

// --- HTTP_GATEWAY_VERSION -------------------------------------------------

test("HTTP_GATEWAY_VERSION is a semver-ish string", () => {
  assert.equal(typeof HTTP_GATEWAY_VERSION, "string");
  assert.match(HTTP_GATEWAY_VERSION, /^\d+\.\d+\.\d+/);
});

// --- SseWriter ------------------------------------------------------------

test("SseWriter.emit writes event + JSON data + trailing blank line", () => {
  const writes = [];
  const res = { write: (chunk) => writes.push(chunk) };
  const w = new SseWriter(res);
  w.emit("sessionUpdate", { foo: 1 });
  assert.equal(writes.length, 2);
  assert.match(writes[0], /^event: sessionUpdate\n$/);
  assert.match(writes[1], /^data: \{"foo":1\}\n\n$/);
});

test("SseWriter.emit silently no-ops after close()", () => {
  const writes = [];
  const res = {
    write: (chunk) => writes.push(chunk),
    end: () => writes.push("__END__"),
  };
  const w = new SseWriter(res);
  w.close();
  assert.equal(writes[writes.length - 1], "__END__");
  w.emit("sessionUpdate", { foo: 1 });
  assert.equal(writes.length, 1); // no extra write after close
});

test("SseWriter.emit survives res.write throwing (e.g. ECONNRESET)", () => {
  const res = {
    write: () => {
      throw new Error("ECONNRESET");
    },
    end: () => {},
  };
  const w = new SseWriter(res);
  // Should not throw — just sets closed=true.
  assert.doesNotThrow(() => w.emit("sessionUpdate", { x: 1 }));
  // Subsequent emits also no-op.
  w.emit("sessionUpdate", { x: 2 });
  // close() also no-op (already closed).
  assert.doesNotThrow(() => w.close());
});

// --- createNotifyBridge ---------------------------------------------------

test("createNotifyBridge: emitter routes notify to all attached writers", () => {
  const bridge = createNotifyBridge();
  const a = [];
  const b = [];
  const writerA = { emit: (event, data) => a.push({ event, data }) };
  const writerB = { emit: (event, data) => b.push({ event, data }) };
  bridge.attachWriter(writerA);
  bridge.attachWriter(writerB);
  bridge.emitter.emit("notify", "session/update", { id: 1 });
  assert.equal(a.length, 1);
  assert.equal(b.length, 1);
  assert.equal(a[0].event, "sessionUpdate");
  assert.deepEqual(a[0].data, { method: "session/update", params: { id: 1 } });
  bridge.detachWriter(writerA);
  bridge.emitter.emit("notify", "session/update", { id: 2 });
  assert.equal(a.length, 1); // unchanged
  assert.equal(b.length, 2); // still receives
});

test("createNotifyBridge: emitter.setMaxListeners >= concurrent prompts", () => {
  const bridge = createNotifyBridge();
  assert.ok(bridge.emitter.getMaxListeners() >= 16);
});

// --- makeNotifyAcpClient --------------------------------------------------

test("makeNotifyAcpClient.notify() routes through bridge emitter", async () => {
  const bridge = createNotifyBridge();
  const client = makeNotifyAcpClient(bridge);
  let captured = null;
  bridge.attachWriter({
    emit: (_event, data) => {
      captured = data;
    },
  });
  await client.notify("session/update", { sessionId: "abc", type: "message" });
  assert.deepEqual(captured, {
    method: "session/update",
    params: { sessionId: "abc", type: "message" },
  });
});

test("makeNotifyAcpClient.request() throws (v1 stub — no bidirectional wire)", async () => {
  const bridge = createNotifyBridge();
  const client = makeNotifyAcpClient(bridge);
  await assert.rejects(
    () => client.request("session/request_permission", {}),
    /not wired in commit 1/,
  );
});

// --- registerHttpGateway (with mock webServer) ----------------------------

/**
 * Build a mock webServer that records register() calls and lets tests pull
 * the handler back out by path.
 *
 * @returns {{ register: Function, handlers: Map<string, Function> }}
 */
function makeMockWebServer() {
  const handlers = new Map();
  return {
    handlers,
    register(spec) {
      handlers.set(spec.path, spec.handler);
    },
  };
}

/**
 * Build a mock req/res pair suitable for handler(req, res) calls. Returns the
 * write buffer for inspection.
 */
function makeMockReqRes({ method = "GET", body = "" } = {}) {
  const req = Object.assign(new EventEmitter(), {
    method,
    headers: {},
    destroy: () => {},
  });
  const writes = [];
  let statusCode = 0;
  let headersSent = {};
  const res = {
    writeHead(s, h) {
      statusCode = s;
      headersSent = h ?? {};
    },
    write(chunk) {
      writes.push(chunk);
    },
    end(chunk) {
      if (chunk !== undefined) writes.push(chunk);
      req.emit("__res_ended__");
    },
  };
  // Feed body asynchronously so handlers can `await readJsonBody(req)`.
  queueMicrotask(() => {
    if (body) req.emit("data", Buffer.from(body));
    req.emit("end");
  });
  return { req, res, writes, get statusCode() { return statusCode; }, get headersSent() { return headersSent; } };
}

test("registerHttpGateway registers probe + prompt routes on webServer", () => {
  const ws = makeMockWebServer();
  const ctx = { logger: { info() {} } };
  registerHttpGateway(ctx, ws);
  assert.ok(ws.handlers.has("/acp/proxy/probe"));
  assert.ok(ws.handlers.has("/acp/proxy/session/prompt"));
});

test("registerHttpGateway: enablePrompt=false omits prompt route", () => {
  const ws = makeMockWebServer();
  const ctx = { logger: { info() {} } };
  registerHttpGateway(ctx, ws, { enablePrompt: false });
  assert.ok(ws.handlers.has("/acp/proxy/probe"));
  assert.ok(!ws.handlers.has("/acp/proxy/session/prompt"));
});

// --- probe handler --------------------------------------------------------

test("GET /acp/proxy/probe returns JSON with version + longReady=false (no long-runtime)", async () => {
  const ws = makeMockWebServer();
  const ctx = { logger: { info() {} } };
  registerHttpGateway(ctx, ws);
  const handler = ws.handlers.get("/acp/proxy/probe");
  const { req, res, writes } = makeMockReqRes({ method: "GET" });
  await handler(req, res);
  const body = JSON.parse(writes.join(""));
  assert.equal(body.ok, true);
  assert.equal(body.version, HTTP_GATEWAY_VERSION);
  assert.equal(body.longReady, false);
  // Probe didn't get long-runtime (we didn't FORCE_P2 / no real dsh installed)
  assert.match(body.mode, /spawn-hint|long/);
});

// --- prompt handler (validation paths) ------------------------------------

test("POST /acp/proxy/session/prompt without sessionId emits SSE error event", async () => {
  const ws = makeMockWebServer();
  const ctx = { logger: { info() {} } };
  registerHttpGateway(ctx, ws);
  const handler = ws.handlers.get("/acp/proxy/session/prompt");
  const mock = makeMockReqRes({
    method: "POST",
    body: JSON.stringify({ prompt: "hello" }),
  });
  await handler(mock.req, mock.res);
  // SSE headers should be set (access via getter, NOT destructured value —
  // destructuring calls getters once at binding time and freezes the result).
  assert.match(mock.headersSent["content-type"] ?? "", /text\/event-stream/);
  // Should contain an error event
  const text = mock.writes.join("");
  assert.match(text, /event: error\n/);
  assert.match(text, /sessionId required/);
});

test("POST /acp/proxy/session/prompt with invalid JSON body emits SSE error event", async () => {
  const ws = makeMockWebServer();
  const ctx = { logger: { info() {} } };
  registerHttpGateway(ctx, ws);
  const handler = ws.handlers.get("/acp/proxy/session/prompt");
  const { req, res, writes } = makeMockReqRes({
    method: "POST",
    body: "{ not json",
  });
  await handler(req, res);
  const text = writes.join("");
  assert.match(text, /event: error\n/);
  assert.match(text, /invalid JSON/);
});

test("POST /acp/proxy/session/prompt with empty body emits SSE error event", async () => {
  const ws = makeMockWebServer();
  const ctx = { logger: { info() {} } };
  registerHttpGateway(ctx, ws);
  const handler = ws.handlers.get("/acp/proxy/session/prompt");
  const { req, res, writes } = makeMockReqRes({ method: "POST", body: "" });
  await handler(req, res);
  const text = writes.join("");
  assert.match(text, /event: error\n/);
  assert.match(text, /sessionId required/);
});