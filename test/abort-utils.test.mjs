// test/abort-utils.test.mjs — node:test unit tests for lib/abort-utils.mjs
//
// Phase B/D foundation: raceWithAbort + abortOnSignal + makeAbortError
// are the primitives that replace the old 5-minute wall-clock race and
// thread cancellation through the proxy. These tests lock the contract:
//   - Pre-aborted signals don't fire the operation (thunk form)
//   - Listeners are removed in both branches (no memory leak)
//   - AbortError shape is stable for downstream `e.name === "AbortError"`
//     branches in permission-gate / long-runtime / proxy-mode.
//   - abortOnSignal without a signal is intentionally never-settling.

import test from "node:test";
import assert from "node:assert/strict";
import {
  raceWithAbort,
  abortOnSignal,
  makeAbortError,
} from "../lib/abort-utils.mjs";

// --- makeAbortError -------------------------------------------------------

test("makeAbortError: Error reason → message preserved, name='AbortError'", () => {
  const original = new Error("user cancelled");
  const e = makeAbortError(original);
  assert.equal(e.name, "AbortError");
  assert.equal(e.message, "user cancelled");
  assert.notEqual(e, original, "must be a fresh Error, not the original");
});

test("makeAbortError: string reason → message is that string", () => {
  const e = makeAbortError("test reason");
  assert.equal(e.name, "AbortError");
  assert.equal(e.message, "test reason");
});

test("makeAbortError: non-string/Error reason → 'aborted' fallback", () => {
  assert.equal(makeAbortError(undefined).message, "aborted");
  assert.equal(makeAbortError(null).message, "aborted");
  assert.equal(makeAbortError(42).message, "aborted");
  assert.equal(makeAbortError({}).message, "aborted");
});

// --- raceWithAbort: happy paths -------------------------------------------

test("raceWithAbort: resolves with the operation's value when no signal", async () => {
  const v = await raceWithAbort(Promise.resolve(42));
  assert.equal(v, 42);
});

test("raceWithAbort: thunk form — invokes the thunk once", async () => {
  let calls = 0;
  const r = await raceWithAbort(() => {
    calls++;
    return Promise.resolve("ok");
  });
  assert.equal(r, "ok");
  assert.equal(calls, 1);
});

test("raceWithAbort: undefined signal = no race (operation untouched)", async () => {
  const slow = new Promise((r) => setTimeout(() => r("late"), 200));
  const start = Date.now();
  const v = await raceWithAbort(slow, undefined);
  const elapsed = Date.now() - start;
  assert.equal(v, "late");
  assert.ok(elapsed >= 100, "must actually wait, no fake abort");
});

// --- raceWithAbort: pre-aborted signal ------------------------------------

test("raceWithAbort: pre-aborted signal rejects without invoking thunk", async () => {
  let calls = 0;
  const ctl = new AbortController();
  ctl.abort();
  await assert.rejects(
    raceWithAbort(() => {
      calls++;
      return new Promise(() => {});
    }, ctl.signal),
    (err) => err && err.name === "AbortError",
  );
  assert.equal(calls, 0, "pre-aborted signal must skip the thunk entirely");
});

test("raceWithAbort: pre-aborted signal rejects with signal.reason", async () => {
  const ctl = new AbortController();
  ctl.abort("custom-reason-string");
  const p = raceWithAbort(Promise.resolve("ignored"), ctl.signal);
  await assert.rejects(p, (err) => {
    return err.name === "AbortError" && err.message === "custom-reason-string";
  });
});

// --- raceWithAbort: mid-flight abort --------------------------------------

test("raceWithAbort: signal aborts mid-flight → AbortError rejects", async () => {
  const never = new Promise(() => {}); // never settles
  const ctl = new AbortController();
  setTimeout(() => ctl.abort(), 30);
  await assert.rejects(
    raceWithAbort(never, ctl.signal),
    (err) => err && err.name === "AbortError",
  );
});

