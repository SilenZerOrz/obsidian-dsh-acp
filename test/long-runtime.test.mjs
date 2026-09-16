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
  // 4 text chunks (init + 2 deltas + end) + 1 usage_update = 5 total
  assert.equal(updates.length, 5);
  const textUpdates = updates.filter((u) => u.sessionUpdate === "agent_message_chunk");
  const usageUpdates = updates.filter((u) => u.sessionUpdate === "usage_update");
  assert.equal(textUpdates.length, 4);
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

test("prompt: tool-call stream emits in_progress then completed", async () => {
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

  const toolUpdates = client.sent
    .filter((s) => s.method === "session/update")
    .map((s) => s.params.update)
    .filter((u) => u.sessionUpdate === "tool_call_update");
  assert.equal(toolUpdates.length, 3); // 2 in_progress + 1 completed
  assert.equal(toolUpdates[0].status, "in_progress");
  assert.equal(toolUpdates[2].status, "completed");
  assert.equal(toolUpdates[2].toolCallId, "tc1");
  assert.deepEqual(toolUpdates[2].rawInput, { p: "x" });
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
  assert.equal(capturedOpts.messages[0].content, "first");
  assert.equal(capturedOpts.messages[2].content, "second turn");
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
  assert.equal(opts.messages[0].content, "hi");
});

test("buildStreamOptions: defaults provider to 'default' and keeps bare model id", () => {
  const opts = buildStreamOptions({
    promptText: "hi",
    sessionConfig: { model: "DeepSeek-V4-Flash" },
    defaultModel: null,
    history: [],
    cwd: "/tmp",
  });
  assert.equal(opts.provider, "default");
  assert.equal(opts.model, "DeepSeek-V4-Flash");
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

test("buildStreamOptions: throws when no model is resolvable", () => {
  assert.throws(
    () =>
      buildStreamOptions({
        promptText: "hi",
        sessionConfig: {},
        defaultModel: null,
        history: [],
        cwd: "/tmp",
      }),
    /no model configured/,
  );
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
      return { outcome: { outcome: "selected", optionId: "allow_once" } };
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
      return { outcome: { outcome: "selected", optionId: "reject_once" } };
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
      return { outcome: { outcome: "selected", optionId: "allow_once" } };
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
      return { outcome: { outcome: "selected", optionId: "allow_once" } };
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
