// lib/selfcheck/repair.mjs — 16 repair handlers + dry-run / FIXTURE_ESCAPE / backup / idempotency
//
// 2026-10-13 重建。SELFCHECK.md §4。

import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { isDir, isFile, profileDir, readTextFile, resolveRoots, vaultPaths } from "./paths.mjs";
import { runCapture } from "./platform.mjs";
import { scanProviderKeys, readAgentDefaultModel, modelForProvider } from "./audit.mjs";

/** 修复处理器注册表。code 即 check id。 */
const REPAIRERS = new Map();

/** Register a repair handler. */
export function registerRepairer(code, fn) {
  if (!code || typeof fn !== "function") return;
  REPAIRERS.set(code, fn);
}

/**
 * Dry-run / fixture-escape / backup / idempotency 管线。
 * @param {Array} findings     runChecks 产出的失败/告警条目
 * @param {object} ctx         selfcheck context
 * @param {object} opts
 * @param {boolean} [opts.dry=true]   true → 全部 plan-only，零副作用
 * @param {boolean} [opts.execute]    true → 真正执行 plan 写盘
 * @param {boolean} [opts.auto]       true → 自动非交互（替代 DSH_ACP_AUTOFIX=1）
 * @returns {{
 *   actions: Array<{code, kind, plan, applied, error?}>,
 *   backups: Array<{file, backupPath, ts}>,
 *   escape:  boolean,
 *   code:    "ok" | "FIXTURE_ESCAPE" | "BLOCKED" | "ERROR",
 * }}
 */
