// test/permission-gate.test.mjs — node:test unit tests for lib/permission-gate.mjs
//
// Covers the 4-mode × {edit-tool, non-edit, cache hit, abort-signal} decision
// matrix for PermissionGate.resolve(), plus the cacheKey stability, root-check
// gating, ensureToolCallEmitted fallback, and the decisionToAcpOption helper.
//
// Phase B changes (2026-09-18): the 5-minute wall-clock timeout is gone.
// PermissionGate races the requester against an AbortSignal (matching official
// claude-agent-acp). Tests that used `Promise.race([never-resolving, setTimeout]`
// were rewritten to exercise the AbortSignal abort path instead.

import test from "node:test";
import assert from "node:assert/strict";
import {
  PermissionGate,
  decisionToAcpOption,
} from "../lib/permission-gate.mjs";

const DEFAULT_CONFIG = {
  mode: "default",
  editTools: ["Edit", "Write", "MultiEdit", "NotebookEdit"],
};

/** Build a fresh fake requester (each test gets its own to avoid state bleed). */
function makeRequester(reply = "allow_once") {
  const r = {
    calls: [],
    async request(toolCallId, title, options) {
      r.calls.push({ toolCallId, title, options });
      return reply;
    },
  };
  return r;
}

// Kept for backwards compat with the few tests that don't care about
// captured state — points at a fresh instance at import time.
const FAKE_REQUESTER = makeRequester();

function req(toolName, args, reason) {
  return { toolName, args, reason };
}

// --- constructor ---------------------------------------------------------

test("PermissionGate: requires config", () => {
  assert.throws(() => new PermissionGate(), /config/);
});

test("PermissionGate: defaults editTools to [] when omitted", () => {
  const g = new PermissionGate({ mode: "default" });
  // Phase B: timeoutMs is gone (replaced by AbortSignal). Confirm the gate
  // doesn't expose it as a field, and editTools defaults to an empty array.
  assert.equal(g.timeoutMs, undefined);
  assert.deepEqual(g.editTools, []);
});

test("PermissionGate: legacy timeoutMs config is ignored (no-op)", () => {
  // Backward compat: old callers may still pass `timeoutMs`. The constructor
  // accepts the object without throwing and the field is silently dropped —
  // matches official behavior (no wall-clock auto-deny).
  const g = new PermissionGate({ mode: "default", timeoutMs: 300000 });
  assert.equal(g.timeoutMs, undefined);
});

// --- bypassPermissions ----------------------------------------------------

test("bypassPermissions: allows every tool without calling acpRequester", async () => {
  const g = new PermissionGate({ mode: "bypassPermissions", editTools: [] });
  const r = await g.resolve(req("bash", { cmd: "rm -rf /" }), "tc1", FAKE_REQUESTER);
  assert.equal(r.outcome, "allow");
  assert.equal(r.reason, "bypassPermissions");
  assert.equal(FAKE_REQUESTER.calls.length, 0, "must not invoke user");
});

test("bypassPermissions: caches the decision so second call is a hit", async () => {
  const g = new PermissionGate({ mode: "bypassPermissions", editTools: [] });
  await g.resolve(req("Edit", { file: "a.md" }), "t1", FAKE_REQUESTER);
  const second = await g.resolve(req("Edit", { file: "a.md" }), "t2", FAKE_REQUESTER);
  assert.equal(second.outcome, "allow");
  assert.equal(second.cachedAs.length, 16);
});

// --- dontAsk --------------------------------------------------------------

test("dontAsk: allows without calling acpRequester", async () => {
  const g = new PermissionGate({ mode: "dontAsk", editTools: [] });
  const r = await g.resolve(req("bash", { cmd: "ls" }), "tc1", FAKE_REQUESTER);
  assert.equal(r.outcome, "allow");
  assert.equal(FAKE_REQUESTER.calls.length, 0);
});

// --- acceptEdits ----------------------------------------------------------

