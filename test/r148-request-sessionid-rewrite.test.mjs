// test/r148-request-sessionid-rewrite.test.mjs — R148 审批请求 sessionId 重写契约。
//
// 真机根因（2026-11-15，Obsidian 1.15.1 + agent-client 实跑取证）：
//   宿主在 SSE `request`（session/request_permission）里携带的是**宿主会话 id**
//   （apply() 内部 UUID），而客户端 ACP 会话是另一个 id。Obsidian agent-client 的
//   PermissionManager 把 `params.sessionId` 原样塞进 `tool_call` 事件，AcpHandler
//   .emitSessionUpdate 的判据 `if (!(n && t.sessionId !== n))`（n = currentSessionId）
//   在不匹配时**直接丢弃**整个事件 ⇒ 审批卡片不渲染、请求永不回复、工具卡停在
//   pending（真机 R148 现象：显示 "Waiting for permission…" 之前完全没有弹窗）。
//
// 修法契约（lib/proxy-mode.mjs::handleServerRequest）：
//   1. 转发给客户端 onRequest 之前，把 params.sessionId 重写为**客户端会话 id**
//      （与 sessionUpdate 路径的 sid 重写同口径）；请求**没带** sessionId 时也算
//      不匹配并补上客户端 id —— 否则客户端同样按 `undefined !== currentSessionId`
//      丢弃事件；
//   2. 回复仍按 correlationId 配对（resolveRequest 不受影响），POST body 的
//      sessionId 仍是客户端 id；
//   3. 两边已一致时不重写、不告警；不一致时每次进程只告警一次。
//
// 注意：用例 D（一次性告警闩）**必须排在最前**——闩是模块级 / 进程级状态，
// 前面的用例一旦触发过重写，后面的用例就再也观察不到那条告警。
//
// 若把重写去掉，用例 A/C 会红（客户端收到的是宿主 id）。

import test from "node:test";
import assert from "node:assert/strict";

import { forwardPromptViaHttp } from "../lib/proxy-mode.mjs";

const HOST_SID = "dsh-629a7e21-ba9e-4f30-9279-34740fee3510";
const CLIENT_SID = "sess-client-1";

function withMockFetch(handler) {
  const original = globalThis.fetch;
  globalThis.fetch = handler;
  return () => { globalThis.fetch = original; };
}

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

/** Drive one prompt turn carrying a single permission request whose
 *  params.sessionId is `requestSid`. Returns what onRequest saw + the POST body. */
async function runTurn({ requestSid, clientSid = CLIENT_SID }) {
  const observedPermissionBodies = [];
  const restore = withMockFetch(async (url, init = {}) => {
    if (url.endsWith("/acp/proxy/session/prompt")) {
      const sse =
        "event: request\n" +
        `data: {"correlationId":"req-r148","method":"session/request_permission",` +
        `"params":{"toolCallId":"tc1","sessionId":${JSON.stringify(requestSid)},` +
        `"options":[{"optionId":"allow-once"},{"optionId":"reject-once"}]}}\n\n` +
        "event: result\n" +
        'data: {"stopReason":"end_turn","usage":{"totalTokens":1,"inputTokens":1,"outputTokens":0}}\n\n';
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
    let seen = null;
    const result = await forwardPromptViaHttp({
      baseUrl: "http://example.test",
      sessionId: clientSid,
      prompt: "x",
      onUpdate: () => {},
      onRequest: async (method, params) => {
        seen = { method, params };
        return { outcome: { outcome: "selected", optionId: "allow-once" } };
      },
    });
    return { seen, bodies: observedPermissionBodies, result };
  } finally {
    restore();
  }
}

test("R148 D: mismatch warns exactly once per process (one-time latch)", async () => {
  const origWrite = process.stderr.write;
  const lines = [];
  process.stderr.write = (chunk, ...rest) => {
    lines.push(typeof chunk === "string" ? chunk : String(chunk));
    return true;
  };
  try {
    await runTurn({ requestSid: HOST_SID });
    const afterFirst = lines.filter((l) => l.includes("rewriting to client id")).length;
    await runTurn({ requestSid: HOST_SID });
    const afterSecond = lines.filter((l) => l.includes("rewriting to client id")).length;
    assert.equal(afterFirst, 1, "first mismatch must warn once");
    assert.equal(afterSecond, 1, "second mismatch must NOT warn again (latch)");
  } finally {
    process.stderr.write = origWrite;
  }
});

test("R148 A: host sessionId ≠ client id → onRequest sees the CLIENT sessionId", async () => {
  const { seen, bodies } = await runTurn({ requestSid: HOST_SID });
  assert.equal(seen.method, "session/request_permission");
  assert.equal(seen.params.sessionId, CLIENT_SID, "sessionId must be rewritten to the client id");
  // The rewrite must not invent or drop anything else.
  assert.deepEqual(Object.keys(seen.params).sort(), ["options", "sessionId", "toolCallId"]);
  assert.equal(seen.params.toolCallId, "tc1");
  // Reply POST keeps the client id and the correlationId.
  assert.equal(bodies.length, 1);
  assert.equal(bodies[0].sessionId, CLIENT_SID);
  assert.equal(bodies[0].correlationId, "req-r148");
  assert.deepEqual(bodies[0].result, { outcome: { outcome: "selected", optionId: "allow-once" } });
});

test("R148 B: already-identical sessionId → params passed through untouched", async () => {
  const { seen } = await runTurn({ requestSid: CLIENT_SID });
  assert.equal(seen.params.sessionId, CLIENT_SID);
  assert.equal(seen.params.toolCallId, "tc1");
});

test("R148 C: request without sessionId → client id is filled in (absent counts as mismatch)", async () => {
  const observedPermissionBodies = [];
  const restore = withMockFetch(async (url, init = {}) => {
    if (url.endsWith("/acp/proxy/session/prompt")) {
      const sse =
        "event: request\n" +
        'data: {"correlationId":"req-r148-n","method":"session/request_permission","params":{"toolCallId":"tc9"}}\n\n' +
        "event: result\n" +
        'data: {"stopReason":"end_turn","usage":{"totalTokens":1,"inputTokens":1,"outputTokens":0}}\n\n';
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
    let seen = null;
    await forwardPromptViaHttp({
      baseUrl: "http://example.test",
      sessionId: CLIENT_SID,
      prompt: "x",
      onUpdate: () => {},
      onRequest: async (method, params) => {
        seen = { method, params };
        return { outcome: { outcome: "selected", optionId: "allow-once" } };
      },
    });
    assert.deepEqual(seen.params, { toolCallId: "tc9", sessionId: CLIENT_SID });
  } finally {
    restore();
  }
});
