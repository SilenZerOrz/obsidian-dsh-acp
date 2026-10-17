// test/long-runtime.test.mjs — node:test unit tests for lib/long-runtime.mjs
//
// P1.0: validated skeleton (init() throws placeholder).
// P1.5: validates init() success + prompt() wiring through LLMStreamBridge,
//       using a fake cordis ctx that exposes a stream() returning a
//       scriptable async iterable of StreamChunks.

import test from "node:test";
import assert from "node:assert/strict";
import {
  LongRuntime,
  getLongRuntime,
  resetLongRuntime,
  extractPromptText,
  buildStreamOptions,
} from "../lib/long-runtime.mjs";

// --- helpers --------------------------------------------------------------

/** Build a fake cordis ctx whose llm.stream() returns a scriptable iterable. */
function fakeCtx(chunksByTurn /* Array<Array<object>> */) {
  let turn = 0;
  return {
    llm: {
      stream(opts) {
        const seq = chunksByTurn[turn++] ?? [];
        return (async function* () {
          for (const c of seq) {
            // honour AbortSignal between chunks
            if (opts && opts.signal && opts.signal.aborted) {
              throw new Error("aborted");
            }
            yield c;
          }
        })();
      },
    },
    off() {},
    on() {},
  };
}

/** Fake ACP client that captures sessionUpdate notifications. */
function fakeClient() {
  const sent = [];
  return {
    sent,
    async notify(method, params) {
      sent.push({ method, params });
    },
  };
}

const DEFAULT_PERMISSION = {
  mode: "default",
  timeoutMs: 300000,
  editTools: ["Edit", "Write", "MultiEdit", "NotebookEdit"],
};

// --- skeleton backward-compat --------------------------------------------

test("LongRuntime: new instance starts uninitialized", () => {
  const rt = new LongRuntime();
  assert.equal(rt._initialized, false);
  assert.equal(rt.cordisCtx, null);
  assert.equal(rt.acpClient, null);
});

test("LongRuntime: prompt() throws when not initialized", async () => {
  const rt = new LongRuntime();
  await assert.rejects(rt.prompt({ sessionId: "x" }), /not initialized/);
});

test("LongRuntime: dispose() clears state", async () => {
  const rt = new LongRuntime();
  const ctx = fakeCtx([]);
  const client = fakeClient();
  await rt.init({ cordisCtx: ctx, acpClient: client, permissionConfig: DEFAULT_PERMISSION, cwd: "/tmp" });
  await rt.dispose();
  assert.equal(rt._initialized, false);
  assert.equal(rt.cordisCtx, null);
  assert.equal(rt.acpClient, null);
  assert.equal(rt.permissionConfig, null);
});

// --- P1.5 init() success path --------------------------------------------

test("init: succeeds when ctx.llm.stream is a function", async () => {
  const rt = new LongRuntime();
  await rt.init({
    cordisCtx: fakeCtx([]),
    acpClient: fakeClient(),
    permissionConfig: DEFAULT_PERMISSION,
    cwd: "/tmp",
    model: "default/test-model",
  });
  assert.equal(rt._initialized, true);
  assert.equal(rt.defaultModel, "default/test-model");
  assert.equal(rt.cwd, "/tmp");
});

test("init: rejects when cordisCtx missing", async () => {
  const rt = new LongRuntime();
  await assert.rejects(rt.init({ acpClient: fakeClient() }), /cordisCtx/);
});

test("init: rejects when acpClient missing", async () => {
  const rt = new LongRuntime();
  await assert.rejects(
    rt.init({ cordisCtx: fakeCtx([]), acpClient: null }),
    /acpClient/,
  );
});

test("init: rejects when ctx.llm.stream is missing (wrong dsh version)", async () => {
  const rt = new LongRuntime();
  await assert.rejects(
    rt.init({ cordisCtx: { llm: {} }, acpClient: fakeClient() }),
    /llm\.stream/,
  );
});

test("init: stores default permission config when omitted", async () => {
  const rt = new LongRuntime();
  await rt.init({ cordisCtx: fakeCtx([]), acpClient: fakeClient() });
  assert.equal(rt.permissionConfig.mode, "default");
  assert.ok(Array.isArray(rt.permissionConfig.editTools));
});

// --- prompt(): end-to-end through LLMStreamBridge -----------------------

