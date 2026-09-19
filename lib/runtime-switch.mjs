// lib/runtime-switch.mjs — Dual-runtime mode resolution for P2 long-running.
//
// dsh-acp supports two runtime modes:
//   - "spawn"  : per-turn `spawn dsh --profile headless <prompt>` (v0.2.1 behavior)
//   - "long"   : in-process long-running, subscribes to dsh's agent/LLM events
//
// This module centralizes the runtime-mode resolution policy so both
// `dsh-acp.mjs` (standalone binary) and `index.mjs` (cordis plugin) agree.
//
// Resolution order (highest priority first):
//   1. DSH_PROFILE=headless → forced to "spawn" (existing headless users must
//      not change behavior; long mode requires dsh's cordis ctx which is not
//      available in a standalone headless invocation)
//   2. DSH_ACP_RUNTIME_MODE env (explicit override; downgraded to spawn if
//      dsh version lacks P2 subpackages — see version-detect.mjs)
//   3. DSH_IN_CORDIS=1 + hasP2Apis() → "long"; else fall through
//   4. default "spawn" for standalone binary

import { hasP2Apis } from "./version-detect.mjs";

/**
 * @typedef {"long" | "spawn"} RuntimeMode
 */

/**
 * @typedef {Object} RuntimeConfig
 * @property {RuntimeMode} mode - "long" or "spawn"
 * @property {boolean} spawnFallback - if true, fall back to spawn when long init fails
 */

/**
 * @typedef {Object} PermissionConfig
 * @property {"default"|"acceptEdits"|"dontAsk"|"bypassPermissions"} mode
 * @property {string[]} editTools - tool names that acceptEdits auto-allows
 * @property {boolean} [enableRootBypass] - honor bypassPermissions even when
 *           process.geteuid() === 0 (default false). Mirrors the official
 *           `IS_SANDBOX` env-var escape hatch.
 * @property {number} [timeoutMs] - DEPRECATED. Ignored as of Phase B (2026-09-18).
 *           Removed the wall-clock 5-minute race in favor of an AbortSignal-
 *           driven `raceWithAbort` (parity with claude-agent-acp). Kept in
 *           the typedef so old callers don't crash; the field is a no-op.
 */

/** Default permission config — matches claude-agent-acp's defaults. */
export const PERMISSION_DEFAULTS = Object.freeze({
  mode: "default",
  editTools: ["Edit", "Write", "MultiEdit", "NotebookEdit"],
});

/** Default runtime config. */
export const RUNTIME_DEFAULTS = Object.freeze({
  mode: "spawn",
  spawnFallback: true,
});

// P2 detection — wraps version-detect.mjs::hasP2Apis() with a one-time cache
// to keep resolveRuntimeMode pure-ish (no repeated package.json reads).
let _p2Cache = null;
function checkP2Available() {
  // Test escape hatch: DSH_ACP_FORCE_P2_AVAILABLE=1 forces the resolver to
  // treat P2 APIs as available, regardless of the actual installed dsh
  // version. Used by unit tests that exercise the "long" branch without
  // having the dsh web profile's node_modules in scope.
  if (process.env.DSH_ACP_FORCE_P2_AVAILABLE === "1") return true;
  if (process.env.DSH_ACP_FORCE_P2_AVAILABLE === "0") return false;
  if (_p2Cache !== null) return _p2Cache;
  try {
    _p2Cache = hasP2Apis();
  } catch {
    _p2Cache = false;
  }
  return _p2Cache;
}

/**
 * Clear the P2 availability cache. Test-only — production code never calls
 * this. Re-reads hasP2Apis() on the next checkP2Available() invocation.
 */
export function _resetP2CacheForTesting() {
  _p2Cache = null;
}

/**
 * Resolve the runtime mode at startup. Pure function — no side effects.
 *
 * @param {NodeJS.ProcessEnv} [env=process.env]
 * @returns {RuntimeMode}
 */
