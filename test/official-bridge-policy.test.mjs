// test/official-bridge-policy.test.mjs — node:test unit tests for
// lib/official-bridge-policy.mjs (U3, 2026-11-03).
//
// Covers the "official bridge 启用策略" contract:
//   · env 解析：on / off / auto（未设与未知值都归 auto）
//   · 探针判定：importable && servicesReady
//   · 决策合成：resolveOfficialBridge（显式 vs auto 降级 reason）
//   · 运行时口径：resolveOfficialActive（trigger() 与挂载门共用的唯一判定）
//   · 日志文案可 grep
//   · index.mjs 装配：策略与「挂载结果」必须由 apply() 注入构造函数
//     （曾经的缺陷：trigger() 定义在类作用域，直接引用 apply() 的局部 const
//     会在 boot 触发时抛 ReferenceError —— node --check 查不出，只能靠装配断言）

import test from "node:test";
import assert from "node:assert/strict";

import {
  OFFICIAL_BRIDGE_ENV,
  officialBridgePolicy,
  officialBridgeFromProbe,
  resolveOfficialBridge,
  resolveOfficialActive,
  officialBridgeLogLine,
} from "../lib/official-bridge-policy.mjs";

// --- officialBridgePolicy --------------------------------------------------

test("officialBridgePolicy: explicit ON values → 'on'", () => {
  for (const v of ["1", "true", "TRUE", "yes", "YES", "on", "ON", " 1 ", "True"]) {
    assert.equal(officialBridgePolicy({ [OFFICIAL_BRIDGE_ENV]: v }), "on", `value=${JSON.stringify(v)}`);
  }
});

test("officialBridgePolicy: explicit OFF values → 'off'", () => {
  for (const v of ["0", "false", "FALSE", "no", "NO", "off", "OFF", " 0 ", "False"]) {
    assert.equal(officialBridgePolicy({ [OFFICIAL_BRIDGE_ENV]: v }), "off", `value=${JSON.stringify(v)}`);
  }
});

test("officialBridgePolicy: unset → 'auto' (default-on via probe)", () => {
  assert.equal(officialBridgePolicy({}), "auto");
  assert.equal(officialBridgePolicy({ [OFFICIAL_BRIDGE_ENV]: "" }), "auto");
  assert.equal(officialBridgePolicy({ [OFFICIAL_BRIDGE_ENV]: "   " }), "auto");
});

test("officialBridgePolicy: unknown values fall back to 'auto' (never throws)", () => {
  assert.equal(officialBridgePolicy({ [OFFICIAL_BRIDGE_ENV]: "maybe" }), "auto");
  assert.equal(officialBridgePolicy({ [OFFICIAL_BRIDGE_ENV]: "2" }), "auto");
  assert.equal(officialBridgePolicy({ [OFFICIAL_BRIDGE_ENV]: "enabled" }), "auto");
});

test("officialBridgePolicy: non-string / missing env safely → 'auto'", () => {
  assert.equal(officialBridgePolicy({ [OFFICIAL_BRIDGE_ENV]: undefined }), "auto");
  assert.equal(officialBridgePolicy({ [OFFICIAL_BRIDGE_ENV]: null }), "auto");
  assert.equal(officialBridgePolicy({ [OFFICIAL_BRIDGE_ENV]: 1 }), "auto");
  assert.equal(officialBridgePolicy(undefined), "auto");
});

// --- officialBridgeFromProbe ----------------------------------------------

test("officialBridgeFromProbe: only importable && servicesReady is usable", () => {
  assert.equal(officialBridgeFromProbe({ importable: true, servicesReady: true }), true);
  assert.equal(officialBridgeFromProbe({ importable: true, servicesReady: false }), false);
  assert.equal(officialBridgeFromProbe({ importable: false, servicesReady: true }), false);
  assert.equal(officialBridgeFromProbe({ importable: false, servicesReady: false }), false);
  assert.equal(officialBridgeFromProbe({}), false);
  assert.equal(officialBridgeFromProbe(null), false);
  assert.equal(officialBridgeFromProbe(undefined), false);
});

// --- resolveOfficialBridge ------------------------------------------------