test("prompt: text-only stream emits agent_message_chunk and returns end_turn", async () => {
  const rt = new LongRuntime();
  const client = fakeClient();
  const ctx = fakeCtx([
    [
      { type: "block-start", index: 0, blockType: "text" },
      { type: "text-delta", index: 0, text: "Hello " },
      { type: "text-delta", index: 0, text: "world" },
      { type: "block-end", index: 0, block: { type: "text", text: "Hello world" } },
      { type: "usage", usage: { totalTokens: 7 } },
      { type: "finish", reason: { kind: "stop" } },
    ],
  ]);
  await rt.init({ cordisCtx: ctx, acpClient: client, model: "default/m" });

  const result = await rt.prompt({
    sessionId: "s1",
    prompt: "hi",
    sessionConfig: { model: "default/m" },
  });

  assert.equal(result.stopReason, "end_turn");
  assert.equal(result.text, "Hello world");
  assert.equal(result.usage.totalTokens, 7);
  // acpClient.notify called for each non-null sessionUpdate
  const updates = client.sent
    .filter((s) => s.method === "session/update")
    .map((s) => s.params.update);
  // C1 dedup (chunk-mapper 71a10a7): the block-end text snapshot is skipped
  // when deltas already streamed → 3 text (init + 2 deltas) + 1 usage = 4,
  // not 5 (previously counted a redundant end snapshot).
  assert.equal(updates.length, 4);
  const textUpdates = updates.filter((u) => u.sessionUpdate === "agent_message_chunk");
  const usageUpdates = updates.filter((u) => u.sessionUpdate === "usage_update");
  assert.equal(textUpdates.length, 3);
  assert.equal(usageUpdates.length, 1);
  // First update is the empty init chunk
  assert.equal(updates[0].messageId, "msg-1");
});

test("prompt: reasoning stream surfaces as agent_thought_chunk", async () => {
  const rt = new LongRuntime();
  const client = fakeClient();
  const ctx = fakeCtx([
    [
      { type: "block-start", index: 0, blockType: "reasoning" },
      { type: "reasoning-delta", index: 0, text: "thinking…" },
      { type: "block-end", index: 0, block: { type: "reasoning", text: "thinking…" } },
      { type: "finish", reason: { kind: "stop" } },
    ],
  ]);
  await rt.init({ cordisCtx: ctx, acpClient: client, model: "default/m" });

  await rt.prompt({ sessionId: "s2", prompt: "x", sessionConfig: { model: "default/m" } });

  const updates = client.sent
    .filter((s) => s.method === "session/update")
    .map((s) => s.params.update);
  assert.ok(updates.some((u) => u.sessionUpdate === "agent_thought_chunk"));
});

test("prompt: tool-call stream emits tool_call(pending) → update(in_progress) → completed", async () => {
  const rt = new LongRuntime();
  const client = fakeClient();
  const ctx = fakeCtx([
    [
      { type: "tool-call-delta", index: 1, id: "tc1", name: "Read", argumentsDelta: '{"p":' },
      { type: "tool-call-delta", index: 1, id: "tc1", argumentsDelta: '"x"}' },
      { type: "block-end", index: 1, block: { type: "tool-call", toolCallId: "tc1", toolCallName: "Read" } },
      { type: "finish", reason: { kind: "stop" } },
    ],
  ]);
  await rt.init({ cordisCtx: ctx, acpClient: client, model: "default/m" });

  await rt.prompt({ sessionId: "s3", prompt: "y", sessionConfig: { model: "default/m" } });

  const updates = client.sent
    .filter((s) => s.method === "session/update")
    .map((s) => s.params.update);
  const start = updates.filter((u) => u.sessionUpdate === "tool_call");
  const toolUpdates = updates.filter((u) => u.sessionUpdate === "tool_call_update");
  // P0-1 (2026-10-14): first delta → tool_call start (pending).
  assert.equal(start.length, 1);
  assert.equal(start[0].status, "pending");
  assert.equal(start[0].kind, "read"); // P0-3
  assert.equal(toolUpdates.length, 2); // 1 in_progress + 1 completed
  assert.equal(toolUpdates[0].status, "in_progress");
  assert.equal(toolUpdates[1].status, "completed");
  assert.equal(toolUpdates[1].toolCallId, "tc1");
  assert.deepEqual(toolUpdates[1].rawInput, { p: "x" });
});

