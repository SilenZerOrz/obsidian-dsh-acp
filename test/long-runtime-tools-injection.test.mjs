// test/long-runtime-tools-injection.test.mjs
//
// Hop 0 blocker fix verification — unit tests for the
// `collectToolSchemas(ctx)` helper + the prompt() call site that injects
// `options.tools` into ctx.llm.stream().
//
// Why (2026-09-30): the long-runtime path on dsh web was emitting
// GenerateOptions with no `tools` field, so the LLM had no tool
// definitions and never produced `tool_call` events — every turn ended
// with `stopReason: "end_turn"` and no tool frame. The fix threads
// ToolSchema[] from the cordis ctx into the stream options, mirroring
// what dsh-agent-loop does at dsh-agent-loop/lib/index.js:906 + 1190.
//
// Scope: helper-level (collectToolSchemas) + a thin prompt() smoke that
// asserts the call site actually assigns `options.tools` when at least
// one tool is available. Does NOT spawn a real dsh ctx — uses fakes.

import test from "node:test";
import assert from "node:assert/strict";

import {
  LongRuntime,
  collectToolSchemas,
} from "../lib/long-runtime.mjs";

// --- helpers --------------------------------------------------------------

const TOOL_SCHEMA_A = {
  name: "Read",
  description: "Read a file from disk",
  parameters: { type: "object", properties: { path: { type: "string" } } },
};
const TOOL_SCHEMA_B = {
  name: "Bash",
  description: "Run a shell command",
  parameters: {
    type: "object",
    properties: { command: { type: "string" } },
    required: ["command"],
  },
};

/** Ctx that exposes a systemPrompt.assemble() returning asm.tools. */
function fakeCtxWithSystemPrompt(tools) {
  return {
    systemPrompt: {
      async assemble() {
        return { tools };
      },
    },
    logger: { warn() {} },
  };
}

/** Ctx that exposes tools.wireSchemas() returning {schemas}. */
function fakeCtxWithToolRuntime(schemas) {
  return {
    tools: {
      wireSchemas(scope) {
        return { schemas, knownNames: schemas.map((s) => s.name) };
      },
    },
    logger: { warn() {} },
  };
}

/** Ctx that throws inside systemPrompt.assemble(). */
function fakeCtxThrowingSystemPrompt(err) {
  return {
    systemPrompt: {
      async assemble() {
        throw err;
      },
    },
    tools: {
      wireSchemas() {
        return { schemas: [TOOL_SCHEMA_A, TOOL_SCHEMA_B], knownNames: ["Read", "Bash"] };
      },
    },
    logger: { warn() {} },
  };
}

/** Ctx with neither service — empty path. */
function fakeCtxEmpty() {
  return { logger: { warn() {} } };
}

// --- collectToolSchemas direct --------------------------------------------

test("collectToolSchemas: returns tools from systemPrompt.assemble() (preferred)", async () => {
  const ctx = fakeCtxWithSystemPrompt([TOOL_SCHEMA_A, TOOL_SCHEMA_B]);
  const result = await collectToolSchemas(ctx);
  assert.equal(result.length, 2);
  assert.equal(result[0].name, "Read");
  assert.equal(result[1].name, "Bash");
  assert.ok(result[0].parameters, "parameters preserved");
});

test("collectToolSchemas: returns tools from tools.wireSchemas() (fallback)", async () => {
  // No systemPrompt service; only ToolRuntime available.
  const ctx = fakeCtxWithToolRuntime([TOOL_SCHEMA_A]);
  const result = await collectToolSchemas(ctx);
  assert.equal(result.length, 1);
  assert.equal(result[0].name, "Read");
});

test("collectToolSchemas: falls back to wireSchemas when systemPrompt returns empty", async () => {
  // systemPrompt present but asm.tools is empty → use tools.wireSchemas.
  const ctx = {
    systemPrompt: { async assemble() { return { tools: [] }; } },
    tools: {
      wireSchemas() {
        return { schemas: [TOOL_SCHEMA_B], knownNames: ["Bash"] };
      },
    },
    logger: { warn() {} },
  };
  const result = await collectToolSchemas(ctx);
  assert.equal(result.length, 1);
  assert.equal(result[0].name, "Bash");
});

test("collectToolSchemas: throws → returns [] and does not throw", async () => {
  const ctx = fakeCtxThrowingSystemPrompt(new Error("systemPrompt down"));
  const result = await collectToolSchemas(ctx);
  // Fallback to wireSchemas is consulted BEFORE the catch — see
  // implementation order. So if systemPrompt throws AND tools is
  // available, the fallback should still fire.
  // To strictly assert the catch path, remove tools from the ctx:
  delete ctx.tools;
  const result2 = await collectToolSchemas(ctx);
  assert.deepEqual(result, []);
  assert.deepEqual(result2, []);
});

test("collectToolSchemas: empty ctx returns []", async () => {
  const result = await collectToolSchemas(fakeCtxEmpty());
  assert.deepEqual(result, []);
});

test("collectToolSchemas: null/undefined ctx returns [] without throw", async () => {
  assert.deepEqual(await collectToolSchemas(null), []);
  assert.deepEqual(await collectToolSchemas(undefined), []);
});

// --- prompt() call site ----------------------------------------------------

