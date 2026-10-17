// lib/official-acp-bridge.mjs — Phase 1 (migration plan).
//
// Static integration check for `@deepseek-ai/dsh-acp`. We don't actually mount
// `apply(ctx, config)` here — mounting kicks off a JSON-RPC stream connection
// that consumes `config.stream.readable` and blocks on `connect()`. Phase 1
// only verifies the package is importable and that the cordis ctx carries
// every service the official `apply()` reaches for at mount time:
//
//   ctx.llm, ctx.logger, ctx.sessionPersistence, ctx.agents, ctx.sessions,
//   ctx.get('subagents'), ctx.attachments, ctx.tokenMeter
//
// Once this probe returns `{importable:true, servicesReady:true}` we know
// Phase 2 (actually calling `apply()` and routing prompts) is safe to start.
//
// Env switch: `DSH_ACP_USE_OFFICIAL_BRIDGE=1` opts the gateway into the
// official path; OFF keeps the current `ensureLongRuntime()` behavior so we
// can flip back without restart coordination.
//
// ---------------------------------------------------------------------------
// 2026-10-09 (t8): `@deepseek-ai/dsh-acp` is now a **peerDependency** provided
// by the host, not a bundled dependency. Why: pinning it in `dependencies` let
// the plugin materialise its own copy (desktop profile ended up with 24 nested
// @0.1.6-alpha.x packages while its host anchors @0.2.0-rc.2 — three
// generations of skew). No single hardcoded version can satisfy both hosts
// (web/CLI = 0.2.1-alpha.1, desktop = 0.2.0-rc.2), so the host must supply it.
//
// Consequence: the package may be ABSENT. A static `import` would then turn
// "optional capability unavailable" into "the whole plugin module fails to
// load", so resolution is now LAZY (at probe time) and folded into the probe
// result. This module must always load, even with the package missing.
// ---------------------------------------------------------------------------

import { HTTP_GATEWAY_VERSION } from "./http-gateway.mjs";

/**
 * Cached lazy resolution of `@deepseek-ai/dsh-acp`.
 * `null` = not attempted yet. `{ok:true, apply, Config}` | `{ok:false, error}`.
 * @type {{ok:boolean, apply?:Function, Config?:any, error?:string|null}|null}
 */
let _officialAcp = null;

/**
 * Lazily resolve the host-provided `@deepseek-ai/dsh-acp`. Idempotent; never
 * throws — failures are cached as `{ok:false, error}` so callers can fold them
 * into a return value instead of crashing module load.
 *
 * @returns {Promise<{ok:boolean, apply?:Function, Config?:any, error?:string|null}>}
 */
// [H2b] 双策略解析 @deepseek-ai/dsh-acp：
//   策略 1 —— 原样 import()：发布态下，本插件安装于 <profile>/node_modules/obsidian-dsh-acp，
//     Node 会从该目录上溯，命中 <profile>/node_modules/@deepseek-ai/dsh-acp（peer）。命中即返回。
//   策略 2 —— profile-根回退：link: 开发态下本插件实体在工作树，import() 的基准=工作树 lib/，
//     上溯不到 peer → 从 $DSH_HOME/profiles/*/node_modules 逐一 createRequire().resolve() 得
//     绝对路径再 import()。⚠️ 不能用 config.profile 推路径（web 运行时它= "headless"）。
async function _importOfficialAcp(pkg) {
  // 策略 1
  try {
    return await import(pkg);
  } catch (e1) {
    if (e1?.code !== "ERR_MODULE_NOT_FOUND") throw e1;
  }
  // 策略 2
  const { createRequire } = await import("node:module");
  const { pathToFileURL } = await import("node:url");
  const path = await import("node:path");
  const fs = await import("node:fs");
  const os = await import("node:os");
  const dshHome = process.env.DSH_HOME || path.join(os.homedir(), ".dsh");
  const profilesDir = path.join(dshHome, "profiles");
  let profiles = [];
  try { profiles = fs.readdirSync(profilesDir); } catch { /* no profiles dir */ }
  // $DSH_PROFILE 提示的 profile 优先，其余任意顺序
  const preferred = process.env.DSH_PROFILE;
  if (preferred && profiles.includes(preferred)) {
    profiles = [preferred, ...profiles.filter((p) => p !== preferred)];
  }
  const roots = profiles.map((p) => path.join(profilesDir, p, "node_modules"));
  let lastErr = null;
  for (const root of roots) {
    try {
      const req = createRequire(path.join(root, "package.json"));
      const abs = req.resolve(pkg);
      return await import(pathToFileURL(abs).href);
    } catch (e) { lastErr = e; }
  }
  const err = new Error(
    "[H2b] loadOfficialAcp: cannot resolve " + pkg + " from any profile root " +
      `(${roots.join(", ") || "none"})${lastErr ? `; last: ${lastErr?.message ?? lastErr}` : ""}`,
  );
  err.code = "ERR_MODULE_NOT_FOUND";
  throw err;
}

export async function loadOfficialAcp() {
  if (_officialAcp !== null) return _officialAcp;
  try {
    const mod = await _importOfficialAcp("@deepseek-ai/dsh-acp");
    if (typeof mod?.apply !== "function") {
      _officialAcp = {
        ok: false,
        error: "@deepseek-ai/dsh-acp resolved but does not export a callable `apply`",
      };
    } else {
      _officialAcp = { ok: true, apply: mod.apply, Config: mod.Config, error: null };
    }
  } catch (e) {
    _officialAcp = {
      ok: false,
      error:
        `@deepseek-ai/dsh-acp is not resolvable — it is an optional peerDependency ` +
        `supplied by the host dsh install (${e?.code ?? "ERR"}${e?.message ? `: ${e.message}` : ""})`,
    };
  }
  return _officialAcp;
}

