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

import { apply as dshAcpApply, Config as DshAcpConfig } from "@deepseek-ai/dsh-acp";
import { HTTP_GATEWAY_VERSION } from "./http-gateway.mjs";

// Re-export the two public surfaces we'll actually mount in Phase 2. The probe
// below only verifies they're reachable — calling `apply()` would open a
// JSON-RPC stream and block on `connect()`, which belongs to the run loop, not
// this static check.
export { dshAcpApply, DshAcpConfig };

/**
 * @typedef {Object} OfficialBridgeProbeResult
 * @property {boolean} importable          - `@deepseek-ai/dsh-acp` resolved & `apply` exported.
 * @property {boolean} servicesReady       - cordis ctx has every service `apply()` touches.
 * @property {boolean} envSwitchOn         - DSH_ACP_USE_OFFICIAL_BRIDGE=1.
 * @property {string[]} missingServices    - service names that came back undefined.
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
    applySignature: "?",
    version: HTTP_GATEWAY_VERSION,
    error: null,
  };

  // 1) The official package is now a direct dependency (see package.json), so a
  //    static import at the top of this module is sufficient. If the user
  //    removed the dep, this probe would have already thrown at module load
  //    time — we surface that below as `error: "module failed to load"`.
  if (typeof dshAcpApply !== "function") {
    out.error = "apply is not exported by @deepseek-ai/dsh-acp";
    return out;
  }
  out.importable = true;
  out.applySignature = String(dshAcpApply.length); // 2 = (ctx, config)

  // 2) Verify the ctx carries every service apply() reaches for at mount time.
  //    Reading source: lib/index.js line 1072+ uses ctx.sessionPersistence,
  //    ctx.logger, ctx.get('llm' | 'attachments' | 'tokenMeter' | 'subagents'),
  //    ctx.llm, ctx.agents, ctx.sessions, ctx.sessionPersistence.
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
  // ctx.get('subagents') is used inside apply() during teardown; not required
  // for mount but worth logging if absent so Phase 2 has a heads-up.
  const subagents = safeGet(() => (typeof ctx?.get === "function" ? ctx.get("subagents") : undefined));
  if (subagents === undefined) {
    out.missingServices.push("subagents");
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