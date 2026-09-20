// test/official-bridge-realllm-tool.test.mjs — #96 收尾: 真 LLM tool_call 形状实证.
//
// Drives the SAME real reasoning LLM (self-hosted Qwen3.8 via example-llm) into a
// REAL tool call through BOTH event producers, then asserts the raw session/update
// tool frames match the translation-layer spec table.
//
//   - legacy  : ctx.llm.stream({provider, model, messages, tools}) → LLMStreamBridge
//               → chunk-mapper. Only ever emits tool_call_update (in_progress +
//               completed+rawInput); NEVER emits tool_call.
//   - official: apply() → dsh agent loop (a noop tool registered via ctx.tools so
//               the loop ships its schema + executes it). Emits tool_call (start)
//               then tool_call_update (finish, content:[]), and delivers the tool
//               RESULT as a trailing agent_message_chunk, not on the finish frame.
//
// This is the empirical basis for lib spec
//   docs/实施计划/dsh-acp-official-bridge-tool-translation-spec.md
// (translation rules: cache start.rawInput by toolCallId; drop the empty content:[]).
//
// ENV-GATED: skips (node:test skip) unless DSH_ACP_REAL_LLM_KEY is set. Never part
// of the default unit CI run. Run manually:
//   export DSH_ACP_REAL_LLM_KEY="$(grep '^VISUAL_API_KEY=' <path-to>/.env | cut -d= -f2- | tr -d '\"')"
//   node --test test/official-bridge-realllm-tool.test.mjs
// Endpoint + model id default to the constants in test/fixtures/qwen-shenke-adapter.mjs
// (qwenRealConfig) and are overridable via DSH_ACP_REAL_LLM_BASE(_URL) /
// DSH_ACP_REAL_LLM_MODEL — deliberately NOT hard-coded here (the endpoint's model
// list changes). Discover the live list:
//   curl -H "Authorization: Bearer $DSH_ACP_REAL_LLM_KEY" "$BASE/models"
// The key only ever comes from env in THIS process — never printed or committed.
// Real-LLM tool 实证 is a #96 (收尾) artifact; #95 itself uses only the stub LLM.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";

import { createOfficialAcpRouter } from "../lib/acp-official-router.mjs";
import { LLMStreamBridge } from "../lib/llm-event-bridge.mjs";
import { bootSpikeContext } from "./fixtures/spike-bootstrap.mjs";
import {
  QwenShenkeAdapter,
  QWEN_REAL_PROVIDER,
  qwenRealConfig,
  qwenRealEnabled,
} from "./fixtures/qwen-shenke-adapter.mjs";

const REAL_ENABLED = qwenRealEnabled();

// A noop tool whose schema the model can trigger; registerable via ctx.tools
// (output.schema is object-rooted, render is a function) and executable.
const NOOP_TOOL = {
  name: "get_cwd",
  description: "Return the absolute current working directory path as a single string.",
  parameters: { type: "object", properties: {}, additionalProperties: false },
  output: {
    schema: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
      additionalProperties: false,
    },
    render: (result) => (typeof result === "string" ? result : JSON.stringify(result)),
  },
  async execute() {
    return { path: process.cwd() };
  },
};

const TOOL_PROMPT =
  "Use the get_cwd tool to find the current working directory, then reply with one short line giving that path.";

let bootLegacy; // ctx A — legacy producer
let bootOfficial; // ctx B — official producer

before(async () => {
  if (!REAL_ENABLED) return;
  const cfg = qwenRealConfig();
  const adapter = new QwenShenkeAdapter(cfg);

  bootLegacy = await bootSpikeContext();
  bootLegacy.ctx.llm.registerAdapter([QWEN_REAL_PROVIDER], adapter);

  bootOfficial = await bootSpikeContext();
  bootOfficial.ctx.llm.registerAdapter([QWEN_REAL_PROVIDER], adapter);
  // The agent loop reads tool schemas from ctx.tools and executes the tool by name.
  bootOfficial.ctx.tools.register({ ...NOOP_TOOL });
});

after(async () => {
  if (!REAL_ENABLED) return;
  await bootLegacy?.dispose();
  await bootOfficial?.dispose();
});

const WAIT_MS = 120_000;
async function withinTimeout(p, label) {
  return Promise.race([
    p,
    new Promise((_, rej) => setTimeout(() => rej(new Error(`${label} timed out after ${WAIT_MS}ms`)), WAIT_MS)),
  ]);
}

