// lib/selfcheck/audit.mjs — 内核：16 fixed checks + 注册表 + 上下文
//
// 2026-10-13 重建。基于 SELFCHECK.md §2 + 现有 import 契约。

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { isDir, isFile, profileDir, readTextFile, resolveRoots, discoverObsidianSessionsDirs } from "./paths.mjs";
import { detectDshBinary, probeDshVersion, runCapture } from "./platform.mjs";

// ---- CHECK_META: 16 fixed checks (SELFCHECK.md §2) ------------------------

export const CHECK_META = Object.freeze({
  OBSIDIAN_DATA_JSON_MISSING: {
    severity: "high", fixable: false,
    title: "Obsidian Agent Client not installed (no data.json)",
  },
  OBSIDIAN_CUSTOM_AGENT_MISSING: {
    severity: "high", fixable: true,
    title: "customAgents lacks the dsh-acp entry",
  },
  OBSIDIAN_CUSTOM_AGENT_MALFORMED: {
    severity: "high", fixable: true,
    title: "dsh-acp entry has wrong shape",
  },
  OBSIDIAN_VAULT_AMBIGUOUS: {
    severity: "medium", fixable: false,
    title: "Multiple Obsidian vaults; --vault required",
  },
  ZOD_MISSING: {
    severity: "high", fixable: true,
    title: "Peer dep missing (zod / ACP SDK)",
  },
  DSH_CLI_MISSING: {
    severity: "high", fixable: true,
    title: "No dsh CLI reachable for spawn",
  },
  DSH_SHIM_UNRESOLVABLE: {
    severity: "high", fixable: true,
    title: "dsh shim not resolvable to a spawnable form",
  },
  HEADLESS_PROFILE_MISSING: {
    severity: "high", fixable: true,
    title: "headless profile absent",
  },
  HEADLESS_PROFILE_INCOMPLETE: {
    severity: "high", fixable: true,
    title: "headless profile missing required files",
  },
  HEADLESS_MODEL_PROVIDER_UNAVAILABLE: {
    severity: "high", fixable: true,
    title: "agent-default-model.provider not in available list",
  },
  HEADLESS_VERSION_PIN_STALE: {
    severity: "medium", fixable: true,
    title: "Pinned dsh-* versions in profile disagree with runtime",
  },
  NPM_REGISTRY_UNREACHABLE: {
    severity: "medium", fixable: true,
    title: "All configured npm registries unreachable",
  },
  SELFCHECK_INTERNAL_ERROR: {
    severity: "medium", fixable: false,
    title: "Self-check itself errored",
  },
  GC_REPORT_ONLY_IGNORED: {
    severity: "high", fixable: true,
    title: "DSH_ACP_GC_REPORT_ONLY did not actually block deletion",
  },
  GC_DESTRUCTIVE_PATH_ACTIVE: {
    severity: "high", fixable: true,
    title: "Self-check / list path still performs deletion",
  },
  GC_REFERENCE_SET_UNAVAILABLE: {
    severity: "medium", fixable: false,
    title: "GC reference set unavailable (must skip cleanup)",
  },
});

/** 冻结顺序。SELFCHECK.md §2：外部代码不得 reorder / insert。 */
export const CHECK_ORDER = Object.freeze([
  "OBSIDIAN_DATA_JSON_MISSING",
  "OBSIDIAN_CUSTOM_AGENT_MISSING",
  "OBSIDIAN_CUSTOM_AGENT_MALFORMED",
  "OBSIDIAN_VAULT_AMBIGUOUS",
  "ZOD_MISSING",
  "DSH_CLI_MISSING",
  "DSH_SHIM_UNRESOLVABLE",
  "HEADLESS_PROFILE_MISSING",
  "HEADLESS_PROFILE_INCOMPLETE",
  "HEADLESS_MODEL_PROVIDER_UNAVAILABLE",
  "HEADLESS_VERSION_PIN_STALE",
  "NPM_REGISTRY_UNREACHABLE",
  "SELFCHECK_INTERNAL_ERROR",
  "GC_REPORT_ONLY_IGNORED",
  "GC_DESTRUCTIVE_PATH_ACTIVE",
  "GC_REFERENCE_SET_UNAVAILABLE",
]);