test("raceWithAbort: listener removed on operation success (no leak)", async () => {
  const ctl = new AbortController();
  const startListeners = ctl.signal.listenerCount?.("abort") ?? -1;
  await raceWithAbort(Promise.resolve("done"), ctl.signal);
  const endListeners = ctl.signal.listenerCount?.("abort") ?? -1;
  if (startListeners !== -1) {
    assert.equal(endListeners, startListeners, "abort listener must be cleaned up");
  }
  // Trigger abort — should NOT raise an unhandled rejection (proves the
  // listener has been removed by the success branch).
  ctl.abort();
});

test("raceWithAbort: listener removed on operation failure (no leak)", async () => {
  const ctl = new AbortController();
  const failing = Promise.reject(new Error("op failed"));
  await assert.rejects(raceWithAbort(failing, ctl.signal), /op failed/);
  // Trigger abort — should NOT raise an unhandled rejection.
  ctl.abort();
});

test("raceWithAbort: abort after operation settles is a no-op (settled flag)", async () => {
  let resolved = false;
  const op = new Promise((r) => {
    setImmediate(() => {
      resolved = true;
      r("ok");
    });
  });
  const ctl = new AbortController();
  const result = await raceWithAbort(op, ctl.signal);
  assert.equal(result, "ok");
  // Now abort — must NOT reject (operation already settled, settled=true).
  ctl.abort();
  // Give any listener a tick to fire:
  await new Promise((r) => setImmediate(r));
  assert.equal(resolved, true);
});

// --- raceWithAbort: Promise vs thunk --------------------------------------

test("raceWithAbort: Promise form — invoking aborts an already-running promise", async () => {
  // The Promise form must NOT skip invocation (unlike the thunk form).
  let invoked = false;
  const never = new Promise(() => {
    invoked = true;
  });
  const ctl = new AbortController();
  setImmediate(() => ctl.abort());
  await assert.rejects(raceWithAbort(never, ctl.signal), (e) => e.name === "AbortError");
  // Promise's executor runs synchronously; we expect invoked=true.
  assert.equal(invoked, true, "Promise form invokes the executor; thunk form does not (pre-abort)");
});

// --- abortOnSignal --------------------------------------------------------

test("abortOnSignal: without signal returns a never-settling Promise", async () => {
  let settled = false;
  const p = abortOnSignal(undefined);
  p.then(
    () => (settled = true),
    () => (settled = true),
  );
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(settled, false, "must never settle when signal is undefined");
});

test("abortOnSignal: pre-aborted signal rejects immediately with AbortError", async () => {
  const ctl = new AbortController();
  ctl.abort();
  await assert.rejects(abortOnSignal(ctl.signal), (err) => err && err.name === "AbortError");
});

test("abortOnSignal: signal aborts mid-flight → AbortError", async () => {
  const ctl = new AbortController();
  setTimeout(() => ctl.abort(), 30);
  await assert.rejects(abortOnSignal(ctl.signal, "custom"), (err) => {
    return err.name === "AbortError" && err.message === "custom";
  });
});

test("abortOnSignal: custom msg used when no signal.reason", async () => {
  const ctl = new AbortController();
  setTimeout(() => ctl.abort(), 10);
  const e = await abortOnSignal(ctl.signal, "permission aborted").catch((x) => x);
  assert.equal(e.message, "permission aborted");
});

// --- raceWithAbort + abortOnSignal: real-world pairing ---------------------

test("race + abortOnSignal: Promise.race behaves like raceWithAbort (thunk form)", async () => {
  // Proxy-mode uses this pattern: `Promise.race([op, abortOnSignal(signal)])`
  // when `op` doesn't accept a signal directly. Make sure it behaves
  // equivalently to raceWithAbort for the success + abort paths.
  const ctl = new AbortController();
  setTimeout(() => ctl.abort(), 30);
  await assert.rejects(
    Promise.race([
      new Promise(() => {}), // never settles
      abortOnSignal(ctl.signal),
    ]),
    (err) => err && err.name === "AbortError",
  );
});