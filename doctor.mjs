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
import { isAbsolute, join } from "node:path";
import { spawnSync } from "node:child_process";

// 本插件版本（与 package.json 保持同步）
export const ADAPTER_VERSION = "0.1.4";

/** 定位 dsh 二进制（与 dsh-acp.mjs 的 detectDshBinary 一致）。 */
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
  return "dsh";
}

const DSH_BIN = detectDshBinary();

/** 读取 dsh 版本（不阻塞）。 */
export function getDshVersion() {
  try {
    const r = spawnSync(DSH_BIN, ["--version"], { encoding: "utf8", timeout: 8000 });
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

  // 3) 插件版本检查：npm 上是否有更新（可选、不阻塞）
  //    （由 CLI 侧调用 npm view；此处不自动访问网络）

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
export function runDoctorCli(argv = process.argv.slice(3)) {
  const doAuto = argv.includes("--auto") || argv.includes("-a");
  console.log(`🩺 obsidian-dsh-acp doctor  (adapter v${ADAPTER_VERSION})`);
  console.log(`   dsh 二进制: ${DSH_BIN}`);
  const ver = getDshVersion();
  console.log(`   dsh 版本  : ${ver || "未知/不可用"}`);
  console.log("");

  const issues = diagnoseDsh();

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
  runDoctorCli();
}
