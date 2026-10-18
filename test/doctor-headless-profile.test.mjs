#!/usr/bin/env node
// test/doctor-headless-profile.test.mjs — doctor.mjs 五层检测的契约测试
//
// 不动真实 ~/.dsh/profiles/headless，建一个 mkdtemp 临时 profile，
// 模拟每种坏状态，验证 diagnoseHeadlessProfile() 报告对应 kind。
//
// 每个 case 用 process.env.DSH_ACP_PROFILE_DIR 指向临时目录，
// 跑诊断 → reset 临时目录 → 跑下一个 case。
//
// Exit 0=全绿；1=任一 case 漏报或误报。

import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "node:test";

const { test } = await import("node:test");
import { strict as assert } from "node:assert";
import { diagnoseHeadlessProfile } from "../doctor.mjs";

function newTmpProfile() {
  const dir = mkdtempSync(join(tmpdir(), "dsh-acp-doctor-"));
  return dir;
}
function writeFile(dir, name, content) {
  const p = join(dir, name);
  writeFileSync(p, content);
  return p;
}
function reset() {
  if (process.env.DSH_ACP_PROFILE_DIR) delete process.env.DSH_ACP_PROFILE_DIR;
}

const BASE_PATCH = `- id: llm-pi-ai
  name: "@deepseek-ai/dsh-llm-pi-ai"
  config:
    providers:
      jl-token:
        displayName: jl-token
        apiKeyEnv: JL_TOKEN_API_KEY
        api: openai-completions
        baseURL: http://example.invalid/v1
        models:
          - id: gemini-2.5-pro
            name: gemini-2.5-pro
`;

const BASE_PKG = {
  name: "dsh-profile-headless",
  private: true,
  devDependencies: {
    "@deepseek-ai/dsh-acp": "0.1.7-rc.1",
    "@deepseek-ai/dsh-agent-loop": "0.1.7-rc.1",
    "@deepseek-ai/dsh-base": "0.1.7-rc.1",
    "@deepseek-ai/dsh-headless": "0.1.7-rc.1",
    "@deepseek-ai/dsh-llm": "0.1.7-rc.1",
  },
};

const BASE_WS = `packages:
  - .
nodeLinker: hoisted
autoInstallPeers: false
allowBuilds:
  '@deepseek-ai/dsh-subprocess-local': true
overrides:
  "@deepseek-ai/dsh-base": "0.1.7-rc.1"
  "@deepseek-ai/dsh-llm": "0.1.7-rc.1"
`;

function setupGood(dir) {
  writeFile(dir, "cordis.patch.yml", BASE_PATCH);
  writeFile(dir, "package.json", JSON.stringify(BASE_PKG, null, 2));
  writeFile(dir, "pnpm-workspace.yaml", BASE_WS);
}

