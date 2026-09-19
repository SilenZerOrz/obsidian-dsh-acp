// lib/abort-utils.mjs — AbortSignal race primitives shared by permission-gate
// (Phase B) and the HTTP/SSE proxy path (Phase D).
//
// Why this file exists (2026-09-18):
//   The tool-call hang had two layers of "wait forever" races:
//     - lib/permission-gate.mjs::_askUser used Promise.race([requester, setTimeout])
//       to bound the wait to 5 minutes, then auto-denied. Official claude-agent-acp
//       instead races against an AbortSignal and never auto-times-out (release on
//       client cancellation, never on wall-clock).
//     - lib/proxy-mode.mjs::handleServerRequest awaited onRequest() with no
//       outer abort path — when Obsidian Agent Client silently drops a
//       request_permission the round-trip never settles, the outer 10-minute
//       PROMPT_TIMEOUT_MS does abort the fetch but doesn't notify the server's
//       pending Promise, leaving it stranded.
//
//   Both fixes need the same primitive: "Promise that follows operation but
//   rejects when an AbortSignal fires". That's `raceWithAbort`. Plus
//   `abortOnSignal` for the second case (Promise.race against an abort-only
//   promise when the operation's contract doesn't accept a signal).
//
// Reference (raceWithAbort semantics):
//   ~/.npm-global/lib/node_modules/@agentclientprotocol/claude-agent-acp/dist/acp-agent.js:582-601
//   + the comment at 5166-5168 explaining why this primitive is mandatory in
//   any ACP host.

/**
 * Race an async operation against an AbortSignal. The returned Promise follows
 * the operation's outcome; if the signal aborts first, the Promise rejects
 * with an AbortError.
 *
 * `operationOrThunk` may be either a Promise or a zero-arg function returning
 * a Promise. The thunk form is preferred when invoking `operation` has side
 * effects (e.g. an IPC call that should NOT fire when the signal is already
 * aborted) — passing a thunk defers invocation until after the pre-abort
 * check below.
 *
 * If `signal` is undefined / already aborted, the behavior is:
 *   - undefined  → invoke/return operation unchanged (no race)
 *   - aborted    → return a Promise that rejects immediately with AbortError
 *                  WITHOUT invoking the thunk (thunk form) or touching the
 *                  supplied operation.
 *
 * Listeners are removed in both branches (operation settles AND signal aborts),
 * so callers don't leak event handlers.
 *
 * @template T
 * @param {Promise<T>|(() => Promise<T>)} operationOrThunk
 * @param {AbortSignal} [signal]
 * @returns {Promise<T>}
 */
export function raceWithAbort(operationOrThunk, signal) {
  if (!signal) {
    return typeof operationOrThunk === "function" ? operationOrThunk() : operationOrThunk;
  }
  if (signal.aborted) {
    return Promise.reject(makeAbortError(signal.reason));
  }
  const op =
    typeof operationOrThunk === "function" ? operationOrThunk() : operationOrThunk;
  return new Promise((resolve, reject) => {
    let settled = false;
    const onAbort = () => {
      if (settled) return;
      settled = true;
      reject(makeAbortError(signal.reason));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    op.then(
      (v) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        resolve(v);
      },
      (e) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        reject(e);
      },
    );
  });
}

/**
 * Returns a Promise that rejects when the signal aborts. Useful as the
 * loser branch in `Promise.race([operation, abortOnSignal(signal)])` when
 * the operation's contract doesn't accept a signal directly.
 *
 *   - If `signal` is undefined → returns a Promise that never settles. The
 *     caller's race therefore depends on the other branch settling.
 *     Documented behavior; not a bug.
 *   - If `signal` is already aborted → rejects immediately.
 *
 * The "never settles without signal" branch is intentional: callers who need
 * "race against abort OR just wait for operation" pass a real signal. A
 * missing signal means "no abort path", which is exactly what callers want.
 *
 * @param {AbortSignal} [signal]
 * @param {string} [msg] - reason when no signal.reason is provided
 * @returns {Promise<never>}
 */
export function abortOnSignal(signal, msg = "aborted") {
  return new Promise((_resolve, reject) => {
    if (!signal) return; // never settles
    if (signal.aborted) {
      // Always prefer `msg` (the caller's intent) over signal.reason.
      // Node 17+ sets signal.reason to a default DOMException when
      // abort() is called without args — its message ("This operation was
      // aborted") is a platform default and not useful to downstream
      // callers, who want their own msg surfaced in logs / SSE error
      // replies. Only fall back to msg2 when neither msg nor reason is set.
      reject(makeAbortError(msg));
      return;
    }
    signal.addEventListener(
      "abort",
      () => reject(makeAbortError(msg)),
      { once: true },
    );
  });
}

/**
 * Build an Error with `name: "AbortError"` so callers can distinguish
 * cancellation from operational failures with a stable shape.
 *
 * @param {*} reason - abort reason (Error, string, or anything else)
 * @returns {Error}
 */
export function makeAbortError(reason) {
  let msg2;
  if (reason instanceof Error) msg2 = reason.message;
  else if (typeof reason === "string") msg2 = reason;
  else msg2 = "aborted";
  const e = new Error(msg2);
  e.name = "AbortError";
  return e;
}