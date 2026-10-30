// test/acp-stdout-purity.test.mjs — 0.3.8 regression gate for ACP stdout purity.
//
// Background (2026-10-30, dsh 0.2.1-rc.5 升级实走):
//
//   The adapter speaks ACP v1 over stdin/stdout using **newline-delimited
//   JSON-RPC** (dsh-acp.mjs: `ndJsonStream(input, output)`). stdout carries
//   protocol frames only — one complete JSON object per line. A single
//   plain-text line desynchronizes the client's NDJSON parser: the client
//   tries `JSON.parse` on it, fails, and the session's framing goes off-rail.
//
//   Two holes let non-protocol text reach stdout:
//
//     1. The `notifyUpdate()` rejection handlers used `console.log`, which
//        writes to **stdout** in Node. When a notification rejected (client
//        disconnected, session gone, transport torn down) they emitted a bare
//        `notify error: ...` line straight onto the protocol channel.
//
//     2. The console→log-file redirect was **conditional on
//        `DSH_ACP_LOG_DIR`**, which README documents as disabled by default.
//        So in the default configuration there was no stdout guard at all and
//        any module loaded in-process could write to stdout freely.
//
//   This is not a hypothetical upstream concern: dsh itself hit the same class
//   of bug and fixed it in 0.2.1-rc.4 ("Fix diagnostics leaking into stdout in
//   ACP mode") with a one-line `console.info(...)` → `console.error(...)`.
//
// These cases pin:
//   1. installAcpStdoutGuard() keeps console.log/info/debug off stdout;
//   2. the guard is idempotent (a second install is a no-op);
//   3. the guard defers to the log-file redirect when a log file is active;
//   4. diagNotifyError() writes to stderr, never stdout;
//   5. SOURCE GATE: every console.log/info/debug in dsh-acp.mjs lies inside
//      the `--help` block — the ACP server path cannot regress silently.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  installAcpStdoutGuard,
  stdoutGuardState,
  diagNotifyError,
  diagWarn,
  _resetStdoutGuardForTest,
} from "../lib/acp-stdout-guard.mjs";

const ADAPTER_SRC = readFileSync(new URL("../dsh-acp.mjs", import.meta.url), "utf8");

/**
 * Capture everything written to stdout / stderr while `fn` runs.
 * Restores both streams afterwards.
 */
function captureOutput(fn) {
  const stdout = [];
  const stderr = [];
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  const origLog = console.log;
  const origInfo = console.info;
  const origDebug = console.debug;
  process.stdout.write = (chunk, ...rest) => { stdout.push(String(chunk)); return true; };
  process.stderr.write = (chunk, ...rest) => { stderr.push(String(chunk)); return true; };
  try {
    fn();
  } finally {
    process.stdout.write = origOut;
    process.stderr.write = origErr;
    console.log = origLog;
    console.info = origInfo;
    console.debug = origDebug;
  }
  return { stdout: stdout.join(""), stderr: stderr.join("") };
}

// --- 1. the guard keeps console.* off stdout -------------------------------

test("installAcpStdoutGuard: console.log/info/debug never reach stdout", () => {
  _resetStdoutGuardForTest();
  const state = installAcpStdoutGuard({});
  assert.equal(state.installed, true);
  assert.equal(state.redirectedTo, "stderr");

  const { stdout, stderr } = captureOutput(() => {
    console.log("log-line");
    console.info("info-line");
    console.debug("debug-line");
  });

  assert.equal(stdout, "", "console.* must not write to the ACP protocol channel");
  assert.match(stderr, /log-line/);
  assert.match(stderr, /info-line/);
  assert.match(stderr, /debug-line/);
});

test("installAcpStdoutGuard: is idempotent", () => {
  _resetStdoutGuardForTest();
  const first = installAcpStdoutGuard({});
  const second = installAcpStdoutGuard({});
  assert.equal(first, second, "a second install must return the existing state");
  assert.equal(stdoutGuardState(), first);
});

// --- 2. the guard defers to the log-file redirect --------------------------

test("installAcpStdoutGuard: defers when a log file redirect is already active", () => {
  _resetStdoutGuardForTest();
  const state = installAcpStdoutGuard({ logFile: "/tmp/dsh-acp.log" });
  assert.equal(state.installed, true);
  assert.equal(state.redirectedTo, null, "must not override the log-file redirect");
  assert.equal(state.skippedReason, "log-file-redirect-already-installed");
});

// --- 3. diagnostics helpers target stderr ----------------------------------

test("diagNotifyError: writes to stderr, never stdout", () => {
  _resetStdoutGuardForTest();
  const { stdout, stderr } = captureOutput(() => {
    diagNotifyError(new Error("client gone"), "session_update");
  });
  assert.equal(stdout, "");
  assert.match(stderr, /session_update/);
  assert.match(stderr, /client gone/);
});

test("diagWarn: writes to stderr, never stdout", () => {
  const { stdout, stderr } = captureOutput(() => {
    diagWarn("hello");
  });
  assert.equal(stdout, "");
  assert.match(stderr, /hello/);
});

// --- 4. source gate: the ACP server path stays clean -----------------------

test("SOURCE GATE: every console.log/info/debug in dsh-acp.mjs sits in the --help block", () => {
  const helpStart = ADAPTER_SRC.indexOf('process.argv[2] === "--help"');
  const doctorStart = ADAPTER_SRC.indexOf('process.argv[2] === "doctor"');
  assert.ok(helpStart > 0, "could not locate the --help branch marker");
  assert.ok(doctorStart > helpStart, "could not locate the doctor branch marker");

  const re = /console\.(?:log|info|debug)\s*\(/g;
  const offenders = [];
  let m;
  while ((m = re.exec(ADAPTER_SRC)) !== null) {
    if (m.index <= helpStart || m.index >= doctorStart) {
      const line = ADAPTER_SRC.slice(0, m.index).split("\n").length;
      offenders.push(`dsh-acp.mjs:${line}  ${m[0]}`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    "console.log/info/debug outside the --help block would corrupt the ACP NDJSON channel:\n" +
      offenders.join("\n"),
  );
});

test("SOURCE GATE: the ACP-server branch installs the stdout guard", () => {
  assert.match(
    ADAPTER_SRC,
    /installAcpStdoutGuard\(\{ logFile \}\)/,
    "the default (ACP server) branch must install the stdout guard before runAcpDualMode()",
  );
  // Match the *call site* (".catch("), not the function definition.
  const guardAt = ADAPTER_SRC.indexOf("installAcpStdoutGuard({ logFile })");
  const runAt = ADAPTER_SRC.indexOf("runAcpDualMode().catch(");
  assert.ok(guardAt > 0, "could not locate the guard call");
  assert.ok(runAt > 0, "could not locate the ACP server call site");
  assert.ok(runAt > guardAt, "the guard must be installed before the server starts");
});
