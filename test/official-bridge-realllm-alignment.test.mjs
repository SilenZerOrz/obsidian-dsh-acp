// test/official-bridge-realllm-alignment.test.mjs — #96 真 LLM 冒烟验证字段对齐.
//
// Drives the SAME real reasoning LLM (self-hosted Qwen3.8 via example-llm) through
// BOTH event producers and JSON-diffs the session/update ENVELOPE SHAPES:
//   - legacy : LongRuntime → ctx.llm.stream → LLMStreamBridge → chunk-mapper
//   - official: apply() → dsh agent loop → apply()'s own session/update builder
//
// Goal per the user's second-cut directive: validate the "official update shape ==
// legacy update shape" assumption that #95's router depends on. If message/thought
// chunk shapes align → the router can forward them verbatim; usage_update / tool
// events carry known caveats (see below) that #95 must handle.
//
// ENV-GATED: skips (node:test skip) unless DSH_ACP_REAL_LLM_KEY is set. Never part
// of the default CI run. Run manually:
//   export DSH_ACP_REAL_LLM_KEY="$(grep '^VISUAL_API_KEY=' <path-to>/.env | cut -d= -f2- | tr -d '\"')"
//   node --test test/official-bridge-realllm-alignment.test.mjs
// Endpoint + model id default to the constants in test/fixtures/qwen-shenke-adapter.mjs
// (qwenRealConfig) and are overridable via DSH_ACP_REAL_LLM_BASE(_URL) /
// DSH_ACP_REAL_LLM_MODEL — deliberately NOT hard-coded here, because the self-hosted
// endpoint's model list changes over time. To discover the live list:
//   curl -H "Authorization: Bearer $DSH_ACP_REAL_LLM_KEY" "$BASE/models"
// The key only ever comes from env in THIS process — it is never printed or committed.
//
// Not covered here (per #96 scope): bash execution, approval popup, tool result
// correctness, multi-session, MCP mounting. Tool SHAPE divergence (official emits
// sessionUpdate:"tool_call" + nested-content tool_call_update; legacy only emits
// tool_call_update with rawInput) is code-confirmed in dsh-acp index.js:591-629 vs
// chunk-mapper.mjs:147-201 and is deferred to #95 (needs MCP server to elicit).

import { test, before, after } from "node:test";
import assert from "node:assert/strict";

import { LongRuntime } from "../lib/long-runtime.mjs";
import { createOfficialAcpRouter } from "../lib/acp-official-router.mjs";
import { bootSpikeContext } from "./fixtures/spike-bootstrap.mjs";
import {
  QwenShenkeAdapter,
  QWEN_REAL_PROVIDER,
  qwenRealConfig,
  qwenRealEnabled,
} from "./fixtures/qwen-shenke-adapter.mjs";

const REAL_ENABLED = qwenRealEnabled();

// Prompt that forces the reasoning model to emit real `reasoning_content`
// (→ agent_thought_chunk) and then a short visible answer.
const REASONING_PROMPT = "Think step by step, then reply with just the product: 17 * 23 = ?";

// --- frame collection -------------------------------------------------------
function makeFrameSink() {
  const frames = []; // each = { sessionId, update }
  const sink = {
    frames,
    notify: async (_method, params) => { frames.push(params); },
    onUpdate: (params) => { frames.push(params); },
  };
  return sink;
}

/** Envelope shape of one update: {sessionUpdate, keys, valueKinds} — text-insensitive. */
function shapeOf(update) {
  const keys = Object.keys(update).sort();
  return {
    sessionUpdate: update.sessionUpdate,
    keys,
    kinds: keys.map((k) => (Array.isArray(update[k]) ? "array" : typeof update[k])),
  };
}