test("resolveOfficialBridge: off never mounts and never degrades loudly to auto", () => {
  const d = resolveOfficialBridge({ mode: "off" });
  assert.equal(d.active, false);
  assert.equal(d.requested, false);
  assert.match(d.reason, /关闭/);
});

test("resolveOfficialBridge: on mounts without consulting the probe", () => {
  const d = resolveOfficialBridge({ mode: "on", probe: { importable: false, servicesReady: false } });
  assert.equal(d.active, true);
  assert.equal(d.requested, true);
});

test("resolveOfficialBridge: auto mounts only when the probe is usable", () => {
  const good = resolveOfficialBridge({ mode: "auto", probe: { importable: true, servicesReady: true } });
  assert.equal(good.active, true);
  assert.match(good.reason, /探针可用/);

  const bad = resolveOfficialBridge({ mode: "auto", probe: { importable: true, servicesReady: false } });
  assert.equal(bad.active, false);
  assert.match(bad.reason, /降级/);
  assert.match(bad.reason, /servicesReady=false/);
});

test("resolveOfficialBridge: auto with a missing/throwing probe degrades (never silently active)", () => {
  for (const probe of [null, undefined, { error: "probe threw: boom" }]) {
    const d = resolveOfficialBridge({ mode: "auto", probe });
    assert.equal(d.active, false);
    assert.match(d.reason, /降级/);
  }
  assert.equal(resolveOfficialBridge().active, false); // default: auto + no probe
});

// --- resolveOfficialActive（trigger 与挂载门共用的口径）-------------------

test("resolveOfficialActive: on → true regardless of outcome", () => {
  assert.equal(resolveOfficialActive("on", null), true);
  assert.equal(resolveOfficialActive("on", { mounted: false }), true);
});

test("resolveOfficialActive: off → false regardless of outcome", () => {
  assert.equal(resolveOfficialActive("off", null), false);
  assert.equal(resolveOfficialActive("off", { mounted: true }), false);
});

test("resolveOfficialActive: auto follows the mount outcome only", () => {
  assert.equal(resolveOfficialActive("auto", { mounted: true, reason: "x" }), true);
  assert.equal(resolveOfficialActive("auto", { mounted: false, reason: "x" }), false);
  assert.equal(resolveOfficialActive("auto", null), false);          // 2s 超时未挂上
  assert.equal(resolveOfficialActive("auto", undefined), false);
  assert.equal(resolveOfficialActive("auto", {}), false);            // 结果缺 mounted
});

// --- officialBridgeLogLine ------------------------------------------------

test("officialBridgeLogLine: one greppable line naming policy + active + reason", () => {
  const line = officialBridgeLogLine({ mode: "auto", active: false, reason: "auto：探针不可用" });
  assert.match(line, /^\[dsh-acp\] official bridge policy=auto active=false — /);
  assert.match(line, /探针不可用/);
  assert.equal(line.includes("\n"), false, "must stay a single line");
});

test("officialBridgeLogLine: tolerates a missing decision", () => {
  assert.match(officialBridgeLogLine(null), /policy=auto active=false/);
  assert.match(officialBridgeLogLine(undefined), /^\[dsh-acp\] official bridge/);
});

// --- index.mjs 装配（曾经的 ReferenceError 缺陷回归）----------------------

test("DshAcpService: apply() 注入的 official 策略/挂载结果能被实例读到", async () => {
  const { Context } = await import("@deepseek-ai/cordis");
  const { DshAcpService } = await import("../index.mjs");

  const ctx = new Context();
  const outcome = { mounted: true, reason: "unit-test" };
  // spawn:false → 构造函数不注册 loader/setTimeout 触发，不会真起子进程。
  const svc = new DshAcpService(ctx, { spawn: false }, {
    officialPolicy: "auto",
    officialMountOutcome: Promise.resolve(outcome),
  });

  assert.equal(svc._officialPolicy, "auto");
  assert.equal(await svc._officialMountOutcome, outcome);

  // 独立实例化（无 internal）时按 env 解析、挂载结果视为未挂载 —— 不抛错。
  const bare = new DshAcpService(new Context(), { spawn: false });
  assert.ok(["on", "off", "auto"].includes(bare._officialPolicy));
  assert.equal((await bare._officialMountOutcome).mounted, false);
});