test("prompt: usage chunk emitted as usage_update with totalTokens", async () => {
  const rt = new LongRuntime();
  const client = fakeClient();
  const ctx = fakeCtx([
    [
      { type: "block-start", index: 0, blockType: "text" },
      { type: "text-delta", index: 0, text: "x" },
      { type: "usage", usage: { inputTokens: 5, outputTokens: 3, totalTokens: 8 } },
      { type: "finish", reason: { kind: "stop" } },
    ],
  ]);
  await rt.init({ cordisCtx: ctx, acpClient: client, model: "default/m" });
  await rt.prompt({ sessionId: "s4", prompt: "z", sessionConfig: { model: "default/m" } });
  const usage = client.sent
    .map((s) => s.params.update)
    .find((u) => u?.sessionUpdate === "usage_update");
  assert.ok(usage);
  assert.equal(usage.used, 8);
});

test("prompt: stream throw → cancelled stopReason", async () => {
  const rt = new LongRuntime();
  const client = fakeClient();
  const ctx = fakeCtx([
    // first turn throws immediately
    (async function* () {
      yield { type: "block-start", index: 0, blockType: "text" };
      throw new Error("network down");
    })(),
  ]);
  await rt.init({ cordisCtx: ctx, acpClient: client, model: "default/m" });
  const result = await rt.prompt({ sessionId: "s5", prompt: "q", sessionConfig: { model: "default/m" } });
  assert.equal(result.stopReason, "cancelled");
});

test("prompt: empty stream returns end_turn with no text", async () => {
  const rt = new LongRuntime();
  const client = fakeClient();
  const ctx = fakeCtx([[]]);
  await rt.init({ cordisCtx: ctx, acpClient: client, model: "default/m" });
  const result = await rt.prompt({ sessionId: "s6", prompt: "", sessionConfig: { model: "default/m" } });
  assert.equal(result.stopReason, "end_turn");
  assert.equal(result.text, undefined);
});

test("prompt: synchronous stream throw (provider lookup failed) → cancelled", async () => {
  const rt = new LongRuntime();
  const client = fakeClient();
  const ctx = {
    llm: {
      stream() {
        throw new Error("no provider for model");
      },
    },
    off() {},
    on() {},
  };
  await rt.init({ cordisCtx: ctx, acpClient: client, model: "default/m" });
  const result = await rt.prompt({ sessionId: "s7", prompt: "go", sessionConfig: { model: "default/m" } });
  assert.equal(result.stopReason, "cancelled");
  assert.ok(result.text.includes("no provider"));
});

// --- sessionConfig wiring ------------------------------------------------

test("prompt: honors sessionConfig.temperature and reasoningEffort", async () => {
  const rt = new LongRuntime();
  let capturedOpts = null;
  const ctx = {
    llm: {
      stream(opts) {
        capturedOpts = opts;
        return (async function* () {
          yield { type: "finish", reason: { kind: "stop" } };
        })();
      },
    },
    off() {},
    on() {},
  };
  await rt.init({ cordisCtx: ctx, acpClient: fakeClient(), model: "default/m" });
  await rt.prompt({
    sessionId: "s8",
    prompt: "x",
    sessionConfig: { model: "default/m", temperature: 0.3, reasoningEffort: "high" },
  });
  assert.equal(capturedOpts.temperature, 0.3);
  assert.equal(capturedOpts.reasoningEffort, "high");
});

test("prompt: prepends history messages + appends user prompt", async () => {
  const rt = new LongRuntime();
  let capturedOpts = null;
  const ctx = {
    llm: {
      stream(opts) {
        capturedOpts = opts;
        return (async function* () {
          yield { type: "finish", reason: { kind: "stop" } };
        })();
      },
    },
    off() {},
    on() {},
  };
  await rt.init({ cordisCtx: ctx, acpClient: fakeClient(), model: "default/m" });
  await rt.prompt({
    sessionId: "s9",
    prompt: "second turn",
    sessionConfig: {
      model: "default/m",
      messages: [{ role: "user", content: "first" }, { role: "assistant", content: "ok" }],
    },
  });
  assert.equal(capturedOpts.messages.length, 3);
  // dsh's LlmRuntime calls content.some(...), so all messages are normalized
  // to parts arrays regardless of how the caller passed them.
  assert.deepEqual(capturedOpts.messages[0].content, [{ type: "text", text: "first" }]);
  assert.deepEqual(capturedOpts.messages[2].content, [{ type: "text", text: "second turn" }]);
});

// --- extractPromptText ----------------------------------------------------

test("extractPromptText: plain string", () => {
  assert.equal(extractPromptText("hello"), "hello");
});

test("extractPromptText: array of text blocks", () => {
  assert.equal(
    extractPromptText([{ type: "text", text: "a" }, { type: "text", text: "b" }]),
    "a\nb",
  );
});

test("extractPromptText: object with content array", () => {
  assert.equal(
    extractPromptText({ content: [{ type: "text", text: "x" }, { type: "text", text: "y" }] }),
    "x\ny",
  );
});