// Which update types we require to appear in BOTH producers, and that their shapes align.
function assertCoreAlignment(legacyFrames, officialFrames) {
  const group = (frames) =>
    frames.reduce((m, f) => {
      const u = f?.update;
      if (!u?.sessionUpdate) return m;
      (m[u.sessionUpdate] ??= []).push(u);
      return m;
    }, {});

  const L = group(legacyFrames);
  const O = group(officialFrames);

  // 1. message/thought chunks MUST appear in both and align.
  for (const type of ["agent_message_chunk", "agent_thought_chunk"]) {
    const l = L[type];
    const o = O[type];
    assert.ok(l?.length, `legacy did not emit ${type}`);
    assert.ok(o?.length, `official did not emit ${type}`);
    const lShape = shapeOf(l[0]);
    const oShape = shapeOf(o[0]);
    assert.deepEqual(
      oShape,
      lShape,
      `shape mismatch for ${type}:\nofficial=${JSON.stringify(oShape)}\nlegacy=${JSON.stringify(lShape)}\n` +
        `official sample=${JSON.stringify(o[0])}\nlegacy sample=${JSON.stringify(l[0])}`,
    );
    // Both use content:{type:"text",text}.
    for (const u of [...l, ...o]) {
      assert.equal(u.content?.type, "text", `${type}.content.type`);
      assert.equal(typeof u.content?.text, "string", `${type}.content.text is string`);
      assert.ok(u.messageId, `${type}.messageId present`);
    }
  }

  // 2. usage_update — aligned IF both emitted it (official may omit: needs tokenMeter).
  if (O.usage_update?.length && L.usage_update?.length) {
    assert.deepEqual(shapeOf(O.usage_update[0]), shapeOf(L.usage_update[0]), "usage_update shape");
  } else if (O.usage_update?.length) {
    // reported, not fatal
    // eslint-disable-next-line no-console
    console.log("[realllm] note: official emitted usage_update, legacy did not");
  } else {
    // eslint-disable-next-line no-console
    console.log("[realllm] note: official emitted no usage_update (spike-bare may lack tokenMeter)");
  }
}

// --- env gate + boot ---------------------------------------------------------
let bootA; // legacy ctx
let bootB; // official ctx

before(async () => {
  if (!REAL_ENABLED) return;
  const config = qwenRealConfig();
  bootA = await bootSpikeContext();
  bootB = await bootSpikeContext();
  const adapter = new QwenShenkeAdapter(config);
  bootA.ctx.llm.registerAdapter([QWEN_REAL_PROVIDER], adapter);
  bootB.ctx.llm.registerAdapter([QWEN_REAL_PROVIDER], adapter);
});

after(async () => {
  if (!REAL_ENABLED) return;
  await bootA?.dispose();
  await bootB?.dispose();
});

const WAIT_MS = 90_000;
async function withinTimeout(p, label) {
  return Promise.race([
    p,
    new Promise((_, rej) => setTimeout(() => rej(new Error(`${label} timed out after ${WAIT_MS}ms`)), WAIT_MS)),
  ]);
}

// --- tests -------------------------------------------------------------------
test("#96 real-LLM: legacy LongRuntime → chunk-mapper frames (reasoning + text)", { skip: !REAL_ENABLED }, async () => {
  const cfg = qwenRealConfig();
  const sink = makeFrameSink();
  const rt = new LongRuntime();
  await rt.init({
    cordisCtx: bootA.ctx,
    acpClient: sink,
    model: cfg.model,
    permissionConfig: { mode: "acceptEdits", editTools: [] },
  });
  const result = await withinTimeout(
    rt.prompt({
      sessionId: "legacy-sess",
      prompt: [{ type: "text", text: REASONING_PROMPT }],
      sessionConfig: { provider: QWEN_REAL_PROVIDER, model: cfg.model },
    }),
    "legacy prompt",
  );
  await rt.dispose();
  sink.legacyResult = result;

  const types = new Set(sink.frames.map((f) => f.update?.sessionUpdate));
  // eslint-disable-next-line no-console
  console.log(`[realllm] legacy types=${[...types].join(",")} stopReason=${result.stopReason}`);
  assert.ok(sink.frames.length > 0, "legacy emitted no frames");
  assert.ok(result.stopReason !== undefined, "legacy returned stopReason");
  global.__realllm_legacy = sink;
});

test("#96 real-LLM: official apply() → agent-loop frames (reasoning + text)", { skip: !REAL_ENABLED }, async () => {
  const cfg = qwenRealConfig();
  const sink = makeFrameSink();
  const router = createOfficialAcpRouter(bootB.ctx, {
    provider: QWEN_REAL_PROVIDER,
    model: cfg.model,
  });
  const result = await withinTimeout(
    router.prompt("official-sess", {
      prompt: [{ type: "text", text: REASONING_PROMPT }],
      model: cfg.model,
      onUpdate: sink.onUpdate,
    }),
    "official prompt",
  );
  router.close();
  sink.officialResult = result;

  const types = new Set(sink.frames.map((f) => f.update?.sessionUpdate));
  // eslint-disable-next-line no-console
  console.log(`[realllm] official types=${[...types].join(",")} stopReason=${result.stopReason}`);
  assert.ok(sink.frames.length > 0, "official emitted no frames");
  assert.ok(result.stopReason !== undefined, "official returned stopReason");
  global.__realllm_official = sink;
});

test("#96 real-LLM: message/thought chunk envelope shapes ALIGN across producers", { skip: !REAL_ENABLED }, async () => {
  const legacy = global.__realllm_legacy;
  const official = global.__realllm_official;
  assert.ok(legacy, "run legacy test first");
  assert.ok(official, "run official test first");
  assertCoreAlignment(legacy.frames, official.frames);
});
