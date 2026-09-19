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
// Cancellation: callers pass an AbortSignal so a turn cancel / session close
// can release the gate's await. We do NOT auto-time-out — claude-agent-acp
// races against the signal only; the dsh official bridge (`@deepseek-ai/dsh-acp`)
// waits indefinitely. Mirroring that avoids surprising users who took longer
// than 5 minutes to read a permission prompt.

import { createHash } from "node:crypto";
import { raceWithAbort } from "./abort-utils.mjs";

/**
 * @typedef {"default"|"acceptEdits"|"dontAsk"|"bypassPermissions"} PermissionMode
 */

/** Valid PermissionMode values. Mirrors `PERMISSION_MODES` in archive-store.mjs. */
export const PERMISSION_MODES = new Set([
  "default",
  "acceptEdits",
  "dontAsk",
  "bypassPermissions",
]);

/**
 * @typedef {Object} PermissionConfig
 * @property {PermissionMode} mode
 * @property {string[]} [editTools] - tool names that acceptEdits auto-allows
 * @property {boolean} [enableRootBypass] - when true, bypassPermissions is honored
 *           even when process.geteuid() === 0. Defaults to false. Mirrors the
 *           official `IS_SANDBOX` env var pattern (see claude-agent-acp
 *           permissions/modes.js).
 *
 * Legacy field (ignored): timeoutMs. Kept in the typedef so old callers don't
 * crash on unknown keys, but no longer consumed — see migration note in §一
 * of the pitfall doc.
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
 * @property {(method: string, params: object) => Promise<void>} [notify] - optional.
 *           When present, the gate may emit a "tool_call_update pending"
 *           notification before asking, mirroring official claude-agent-acp's
 *           `ensureToolCallEmitted` so Obsidian's UI shows the tool before the
 *           permission dialog.
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
    // timeoutMs is intentionally ignored. See migration note above.
    this.editTools = Array.isArray(config.editTools) ? config.editTools : [];
    this.enableRootBypass = config.enableRootBypass === true;
    /** @type {Map<string, "allow"|"deny">} */
    this._cache = new Map();
  }

  /**
   * Resolve one tool-call permission request against the current mode + cache.
   *
   * If the decision is "ask" and an acpRequester is provided, the gate calls
   * acpRequester.request(...) raced against `signal` (no wall-clock timeout).
   * If no acpRequester is provided, "ask" stays as "ask" (caller must handle).
   *
   * @param {ToolCallRequest} req
   * @param {string} toolCallId - id used for acpRequester and cache key
   * @param {AcpRequester} [acpRequester]
   * @param {AbortSignal} [signal] - cancellation source. Aborting throws an
   *           AbortError from raceWithAbort; the gate propagates without
   *           caching (so a fresh resolve after cancel can re-prompt).
   * @returns {Promise<PermissionDecision>}
   */
  async resolve(req, toolCallId, acpRequester, signal) {
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
    return await this._askUser(req, toolCallId, acpRequester, cacheKey, signal);
  }

  /** Clear the in-memory cache (e.g. between sessions). */
  clearCache() {
    this._cache.clear();
  }

  /**
   * Change the active mode at runtime (M2.4 — 2026-09-18).
   *
   * Mirrors setSessionMode's persistent change on the session record so the
   * in-flight PermissionGate (one instance per LongRuntime) reflects the new
   * mode without needing a session reload. Cache is cleared on mode change
   * because a prior allow/deny may have been decided under different rules
   * (e.g. a cached "allow" under bypassPermissions would silently bypass
   * acceptEdits' "ask for non-edit tools" behavior).
   *
   * @param {PermissionMode} newMode
   */
  setMode(newMode) {
    if (!PERMISSION_MODES.has(newMode)) {
      throw new TypeError(`PermissionGate.setMode: invalid mode ${newMode}`);
    }
    if (this.mode !== newMode) {
      this.mode = newMode;
      this._cache.clear();
    }
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
        // Mirror claude-agent-acp's root check: refuse bypass when running
        // as root unless the caller has explicitly opted in via
        // `enableRootBypass` (the dsh-acp equivalent of IS_SANDBOX).
        if (this._isRoot() && !this.enableRootBypass) {
          process.stderr.write(
            "[dsh-acp] bypassPermissions refused: running as root; " +
              "falling back to default mode. Set permission.enableRootBypass=true " +
              "in dsh-acp config (or IS_SANDBOX=1 in the official reference) " +
              "to override.\n",
          );
          return { outcome: "ask", reason: "bypassPermissions:refused-as-root" };
        }
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

  /**
   * Detect "running as root" portably. process.geteuid is POSIX-only; on
   * Windows there's no uid, so we fall through to false (Windows containers
   * aren't a sandbox model we'd auto-deny anyway).
   *
   * @returns {boolean}
   */
  _isRoot() {
    try {
      const uid =
        typeof process.geteuid === "function"
          ? process.geteuid()
          : typeof process.getuid === "function"
            ? process.getuid()
            : -1;
      return uid === 0;
    } catch {
      return false;
    }
  }

  _isEditTool(toolName) {
    return typeof toolName === "string" && this.editTools.includes(toolName);
  }

  async _askUser(req, toolCallId, acpRequester, cacheKey, signal) {
    const title = req.reason || `Run ${req.toolName}?`;
    const options = [
      { name: "Allow once", kind: "allow_once" },
      { name: "Reject", kind: "reject_once" },
    ];
    // Official parity (Phase B): race the request against the signal — never
    // auto-time-out on wall-clock. The dsh-acp requester already emits the
    // tool_call before asking (lib/long-runtime.mjs pre-step + the per-prompt
    // acpClient wrapper), so Obsidian sees the tool even without an explicit
    // notify here. We feature-detect `notify` on the requester for the
    // narrow cases where the acpRequester is also the only ACP surface (e.g.
    // spawn-mode mocks) and Obsidian UI ordering matters.
    if (typeof acpRequester.notify === "function") {
      try {
        await acpRequester.notify("session/update", {
          sessionId: undefined,
          update: {
            sessionUpdate: "tool_call_update",
            toolCallId,
            title: req.toolName,
            status: "pending",
          },
        });
      } catch {
        /* notify is best-effort; permission flow must continue */
      }
    }
    let choice;
    try {
      // Lazy thunk form so a pre-aborted signal doesn't fire the requester
      // (avoids spurious IPC/permission-popups when a turn is cancelled
      // before the user has been asked).
      choice = await raceWithAbort(
        () => acpRequester.request(toolCallId, title, options),
        signal,
      );
    } catch (err) {
      // Cancellation: do NOT cache — a re-resolve after a fresh signal
      // should re-prompt. (E1 retest confirms retry behavior.)
      if (err && err.name === "AbortError") {
        throw err;
      }
      // Operational error from the requester: fall back to deny + cache so a
      // // transient transport glitch doesn't keep re-prompting.
      this._cache.set(cacheKey, "deny");
      return {
        outcome: "deny",
        reason: `permission requester error: ${err?.message ?? String(err)}`,
      };
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