export function resolveRuntimeMode(env = process.env) {
  // 0. Test escape hatch: --mock-llm explicitly requests long mode even when
  //    the profile would normally force spawn. Used by acp-feature-test.mjs
  //    to exercise the long-runtime path end-to-end without a real dsh.
  if (env.DSH_ACP_MOCK_LLM === "1") return "long";

  // 0.5 Official-bridge decoupling (Phase 2 first cut). When
  //    DSH_ACP_USE_OFFICIAL_BRIDGE=1, the in-process cordis ctx is OWNED by
  //    apply() for prompt routing. Legacy long-runtime must NOT boot (startLong
  //    → LongRuntime.init → _registerAgentHooks installs an `agent/pre-step`
  //    listener that collapses apply()'s pre-step middleware chain and breaks
  //    every turn — see dsh-legacy-prestep-conflicts-with-apply). Forcing spawn
  //    here is the single source of truth: it covers BOTH index.mjs's startLong
  //    boot decision AND the standalone dsh-acp.mjs binary, so legacy hooks can
  //    never be installed onto the official-owned ctx. Legacy ACP capabilities
  //    that need no ctx (initialize/session/list) still work via the spawn /
  //    standalone path.
  if (env.DSH_ACP_USE_OFFICIAL_BRIDGE === "1") return "spawn";

  // 1. headless profile is ALWAYS spawn — long mode needs cordis ctx, which a
  //    headless spawn cannot provide. This protects existing headless users.
  if (env.DSH_PROFILE === "headless") return "spawn";

  // 2. Explicit override wins — BUT if user explicitly asked for long in a
  //    context where P2 subpackages aren't installed (0.1.5-rc.1/rc.2 or
  //    older), downgrade silently to spawn and surface a hint. This is the
  //    "pre-check" layer; the runtime tryLongFallbackSpawn below is the
  //    fallback layer for cases where pre-check is bypassed.
  const explicit = env.DSH_ACP_RUNTIME_MODE;
  if (explicit === "long" || explicit === "spawn") {
    if (explicit === "long" && !checkP2Available()) {
      // eslint-disable-next-line no-console
      console.warn(
        "[dsh-acp] DSH_ACP_RUNTIME_MODE=long requested but dsh P2 subpackages unavailable; downgrading to spawn mode",
      );
      return "spawn";
    }
    return explicit;
  }

  // 3. cordis bundle marker — set by index.mjs when hosting long in-process.
  //    Standalone binary never has this set, so falls through to spawn.
  //    Pre-check: in-cordis default is long, but only when P2 subpackages are
  //    installed; otherwise fall through to spawn (default for standalone).
  if (env.DSH_IN_CORDIS === "1") {
    return checkP2Available() ? "long" : "spawn";
  }

  // 4. Default: standalone binary → spawn (backward-compatible)
  return "spawn";
}

/**
 * Resolve the runtime config (mode + fallback flag).
 *
 * @param {NodeJS.ProcessEnv} [env=process.env]
 * @returns {RuntimeConfig}
 */
export function resolveRuntimeConfig(env = process.env) {
  const mode = resolveRuntimeMode(env);
  // Treat any of "false"/"0"/"no" as opt-out; default true.
  const raw = env.DSH_ACP_SPAWN_FALLBACK;
  const spawnFallback = !(raw === "false" || raw === "0" || raw === "no");
  return { mode, spawnFallback };
}

/**
 * Resolve the permission config from env (DSH_ACP_PERMISSION_*) with defaults.
 *
 * @param {NodeJS.ProcessEnv} [env=process.env]
 * @returns {PermissionConfig}
 */
export function resolvePermissionConfig(env = process.env) {
  const mode = env.DSH_ACP_PERMISSION_MODE;
  const validModes = ["default", "acceptEdits", "dontAsk", "bypassPermissions"];
  const editToolsRaw = env.DSH_ACP_PERMISSION_EDIT_TOOLS;
  const editTools = editToolsRaw && editToolsRaw.length > 0
    ? editToolsRaw.split(",").map((s) => s.trim()).filter(Boolean)
    : PERMISSION_DEFAULTS.editTools.slice();
  const enableRootBypass = env.DSH_ACP_PERMISSION_ENABLE_ROOT_BYPASS === "true";
  // Phase B: timeoutMs is no longer consumed by PermissionGate. We still
  // read the env var (and pass the value through as an inert field) so old
  // diagnostic tooling that prints the resolved config doesn't go blank.
  // New callers should treat it as deprecated.
  const rawTimeout = env.DSH_ACP_PERMISSION_TIMEOUT_MS;
  let timeoutMs;
  if (rawTimeout && rawTimeout.length > 0) {
    const parsed = Number(rawTimeout);
    if (Number.isFinite(parsed) && parsed >= 0) {
      timeoutMs = parsed;
    }
  }
  return {
    mode: validModes.includes(mode) ? mode : PERMISSION_DEFAULTS.mode,
    editTools,
    enableRootBypass,
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
  };
}

/**
 * Try a long-mode operation; if it throws and spawnFallback is true,
 * run the spawn-mode fallback. Logs the fallback decision.
 *
 * @template T
 * @param {() => Promise<T>} longFn - the long-mode operation to attempt
 * @param {() => Promise<T>} spawnFn - the spawn-mode fallback
 * @param {RuntimeConfig} config
 * @returns {Promise<T>}
 */
export async function tryLongFallbackSpawn(longFn, spawnFn, config) {
  if (config.mode !== "long") return spawnFn();
  try {
    return await longFn();
  } catch (err) {
    if (!config.spawnFallback) throw err;
    const msg = err && err.message ? err.message : String(err);
    // eslint-disable-next-line no-console
    console.warn(`[dsh-acp] long mode failed (${msg}); falling back to spawn mode`);
    return spawnFn();
  }
}
