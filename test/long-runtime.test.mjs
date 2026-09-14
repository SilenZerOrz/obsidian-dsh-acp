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

test("buildStreamOptions: extracts provider from 'provider/model' id", () => {
  const opts = buildStreamOptions({
    promptText: "hi",
    sessionConfig: { model: "anthropic/claude-3" },
    defaultModel: null,
    history: [],
    cwd: "/tmp",
  });
  assert.equal(opts.provider, "anthropic");
  assert.equal(opts.model, "anthropic/claude-3");
  assert.equal(opts.messages.length, 1);
  assert.equal(opts.messages[0].role, "user");
  assert.equal(opts.messages[0].content, "hi");
});

test("buildStreamOptions: defaults provider to 'default' for bare model id", () => {
  const opts = buildStreamOptions({
    promptText: "hi",
    sessionConfig: { model: "DeepSeek-V4-Flash" },
    defaultModel: null,
    history: [],
    cwd: "/tmp",
  });
  assert.equal(opts.provider, "default");
});

test("buildStreamOptions: falls back to defaultModel when sessionConfig omits model", () => {
  const opts = buildStreamOptions({
    promptText: "hi",
    sessionConfig: {},
    defaultModel: "default/fb",
    history: [],
    cwd: "/tmp",
  });
  assert.equal(opts.model, "default/fb");
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
