// test/config-schema.test.mjs — node:test regression test for index.mjs Config schema.
//
// Background: P1.0 introduced Config.runtime.mode (long|spawn) and
// Config.permission.mode (default|acceptEdits|dontAsk|bypassPermissions).
// The first attempt used `z.enum([...])` which schemastery does NOT have —
// cordis-plugin-loader crashed with `z.enum is not a function`. The second
// attempt used `z.union([z.literal(...), ...])` — also fails because schemastery
// has no `z.literal`. Correct API: `z.union([z.const(value), ...])`.
//
// This test guards three regressions:
//   1. index.mjs can be imported (module-level throws crash the cordis loader).
//   2. Config has the standard-schema validator (required by cordis).
//   3. runtime.mode / permission.mode accept the documented enum values.

import test from "node:test";
import assert from "node:assert/strict";

test("index.mjs loads without throwing (regression: z.enum/z.literal crash)", async () => {
  let mod;
  await assert.doesNotReject(async () => {
    mod = await import("../index.mjs");
  }, "importing index.mjs must not throw — the cordis plugin loader crashes if it does");
  assert.equal(typeof mod.Config, "function", "Config must be exported as a function (schemastery schema)");
});

test("Config has standard-schema validator (required by cordis-plugin-loader)", async () => {
  // cordis resolves Config["~standard"] to validate user config; absence makes
  // it throw "Cannot read properties of undefined (reading 'validate')".
  // The standard-schema field is exposed as a non-enumerable getter on the
  // schemastery Schema instance.
  const { Config } = await import("../index.mjs");
  // schemastery stores the validator under Symbol(kSchema) + attaches ~standard.
  // Read it without enumerating own properties (Symbol keys aren't enumerated).
  const proto = Object.getPrototypeOf(Config);
  const allKeys = [
    ...Object.getOwnPropertyNames(Config),
    ...Object.getOwnPropertySymbols(Config),
    ...Object.getOwnPropertyNames(proto ?? {}),
    ...Object.getOwnPropertySymbols(proto ?? {}),
  ];
  const hasStandard = allKeys.some((k) => String(k) === "~standard");
  assert.ok(hasStandard, "Config must expose ~standard validator (cordis-plugin-loader requirement)");
});

test("runtime.mode + permission.mode accept documented enum values", async () => {
  const { Config } = await import("../index.mjs");
  // schemastery Schema instances are callable: Config(input) → normalized output
  const okRuntime = Config({ spawn: true, profile: "headless" });
  assert.equal(okRuntime.runtime.mode, "spawn", "default runtime.mode must be 'spawn'");
  assert.equal(okRuntime.runtime.spawnFallback, true);
  assert.equal(okRuntime.permission.mode, "default", "default permission.mode must be 'default'");
  // Phase B (2026-09-18): timeoutMs is no longer in defaults — PermissionGate
  // cancellation now flows via AbortSignal, not a wall-clock timer.
  assert.equal(okRuntime.permission.timeoutMs, undefined);
  assert.equal(okRuntime.permission.enableRootBypass, false);
  assert.deepEqual(okRuntime.permission.editTools, ["Edit", "Write", "MultiEdit", "NotebookEdit"]);

  // Long mode + bypassPermissions — must accept without throwing.
  const longRuntime = Config({ runtime: { mode: "long" }, permission: { mode: "bypassPermissions" } });
  assert.equal(longRuntime.runtime.mode, "long");
  assert.equal(longRuntime.permission.mode, "bypassPermissions");
});

test("runtime.mode rejects values outside the documented enum", async () => {
  const { Config } = await import("../index.mjs");
  // Schemastery throws on invalid union members; this is the contract cordis relies on.
  await assert.rejects(
    async () => Config({ runtime: { mode: "weird" } }),
    /weird|long|spawn|must match|union/i,
    "invalid runtime.mode must be rejected (cordis must not silently accept bad config)",
  );
});