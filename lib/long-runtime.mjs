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
// Lifecycle:
//   P1.0 (skeleton) — init() throws placeholder; spawn fallback handles turns.
//   P1.5 (this commit) — init() succeeds; prompt() wires ctx.llm.stream() to
//                        the LLMStreamBridge and emits sessionUpdates over
//                        the ACP client. Permission gate + approval/request
//                        bridge still pending (P2.0).
//   P2.0 — 4-mode PermissionGate + agent/pre-step + approval/request wiring.
//   P2.5 — per-session temperature/reasoningEffort in ctx.llm.stream options.

import { LLMStreamBridge } from "./llm-event-bridge.mjs";

/**
 * @typedef {Object} LongRuntimeInitOptions
 * @property {object} cordisCtx - dsh's cordis context (or a compatible mock).
 *           Must expose `.llm.stream(options)` returning an async iterable of
 *           dsh StreamChunks, and `.on(event, listener)` for later P2.0 hooks.
 * @property {object} acpClient - ACP SDK client surface. Must expose
 *           `.notify(method, params)` for sessionUpdate pushes.
 * @property {object} [permissionConfig] - from resolvePermissionConfig(). P2.0
 *           will consume this; P1.5 only stores it for forward compatibility.
 * @property {string} [cwd] - working directory (used for archive metadata).
 * @property {string} [model] - default model id when sessionConfig omits one.
 */

/**
 * @typedef {Object} PromptParams
 * @property {string} sessionId
 * @property {string|object|object[]} prompt - raw ACP prompt (text or blocks).
 * @property {AbortSignal} [signal] - cancellation signal; honored between chunks.
 * @property {object} [sessionConfig] - per-session overrides:
 *   { model?: string, temperature?: number, reasoningEffort?: string,
 *     messages?: Message[] }
 */

/**
 * @typedef {Object} SessionConfig
 * @property {string} [model]
 * @property {number} [temperature]
 * @property {string} [reasoningEffort]
 * @property {Array<object>} [messages] - prior conversation history
 */

/**
 * Long-running ACP adapter.
 *
 * Lifecycle:
 *   const rt = new LongRuntime();
 *   await rt.init({ cordisCtx, acpClient, ... });
 *   const result = await rt.prompt(params);  // per turn
 *   await rt.dispose();                       // on session close / adapter exit
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
    /** @type {string|null} */
    this.defaultModel = null;
    this._initialized = false;
    this._agentListeners = []; // [{ event, listener }] for P2.0 cleanup
  }

  /**
   * Initialize the long runtime with the dsh cordis ctx and ACP client.
   *
   * P1.5: stores references and validates ctx.llm.stream exists. The full
   * approval/request bridge + permission gate land in P2.0 (registered here
   * but no-op until then).
   *
   * @param {LongRuntimeInitOptions} opts
   */
  async init(opts) {
    if (!opts || !opts.cordisCtx) {
      throw new Error("LongRuntime.init: cordisCtx is required");
    }
    if (!opts.acpClient) {
      throw new Error("LongRuntime.init: acpClient is required");
    }
    // Validate ctx.llm.stream exists so we fail fast with a clear message
    // rather than deep inside the first prompt turn.
    const llm = opts.cordisCtx.llm;
    if (!llm || typeof llm.stream !== "function") {
      throw new Error(
        "LongRuntime.init: cordisCtx.llm.stream() not available — " +
          "dsh version too old (need 0.1.5-rc.2+) or not loaded inside dsh process.",
      );
    }

    this.cordisCtx = opts.cordisCtx;
    this.acpClient = opts.acpClient;
    this.permissionConfig = opts.permissionConfig ?? {
      mode: "default",
      timeoutMs: 300000,
      editTools: ["Edit", "Write", "MultiEdit", "NotebookEdit"],
    };
    this.cwd = opts.cwd ?? null;
    this.defaultModel = opts.model ?? null;
    this._initialized = true;

    // P2.0 reservation: when PermissionGate lands, attach agent/pre-step +
    // approval/request listeners here. Storing the teardown list keeps
    // dispose() able to unsubscribe cleanly.
    //
    // For now P1.5 deliberately does not register these — would require
    // permission-gate.mjs which is P2.0 work.
  }

  /**
   * Run one ACP prompt turn.
   *
   * Flow:
   *   1. Extract text from params.prompt
   *   2. Build GenerateOptions from sessionConfig + defaultModel + history
   *   3. ctx.llm.stream(options) → async iterable of StreamChunks
   *   4. LLMStreamBridge.pump(stream) emits sessionUpdates via acpClient
   *   5. Return { stopReason, usage, text? } to the ACP server
   *
   * @param {PromptParams} params
   * @returns {Promise<{
   *   stopReason: "end_turn"|"max_tokens"|"max_turn_requests"|"refusal"|"cancelled",
   *   usage?: object,
   *   text?: string
   * }>}
   */
  async prompt(params) {
    this._requireInitialized();

    const promptText = extractPromptText(params.prompt);
    const sessionConfig = params.sessionConfig ?? {};
    const options = buildStreamOptions({
      promptText,
      sessionConfig,
      defaultModel: this.defaultModel,
      history: sessionConfig.messages ?? [],
      cwd: this.cwd,
    });

    // Bridge: owns one MapperState + lifecycle. Each turn gets its own
    // bridge so concurrent turns (future) wouldn't share state.
    const updates = [];
    // Accumulate text per messageId so a legacy caller (or the dsh web route)
    // can render the final answer without re-reading session state. Keyed by
    // messageId so reasoning + text blocks don't clobber each other.
    const textByMessage = new Map();
    const bridge = new LLMStreamBridge({
      onUpdate: async (update) => {
        // Push to the ACP client as a sessionUpdate notification.
        await this._notifyUpdate(params.sessionId, update);
        updates.push(update);
        if (update.sessionUpdate === "agent_message_chunk" && update.content?.text) {
          if (textByMessage.has(update.messageId)) {
            // Already accumulated from deltas — replace with the assembled
            // snapshot when block-end arrives. The deltas may be missing
            // prefix (e.g. mock chunks append "hello " + "world" but the
            // assembled text is "mock-long: hello world"). The snapshot is
            // authoritative; use it as the canonical text for this message.
            textByMessage.set(update.messageId, update.content.text);
          } else {
            textByMessage.set(update.messageId, update.content.text);
          }
        }
      },
    });

    // Kick off the stream. ctx.llm.stream is an AsyncIterable — Bridge.pump
    // iterates it and accumulates the result.
    let result;
    try {
      const stream = this.cordisCtx.llm.stream(options);
      result = await bridge.pump(stream);
    } catch (err) {
      // If ctx.llm.stream itself throws synchronously (e.g. provider lookup
      // failed before the first pull), the bridge never sees the stream.
      // Surface this to the caller as a cancelled turn — the spawn fallback
      // (or higher-level error handling) decides how to escalate.
      return {
        stopReason: "cancelled",
        text: `[long-runtime] stream failed: ${err?.message ?? String(err)}`,
      };
    }

    // Final text = concatenation of all messageId buckets in insertion order.
    // For single-message streams (most turns) this collapses to the full text.
    const finalText = Array.from(textByMessage.values()).join("");
    return {
      stopReason: result.stopReason,
      usage: result.usage ?? undefined,
      text: finalText || undefined,
    };
  }

  /** Release resources held by this runtime (event subscriptions, timers). */
  async dispose() {
    // Tear down any agent/* listeners registered during init (P2.0).
    if (this.cordisCtx && typeof this.cordisCtx.off === "function") {
      for (const { event, listener } of this._agentListeners) {
        try {
          this.cordisCtx.off(event, listener);
        } catch {
          /* best-effort cleanup */
        }
      }
    }
    this._agentListeners = [];
    this.cordisCtx = null;
    this.acpClient = null;
    this.permissionConfig = null;
    this.cwd = null;
    this.defaultModel = null;
    this._initialized = false;
  }

  // --- internals -----------------------------------------------------------

  _requireInitialized() {
    if (!this._initialized) {
      throw new Error("LongRuntime.prompt: not initialized — call init() first");
    }
  }

  /**
   * Send one sessionUpdate to the ACP client. Wraps acpClient.notify so the
   * rest of the file only knows the abstract "send an update" verb.
   *
   * @param {string} sessionId
   * @param {object} update - ACP sessionUpdate payload (already shaped by
   *                         chunk-mapper).
   */
  async _notifyUpdate(sessionId, update) {
    if (!this.acpClient || typeof this.acpClient.notify !== "function") {
      return; // no client → drop on the floor (test/dev convenience)
    }
    try {
      await this.acpClient.notify("session/update", { sessionId, update });
    } catch {
      // Notify errors must not kill the stream — the next chunk may still
      // succeed. P3.0 will add structured error logging.
    }
  }
}

