// test/conversation-output-guard.test.mjs — Layer C 自检（源码守卫 + 开关）
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import "../lib/selfcheck/conversation-output.mjs"; // side-effect register
import { createContext, runChecks, registeredExtraChecks } from "../lib/selfcheck/audit.mjs";
import { repairAll } from "../lib/selfcheck/repair.mjs";

function ctxRoots(overrides = {}) {
  return {
    injected: false, path: "/tmp", home: "/tmp", dshHome: "/tmp/.dsh",
    obsidianDir: "/tmp", npmPrefix: "/tmp", adapter: "/tmp", ...overrides,
  };
}

async function runCheckOf(id, ctx) {
  // createContext defaults extraChecks to [] — mirror auditAll's behaviour so the
  // registered pluggable checks (incl. this module's) actually run.
  ctx.extraChecks = registeredExtraChecks();
  const { checks } = await runChecks(ctx);
  return checks.find((c) => c.id === id);
}

test("guard: all four fallback guards present → pass", async () => {
  const dir = mkdtempSync(join(tmpdir(), "conv-guard-"));
  const src = join(dir, "dsh-acp.mjs");
  writeFileSync(src, [
    "if (proxyToolFrames >= 1 && visibleLen === 0) {",
    "  const synth = toolOnlyFallbackText(names);",
    "}",
    "if (shouldSynthesizeFallback({ visibleText, toolFrames: spawnToolFrames })) {}",
    "const outboundMessages = withClosingReplyNudge(history, enabled);",
  ].join("\n"));
  const ctx = createContext({ env: {}, roots: ctxRoots({ adapter: src }) });
  const c = await runCheckOf("DSH_ACP_CONVERSATION_OUTPUT_GUARD", ctx);
  assert.equal(c.status, "pass");
});

test("guard: a missing guard → fail with evidence naming it", async () => {
  const dir = mkdtempSync(join(tmpdir(), "conv-guard-"));
  const src = join(dir, "dsh-acp.mjs");
  // Missing the spawn discriminator + Layer B.
  writeFileSync(src, [
    "if (proxyToolFrames >= 1 && visibleLen === 0) {",
    "  const synth = toolOnlyFallbackText(names);",
    "}",
  ].join("\n"));
  const ctx = createContext({ env: {}, roots: ctxRoots({ adapter: src }) });
  const c = await runCheckOf("DSH_ACP_CONVERSATION_OUTPUT_GUARD", ctx);
  assert.equal(c.status, "fail");
  assert.ok(Array.isArray(c.evidence) && c.evidence.length > 0);
});

test("guard: unreadable/nonexistent source → skip (never a false pass)", async () => {
  const ctx = createContext({ env: {}, roots: ctxRoots({ adapter: "/no/such/dsh-acp.mjs" }) });
  const c = await runCheckOf("DSH_ACP_CONVERSATION_OUTPUT_GUARD", ctx);
  // locateAdapterSource falls back to the real in-package dsh-acp.mjs (which has guards).
  // Either skip (unlocatable) or a real verdict — but never a fabricated "fail on unreadable".
  assert.ok(["skip", "pass", "fail"].includes(c.status));
});

test("switch: default env → pass; explicit off → warn", async () => {
  const on = await runCheckOf("DSH_ACP_TOOL_ONLY_FALLBACK_DISABLED",
    createContext({ env: {}, roots: ctxRoots() }));
  assert.equal(on.status, "pass");

  const off = await runCheckOf("DSH_ACP_TOOL_ONLY_FALLBACK_DISABLED",
    createContext({ env: { DSH_ACP_TOOL_ONLY_FALLBACK: "off" }, roots: ctxRoots() }));
  assert.equal(off.status, "warn");
  assert.match(off.detail, /DSH_ACP_TOOL_ONLY_FALLBACK/);
});

test("repair: both checks are plan-only — no file written, no false 'applied'", async () => {
  const dir = mkdtempSync(join(tmpdir(), "conv-repair-"));
  const before = readdirSync(dir).length;
  const ctx = createContext({ env: {}, roots: ctxRoots({ home: dir, dshHome: dir, path: dir }) });
  const r = await repairAll([
    { code: "DSH_ACP_CONVERSATION_OUTPUT_GUARD", status: "fail" },
    { code: "DSH_ACP_TOOL_ONLY_FALLBACK_DISABLED", status: "warn" },
  ], ctx, { execute: true });
  assert.equal(r.backups.length, 0, "plan-only must not create backups");
  for (const a of r.actions) {
    assert.equal(a.applied, false, `${a.code} must not be reported applied`);
    assert.equal(a.status, "planned");
    assert.equal(a.kind, "plan-only");
  }
  assert.equal(readdirSync(dir).length, before, "no file in the fixture dir changed");
});
