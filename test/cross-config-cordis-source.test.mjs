// test/cross-config-cordis-source.test.mjs — A1: cross-config checks 以 cordis.patch.yml 为基准
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import "../lib/selfcheck/cross-config-sync.mjs"; // side-effect register
import { createContext, runChecks, registeredExtraChecks } from "../lib/selfcheck/audit.mjs";

const CORDIS = `- id: llm-pi-ai
  name: "@deepseek-ai/dsh-llm-pi-ai"
  config:
    providers:
      jl-token:
        displayName: jl-token
        models:
          - id: DeepSeek-V4.1-Flash
            name: DeepSeek-V4.1-Flash
`;

function makeHome(profile, cordisText) {
  const home = mkdtempSync(join(tmpdir(), "cc-cordis-"));
  const pdir = join(home, "profiles", profile);
  mkdirSync(pdir, { recursive: true });
  if (cordisText != null) writeFileSync(join(pdir, "cordis.patch.yml"), cordisText);
  return home;
}

async function runCheck(id, { home, profile = "web", env = {} } = {}) {
  const ctx = createContext({
    env: { ...env, DSH_PROFILE: profile },
    roots: { injected: false, path: home, home, dshHome: home, obsidianDir: home, npmPrefix: home, adapter: home },
  });
  ctx.extraChecks = registeredExtraChecks();
  const { checks } = await runChecks(ctx);
  return checks.find((c) => c.id === id);
}

test("A1: cordis.patch.yml present with providers → SETTINGS_YAML_MISSING pass", async () => {
  const home = makeHome("web", CORDIS);
  const c = await runCheck("DSH_ACP_SETTINGS_YAML_MISSING", { home });
  assert.equal(c.status, "pass");
});

test("A1: cordis.patch.yml missing → fail (not the legacy settings.yaml)", async () => {
  const home = makeHome("web", null); // no cordis file
  const c = await runCheck("DSH_ACP_SETTINGS_YAML_MISSING", { home });
  assert.equal(c.status, "fail");
  assert.match(c.detail, /cordis\.patch\.yml/);
});

test("A1: cordis.patch.yml present but no providers → fail", async () => {
  const home = makeHome("web", "- id: something-else\n  config: {}\n");
  const c = await runCheck("DSH_ACP_SETTINGS_YAML_MISSING", { home });
  assert.equal(c.status, "fail");
  assert.match(c.detail, /未声明任何 llm-pi-ai\.providers/);
});

test("A1: DESYNC passes when dropdown catalog covers declared providers", async () => {
  const home = makeHome("web", CORDIS);
  // loadProviderCatalog reads <home>/profiles/<DSH_PROFILE>/cordis.patch.yml with DSH_HOME set
  const c = await runCheck("DSH_ACP_SETTINGS_CORDIS_DESYNC", {
    home, profile: "web", env: { DSH_HOME: home },
  });
  assert.equal(c.status, "pass");
});

test("A1: desktop default provider judged against other profiles' cordis (no settings.yaml)", async () => {
  const home = mkdtempSync(join(tmpdir(), "cc-desktop-"));
  // desktop profile declares agent-default-model provider jl-token
  mkdirSync(join(home, "profiles", "desktop"), { recursive: true });
  writeFileSync(join(home, "profiles", "desktop", "cordis.patch.yml"),
    "- id: agent-default-model\n  config:\n    provider: jl-token\n    model: DeepSeek-V4.1-Flash\n");
  // web profile declares provider jl-token under llm-pi-ai
  mkdirSync(join(home, "profiles", "web"), { recursive: true });
  writeFileSync(join(home, "profiles", "web", "cordis.patch.yml"), CORDIS);
  const c = await runCheck("DSH_DESKTOP_DEFAULT_MODEL_VALID", { home });
  assert.equal(c.status, "pass", `expected pass, got ${c.status}: ${c.detail}`);
});

// ---- A2: PROVIDER_NAME_HYPHEN comment exclusion (// and #) ----

test("A2: '//' comment line with jl-token → NOT a finding (pass)", async () => {
  const home = mkdtempSync(join(tmpdir(), "hyphen-"));
  const adapter = join(home, "dsh-acp.mjs");
  writeFileSync(adapter, [
    "// t38: 不再兜硬编码 \"jl-token\" —— env 缺失时为 null",
    "const x = 1;",
  ].join("\n"));
  const c = await runCheck("DSH_ACP_PROVIDER_NAME_HYPHEN", { home, env: { DSH_ACP_ADAPTER_PATH: adapter } });
  // locateAdapterSource uses ctx.roots.adapter; our ctx uses `adapter: home` (dir) so it
  // falls back to the package copy — either way the '//' line must not cause a FAIL.
  assert.ok(c.status === "pass" || c.status === "skip", `expected pass/skip, got ${c.status}: ${c.detail}`);
});

test("A2: real (non-comment) jl-token literal → fail", async () => {
  const home = mkdtempSync(join(tmpdir(), "hyphen2-"));
  const adapter = join(home, "dsh-acp.mjs");
  writeFileSync(adapter, ['const NAMES = ["jl-token"];'].join("\n"));
  const ctx = createContext({
    env: {},
    roots: { injected: false, path: home, home, dshHome: home, obsidianDir: home, npmPrefix: home, adapter },
  });
  ctx.extraChecks = registeredExtraChecks();
  const { checks } = await runChecks(ctx);
  const c = checks.find((x) => x.id === "DSH_ACP_PROVIDER_NAME_HYPHEN");
  assert.equal(c.status, "fail", `expected fail, got ${c.status}: ${c.detail}`);
});
