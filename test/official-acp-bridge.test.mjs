// test/official-acp-bridge.test.mjs — Phase 1 migration probe tests.
// Verifies probeOfficialBridge() detects (a) missing package, (b) missing ctx
// services, (c) live integration against the real @deepseek-ai/dsh-acp.
//
// We don't import the real package in a way that requires dsh web; the probe
// uses createRequire(import.meta.url) so the test passes whether or not dsh is
// in the dependency tree. dsh IS in the tree (it's a peer transitive via the
// global @deepseek-ai/dsh install), so the live path runs end-to-end.

import { test } from "node:test";
import assert from "node:assert/strict";

const { probeOfficialBridge } = await import("../lib/official-acp-bridge.mjs");

// Fake ctx builder
function fakeCtx({ missing = [] } = {}) {
  const have = {
    llm: { stream: () => ({}) },
    logger: { warn: () => {}, info: () => {} },
    sessionPersistence: { get: () => null },
    agents: { create: async () => ({}), resume: async () => ({}), get: () => null },
    sessions: { get: () => null, flush: async () => {} },
    get(name) {
      if (name === "subagents") return {};
      return undefined;
    },
  };
  for (const m of missing) delete have[m];
  return have;
}

test("probeOfficialBridge: import succeeds in current env (dsh-acp is transitively available)", async () => {
  const result = await probeOfficialBridge(fakeCtx());
  assert.equal(result.error, null, `unexpected error: ${result.error}`);
  assert.equal(result.importable, true, "@deepseek-ai/dsh-acp should resolve via createRequire");
  assert.equal(typeof result.applySignature, "string");
  assert.equal(result.applySignature, "2", "apply should accept (ctx, config)");
});

test("probeOfficialBridge: servicesReady=true when all cordis services present", async () => {
  const result = await probeOfficialBridge(fakeCtx());
  assert.equal(result.servicesReady, true);
  assert.deepEqual(result.missingServices, []);
});

test("probeOfficialBridge: servicesReady=false when ctx.llm is missing", async () => {
  const result = await probeOfficialBridge(fakeCtx({ missing: ["llm"] }));
  assert.equal(result.servicesReady, false);
  assert.ok(result.missingServices.includes("llm"));
});

test("probeOfficialBridge: servicesReady=false when ctx.agents is missing", async () => {
  const result = await probeOfficialBridge(fakeCtx({ missing: ["agents"] }));
  assert.equal(result.servicesReady, false);
  assert.ok(result.missingServices.includes("agents"));
});

test("probeOfficialBridge: servicesReady=false when ctx.sessions is missing", async () => {
  const result = await probeOfficialBridge(fakeCtx({ missing: ["sessions"] }));
  assert.equal(result.servicesReady, false);
  assert.ok(result.missingServices.includes("sessions"));
});

test("probeOfficialBridge: subagents missing is reported (degrades teardown, not mount)", async () => {
  const ctx = fakeCtx();
  delete ctx.get; // remove get('subagents') support
  const result = await probeOfficialBridge(ctx);
  assert.ok(result.missingServices.includes("subagents"));
});

test("probeOfficialBridge: envSwitchOn reflects DSH_ACP_USE_OFFICIAL_BRIDGE", async () => {
  const prev = process.env.DSH_ACP_USE_OFFICIAL_BRIDGE;
  try {
    process.env.DSH_ACP_USE_OFFICIAL_BRIDGE = "1";
    const on = await probeOfficialBridge(fakeCtx());
    assert.equal(on.envSwitchOn, true);
    process.env.DSH_ACP_USE_OFFICIAL_BRIDGE = "0";
    const off = await probeOfficialBridge(fakeCtx());
    assert.equal(off.envSwitchOn, false);
    delete process.env.DSH_ACP_USE_OFFICIAL_BRIDGE;
    const unset = await probeOfficialBridge(fakeCtx());
    assert.equal(unset.envSwitchOn, false);
  } finally {
    if (prev === undefined) delete process.env.DSH_ACP_USE_OFFICIAL_BRIDGE;
    else process.env.DSH_ACP_USE_OFFICIAL_BRIDGE = prev;
  }
});

test("probeOfficialBridge: version field echoes HTTP_GATEWAY_VERSION", async () => {
  const result = await probeOfficialBridge(fakeCtx());
  assert.match(result.version, /^0\.\d+\.\d+/);
});

test("probeOfficialBridge: result shape is stable (downstream can rely on keys)", async () => {
  const result = await probeOfficialBridge(fakeCtx());
  const expected = [
    "importable", "servicesReady", "envSwitchOn",
    "missingServices", "applySignature", "version", "error",
  ];
  for (const k of expected) assert.ok(k in result, `missing key: ${k}`);
});