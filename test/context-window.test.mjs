// test/context-window.test.mjs — P2-3 (R142 / 卡 -72) `usage_update.size` 自动解析.
//
// 判据（评审者 2026-11-15 下发）：
//   ① 无 env 覆盖时 `size` > 0（自动探测，而非只靠手工 env）；
//   ② spawn 路径不再硬编码 0。
//
// 覆盖三层：
//   A. lib/context-window.mjs 的解析顺序（profile 声明 → 路由默认 → dsh 编译默认 → 未知）
//   B. long/proxy 路径（chunk-mapper → LLMStreamBridge）
//   C. spawn 路径（headless-json-parser）
//
// 确定性的关键：A 组全部注入 profileText / dshDefault，不读开发机的 ~/.dsh；
// B/C 组把 DSH_ACP_CONTEXT_WINDOW 清空后断言 size > 0，并额外断言 env 仍然最高优先。

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import {
  resolveContextWindowCeiling,
  contextWindowFor,
  resetContextWindowCache,
} from "../lib/context-window.mjs";
import { chunkToUpdate, createMapperState } from "../lib/chunk-mapper.mjs";
import { LLMStreamBridge } from "../lib/llm-event-bridge.mjs";
import { createHeadlessParser } from "../lib/headless-json-parser.mjs";
import { parseProviderCatalog } from "../lib/settings-provider-catalog.mjs";

const ORIGINAL_CW = process.env.DSH_ACP_CONTEXT_WINDOW;

beforeEach(() => {
  delete process.env.DSH_ACP_CONTEXT_WINDOW;
  resetContextWindowCache();
});

afterEach(() => {
  if (ORIGINAL_CW === undefined) delete process.env.DSH_ACP_CONTEXT_WINDOW;
  else process.env.DSH_ACP_CONTEXT_WINDOW = ORIGINAL_CW;
  resetContextWindowCache();
});

/** Minimal profile body: one provider, one model, explicit contextWindow. */
const PROFILE_WITH_CEILING = `
- id: llm-pi-ai
  name: "@deepseek-ai/dsh-llm-pi-ai"
  config:
    providers:
      acme:
        displayName: Acme
        apiKeyEnv: ACME_API_KEY
        api: openai-completions
        baseURL: http://llm.example.com/v1
        models:
          - id: big-model
            name: Big Model
            contextWindow: 409600
          - id: small-model
            name: Small Model
`;

/** Profile with NO per-model ceiling but a route-level default. */
const PROFILE_WITH_ROUTE_DEFAULT = `
- id: llm-pi-ai
  name: "@deepseek-ai/dsh-llm-pi-ai"
  config:
    defaultContextWindow: 131072
    providers:
      acme:
        models:
          - id: plain-model
            name: Plain Model
`;

// ===========================================================================
// A. resolution order
// ===========================================================================

test("P2-3: the profile's per-model contextWindow wins", () => {
  const hit = resolveContextWindowCeiling({
    provider: "acme",
    model: "big-model",
    profileText: PROFILE_WITH_CEILING,
    dshDefault: 999999,
  });
  assert.deepEqual(hit, { size: 409600, source: "profile:inline:models[].contextWindow" });
});

test("P2-3: a model WITHOUT its own ceiling falls through to the route default", () => {
  const hit = resolveContextWindowCeiling({
    provider: "acme",
    model: "plain-model",
    profileText: PROFILE_WITH_ROUTE_DEFAULT,
  });
  assert.deepEqual(hit, { size: 131072, source: "profile:inline:defaultContextWindow" });
});

test("P2-3: falls back to dsh's compiled default when the profile declares nothing", () => {
  const hit = resolveContextWindowCeiling({
    provider: "acme",
    model: "small-model",
    profileText: `
- id: llm-pi-ai
  config:
    providers:
      acme:
        models:
          - id: small-model
            name: Small Model
`,
    dshDefault: 1000000,
  });
  assert.equal(hit.size, 1000000);
  assert.match(hit.source, /^dsh:/, `unexpected source: ${hit.source}`);
});

test("P2-3: unreachable ⇒ null (caller keeps 0), never throws", () => {
  const hit = resolveContextWindowCeiling({
    provider: "acme",
    model: "small-model",
    profileText: "",
    dshDefault: 0,
  });
  assert.equal(hit, null);
  assert.equal(contextWindowFor({ profileText: "", dshDefault: 0 }), null);
});

test("P2-3: parseProviderCatalog now carries models[].contextWindow", () => {
  const cat = parseProviderCatalog(PROFILE_WITH_CEILING);
  const big = cat.find((c) => c.model === "big-model");
  const small = cat.find((c) => c.model === "small-model");
  assert.equal(big.contextWindow, 409600);
  assert.equal(small.contextWindow, undefined, "no declaration ⇒ key absent, not 0");
});