// --- module-level helpers --------------------------------------------------

/**
 * Extract prompt text from ACP's polymorphic prompt payload.
 *
 * Mirrors dsh-acp.mjs::extractPromptText so long mode behaves the same as
 * spawn mode for the same input.
 *
 * @param {string|object|object[]} prompt
 * @returns {string}
 */
export function extractPromptText(prompt) {
  if (typeof prompt === "string") return prompt;
  if (Array.isArray(prompt)) {
    return prompt
      .map((b) => (b?.type === "text" && typeof b.text === "string" ? b.text : ""))
      .join("\n");
  }
  if (prompt && Array.isArray(prompt.content)) {
    return prompt.content
      .map((b) => (b?.type === "text" && typeof b.text === "string" ? b.text : ""))
      .join("\n");
  }
  return String(prompt ?? "");
}

/**
 * Build the GenerateOptions object that ctx.llm.stream() expects.
 *
 * @param {Object} input
 * @param {string} input.promptText
 * @param {SessionConfig} input.sessionConfig
 * @param {string|null} input.defaultModel
 * @param {Array<object>} input.history
 * @param {string|null} input.cwd
 * @returns {object} GenerateOptions
 */
export function buildStreamOptions(input) {
  const { promptText, sessionConfig, defaultModel, history } = input;
  const model = sessionConfig.model || defaultModel;
  if (!model) {
    throw new Error(
      "LongRuntime.prompt: no model configured. Set sessionConfig.model or " +
        "runtime.defaultModel (e.g. from session_config_options).",
    );
  }
  // Provider routing is dsh's responsibility — pass through the model id as
  // dsh expects and let dsh look up the provider from its configured catalog.
  const provider = sessionConfig.provider ?? extractProvider(model);

  const messages = [];
  if (Array.isArray(history)) messages.push(...history);
  messages.push({ role: "user", content: promptText });

  /** @type {object} */
  const options = {
    provider,
    model,
    messages,
  };
  if (typeof sessionConfig.temperature === "number") {
    options.temperature = sessionConfig.temperature;
  }
  if (sessionConfig.reasoningEffort) {
    options.reasoningEffort = sessionConfig.reasoningEffort;
  }
  return options;
}

/**
 * Pick a provider id from the model id when sessionConfig didn't supply one.
 * dsh convention: "provider/model" → first segment is the provider. Bare
 * model ids default to "default".
 *
 * @param {string} model
 * @returns {string}
 */
function extractProvider(model) {
  if (typeof model !== "string") return "default";
  const slash = model.indexOf("/");
  if (slash > 0) return model.slice(0, slash);
  return "default";
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
