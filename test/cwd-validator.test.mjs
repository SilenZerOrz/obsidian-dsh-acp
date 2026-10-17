// test/cwd-validator.test.mjs — Phase 3 #3 (2026-09-25).
//
// Two layers of coverage:
//
//   1. Pure-function tests over `lib/cwd-validator.mjs::validateCwd` /
//      `throwIfInvalidCwd`. No fs I/O beyond the temp dir, no dsh imports.
//      Verifies the tagged-union + throwing-wrapper contract that BOTH
//      `dsh-acp.mjs::validateCwdParam` (protocol layer) and
//      `lib/acp-official-router.mjs::ensureSession` rely on.
//
//   2. Router integration: boot the Spike fixture (stub LlmAdapter) and assert
//      that `router.prompt({ cwd: <bad> })` throws BEFORE apply()'s session/new
//      runs — so the failure surfaces at the protocol boundary with
//      `code = "INVALID_CWD"` instead of an opaque spawn error from runDsh().
//
// This file is intentionally env-gated-friendly (no real LLM), so it runs in
// CI without a key. The only gate is `node:test` self-import resolution;
// nothing async / network.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { validateCwd, throwIfInvalidCwd } from "../lib/cwd-validator.mjs";
import { createOfficialAcpRouter } from "../lib/acp-official-router.mjs";
import { StubLlmAdapter, STUB_PROVIDER, STUB_MODEL } from "./fixtures/spike-llm-stub.mjs";
import { bootSpikeContext } from "./fixtures/spike-bootstrap.mjs";

// ---- Pure-function tests --------------------------------------------------

test("validateCwd: undefined/null/empty → ok with cwd=undefined (fall back)", () => {
  for (const v of [undefined, null, ""]) {
    const r = validateCwd(v);
    assert.equal(r.ok, true, `expected ok for ${JSON.stringify(v)}`);
    assert.equal(r.cwd, undefined);
  }
});

test("validateCwd: relative path → not_absolute", () => {
  const r = validateCwd("relative/path");
  assert.equal(r.ok, false);
  assert.equal(r.error.code, "INVALID_CWD");
  assert.equal(r.error.reason, "not_absolute");
  assert.equal(r.error.cwd, "relative/path");
});

test("validateCwd: non-string (number/object) → not_absolute with JSON-stringified cwd", () => {
  const num = validateCwd(42);
  assert.equal(num.ok, false);
  assert.equal(num.error.reason, "not_absolute");
  assert.equal(num.error.cwd, "42", "number coerces to '42'");

  const obj = validateCwd({ x: 1 });
  assert.equal(obj.ok, false);
  assert.equal(obj.error.reason, "not_absolute");
  assert.match(obj.error.cwd, /^\{.*\}$/, "object coerces to JSON");
});

test("validateCwd: absolute path to nonexistent dir → enoent", () => {
  const r = validateCwd("/this/path/does/not/exist/at/all");
  assert.equal(r.ok, false);
  assert.equal(r.error.reason, "enoent");
  assert.equal(r.error.code, "INVALID_CWD");
});

test("validateCwd: absolute path to an existing FILE → not_directory", () => {
  // Use a known-existing FILE: /etc/hosts (macOS / Linux)
  const r = validateCwd("/etc/hosts");
  assert.equal(r.ok, false);
  assert.equal(r.error.reason, "not_directory");
});

