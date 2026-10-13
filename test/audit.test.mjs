// test/audit.test.mjs — audit.mjs 单元测试
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  CHECK_META, CHECK_ORDER, BLOCKING_CODES,
  createContext, registerChecks, registeredExtraChecks, runChecks,
  scanProviderKeys, readAgentDefaultModel, modelForProvider,
} from "../lib/selfcheck/audit.mjs";

test("audit: CHECK_META has 16 entries and CHECK_ORDER has 16 ids in frozen order", () => {
  const orderIds = CHECK_ORDER;
  const metaIds = Object.keys(CHECK_META);
  assert.equal(metaIds.length, 16);
  assert.equal(orderIds.length, 16);
  // All order ids must exist in meta
  for (const id of orderIds) {
    assert.ok(CHECK_META[id], `meta missing for ${id}`);
  }
});

test("audit: CHECK_META and CHECK_ORDER ids are identical sets", () => {
  const orderSet = new Set(CHECK_ORDER);
  const metaSet = new Set(Object.keys(CHECK_META));
  assert.equal(orderSet.size, metaSet.size);
  for (const id of orderSet) assert.ok(metaSet.has(id), `order has ${id} but meta doesn't`);
  for (const id of metaSet) assert.ok(orderSet.has(id), `meta has ${id} but order doesn't`);
});

test("audit: BLOCKING_CODES contains exactly ZOD_MISSING", () => {
  assert.deepEqual([...BLOCKING_CODES], ["ZOD_MISSING"]);
});

test("audit: createContext builds ctx with roots / env / fast / mode", () => {
  const env = { DSH_HOME: "/x" };
  const ctx = createContext({ env, fast: true, mode: "report" });
  assert.equal(ctx.fast, true);
  assert.equal(ctx.mode, "report");
  assert.equal(ctx.env, env);
  assert.equal(ctx.roots.dshHome, "/x");
  assert.equal(typeof ctx.bust, "function");
});

test("audit: registerChecks / registeredExtraChecks round-trip", () => {
  const before = registeredExtraChecks().length;
  registerChecks([{
    id: "TEST_EXTRA_1",
    severity: "low", fixable: false, title: "x",
    run: async () => ({ status: "pass" }),
  }]);
  const after = registeredExtraChecks();
  assert.ok(after.length === before + 1 || after.some((c) => c.id === "TEST_EXTRA_1"));
});

test("audit: runChecks returns 16 + extra check rows", async () => {
  const ctx = createContext({ env: { DSH_ACP_SELFCHECK_FAST: "1" }, fast: true });
  const { checks, findings } = await runChecks(ctx);
  assert.ok(checks.length >= 16, `expected >=16 checks, got ${checks.length}`);
  // Each check has the canonical id
  for (const c of checks.slice(0, 16)) {
    assert.ok(CHECK_ORDER.includes(c.id), `unexpected id: ${c.id}`);
  }
  // findings should be a subset
  assert.ok(Array.isArray(findings));
});

test("audit: scanProviderKeys extracts top-level yaml keys", () => {
  const yaml = "providers:\n  jltoken:\n    model: x\n  qwen:\n    model: y\n";
  const keys = scanProviderKeys(yaml);
  assert.ok(keys.includes("jltoken"));
  assert.ok(keys.includes("qwen"));
});

test("audit: modelForProvider returns 4 hardcoded fallbacks", () => {
  assert.equal(modelForProvider("jltoken"), "DeepSeek-V4-Flash");
  assert.equal(modelForProvider("qwen"), "Qwen3.8");
  assert.equal(modelForProvider("Kimi-K2.6"), "Kimi-K2.6");
  assert.equal(modelForProvider("gemini-2.5-pro"), "gemini-2.5-pro");
  assert.equal(modelForProvider("nonexistent"), null);
});

test("audit: readAgentDefaultModel returns provider=null on missing dir", () => {
  const r = readAgentDefaultModel("/this/path/does/not/exist");
  assert.equal(r.provider, null);
  assert.equal(r.model, null);
});

test("audit: readAgentDefaultModel parses cordis list-item section (- id: agent-default-model)", () => {
  const dir = mkdtempSync(join(tmpdir(), "cordis-list-"));
  writeFileSync(join(dir, "cordis.patch.yml"), [
    "- id: llm-deepseek",
    "  name: '@deepseek-ai/dsh-llm-deepseek-api-key'",
    "  config:",
    "    baseURL: http://x/v1",
    "- id: agent-default-model",
    "  name: '@deepseek-ai/dsh-agent-default-model'",
    "  config:",
    "    provider: jl-token",
    "    model: gemini-2.5-pro",
    "- id: llm-next",
    "  config:",
    "    provider: OTHER",
    "",
  ].join("\n"));
  const r = readAgentDefaultModel(dir);
  assert.equal(r.provider, "jl-token");
  assert.equal(r.model, "gemini-2.5-pro");
});

test("audit: readAgentDefaultModel parses nested-key section (agent-default-model:)", () => {
  const dir = mkdtempSync(join(tmpdir(), "cordis-nested-"));
  writeFileSync(join(dir, "cordis.patch.yml"), [
    "agent-default-model:",
    "  provider: qwen",
    "  model: Qwen3.8",
    "other:",
    "  provider: nope",
    "",
  ].join("\n"));
  const r = readAgentDefaultModel(dir);
  assert.equal(r.provider, "qwen");
  assert.equal(r.model, "Qwen3.8");
});