export async function repairAll(findings, ctx, opts = {}) {
  // 兼容两套调用契约：
  //  - 本项目 kernel 调用：{ dry, execute, auto }
  //  - GitHub 原版 index.mjs：{ dryRun, execute, executeExternal, ...o }
  const dryRun = opts.dryRun === true || opts.dry === true;
  const explicitlyDry = opts.dry === false || opts.dryRun === false;
  const execute = opts.execute === true && !dryRun;
  const executeExternal = opts.executeExternal === true && !dryRun;
  const auto = opts.auto === true || ctx?.env?.DSH_ACP_AUTOFIX === "1";
  const actions = [];
  const backups = [];
  let escape = false;

  // 0. fixture-escape 预检
  const escapeDetected = detectFixtureEscape(ctx, findings);
  if (escapeDetected) {
    return {
      actions: [],
      backups: [],
      escape: true,
      code: "FIXTURE_ESCAPE",
    };
  }

  // 1. 逐个 finding 调度
  for (const f of findings) {
    const code = f.code ?? f.id;
    const handler = REPAIRERS.get(code);
    if (!handler) {
      actions.push(makeAction({ code, kind: "plan-only", plan: "no registered repairer" }));
      continue;
    }
    try {
      const result = await handler({ ...f, ctx }, { dry: dryRun || !explicitlyDry && !execute, execute, executeExternal, auto });
      const action = normalizeAction(result, code, { execute, executeExternal });
      if (action.backup) backups.push(action.backup);
      actions.push(action);
    } catch (e) {
      actions.push(makeAction({ code, kind: "error", plan: `repairer threw: ${e?.message ?? e}` }));
    }
  }

  // 2. 备份落地（按 plan 实际要写的文件做 .bak.<ts>）
  if (execute) {
    for (const a of actions) {
      if (a.applied && a.target && isFile(a.target)) {
        const ts = new Date().toISOString().replace(/[:.]/g, "-");
        const backupPath = `${a.target}.bak.${ts}`;
        try {
          copyFileSync(a.target, backupPath);
          const rec = { file: a.target, backupPath, ts };
          backups.push(rec);
          a.backupPath = backupPath;
          a.backup = rec;
        } catch { /* 备份失败不 abort；记录在 action */ }
      }
    }
  }

  // 3. 幂等性去重：同 code 同 target 的多次 plan → 只保留第一条
  const seen = new Set();
  const deduped = [];
  for (const a of actions) {
    const key = `${a.code}::${a.target ?? a.plan ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(a);
  }
  return { actions: deduped, backups, escape: false, code: "ok" };
}

/** 构造一个 action，同时带原版契约字段（status）与本 kernel 兼容字段（applied/plan）。 */
function makeAction(fields) {
  const applied = fields.applied === true;
  return {
    id: fields.id ?? null,
    code: fields.code,
    kind: fields.kind ?? "plan-only",
    plan: fields.plan ?? fields.note ?? null,
    note: fields.note ?? fields.plan ?? null,
    target: fields.target ?? null,
    file: fields.file ?? null,
    command: fields.command ?? null,
    registry: fields.registry ?? null,
    version: fields.version ?? null,
    manager: fields.manager ?? null,
    payload: fields.payload ?? null,
    error: fields.error ?? null,
    backup: fields.backup ?? null,
    backupPath: fields.backupPath ?? null,
    // 双契约：
    status: fields.status ?? (applied ? "applied" : "planned"),
    applied,
  };
}

function normalizeAction(result, code, { execute, executeExternal }) {
  // result 形如 { kind, plan, target, payload, applied, error, backup, command, ... }
  if (!result || typeof result !== "object") {
    return makeAction({ code, kind: "plan-only", plan: String(result ?? "") });
  }
  // 外部命令类动作需 executeExternal 才真正 applied。
  const wantsApply = result.applied === true;
  const isExternal = result.kind === "exec" || !!result.command;
  const applied = wantsApply && execute && (!isExternal || executeExternal);
  return makeAction({
    ...result,
    code,
    kind: result.kind ?? (applied ? "applied" : "plan-only"),
    status: applied ? "applied" : "planned",
    applied,
  });
}

/**
 * Fixture-escape 检测：plan 中有写盘动作且 target 落在 ctx.roots.path（--root 注入边界）之外。
 */
function detectFixtureEscape(ctx, findings) {
  const root = ctx?.roots?.path;
  if (!ctx?.roots?.injected || !root) return false; // 未注入不算 escape
  for (const f of findings) {
    const target = f?.action?.target ?? f?.target;
    if (!target) continue;
    const abs = resolve(String(target));
    const ok = abs === root || abs.startsWith(root + sep);
    if (!ok) return true;
  }
  return false;
}

// ---- 默认 16 handlers（由 env-fix.mjs 显式调用 registerRepairer） ----------

/** data.json 缺 customAgents.dsh-acp 修复。 */
function repairObsidianCustomAgent(check, ctx) {
  const file = check?.evidence?.dataJsonPath
    ?? guessDataJsonPath(ctx);
  if (!file) {
    return { kind: "plan-only", plan: "需要 user 手动安装 Obsidian Agent Client 插件", target: null };
  }
  return {
    kind: "edit-json",
    plan: `向 ${file} 写入 customAgents.dsh-acp`,
    target: file,
    payload: (cur) => {
      const j = (typeof cur === "object" && cur) ? cur : {};
      j.customAgents = j.customAgents ?? {};
      j.customAgents["dsh-acp"] = {
        command: "node",
        args: ["dsh-acp.mjs"],
        cwd: ctx?.roots?.adapter ?? process.cwd(),
      };
      return j;
    },
  };
}

function guessDataJsonPath(ctx) {
  for (const dir of ctx?.roots?.obsidianDir ? [ctx.roots.obsidianDir] : []) {
    if (isDir(dir)) return join(dir, "data.json");
  }
  return null;
}

/** ZOD_MISSING 修复：走 `node` 调 npm i（绕开 Windows execution policy 拦截 npm.ps1）。 */
function repairZodMissing(check, ctx) {
  const adapter = ctx?.roots?.adapter ?? process.cwd();
  return {
    kind: "exec",
    plan: `node ./node_modules/npm/bin/npm-cli.js i zod --registry=...`,
    target: adapter,
    payload: { cmd: "node", args: ["./node_modules/npm/bin/npm-cli.js", "i", "zod", "--registry=__RUNTIME__"], timeoutMs: 180000 },
  };
}

/** HEADLESS_PROFILE_MISSING 修复：调 dsh plugin add。 */
function repairHeadlessProfileMissing(check, ctx) {
  return {
    kind: "exec",
    plan: `dsh plugin --profile headless add @deepseek-ai/dsh-headless`,
    target: profileDir(ctx?.profile ?? "headless", ctx?.roots),
    payload: { cmd: "dsh", args: ["plugin", "--profile", "headless", "add", "@deepseek-ai/dsh-headless"], timeoutMs: 180000 },
  };
}

/** HEADLESS_PROFILE_INCOMPLETE 修复：填充 cordis.patch.yml + package.json。 */
function repairHeadlessProfileIncomplete(check, ctx) {
  const p = profileDir(ctx?.profile ?? "headless", ctx?.roots);
  if (!isDir(p)) return { kind: "plan-only", plan: `需先创建 ${p}` };
  return {
    kind: "write-file",
    plan: `填充 ${p}/cordis.patch.yml 与 ${p}/package.json`,
    target: join(p, "cordis.patch.yml"),
    payload: MINIMAL_CORDIS_PATCH,
  };
}

/** HEADLESS_MODEL_PROVIDER_UNAVAILABLE 修复：把 provider 对齐到 modelForProvider() 的 fallback。 */
function repairHeadlessModelProvider(check, ctx) {
  const p = profileDir(ctx?.profile ?? "headless", ctx?.roots);
  const { provider, model } = readAgentDefaultModel(p);
  const fallback = modelForProvider(provider) ?? "Qwen3.8";
  return {
    kind: "edit-yaml",
    plan: `将 agent-default-model.model 改写为 ${fallback}`,
    target: join(p, "cordis.patch.yml"),
    payload: (text) => text.replace(/(\bmodel:\s*)[\w.\-]+/, `$1${fallback}`),
  };
}

/** GC 三个：plan-only，由 --gc --yes 显式开启。 */
function repairGcPlanOnly() { return { kind: "plan-only", plan: "需 --gc --yes 显式 opt-in" }; }

/** SELFCHECK_INTERNAL_ERROR：plan-only。 */
function repairInternalError() { return { kind: "plan-only", plan: "self-check 自身异常，需查日志" }; }

/** NPM_REGISTRY_UNREACHABLE：fallback 到镜像。 */
function repairNpmRegistry() {
  return { kind: "plan-only", plan: "fallback to registry.npmmirror.com（运行时切换）", target: null };
}

// 暴露给 env-fix.mjs 的「全部 16 handlers 注册」helper
export function registerBuiltinRepairers() {
  registerRepairer("OBSIDIAN_DATA_JSON_MISSING", repairGcPlanOnly);
  registerRepairer("OBSIDIAN_CUSTOM_AGENT_MISSING", repairObsidianCustomAgent);
  registerRepairer("OBSIDIAN_CUSTOM_AGENT_MALFORMED", repairObsidianCustomAgent);
  registerRepairer("OBSIDIAN_VAULT_AMBIGUOUS", repairGcPlanOnly);
  registerRepairer("ZOD_MISSING", repairZodMissing);
  registerRepairer("DSH_CLI_MISSING", repairNpmRegistry);
  registerRepairer("DSH_SHIM_UNRESOLVABLE", repairNpmRegistry);
  registerRepairer("HEADLESS_PROFILE_MISSING", repairHeadlessProfileMissing);
  registerRepairer("HEADLESS_PROFILE_INCOMPLETE", repairHeadlessProfileIncomplete);
  registerRepairer("HEADLESS_MODEL_PROVIDER_UNAVAILABLE", repairHeadlessModelProvider);
  registerRepairer("HEADLESS_VERSION_PIN_STALE", repairGcPlanOnly);
  registerRepairer("NPM_REGISTRY_UNREACHABLE", repairNpmRegistry);
  registerRepairer("SELFCHECK_INTERNAL_ERROR", repairInternalError);
  registerRepairer("GC_REPORT_ONLY_IGNORED", repairGcPlanOnly);
  registerRepairer("GC_DESTRUCTIVE_PATH_ACTIVE", repairGcPlanOnly);
  registerRepairer("GC_REFERENCE_SET_UNAVAILABLE", repairGcPlanOnly);
}

const MINIMAL_CORDIS_PATCH = `agent-default-model:
  provider: jltoken
  model: DeepSeek-V4-Flash
cordis:
  plugins:
    "@deepseek-ai/dsh-headless": {}
`;

// 启动时立即注册内建 handlers（env-fix.mjs 也会再调一次，幂等）
registerBuiltinRepairers();