// ===========================================================================
// B. long/proxy path (chunk-mapper + bridge)
// ===========================================================================

/** A usage chunk as dsh emits it (no ceiling field at all). */
const USAGE_CHUNK = { type: "usage", usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } };

test("P2-3①: no env ⇒ chunk-mapper emits size > 0 (auto-detected)", () => {
  assert.equal(process.env.DSH_ACP_CONTEXT_WINDOW, undefined, "precondition: env must be unset");
  const u = chunkToUpdate(USAGE_CHUNK, createMapperState());
  assert.equal(u.sessionUpdate, "usage_update");
  assert.equal(u.used, 15);
  assert.equal(typeof u.size, "number");
  assert.ok(u.size > 0, `expected size > 0 with no env override, got ${u.size}`);
});

test("P2-3: the env override still wins over auto-detection", () => {
  process.env.DSH_ACP_CONTEXT_WINDOW = "128000";
  const u = chunkToUpdate(USAGE_CHUNK, createMapperState());
  assert.equal(u.size, 128000, "operator override must not be overridden by the probe");
});

test("P2-3: a producer-supplied ceiling still wins over the env override", () => {
  process.env.DSH_ACP_CONTEXT_WINDOW = "128000";
  const u = chunkToUpdate(
    { type: "usage", usage: { totalTokens: 15, contextWindow: 200000 } },
    createMapperState(),
  );
  assert.equal(u.size, 200000);
});

test("P2-3: an unparsable env override still means unknown (0), not auto-detect", () => {
  // 0.3.6 semantics preserved: the escape hatch stays airtight.
  process.env.DSH_ACP_CONTEXT_WINDOW = "not-a-number";
  const u = chunkToUpdate(USAGE_CHUNK, createMapperState());
  assert.equal(u.size, 0);
});

test("P2-3: LLMStreamBridge forwards its target to the mapper", async () => {
  const seen = [];
  const bridge = new LLMStreamBridge({
    onUpdate: (u) => seen.push(u),
    target: { provider: "minimax-cn", model: "MiniMax-M3" },
  });
  await bridge.pump((async function* () { yield USAGE_CHUNK; })());
  const usage = seen.find((u) => u.sessionUpdate === "usage_update");
  assert.ok(usage, "no usage_update emitted");
  assert.ok(usage.size > 0, `bridge must resolve a ceiling, got ${usage.size}`);
});

test("P2-3: bridge without a target still resolves (env-less auto-detect)", async () => {
  const seen = [];
  const bridge = new LLMStreamBridge({ onUpdate: (u) => seen.push(u) });
  await bridge.pump((async function* () { yield USAGE_CHUNK; })());
  const usage = seen.find((u) => u.sessionUpdate === "usage_update");
  assert.ok(usage.size > 0, `expected size > 0, got ${usage.size}`);
});

// ===========================================================================
// C. spawn path (headless-json-parser)
// ===========================================================================

const STEP_END_LINE = JSON.stringify({
  type: "status",
  phase: "step_end",
  usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
});

test("P2-3②: spawn path no longer hardcodes size: 0", () => {
  assert.equal(process.env.DSH_ACP_CONTEXT_WINDOW, undefined, "precondition: env must be unset");
  const [frame] = createHeadlessParser().push(STEP_END_LINE);
  assert.equal(frame.sessionUpdate, "usage_update");
  assert.equal(frame.used, 150);
  assert.equal(typeof frame.size, "number");
  assert.ok(frame.size > 0, `expected spawn-path size > 0, got ${frame.size}`);
});

test("P2-3: spawn path honours the env override first", () => {
  process.env.DSH_ACP_CONTEXT_WINDOW = "64000";
  const [frame] = createHeadlessParser().push(STEP_END_LINE);
  assert.equal(frame.size, 64000);
});

test("P2-3: spawn path accepts a target and keeps the breakdown fields", () => {
  const [frame] = createHeadlessParser({ provider: "jl-token", model: "gemini-2.5-pro" }).push(STEP_END_LINE);
  assert.ok(frame.size > 0);
  assert.equal(frame.inputTokens, 100);
  assert.equal(frame.outputTokens, 50);
});

// ===========================================================================
// D. both producers agree
// ===========================================================================

test("P2-3: long/proxy and spawn produce the SAME ceiling", () => {
  const long = chunkToUpdate(USAGE_CHUNK, createMapperState());
  const [spawn] = createHeadlessParser().push(STEP_END_LINE);
  assert.equal(long.size, spawn.size, "one rule must govern both producers");
});