// --- buildStreamOptions ---------------------------------------------------

test("buildStreamOptions: splits provider from a flattened 'provider/model' id", () => {
  const opts = buildStreamOptions({
    promptText: "hi",
    sessionConfig: { model: "anthropic/claude-3" },
    defaultModel: null,
    history: [],
    cwd: "/tmp",
  });
  assert.equal(opts.provider, "anthropic");
  // GenerateOptions.model must be the BARE model id — provider is a separate field.
  assert.equal(opts.model, "claude-3");
  assert.equal(opts.messages.length, 1);
  assert.equal(opts.messages[0].role, "user");
  // dsh's LlmRuntime calls content.some(...), so content MUST be a parts array.
  assert.deepEqual(opts.messages[0].content, [{ type: "text", text: "hi" }]);
});

test("buildStreamOptions: bare model id borrows provider from defaultModel (never 'default')", () => {
  // 2026-10-10: the old behaviour invented provider "default" for a bare id,
  // which dsh rejected as NO_ADAPTER. A bare id now takes the provider from
  // defaultModel; with no defaultModel it throws (covered below).
  const opts = buildStreamOptions({
    promptText: "hi",
    sessionConfig: { model: "DeepSeek-V4-Flash" },
    defaultModel: "jl-token/DeepSeek-V4.1-Flash",
    history: [],
    cwd: "/tmp",
  });
  assert.equal(opts.provider, "jl-token");
  assert.equal(opts.model, "DeepSeek-V4-Flash");
});

test("buildStreamOptions: bare model id with no defaultModel throws (no fabricated provider)", () => {
  assert.throws(
    () =>
      buildStreamOptions({
        promptText: "hi",
        sessionConfig: { model: "DeepSeek-V4-Flash" },
        defaultModel: null,
        history: [],
        cwd: "/tmp",
      }),
    (err) => {
      assert.ok(err instanceof Error);
      assert.match(err.message, /DeepSeek-V4-Flash/);
      return true;
    },
  );
});

test("buildStreamOptions: falls back to defaultModel when sessionConfig omits model", () => {
  const opts = buildStreamOptions({
    promptText: "hi",
    sessionConfig: {},
    defaultModel: "default/fb",
    history: [],
    cwd: "/tmp",
  });
  assert.equal(opts.provider, "default");
  assert.equal(opts.model, "fb");
});

test("buildStreamOptions: falls back to HARDCODED model when no model is resolvable", () => {
  // [H3c-1 修法 3] 当 init 路径漏 seed defaultModel 时，prompt 侧仍兜底到
  // 硬编码模型（与 lib/http-gateway.mjs:475 HTTP_GATEWAY_HARDCODED_MODEL
  // 同源）。修复前此处 throw "no model configured" → adapter end_turn 转圈；
  // 修法 3 后不再抛，改为兜底（设计意图即兜底，故断言随行为更新）。
  // 同时清掉 env 兜底层，确保测到的是 HARDCODED 这一层。
  const prevEnv = process.env.DSH_ACP_DEFAULT_MODEL;
  delete process.env.DSH_ACP_DEFAULT_MODEL;
  try {
    const opts = buildStreamOptions({
      promptText: "hi",
      sessionConfig: {},
      defaultModel: null,
      history: [],
      cwd: "/tmp",
    });
    // HARDCODED = "jl-token/DeepSeek-V4-Flash" → provider 前缀被拆出
    assert.equal(opts.provider, "jl-token");
    assert.equal(opts.model, "DeepSeek-V4-Flash");
  } finally {
    if (prevEnv === undefined) delete process.env.DSH_ACP_DEFAULT_MODEL;
    else process.env.DSH_ACP_DEFAULT_MODEL = prevEnv;
  }
});

test("buildStreamOptions: prefers DSH_ACP_DEFAULT_MODEL env over HARDCODED", () => {
  // [H3c-1 修法 3] 兜底链优先级：sessionConfig.model → defaultModel →
  // DSH_ACP_DEFAULT_MODEL env → HARDCODED。本用例覆盖 env 层优先于 HARDCODED。
  const prevEnv = process.env.DSH_ACP_DEFAULT_MODEL;
  process.env.DSH_ACP_DEFAULT_MODEL = "custom/test-model";
  try {
    const opts = buildStreamOptions({
      promptText: "hi",
      sessionConfig: {},
      defaultModel: null,
      history: [],
      cwd: "/tmp",
    });
    assert.equal(opts.provider, "custom");
    assert.equal(opts.model, "test-model");
  } finally {
    if (prevEnv === undefined) delete process.env.DSH_ACP_DEFAULT_MODEL;
    else process.env.DSH_ACP_DEFAULT_MODEL = prevEnv;
  }
});

