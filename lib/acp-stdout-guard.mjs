// lib/acp-stdout-guard.mjs — ACP stdout purity guard.
//
// WHY (2026-10-30, dsh 0.2.1-rc.5 升级实走发现):
//
//   The adapter speaks ACP v1 over stdin/stdout using **newline-delimited
//   JSON-RPC** (see dsh-acp.mjs `ndJsonStream(input, output)`). stdout is NOT
//   a log sink — every byte on it must be one complete JSON object per line.
//
//   A single stray line of plain text on stdout desynchronizes the client's
//   NDJSON parser: the client tries `JSON.parse` on it, fails, and the whole
//   session's framing goes off-rail. This is not hypothetical — the upstream
//   dsh project hit exactly this class of bug and fixed it in 0.2.1-rc.4
//   ("Fix diagnostics leaking into stdout in ACP mode"), whose fix was a
//   one-line `console.info(...)` → `console.error(...)` inside
//   `@deepseek-ai/dsh-llm-deepseek-account`.
//
//   Two holes let non-protocol text reach stdout in this adapter:
//
//   1. Our own error handlers used `console.log` (dsh-acp.mjs:1244/1267).
//      `console.log` writes to **stdout** in Node. When `notifyUpdate()`
//      rejects (client disconnected, session gone, transport torn down) those
//      two handlers emitted a bare `notify error: ...` line straight onto the
//      protocol channel.
//
//   2. The existing console redirect (dsh-acp.mjs) is **conditional on
//      `DSH_ACP_LOG_DIR`**, which README documents as disabled by default. So
//      in the default configuration there was no stdout guard at all, and any
//      module loaded in-process — including upstream dsh packages and their
//      transitive dependencies — could write to stdout freely.
//
// WHAT THIS MODULE DOES:
//
//   `installAcpStdoutGuard()` redirects `console.log` / `console.info` /
//   `console.debug` to **stderr** for the lifetime of the ACP server. It is
//   installed only in the ACP-server branch of the CLI dispatch, so the
//   `--help` / `doctor` / `import` / `manage` subcommands keep their normal
//   stdout behaviour.
//
//   `diagWarn()` is the sanctioned way for this project to emit a diagnostic
//   line: it always goes to stderr, never stdout.
//
// INVARIANT (asserted by test/acp-stdout-purity.test.mjs):
//   In ACP-server mode, nothing this project writes reaches stdout except
//   ACP protocol frames.

const GUARD_KEY = Symbol.for("obsidian-dsh-acp.stdout-guard");

/** Render one console-style argument without throwing on exotic values. */
function renderArg(value) {
  try {
    if (typeof value === "string") return value;
    if (value instanceof Error) return value.stack || value.message || String(value);
    return String(value);
  } catch {
    return "[unrenderable]";
  }
}

/**
 * Write a diagnostic line to **stderr**.
 *
 * Never stdout: in ACP-server mode stdout carries NDJSON protocol frames and
 * any plain-text line desynchronizes the client's parser.
 *
 * @param {string} message
 */
export function diagWarn(message) {
  try {
    process.stderr.write(`[dsh-acp] ${renderArg(message)}\n`);
  } catch {
    /* stderr closed — nothing useful left to do */
  }
}

/**
 * Report a rejected ACP notification without touching stdout.
 *
 * @param {unknown} err
 * @param {string} [context] short label identifying the notify site
 */
export function diagNotifyError(err, context) {
  const detail = err instanceof Error ? (err.stack || err.message) : renderArg(err);
  diagWarn(`${context ? `${context}: ` : ""}notify error: ${detail}`);
}

/**
 * Redirect console.log / console.info / console.debug to stderr.
 *
 * Idempotent — a second call is a no-op and returns the existing state.
 * `console.warn` / `console.error` already target stderr in Node and are
 * deliberately left alone.
 *
 * @param {{ logFile?: string | null }} [options]
 *   `logFile` — when set, the caller has already redirected console.* into a
 *   rotating log file; this guard then does nothing (diagnostics belong in
 *   the log, not on stderr).
 * @returns {{ installed: boolean, redirectedTo: string | null, skippedReason: string | null }}
 */
export function installAcpStdoutGuard(options = {}) {
  const existing = globalThis[GUARD_KEY];
  if (existing) return existing;

  const { logFile = null } = options;
  const state = { installed: true, redirectedTo: null, skippedReason: null };

  if (logFile) {
    state.skippedReason = "log-file-redirect-already-installed";
  } else {
    const toStderr = (...args) => {
      try {
        process.stderr.write(`${args.map(renderArg).join(" ")}\n`);
      } catch {
        /* stderr closed */
      }
    };
    console.log = toStderr;
    console.info = toStderr;
    console.debug = toStderr;
    state.redirectedTo = "stderr";
  }

  globalThis[GUARD_KEY] = state;
  return state;
}

/**
 * Current guard state, or `null` when the guard was never installed.
 *
 * @returns {{ installed: boolean, redirectedTo: string | null, skippedReason: string | null } | null}
 */
export function stdoutGuardState() {
  return globalThis[GUARD_KEY] ?? null;
}

/**
 * Reset the guard state. Test-only helper — never call from runtime code.
 */
export function _resetStdoutGuardForTest() {
  delete globalThis[GUARD_KEY];
}