test("acceptEdits: edit-class tool auto-allows without asking", async () => {
  const g = new PermissionGate(DEFAULT_CONFIG);
  g.mode = "acceptEdits";
  const r = await g.resolve(req("Edit", { file: "a.md" }), "t1", FAKE_REQUESTER);
  assert.equal(r.outcome, "allow");
  assert.equal(r.reason, "acceptEdits:edit-tool");
  assert.equal(FAKE_REQUESTER.calls.length, 0);
});

test("acceptEdits: non-edit tool (bash) asks user via acpRequester", async () => {
  const g = new PermissionGate({ mode: "acceptEdits", editTools: ["Edit"] });
  const r = await g.resolve(req("bash", { cmd: "ls" }), "t1", FAKE_REQUESTER);
  assert.equal(r.outcome, "allow");
  assert.equal(FAKE_REQUESTER.calls.length, 1);
  assert.equal(FAKE_REQUESTER.calls[0].toolCallId, "t1");
});

test("acceptEdits: edit tool with different args gets distinct cache keys", async () => {
  const g = new PermissionGate({ mode: "acceptEdits", editTools: ["Edit"] });
  const a = await g.resolve(req("Edit", { file: "a.md" }), "t1", FAKE_REQUESTER);
  const b = await g.resolve(req("Edit", { file: "b.md" }), "t2", FAKE_REQUESTER);
  // Both auto-allow (edit-class), but they must NOT collide on cache key.
  assert.equal(a.cachedAs, undefined); // first call didn't hit cache (terminal)
  // Second call hits cache → has cachedAs
  const secondA = await g.resolve(req("Edit", { file: "a.md" }), "t3", FAKE_REQUESTER);
  assert.equal(secondA.cachedAs.length, 16);
  // b.md never resolves as a cache hit because the first call to file=a
  // produced a different key.
  assert.notEqual(a.cachedAs, secondA.cachedAs);
});

// --- default --------------------------------------------------------------

test("default: any tool triggers acpRequester", async () => {
  const requester = makeRequester();
  const g = new PermissionGate({ mode: "default", editTools: [] });
  const r = await g.resolve(req("Read", { path: "/etc/hosts" }), "tc1", requester);
  assert.equal(r.outcome, "allow");
  assert.equal(requester.calls.length, 1);
});

test("default: user reject maps to deny outcome", async () => {
  const requester = makeRequester("reject_once");
  const g = new PermissionGate({ mode: "default", editTools: [] });
  const r = await g.resolve(req("bash", {}), "tc1", requester);
  assert.equal(r.outcome, "deny");
});

test("default: title passed to acpRequester includes reason when provided", async () => {
  const requester = makeRequester();
  const g = new PermissionGate({ mode: "default", editTools: [] });
  await g.resolve(req("Edit", { file: "x" }, "Update changelog header"), "tc1", requester);
  assert.equal(requester.calls[0].title, "Update changelog header");
});

test("default: title falls back to 'Run <toolName>?' when no reason", async () => {
  const requester = makeRequester();
  const g = new PermissionGate({ mode: "default", editTools: [] });
  await g.resolve(req("bash", {}), "tc1", requester);
  assert.equal(requester.calls[0].title, "Run bash?");
});

// --- abort signal ---------------------------------------------------------

test("default: abort signal rejects gate.resolve with AbortError", async () => {
  const slowRequester = {
    calls: [],
    request() {
      // never resolves — simulates a client that never replies
      return new Promise(() => {});
    },
  };
  const g = new PermissionGate({ mode: "default", editTools: [] });
  const ctl = new AbortController();
  setTimeout(() => ctl.abort(), 50);
  await assert.rejects(
    g.resolve(req("Edit", { file: "a.md" }), "tc1", slowRequester, ctl.signal),
    (err) => err && err.name === "AbortError",
  );
});

test("default: pre-aborted signal rejects immediately without invoking requester", async () => {
  let invocations = 0;
  const slowRequester = { request() { invocations++; return new Promise(() => {}); } };
  const g = new PermissionGate({ mode: "default", editTools: [] });
  const ctl = new AbortController();
  ctl.abort();
  await assert.rejects(
    g.resolve(req("Edit", { file: "a.md" }), "tc1", slowRequester, ctl.signal),
    (err) => err && err.name === "AbortError",
  );
  assert.equal(invocations, 0, "pre-aborted signal must not even call the requester");
});

