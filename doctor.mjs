// doctor.mjs — obsidian-dsh-acp 健康诊断 + 可复制修复指引（版本无关，兼容 0.1.1-rc.2 / 0.1.2-alpha）
//
// 设计原则：
//  - 只做通用检查（dsh 二进制 / 版本 / 凭据缺失 / 插件版本），不依赖任何 dsh 版本特有的 ACP API。
//  - "修复指引"输出为可直接复制的 shell 命令；自动修复必须显式确认（--auto 或用户回复确认）。
//
// 用法：
//  - node dsh-acp.mjs doctor          体检并打印诊断 + 修复命令
//  - node dsh-acp.mjs doctor --auto   尝试自动修复（每步先提示将执行的操作，需确认）
//  - 程序内: import { diagnoseFromError, formatFixHints } from "./doctor.mjs"

import { accessSync, constants as fsConstants, existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

// 本插件版本（与 package.json 保持同步）：从同目录 package.json 读，避免依赖 cwd
const _PKG = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), "package.json"), "utf8"),
);
export const ADAPTER_VERSION = _PKG.version;

/** 定位 dsh 二进制（唯一实现；dsh-acp.mjs 也从此导入）。 */
export function detectDshBinary() {
  if (process.env.DSH_BIN) return process.env.DSH_BIN;
  if (process.env.DSH_ACP_DSH) return process.env.DSH_ACP_DSH;
  const candidates = [
    process.env.DSH_HOME && join(process.env.DSH_HOME, "bin", "dsh"),
    join(homedir(), ".local", "bin", "dsh"),
    join(homedir(), ".npm-global", "bin", "dsh"),
    join("/opt/homebrew", "bin", "dsh"),
    join("/usr/local", "bin", "dsh"),
  ].filter(Boolean);
  for (const p of candidates) {
    if (isAbsolute(p)) {
      try { accessSync(p, fsConstants.X_OK); return p; } catch { /* next */ }
    }
  }
  // Windows 兜底：npm 全局安装的 dsh 只有 .cmd/.ps1/sh 三种垫片——CreateProcess
  // 无法执行无扩展名 sh 垫片，Node spawn 也不做 PATHEXT 解析（裸名 → ENOENT），
  // 所以在 PATH 上显式找 dsh.cmd。
  if (process.platform === "win32") {
    for (const dir of (process.env.PATH ?? "").split(";")) {
      if (!dir) continue;
      const p = join(dir.trim(), "dsh.cmd");
      try { accessSync(p, fsConstants.X_OK); return p; } catch { /* next */ }
    }
  }
  return "dsh";
}

const DSH_BIN = detectDshBinary();

/**
 * Windows 兼容：把 detectDshBinary() 的结果转换为可直接 spawn 的形式。
 *
 * 背景：npm 全局安装的 dsh 在 Windows 上是 .cmd 垫片（如 %APPDATA%\npm\dsh.cmd）。
 * Node 的 spawn（无 shell）对裸名不做 PATHEXT 解析（ENOENT），且 Node >= 18.20
 * 出于 CVE-2024-27980 禁止无 shell 直接 spawn .cmd/.bat（EINVAL）。因此解析
 * npm cmd-shim 里的真实 JS 入口，改用当前 node 可执行文件直连拉起——参数数组
 * 保持不变，多行 prompt 不会被 shell 二次解析。
 *
 * @param {string} [binPath=DSH_BIN]
 * @returns {{ cmd: string, prefixArgs: string[] }} spawn(cmd, [...prefixArgs, ...args])
 */
export function resolveDshSpawnSpec(binPath = DSH_BIN) {
  if (process.platform !== "win32") return { cmd: binPath, prefixArgs: [] };
  // 1) 显式 .cmd/.bat 垫片路径（含 DSH_BIN 直接指向垫片的情况）
  if (/\.(cmd|bat)$/i.test(binPath)) {
    const entry = parseCmdShimEntry(binPath);
    if (entry) return { cmd: process.execPath, prefixArgs: [entry] };
    return { cmd: binPath, prefixArgs: [] };
  }
  // 2) 裸名 / 无扩展名（sh 垫片无法被 CreateProcess 执行）：在 PATH 或同目录找 .cmd
  if (!/\.(exe|node)$/i.test(binPath)) {
    const shim = findCmdShimOnPath(binPath);
    if (shim) {
      const entry = parseCmdShimEntry(shim);
      if (entry) return { cmd: process.execPath, prefixArgs: [entry] };
    }
  }
  return { cmd: binPath, prefixArgs: [] };
}

/** 在 PATH（绝对路径则在其同目录）上找 <name>.cmd 垫片。 */
function findCmdShimOnPath(name) {
  const base = `${name.replace(/\.(cmd|bat|exe)$/i, "")}.cmd`;
  const dirs = isAbsolute(name) ? [dirname(name)] : (process.env.PATH ?? "").split(";");
  for (const dir of dirs) {
    if (!dir) continue;
    const p = join(dir.trim(), base);
    try { accessSync(p, fsConstants.X_OK); return p; } catch { /* next */ }
  }
  return null;
}

/** 解析 npm cmd-shim 中被引号包住的 JS 入口路径（%dp0% / %~dp0 → 垫片目录）。 */
function parseCmdShimEntry(cmdFile) {
  try {
    const text = readFileSync(cmdFile, "utf8");
    // 典型形态：endLocal & ... & "%_prog%"  "%dp0%\node_modules\...\lib\bin.js" %*
    const m = text.match(/"([^"]+\.js)"/);
    if (!m) return null;
    const shimDir = dirname(cmdFile);
    return m[1].replace(/%dp0%/gi, shimDir).replace(/%~dp0/gi, shimDir);
  } catch { return null; }
}

/** 读取 dsh 版本（不阻塞）。 */
export function getDshVersion() {
  try {
    const spec = resolveDshSpawnSpec();
    const r = spawnSync(spec.cmd, [...spec.prefixArgs, "--version"], { encoding: "utf8", timeout: 8000 });
    if (r.status === 0 && r.stdout) return r.stdout.trim().split("\n")[0];
    return r.stderr?.trim() || null;
  } catch { return null; }
}

/**
 * 从 dsh 运行错误消息解析「缺凭据」问题，返回修复指引。
 * 兼容 dsh 0.1.1-rc.2 与 0.1.2-alpha 的 MISSING_CREDENTIAL 报错格式：
 *   dsh: MISSING_CREDENTIAL: llm-deepseek: no API key for provider route "deepseek-official"
 *   → 缺 DEEPSEEK_API_KEY
 *   baseURL <LOCAL_GATEWAY_BASE_URL> ... (deepseeklocal provider → DEEPSEEKLOCAL_API_KEY)
 */
