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
//   2. DSH_ACP_RUNTIME_MODE env (explicit override)
//   3. DSH_IN_CORDIS=1 (set by the cordis plugin when in-process hosting)
//   4. default "spawn" for standalone binary

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
 * @property {number} timeoutMs - max wait for user approval before default reject
 * @property {string[]} editTools - tool names that acceptEdits auto-allows
 */

/** Default permission config — matches claude-agent-acp's defaults. */
export const PERMISSION_DEFAULTS = Object.freeze({
  mode: "default",
  timeoutMs: 300000, // 5 minutes
  editTools: ["Edit", "Write", "MultiEdit", "NotebookEdit"],
});

/** Default runtime config. */
export const RUNTIME_DEFAULTS = Object.freeze({
  mode: "spawn",
  spawnFallback: true,
});

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

  // 1. headless profile is ALWAYS spawn — long mode needs cordis ctx, which a
  //    headless spawn cannot provide. This protects existing headless users.
  if (env.DSH_PROFILE === "headless") return "spawn";

  // 2. Explicit override wins
  const explicit = env.DSH_ACP_RUNTIME_MODE;
  if (explicit === "long" || explicit === "spawn") return explicit;

  // 3. cordis bundle marker — set by index.mjs when hosting long in-process.
  //    Standalone binary never has this set, so falls through to spawn.
  if (env.DSH_IN_CORDIS === "1") return "long";

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
  return {
    mode: validModes.includes(mode) ? mode : PERMISSION_DEFAULTS.mode,
    timeoutMs: Number(env.DSH_ACP_PERMISSION_TIMEOUT_MS) || PERMISSION_DEFAULTS.timeoutMs,
    editTools,
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
