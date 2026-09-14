// test/runtime-switch.test.mjs — node:test unit tests for lib/runtime-switch.mjs
// Validates: resolveRuntimeMode() priority order, resolvePermissionConfig() parsing,
// tryLongFallbackSpawn() success + fallback paths.

import test from "node:test";
import assert from "node:assert/strict";
import {
  resolveRuntimeMode,
  resolveRuntimeConfig,
  resolvePermissionConfig,
  tryLongFallbackSpawn,
  PERMISSION_DEFAULTS,
  RUNTIME_DEFAULTS,
} from "../lib/runtime-switch.mjs";

// --- resolveRuntimeMode ---------------------------------------------------

test("resolveRuntimeMode: headless profile forces spawn", () => {
  assert.equal(resolveRuntimeMode({ DSH_PROFILE: "headless" }), "spawn");
  assert.equal(resolveRuntimeMode({ DSH_PROFILE: "headless", DSH_ACP_RUNTIME_MODE: "long" }), "spawn");
  assert.equal(resolveRuntimeMode({ DSH_PROFILE: "headless", DSH_IN_CORDIS: "1" }), "spawn");
});

test("resolveRuntimeMode: explicit env wins over defaults", () => {
  assert.equal(resolveRuntimeMode({ DSH_ACP_RUNTIME_MODE: "long" }), "long");
  assert.equal(resolveRuntimeMode({ DSH_ACP_RUNTIME_MODE: "spawn" }), "spawn");
  assert.equal(resolveRuntimeMode({ DSH_PROFILE: "web", DSH_ACP_RUNTIME_MODE: "long" }), "long");
});

test("resolveRuntimeMode: DSH_IN_CORDIS=1 implies long (when no override)", () => {
  assert.equal(resolveRuntimeMode({ DSH_IN_CORDIS: "1" }), "long");
});

test("resolveRuntimeMode: standalone binary default is spawn", () => {
  assert.equal(resolveRuntimeMode({}), "spawn");
});

test("resolveRuntimeMode: unknown env values fall through", () => {
  assert.equal(resolveRuntimeMode({ DSH_ACP_RUNTIME_MODE: "weird" }), "spawn");
  assert.equal(resolveRuntimeMode({ DSH_IN_CORDIS: "0" }), "spawn");
  assert.equal(resolveRuntimeMode({ DSH_IN_CORDIS: "" }), "spawn");
});

// --- resolveRuntimeConfig -------------------------------------------------

test("resolveRuntimeConfig: defaults when no env", () => {
  const cfg = resolveRuntimeConfig({});
  assert.equal(cfg.mode, "spawn");
  assert.equal(cfg.spawnFallback, true);
});

test("resolveRuntimeConfig: spawnFallback=false honored", () => {
  assert.equal(resolveRuntimeConfig({ DSH_ACP_SPAWN_FALLBACK: "false" }).spawnFallback, false);
  assert.equal(resolveRuntimeConfig({ DSH_ACP_SPAWN_FALLBACK: "0" }).spawnFallback, false);
  assert.equal(resolveRuntimeConfig({ DSH_ACP_SPAWN_FALLBACK: "true" }).spawnFallback, true);
});

test("RUNTIME_DEFAULTS is frozen and matches spec", () => {
  assert.equal(RUNTIME_DEFAULTS.mode, "spawn");
  assert.equal(RUNTIME_DEFAULTS.spawnFallback, true);
  assert.ok(Object.isFrozen(RUNTIME_DEFAULTS));
});

// --- resolvePermissionConfig ---------------------------------------------

test("resolvePermissionConfig: defaults match PERMISSION_DEFAULTS", () => {
  const cfg = resolvePermissionConfig({});
  assert.equal(cfg.mode, PERMISSION_DEFAULTS.mode);
  assert.equal(cfg.timeoutMs, PERMISSION_DEFAULTS.timeoutMs);
  assert.deepEqual(cfg.editTools, PERMISSION_DEFAULTS.editTools);
});