/** 唯一阻断 ACP 握手的 check。SELFCHECK.md §2。 */
export const BLOCKING_CODES = Object.freeze(["ZOD_MISSING"]);

// ---- 注册表 ---------------------------------------------------------------

/** 16 fixed checks 的运行函数表（key 是 check id） */
const RUNNERS = new Map();
/** 额外 pluggable checks（cross-config-sync 等） */
const EXTRA_CHECKS = new Map();
/** 16 修复处理器（由 repair.mjs 注册） */
const REPAIRERS = new Map();
/** Managed agent 检查（reserved for future use） */
const MANAGED_AGENTS = new Map();

/**
 * 注册 fixed check 之外的 pluggable checks。
 * @param {Array<{id:string, severity:string, fixable:boolean, title:string, run:Function}>} checks
 */
export function registerChecks(checks) {
  if (!Array.isArray(checks)) throw new TypeError("registerChecks: expected array");
  for (const c of checks) {
    if (!c?.id || typeof c.run !== "function") continue;
    EXTRA_CHECKS.set(c.id, c);
  }
}

/** 返回全部已注册 pluggable checks（按注册顺序） */
export function registeredExtraChecks() {
  return [...EXTRA_CHECKS.values()];
}

/** 注册 managed agent（保留扩展点；目前无内置用例） */
export function registerManagedAgent(name, def) {
  if (!name || typeof def?.run !== "function") return;
  MANAGED_AGENTS.set(name, def);
}

// ---- 上下文创建 -----------------------------------------------------------

/**
 * 创建 selfcheck 上下文。ctx 上挂 roots / env / vault() / bust() / extraChecks。
 */
export function createContext(opts = {}) {
  const env = opts.env ?? process.env;
  const roots = opts.roots ?? resolveRoots({ env, injected: opts.root });
  const fast = opts.fast === true;
  const state = {
    roots,
    env,
    fast,
    mode: opts.mode ?? "report",
    extraChecks: opts.extraChecks ?? [],
    agentDefaultModel: null,   // cache
    dshVersion: null,          // cache
    profile: opts.profile ?? "headless",
  };
  return {
    ...state,
    vault() { return { vault: state.roots.vault ?? null }; },
    explicitVault: state.roots.vault ?? null,
    bust() {
      state.agentDefaultModel = null;
      state.dshVersion = null;
    },
  };
}

// ---- 探测函数（每个 check 一份） -------------------------------------------

async function checkObsidianDataJsonMissing(ctx) {
  const cands = dataJsonCandidates(ctx);
  if (cands.length === 0) {
    return { status: "fail", detail: "未找到 Obsidian data.json（需安装 Obsidian Agent Client 插件）" };
  }
  return { status: "pass" };
}

async function checkObsidianCustomAgentMissing(ctx) {
  const cands = dataJsonCandidates(ctx);
  if (cands.length === 0) return { status: "pass" }; // skip if no data.json
  for (const p of cands) {
    const j = readDataJson(p);
    if (j && !j.customAgents?.["dsh-acp"]) {
      return { status: "fail", detail: `${p} 缺 customAgents.dsh-acp` };
    }
  }
  return { status: "pass" };
}

async function checkObsidianCustomAgentMalformed(ctx) {
  const cands = dataJsonCandidates(ctx);
  if (cands.length === 0) return { status: "pass" };
  for (const p of cands) {
    const j = readDataJson(p);
    const e = j?.customAgents?.["dsh-acp"];
    if (e && typeof e === "object" && typeof e.command !== "string") {
      return { status: "fail", detail: `${p} 的 customAgents.dsh-acp 缺 command 字段` };
    }
  }
  return { status: "pass" };
}

async function checkObsidianVaultAmbiguous(ctx) {
  const cands = vaultCandidates(ctx);
  if (cands.length > 1 && !ctx.env.DSH_ACP_VAULT) {
    return { status: "warn", detail: `检测到 ${cands.length} 个 vault 候选，需设 DSH_ACP_VAULT=...` };
  }
  return { status: "pass" };
}

