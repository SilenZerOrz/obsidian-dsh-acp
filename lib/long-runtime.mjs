// lib/long-runtime.mjs — In-process long-running ACP adapter for P2.
//
// Architecture (P2 roadmap):
//   - dsh-acp runs IN-PROCESS inside dsh (via the cordis plugin index.mjs),
//     sharing dsh's cordis ctx so we can directly call ctx.llm.stream(),
//     ctx.on('agent/pre-step'), ctx.on('approval/request'), etc.
//   - Each prompt turn subscribes to LLM stream chunks and translates them to
//     ACP sessionUpdate notifications (agent_message_chunk / agent_thought_chunk /
//     tool_call_update / usage_update / ...).
//   - Permission gating: 4 modes (default/acceptEdits/dontAsk/bypassPermissions)
//     delegated to lib/permission-gate.mjs.
//
// P1.0 (this commit): skeleton only — init() throws a clear placeholder so the
// dual-runtime dispatch can be wired end-to-end without the full long path.
// P1.5 will replace init() to connect ctx.llm.stream() + emit real chunks.
// P2.0 will add the approval/request bridge + permission-gate integration.

/**
 * @typedef {Object} LongRuntimeInitOptions
 * @property {object} cordisCtx - dsh's cordis context (or a compatible mock)
 * @property {object} acpClient - ACP SDK client (cx.notify / cx.request surface)
 * @property {object} permissionConfig - from resolvePermissionConfig()
 * @property {string} sessionId - current ACP session id
 * @property {string} cwd - working directory
 */

/**
 * @typedef {Object} PromptParams
 * @property {string} sessionId
 * @property {string|object|object[]} prompt - raw ACP prompt (text or blocks)
 * @property {AbortSignal} [signal]
 * @property {object} [sessionConfig] - per-session temperature/reasoningEffort/model
 */

/**
 * Long-running ACP adapter.
 *
 * Lifecycle:
 *   const rt = new LongRuntime();
 *   await rt.init({ cordisCtx, acpClient, ... });
 *   const result = await rt.prompt(params);  // per turn
 *   await rt.dispose();                       // on session close / adapter exit
 *
 * P1.0: init() throws a descriptive placeholder so callers (dsh-acp.mjs /
 *       index.mjs) can detect the not-yet-implemented state and fall back
 *       to spawn mode (when runtime.spawnFallback === true).
 */
export class LongRuntime {
  constructor() {
    /** @type {object|null} */
    this.cordisCtx = null;
    /** @type {object|null} */
    this.acpClient = null;
    /** @type {object|null} */
    this.permissionConfig = null;
    /** @type {string|null} */
    this.cwd = null;
    this._initialized = false;
  }

  /**
   * Initialize the long runtime with the dsh cordis ctx and ACP client.
   *
   * @param {LongRuntimeInitOptions} opts
   */
  async init(opts) {
    this.cordisCtx = opts.cordisCtx;
    this.acpClient = opts.acpClient;
    this.permissionConfig = opts.permissionConfig ?? { mode: "default", timeoutMs: 300000, editTools: [] };
    this.cwd = opts.cwd;
    this._initialized = true;

    // P1.0: full long path not implemented yet. Throw so the caller's
    // tryLongFallbackSpawn() can route back to spawn mode.
    throw new Error(
      "LongRuntime.init: P1.0 skeleton only. The long-running path " +
        "(ctx.llm.stream / agent events / approval gate) lands in P1.5 + P2.0. " +
        "Set runtime.spawnFallback=true (default) to fall back to spawn mode."
    );
  }

  /**
   * Run one ACP prompt turn. (P1.0: unimplemented; will be wired in P1.5.)
   *
   * @param {PromptParams} _params
   * @returns {Promise<{stopReason: string, usage?: object, text?: string}>}
   */
  async prompt(_params) {
    if (!this._initialized) {
      throw new Error("LongRuntime.prompt: not initialized — call init() first");
    }
    throw new Error("LongRuntime.prompt: not implemented (P1.5)");
  }

  /** Release resources held by this runtime (event subscriptions, timers). */
  async dispose() {
    this.cordisCtx = null;
    this.acpClient = null;
    this.permissionConfig = null;
    this._initialized = false;
  }
}

/** Singleton accessor — at most one LongRuntime per process. */
let _singleton = null;

/**
 * Get (or lazily create) the process-wide LongRuntime instance.
 *
 * @returns {LongRuntime}
 */
export function getLongRuntime() {
  if (!_singleton) _singleton = new LongRuntime();
  return _singleton;
}

/** Reset the singleton (used by tests / dispose flows). */
export function resetLongRuntime() {
  _singleton = null;
}
