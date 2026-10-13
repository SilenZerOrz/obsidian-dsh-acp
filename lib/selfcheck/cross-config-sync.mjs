// lib/selfcheck/cross-config-sync.mjs — 跨配置源一致性 check
//
// 2026-10-12 新增。t27/F8 制度化：dsh 存在 3 层独立的 provider/model 配置源，
// 必须由自检统一看住，缺一即报错：
//
//   1. dsh Desktop runtime  → profiles/<name>/cordis.patch.yml 的 `llm-pi-ai.providers`
//   2. dsh-acp Obsidian 插件 → ~/.dsh/settings.yaml 的 `llm-pi-ai.providers`
//   3. dsh-acp 默认值硬编码  → dsh-acp.mjs:240 / :486 的字符串字面量
//
// 任一不一致都会引发以下已知症状（见 agent-team-lab/fix/reports/66-cross-config-sync-selfcheck-fixes.md）：
//   - 源 2 缺失 → dsh-acp 走 FALLBACK_MODELS（4 个 hardcoded），V4.1 不在 dropdown
//   - 源 1/2 漂移 → dropdown 与 dsh Desktop UI 看到的模型不一致
//   - 源 3 错字（"jl-token" vs "jltoken"）→ dsh 报 NO_ADAPTER
//   - 源 1 默认 provider 不在源 2 catalog → 选了下拉里没的模型就 NO_ADAPTER
//
// 写入策略：
//   - 仅 read-only 检测；自动修复只允许生成 settings.yaml（无任何 dsh 运行时副作用）
//   - 任何"自动改源 1 cordis.patch.yml" 的需求都走既有的 HEADLESS_MODEL_PROVIDER_UNAVAILABLE
//     流程（align-provider），本模块不重复
//   - 源 3 错字是 src/installed 物理分离造成的，**只能 plan-only**（详见 §3 注释）

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { registerChecks, scanProviderKeys, readAgentDefaultModel, modelForProvider } from "./audit.mjs";
import { isDir, isFile, profileDir, readTextFile } from "./paths.mjs";
import { registerRepairer } from "./repair.mjs";
import { settingsYamlPath, parseProviderCatalog } from "../settings-provider-catalog.mjs";

// ---- 元数据：4 个新问题码 ---------------------------------------------------

const CHECK_META_EXTRA = Object.freeze({
  DSH_ACP_SETTINGS_YAML_MISSING: {
    severity: "high",
    fixable: true,
    title: "~/.dsh/settings.yaml 缺失（dsh-acp 走 FALLBACK_MODELS，模型下拉与 dsh Desktop UI 不一致）",
  },
  DSH_ACP_SETTINGS_CORDIS_DESYNC: {
    severity: "medium",
    fixable: true,
    title: "~/.dsh/settings.yaml 与 cordis.patch.yml 的 llm-pi-ai.providers 漂移",
  },
  DSH_ACP_PROVIDER_NAME_HYPHEN: {
    severity: "high",
    fixable: false,
    title: "dsh-acp.mjs 仍有 \"jl-token\"（带连字符）硬编码 → dsh 报 NO_ADAPTER",
  },
  DSH_DESKTOP_DEFAULT_MODEL_VALID: {
    severity: "medium",
    fixable: true,
    title: "desktop profile 的 agent-default-model provider 不在 settings.yaml 已知清单",
  },
});

// ---- 检测函数 ----------------------------------------------------------------

/** Check 1：~/.dsh/settings.yaml 是否存在且可解析。 */
function checkSettingsYamlMissing(ctx) {
  const path = settingsYamlPath(ctx.env);
  if (!isFile(path)) {
    return {
      status: "fail",
      detail: `${path} 不存在 → dsh-acp 走 FALLBACK_MODELS 硬编码 4 模型（jltoken/gemini-2.5-pro / Kimi-K2.6 / DeepSeek-V4-Flash / Qwen3.8），DeepSeek-V4.1-Flash 不在下拉`,
      evidence: [
        "settings-provider-catalog.mjs:13 注释：Source of truth: ~/.dsh/settings.yaml",
        "dsh-acp.mjs:486-489 FALLBACK_MODELS（4 个 hardcoded）",
        "本机 cordis.patch.yml 已注册 V4.1 但 dsh-acp dropdown 不显示",
      ],
      action: { kind: "write-yaml-from-cordis", file: path },
    };
  }
  // 文件存在但解析失败
  const text = readTextFile(path);
  if (text === null) {
    return { status: "fail", detail: `${path} 不可读（权限/编码）`, action: { kind: "write-yaml-from-cordis", file: path } };
  }
  const catalog = parseProviderCatalog(text);
  if (catalog.length === 0) {
    return {
      status: "fail",
      detail: `${path} 存在但 parseProviderCatalog 返回 0 项（结构错误/字段缺失）`,
      action: { kind: "write-yaml-from-cordis", file: path },
    };
  }
  return { status: "pass", detail: `已存在，${catalog.length} 个 model 项` };
}