test("validateCwd: absolute path to an existing directory → ok with cwd set", () => {
  const dir = mkdtempSync(join(tmpdir(), "dsh-acp-cwd-validator-"));
  try {
    const r = validateCwd(dir);
    assert.equal(r.ok, true);
    assert.equal(r.cwd, dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("throwIfInvalidCwd: ok case returns the cwd (or undefined)", () => {
  const dir = mkdtempSync(join(tmpdir(), "dsh-acp-cwd-validator-throw-"));
  try {
    assert.equal(throwIfInvalidCwd(dir), dir);
    assert.equal(throwIfInvalidCwd(undefined), undefined);
    assert.equal(throwIfInvalidCwd(null), undefined);
    assert.equal(throwIfInvalidCwd(""), undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("throwIfInvalidCwd: invalid case throws Error with code=INVALID_CWD and preserves error payload", () => {
  let caught;
  try {
    throwIfInvalidCwd("relative/path", "session/new");
  } catch (e) {
    caught = e;
  }
  assert.ok(caught, "expected throw");
  assert.equal(caught.code, "INVALID_CWD");
  assert.equal(caught.error?.reason, "not_absolute");
  assert.match(caught.message, /session\/new/, "message should include opName");
});

// ---- Router integration tests --------------------------------------------

let bootHandle;
let ctx;

before(async () => {
  bootHandle = await bootSpikeContext();
  ctx = bootHandle.ctx;
  ctx.llm.registerAdapter([STUB_PROVIDER], new StubLlmAdapter());
});

after(async () => {
  await bootHandle?.dispose();
});

test("official router rejects bad cwd BEFORE apply() session/new", async () => {
  const router = createOfficialAcpRouter(ctx, { provider: STUB_PROVIDER, model: STUB_MODEL });
  try {
    let caught;
    try {
      await router.prompt("client-bad-cwd", {
        cwd: "relative/cwd/path",
        prompt: [{ type: "text", text: "should not reach llm" }],
      });
    } catch (e) {
      caught = e;
    }
    assert.ok(caught, "expected ensureSession to throw");
    assert.equal(caught.code, "INVALID_CWD");
    assert.equal(caught.error?.reason, "not_absolute");
    // Mapping must NOT have been created — the throw happens before session/new.
    assert.equal(router.getApplyId("client-bad-cwd"), undefined,
      "clientId must NOT be mapped when cwd validation rejects");
    assert.equal(router.sessionCount(), 0);
  } finally {
    router.close();
  }
});

test("official router rejects nonexistent absolute cwd BEFORE apply() session/new", async () => {
  const router = createOfficialAcpRouter(ctx, { provider: STUB_PROVIDER, model: STUB_MODEL });
  try {
    let caught;
    try {
      await router.prompt("client-missing-cwd", {
        cwd: "/this/abs/path/definitely/does/not/exist/xyz",
        prompt: [{ type: "text", text: "should not reach llm" }],
      });
    } catch (e) {
      caught = e;
    }
    assert.ok(caught, "expected ensureSession to throw");
    assert.equal(caught.code, "INVALID_CWD");
    assert.equal(caught.error?.reason, "enoent");
    assert.equal(router.sessionCount(), 0);
  } finally {
    router.close();
  }
});

test("official router rejects file path (not directory) BEFORE apply() session/new", async () => {
  // Create a temp file (not a directory).
  const tmp = mkdtempSync(join(tmpdir(), "dsh-acp-cwd-notdir-"));
  const filePath = join(tmp, "not-a-dir.txt");
  writeFileSync(filePath, "x");
  try {
    const router = createOfficialAcpRouter(ctx, { provider: STUB_PROVIDER, model: STUB_MODEL });
    try {
      let caught;
      try {
        await router.prompt("client-file-as-cwd", {
          cwd: filePath,
          prompt: [{ type: "text", text: "should not reach llm" }],
        });
      } catch (e) {
        caught = e;
      }
      assert.ok(caught, "expected ensureSession to throw");
      assert.equal(caught.code, "INVALID_CWD");
      assert.equal(caught.error?.reason, "not_directory");
      assert.equal(router.sessionCount(), 0);
    } finally {
      router.close();
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("official router accepts undefined cwd (falls back to process.cwd()) and runs prompt", async () => {
  const router = createOfficialAcpRouter(ctx, { provider: STUB_PROVIDER, model: STUB_MODEL });
  try {
    const result = await router.prompt("client-ok-undef-cwd", {
      // no cwd at all → fall back to process.cwd()
      prompt: [{ type: "text", text: "echo hello" }],
    });
    assert.ok(result.stopReason, `expected stopReason: ${JSON.stringify(result)}`);
    assert.ok(router.getApplyId("client-ok-undef-cwd"));
  } finally {
    router.close();
  }
});

test("official router accepts an existing absolute cwd and runs prompt", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dsh-acp-cwd-ok-"));
  try {
    const router = createOfficialAcpRouter(ctx, { provider: STUB_PROVIDER, model: STUB_MODEL });
    try {
      const result = await router.prompt("client-ok-abs-cwd", {
        cwd: dir,
        prompt: [{ type: "text", text: "echo hello" }],
      });
      assert.ok(result.stopReason, `expected stopReason: ${JSON.stringify(result)}`);
      assert.ok(router.getApplyId("client-ok-abs-cwd"));
    } finally {
      router.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Silence the unused-import linter for mkdirSync (left intentionally for
// symmetry with other test files that need to set up nested paths later).
void mkdirSync;