test("baseline (well-configured profile) → 0 issues", () => {
  reset();
  const dir = newTmpProfile();
  try {
    process.env.DSH_ACP_PROFILE_DIR = dir;
    setupGood(dir);
    const issues = diagnoseHeadlessProfile();
    assert.equal(issues.length, 0, `expected 0 issues, got: ${JSON.stringify(issues.map((i) => i.kind))}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    reset();
  }
});

test("layer 1: cordis.patch.yml default → deepseek-official (broken key)", () => {
  reset();
  const dir = newTmpProfile();
  try {
    process.env.DSH_ACP_PROFILE_DIR = dir;
    setupGood(dir);
    writeFile(dir, "cordis.patch.yml", BASE_PATCH + `
- id: agent-default-model
  name: '@deepseek-ai/dsh-agent-default-model'
  config:
    provider: deepseek-official
    model: deepseek-v4-flash
`);
    const issues = diagnoseHeadlessProfile();
    const kinds = issues.map((i) => i.kind);
    assert.ok(kinds.includes("headless-default-model-broken"),
      `expected headless-default-model-broken, got: ${JSON.stringify(kinds)}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    reset();
  }
});

test("layer 2: package.json missing 3 devDeps", () => {
  reset();
  const dir = newTmpProfile();
  try {
    process.env.DSH_ACP_PROFILE_DIR = dir;
    setupGood(dir);
    const pkg = JSON.parse(JSON.stringify(BASE_PKG));
    delete pkg.devDependencies["@deepseek-ai/dsh-llm"];
    delete pkg.devDependencies["@deepseek-ai/dsh-agent-loop"];
    delete pkg.devDependencies["@deepseek-ai/dsh-acp"];
    writeFile(dir, "package.json", JSON.stringify(pkg, null, 2));
    const issues = diagnoseHeadlessProfile();
    const kinds = issues.map((i) => i.kind);
    assert.ok(kinds.includes("headless-missing-deps"),
      `expected headless-missing-deps, got: ${JSON.stringify(kinds)}`);
    const dep = issues.find((i) => i.kind === "headless-missing-deps");
    assert.match(dep.hint, /dsh-llm/);
    assert.match(dep.hint, /dsh-agent-loop/);
    assert.match(dep.hint, /dsh-acp/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    reset();
  }
});

test("layer 3: pnpm-workspace.yaml missing overrides", () => {
  reset();
  const dir = newTmpProfile();
  try {
    process.env.DSH_ACP_PROFILE_DIR = dir;
    setupGood(dir);
    writeFile(dir, "pnpm-workspace.yaml", `packages:
  - .
nodeLinker: hoisted
allowBuilds:
  '@deepseek-ai/dsh-subprocess-local': true
`);
    const issues = diagnoseHeadlessProfile();
    const kinds = issues.map((i) => i.kind);
    assert.ok(kinds.includes("headless-workspace-yaml-incomplete"),
      `expected headless-workspace-yaml-incomplete, got: ${JSON.stringify(kinds)}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    reset();
  }
});

test("layer 4: cordis.patch.yml uses wrong plugin name dsh-settings-file", () => {
  reset();
  const dir = newTmpProfile();
  try {
    process.env.DSH_ACP_PROFILE_DIR = dir;
    setupGood(dir);
    writeFile(dir, "cordis.patch.yml", `- id: settings
  name: "@deepseek-ai/dsh-settings-file"
  config:
    providers:
      jl-token:
        apiKeyEnv: ANIONEX_FREE_VISION
`);
    const issues = diagnoseHeadlessProfile();
    const kinds = issues.map((i) => i.kind);
    assert.ok(kinds.includes("headless-cordis-plugin-name-wrong"),
      `expected headless-cordis-plugin-name-wrong, got: ${JSON.stringify(kinds)}`);
    assert.ok(kinds.includes("headless-cordis-llm-pi-ai-missing"),
      `expected headless-cordis-llm-pi-ai-missing, got: ${JSON.stringify(kinds)}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    reset();
  }
});

test("layer 5: redundant settings.yaml exists", () => {
  reset();
  const dir = newTmpProfile();
  try {
    process.env.DSH_ACP_PROFILE_DIR = dir;
    setupGood(dir);
    writeFile(dir, "settings.yaml", `providers:
  jl-token:
    apiKeyEnv: JL_TOKEN_API_KEY
`);
    const issues = diagnoseHeadlessProfile();
    const kinds = issues.map((i) => i.kind);
    assert.ok(kinds.includes("headless-redundant-settings-yaml"),
      `expected headless-redundant-settings-yaml, got: ${JSON.stringify(kinds)}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    reset();
  }
});

test("profile dir missing entirely", () => {
  reset();
  const dir = newTmpProfile();
  try {
    process.env.DSH_ACP_PROFILE_DIR = dir;
    // delete the dir to simulate missing profile
    rmSync(dir, { recursive: true, force: true });
    const issues = diagnoseHeadlessProfile();
    const kinds = issues.map((i) => i.kind);
    assert.ok(kinds.includes("headless-profile-missing"),
      `expected headless-profile-missing, got: ${JSON.stringify(kinds)}`);
  } finally {
    reset();
  }
});

// === P0-1: 层 6 headless 凭据检查 ===
import { __setTestVersion } from "../doctor.mjs";

const ENV_PATCH = BASE_PATCH; // BASE_PATCH 含 apiKeyEnv: JL_TOKEN_API_KEY

test("层 6: headless + dsh ≥ 0.2.1-rc.2 + 无 .env → 报 high", () => {
  reset();
  const dir = newTmpProfile();
  const home = newTmpProfile();      // 临时 DSH_HOME（无 .env）
  const prevHome = process.env.DSH_HOME;
  try {
    process.env.DSH_ACP_PROFILE_DIR = dir;
    process.env.DSH_HOME = home;
    delete process.env.JL_TOKEN_API_KEY;
    setupGood(dir);
    __setTestVersion("0.2.1-rc.2");
    const issues = diagnoseHeadlessProfile();
    const hit = issues.find((i) => i.kind === "headless-credential-env");
    assert.ok(hit, `expected headless-credential-env, got: ${JSON.stringify(issues.map((i) => i.kind))}`);
    assert.equal(hit.severity, "high");
    assert.ok(hit.hint.includes("JL_TOKEN_API_KEY"), "hint should name the missing env");
  } finally {
    __setTestVersion(undefined);
    if (prevHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = prevHome;
    rmSync(dir, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
    reset();
  }
});

test("层 6: headless + dsh ≥ 0.2.1-rc.2 + .env 含 key → 不报", () => {
  reset();
  const dir = newTmpProfile();
  const home = newTmpProfile();
  const prevHome = process.env.DSH_HOME;
  try {
    process.env.DSH_ACP_PROFILE_DIR = dir;
    process.env.DSH_HOME = home;
    delete process.env.JL_TOKEN_API_KEY;
    setupGood(dir);
    writeFile(home, ".env", "JL_TOKEN_API_KEY=dummy\n");
    __setTestVersion("0.2.1-rc.2");
    const issues = diagnoseHeadlessProfile();
    assert.ok(!issues.some((i) => i.kind === "headless-credential-env"),
      `should NOT report; got: ${JSON.stringify(issues.map((i) => i.kind))}`);
  } finally {
    __setTestVersion(undefined);
    if (prevHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = prevHome;
    rmSync(dir, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
    reset();
  }
});

test("层 6: headless + dsh < 0.2.1-rc.2 → 不报（旧版读 credentials.yaml）", () => {
  reset();
  const dir = newTmpProfile();
  const home = newTmpProfile();
  const prevHome = process.env.DSH_HOME;
  try {
    process.env.DSH_ACP_PROFILE_DIR = dir;
    process.env.DSH_HOME = home;
    delete process.env.JL_TOKEN_API_KEY;
    setupGood(dir);
    __setTestVersion("0.2.0-rc.2");
    const issues = diagnoseHeadlessProfile();
    assert.ok(!issues.some((i) => i.kind === "headless-credential-env"),
      `old dsh should NOT report; got: ${JSON.stringify(issues.map((i) => i.kind))}`);
  } finally {
    __setTestVersion(undefined);
    if (prevHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = prevHome;
    rmSync(dir, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
    reset();
  }
});

test("层 6: 版本不可判定（compareSemver null）→ 保守不报", () => {
  reset();
  const dir = newTmpProfile();
  const home = newTmpProfile();
  const prevHome = process.env.DSH_HOME;
  try {
    process.env.DSH_ACP_PROFILE_DIR = dir;
    process.env.DSH_HOME = home;
    delete process.env.JL_TOKEN_API_KEY;
    setupGood(dir);
    __setTestVersion("not-a-version");   // compareSemver → null
    const issues = diagnoseHeadlessProfile();
    assert.ok(!issues.some((i) => i.kind === "headless-credential-env"),
      `unparseable version should NOT report; got: ${JSON.stringify(issues.map((i) => i.kind))}`);
  } finally {
    __setTestVersion(undefined);
    if (prevHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = prevHome;
    rmSync(dir, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
    reset();
  }
});

// === P0-1: parseCredentialIssue（凭据修复提示）===
import { parseCredentialIssue } from "../doctor.mjs";

test("parseCredentialIssue: 不抛错 + 双提示（.env + .zshrc）", () => {
  const issue = parseCredentialIssue(
    'MISSING_CREDENTIAL: llm-pi-ai: no credential for provider route "jltoken"; its profile resolves JLTOKEN_API_KEY',
  );
  assert.ok(issue, "应返回 issue 对象（非 null）");
  assert.equal(issue.kind, "missing-credential");
  assert.equal(issue.severity, "high");
  assert.equal(issue.envName, "JLTOKEN_API_KEY");

  const fixText = issue.fix.join("\n");
  assert.match(fixText, /~\/\.dsh\/\.env/, "应含 headless .env 提示");
  assert.match(fixText, /\.zshrc/, "应含非 headless .zshrc 提示");
  assert.match(fixText, /JLTOKEN_API_KEY/, "应含具体 env 名");
});