/** Check 2：settings.yaml 的 provider 清单 vs cordis.patch.yml 各 profile 的 llm-pi-ai.providers。 */
function checkSettingsCordisDesync(ctx) {
  const path = settingsYamlPath(ctx.env);
  if (!isFile(path)) {
    return { status: "skip", detail: `settings.yaml 缺失（由 DSH_ACP_SETTINGS_YAML_MISSING 报告）` };
  }
  const text = readTextFile(path);
  const settingsProviders = new Set(scanProviderKeys(text, "llm-pi-ai"));

  // 收集所有 profile 的 cordis.patch.yml 的 providers
  const profilesScanned = [];
  const cordisProviders = new Set();
  const home = ctx.roots.dshHome;
  if (home && isDir(home)) {
    const profilesDir = join(home, "profiles");
    if (isDir(profilesDir)) {
      for (const name of readdirSync(profilesDir)) {
        const cordisPath = join(profilesDir, name, "cordis.patch.yml");
        if (!isFile(cordisPath)) continue;
        const cText = readTextFile(cordisPath);
        if (cText === null) continue;
        const providers = scanProviderKeys(cText, "llm-pi-ai");
        profilesScanned.push(`${name}(${providers.length})`);
        for (const p of providers) cordisProviders.add(p);
      }
    }
  }

  const inCordisNotSettings = [...cordisProviders].filter((p) => !settingsProviders.has(p));
  const inSettingsNotCordis = [...settingsProviders].filter((p) => !cordisProviders.has(p));

  if (!inCordisNotSettings.length && !inSettingsNotCordis.length) {
    return {
      status: "pass",
      detail: `settings.yaml 与 cordis 一致（${cordisProviders.size} 个 provider，扫了 ${profilesScanned.join(", ") || "0 profile"}）`,
    };
  }
  return {
    status: "warn",
    detail: [
      `cordis 有但 settings.yaml 缺：${inCordisNotSettings.join(", ") || "无"}`,
      `settings.yaml 有但 cordis 全无：${inSettingsNotCordis.join(", ") || "无"}`,
    ].join("；"),
    evidence: profilesScanned,
    action: { kind: "write-yaml-from-cordis", file: path },
  };
}