// --- normalizeMessage (regression for dsh content.some bug) ---------------

test("buildStreamOptions: wraps history[i].content string into parts array", () => {
  // Regression (2026-09-17): dsh's LlmRuntime calls content.some(...) on every
  // message; passing a plain string content produced a terminal
  //   failure: { message: "content.some is not a function", code: "UNKNOWN" }
  // chunk that the bridge silently mapped to stopReason:"cancelled". All
  // messages (history + new user turn) must be normalized to parts arrays.
  const opts = buildStreamOptions({
    promptText: "what's up",
    sessionConfig: { model: "default/m" },
    defaultModel: null,
    history: [
      { role: "user", content: "previous question" },
      { role: "assistant", content: "previous answer" },
    ],
    cwd: "/tmp",
  });
  assert.equal(opts.messages.length, 3);
  for (const m of opts.messages) {
    assert.ok(Array.isArray(m.content), `expected content array, got ${typeof m.content}`);
    assert.equal(m.content.length, 1);
    assert.equal(m.content[0].type, "text");
    assert.equal(typeof m.content[0].text, "string");
  }
  assert.equal(opts.messages[2].content[0].text, "what's up");
});

test("buildStreamOptions: preserves history messages whose content is already a parts array", () => {
  const opts = buildStreamOptions({
    promptText: "describe image",
    sessionConfig: { model: "default/m" },
    defaultModel: null,
    history: [
      {
        role: "user",
        content: [
          { type: "text", text: "what is in this image?" },
          { type: "image", source: { type: "base64", data: "abc" } },
        ],
      },
    ],
    cwd: "/tmp",
  });
  assert.equal(opts.messages.length, 2);
  // History content is passed through unchanged (still 2 parts).
  assert.equal(opts.messages[0].content.length, 2);
  assert.equal(opts.messages[0].content[0].type, "text");
  assert.equal(opts.messages[0].content[1].type, "image");
  // New user turn still gets the string → parts conversion.
  assert.deepEqual(opts.messages[1].content, [{ type: "text", text: "describe image" }]);
});

test("buildStreamOptions: omits temperature/reasoningEffort when not set", () => {
  const opts = buildStreamOptions({
    promptText: "hi",
    sessionConfig: { model: "default/m" },
    defaultModel: null,
    history: [],
    cwd: "/tmp",
  });
  assert.equal("temperature" in opts, false);
  assert.equal("reasoningEffort" in opts, false);
});

// --- singleton ----------------------------------------------------------

test("getLongRuntime: returns singleton instance", () => {
  resetLongRuntime();
  const a = getLongRuntime();
  const b = getLongRuntime();
  assert.equal(a, b);
});

test("resetLongRuntime: clears the singleton", () => {
  const a = getLongRuntime();
  resetLongRuntime();
  const b = getLongRuntime();
  assert.notEqual(a, b);
});

// --- P2.0 step 2: agent/pre-step + approval/request hooks ---------------

test("init: registers agent/pre-step listener on cordis ctx", async () => {
  const ctx = fakeCtx([]);
  const registered = [];
  ctx.on = (event, listener) => { registered.push({ event, listener }); };
  const rt = new LongRuntime();
  await rt.init({ cordisCtx: ctx, acpClient: fakeClient(), model: "default/m" });
  const events = registered.map((r) => r.event);
  assert.ok(events.includes("agent/pre-step"), "must subscribe to pre-step");
  assert.ok(events.includes("approval/request"), "must subscribe to approval/request");
});

test("init: stores PermissionGate on instance", async () => {
  const rt = new LongRuntime();
  await rt.init({
    cordisCtx: fakeCtx([]),
    acpClient: fakeClient(),
    permissionConfig: { mode: "bypassPermissions", timeoutMs: 1000, editTools: ["Edit"] },
    model: "default/m",
  });
  assert.ok(rt.gate, "gate must be created");
  assert.equal(rt.gate.mode, "bypassPermissions");
});

