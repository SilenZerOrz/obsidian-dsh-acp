// test/long-runtime.test.mjs — node:test unit tests for lib/long-runtime.mjs
// P1.0: validates the skeleton (init() throws placeholder, dispose() is safe).
// P1.5+: will be expanded to test ctx.llm.stream + chunk bridging.

import test from "node:test";
import assert from "node:assert/strict";
import { LongRuntime, getLongRuntime, resetLongRuntime } from "../lib/long-runtime.mjs";

test("LongRuntime: new instance starts uninitialized", () => {
  const rt = new LongRuntime();
  assert.equal(rt._initialized, false);
  assert.equal(rt.cordisCtx, null);
  assert.equal(rt.acpClient, null);
});

test("LongRuntime: init() throws P1.0 placeholder with descriptive message", async () => {
  const rt = new LongRuntime();
  await assert.rejects(
    rt.init({ cordisCtx: { fake: true }, acpClient: null, permissionConfig: { mode: "default", timeoutMs: 300000, editTools: [] }, cwd: "/tmp" }),
    /P1\.0 skeleton/,
  );
});

test("LongRuntime: prompt() throws when not initialized", async () => {
  const rt = new LongRuntime();
  await assert.rejects(rt.prompt({ sessionId: "x" }), /not initialized/);
});

test("LongRuntime: prompt() throws after init (P1.0 placeholder)", async () => {
  const rt = new LongRuntime();
  try {
    await rt.init({ cordisCtx: {}, acpClient: null, permissionConfig: { mode: "default", timeoutMs: 300000, editTools: [] }, cwd: "/tmp" });
  } catch { /* expected placeholder throw */ }
  await assert.rejects(rt.prompt({ sessionId: "x" }), /P1\.5/);
});

test("LongRuntime: dispose() clears state", async () => {
  const rt = new LongRuntime();
  try {
    await rt.init({ cordisCtx: {}, acpClient: null, permissionConfig: { mode: "default", timeoutMs: 300000, editTools: [] }, cwd: "/tmp" });
  } catch { /* expected */ }
  await rt.dispose();
  assert.equal(rt._initialized, false);
  assert.equal(rt.cordisCtx, null);
  assert.equal(rt.acpClient, null);
  assert.equal(rt.permissionConfig, null);
});

test("getLongRuntime: returns singleton instance", () => {
  resetLongRuntime();
  const a = getLongRuntime();
  const b = getLongRuntime();
  assert.equal(a, b, "getLongRuntime must return the same instance");
});

test("resetLongRuntime: clears the singleton", () => {
  const a = getLongRuntime();
  resetLongRuntime();
  const b = getLongRuntime();
  assert.notEqual(a, b, "resetLongRuntime must yield a fresh instance on next get");
});