test("resolvePermissionConfig: explicit mode wins, invalid falls back to default", () => {
  assert.equal(resolvePermissionConfig({ DSH_ACP_PERMISSION_MODE: "acceptEdits" }).mode, "acceptEdits");
  assert.equal(resolvePermissionConfig({ DSH_ACP_PERMISSION_MODE: "dontAsk" }).mode, "dontAsk");
  assert.equal(resolvePermissionConfig({ DSH_ACP_PERMISSION_MODE: "bypassPermissions" }).mode, "bypassPermissions");
  assert.equal(resolvePermissionConfig({ DSH_ACP_PERMISSION_MODE: "nonsense" }).mode, "default");
});

test("resolvePermissionConfig: timeoutMs honors env, falls back on garbage", () => {
  assert.equal(resolvePermissionConfig({ DSH_ACP_PERMISSION_TIMEOUT_MS: "60000" }).timeoutMs, 60000);
  assert.equal(resolvePermissionConfig({ DSH_ACP_PERMISSION_TIMEOUT_MS: "abc" }).timeoutMs, PERMISSION_DEFAULTS.timeoutMs);
  assert.equal(resolvePermissionConfig({ DSH_ACP_PERMISSION_TIMEOUT_MS: "" }).timeoutMs, PERMISSION_DEFAULTS.timeoutMs);
});

test("resolvePermissionConfig: editTools parsing", () => {
  assert.deepEqual(
    resolvePermissionConfig({ DSH_ACP_PERMISSION_EDIT_TOOLS: "Edit, Write , MultiEdit" }).editTools,
    ["Edit", "Write", "MultiEdit"],
  );
  assert.deepEqual(
    resolvePermissionConfig({ DSH_ACP_PERMISSION_EDIT_TOOLS: "" }).editTools,
    PERMISSION_DEFAULTS.editTools,
  );
});

test("PERMISSION_DEFAULTS is frozen and matches spec", () => {
  assert.equal(PERMISSION_DEFAULTS.mode, "default");
  assert.equal(PERMISSION_DEFAULTS.timeoutMs, 300000);
  assert.ok(PERMISSION_DEFAULTS.editTools.includes("Edit"));
  assert.ok(Object.isFrozen(PERMISSION_DEFAULTS));
});

// --- tryLongFallbackSpawn -------------------------------------------------

test("tryLongFallbackSpawn: spawn mode goes straight to spawnFn", async () => {
  let longCalled = 0;
  let spawnCalled = 0;
  await tryLongFallbackSpawn(
    async () => { longCalled++; return "LONG"; },
    async () => { spawnCalled++; return "SPAWN"; },
    { mode: "spawn", spawnFallback: true },
  );
  assert.equal(longCalled, 0);
  assert.equal(spawnCalled, 1);
});

test("tryLongFallbackSpawn: long mode success returns long result", async () => {
  const result = await tryLongFallbackSpawn(
    async () => "LONG-OK",
    async () => "SPAWN-OK",
    { mode: "long", spawnFallback: true },
  );
  assert.equal(result, "LONG-OK");
});

test("tryLongFallbackSpawn: long failure + spawnFallback=true → spawn", async () => {
  const result = await tryLongFallbackSpawn(
    async () => { throw new Error("long broken"); },
    async () => "SPAWN-RECOVER",
    { mode: "long", spawnFallback: true },
  );
  assert.equal(result, "SPAWN-RECOVER");
});

test("tryLongFallbackSpawn: long failure + spawnFallback=false → throws", async () => {
  await assert.rejects(
    tryLongFallbackSpawn(
      async () => { throw new Error("long broken"); },
      async () => "SPAWN",
      { mode: "long", spawnFallback: false },
    ),
    /long broken/,
  );
});

test("tryLongFallbackSpawn: long mode but spawnFallback=false + long success returns long", async () => {
  const result = await tryLongFallbackSpawn(
    async () => "LONG",
    async () => "SPAWN",
    { mode: "long", spawnFallback: false },
  );
  assert.equal(result, "LONG");
});