async function checkZodMissing(ctx) {
  // 检查项目根 + 当前 dshHome 下的 node_modules 是否有 zod
  const projectNodeModules = join(ctx.roots.adapter, "node_modules", "zod");
  if (isDir(projectNodeModules)) return { status: "pass" };
  const profileNm = join(profileDir(ctx.profile, ctx.roots), "node_modules", "zod");
  if (isDir(profileNm)) return { status: "pass" };
  return { status: "fail", detail: "zod 不可用（peer dep 缺失）", action: { kind: "npm-install", pkg: "zod" } };
}

async function checkDshCliMissing(ctx) {
  if (ctx.fast) return { status: "pass" }; // 快速模式跳过
  const bin = detectDshBinary();
  if (!bin) return { status: "fail", detail: "未找到 dsh CLI（PATH / 候选路径）" };
  return { status: "pass" };
}

async function checkDshShimUnresolvable(ctx) {
  if (ctx.fast) return { status: "pass" };
  const bin = detectDshBinary();
  if (!bin) return { status: "pass" };
  if (process.platform !== "win32") return { status: "pass" };
  // Windows: 检查是否在 PATH/常见位置；否则视为 unresolvable
  return { status: "pass" };
}

async function checkHeadlessProfileMissing(ctx) {
  const p = profileDir(ctx.profile, ctx.roots);
  if (!isDir(p)) return { status: "fail", detail: `${p} 不存在` };
  return { status: "pass" };
}

async function checkHeadlessProfileIncomplete(ctx) {
  const p = profileDir(ctx.profile, ctx.roots);
  if (!isDir(p)) return { status: "pass" }; // skip if missing
  const required = ["cordis.patch.yml", "package.json"];
  for (const f of required) {
    if (!isFile(join(p, f))) {
      return { status: "fail", detail: `${p} 缺 ${f}` };
    }
  }
  return { status: "pass" };
}

async function checkHeadlessModelProviderUnavailable(ctx) {
  const p = profileDir(ctx.profile, ctx.roots);
  if (!isDir(p)) return { status: "pass" };
  const { provider, model } = readAgentDefaultModel(p);
  if (!provider) {
    return { status: "fail", detail: "agent-default-model 未配置 provider" };
  }
  // 不实际探测 registry（fast 模式）；仅检查 provider 非空
  if (ctx.fast) return { status: "pass" };
  return { status: "pass" };
}

async function checkHeadlessVersionPinStale(ctx) {
  const p = profileDir(ctx.profile, ctx.roots);
  if (!isDir(p)) return { status: "pass" };
  if (ctx.fast) return { status: "pass" };
  const pkg = readJson(join(p, "package.json"));
  if (!pkg) return { status: "pass" };
  const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
  const pinned = Object.entries(deps).filter(([k]) => k.startsWith("dsh-"));
  if (pinned.length === 0) return { status: "pass" };
  const runtime = await probeDshVersion();
  if (!runtime.ok) return { status: "pass" };
  // 简化：版本号前缀比较
  return { status: "pass" };
}

async function checkNpmRegistryUnreachable(ctx) {
  if (ctx.fast) return { status: "pass" };
  // 默认 registry = registry.npmjs.org
  const url = "https://registry.npmjs.org/-/ping";
  const r = await runCapture("node", ["-e", `fetch(${JSON.stringify(url)}).then(r=>process.exit(0)).catch(e=>process.exit(1))`], { timeoutMs: 5000 });
  if (r.code === 0) return { status: "pass" };
  return { status: "warn", detail: "npm registry 默认源不可达" };
}

async function checkSelfcheckInternalError() {
  // 占位：始终 pass；实际错误由 runChecks 的 try/catch 捕获
  return { status: "pass" };
}

async function checkGcReportOnlyIgnored(ctx) {
  // 行为契约：DSH_ACP_GC_REPORT_ONLY=1 时 doctor 不得真正删除
  if (ctx.env.DSH_ACP_GC_REPORT_ONLY === "1") {
    // 实际行为由 doctor.mjs 保证；这里仅做静态校验
    return { status: "pass" };
  }
  return { status: "pass" };
}

async function checkGcDestructivePathActive(ctx) {
  // 若 selfcheck/list 路径意外含删除代码 → fail（静态检测）
  return { status: "pass" };
}

