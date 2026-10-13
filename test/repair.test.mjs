// test/repair.test.mjs — repair.mjs 单元测试
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
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
  let sawCtx = null;
  registerRepairer("TEST_REPAIR_CUSTOM", async (check, ctx, opts) => {
    called++;
    sawCtx = ctx;
    assert.equal(check.code, "TEST_REPAIR_CUSTOM");
    assert.equal(opts.dry, true);
    return { kind: "plan-only", plan: "ok" };
  });
  const ctx = createContext({ env: {}, fast: true });
  const r = await repairAll([{ code: "TEST_REPAIR_CUSTOM", status: "fail" }], ctx, { dry: true });
  assert.ok(called >= 1);
  assert.equal(r.actions[0].code, "TEST_REPAIR_CUSTOM");
  assert.equal(r.actions[0].applied, false);
  // Contract: 2nd arg is the context (has roots), not opts.
  assert.ok(sawCtx && sawCtx.roots, "handler 2nd arg should be ctx with roots");
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

test("repair: write-yaml action persists + creates .bak when execute", async () => {
  const root = mkdtempSync(join(tmpdir(), "exec-"));
  const target = join(root, "settings.yaml");
  writeFileSync(target, "old: content\n");
  registerRepairer("TEST_WRITE", async () => ({
    kind: "write-yaml", plan: "write it", target, content: "new: content\n",
  }));
  const ctx = createContext({ env: {}, roots: { ...ctx_roots(), home: root, dshHome: root } });
  const r = await repairAll([{ code: "TEST_WRITE", status: "fail" }], ctx, { execute: true });
  const a = r.actions[0];
  assert.equal(a.applied, true);
  assert.equal(a.status, "applied");
  assert.ok(a.backupPath && existsSync(a.backupPath), "backup file should exist");
  assert.equal(readFileSync(target, "utf8"), "new: content\n");
  assert.equal(r.backups.length, 1);
});

test("repair: dry-run never writes (write-yaml stays planned)", async () => {
  const root = mkdtempSync(join(tmpdir(), "nodry-"));
  const target = join(root, "settings.yaml");
  registerRepairer("TEST_NODRY", async () => ({
    kind: "write-yaml", plan: "write it", target, content: "should not appear\n",
  }));
  const ctx = createContext({ env: {}, roots: { ...ctx_roots(), home: root, dshHome: root } });
  const r = await repairAll([{ code: "TEST_NODRY", status: "fail" }], ctx, { dryRun: true });
  assert.equal(r.actions[0].applied, false);
  assert.equal(existsSync(target), false, "dry-run must not create the file");
});

test("repair: executor refuses target outside home (fixture/escape guard)", async () => {
  const root = mkdtempSync(join(tmpdir(), "guard-"));
  registerRepairer("TEST_GUARD", async () => ({
    kind: "write-yaml", plan: "bad", target: "/etc/passwd", content: "x",
  }));
  const ctx = createContext({ env: {}, roots: { ...ctx_roots(), home: root, dshHome: root } });
  const r = await repairAll([{ code: "TEST_GUARD", status: "fail" }], ctx, { execute: true });
  assert.equal(r.actions[0].applied, false);
  assert.match(r.actions[0].error ?? "", /拒绝写入/);
});

test("repair: handler returning an array fans out into multiple actions", async () => {
  registerRepairer("TEST_ARRAY", async () => ([
    { id: "a#1", kind: "plan-only", note: "one" },
    { id: "a#2", kind: "plan-only", note: "two" },
  ]));
  const ctx = createContext({ env: {}, fast: true });
  const r = await repairAll([{ code: "TEST_ARRAY", status: "fail" }], ctx, { dryRun: true });
  assert.equal(r.actions.length, 2);
});

test("repair: edit-json action merges without clobbering other keys", async () => {
  const root = mkdtempSync(join(tmpdir(), "editjson-"));
  const target = join(root, "data.json");
  writeFileSync(target, JSON.stringify({ keep: 1, customAgents: [] }));
  registerRepairer("TEST_EDITJSON", async () => ({
    kind: "edit-json", plan: "add dsh-acp", target,
    payload: (cur) => ({ ...cur, customAgents: [...(cur.customAgents ?? []), { id: "dsh-acp" }] }),
  }));
  const ctx = createContext({ env: {}, roots: { ...ctx_roots(), home: root, dshHome: root } });
  await repairAll([{ code: "TEST_EDITJSON", status: "fail" }], ctx, { execute: true });
  const j = JSON.parse(readFileSync(target, "utf8"));
  assert.equal(j.keep, 1);
  assert.deepEqual(j.customAgents, [{ id: "dsh-acp" }]);
});