test("agent/pre-step: pushes tool_call_update (status=pending) via acpClient", async () => {
  const ctx = fakeCtx([]);
  const client = fakeClient();
  const rt = new LongRuntime();
  await rt.init({ cordisCtx: ctx, acpClient: client, model: "default/m" });

  // Find the pre-step listener and invoke it directly.
  const preStep = ctx._lastListeners?.["agent/pre-step"]?.[0]?.listener;
  // fakeCtx's on() above is no-op, so re-register through the ctx shape we used.
  // Re-run via the listeners array we stored on init:
  const stored = rt._agentListeners.find((l) => l.event === "agent/pre-step");
  assert.ok(stored, "pre-step listener must be stored for dispose()");
  await stored.listener({
    toolCallId: "tc-pre-1",
    toolName: "Edit",
    sessionId: "sess-1",
  });

  const paramsList = client.sent
    .filter((s) => s.method === "session/update")
    .map((s) => s.params);
  const pending = paramsList.find((p) => p.update?.toolCallId === "tc-pre-1");
  assert.ok(pending, "expected a tool_call_update with tc-pre-1");
  assert.equal(pending.update.status, "pending");
  assert.equal(pending.update.title, "Edit");
  assert.equal(pending.sessionId, "sess-1");
});

test("approval/request: bypassPermissions auto-allows (no acpRequester call)", async () => {
  const ctx = fakeCtx([]);
  const rt = new LongRuntime();
  await rt.init({
    cordisCtx: ctx,
    acpClient: fakeClient(),
    permissionConfig: { mode: "bypassPermissions", timeoutMs: 1000, editTools: [] },
    model: "default/m",
  });
  const stored = rt._agentListeners.find((l) => l.event === "approval/request");
  const replies = { acceptCalled: false, rejectCalled: false };
  await stored.listener(
    { toolCallId: "tc-1", toolName: "bash", args: { cmd: "ls" } },
    {
      accept: () => { replies.acceptCalled = true; },
      reject: (r) => { replies.rejectCalled = true; replies.rejectReason = r; },
    },
  );
  assert.equal(replies.acceptCalled, true);
  assert.equal(replies.rejectCalled, false);
});

test("approval/request: dontAsk auto-allows without surfacing UI", async () => {
  const ctx = fakeCtx([]);
  const rt = new LongRuntime();
  await rt.init({
    cordisCtx: ctx,
    acpClient: fakeClient(),
    permissionConfig: { mode: "dontAsk", timeoutMs: 1000, editTools: [] },
    model: "default/m",
  });
  const stored = rt._agentListeners.find((l) => l.event === "approval/request");
  let resolved = null;
  await stored.listener(
    { toolCallId: "tc-2", toolName: "bash", args: {} },
    {
      accept: () => { resolved = "accept"; },
      reject: () => { resolved = "reject"; },
    },
  );
  assert.equal(resolved, "accept");
});

test("approval/request: default mode calls _liveAcpClient.request and respects allow_once", async () => {
  const ctx = fakeCtx([]);
  const rt = new LongRuntime();
  await rt.init({
    cordisCtx: ctx,
    acpClient: fakeClient(),
    permissionConfig: { mode: "default", timeoutMs: 1000, editTools: [] },
    model: "default/m",
  });
  let requested = null;
  rt._liveAcpClient = {
    async request(method, params) {
      requested = { method, params };
      return { outcome: { outcome: "selected", optionId: "allow-once" } };
    },
  };
  rt._activeSessionId = "sess-A";
  const stored = rt._agentListeners.find((l) => l.event === "approval/request");
  let verdict = null;
  await stored.listener(
    { toolCallId: "tc-3", toolName: "Read", args: { path: "/x" }, reason: "Read file" },
    {
      accept: () => { verdict = "accept"; },
      reject: (r) => { verdict = `reject:${r}`; },
    },
  );
  assert.equal(verdict, "accept");
  assert.equal(requested.method, "session/request_permission");
  assert.equal(requested.params.toolCallId, "tc-3");
  assert.equal(requested.params.title, "Read file");
  assert.equal(requested.params.sessionId, "sess-A");
});

test("approval/request: reject_once → reject called with reason", async () => {
  const ctx = fakeCtx([]);
  const rt = new LongRuntime();
  await rt.init({
    cordisCtx: ctx,
    acpClient: fakeClient(),
    permissionConfig: { mode: "default", timeoutMs: 1000, editTools: [] },
    model: "default/m",
  });
  rt._liveAcpClient = {
    async request() {
      return { outcome: { outcome: "selected", optionId: "reject" } };
    },
  };
  const stored = rt._agentListeners.find((l) => l.event === "approval/request");
  let verdict = null;
  await stored.listener(
    { toolCallId: "tc-4", toolName: "bash", args: {} },
    {
      accept: () => { verdict = "accept"; },
      reject: (r) => { verdict = `reject:${r}`; },
    },
  );
  assert.match(verdict, /^reject:/);
  assert.match(verdict, /user:reject_once/);
});