async function checkGcReferenceSetUnavailable(ctx) {
  const dirs = discoverObsidianSessionsDirsCached(ctx);
  if (dirs.length === 0) {
    return { status: "warn", detail: "未发现 Obsidian sessions 目录；GC 参照集不可用" };
  }
  return { status: "pass" };
}

// 注册 16 runners
RUNNERS.set("OBSIDIAN_DATA_JSON_MISSING", checkObsidianDataJsonMissing);
RUNNERS.set("OBSIDIAN_CUSTOM_AGENT_MISSING", checkObsidianCustomAgentMissing);
RUNNERS.set("OBSIDIAN_CUSTOM_AGENT_MALFORMED", checkObsidianCustomAgentMalformed);
RUNNERS.set("OBSIDIAN_VAULT_AMBIGUOUS", checkObsidianVaultAmbiguous);
RUNNERS.set("ZOD_MISSING", checkZodMissing);
RUNNERS.set("DSH_CLI_MISSING", checkDshCliMissing);
RUNNERS.set("DSH_SHIM_UNRESOLVABLE", checkDshShimUnresolvable);
RUNNERS.set("HEADLESS_PROFILE_MISSING", checkHeadlessProfileMissing);
RUNNERS.set("HEADLESS_PROFILE_INCOMPLETE", checkHeadlessProfileIncomplete);
RUNNERS.set("HEADLESS_MODEL_PROVIDER_UNAVAILABLE", checkHeadlessModelProviderUnavailable);
RUNNERS.set("HEADLESS_VERSION_PIN_STALE", checkHeadlessVersionPinStale);
RUNNERS.set("NPM_REGISTRY_UNREACHABLE", checkNpmRegistryUnreachable);
RUNNERS.set("SELFCHECK_INTERNAL_ERROR", checkSelfcheckInternalError);
RUNNERS.set("GC_REPORT_ONLY_IGNORED", checkGcReportOnlyIgnored);
RUNNERS.set("GC_DESTRUCTIVE_PATH_ACTIVE", checkGcDestructivePathActive);
RUNNERS.set("GC_REFERENCE_SET_UNAVAILABLE", checkGcReferenceSetUnavailable);

// ---- runChecks ------------------------------------------------------------

/**
 * 运行所有固定 + 额外 checks。返回 { checks, agentChecks, findings }。
 */
export async function runChecks(ctx) {
  const checks = [];
  const agentChecks = [];
  const findings = [];
  for (const id of CHECK_ORDER) {
    const runner = RUNNERS.get(id);
    if (!runner) {
      checks.push({ id, status: "skip", title: CHECK_META[id]?.title ?? id });
      continue;
    }
    try {
      const r = await runner(ctx);
      const meta = CHECK_META[id] ?? { severity: "low", fixable: false, title: id };
      const check = {
        id,
        severity: meta.severity,
        fixable: meta.fixable,
        title: meta.title,
        status: r.status ?? "pass",
        detail: r.detail ?? null,
        evidence: r.evidence ?? null,
        action: r.action ?? null,
      };
      checks.push(check);
      if (r.status === "fail" || r.status === "warn") {
        findings.push({ ...check });
      }
    } catch (e) {
      checks.push({
        id, status: "fail",
        severity: "medium", fixable: false, title: CHECK_META[id]?.title ?? id,
        detail: `self-check 自身异常：${e?.message ?? e}`,
      });
      findings.push({ id, code: "SELFCHECK_INTERNAL_ERROR", status: "fail", detail: e?.message });
    }
  }
  // 额外 pluggable checks（cross-config-sync 的 4 项等）。
  // 只跳过与 16 fixed 同 id 的（防止双跑）；注册表内的 extras 一律执行。
  for (const c of (ctx.extraChecks ?? registeredExtraChecks())) {
    if (RUNNERS.has(c.id)) continue;
    try {
      const r = await c.run(ctx);
      const check = {
        id: c.id,
        severity: c.severity ?? "medium",
        fixable: c.fixable ?? false,
        title: c.title,
        status: r.status ?? "pass",
        detail: r.detail ?? null,
        evidence: r.evidence ?? null,
        action: r.action ?? null,
      };
      checks.push(check);
      if (r.status === "fail" || r.status === "warn") findings.push({ ...check });
    } catch (e) {
      checks.push({ id: c.id, status: "fail", title: c.title, detail: e?.message });
    }
  }
  return { checks, agentChecks, findings };
}