test(
  "#96 tool_call 实证 (env-gated): official + legacy tool 帧对照 matches translation spec",
  { skip: !REAL_ENABLED },
  async () => {
    const cfg = qwenRealConfig();

    // ---------- OFFICIAL ----------
    const router = createOfficialAcpRouter(bootOfficial.ctx, {
      provider: QWEN_REAL_PROVIDER,
      model: cfg.model,
    });
    const official = []; // {sessionId, update}
    await withinTimeout(
      router.prompt("official-tool-sess", {
        prompt: [{ type: "text", text: TOOL_PROMPT }],
        model: cfg.model,
        onUpdate: (params) => official.push(params),
      }),
      "official prompt",
    );
    router.close();

    const oStart = official.find((f) => f.update?.sessionUpdate === "tool_call");
    const oFinish = official.find(
      (f) => f.update?.sessionUpdate === "tool_call_update" && f.update?.status === "completed",
    );
    // The tool RESULT is normally delivered as a trailing agent_message_chunk, but
    // its presence is model/determinism-dependent and it races the session/prompt
    // result. It is ordinary message passthrough (not the tool-frame translation
    // contract) — poll briefly for it, but only soft-log if the model ended the
    // turn without a visible text message.
    const oResult = await pollForMessage(official, 6_000);
    assert.ok(oStart, "official did not emit tool_call (start)");
    assert.ok(oFinish, "official did not emit tool_call_update completed");
    assert.equal(oStart.update.kind, "other");
    assert.equal(oStart.update.status, "in_progress");
    assert.equal(oStart.update.title, NOOP_TOOL.name);
    assert.ok(oStart.update.rawInput !== undefined, "official start rawInput present");
    // Empirical caveat: official finish frame has NO rawInput (it lives on start).
    assert.equal(oFinish.update.rawInput, undefined, "official finish rawInput absent (cached on start)");
    // Empirical caveat: official finish content is an EMPTY array, not nested blocks.
    assert.ok(Array.isArray(oFinish.update.content), "official finish content is array");
    assert.equal(oFinish.update.content.length, 0, "official finish content empty [] (drop in translation)");

    // ---------- LEGACY ----------
    const legacy = [];
    const bridge = new LLMStreamBridge({ onUpdate: (u) => legacy.push(u) });
    await withinTimeout(
      bridge.pump(
        bootLegacy.ctx.llm.stream({
          provider: QWEN_REAL_PROVIDER,
          model: cfg.model,
          messages: [{ role: "user", content: [{ type: "text", text: TOOL_PROMPT }] }],
          tools: [NOOP_TOOL],
        }),
      ),
      "legacy stream",
    );

    const lInProgress = legacy.filter(
      (u) => u?.sessionUpdate === "tool_call_update" && u?.status === "in_progress",
    );
    const lFinish = legacy.find(
      (u) => u?.sessionUpdate === "tool_call_update" && u?.status === "completed",
    );
    const lMsg = legacy.find((u) => u?.sessionUpdate === "agent_message_chunk");
    // Legacy NEVER emits tool_call — only tool_call_update (spec: translation must
    // synthesize the in_progress from official's tool_call).
    assert.ok(!legacy.some((u) => u?.sessionUpdate === "tool_call"), "legacy must not emit tool_call");
    assert.ok(lInProgress.length > 0, "legacy did not emit tool_call_update in_progress");
    assert.ok(lFinish, "legacy did not emit tool_call_update completed");
    // lMsg is intentionally SOFT (see 对照 section): the model sometimes ends the
    // turn right after the tool call without a visible closing text message —
    // nondeterministic model behavior, not a tool-frame spec break.
    assert.ok(lInProgress[0].title, "legacy in_progress carries title");
    assert.equal(lFinish.rawInput !== undefined, true, "legacy completed carries rawInput");
    // Empirical caveat: legacy completed has NO content key (tool block has none).
    assert.equal(lFinish.content, undefined, "legacy completed has no content key");

    // ---------- 对照 : the translation-layer input table ----------
    // official 开始 (tool_call)  vs legacy 开始 (tool_call_update in_progress)
    assert.equal(oStart.update.sessionUpdate, "tool_call");
    assert.equal(lInProgress[0].sessionUpdate, "tool_call_update");
    // official 结束 (tool_call_update completed content:[]) vs legacy 结束 (completed rawInput)
    assert.equal(oFinish.update.sessionUpdate, "tool_call_update");
    assert.equal(oFinish.update.status, "completed");
    assert.equal(lFinish.sessionUpdate, "tool_call_update");
    assert.equal(lFinish.status, "completed");
    // toolCallId forms are both strings (32-char hex/uuid style).
    assert.equal(typeof oStart.update.toolCallId, "string");
    assert.equal(typeof lFinish.toolCallId, "string");
    // Both producers land the tool RESULT as a trailing agent_message_chunk
    // (soft — see above; verified when the model emits a visible closing text).
    if (oResult) assert.equal(oResult.update.content.type, "text");
    if (lMsg) assert.equal(lMsg.content.type, "text");
  },
);

/** Poll `frames` up to `ms` for an agent_message_chunk (late-flushed frames). */
async function pollForMessage(frames, ms) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const hit = frames.find((f) => f.update?.sessionUpdate === "agent_message_chunk");
    if (hit) return hit;
    await new Promise((r) => setTimeout(r, 100));
  }
  return frames.find((f) => f.update?.sessionUpdate === "agent_message_chunk");
}