test("approval/request: cache hit short-circuits and skips requester", async () => {
  const ctx = fakeCtx([]);
  const rt = new LongRuntime();
  await rt.init({
    cordisCtx: ctx,
    acpClient: fakeClient(),
    permissionConfig: { mode: "default", timeoutMs: 1000, editTools: [] },
    model: "default/m",
  });
  let requestCount = 0;
  rt._liveAcpClient = {
    async request() {
      requestCount++;
      return { outcome: { outcome: "selected", optionId: "allow-once" } };
    },
  };
  const stored = rt._agentListeners.find((l) => l.event === "approval/request");
  const reply = { accept: () => {}, reject: () => {} };
  await stored.listener({ toolCallId: "tc-5", toolName: "Read", args: { p: 1 } }, reply);
  await stored.listener({ toolCallId: "tc-6", toolName: "Read", args: { p: 1 } }, reply);
  assert.equal(requestCount, 1, "second call must hit cache");
});

test("approval/request: acceptEdits auto-allows Edit but asks bash", async () => {
  const ctx = fakeCtx([]);
  const rt = new LongRuntime();
  await rt.init({
    cordisCtx: ctx,
    acpClient: fakeClient(),
    permissionConfig: { mode: "acceptEdits", timeoutMs: 1000, editTools: ["Edit"] },
    model: "default/m",
  });
  let requestCount = 0;
  rt._liveAcpClient = {
    async request() {
      requestCount++;
      return { outcome: { outcome: "selected", optionId: "allow-once" } };
    },
  };
  const stored = rt._agentListeners.find((l) => l.event === "approval/request");
  const replyEdit = { accept: () => {}, reject: () => {} };
  const replyBash = { accept: () => {}, reject: () => {} };
  await stored.listener({ toolCallId: "tc-edit", toolName: "Edit", args: {} }, replyEdit);
  await stored.listener({ toolCallId: "tc-bash", toolName: "bash", args: {} }, replyBash);
  assert.equal(requestCount, 1, "Edit auto-allows; only bash asks");
});

test("dispose: detaches all agent listeners + clears gate cache", async () => {
  const ctx = fakeCtx([]);
  const offed = [];
  ctx.off = (event, listener) => offed.push({ event, listener });
  const rt = new LongRuntime();
  await rt.init({ cordisCtx: ctx, acpClient: fakeClient(), model: "default/m" });
  // populate cache
  await rt.gate.resolve({ toolName: "Read", args: { p: 1 } }, "x", null);
  assert.equal(rt.gate.cacheSize, 0, "default mode returns 'ask' (not cached)");
  // manually cache via bypass mode
  rt.gate.mode = "bypassPermissions";
  await rt.gate.resolve({ toolName: "Edit", args: { p: 1 } }, "y", null);
  assert.ok(rt.gate.cacheSize > 0);

  await rt.dispose();

  assert.equal(rt._agentListeners.length, 0);
  assert.equal(rt.gate, null);
  // off() called for each registered listener
  assert.ok(offed.length >= 2, `expected >=2 off() calls, got ${offed.length}`);
  const offedEvents = offed.map((o) => o.event);
  assert.ok(offedEvents.includes("agent/pre-step"));
  assert.ok(offedEvents.includes("approval/request"));
});

// --- W4-B: real-behaviour coverage for `_buildAcpRequester()` ------------
//
// These tests were added per t30 to upgrade W4-B coverage from the source-text
// guard at test/http-gateway-bidi.test.mjs:165-179 (which the same file labels
// as "非行为覆盖") to true behavioural coverage by driving the actual method
// against fake clients/gates. The mapping table below mirrors the production
// rules at lib/long-runtime.mjs:246-270.

/** Install a fake `_liveAcpClient` whose `request()` returns `reply`. */
function withLiveClient(rt, reply) {
  rt._liveAcpClient = {
    async request(_method, _params) {
      return reply;
    },
  };
  rt._activeSessionId = "sess-W4B";
}

/** Drive `_buildAcpRequester().request(...)` and resolve to its return value. */
async function driveRequest(rt) {
  const requester = rt._buildAcpRequester();
  return await requester.request("tc-W4B", "W4-B title", []);
}

