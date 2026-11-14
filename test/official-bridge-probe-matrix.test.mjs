// test/official-bridge-probe-matrix.test.mjs — P2-2 (R141 / 卡 -71) 版本矩阵回归.
//
// 判据（评审者 2026-11-15 下发）：
//   ① 重跑 probeOfficialBridge，记录 servicesReady / missingServices / hostServices；
//   ② 可用性矩阵落文档；
//   ③ 已可用 ⇒ 转「可用性确认 + 文档收口」，不新增实现；
//   ④ 单测或真机取证（二选一）——本文件即单测取证。
//
// 本文件把「探针的 required 列表 ⊇ 上游 apply() 实际 inject 的服务」这条不变量
// 钉死。上游换版本若新增了**门控**服务而探针没跟上，这里立刻红——这比一次性的
// 真机读数更能防止「版本漂移后探针悄悄失效」。
//
// 上游源码缺失（未装 dsh）⇒ skip，不判失败：dsh-acp 是 optional peer。

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { probeOfficialBridge } from "../lib/official-acp-bridge.mjs";

/**
 * Read the probe's `required` list FROM ITS SOURCE rather than re-typing it.
 *
 * Hand-copying the list would make this file agree with itself instead of with
 * the probe: deleting a service from lib/official-acp-bridge.mjs would leave
 * both copies of the test constant intact and the invariant would silently
 * stop protecting anything (verified by mutating the source — see the
 * "mutation" note in the P2-2 report).
 */
function readProbeRequired() {
  const src = readFileSync(new URL("../lib/official-acp-bridge.mjs", import.meta.url), "utf8");
  const start = src.indexOf("const required = [");
  if (start < 0) throw new Error("`const required = [` not found in lib/official-acp-bridge.mjs");
  const end = src.indexOf("];", start);
  if (end < 0) throw new Error("unterminated `required` array");
  const body = src.slice(start, end);
  const names = [...body.matchAll(/\[\s*"([A-Za-z]+)"\s*,/g)].map((m) => m[1]);
  if (names.length === 0) throw new Error("parsed zero services out of the probe's `required` array");
  return names;
}

const PROBE_REQUIRED = readProbeRequired();

/** Locate the installed @deepseek-ai/dsh-acp entry, or null. */
function findInstalledOfficialAcp() {
  const dshHome = process.env.DSH_HOME || join(homedir(), ".dsh");
  const candidates = [
    join(dshHome, "profiles", process.env.DSH_PROFILE || "web", "node_modules", "@deepseek-ai", "dsh-acp", "lib", "index.js"),
    join(dshHome, "profiles", "headless", "node_modules", "@deepseek-ai", "dsh-acp", "lib", "index.js"),
    join(dshHome, "profiles", "node_modules", "@deepseek-ai", "dsh-acp", "lib", "index.js"),
    join(homedir(), ".npm-global", "lib", "node_modules", "@deepseek-ai", "dsh", "node_modules", "@deepseek-ai", "dsh-acp", "lib", "index.js"),
  ];
  for (const p of candidates) if (existsSync(p)) return p;
  return null;
}

/** Parse `const inject = [ ... ]` out of the upstream bundle. */
function parseUpstreamInject(src) {
  const m = /const inject = \[([^\]]*)\]/.exec(src);
  if (!m) return null;
  return [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]);
}

/** Installed package version (best-effort, for the assertion message). */
function installedVersion(entryPath) {
  try {
    const pkg = JSON.parse(readFileSync(join(entryPath, "..", "..", "package.json"), "utf8"));
    return pkg.version ?? "?";
  } catch {
    return "?";
  }
}

const ENTRY = findInstalledOfficialAcp();
const SKIP = "@deepseek-ai/dsh-acp not installed (optional peer)";

/** A ctx that carries every service, so servicesReady must come back true. */
function fullCtx() {
  const services = ["llm", "logger", "sessionPersistence", "agents", "sessions", "subagents", "tokenMeter", "attachments", "approval", "tools", "systemPrompt"];
  const store = new Map(services.map((s) => [s, { __service: s }]));
  const ctx = { get: (n) => store.get(n) };
  for (const s of services) ctx[s] = store.get(s);
  return ctx;
}