/**
 * Sync accessor for the already-resolved module (used by mount paths that
 * cannot await). Returns `null` when the lazy load has not succeeded.
 *
 * @returns {{apply:Function, Config:any}|null}
 */
export function getLoadedOfficialAcp() {
  return _officialAcp && _officialAcp.ok ? { apply: _officialAcp.apply, Config: _officialAcp.Config } : null;
}

/**
 * Reset the cached resolution (test helper — lets tests force a re-resolve
 * after stubbing module resolution). Not used by production code.
 */
export function _resetOfficialAcpCache() {
  _officialAcp = null;
}

/**
 * @typedef {Object} OfficialBridgeProbeResult
 * @property {boolean} importable          - `@deepseek-ai/dsh-acp` resolved & `apply` exported.
 * @property {boolean} servicesReady       - cordis ctx has every service `apply()` touches.
 * @property {boolean} envSwitchOn         - DSH_ACP_USE_OFFICIAL_BRIDGE=1.
 * @property {string[]} missingServices    - mount-critical service names that came back undefined.
 * @property {string[]} advisoryServices   - non-gating services apply() touches (tokenMeter,
 *                                           attachments); absent ones are logged, never flip servicesReady.
 * @property {string}  applySignature      - `apply` arity for sanity (always 2 today).
 * @property {string}  version             - HTTP_GATEWAY_VERSION (echoed for log correlation).
 * @property {string|null} error           - any thrown import error message (null if none).
 */

/**
 * Static probe: does the official bridge package import, and is the cordis ctx
 * shaped correctly to host it? Never throws; errors are folded into the result.
 *
 * @param {import("@deepseek-ai/cordis").Context} ctx
 * @returns {Promise<OfficialBridgeProbeResult>}
 */
export async function probeOfficialBridge(ctx) {
  const out = {
    importable: false,
    servicesReady: false,
    envSwitchOn: process.env.DSH_ACP_USE_OFFICIAL_BRIDGE === "1",
    missingServices: [],
    advisoryServices: [],
    applySignature: "?",
    version: HTTP_GATEWAY_VERSION,
    error: null,
  };

  // 1) Lazy resolve the host-provided package. `loadOfficialAcp()` never
  //    throws: a missing/failed resolution comes back as `{ok:false, error}`
  //    and is reported as `importable:false` + `error` (module load already
  //    happened, so the plugin itself stays alive).
  const resolved = await loadOfficialAcp();
  if (!resolved.ok) {
    out.error = resolved.error ?? "@deepseek-ai/dsh-acp unavailable";
    return out;
  }
  out.importable = true;
  out.applySignature = String(resolved.apply.length); // 2 = (ctx, config)

  // 2) Verify the ctx carries every service apply() reaches for at mount time.
  //    Reading @deepseek-ai/dsh-acp@0.2.1-alpha.1 source: lib/index.js:1052
  //    (service list) and :1074 (ctx.sessionPersistence) — apply() uses
  //    ctx.sessionPersistence, ctx.logger, ctx.get('llm' | 'attachments' |
  //    'tokenMeter' | 'subagents'), ctx.llm, ctx.agents, ctx.sessions.
  const required = [
    ["llm", () => ctx?.llm],
    ["logger", () => ctx?.logger],
    ["sessionPersistence", () => ctx?.sessionPersistence],
    ["agents", () => ctx?.agents],
    ["sessions", () => ctx?.sessions],
  ];
  for (const [name, getter] of required) {
    const v = safeGet(getter);
    if (v === undefined || v === null) {
      out.missingServices.push(name);
    }
  }
  // G2-1: ctx.get('subagents') is used inside apply() during teardown only —
  // NOT required for mount. It must NOT gate `servicesReady` (same rationale as
  // tokenMeter/attachments below): a host that legitimately lacks subagents
  // would otherwise be misreported as "official unavailable". Report advisory.
  const subagents = safeGet(() => (typeof ctx?.get === "function" ? ctx.get("subagents") : undefined));
  if (subagents === undefined) {
    out.advisoryServices.push("subagents");
  }

  // a1-audit G6: apply() also reaches for ctx.tokenMeter and ctx.attachments
  // (see the source note above). These are deliberately NOT in `required`:
  // servicesReady gates whether the official path is treated as usable
  // (http-gateway.mjs:549), so promoting them would flip that gate to
  // "unusable" on hosts that legitimately lack them — a behaviour change, not
  // a diagnostic. They are reported as advisory instead.
  const advisory = [
    ["tokenMeter", () => (typeof ctx?.get === "function" ? ctx.get("tokenMeter") : undefined) ?? ctx?.tokenMeter],
    ["attachments", () => (typeof ctx?.get === "function" ? ctx.get("attachments") : undefined) ?? ctx?.attachments],
  ];
  for (const [name, getter] of advisory) {
    const v = safeGet(getter);
    if (v === undefined || v === null) {
      out.advisoryServices.push(name);
    }
  }

  out.servicesReady = out.missingServices.length === 0;
  return out;
}

function safeGet(fn) {
  try {
    return fn();
  } catch {
    return undefined;
  }
}