test("abort: AbortError is NOT cached so a fresh resolve re-prompts", async () => {
  // After a cancel, the next turn should be able to ask again — caching deny
  // would make the user never see the prompt for the same tool/args again.
  let invocations = 0;
  const slowRequester = {
    request() {
      invocations++;
      return new Promise(() => {}); // never — relies on abort
    },
  };
  const g = new PermissionGate({ mode: "default", editTools: [] });

  // First turn: abort before the requester can answer
  const ctl1 = new AbortController();
  setTimeout(() => ctl1.abort(), 30);
  await assert.rejects(
    g.resolve(req("Edit", { file: "x" }), "tc1", slowRequester, ctl1.signal),
    (err) => err && err.name === "AbortError",
  );

  // Second turn (same tool/args): should call the requester again because
  // the first resolve aborted without caching.
  const ctl2 = new AbortController();
  const second = g.resolve(req("Edit", { file: "x" }), "tc2", slowRequester, ctl2.signal);
  // give it a tick to invoke requester
  await new Promise((r) => setImmediate(r));
  assert.ok(invocations >= 2, `requester should be invoked twice, got ${invocations}`);
  ctl2.abort();
  await assert.rejects(second, (err) => err && err.name === "AbortError");
});

test("default: no signal passes through normally (legacy callers)", async () => {
  const requester = makeRequester();
  const g = new PermissionGate({ mode: "default", editTools: [] });
  const r = await g.resolve(req("Read", {}), "tc1", requester /* no signal */);
  assert.equal(r.outcome, "allow");
});

// --- cache ----------------------------------------------------------------

test("cache: same toolName + same args returns cached decision", async () => {
  const requester = { calls: [], async request() { this.calls.push(1); return "allow_once"; } };
  const g = new PermissionGate({ mode: "default", editTools: [] });
  await g.resolve(req("Read", { path: "/a" }), "t1", requester);
  await g.resolve(req("Read", { path: "/a" }), "t2", requester);
  assert.equal(requester.calls.length, 1, "second call must hit cache");
});

test("cache: different args produce different keys", async () => {
  let invocations = 0;
  const requester = { async request() { invocations++; return "allow_once"; } };
  const g = new PermissionGate({ mode: "default", editTools: [] });
  await g.resolve(req("Read", { path: "/a" }), "t1", requester);
  await g.resolve(req("Read", { path: "/b" }), "t2", requester);
  assert.equal(invocations, 2);
});

test("cache: undefined args and empty args produce different keys", async () => {
  let invocations = 0;
  const requester = { async request() { invocations++; return "allow_once"; } };
  const g = new PermissionGate({ mode: "default", editTools: [] });
  await g.resolve(req("ListTools", undefined), "t1", requester);
  await g.resolve(req("ListTools", {}), "t2", requester);
  assert.equal(invocations, 2, "undefined vs {} must not collide");
});

test("cache: clearCache() forces re-evaluation", async () => {
  let invocations = 0;
  const requester = { async request() { invocations++; return "allow_once"; } };
  const g = new PermissionGate({ mode: "default", editTools: [] });
  await g.resolve(req("Read", { path: "/a" }), "t1", requester);
  g.clearCache();
  await g.resolve(req("Read", { path: "/a" }), "t2", requester);
  assert.equal(invocations, 2);
});

test("cache: cacheSize reports live size", async () => {
  const g = new PermissionGate({ mode: "bypassPermissions", editTools: [] });
  assert.equal(g.cacheSize, 0);
  await g.resolve(req("Edit", { file: "a" }), "t1", FAKE_REQUESTER);
  await g.resolve(req("Edit", { file: "b" }), "t2", FAKE_REQUESTER);
  assert.equal(g.cacheSize, 2);
});

// --- ask without acpRequester -------------------------------------------

