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

import { accessSync, constants as fsConstants, existsSync, readFileSync } from "node:fs";
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
 *   baseURL http://10.10.10.9:58088 ... (deepseeklocal provider → DEEPSEEKLOCAL_API_KEY)
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
          `        baseURL: http://cdn.shenkeinfo.net/v1`,
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