// P0-1 (2026-10-14): optionId is now declared by the server (permission-gate
// options) with hyphenated ids mirroring claude-agent-acp (allow-once /
// allow-always / reject). The client echoes the DECLARED id, so we match
// exactly on those. (Previously no optionId was declared at all, so the old
// underscore/prefix assertions tested an impossible scenario.)
test("P0-1: _buildAcpRequester maps optionId='allow-once' → 'allow_once'", async () => {
  const rt = new LongRuntime();
  withLiveClient(rt, { outcome: { outcome: "selected", optionId: "allow-once" } });
  assert.equal(await driveRequest(rt), "allow_once");
});

test("P0-1: _buildAcpRequester maps optionId='allow-always' → 'allow_always'", async () => {
  const rt = new LongRuntime();
  withLiveClient(rt, { outcome: { outcome: "selected", optionId: "allow-always" } });
  assert.equal(await driveRequest(rt), "allow_always");
});

test("P0-1: _buildAcpRequester maps optionId='reject' → 'reject_once'", async () => {
  const rt = new LongRuntime();
  withLiveClient(rt, { outcome: { outcome: "selected", optionId: "reject" } });
  assert.equal(await driveRequest(rt), "reject_once");
});

test("P0-1: legacy underscore optionId is NOT accepted (exact match, no prefix)", async () => {
  const rt = new LongRuntime();
  withLiveClient(rt, { outcome: { outcome: "selected", optionId: "allow_once" } });
  assert.equal(await driveRequest(rt), "deny", "must not accept an undeclared optionId form");
});

test("W4-B: _buildAcpRequester maps {outcome:{outcome:'cancelled'}} (no optionId) → 'reject_once'", async () => {
  const rt = new LongRuntime();
  withLiveClient(rt, { outcome: { outcome: "cancelled" } });
  assert.equal(await driveRequest(rt), "reject_once");
});

test("W4-B: _buildAcpRequester maps unknown optionId → 'deny' (fallback)", async () => {
  const rt = new LongRuntime();
  withLiveClient(rt, { outcome: { outcome: "selected", optionId: "weird_unknown_value" } });
  assert.equal(await driveRequest(rt), "deny");
});

test("W4-B: _buildAcpRequester maps missing optionId ({outcome:{}}) → 'deny' (fallback)", async () => {
  const rt = new LongRuntime();
  withLiveClient(rt, { outcome: {} });
  assert.equal(await driveRequest(rt), "deny");
});

test("W4-B: _buildAcpRequester maps null return value → 'deny' (fallback)", async () => {
  const rt = new LongRuntime();
  withLiveClient(rt, null);
  assert.equal(await driveRequest(rt), "deny");
});

test("W4-B: _buildAcpRequester maps undefined return value → 'deny' (fallback)", async () => {
  const rt = new LongRuntime();
  withLiveClient(rt, undefined);
  assert.equal(await driveRequest(rt), "deny");
});

test("W4-B: _buildAcpRequester catches thrown error → 'deny'", async () => {
  const rt = new LongRuntime();
  rt._liveAcpClient = {
    async request() {
      throw new Error("boom");
    },
  };
  rt._activeSessionId = "sess-W4B";
  assert.equal(await driveRequest(rt), "deny");
});

test("W4-B: _buildAcpRequester returns 'deny' when _liveAcpClient is null", async () => {
  const rt = new LongRuntime();
  rt._liveAcpClient = null;
  rt._activeSessionId = "sess-W4B";
  assert.equal(await driveRequest(rt), "deny");
});

test("W4-B: _buildAcpRequester returns 'deny' when client has no request function", async () => {
  const rt = new LongRuntime();
  rt._liveAcpClient = { request: "not a function" };
  rt._activeSessionId = "sess-W4B";
  assert.equal(await driveRequest(rt), "deny");
});

// --- W4-B: real-behaviour coverage for `dispose()` ↔ `gate.clearCache()` --
//
// The existing 'dispose: detaches all agent listeners + clears gate cache'
// test only asserts structural end-state (rt.gate === null) without a recording
// fake gate, so it cannot prove clearCache() was actually invoked. This test
// installs a recording fake gate and asserts the call exactly once + gate
// becomes null + a second dispose() is safe (idempotent under ?. guards).

test("W4-B: dispose() invokes gate.clearCache() exactly once and nulls gate (idempotent)", async () => {
  const rt = new LongRuntime();
  const calls = [];
  rt.gate = {
    clearCache() {
      calls.push("clearCache");
    },
  };

  await rt.dispose();

  assert.deepEqual(calls, ["clearCache"], "clearCache must be invoked exactly once");
  assert.equal(rt.gate, null, "gate must be nulled after dispose");

  // Second dispose: gate is already null, ?. guards must keep this safe.
  await assert.doesNotReject(() => rt.dispose(), "dispose() must be safe to call twice");
});
