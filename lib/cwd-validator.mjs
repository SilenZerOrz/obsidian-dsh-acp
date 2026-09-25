// lib/cwd-validator.mjs — pure cwd validation shared by the protocol layer
// (dsh-acp.mjs session/new|load|fork) and the official bridge router
// (lib/acp-official-router.mjs ensureSession).
//
// Why a shared module:
//   Bug C (2026-09-19, #63) introduced `validateCwdParam` in dsh-acp.mjs to
//   reject stale savedSession cwd paths at the protocol boundary. The official
//   bridge router (Phase 2 first cut) reads `process.cwd()` verbatim, so the
//   same stale-cwd failure mode is reachable via `DSH_ACP_USE_OFFICIAL_BRIDGE=1`
//   — just one bug in two places. Extracting the validator prevents drift and
//   keeps the failure wording identical.
//
// What this module does NOT do:
//   - Throw the ACP SDK `RequestError`. The router path doesn't speak the
//     `@agentclientprotocol/sdk` JSON-RPC envelope, so we throw a plain `Error`
//     with `code = "INVALID_CWD"` instead. dsh-acp.mjs wraps this for protocol
//     surfaces that DO need `RequestError`.
//   - Touch any global state. The validator is a pure function over its inputs
//     plus a filesystem stat.

import { statSync } from "node:fs";
import { isAbsolute } from "node:path";

/**
 * @typedef {object} CwdValidationError
 * @property {"INVALID_CWD"} code
 * @property {string} message
 * @property {string} reason - one of: "missing" | "not_absolute" | "enoent" |
 *           "not_directory" | "not_accessible"
 * @property {string} cwd
 */

/**
 * Validate a cwd path supplied to ACP session/new|load|fork (or any equivalent
 * official-bridge entrypoint).
 *
 * @param {unknown} cwd
 * @param {string} [opName="session"] - human-readable op name for error context
 *   (e.g. "session/new" or "ensureSession"). Defaults to "session" so the
 *   shared module has zero dependency on the protocol layer.
 * @returns {{ ok: true, cwd: string|undefined }} ok=true with cwd=undefined
 *   means "no cwd supplied, fall back to process.cwd()". ok=true with cwd set
 *   means "use this cwd verbatim".
 *
 * Note: returns a tagged union, NOT throwing. The protocol layer translates
 * `{ ok: false }` into a `RequestError`; the official bridge router translates
 * it into a thrown plain `Error` with `.code = "INVALID_CWD"`. See
 * `throwIfInvalid()` below for the throwing wrapper the router uses.
 */
export function validateCwd(cwd, opName = "session") {
  if (cwd === undefined || cwd === null || cwd === "") {
    return { ok: true, cwd: undefined };
  }
  if (typeof cwd !== "string" || !isAbsolute(cwd)) {
    return {
      ok: false,
      error: {
        code: "INVALID_CWD",
        reason: "not_absolute",
        cwd: typeof cwd === "string" ? cwd : JSON.stringify(cwd),
        message: `${opName}: cwd must be an absolute path (got ${
          typeof cwd === "string" ? JSON.stringify(cwd) : String(cwd)
        })`,
      },
    };
  }
  let st;
  try {
    st = statSync(cwd);
  } catch (e) {
    if (e.code === "ENOENT") {
      return {
        ok: false,
        error: {
          code: "INVALID_CWD",
          reason: "enoent",
          cwd,
          message: `${opName}: cwd does not exist: ${cwd}`,
        },
      };
    }
    return {
      ok: false,
      error: {
        code: "INVALID_CWD",
        reason: "not_accessible",
        cwd,
        message: `${opName}: cwd not accessible (${e.code ?? e.message}): ${cwd}`,
      },
    };
  }
  if (!st.isDirectory()) {
    return {
      ok: false,
      error: {
        code: "INVALID_CWD",
        reason: "not_directory",
        cwd,
        message: `${opName}: cwd is not a directory: ${cwd}`,
      },
    };
  }
  return { ok: true, cwd };
}

/**
 * Throwing wrapper for callers that prefer exceptions (e.g. the official bridge
 * router). Preserves the `{ code, reason, cwd }` shape on `.error` so a caller
 * can still discriminate without parsing the message string.
 *
 * @param {unknown} cwd
 * @param {string} [opName]
 * @returns {string|undefined} the validated cwd, or undefined to fall back.
 * @throws {Error} with `.code = "INVALID_CWD"` and `.error = CwdValidationError`
 */
export function throwIfInvalidCwd(cwd, opName) {
  const res = validateCwd(cwd, opName);
  if (res.ok) return res.cwd;
  const err = new Error(res.error.message);
  err.code = res.error.code;
  err.error = res.error;
  err.cwd = res.error.cwd;
  throw err;
}