test("ask: returns 'ask' outcome when no acpRequester provided", async () => {
  const g = new PermissionGate({ mode: "default", editTools: [] });
  const r = await g.resolve(req("bash", { cmd: "rm -rf /" }), "tc1");
  assert.equal(r.outcome, "ask");
  assert.equal(r.reason, "default:ask");
});

// --- allow_always / reject_once choices ---------------------------------

test("acpRequester: allow_always maps to allow", async () => {
  const requester = { async request() { return "allow_always"; } };
  const g = new PermissionGate({ mode: "default", editTools: [] });
  const r = await g.resolve(req("Read", {}), "t1", requester);
  assert.equal(r.outcome, "allow");
});

test("acpRequester: unknown response → deny (safer default)", async () => {
  const requester = { async request() { return "something_else"; } };
  const g = new PermissionGate({ mode: "default", editTools: [] });
  const r = await g.resolve(req("Read", {}), "t1", requester);
  assert.equal(r.outcome, "deny");
});

// --- bypassPermissions root gate -----------------------------------------

test("bypassPermissions: refused when running as root, no opt-in → consults user", async () => {
  // Mock process.geteuid to look like root. Use defineProperty because
  // process.geteuid is a getter on some Node versions and direct assignment
  // is a no-op.
  const originalDesc = Object.getOwnPropertyDescriptor(process, "geteuid");
  Object.defineProperty(process, "geteuid", {
    value: () => 0,
    configurable: true,
    writable: true,
  });
  try {
    const requester = makeRequester();
    const g = new PermissionGate({ mode: "bypassPermissions", editTools: [] });
    const r = await g.resolve(req("bash", { cmd: "rm -rf /" }), "tc1", requester);
    // Falls back to default-mode "ask". When a requester IS wired, the user
    // gets consulted (this test's stub returns "allow_once") and the outcome
    // follows the user's reply — but the key invariant is that the user WAS
    // consulted (not silently auto-allowed).
    assert.equal(requester.calls.length, 1, "must consult the user when bypass is refused");
    assert.equal(r.outcome, "allow");
    assert.match(r.reason, /user:allow_once/);
  } finally {
    if (originalDesc) {
      Object.defineProperty(process, "geteuid", originalDesc);
    } else {
      delete process.geteuid;
    }
  }
});

test("bypassPermissions: refused when running as root, no requester → outcome stays 'ask'", async () => {
  const originalDesc = Object.getOwnPropertyDescriptor(process, "geteuid");
  Object.defineProperty(process, "geteuid", {
    value: () => 0,
    configurable: true,
    writable: true,
  });
  try {
    const g = new PermissionGate({ mode: "bypassPermissions", editTools: [] });
    const r = await g.resolve(req("bash", { cmd: "rm -rf /" }), "tc1");
    assert.equal(r.outcome, "ask");
    assert.match(r.reason, /refused-as-root/);
  } finally {
    if (originalDesc) {
      Object.defineProperty(process, "geteuid", originalDesc);
    } else {
      delete process.geteuid;
    }
  }
});

test("bypassPermissions: honored when running as root AND enableRootBypass", async () => {
  const originalDesc = Object.getOwnPropertyDescriptor(process, "geteuid");
  Object.defineProperty(process, "geteuid", {
    value: () => 0,
    configurable: true,
    writable: true,
  });
  try {
    const requester = makeRequester();
    const g = new PermissionGate({
      mode: "bypassPermissions",
      editTools: [],
      enableRootBypass: true,
    });
    const r = await g.resolve(req("bash", { cmd: "rm -rf /" }), "tc1", requester);
    assert.equal(r.outcome, "allow");
    assert.equal(requester.calls.length, 0, "opt-in root bypass must skip the requester");
  } finally {
    if (originalDesc) {
      Object.defineProperty(process, "geteuid", originalDesc);
    } else {
      delete process.geteuid;
    }
  }
});

test("bypassPermissions: honored normally when not running as root", async () => {
  // Default test env: never root.
  const requester = makeRequester();
  const g = new PermissionGate({ mode: "bypassPermissions", editTools: [] });
  const r = await g.resolve(req("bash", { cmd: "ls" }), "tc1", requester);
  assert.equal(r.outcome, "allow");
  assert.equal(requester.calls.length, 0);
});