test("A3: LongRuntime.prompt: default (no DSH_ACP_LONG_TOOLS) does NOT inject options.tools", async () => {
  // H1 fix: the long/proxy path has no tool executor, so tool schemas are
  // NOT exposed by default (would make the model request unexecutable tools).
  const prev = process.env.DSH_ACP_LONG_TOOLS;
  delete process.env.DSH_ACP_LONG_TOOLS;
  try {
    let capturedOptions = null;
    const ctx = {
      llm: { async *stream(opts) { capturedOptions = opts; yield { type: "finish", finishReason: "stop" }; } },
      systemPrompt: { async assemble() { return { tools: [TOOL_SCHEMA_A, TOOL_SCHEMA_B] }; } },
      off() {}, on() {}, logger: { warn() {} },
    };
    const rt = new LongRuntime();
    await rt.init({ cordisCtx: ctx, acpClient: { notify() {}, request() {} } });
    await rt.prompt({ sessionId: "s", prompt: "hello", sessionConfig: { model: "M", provider: "test" } });
    assert.ok(capturedOptions, "stream was invoked");
    assert.equal(capturedOptions.tools, undefined, "default must NOT expose tools (no executor)");
  } finally {
    if (prev === undefined) delete process.env.DSH_ACP_LONG_TOOLS; else process.env.DSH_ACP_LONG_TOOLS = prev;
  }
});

test("LongRuntime.prompt: DSH_ACP_LONG_TOOLS=1 injects options.tools when tools available", async () => {
  const prev = process.env.DSH_ACP_LONG_TOOLS;
  process.env.DSH_ACP_LONG_TOOLS = "1";
  try {
  let capturedOptions = null;
  const ctx = {
    llm: {
      async *stream(opts) {
        capturedOptions = opts;
        yield { type: "finish", finishReason: "stop", usage: { used: 0 } };
      },
    },
    systemPrompt: {
      async assemble() {
        return { tools: [TOOL_SCHEMA_A, TOOL_SCHEMA_B] };
      },
    },
    off() {},
    on() {},
    logger: { warn() {} },
  };

  const rt = new LongRuntime();
  await rt.init({ cordisCtx: ctx, acpClient: { notify() {}, request() {} } });
  const result = await rt.prompt({
    sessionId: "test-session",
    prompt: "hello",
    sessionConfig: { model: "TestModel", provider: "test" },
  });

  assert.ok(capturedOptions, "stream was invoked");
  assert.ok(Array.isArray(capturedOptions.tools), "options.tools is an array");
  assert.equal(capturedOptions.tools.length, 2);
  assert.equal(capturedOptions.tools[0].name, "Read");
  assert.equal(capturedOptions.tools[1].name, "Bash");
  assert.equal(result.stopReason, "end_turn");
  } finally {
    if (prev === undefined) delete process.env.DSH_ACP_LONG_TOOLS; else process.env.DSH_ACP_LONG_TOOLS = prev;
  }
});

test("LongRuntime.prompt: injects options.tools via wireSchemas fallback when systemPrompt absent", async () => {
  const prev = process.env.DSH_ACP_LONG_TOOLS;
  process.env.DSH_ACP_LONG_TOOLS = "1"; // A3: tools now opt-in
  try {
  let capturedOptions = null;
  const ctx = {
    llm: {
      async *stream(opts) {
        capturedOptions = opts;
        yield { type: "finish", finishReason: "stop" };
      },
    },
    tools: {
      wireSchemas() {
        return { schemas: [TOOL_SCHEMA_A], knownNames: ["Read"] };
      },
    },
    off() {},
    on() {},
    logger: { warn() {} },
  };

  const rt = new LongRuntime();
  await rt.init({ cordisCtx: ctx, acpClient: { notify() {}, request() {} } });
  await rt.prompt({
    sessionId: "test-session",
    prompt: "read foo",
    sessionConfig: { model: "TestModel", provider: "test" },
  });

  assert.ok(capturedOptions);
  assert.ok(Array.isArray(capturedOptions.tools));
  assert.equal(capturedOptions.tools.length, 1);
  assert.equal(capturedOptions.tools[0].name, "Read");
  } finally {
    if (prev === undefined) delete process.env.DSH_ACP_LONG_TOOLS; else process.env.DSH_ACP_LONG_TOOLS = prev;
  }
});

test("LongRuntime.prompt: options.tools absent when neither service exposes tools (preserves prior behavior)", async () => {
  let capturedOptions = null;
  const ctx = {
    llm: {
      async *stream(opts) {
        capturedOptions = opts;
        yield { type: "finish", finishReason: "stop" };
      },
    },
    off() {},
    on() {},
    logger: { warn() {} },
  };

  const rt = new LongRuntime();
  await rt.init({ cordisCtx: ctx, acpClient: { notify() {}, request() {} } });
  await rt.prompt({
    sessionId: "test-session",
    prompt: "hi",
    sessionConfig: { model: "TestModel", provider: "test" },
  });

  assert.ok(capturedOptions);
  assert.equal(
    capturedOptions.tools,
    undefined,
    "tools must NOT be set when no tools service exists (avoids asserting [] which downstream treats differently)",
  );
});

test("LongRuntime.prompt: tools service throws → options.tools unset, no throw", async () => {
  let capturedOptions = null;
  const ctx = {
    llm: {
      async *stream(opts) {
        capturedOptions = opts;
        yield { type: "finish", finishReason: "stop" };
      },
    },
    systemPrompt: {
      async assemble() {
        throw new Error("assemble exploded");
      },
    },
    tools: {
      wireSchemas() {
        throw new Error("wireSchemas exploded");
      },
    },
    off() {},
    on() {},
    logger: { warn() {} },
  };

  const rt = new LongRuntime();
  await rt.init({ cordisCtx: ctx, acpClient: { notify() {}, request() {} } });
  const result = await rt.prompt({
    sessionId: "test-session",
    prompt: "hi",
    sessionConfig: { model: "TestModel", provider: "test" },
  });

  assert.ok(capturedOptions);
  assert.equal(capturedOptions.tools, undefined, "both services threw → no tools");
  assert.equal(result.stopReason, "end_turn", "turn still completes");
});