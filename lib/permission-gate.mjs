// lib/permission-gate.mjs — 4-mode permission gate for P2 long-running ACP.
//
// Decides whether a dsh agent tool call (Edit/Write/bash/Read/...) should be
// auto-allowed, auto-denied, or surface an ACP request_permission dialog to
// the user. Mirrors the claude-agent-acp PermissionMode state machine.
//
// 4 modes (configured via PermissionConfig.mode):
//
//   default            — all tools trigger request_permission (cache-hit short-circuits)
//   acceptEdits       — edit-class tools auto-allow; everything else pops a dialog
//   dontAsk           — emit tool_call_update but never call request_permission
//                       (decision recorded for log/audit)
//   bypassPermissions — everything auto-allows (no dialog, no log noise)
//
// Outcomes: { outcome: "allow" | "deny" | "ask", reason?: string }
//
//   - "allow" / "deny" are terminal: the caller dispatches / blocks the tool
//   - "ask" is only returned in `default` and `acceptEdits` modes when the
//     caller wires `acpRequester` to a real client.request_permission
//     handler. The bridge resolves "ask" by calling acpRequester and returning
//     the user's choice as { outcome: "allow" | "deny" }.
//
// Caching: toolName + sha256(argsJSON) short-circuits the same call so the
// user isn't asked twice in a session for the same edit.
//
// Timeout: if acpRequester doesn't resolve within `timeoutMs`, the default
// decision is "deny" (safer than auto-allow). Callers can override by passing
// their own Promise.race wrapper.

import { createHash } from "node:crypto";

/**
 * @typedef {"default"|"acceptEdits"|"dontAsk"|"bypassPermissions"} PermissionMode
 */

/**
 * @typedef {Object} PermissionConfig
 * @property {PermissionMode} mode
 * @property {number} timeoutMs - max wait before defaulting to deny
 * @property {string[]} editTools - tool names that acceptEdits auto-allows
 */

/**
 * @typedef {Object} ToolCallRequest
 * @property {string} toolName
 * @property {object} [args] - tool input (may be undefined for no-arg tools)
 * @property {string} [reason] - optional human-readable context (e.g. from
 *           the model: "I want to edit foo.md to add the changelog entry")
 */

/**
 * @typedef {"allow"|"deny"|"ask"} DecisionKind
 */

/**
 * @typedef {Object} PermissionDecision
 * @property {DecisionKind} outcome
 * @property {string} [reason] - short human-readable explanation
 * @property {string} [cachedAs] - when short-circuited by cache, the cached key
 */

/**
 * @typedef {Object} AcpRequester
 *           Adapter to the ACP client's request_permission JSON-RPC call.
 *           Resolves to one of: "allow_once" | "allow_always" | "reject_once" | "reject_always".
 *           The gate maps these to { outcome: "allow" | "deny" }.
 * @property {(toolCallId: string, title: string, options: Array<{name: string, kind: string}>) => Promise<string>} request
 */

/**
 * Permission gate — stateless except for the in-memory cache. Safe to share
 * across turns within one LongRuntime instance.
 */
export class PermissionGate {
  /** @param {PermissionConfig} config */
  constructor(config) {
    if (!config) throw new TypeError("PermissionGate requires a config");
    this.mode = config.mode;
    this.timeoutMs = typeof config.timeoutMs === "number" ? config.timeoutMs : 300000;
    this.editTools = Array.isArray(config.editTools) ? config.editTools : [];
    /** @type {Map<string, "allow"|"deny">} */
    this._cache = new Map();
  }

  /**
   * Resolve one tool-call permission request against the current mode + cache.
   *
   * If the decision is "ask" and an acpRequester is provided, the gate calls
   * acpRequester.request(...) with a timeout and resolves to allow/deny.
   * If no acpRequester is provided, "ask" stays as "ask" (caller must handle).
   *
   * @param {ToolCallRequest} req
   * @param {string} toolCallId - id used for acpRequester and cache key
   * @param {AcpRequester} [acpRequester]
   * @returns {Promise<PermissionDecision>}
   */
  async resolve(req, toolCallId, acpRequester) {
    const cacheKey = this._cacheKey(req);
    // 1. cache hit short-circuits everything
    const cached = this._cache.get(cacheKey);
    if (cached) {
      return { outcome: cached, reason: `cached:${cached}`, cachedAs: cacheKey };
    }

    // 2. mode-based first decision
    const decision = this._decideByMode(req);

    // 3. terminal outcomes return immediately
    if (decision.outcome === "allow" || decision.outcome === "deny") {
      // Only cache user-meaningful decisions; "ask" path resolves later
      // and caches its own result.
      this._cache.set(cacheKey, decision.outcome);
      return decision;
    }

    // 4. "ask" → call ACP if a requester is provided
    if (!acpRequester) return decision;
    return await this._askUser(req, toolCallId, acpRequester, cacheKey);
  }

