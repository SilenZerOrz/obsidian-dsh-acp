// test/repair.test.mjs — repair.mjs 单元测试
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { registerRepairer, repairAll } from "../lib/selfcheck/repair.mjs";
import { createContext } from "../lib/selfcheck/audit.mjs";

test("repair: empty findings → empty actions, code=ok", async () => {
  const ctx = createContext({ env: {}, fast: true });
  const r = await repairAll([], ctx, { dry: true });
  assert.equal(r.code, "ok");
  assert.equal(r.actions.length, 0);
  assert.equal(r.escape, false);
  assert.equal(r.backups.length, 0);
});

test("repair: dry mode never writes even with execute=true hint and no target", async () => {
  const ctx = createContext({ env: {}, fast: true });
  const findings = [{ code: "GC_REPORT_ONLY_IGNORED", status: "fail" }];
  const r = await repairAll(findings, ctx, { dry: true });
  for (const a of r.actions) {
    assert.equal(a.applied, false, `dry mode should never apply: ${a.code}`);
  }
});

test("repair: custom registered repairer is called with check + opts", async () => {
  let called = 0;
  registerRepairer("TEST_REPAIR_CUSTOM", async (check, opts) => {
    called++;
    assert.equal(check.code, "TEST_REPAIR_CUSTOM");
    assert.equal(opts.dry, true);
    return { kind: "plan-only", plan: "ok" };
  });
  const ctx = createContext({ env: {}, fast: true });
  const r = await repairAll([{ code: "TEST_REPAIR_CUSTOM", status: "fail" }], ctx, { dry: true });
  assert.ok(called >= 1);
  assert.equal(r.actions[0].code, "TEST_REPAIR_CUSTOM");
  assert.equal(r.actions[0].applied, false);
});

test("repair: fixture-escape triggers FIXTURE_ESCAPE code, zero actions", async () => {
  const root = mkdtempSync(join(tmpdir(), "escape-"));
  const env = {};
  const ctx = createContext({ env, roots: { ...ctx_roots(), path: root, injected: true } });
  // Force injected=true
  ctx.roots.injected = true;
  ctx.roots.path = root;
  // Finding carries an out-of-bounds target in its action.target — pre-check
  // runs before any repairer, so escape is detected even if repairer never fires.
  const findings = [{
    code: "TEST_ESCAPE",
    status: "fail",
    action: { kind: "write-file", target: "/etc/passwd" },
  }];
  const r = await repairAll(findings, ctx, { dry: false, execute: true });
  assert.equal(r.escape, true);
  assert.equal(r.code, "FIXTURE_ESCAPE");
  assert.equal(r.actions.length, 0);
});

test("repair: actions are deduplicated by code::target key", async () => {
  const ctx = createContext({ env: {}, fast: true });
  // Same repairer called twice via identical findings
  registerRepairer("TEST_DEDUP", async () => ({
    kind: "plan-only", plan: "same", target: "/a/b",
  }));
  const r = await repairAll([
    { code: "TEST_DEDUP", status: "fail" },
    { code: "TEST_DEDUP", status: "fail" },
  ], ctx, { dry: true });
  assert.equal(r.actions.length, 1);
});

function ctx_roots() {
  return {
    injected: false, path: "/tmp", home: "/tmp", dshHome: "/tmp/.dsh",
    obsidianDir: "/tmp", npmPrefix: "/tmp", adapter: "/tmp",
  };
}

test("repair: handler that throws becomes an error action (not crash)", async () => {
  const ctx = createContext({ env: {}, fast: true });
  registerRepairer("TEST_THROWS", async () => { throw new Error("boom"); });
  const r = await repairAll([{ code: "TEST_THROWS", status: "fail" }], ctx, { dry: true });
  assert.equal(r.actions[0].code, "TEST_THROWS");
  assert.equal(r.actions[0].kind, "error");
  assert.match(r.actions[0].plan, /boom/);
});