// --- ensureToolCallEmitted fallback -------------------------------------

test("default: emits tool_call_update pending via acpRequester.notify before asking", async () => {
  const notifications = [];
  const requester = {
    notifications,
    async notify(method, params) { notifications.push({ method, params }); },
    async request() { return "allow_once"; },
  };
  const g = new PermissionGate({ mode: "default", editTools: [] });
  await g.resolve(req("bash", { cmd: "ls" }), "tc1", requester);
  // First emit = pending tool_call, second = the ask itself doesn't notify
  assert.equal(notifications.length, 1, "one notify expected");
  assert.equal(notifications[0].method, "session/update");
  assert.equal(notifications[0].params.update.sessionUpdate, "tool_call_update");
  assert.equal(notifications[0].params.update.toolCallId, "tc1");
  assert.equal(notifications[0].params.update.status, "pending");
});

test("default: skips ensureToolCallEmitted when acpRequester has no notify", async () => {
  // Legacy caller without notify() — must not crash, just skip the emit.
  const requester = { async request() { return "allow_once"; } };
  const g = new PermissionGate({ mode: "default", editTools: [] });
  const r = await g.resolve(req("bash", { cmd: "ls" }), "tc1", requester);
  assert.equal(r.outcome, "allow");
});

test("default: ensureToolCallEmitted failure does not block the ask", async () => {
  const requester = {
    async notify() { throw new Error("notify broken"); },
    async request() { return "allow_once"; },
  };
  const g = new PermissionGate({ mode: "default", editTools: [] });
  const r = await g.resolve(req("bash", {}), "tc1", requester);
  assert.equal(r.outcome, "allow");
});

// --- decisionToAcpOption helper -----------------------------------------

test("decisionToAcpOption: allow → allow_once", () => {
  assert.equal(decisionToAcpOption({ outcome: "allow" }), "allow_once");
});

test("decisionToAcpOption: deny → reject_once", () => {
  assert.equal(decisionToAcpOption({ outcome: "deny" }), "reject_once");
});

test("decisionToAcpOption: ask → null (caller must await)", () => {
  assert.equal(decisionToAcpOption({ outcome: "ask" }), null);
});

// --- M2.4: setMode runtime mutation (2026-09-18) ------------------------

test("setMode: changes active mode without rebuilding the gate", () => {
  const g = new PermissionGate({ mode: "default", editTools: [] });
  assert.equal(g.mode, "default");
  g.setMode("bypassPermissions");
  assert.equal(g.mode, "bypassPermissions");
  g.setMode("acceptEdits");
  assert.equal(g.mode, "acceptEdits");
});

test("setMode: rejects unknown mode id with TypeError", () => {
  const g = new PermissionGate({ mode: "default", editTools: [] });
  assert.throws(() => g.setMode("ultra"), TypeError);
  assert.throws(() => g.setMode(""), TypeError);
  assert.throws(() => g.setMode(null), TypeError);
  // mode unchanged on rejection
  assert.equal(g.mode, "default");
});

test("setMode: clears cache when mode changes (decisions depend on mode)", () => {
  const g = new PermissionGate({ mode: "bypassPermissions", editTools: [] });
  // populate cache via a real resolve (bypassPermissions auto-allows)
  const req = { toolName: "bash", args: { cmd: "ls" } };
  return g.resolve(req, "tc-cache", null).then(() => {
    assert.ok(g.cacheSize >= 1, "cache populated under bypassPermissions");
    // Switching to a stricter mode must drop the cached "allow"
    g.setMode("default");
    assert.equal(g.cacheSize, 0, "cache cleared on mode change");
  });
});

test("setMode: no-op when mode unchanged does not clear cache", () => {
  const g = new PermissionGate({ mode: "default", editTools: [] });
  return g.resolve({ toolName: "Read" }, "tc-noop", null).then(() => {
    const sizeBefore = g.cacheSize;
    g.setMode("default");
    assert.equal(g.cacheSize, sizeBefore, "same-mode setMode preserves cache");
  });
});
