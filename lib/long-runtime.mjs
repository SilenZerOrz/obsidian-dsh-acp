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
import { PermissionGate } from "./permission-gate.mjs";

// Constant for the ACP request_permission method. Centralized so a future
// SDK rename is a one-line change.
const ACP_METHOD_REQUEST_PERMISSION = "session/request_permission";

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
    /**
     * Per-turn AbortController created on each prompt() so the
     * approvalListener can race gate.resolve against the same cancellation
     * signal that the upstream proxy uses. Phase B aligns with the official
     * claude-agent-acp `raceWithAbort` primitive (no wall-clock timeout).
     *
     * @type {AbortController|null}
     */
    this._activeAbortController = null;
  }

  /**
   * Initialize the long runtime with the dsh cordis ctx and ACP client.
   *
   * P1.5: stores references and validates ctx.llm.stream exists.
   * P2.0: also wires agent/pre-step (push tool_call_update pending) +
   *       approval/request (delegate to PermissionGate) listeners on the
   *       cordis ctx, so tool execution becomes visible + gated in ACP.
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
    //
    // Note (2026-09-17 P3.0 e2e): `ctx.llm` property access throws
    //   "cannot get property \"llm\" without inject" when dsh-acp's frame does
    //   not declare `llm` in its `inject` array (index.mjs exports inject=[]).
    //   cordis's `ctx.get("llm")` performs a runtime service lookup that does
    //   NOT enforce the inject-declaration guard (returns undefined when the
    //   service is absent), matching the lazy-lookup idiom used across this
    //   project (session-panel.mjs:299, index.mjs:139). Fall back to direct
    //   property access for non-cordis test hosts (plain object ctx).
    const llm =
      opts.cordisCtx.get?.("llm") ??
      opts.cordisCtx.llm;
    if (!llm || typeof llm.stream !== "function") {
      throw new Error(
        "LongRuntime.init: cordisCtx.llm.stream() not available — " +
          "dsh version too old (need 0.1.5-rc.2+) or not loaded inside dsh process.",
      );
    }

    this.cordisCtx = opts.cordisCtx;
    this.llm = llm;
    this.acpClient = opts.acpClient;
    // Phase B: drop the 5-minute wall-clock default. PermissionGate now
    // races the requester against an AbortSignal (no auto-time-out). The
    // caller still passes editTools so service aliases stay consistent.
    this.permissionConfig = opts.permissionConfig ?? {
      mode: "default",
      editTools: ["Edit", "Write", "MultiEdit", "NotebookEdit"],
    };
    this.cwd = opts.cwd ?? null;
    this.defaultModel = opts.model ?? null;
    this.gate = new PermissionGate(this.permissionConfig);
    this._initialized = true;

    // P2.0 step 2: subscribe to agent/pre-step + approval/request events so
    // tool execution becomes visible + gated. Both listeners are stored in
    // _agentListeners so dispose() can detach cleanly.
    this._registerAgentHooks();
  }

  /**
   * Register agent/pre-step + approval/request listeners on the cordis ctx.
   * Tool calls become observable (pending → in_progress → completed via the
   * chunk-mapper) and approval decisions are delegated to PermissionGate.
   */
  _registerAgentHooks() {
    if (!this.cordisCtx || typeof this.cordisCtx.on !== "function") return;

    // pre-step fires before each tool call. We push a "pending" tool_call_update
    // so Obsidian's UI can show the tool queued before it runs.
    const preStepListener = async (event) => {
      try {
        const update = this._buildPendingToolUpdate(event);
        if (update) await this._notifyUpdate(event?.sessionId ?? null, update);
      } catch {
        /* best-effort */
      }
    };
    this.cordisCtx.on("agent/pre-step", preStepListener);
    this._agentListeners.push({ event: "agent/pre-step", listener: preStepListener });

    // approval/request is dsh's hook for "may I run this tool?". We resolve
    // via PermissionGate and reply allow/deny to the listener.
    const approvalListener = async (event, reply) => {
      try {
        const decision = await this.gate.resolve(
          {
            toolName: event?.toolName ?? event?.name ?? "unknown",
            args: event?.args ?? event?.input,
            reason: event?.reason,
          },
          event?.toolCallId ?? event?.id ?? "tc-unknown",
          // Wrap acpRequester so PermissionGate can call request_permission.
          this._buildAcpRequester(),
          // Phase B: race against the active turn's abort signal. If the
          // upstream proxy / turn / session cancels, gate.resolve rejects
          // with AbortError instead of hanging until 5min → deny.
          this._activeAbortController?.signal,
        );
        if (decision.outcome === "deny") {
          reply?.reject?.(decision.reason ?? "permission denied");
        } else {
          reply?.accept?.();
        }
      } catch (err) {
        // AbortError propagation: reject the dsh approval with the same
        // semantic so dsh stops the in-progress tool instead of stalling.
        if (err && err.name === "AbortError") {
          reply?.reject?.(err.message ?? "aborted");
          return;
        }
        reply?.reject?.(err?.message ?? String(err));
      }
    };
    this.cordisCtx.on("approval/request", approvalListener);
    this._agentListeners.push({ event: "approval/request", listener: approvalListener });
  }

  /**
   * Build a "pending" tool_call_update from a dsh pre-step event. Returns
   * null when the event doesn't carry enough info to surface one.
   */
  _buildPendingToolUpdate(event) {
    const toolCallId = event?.toolCallId ?? event?.id;
    const toolName = event?.toolName ?? event?.name;
    if (!toolCallId || !toolName) return null;
    return {
      sessionUpdate: "tool_call_update",
      toolCallId,
      title: toolName,
      status: "pending",
    };
  }

  /**
   * Build a PermissionGate-compatible acpRequester that calls the ACP
   * client's request_permission JSON-RPC method. The current session id is
   * captured per-call via the active prompt turn (passed in via sessionId).
   * Falls back to a no-op if no client is wired.
   */
  _buildAcpRequester() {
    return {
      request: async (toolCallId, title, options) => {
        const live = this._liveAcpClient;
        if (!live || typeof live.request !== "function") return "deny";
        try {
          const res = await live.request(ACP_METHOD_REQUEST_PERMISSION, {
            sessionId: this._activeSessionId ?? "",
            toolCallId,
            title,
            options,
          });
          // ACP returns { outcome: { outcome: "selected" | "cancelled", optionId?: string } }
          // Map optionId back to our gate vocabulary.
          const opt = res?.outcome?.optionId ?? "";
          if (opt.startsWith("allow")) return "allow_once";
          if (opt.startsWith("reject")) return "reject_once";
          if (res?.outcome?.outcome === "cancelled") return "reject_once";
          return "deny";
        } catch {
          return "deny";
        }
      },
    };
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
    // Phase B: own AbortController per turn. The caller-provided signal (if
    // any) triggers ours, and the approvalListener can race gate.resolve
    // against this._activeAbortController.signal so a turn cancel propagates
    // all the way into the pending permission request.
    this._activeAbortController = new AbortController();
    const linkAbort = (e) => this._activeAbortController.abort(e?.reason);
    if (params.signal) {
      if (params.signal.aborted) {
        this._activeAbortController.abort(params.signal.reason);
      } else {
        params.signal.addEventListener("abort", linkAbort, { once: true });
      }
    }
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
    // Make the active sessionId + live acp client reachable to the
    // permission-gate's acpRequester (built once at init). When the prompt
    // handler in dsh-acp.mjs swaps rt.acpClient per turn, it sets this too.
    this._activeSessionId = params.sessionId;
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
    // iterates it and accumulates the result. Use the llm reference resolved
    // in init() (which tolerates non-injected cordis ctx via ctx.get("llm")).
    let result;
    try {
      const stream = this.llm.stream(options);
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
    } finally {
      // Phase B: tear down the per-turn abort signal + listener regardless of
      // outcome. A late abort after the turn resolves must not leak into the
      // next prompt's wait, and the listener must be detached to avoid the
      // EventEmitter holding a stale closure.
      try {
        if (params.signal) params.signal.removeEventListener("abort", linkAbort);
      } catch {
        /* best-effort */
      }
      this._activeAbortController = null;
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
    // Phase B: abort any in-flight permission wait so dispose doesn't hang on
    // a gate.resolve that's awaiting an unresponsive client.
    try {
      this._activeAbortController?.abort?.("LongRuntime disposed");
    } catch {
      /* best-effort */
    }
    this._activeAbortController = null;
    this.gate?.clearCache?.();
    this.gate = null;
    this._activeSessionId = null;
    this._liveAcpClient = null;
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
  // dsh's GenerateOptions.model is the BARE model id — provider is a separate
  // field selected via registration(provider). When model carries a
  // `provider/model` prefix (FE-1 flattened dropdown value), strip it so the
  // adapter never passes a namespaced model id to resolveModel().
  const bareModel =
    provider && typeof model === "string" && model.startsWith(provider + "/")
      ? model.slice(provider.length + 1)
      : model;

  const messages = [];
  if (Array.isArray(history)) messages.push(...history.map(normalizeMessage));
  messages.push({ role: "user", content: [{ type: "text", text: promptText }] });

  /** @type {object} */
  const options = {
    provider,
    model: bareModel,
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
 * Normalize a single message into dsh's expected shape.
 *
 * Why this exists (2026-09-17 P3.0 e2e): dsh's LlmRuntime calls
 * `content.some(...)` on the user message content, which requires `content`
 * to be an array of typed parts (`[{ type, text }]` etc.). Passing
 * `content: "plain string"` (the previous shape) produced a terminal
 * `content.some is not a function` error chunk that the bridge mapped to
 * `stopReason: "cancelled"` — Obsidian saw nothing.
 *
 * Rules:
 *   - `content` already an array → leave as-is (preserve any image/audio parts).
 *   - `content` a string → wrap as `[{ type: "text", text: content }]`.
 *   - `content` null/undefined/missing → empty parts array (dsh treats as
 *     tool-result etc.; we don't synthesise text).
 *   - `role` and other top-level fields pass through unchanged.
 *
 * @param {object} m
 * @returns {object}
 */
function normalizeMessage(m) {
  if (!m || typeof m !== "object") return { role: "user", content: [] };
  const { role, content, ...rest } = m;
  let normalized;
  if (Array.isArray(content)) normalized = content;
  else if (typeof content === "string")
    normalized = [{ type: "text", text: content }];
  else normalized = [];
  return { ...rest, role: role ?? "user", content: normalized };
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