/** Check 3：dsh-acp.mjs 硬编码 DEFAULT_PROVIDER 仍是 "jl-token"（带连字符）。 */
function checkProviderNameHyphen(ctx) {
  // 找本包（obsidian-dsh-acp）的 dsh-acp.mjs
  const candidates = [];
  // 主：ctx.roots.adapter（如果 createContext 提供了）
  if (ctx.roots?.adapter && isFile(ctx.roots.adapter)) candidates.push(ctx.roots.adapter);
  // 备：从本包 package 解析
  //   自检模块自身在 obsidian-dsh-acp/lib/selfcheck/，往上 2 级即 dsh-acp.mjs 同包
  //   但 src / installed 可能不同，**两个都查**（这是 src/installed desync 的本质）
  try {
    const here = fileURLToPath(import.meta.url);
    // .../lib/selfcheck/cross-config-sync.mjs → .../dsh-acp.mjs
    const same = join(dirname(here), "..", "..", "dsh-acp.mjs");
    if (isFile(same)) candidates.push(same);
  } catch {}

  if (!candidates.length) {
    return { status: "skip", detail: "未定位 dsh-acp.mjs 路径，跳过此 check" };
  }

  const findings = [];
  for (const file of candidates) {
    const text = readTextFile(file);
    if (text === null) continue;
    const lines = text.split(/\r?\n/);
    lines.forEach((line, idx) => {
      // 排除注释行（首字符是 # 或在行首缩进后的 #）
      const trimmed = line.trim();
      if (trimmed.startsWith("#")) return;
      // 找 'jl-token' 或 "jl-token" 字面量（带连字符）
      const m = line.match(/['"]jl-token['"]/);
      if (m) {
        findings.push({ file, line: idx + 1, content: line.trim().slice(0, 120) });
      }
    });
  }

  if (!findings.length) {
    return { status: "pass", detail: `已检查 ${candidates.length} 个 dsh-acp.mjs 副本，无 "jl-token" 字面量` };
  }
  return {
    status: "fail",
    detail: `${findings.length} 处仍含 "jl-token"（带连字符）→ dsh 报 NO_ADAPTER for provider "jl-token"`,
    evidence: findings.map((f) => `${f.file}:${f.line} → ${f.content}`),
    action: { kind: "plan-only", note: "把 src 里 dsh-acp.mjs 的 \"jl-token\" 改成 \"jltoken\"（行 240 / 486），并 cp 到 node_modules/obsidian-dsh-acp/dsh-acp.mjs（src/installed 物理分离，需双向同步）" },
  };
}

/** Check 4：desktop profile 的 agent-default-model.provider 是否在 settings.yaml 的 provider 清单内。 */
function checkDesktopDefaultModel(ctx) {
  const home = ctx.roots.dshHome;
  if (!home) return { status: "skip", detail: "无 dsh home，无法定位 desktop profile" };
  const desktopDir = profileDir(home, "desktop");
  if (!isDir(desktopDir)) return { status: "skip", detail: "desktop profile 不存在（t11 走 ambient profile 路径，本 check 跳过）" };
  const info = readAgentDefaultModel(desktopDir);
  if (!info.exists || !info.provider) {
    return { status: "skip", detail: `desktop cordis.patch.yml 未声明 agent-default-model：${info.file}` };
  }

  // 1) 找 settings.yaml 的 provider 清单
  const settingsPath = settingsYamlPath(ctx.env);
  const inSettings = isFile(settingsPath);
  const settingsText = inSettings ? readTextFile(settingsPath) : null;
  const settingsProviders = settingsText ? new Set(scanProviderKeys(settingsText, "llm-pi-ai")) : new Set();

  // 2) 找本机其它 profile 的 provider 清单
  const allProfiles = [];
  try {
    const profilesDir = join(home, "profiles");
    if (isDir(profilesDir)) {
      for (const name of readdirSync(profilesDir)) {
        if (name === "desktop") continue;
        const cordisPath = join(profilesDir, name, "cordis.patch.yml");
        if (!isFile(cordisPath)) continue;
        const t = readTextFile(cordisPath);
        if (t === null) continue;
        for (const p of scanProviderKeys(t, "llm-pi-ai")) allProfiles.push(p);
      }
    }
  } catch {}

  const allKnown = new Set([...settingsProviders, ...allProfiles]);

  if (allKnown.has(info.provider)) {
    return {
      status: "pass",
      detail: `desktop default=${info.provider}/${info.model ?? "?"} 在已知 provider 清单内（settings.yaml=${settingsProviders.size} + 其它 profile=${allProfiles.length}）`,
    };
  }
  // 建议：取 ambient / 其它 profile 已用的 provider
  const desired = ctx.env.DSH_ACP_AVAILABLE_PROVIDERS?.split(",")[0]?.trim()
    || (allProfiles[0] ?? [...settingsProviders][0] ?? null);
  const desiredModel = desired ? modelForProvider(ctx, desired) ?? info.model : info.model;
  return {
    status: "fail",
    detail: `desktop default provider=${info.provider} 不在已知清单（settings.yaml=${[...settingsProviders].join(",") || "∅"}；其它 profile=${[...allProfiles].filter((v, i, a) => a.indexOf(v) === i).join(",") || "∅"}）`,
    evidence: [`desktop cordis.patch.yml: ${info.file}`, `settings.yaml: ${settingsPath}`],
    action: { kind: "align-provider", file: info.file, provider: desired, model: desiredModel, current: info.provider },
  };
}

// ---- 修复 handler ------------------------------------------------------------

/** 从 cordis.patch.yml 的 llm-pi-ai.providers 块重建 settings.yaml。 */
function planSettingsYamlFromCordis(check, ctx) {
  const file = check.action?.file;
  if (!file) return [];

  const home = ctx.roots.dshHome;
  if (!home || !isDir(home)) {
    return [{ id: `${check.id}#1`, kind: "plan-only", status: "planned", rollback: null, note: "dsh home 不可定位", verify: { kind: "selfcheck-code", code: check.id } }];
  }

  // 收集所有 profile 的 providers（去重：displayName 取该 provider 第一次出现）
  const providers = new Map(); // providerName → { displayName, models: [{id, name}] }
  try {
    const profilesDir = join(home, "profiles");
    if (isDir(profilesDir)) {
      for (const name of readdirSync(profilesDir)) {
        const cordisPath = join(profilesDir, name, "cordis.patch.yml");
        if (!isFile(cordisPath)) continue;
        const t = readTextFile(cordisPath);
        if (t === null) continue;
        // 简化扫描：本 check 用 indentation parser（与 settings-provider-catalog.mjs 同思路）
        // —— 不引外部 parser 以保持本模块自洽。
        scanIntoProviders(t, providers);
      }
    }
  } catch (e) {
    return [{ id: `${check.id}#1`, kind: "plan-only", status: "planned", rollback: null, note: `扫 profile 失败：${e?.message ?? e}`, verify: { kind: "selfcheck-code", code: check.id } }];
  }

  if (providers.size === 0) {
    return [{ id: `${check.id}#1`, kind: "plan-only", status: "planned", rollback: null, note: "cordis.patch.yml 全部 profile 都未找到 llm-pi-ai.providers 块", verify: { kind: "selfcheck-code", code: check.id } }];
  }

  const content = renderSettingsYaml(providers);
  return [{
    id: `${check.id}#1`,
    kind: "write-yaml",
    target: file,
    file,
    content,
    status: "planned",
    backupPath: null,
    rollback: `还原/删除 ${file}`,
    note: `从 ${providers.size} 个 provider 重建（合并自所有 profile 的 cordis.patch.yml）`,
    verify: { kind: "selfcheck-code", code: "DSH_ACP_SETTINGS_YAML_MISSING" },
  }];
}

/**
 * 把 cordis.patch.yml 文本里的 llm-pi-ai.providers.<name>.{displayName,models[].{id,name}} 抽出来。
 *
 * 支持两种 loader patch 条目形态：
 *   - `- id: llm-pi-ai` + `config:` + `providers:`（真实 profile 的列表项形态）
 *   - `llm-pi-ai:` + `providers:`（嵌套键形态）
 * 缩进用**相对层级**判定，不硬编码 +2 —— 中间是否夹 `config:` 都能识别。
 *
 * @param {string} text
 * @param {Map} [out]  可选注入的 Map（providerName → {displayName, models}）；缺省自建
 * @returns {Map} out（含 {displayName, models}）
 */
export function scanIntoProviders(text, out) {
  const map = out instanceof Map ? out : new Map();
  const lines = text.split(/\r?\n/);
  let piAiIndent = -1;        // llm-pi-ai 声明行缩进（-1 = 尚未找到）
  let providersIndent = -1;   // providers: 行缩进
  let providerIndent = -1;    // provider 名（如 jl-token:）缩进
  let childIndent = -1;       // displayName:/models: 缩进
  let modelsIndent = -1;      // - id: 缩进
  let currentProvider = null;
  let inModels = false;
  let lastDashId = null;

  for (const raw of lines) {
    if (!raw.trim() || /^\s*#/.test(raw)) continue;
    const indent = raw.length - raw.trimStart().length;
    const content = raw.trim();

    // 1) 找 llm-pi-ai 声明（两种形态），记录缩进，重置后续层级
    if (piAiIndent < 0) {
      const isPiAi = /^llm-pi-ai:\s*$/.test(content) || /^-\s*id:\s*llm-pi-ai\s*$/.test(content);
      if (isPiAi) { piAiIndent = indent; providersIndent = -1; providerIndent = -1; childIndent = -1; modelsIndent = -1; }
      continue;
    }
    // 出了 llm-pi-ai 块（回到同级或更外层）→ 结束
    if (indent <= piAiIndent) break;

    // 2) 找 providers:（llm-pi-ai 块内，缩进 > piAiIndent）
    if (providersIndent < 0) {
      if (/^providers:\s*$/.test(content) && indent > piAiIndent) providersIndent = indent;
      continue;
    }
    // 出了 providers 块 → 结束
    if (indent <= providersIndent) break;

    // 3) provider 名（缩进 > providersIndent 的第一个键行）
    const provMatch = content.match(/^([A-Za-z0-9_-]+):\s*$/);
    if (providerIndent < 0) {
      if (provMatch && indent > providersIndent) {
        currentProvider = provMatch[1];
        if (!map.has(currentProvider)) map.set(currentProvider, { displayName: currentProvider, models: [] });
        providerIndent = indent;
        childIndent = -1;
        modelsIndent = -1;
        inModels = false;
        lastDashId = null;
      }
      continue;
    }
    // 新的同类 provider 头（与首个 provider 同缩进）→ 切换
    if (provMatch && indent === providerIndent) {
      currentProvider = provMatch[1];
      if (!map.has(currentProvider)) map.set(currentProvider, { displayName: currentProvider, models: [] });
      childIndent = -1;
      modelsIndent = -1;
      inModels = false;
      lastDashId = null;
      continue;
    }
    if (!currentProvider) continue;

    // 4) displayName: / models:（provider 块内第一层子键）
    if (!inModels && indent > providerIndent && (childIndent < 0 || indent <= childIndent)) {
      const dm = content.match(/^displayName:\s*(.*)$/);
      if (dm) {
        childIndent = childIndent < 0 ? indent : childIndent;
        map.get(currentProvider).displayName = dm[1].trim() || currentProvider;
        continue;
      }
      if (/^models:\s*$/.test(content)) {
        childIndent = childIndent < 0 ? indent : childIndent;
        inModels = true;
        modelsIndent = indent;
        continue;
      }
    }
    // 5) models 列表项 - id: / - name:
    if (inModels) {
      if (indent <= modelsIndent) { inModels = false; continue; }
      const idM = content.match(/^-\s*id:\s*(.*)$/);
      if (idM) {
        lastDashId = idM[1].trim();
        if (lastDashId) map.get(currentProvider).models.push({ id: lastDashId, name: lastDashId });
        continue;
      }
      const nameM = content.match(/^-\s*name:\s*(.*)$/);
      if (nameM && lastDashId) {
        const arr = map.get(currentProvider).models;
        for (let i = arr.length - 1; i >= 0; i--) {
          if (arr[i].id === lastDashId) { arr[i].name = nameM[1].trim() || arr[i].id; break; }
        }
      }
    }
  }
  // 去重：同一 provider 的 models 按 id 保留首次出现。
  // （多 profile 共享一个 out Map 时，重复调用会累积 → 必须收敛。）
  for (const info of map.values()) {
    const seen = new Set();
    info.models = info.models.filter((m) => {
      if (seen.has(m.id)) return false;
      seen.add(m.id);
      return true;
    });
  }
  return map;
}

function renderSettingsYaml(providers) {
  const header = [
    "# ~/.dsh/settings.yaml",
    "#",
    "# Auto-generated 2026-10-12 by lib/selfcheck/cross-config-sync.mjs:planSettingsYamlFromCordis",
    "# DO NOT hand-edit; if you change provider/model, edit profiles/<name>/cordis.patch.yml",
    "# and re-run: node dsh-acp.mjs doctor --fix --yes",
    "#",
    "# Source of truth for dsh-acp's per-session model dropdown (FE-1).",
    "# Layout matches parseProviderCatalog() in lib/settings-provider-catalog.mjs",
    "# (2-space indentation, scanner-style — not full YAML).",
    "",
    "llm-pi-ai:",
    "  providers:",
  ];
  const body = [];
  for (const [name, info] of providers) {
    body.push(`    ${name}:`);
    body.push(`      displayName: ${info.displayName}`);
    body.push(`      models:`);
    for (const m of info.models) {
      body.push(`        - id: ${m.id}`);
      body.push(`          name: ${m.name}`);
    }
  }
  return [...header, ...body, ""].join("\n");
}

// ---- 注册 --------------------------------------------------------------------

const EXTRA_CHECKS = [
  { id: "DSH_ACP_SETTINGS_YAML_MISSING", run: checkSettingsYamlMissing },
  { id: "DSH_ACP_SETTINGS_CORDIS_DESYNC", run: checkSettingsCordisDesync },
  { id: "DSH_ACP_PROVIDER_NAME_HYPHEN", run: checkProviderNameHyphen },
  { id: "DSH_DESKTOP_DEFAULT_MODEL_VALID", run: checkDesktopDefaultModel },
];

// 顶层副作用：被 import 时即注册
registerChecks(EXTRA_CHECKS);
registerRepairer("DSH_ACP_SETTINGS_YAML_MISSING", planSettingsYamlFromCordis);
registerRepairer("DSH_ACP_SETTINGS_CORDIS_DESYNC", planSettingsYamlFromCordis);

// 供 audit.mjs CHECK_META 合并（其它模块可读）
export { CHECK_META_EXTRA };
export { EXTRA_CHECKS };
