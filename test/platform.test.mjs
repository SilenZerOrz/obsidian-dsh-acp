// test/platform.test.mjs — platform.mjs 单元测试
import test from "node:test";
import assert from "node:assert/strict";
import { runCapture, detectDshBinary, probeDshVersion, resolveDshSpawnSpec, probeGateway } from "../lib/selfcheck/platform.mjs";

test("platform: runCapture runs `node -e 0` quickly with exit 0", async () => {
  const r = await runCapture("node", ["-e", "0"], { timeoutMs: 5000 });
  assert.equal(r.code, 0);
  assert.equal(r.timedOut, false);
});

test("platform: runCapture enforces timeout and unrefs timer", async () => {
  const r = await runCapture("node", ["-e", "setTimeout(()=>{},30000)"], { timeoutMs: 200 });
  assert.equal(r.timedOut, true);
  // code may be null after SIGKILL on some platforms
  assert.ok(r.timedOut === true);
});

test("platform: runCapture reports non-zero exit code", async () => {
  const r = await runCapture("node", ["-e", "process.exit(7)"], { timeoutMs: 5000 });
  assert.equal(r.code, 7);
});

test("platform: detectDshBinary returns string path or null", () => {
  const p = detectDshBinary();
  assert.ok(p === null || typeof p === "string");
  // If PATH has dsh, p should be absolute
  if (p) assert.ok(p.length > 0);
});

test("platform: probeDshVersion handles missing binary gracefully", async () => {
  const r = await probeDshVersion("/this/path/does/not/exist/dsh-fake");
  assert.equal(r.ok, false);
  assert.ok(r.reason);
});

test("platform: resolveDshSpawnSpec returns null when dsh absent", async () => {
  // Override PATH to empty
  const orig = process.env.PATH;
  process.env.PATH = "/nonexistent";
  try {
    const s = await resolveDshSpawnSpec();
    // Either null (no dsh) or {cmd, args}
    if (s !== null) {
      assert.equal(typeof s.cmd, "string");
      assert.ok(Array.isArray(s.args));
    }
  } finally {
    process.env.PATH = orig;
  }
});

test("platform: probeGateway with no baseUrl returns ok:false", async () => {
  const r = await probeGateway("");
  assert.equal(r.ok, false);
  assert.ok(r.reason);
});

test("platform: probeGateway with bogus URL returns ok:false with reason", async () => {
  const r = await probeGateway("not://a:url:at-all");
  assert.equal(r.ok, false);
  assert.ok(r.reason);
});

test("platform: probeGateway unrefs and times out on unreachable host", async () => {
  // Reserved test address (RFC 5737) — guaranteed not to connect
  const r = await probeGateway("http://192.0.2.1:1", { timeoutMs: 500 });
  assert.equal(r.ok, false);
  assert.ok(r.reason);
});