test("P2-2: installed dsh-acp still gates on exactly the probe's required set", (t) => {
  if (!ENTRY) return t.skip(SKIP);
  const inject = parseUpstreamInject(readFileSync(ENTRY, "utf8"));
  assert.ok(inject, `could not parse \`const inject = [...]\` from ${ENTRY}`);
  // Direction matters: every service upstream GATES on must be probed. The
  // probe may legitimately check MORE (it also checks `logger`, which upstream
  // reads directly via ctx.logger without listing it in inject).
  const missingFromProbe = inject.filter((s) => !PROBE_REQUIRED.includes(s));
  assert.deepEqual(
    missingFromProbe,
    [],
    `dsh-acp@${installedVersion(ENTRY)} injects ${JSON.stringify(inject)} but the probe's required list ` +
      `${JSON.stringify(PROBE_REQUIRED)} omits ${JSON.stringify(missingFromProbe)} — ` +
      `the probe would report servicesReady=true on a host lacking them`,
  );
});

test("P2-2: probe reports ready against a fully-populated ctx", async (t) => {
  if (!ENTRY) return t.skip(SKIP);
  const r = await probeOfficialBridge(fullCtx());
  assert.equal(r.importable, true, `importable=${r.importable} error=${r.error}`);
  assert.equal(r.servicesReady, true, `missingServices=${JSON.stringify(r.missingServices)}`);
  assert.deepEqual(r.missingServices, []);
  assert.equal(r.applySignature, "2", "apply(ctx, config)");
  assert.equal(typeof r.error, "object", "error must be null when the package resolved");
});

test("P2-2: probe still discriminates — a ctx missing `llm` is NOT ready", async (t) => {
  if (!ENTRY) return t.skip(SKIP);
  const ctx = fullCtx();
  delete ctx.llm; // direct read gone …
  ctx.get = ((orig) => (n) => (n === "llm" ? undefined : orig(n)))(ctx.get); // … and ctx.get too
  const r = await probeOfficialBridge(ctx);
  assert.equal(r.servicesReady, false, "a ctx without llm must not be reported usable");
  assert.deepEqual(r.missingServices, ["llm"]);
});

test("P2-2: hostServices inventory is present and boolean-valued", async (t) => {
  if (!ENTRY) return t.skip(SKIP);
  const r = await probeOfficialBridge(fullCtx());
  assert.deepEqual(Object.keys(r.hostServices).sort(), ["approval", "systemPrompt", "tools"]);
  for (const [k, v] of Object.entries(r.hostServices)) {
    assert.equal(typeof v, "boolean", `hostServices.${k} must be boolean, got ${typeof v}`);
    assert.equal(v, true, `hostServices.${k} should be true for a fully-populated ctx`);
  }
});

test("P2-2: upstream no longer reads a service the probe omits (apply surface)", (t) => {
  if (!ENTRY) return t.skip(SKIP);
  const src = readFileSync(ENTRY, "utf8");
  const applyAt = src.indexOf("function apply(ctx, config)");
  assert.ok(applyAt > 0, "apply(ctx, config) not found in the installed bundle");
  const body = src.slice(applyAt);
  const touched = new Set(
    [...body.matchAll(/ctx\.get\("([A-Za-z]+)"\)|ctx\.([A-Za-z]+)\./g)]
      .map((m) => m[1] ?? m[2]),
  );
  const known = new Set([...PROBE_REQUIRED, "subagents", "tokenMeter", "attachments"]);
  const unknown = [...touched].filter((s) => !known.has(s));
  assert.deepEqual(
    unknown,
    [],
    `dsh-acp@${installedVersion(ENTRY)} apply() reaches for ${JSON.stringify(unknown)}, ` +
      `which the probe neither requires nor reports as advisory`,
  );
});