  /** Clear the in-memory cache (e.g. between sessions). */
  clearCache() {
    this._cache.clear();
  }

  /** Current cache size (test/telemetry helper). */
  get cacheSize() {
    return this._cache.size;
  }

  // --- internals ----------------------------------------------------------

  /** First-pass decision based purely on mode + editTools. No async, no cache. */
  _decideByMode(req) {
    switch (this.mode) {
      case "bypassPermissions":
        return { outcome: "allow", reason: "bypassPermissions" };
      case "dontAsk":
        // Emit-only — caller surfaces the decision in logs but never pops UI
        return { outcome: "allow", reason: "dontAsk" };
      case "acceptEdits":
        if (this._isEditTool(req.toolName)) {
          return { outcome: "allow", reason: "acceptEdits:edit-tool" };
        }
        return { outcome: "ask", reason: "acceptEdits:non-edit" };
      case "default":
      default:
        return { outcome: "ask", reason: "default:ask" };
    }
  }

  _isEditTool(toolName) {
    return typeof toolName === "string" && this.editTools.includes(toolName);
  }

  async _askUser(req, toolCallId, acpRequester, cacheKey) {
    const title = req.reason || `Run ${req.toolName}?`;
    const options = [
      { name: "Allow once", kind: "allow_once" },
      { name: "Reject", kind: "reject_once" },
    ];
    let timer;
    const timeout = new Promise((resolve) => {
      timer = setTimeout(() => resolve("__timeout__"), this.timeoutMs);
    });
    let choice;
    try {
      choice = await Promise.race([
        acpRequester.request(toolCallId, title, options),
        timeout,
      ]);
    } finally {
      clearTimeout(timer);
    }
    if (choice === "__timeout__") {
      // Safer default: deny (claude-agent-acp rejects on timeout too).
      const reason = `permission timeout after ${this.timeoutMs}ms → deny`;
      this._cache.set(cacheKey, "deny");
      return { outcome: "deny", reason };
    }
    const allow = choice === "allow_once" || choice === "allow_always";
    const outcome = allow ? "allow" : "deny";
    this._cache.set(cacheKey, outcome);
    return {
      outcome,
      reason: `user:${choice}`,
      cachedAs: cacheKey,
    };
  }

  /**
   * Build a stable cache key. Hashing argsJSON keeps the key length-bounded
   * regardless of how big the tool input is (common for Edit with whole files).
   */
  _cacheKey(req) {
    const argsJson = req && req.args !== undefined ? safeStringify(req.args) : "";
    const h = createHash("sha256");
    h.update(`${req.toolName}\x00${argsJson}`);
    return h.digest("hex").slice(0, 16);
  }
}

/**
 * JSON.stringify with circular-reference fallback. Tool inputs shouldn't have
 * cycles in practice, but a defensive stringify keeps the gate robust.
 */
function safeStringify(value) {
  const seen = new WeakSet();
  return JSON.stringify(value, (_k, v) => {
    if (typeof v === "object" && v !== null) {
      if (seen.has(v)) return "[Circular]";
      seen.add(v);
    }
    return v;
  });
}

/**
 * Map a tool call result to an ACP-shaped request_permission option kind, so
 * downstream code can talk in `allow_once`/`reject_once` consistently.
 *
 * @param {PermissionDecision} decision
 * @returns {"allow_once"|"reject_once"|null} null when the decision is "ask"
 *          and the caller must await user input first.
 */
export function decisionToAcpOption(decision) {
  if (decision.outcome === "allow") return "allow_once";
  if (decision.outcome === "deny") return "reject_once";
  return null;
}