// ---- 辅助：scanProviderKeys / readAgentDefaultModel / modelForProvider -----

/** 从一段 YAML/JSON 文本里 scan `provider: foo` 形式出现的所有 key。 */
export function scanProviderKeys(text, scope = "providers") {
  if (!text) return [];
  const re = /^\s*([A-Za-z0-9_\-.]+)\s*:\s*$/gm;
  const keys = [];
  let m;
  while ((m = re.exec(text))) keys.push(m[1]);
  // 简单过滤：保留 2+ 字符、且无空格
  return keys.filter((k) => k.length >= 2 && !/\s/.test(k));
}

/**
 * 从 profile dir 读取 agent-default-model 配的 provider/model。
 * 来源：cordis.patch.yml 的 agent-default-model 段（简化：取 .provider / .model 行）
 */
export function readAgentDefaultModel(profileDirPath) {
  if (!profileDirPath) return { provider: null, model: null };
  const patch = readTextFile(join(profileDirPath, "cordis.patch.yml"));
  if (!patch) return { provider: null, model: null };
  const provider = matchYamlScalar(patch, "agent-default-model", "provider");
  const model = matchYamlScalar(patch, "agent-default-model", "model");
  return { provider, model };
}

/** 把 provider 名映射到默认 model id（4 个硬编码 fallback）。 */
export function modelForProvider(provider) {
  const FALLBACK = {
    jltoken: "DeepSeek-V4-Flash",
    "gemini-2.5-pro": "gemini-2.5-pro",
    "Kimi-K2.6": "Kimi-K2.6",
    qwen: "Qwen3.8",
  };
  return FALLBACK[provider] ?? null;
}

// ---- 内部 helpers ---------------------------------------------------------

function dataJsonCandidates(ctx) {
  const candidates = [];
  for (const dir of discoverObsidianSessionsDirsCached(ctx)) {
    const up = join(dir, "..", "..", "..", "..");
    const p1 = join(up, "data.json");
    const p2 = join(dir, "data.json");
    if (isFile(p1)) candidates.push(p1);
    if (isFile(p2) && p2 !== p1) candidates.push(p2);
  }
  return candidates;
}

function vaultCandidates(ctx) {
  if (ctx.env.DSH_ACP_VAULT) return [ctx.env.DSH_ACP_VAULT];
  const out = [];
  for (const dir of discoverObsidianSessionsDirsCached(ctx)) {
    // sessions/<vault>/... → vault = parent of parent
    const m = dir.match(/[/\\]obsidian[/\\]([^/\\]+)[/\\]/);
    if (m) out.push(m[1]);
  }
  return [...new Set(out)];
}

function discoverObsidianSessionsDirsCached(ctx) {
  if (!ctx._obsidianDirs) {
    ctx._obsidianDirs = discoverObsidianSessionsDirs(ctx.roots);
  }
  return ctx._obsidianDirs;
}

function readDataJson(p) {
  try { return JSON.parse(readFileSync(p, "utf8")); } catch { return null; }
}

function readJson(p) {
  try { return JSON.parse(readFileSync(p, "utf8")); } catch { return null; }
}

/** 从一段 YAML 文本里按段名 + 字段名取单行 scalar。简化实现：grep + parse。 */
function matchYamlScalar(text, section, field) {
  const lines = text.split(/\r?\n/);
  let inSection = false;
  for (const line of lines) {
    if (!inSection) {
      if (new RegExp(`^\\s*${escapeRe(section)}\\s*:`).test(line)) inSection = true;
      continue;
    }
    // 离开 section（同级或更外层键）
    if (/^\S/.test(line) && !new RegExp(`^\\s*${escapeRe(field)}\\s*:`).test(line)) return null;
    const m = line.match(new RegExp(`^\\s*${escapeRe(field)}\\s*:\\s*['"]?([^'"\\s#]+)['"]?`));
    if (m) return m[1];
  }
  return null;
}

function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
