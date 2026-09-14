// test/permission-gate.test.mjs — node:test unit tests for lib/permission-gate.mjs
//
// Covers the 4-mode × {edit-tool, non-edit, cache hit, timeout} decision matrix
// for PermissionGate.resolve(), plus the cacheKey stability and the
// decisionToAcpOption helper.

import test from "node:test";
import assert from "node:assert/strict";
import {
  PermissionGate,
  decisionToAcpOption,
} from "../lib/permission-gate.mjs";

const DEFAULT_CONFIG = {
  mode: "default",
  timeoutMs: 300000,
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

test("PermissionGate: defaults timeoutMs and editTools when omitted", () => {
  const g = new PermissionGate({ mode: "default" });
  assert.equal(g.timeoutMs, 300000);
  assert.deepEqual(g.editTools, []);
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
  const g = new PermissionGate({ mode: "acceptEdits", editTools: ["Edit"], timeoutMs: 1000 });
  const r = await g.resolve(req("bash", { cmd: "ls" }), "t1", FAKE_REQUESTER);
  assert.equal(r.outcome, "allow");
  assert.equal(FAKE_REQUESTER.calls.length, 1);
  assert.equal(FAKE_REQUESTER.calls[0].toolCallId, "t1");
});

test("acceptEdits: edit tool with different args gets distinct cache keys", async () => {
  const g = new PermissionGate({ mode: "acceptEdits", editTools: ["Edit"], timeoutMs: 1000 });
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
  const g = new PermissionGate({ mode: "default", editTools: [], timeoutMs: 1000 });
  const r = await g.resolve(req("Read", { path: "/etc/hosts" }), "tc1", requester);
  assert.equal(r.outcome, "allow");
  assert.equal(requester.calls.length, 1);
});

test("default: user reject maps to deny outcome", async () => {
  const requester = makeRequester("reject_once");
  const g = new PermissionGate({ mode: "default", editTools: [], timeoutMs: 1000 });
  const r = await g.resolve(req("bash", {}), "tc1", requester);
  assert.equal(r.outcome, "deny");
});

test("default: title passed to acpRequester includes reason when provided", async () => {
  const requester = makeRequester();
  const g = new PermissionGate({ mode: "default", editTools: [], timeoutMs: 1000 });
  await g.resolve(req("Edit", { file: "x" }, "Update changelog header"), "tc1", requester);
  assert.equal(requester.calls[0].title, "Update changelog header");
});

test("default: title falls back to 'Run <toolName>?' when no reason", async () => {
  const requester = makeRequester();
  const g = new PermissionGate({ mode: "default", editTools: [], timeoutMs: 1000 });
  await g.resolve(req("bash", {}), "tc1", requester);
  assert.equal(requester.calls[0].title, "Run bash?");
});

// --- timeout --------------------------------------------------------------

test("default: timeout without acpRequester response → deny", async () => {
  const slowRequester = {
    calls: [],
    request() {
      // never resolves
      return new Promise(() => {});
    },
  };
  const g = new PermissionGate({ mode: "default", editTools: [], timeoutMs: 50 });
  const start = Date.now();
  const r = await g.resolve(req("Edit", { file: "a.md" }), "tc1", slowRequester);
  const elapsed = Date.now() - start;
  assert.equal(r.outcome, "deny");
  assert.match(r.reason, /timeout/);
  assert.ok(elapsed < 1000, `should resolve within timeout, took ${elapsed}ms`);
});

test("timeout: decision is cached as deny so retry doesn't pop again", async () => {
  let invocations = 0;
  const slowRequester = {
    request() { invocations++; return new Promise(() => {}); },
  };
  const g = new PermissionGate({ mode: "default", editTools: [], timeoutMs: 30 });
  const first = await g.resolve(req("Edit", { file: "x" }), "tc1", slowRequester);
  const second = await g.resolve(req("Edit", { file: "x" }), "tc2", slowRequester);
  assert.equal(first.outcome, "deny");
  assert.equal(second.outcome, "deny");
  assert.equal(second.cachedAs.length, 16);
  assert.equal(invocations, 1, "cache hit must skip second requester call");
});

// --- cache ----------------------------------------------------------------

test("cache: same toolName + same args returns cached decision", async () => {
  const requester = { calls: [], async request() { this.calls.push(1); return "allow_once"; } };
  const g = new PermissionGate({ mode: "default", editTools: [], timeoutMs: 1000 });
  await g.resolve(req("Read", { path: "/a" }), "t1", requester);
  await g.resolve(req("Read", { path: "/a" }), "t2", requester);
  assert.equal(requester.calls.length, 1, "second call must hit cache");
});

test("cache: different args produce different keys", async () => {
  let invocations = 0;
  const requester = { async request() { invocations++; return "allow_once"; } };
  const g = new PermissionGate({ mode: "default", editTools: [], timeoutMs: 1000 });
  await g.resolve(req("Read", { path: "/a" }), "t1", requester);
  await g.resolve(req("Read", { path: "/b" }), "t2", requester);
  assert.equal(invocations, 2);
});

test("cache: undefined args and empty args produce different keys", async () => {
  let invocations = 0;
  const requester = { async request() { invocations++; return "allow_once"; } };
  const g = new PermissionGate({ mode: "default", editTools: [], timeoutMs: 1000 });
  await g.resolve(req("ListTools", undefined), "t1", requester);
  await g.resolve(req("ListTools", {}), "t2", requester);
  assert.equal(invocations, 2, "undefined vs {} must not collide");
});

test("cache: clearCache() forces re-evaluation", async () => {
  let invocations = 0;
  const requester = { async request() { invocations++; return "allow_once"; } };
  const g = new PermissionGate({ mode: "default", editTools: [], timeoutMs: 1000 });
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
  const g = new PermissionGate({ mode: "default", editTools: [], timeoutMs: 1000 });
  const r = await g.resolve(req("bash", { cmd: "rm -rf /" }), "tc1");
  assert.equal(r.outcome, "ask");
  assert.equal(r.reason, "default:ask");
});

// --- allow_always / reject_once choices ---------------------------------

test("acpRequester: allow_always maps to allow", async () => {
  const requester = { async request() { return "allow_always"; } };
  const g = new PermissionGate({ mode: "default", editTools: [], timeoutMs: 1000 });
  const r = await g.resolve(req("Read", {}), "t1", requester);
  assert.equal(r.outcome, "allow");
});

test("acpRequester: unknown response → deny (safer default)", async () => {
  const requester = { async request() { return "something_else"; } };
  const g = new PermissionGate({ mode: "default", editTools: [], timeoutMs: 1000 });
  const r = await g.resolve(req("Read", {}), "t1", requester);
  assert.equal(r.outcome, "deny");
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