export function parseCredentialIssue(errMsg) {
  if (!errMsg || typeof errMsg !== "string") return null;
  const m = String(errMsg);
  // 统一匹配：provider route "X" → 需要对应 API key
  const route = m.match(/(?:provider route|provider)\s*["']?([A-Za-z0-9_-]+)["']?/);
  const keyEnv = m.match(/store\s+([A-Z0-9_]+)/i);
  const noApiKey = /MISSING_CREDENTIAL|no api key/i.test(m);

  if (!noApiKey) return null;

  const provider = route?.[1] || "unknown";
  // 已知 provider → key env 名映射（通用、非 dsh 版本特有）
  const ENV_BY_PROVIDER = {
    "deepseek-official": "DEEPSEEK_API_KEY",
    deepseeklocal: "DEEPSEEKLOCAL_API_KEY",
    "jl-token": "JL_TOKEN_API_KEY",
    minimax: "MINIMAX_API_KEY",
    "minimax-cn": "MINIMAX_CN_API_KEY",
  };
  const envName = keyEnv?.[1] || ENV_BY_PROVIDER[provider] || `${provider.toUpperCase().replace(/-/g, "_")}_API_KEY`;
  return {
    kind: "missing-credential",
    severity: "high",
    provider, envName,
    hint: `dsh 需要 provider「${provider}」的 API Key（环境变量 ${envName}）。`,
    fix: [
      `# 一次性（当前 shell/会话）`,
      `export ${envName}=YOUR_${envName}`,
      `# 永久（写入 shell 配置 ~/.zshrc 后 source）`,
      `echo 'export ${envName}=YOUR_${envName}' >> ~/.zshrc`,
    ],
  };
}

/** 体检：返回问题清单（无问题 = 空数组）。 */
export function diagnoseDsh() {
  const issues = [];

  // 1) dsh 二进制
  const resolved = DSH_BIN;
  const isBare = resolved === "dsh";
  if (isBare) {
    // 只有裸名时才真的检查 PATH
    const hasDsh = (() => { try { const r = spawnSync("dsh", ["--version"], { timeout: 5000 }); return r.status === 0; } catch { return false; } })();
    if (!hasDsh) issues.push({
      kind: "no-dsh-binary",
      severity: "high",
      hint: "未找到可执行的 dsh 二进制（当前检测值 " + resolved + "）。",
      fix: [
        "# 安装 dsh（若已装，请确认它在 PATH 或设置 DSH_BIN）",
        "npm install -g @deepseek-ai/dsh",
        "# 或显式指定",
        "export DSH_BIN=/path/to/dsh",
      ],
    });
  }

  // 2) dsh 版本（提示用，不强制）
  const ver = getDshVersion();
  if (ver && /0\.1\.2-alpha/.test(ver)) {
    issues.push({
      kind: "alpha-version",
      severity: "info",
      hint: `当前 dsh 为 ${ver}（alpha）。若 Obsidian 连接异常，优先检查 headless profile 的模型凭据。`,
      fix: ["# 查看 headless 默认模型", `DSH_HOME=${process.env.DSH_HOME || "~/.dsh"} dsh --profile headless --dump-config | grep -A5 agent-default-model`],
    });
  }

  // 3) headless profile 五层检测 — 详见 diagnoseHeadlessProfile()
  //    仅在 DSH_PROFILE 未覆盖 / 或当前 profile 是 headless 时跑（避免误报 web profile）
  const profile = process.env.DSH_PROFILE ?? "headless";
  if (profile === "headless") {
    issues.push(...diagnoseHeadlessProfile());
  }

  return issues;
}

/**
 * Headless profile 五层根因体检。
 *
 * 为什么需要这一层（2026-09-28 教训）：
 *   dsh-acp.mjs 默认 spawn `dsh --profile headless`。若 headless profile 配置
 *   残缺，运行期会报 "NO_ADAPTER: no adapter registered for provider ..."，
 *   表现为 "Obsidian 工具调用无响应 / LLM 输出 XML 文本"。共五层常见根因：
 *
 *     层 1  cordis.patch.yml 默认 model 指向已失效 key 路径（deepseek-official/...）
 *     层 2  headless profile 缺 5 个核心 devDeps（dsh-llm/agent-loop/acp/base/headless）
 *     层 3  pnpm-workspace.yaml 缺 overrides + allowBuilds（next dist-tag 不解析）
 *     层 4  cordis.patch.yml plugin name 写错（dsh-settings-file 而非 dsh-llm-pi-ai）
 *     层 5  冗余 settings.yaml 与 cordis.patch.yml 双重定义 → 配置冲突
 *
 * 检测策略：每个文件用字符串模式匹配（不引入 YAML 解析依赖），失败时给出可复制修复命令。
 * 不做自动修复——配置改动属于一次性且需用户拍板，避免误改。
 */
export function diagnoseHeadlessProfile() {
  const issues = [];

  // 定位 headless profile 目录
  const dshHome = process.env.DSH_HOME || join(homedir(), ".dsh");
  const profileDir = process.env.DSH_ACP_PROFILE_DIR || join(dshHome, "profiles", "headless");
  const cordisYml = join(profileDir, "cordis.patch.yml");
  const pkgJson = join(profileDir, "package.json");
  const wsYaml = join(profileDir, "pnpm-workspace.yaml");
  const settingsYml = join(profileDir, "settings.yaml");

  if (!existsSync(profileDir)) {
    // headless profile 完全没装 — 让 dsh-acp 自动跑 install.sh 或用户手动
    issues.push({
      kind: "headless-profile-missing",
      severity: "high",
      hint: `未找到 headless profile 目录（${profileDir}）。`,
      fix: [
        "# 让 dsh-acp 触发安装（首次运行会自动 install + pnpm install）",
        "node dsh-acp.mjs",
        "# 或手动（首次）",
        "mkdir -p ~/.dsh/profiles && cd ~/.dsh/profiles && npm init -y && npm i @deepseek-ai/dsh-base @deepseek-ai/dsh-headless @deepseek-ai/dsh-llm @deepseek-ai/dsh-agent-loop @deepseek-ai/dsh-acp@0.1.7-rc.1",
      ],
    });
    return issues; // 没目录的话下面 4 项无意义
  }

  // ----- 层 1: cordis.patch.yml 默认 model -----
  if (existsSync(cordisYml)) {
    let cordis = "";
    try { cordis = readFileSync(cordisYml, "utf8"); } catch {}
    // 已知失效路径：deepseek-official/*（用户报告 key 0700 invalid）
    if (/provider:\s*deepseek-official/.test(cordis) || /model:\s*deepseek-v4-flash\b/.test(cordis)) {
      issues.push({
        kind: "headless-default-model-broken",
        severity: "high",
        hint: `cordis.patch.yml 默认 model 指向 deepseek-official（已知 key 失效，0700 invalid）。`,
        file: cordisYml,
        fix: [
          "# 编辑 " + cordisYml,
          "# 替换 agent-default-model 段：provider 改为 jl-token，model 改为 gemini-2.5-pro",
          `# 路径示意:`,
          `- id: agent-default-model`,
          `  name: '@deepseek-ai/dsh-agent-default-model'`,
          `  config:`,
          `    provider: jl-token`,
          `    model: gemini-2.5-pro`,
          ``,
          "# 配 llm-pi-ai 段（若尚未配置）：",
          `# 参考 ~/.dsh/profiles/web/cordis.patch.yml 的 llm-pi-ai 段复制。`,
        ],
      });
    }
  } else {
    issues.push({
      kind: "headless-cordis-patch-missing",
      severity: "high",
      hint: `headless profile 缺 cordis.patch.yml（${cordisYml}）。`,
      file: cordisYml,
      fix: [
        "# 从 web profile 复制参考配置",
        "cp ~/.dsh/profiles/web/cordis.patch.yml " + cordisYml,
        "# 或参考 docs/README.md 的 'Headless profile setup' 段手写",
      ],
    });
  }

  // ----- 层 2: package.json 缺核心 devDeps -----
  if (existsSync(pkgJson)) {
    let pkg = null;
    try { pkg = JSON.parse(readFileSync(pkgJson, "utf8")); } catch {}
    const deps = { ...(pkg?.devDependencies ?? {}), ...(pkg?.dependencies ?? {}) };
    const required = [
      "@deepseek-ai/dsh-llm",
      "@deepseek-ai/dsh-agent-loop",
      "@deepseek-ai/dsh-acp",
      "@deepseek-ai/dsh-base",
      "@deepseek-ai/dsh-headless",
    ];
    const missing = required.filter((n) => !deps[n]);
    if (missing.length) {
      issues.push({
        kind: "headless-missing-deps",
        severity: "high",
        hint: `headless profile 缺 ${missing.length} 个核心 devDeps：${missing.join("、")}。`,
        file: pkgJson,
        fix: [
          "# 进 headless profile 目录",
          `cd ${profileDir}`,
          "# 装齐 5 个核心包（pin 到当前 dsh 版本，避免 next dist-tag 解析失败）",
          `pnpm add -D ${required.join("@0.1.7-rc.1 ")}@0.1.7-rc.1`,
          "# 不锁版本也可，但 pnpm 解析 0.1.7-rc.1 时仍需要 overrides 段（见下一项）",
        ],
      });
    }
  } else {
    issues.push({
      kind: "headless-package-json-missing",
      severity: "high",
      hint: `headless profile 缺 package.json（${pkgJson}）。`,
      file: pkgJson,
      fix: [
        `cd ${profileDir}`,
        "npm init -y",
        `pnpm add -D @deepseek-ai/dsh-base @deepseek-ai/dsh-headless @deepseek-ai/dsh-llm @deepseek-ai/dsh-agent-loop @deepseek-ai/dsh-acp@0.1.7-rc.1`,
      ],
    });
  }

  // ----- 层 3: pnpm-workspace.yaml 缺 overrides + allowBuilds -----
  if (existsSync(wsYaml)) {
    let ws = "";
    try { ws = readFileSync(wsYaml, "utf8"); } catch {}
    const hasOverrides = /^overrides:/m.test(ws);
    const hasAllowBuilds = /^allowBuilds:/m.test(ws);
    if (!hasOverrides || !hasAllowBuilds) {
      issues.push({
        kind: "headless-workspace-yaml-incomplete",
        severity: "high",
        hint: `pnpm-workspace.yaml 缺 ${!hasOverrides ? "overrides" : ""}${!hasOverrides && !hasAllowBuilds ? " + " : ""}${!hasAllowBuilds ? "allowBuilds" : ""} 段。`,
        file: wsYaml,
        fix: [
          "# 从 web profile 复制（已配齐 22 overrides + 5 allowBuilds）",
          `cp ~/.dsh/profiles/web/pnpm-workspace.yaml ${wsYaml}`,
          "# 然后保留 headless 自己的 packages/ 段，叠加 web 的 overrides + allowBuilds",
          "# 关键 allowBuilds: dsh-subprocess-local, @google/genai, koffi, node-pty, protobufjs",
        ],
      });
    }
  } else {
    issues.push({
      kind: "headless-workspace-yaml-missing",
      severity: "high",
      hint: `headless profile 缺 pnpm-workspace.yaml（${wsYaml}）。`,
      file: wsYaml,
      fix: [
        "# 关键段：packages: ['.'], nodeLinker: hoisted, autoInstallPeers: false",
        "# + 22 个 @deepseek-ai/dsh-* overrides (pin 到 0.1.7-rc.1)",
        "# + 5 个 allowBuilds (dsh-subprocess-local, @google/genai, koffi, node-pty, protobufjs)",
        "# 参考 ~/.dsh/profiles/web/pnpm-workspace.yaml 全文复制",
      ],
    });
  }

  // ----- 层 4: cordis.patch.yml plugin name 错 -----
  if (existsSync(cordisYml)) {
    let cordis = "";
    try { cordis = readFileSync(cordisYml, "utf8"); } catch {}
    // 已知错名：@deepseek-ai/dsh-settings-file（已废弃，应直接挂 llm-pi-ai）
    if (/@deepseek-ai\/dsh-settings-file/.test(cordis)) {
      issues.push({
        kind: "headless-cordis-plugin-name-wrong",
        severity: "high",
        hint: `cordis.patch.yml plugin name 写错：使用 @deepseek-ai/dsh-settings-file（应 @deepseek-ai/dsh-llm-pi-ai）。`,
        file: cordisYml,
        fix: [
          "# 编辑 " + cordisYml,
          "# 删 settings 段（- id: settings / name: @deepseek-ai/dsh-settings-file）",
          "# 改为 llm-pi-ai 段（id + name + providers.jl-token.apiKeyEnv/api/baseURL/models）",
          "# 完整模板参考 ~/.dsh/profiles/web/cordis.patch.yml llm-pi-ai 段",
        ],
      });
    }
    // 另一个常见错：用 'settings' id 而非 'llm-pi-ai' id
    if (/^\s*-\s+id:\s*settings\b/m.test(cordis) && !/^\s*-\s+id:\s*llm-pi-ai\b/m.test(cordis)) {
      issues.push({
        kind: "headless-cordis-llm-pi-ai-missing",
        severity: "high",
        hint: `cordis.patch.yml 缺 llm-pi-ai 段（providers 不会注册 → NO_ADAPTER）。`,
        file: cordisYml,
        fix: [
          "# 加 llm-pi-ai 段（参考 web 的写法）",
          `- id: llm-pi-ai`,
          `  name: "@deepseek-ai/dsh-llm-pi-ai"`,
          `  config:`,
          `    providers:`,
          `      jl-token:`,
          `        displayName: jl-token`,
          `        apiKeyEnv: JL_TOKEN_API_KEY`,
          `        api: openai-completions`,
          `        baseURL: <YOUR_GATEWAY_BASE_URL>   # 例如 https://<your-gateway-host>/v1`,
          `        models:`,
          `          - id: gemini-2.5-pro`,
          `            name: gemini-2.5-pro`,
        ],
      });
    }
  }

  // ----- 层 5: 冗余 settings.yaml -----
  if (existsSync(settingsYml)) {
    issues.push({
      kind: "headless-redundant-settings-yaml",
      severity: "medium",
      hint: `settings.yaml 存在且与 cordis.patch.yml 双重定义 providers，配置会冲突。`,
      file: settingsYml,
      fix: [
        "# 删冗余文件（providers 已在 cordis.patch.yml llm-pi-ai 段配置）",
        `rm ${settingsYml}`,
        "# 备份到 .bak 留个引用",
        `mv ${settingsYml} ${settingsYml}.bak`,
      ],
    });
  }

  return issues;
}

/** 把问题清单格式化为可在 ACP 回复里展示的文本（含可复制修复命令）。 */
export function formatDiagnosis(issues, { pluginUpdateHint = "" } = {}) {
  if (!issues || issues.length === 0) return "";
  const lines = ["", "", "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━", "🩺 obsidian-dsh-acp 健康诊断（可修复）", "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"];
  for (const it of issues) {
    lines.push("");
    lines.push(`• [${it.severity}] ${it.hint}`);
    if (it.fix && it.fix.length) {
      lines.push("  要修复，可运行以下命令：");
      for (const c of it.fix) lines.push("  ```bash\n  " + c + "\n  ```");
    }
  }
  if (pluginUpdateHint) lines.push("", `• 插件更新：${pluginUpdateHint}`);
  lines.push("", "自动修复：如需我自动执行以上某一步，回复「修复 <序号>」；或终端运行 `dsh-acp doctor --auto`（每步会先说明将执行的操作并请你确认）。");
  return lines.join("\n");
}

// ---- R2: Obsidian 侧依赖检查（8 项）---------------------------------------
// 依据：docs/开发计划/0.3.3-整合开发计划.md §阶段 2（R2）。
// 设计要点：
//   * 只读 —— 不做任何写操作（R3 的“一键修复”是后续阶段，本轮只诊断）。
//   * 永不抛 —— 任何文件/路径问题都折成 {status:"fail"|"skip", detail}。
//   * 可测 —— 所有外部事实（家目录 / platform / 路径 / node 版本 / dsh 版本 /
//     spawn spec）都可由 opts 注入，故 mock 单测无需碰真实机器状态。

/** 解析 `a.b.c[-pre]` 为可比较结构；无法解析返回 null。 */
function parseSemver(v) {
  if (typeof v !== "string") return null;
  const m = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/.exec(v.trim());
  if (!m) return null;
  return { major: +m[1], minor: +m[2], patch: +m[3], pre: m[4] ? m[4].split(".") : null };
}

/** semver 预发布段比较：无 pre > 有 pre；numeric < alphanumeric；逐段比较。 */
function cmpPre(a, b) {
  if (!a && !b) return 0;
  if (!a) return 1;   // 正式版 > 预发布版
  if (!b) return -1;
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const x = a[i], y = b[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const xn = /^\d+$/.test(x), yn = /^\d+$/.test(y);
    if (xn && yn) { if (+x !== +y) return +x < +y ? -1 : 1; }
    else if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

/** 比较两个 semver 字符串：-1 / 0 / 1；无法解析返回 null。 */
export function compareSemver(a, b) {
  const x = parseSemver(a), y = parseSemver(b);
  if (!x || !y) return null;
  for (const k of ["major", "minor", "patch"]) {
    if (x[k] !== y[k]) return x[k] < y[k] ? -1 : 1;
  }
  return cmpPre(x.pre, y.pre);
}

/**
 * 判断 version 是否满足形如 `>=0.1.6-alpha.1 <0.3.0` 的空格分隔区间。
 * 支持 `>=` / `>` / `<=` / `<` / `=`；无比较符视为 `=`。
 * @returns {boolean|null} null = 无法判定（版本或区间不可解析）
 */
export function satisfiesRange(version, range) {
  if (compareSemver(version, "0.0.0") === null) return null;
  for (const part of String(range).trim().split(/\s+/).filter(Boolean)) {
    const m = /^(>=|<=|>|<|=)?(.+)$/.exec(part);
    if (!m) return null;
    const op = m[1] || "=";
    const c = compareSemver(version, m[2]);
    if (c === null) return null;
    if (op === ">=" && !(c >= 0)) return false;
    if (op === ">" && !(c > 0)) return false;
    if (op === "<=" && !(c <= 0)) return false;
    if (op === "<" && !(c < 0)) return false;
    if (op === "=" && c !== 0) return false;
  }
  return true;
}

/** Obsidian 的 obsidian.json 默认位置（macOS / Windows / Linux）。 */
export function defaultObsidianJsonPath(platform = process.platform, home = homedir()) {
  if (platform === "darwin") return join(home, "Library", "Application Support", "obsidian", "obsidian.json");
  if (platform === "win32") {
    const appData = process.env.APPDATA || join(home, "AppData", "Roaming");
    return join(appData, "obsidian", "obsidian.json");
  }
  return join(home, ".config", "obsidian", "obsidian.json");
}

/** 本插件声明的 dsh-acp peer 区间（与 package.json 保持一致）。 */
export const DSH_ACP_PEER_RANGE = ">=0.1.6-alpha.1 <0.3.0";
/** 本插件要求的最低 Node 版本（engines.node）。 */
export const MIN_NODE_VERSION = "22.13.0";

function readJsonSafe(file) {
  try { return JSON.parse(readFileSync(file, "utf8")); } catch { return null; }
}

/**
 * R2：8 项 Obsidian 侧依赖检查。
 * @param {object} [opts] 全部可注入以便单测（默认取真实机器事实）
 * @param {string} [opts.obsidianJsonPath]
 * @param {string} [opts.dshHome]
 * @param {string} [opts.profileName]
 * @param {string} [opts.nodeVersion]   形如 "v22.13.0"
 * @param {string} [opts.dshAcpVersion] profile 内 @deepseek-ai/dsh-acp 版本
 * @param {object} [opts.spawnSpec]     resolveDshSpawnSpec() 的结果
 * @returns {{checks:Array<{id:string,status:string,detail:string,fixHint:string}>, summary:string, ok:boolean}}
 */
export function diagnoseObsidianDeps(opts = {}) {
  const home = str(opts.home) ?? homedir();
  const platform = str(opts.platform) ?? process.platform;
  const dshHome = str(opts.dshHome) ?? str(process.env.DSH_HOME) ?? join(home, ".dsh");
  const profileName = str(opts.profileName) ?? "web";
  const obsidianJson = str(opts.obsidianJsonPath) ?? defaultObsidianJsonPath(platform, home);
  const checks = [];
  const add = (id, status, detail, fixHint = "") => checks.push({ id, status, detail, fixHint });

  // ① Obsidian 是否安装
  let vaults = null;
  if (!existsSyncSafe(obsidianJson)) {
    add("obsidian-installed", "skip",
      `未找到 ${obsidianJson}（未安装 Obsidian，或使用非默认数据目录）`,
      "安装 Obsidian，或设置 DSH_ACP_OBSIDIAN_JSON 指向 obsidian.json");
  } else {
    const cfg = readJsonSafe(obsidianJson);
    if (!cfg || typeof cfg !== "object") {
      add("obsidian-installed", "fail", `${obsidianJson} 存在但 JSON 解析失败`, "检查该文件是否为合法 JSON");
    } else {
      add("obsidian-installed", "ok", `找到 ${obsidianJson}`, "");
      vaults = Array.isArray(cfg.vaults) ? Object.values(cfg.vaults) : Object.values(cfg.vaults || {});
    }
  }

  // ② vault 路径
  let vaultPath = null;
  if (vaults === null) {
    add("obsidian-vault", "skip", "上一步未取得 obsidian.json，无法解析 vault", "");
  } else if (!vaults.length) {
    add("obsidian-vault", "fail", "obsidian.json 中 vaults 为空（未打开过任何仓库）", "先用 Obsidian 打开一个 vault");
  } else {
    const usable = vaults.map((v) => v && v.path).filter((p) => typeof p === "string" && p);
    const existing = usable.filter((p) => existsSyncSafe(p));
    vaultPath = existing[0] ?? usable[0] ?? null;
    if (!vaultPath) {
      add("obsidian-vault", "fail", `vaults 有 ${vaults.length} 项但均无可用 path`, "检查 obsidian.json 的 vaults[].path");
    } else if (!existing.length) {
      add("obsidian-vault", "fail", `解析到 ${usable.length} 个 vault 路径但本地均不存在（首项 ${vaultPath}）`,
        "确认 vault 目录未被移动/删除");
    } else {
      add("obsidian-vault", "ok", `共 ${usable.length} 个 vault，首个可用：${vaultPath}`, "");
    }
  }

  // ③ Agent Client 插件
  let acDir = null;
  if (!vaultPath) {
    add("agent-client-plugin", "skip", "无可用 vault 路径，无法检查 Agent Client 插件", "");
  } else {
    acDir = join(vaultPath, ".obsidian", "plugins", "agent-client");
    const manifest = join(acDir, "manifest.json");
    if (!existsSyncSafe(acDir)) {
      add("agent-client-plugin", "fail", `未安装：${acDir} 不存在`, "在 Obsidian 中安装 Agent Client 插件（或 BRAT 安装）");
    } else if (!existsSyncSafe(manifest)) {
      add("agent-client-plugin", "fail", `${acDir} 存在但缺 manifest.json（安装不完整）`, "重装 Agent Client 插件");
    } else {
      const mf = readJsonSafe(manifest);
      add("agent-client-plugin", "ok", `已安装${mf?.version ? ` v${mf.version}` : ""}：${acDir}`, "");
    }
  }

  // ④ customAgents 里是否配置了 dsh-acp
  if (!acDir) {
    add("custom-agent-config", "skip", "无 Agent Client 插件目录，无法检查 customAgents", "");
  } else {
    const dataFile = join(acDir, "data.json");
    if (!existsSyncSafe(dataFile)) {
      add("custom-agent-config", "fail", `未找到 ${dataFile}`, "在 Agent Client 设置中添加自定义 agent（id: dsh-acp）");
    } else {
      const data = readJsonSafe(dataFile);
      if (!data || typeof data !== "object") {
        add("custom-agent-config", "fail", `${dataFile} 存在但 JSON 解析失败`, "检查 data.json（先备份再修）");
      } else {
        const list = Array.isArray(data.customAgents) ? data.customAgents : [];
        const entry = list.find((a) => a && a.id === "dsh-acp");
        if (!entry) {
          add("custom-agent-config", "fail",
            `customAgents 中无 id="dsh-acp"（现有 ${list.length} 项：${list.map((a) => a?.id).filter(Boolean).join(", ") || "无"})`,
            "在 Agent Client 设置中新增自定义 agent，id=dsh-acp");
        } else if (entry.enabled === false) {
          add("custom-agent-config", "fail", `dsh-acp 条目存在但 enabled=false`, "在 Agent Client 设置中启用该 agent");
        } else if (!entry.command) {
          add("custom-agent-config", "fail", `dsh-acp 条目缺 command`, "为该 agent 设置 command（指向 dsh-acp.mjs）");
        } else {
          // nodePath 是 Agent Client 的全局 node 解释器设置（data.json 顶层）。
          // 它是常见的“装了但起不来”根因（指向不存在的 node），故一并核验。
          const nodePath = data.nodePath;
          if (nodePath !== undefined && (typeof nodePath !== "string" || !existsSyncSafe(nodePath))) {
            add("custom-agent-config", "fail",
              `dsh-acp 条目已配置，但 data.json 的 nodePath 无效：${JSON.stringify(nodePath)}（该文件不存在）`,
              "在 Agent Client 设置中修正 node 解释器路径（或清空以用系统 node）");
          } else {
            add("custom-agent-config", "ok",
              `已配置：command=${entry.command}${nodePath ? `，nodePath=${nodePath}` : "，nodePath 未设置（用系统 node）"}`,
              "");
          }
        }
      }
    }
  }

  // ⑤ dsh profile 内是否装了本插件
  const profilePlugin = join(dshHome, "profiles", profileName, "node_modules", "obsidian-dsh-acp");
  if (!existsSyncSafe(join(dshHome, "profiles", profileName))) {
    add("dsh-profile-plugin", "skip", `profile 目录不存在：${join(dshHome, "profiles", profileName)}`, "");
  } else if (!existsSyncSafe(profilePlugin)) {
    add("dsh-profile-plugin", "fail", `${profileName} profile 未安装本插件（${profilePlugin} 不存在）`,
      `dsh plugin --profile ${profileName} add obsidian-dsh-acp`);
  } else {
    add("dsh-profile-plugin", "ok", `已安装于 ${profileName} profile`, "");
  }

  // ⑥ dsh-acp peer 区间
  // 解析 @deepseek-ai/dsh-acp 的实装版本。多布局回退（实测必要）：
  //   a) 嵌套副本（npm/hoisted 布局，见 t6：desktop 曾实体化 24 个旧包）
  //   b) profile 顶层 hoist（pnpm 有时提升）
  //   c) profile 内 .pnpm store（pnpm 隔离布局 —— 本机 web profile 即此形态，
  //      插件是 symlink 指向 .pnpm/<plugin>/node_modules，故 a/b 均落空）
  //   d) 全局 CLI 自带树（宿主基线，t1 实测 0.2.1-alpha.1）
  const dshAcpVersion = str(opts.dshAcpVersion) ?? (() => {
    try {
    const candidates = [
      join(profilePlugin, "node_modules", "@deepseek-ai", "dsh-acp", "package.json"),
      join(dshHome, "profiles", profileName, "node_modules", "@deepseek-ai", "dsh-acp", "package.json"),
      join(home, ".npm-global", "lib", "node_modules", "@deepseek-ai", "dsh", "node_modules", "@deepseek-ai", "dsh-acp", "package.json"),
    ];
    for (const c of candidates) {
      const v = readJsonSafe(c)?.version;
      if (v) return v;
    }
    // c) .pnpm store：目录名形如 @deepseek-ai+dsh-acp@<ver>_<hash>
    try {
      const store = join(dshHome, "profiles", profileName, "node_modules", ".pnpm");
      for (const d of readdirSync(store)) {
        const m = /^@deepseek-ai\+dsh-acp@([^_]+)_/.exec(d);
        if (m) {
          const v = readJsonSafe(join(store, d, "node_modules", "@deepseek-ai", "dsh-acp", "package.json"))?.version;
          if (v) return v;
          return m[1];
        }
      }
    } catch { /* store 不存在或无匹配 */ }
    return null;
    } catch { return null; }   // 任何解析异常都降级为 skip，绝不外抛
  })();
  if (!dshAcpVersion) {
    add("dsh-peer-version", "skip",
      `未能读取 @deepseek-ai/dsh-acp 版本（${profileName} profile 内不可解析）`,
      `确认宿主已提供该 peer：dsh plugin --profile ${profileName} add obsidian-dsh-acp`);
  } else {
    const ok = satisfiesRange(dshAcpVersion, DSH_ACP_PEER_RANGE);
    if (ok === null) {
      add("dsh-peer-version", "fail", `版本字符串无法解析：${dshAcpVersion}`, "检查该包 package.json 的 version");
    } else if (!ok) {
      add("dsh-peer-version", "fail",
        `@deepseek-ai/dsh-acp@${dshAcpVersion} 不满足 peer ${DSH_ACP_PEER_RANGE}`,
        "升级/降级宿主 dsh，使该 peer 落在区间内");
    } else {
      add("dsh-peer-version", "ok", `@deepseek-ai/dsh-acp@${dshAcpVersion} 满足 ${DSH_ACP_PEER_RANGE}`, "");
    }
  }

  // ⑦ Node 版本
  const nodeVersion = opts.nodeVersion ?? process.version;
  const nodeOk = satisfiesRange(String(nodeVersion).replace(/^v/, ""), `>=${MIN_NODE_VERSION}`);
  if (nodeOk === null) {
    add("node-version", "fail", `无法解析 Node 版本：${nodeVersion}`, `升级 Node 到 >= ${MIN_NODE_VERSION}`);
  } else if (!nodeOk) {
    add("node-version", "fail", `Node ${nodeVersion} 低于要求 >= v${MIN_NODE_VERSION}`,
      `升级 Node 到 >= v${MIN_NODE_VERSION}（当前所用 node 路径见 \`which node\`）`);
  } else {
    add("node-version", "ok", `Node ${nodeVersion} >= v${MIN_NODE_VERSION}`, "");
  }

  // ⑧ dsh spawn spec 可解析
  const spec = opts.spawnSpec !== undefined ? opts.spawnSpec : (() => {
    try { return resolveDshSpawnSpec(); } catch { return null; }
  })();
  if (spec === null || spec === undefined || typeof spec !== "object") {
    add("dsh-spawn-spec", "fail", "resolveDshSpawnSpec() 返回空（dsh 不可解析）",
      "安装 dsh 或设置 DSH_BIN 指向可执行文件");
  } else if (!spec.cmd || typeof spec.cmd !== "string") {
    add("dsh-spawn-spec", "fail", `spawn spec 缺 cmd：${JSON.stringify(spec)}`, "设置 DSH_BIN 指向 dsh 可执行文件");
  } else {
    add("dsh-spawn-spec", "ok",
      `cmd=${spec.cmd}${Array.isArray(spec.prefixArgs) && spec.prefixArgs.length ? ` prefixArgs=${JSON.stringify(spec.prefixArgs)}` : ""}`,
      "");
  }

  const ok = checks.filter((c) => c.status === "ok").length;
  const fail = checks.filter((c) => c.status === "fail").length;
  const skip = checks.filter((c) => c.status === "skip").length;
  return {
    checks,
    summary: `${ok} ok / ${fail} fail / ${skip} skip`,
    ok: fail === 0,
    // 供 R3 修复直接使用（避免从 detail 文本里正则抠路径——那在「失败态」下会抠错）
    paths: {
      obsidianJson,
      vaultPath: vaultPath ?? null,
      agentClientDir: acDir ?? null,
      dataFile: acDir ? join(acDir, "data.json") : null,
      profileDir: join(dshHome, "profiles", profileName),
      profilePlugin,
    },
  };
}

/** 归一化：非空字符串才采用，否则回退默认。opts/env 取值处统一走它，防 join() 抛非字符串。 */
const str = (v) => (typeof v === "string" && v.length > 0 ? v : null);

/** 供测试/内部使用：避免顶层引入额外依赖。 */
function existsSyncSafe(p) {
  try { return existsSync(p); } catch { return false; }
}

/** R2 人类可读摘要。 */
export function formatObsidianDeps(result) {
  const lines = ["", "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━", "🔎 Obsidian 侧依赖检查（R2，只读）", "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"];
  const icon = { ok: "✅", fail: "❌", skip: "⏭️ " };
  for (const c of result.checks) {
    lines.push(`${icon[c.status] ?? "•"} [${c.id}] ${c.detail}`);
    if (c.status !== "ok" && c.fixHint) lines.push(`      → ${c.fixHint}`);
  }
  lines.push("", `合计：${result.summary}`);
  return lines.join("\n");
}

// ---- R3: 一键修复（阶段 3，受限授权）--------------------------------------
// 依据：docs/开发计划/0.3.3-整合开发计划.md §阶段 3。
//
// 授权分级（规格原文）：
//   user-authorized —— 写 data.json / 跑 dsh plugin add（须由用户显式发起）
//   manual          —— 其余一律只提示，绝不代改
//
// 红线（t11 用户确认，本实现以结构强制而非仅靠注释）：
//   ① 不自动杀 Obsidian —— 本模块不 import child_process 的 kill/exec，亦无任何进程终止路径
//   ② 不改 defaultAgentId —— 合并写入时逐键拷贝白名单，defaultAgentId 永不被纳入
//   ③ 不整文件覆盖 data.json —— 只做「读 → 浅合并 → 写」，且写前必备份
//   ④ 写后必须提示重载，不得声称热生效 —— applyObsidianFix 的返回值固定含 reloadHint

/** 授权分级常量。 */
export const FIX_AUTHORIZATION = Object.freeze({
  USER_AUTHORIZED: "user-authorized",
  MANUAL: "manual",
});

/**
 * 逐检查项的修复计划表（纯数据，便于审计）。
 * 只有本表显式标注的项才可能被 `--apply` 执行；未列出的一律 manual。
 */
const FIX_PLAN = Object.freeze({
  "custom-agent-config": {
    action: "write-custom-agent",
    authorization: FIX_AUTHORIZATION.USER_AUTHORIZED,
    summary: "在 agent-client 的 data.json 中合并写入 customAgents[dsh-acp] 条目（保留其它所有键）",
  },
  "dsh-profile-plugin": {
    action: "dsh-plugin-add",
    authorization: FIX_AUTHORIZATION.USER_AUTHORIZED,
    summary: "在 dsh profile 中注册本插件（需执行 dsh plugin add）",
    warning: "⚠️ 该命令会驱动 pnpm install，而 pnpm install 会抹掉 Symbol 补丁（dsh-tools/dsh-scope 的 Symbol.for）→ 可能复发 reading 'prepare'。请先落地 E1（profile 侧 pnpm patch 持久化）。",
  },
});

/**
 * 把诊断结果映射为修复计划（纯函数，无副作用）。
 * 语义：**所有非 ok 项都进计划**（fail + skip），因为规格规定「其他 → 仅提示（manual）」；
 * skip 代表「无法判定」，同样需要提示用户去确认，只是绝不可自动执行。
 * 只有 FIX_PLAN 中显式登记的 user-authorized 项 executable=true。
 * @param {{checks:Array}} result diagnoseObsidianDeps() 的返回值
 * @returns {Array<{item:string,status:string,action:string,authorization:string,summary:string,fixHint:string,warning?:string,executable:boolean}>}
 */
export function planObsidianFixes(result) {
  const plans = [];
  for (const c of (result?.checks ?? [])) {
    if (c.status === "ok") continue;
    const p = FIX_PLAN[c.id];
    plans.push({
      item: c.id,
      status: c.status,
      action: p?.action ?? "manual",
      authorization: p?.authorization ?? FIX_AUTHORIZATION.MANUAL,
      summary: p?.summary ?? (c.fixHint || "无自动修复动作，按提示手工处理"),
      fixHint: c.fixHint ?? "",
      ...(p?.warning ? { warning: p.warning } : {}),
      executable: Boolean(p) && p.authorization === FIX_AUTHORIZATION.USER_AUTHORIZED,
    });
  }
  return plans;
}

/**
 * 执行单个修复项。**只支持 user-authorized 且已列入 FIX_PLAN 的项**；
 * 其余一律拒绝执行（返回 refused），从而让「manual 不可自动修」成为结构性保证。
 *
 * 所有外部副作用均可注入，便于零依赖单测：
 * @param {string} item
 * @param {object} [opts]
 * @param {string} [opts.dataFile]   data.json 路径（write-custom-agent 用）
 * @param {boolean} [opts.apply]     false（默认）= 只出计划不落盘
 * @param {string} [opts.backupSuffix] 备份后缀，默认时间戳
 * @param {(file:string,data:object)=>void} [opts.writeFile] 注入写实现（测试用）
 * @returns {{item:string,applied:boolean,refused?:boolean,reason?:string,backupPath?:string,reloadHint?:string,command?:string,warning?:string}}
 */
export function applyObsidianFix(item, opts = {}) {
  const plan = FIX_PLAN[item];
  if (!plan) {
    return { item, applied: false, refused: true, reason: `未知修复项或该项为 manual（仅提示）：${item}` };
  }
  if (plan.authorization !== FIX_AUTHORIZATION.USER_AUTHORIZED) {
    return { item, applied: false, refused: true, reason: `该项授权级别为 ${plan.authorization}，不允许自动修复` };
  }

  // —— 写 data.json 类：读 → 浅合并 → 备份 → 写 ——
  if (plan.action === "write-custom-agent") {
    const dataFile = str(opts.dataFile);
    if (!dataFile) return { item, applied: false, refused: true, reason: "缺少 dataFile 路径" };
    if (!opts.apply) {
      return { item, applied: false, reason: "未加 --apply：这是计划预览，未写入任何文件", reloadHint: reloadHint() };
    }
    const current = readJsonSafe(dataFile);
    if (!current || typeof current !== "object") {
      return { item, applied: false, refused: true, reason: `无法读取或解析 ${dataFile}（先备份再手工修）` };
    }
    // ③ 不整文件覆盖：只改 customAgents 一个键，其余键逐键原样保留
    const list = Array.isArray(current.customAgents) ? current.customAgents.slice() : [];
    const idx = list.findIndex((a) => a && a.id === "dsh-acp");
    const entry = { id: "dsh-acp", displayName: "DeepSeek Harness (ACP)", command: opts.command ?? "", args: [], env: [], enabled: true };
    if (idx >= 0) list[idx] = { ...list[idx], ...entry, ...(opts.command ? {} : { command: list[idx].command }) };
    else list.push(entry);
    const next = { ...current, customAgents: list };
    // ② 结构断言：defaultAgentId 绝不改动
    if ("defaultAgentId" in current && next.defaultAgentId !== current.defaultAgentId) {
      return { item, applied: false, refused: true, reason: "内部不变量被破坏（defaultAgentId 被改动）→ 中止写入" };
    }
    const backupPath = `${dataFile}.bak-r3-${opts.backupSuffix ?? new Date().toISOString().replace(/[:.]/g, "-")}`;
    try {
      const write = opts.writeFile ?? ((f, d) => writeFileSync(f, JSON.stringify(d, null, 2)));
      writeFileSync(backupPath, JSON.stringify(current, null, 2));   // ④ 先备份
      write(dataFile, next);
    } catch (e) {
      return { item, applied: false, refused: true, reason: `写入失败：${(e && e.message) || e}` };
    }
    return { item, applied: true, backupPath, reloadHint: reloadHint() };
  }

  // —— dsh plugin add 类：默认只给命令；--apply 才提示需人工执行 ——
  if (plan.action === "dsh-plugin-add") {
    const profileName = str(opts.profileName) ?? "web";
    const command = `dsh plugin --profile ${profileName} add obsidian-dsh-acp`;
    // 有意不自动 spawn：该命令会触发 pnpm install（见 FIX_PLAN.warning）
    return { item, applied: false, command, reason: "需人工执行（会触发 pnpm install，见 warning）", warning: plan.warning, reloadHint: "执行后需重启 dsh web；若 Symbol 补丁被覆盖，请复跑 E1 的 pnpm patch" };
  }

  return { item, applied: false, refused: true, reason: "未实现的修复动作" };
}

/** 写后提示：Obsidian 不会热感知 data.json 变更（t11 实测 reload=0）。 */
function reloadHint() {
  return "⚠️ Obsidian 不会热感知 data.json 变更（实测 reload=0）→ 请重启 Obsidian（或禁用后重新启用 Agent Client 插件）后生效。**不是热生效**。";
}

/**
 * 取 agent-client 的 data.json 路径（供 `--fix custom-agent-config` 用）。
 * 直接读 diagnoseObsidianDeps().paths，**不从 detail 文本正则抠**——失败态下
 * detail 是「未安装：<path> 不存在」这类句子，抠出来会是错的路径。
 */
export function findAgentClientDataFile(result) {
  return result?.paths?.dataFile ?? null;
}

/** R3 修复计划的文本输出。 */
export function formatFixPlan(plans) {
  if (!plans.length) return "✅ 没有需要修复的项。";
  const lines = ["", "🔧 修复计划（默认只预览；加 --apply 才执行 user-authorized 项）", ""];
  for (const p of plans) {
    lines.push(`• [${p.authorization}] ${p.item} (${p.status})`);
    lines.push(`   动作：${p.action}`);
    lines.push(`   说明：${p.summary}`);
    if (p.warning) lines.push(`   ${p.warning}`);
    lines.push(`   可自动执行：${p.executable ? "是（需 --apply）" : "否（manual，仅提示）"}`);
  }
  return lines.join("\n");
}

// ---- CLI（doctor 子命令）--------------------------------------------------
export async function runDoctorCli(argv = process.argv.slice(3)) {
  const doAuto = argv.includes("--auto") || argv.includes("-a");
  console.log(`🩺 obsidian-dsh-acp doctor  (adapter v${ADAPTER_VERSION})`);
  console.log(`   dsh 二进制: ${DSH_BIN}`);
  const ver = getDshVersion();
  console.log(`   dsh 版本  : ${ver || "未知/不可用"}`);
  console.log("");

  const issues = diagnoseDsh();

  // —— Obsidian 会话 GC 检测（用户可据此决定纳入范围 / 清理孤儿） ——
  try {
    const gc = await import("./gc.mjs");
    const dirs = gc.detectObsidianSessionsDirs();
    if (dirs.length === 0) {
      console.log("📁 [GC] 未检测到 Obsidian agent-client sessions 目录。");
      console.log("     可设置 DSH_ACP_GC_OBSIDIAN_DIRS=<逗号分隔的 sessions 目录> 显式纳入后自动 GC。");
    } else {
      console.log(`📁 [GC] 检测到 ${dirs.length} 个 Obsidian sessions 目录（已被纳入 GC 对账）：`);
      for (const d of dirs) console.log("        " + d);
      const report = gc.runGC(dirs); // REPORT_ONLY 模式只报告，不真删
      const gcEnabled = gc.GC_ENABLED;
      if (report.removed.length) {
        console.log(`        ⚠ 发现 ${report.removed.length} 个"Obsidian 已删但 adapter 仍残留"的孤儿会话。`);
        for (const id of report.removed.slice(0, 12)) console.log("          - " + id);
        console.log("        Obsidian 每次拉会话列表时会自动清理这些孤儿。");
        console.log("        现在立即清理：node dsh-acp.mjs doctor --gc");
      } else {
        console.log(`        ✅ 无孤儿会话（adapter 索引与 Obsidian 已同步）。GC ${gcEnabled ? "已启用(自动)" : "已关闭(off)"}。`);
      }
    }
  } catch (e) {
    console.log(`📁 [GC] 检测失败：${e && e.message || e}`);
  }
  console.log("");

  // —— GC 立即清理子命令（doctor --gc）—— */
  if (argv.includes("--gc")) {
    try {
      const gc = await import("./gc.mjs");
      const r = gc.runGC();
      console.log(`🧹 [GC] 已清理 ${r.removed.length} 个孤儿会话。`);
      for (const id of r.removed) console.log("   - " + id);
      console.log(`   剩余 adapter 会话 ${gc.allSessions().length} 个（Obsidian 显示的均保留）。`);
      console.log(`   提示：也可在 Obsidian 设置 DSH_ACP_GC=off 关闭自动 GC。`);
      process.exit(0);
    } catch (e) {
      console.log(`🧹 [GC] 清理失败：${e && e.message || e}`);
      process.exit(2);
    }
  }

  // —— R3: 一键修复（阶段 3）—— --fix <item> / --auto [--apply] ——
  {
    const fixIdx = argv.indexOf("--fix");
    const wantAuto = argv.includes("--auto");
    if (fixIdx >= 0 || wantAuto) {
      const apply = argv.includes("--apply") && !argv.includes("--dry-run");
      const target = fixIdx >= 0 ? argv[fixIdx + 1] : null;
      try {
        const diag = diagnoseObsidianDeps();
        let plans = planObsidianFixes(diag);
        if (target) plans = plans.filter((p) => p.item === target);
        if (target && plans.length === 0) {
          console.log(`🔧 [R3] 未找到需要修复的项：${target}（可能已通过，或 item 名有误）`);
        } else {
          console.log(formatFixPlan(plans));
          console.log("");
          if (apply) {
            const diagAll = diagnoseObsidianDeps();
            for (const p of plans) {
              const r = applyObsidianFix(p.item, {
                apply: true,
                profileName: process.env.DSH_PROFILE ?? "web",
                ...(p.item === "custom-agent-config" ? { dataFile: findAgentClientDataFile(diagAll) } : {}),
              });
              if (r.refused) { console.log(`   ⛔ ${p.item}: 拒绝执行 — ${r.reason}`); continue; }
              if (r.command) { console.log(`   ℹ️ ${p.item}: 需人工执行：\n        ${r.command}`); if (r.warning) console.log(`        ${r.warning}`); continue; }
              if (r.applied) console.log(`   ✅ ${p.item}: 已写入（备份 ${r.backupPath}）\n        ${r.reloadHint}`);
              else console.log(`   ⏭️ ${p.item}: 未写入 — ${r.reason}`);
            }
          } else {
            console.log("（以上为预览。要真正执行 user-authorized 项，请追加 --apply）");
          }
          console.log("");
        }
      } catch (e) {
        console.log(`🔧 [R3] 修复流程失败：${(e && e.message) || e}`);
      }
    }
  }

  // —— R2: Obsidian 侧依赖检查（8 项）—— 显式 --obsidian 才展开，保证默认输出零变化
  try {
    const r2 = diagnoseObsidianDeps();
    if (argv.includes("--obsidian")) {
      console.log(formatObsidianDeps(r2));
      if (argv.includes("--json")) console.log(JSON.stringify(r2, null, 2));
      console.log("");
    } else if (r2.checks.some((c) => c.status === "fail")) {
      const n = r2.checks.filter((c) => c.status === "fail").length;
      console.log(`🔎 [R2] Obsidian 侧依赖有 ${n} 项未通过（详见：dsh-acp doctor --obsidian）`);
      console.log("");
    }
  } catch (e) {
    console.log(`🔎 [R2] 检查失败：${(e && e.message) || e}`);
  }

  // 补充：跑一次轻量 headless 探测（若非 ENOENT）—— 可选，避免每次耗时
  if (issues.length === 0) {
    console.log("✅ 体检通过：未发现明显配置问题。");
  } else {
    console.log(`发现 ${issues.length} 个问题：`);
    console.log(formatDiagnosis(issues));
    if (doAuto) {
      console.log("\n⚠️ 自动修复：以下操作需逐条确认。答 y 执行，n 跳过，q 退出。");
      // 自动修复只做无副作用或低风险的安全动作（此处为示例，真正自动修复由具体 issue 实现）
      console.log("   （当前版本自动修复仅输出指引，不擅自改配置；如需自动改配置请在 issue 的 fix 中显式实现）");
    }
  }
  process.exit(issues.length === 0 ? 0 : 1);
}

// 直接以 `dsh-acp doctor` 运行时走 CLI
if (process.argv[1] && /dsh-acp\.mjs$/.test(process.argv[1]) && process.argv[2] === "doctor") {
  await runDoctorCli();
}
