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
  //    契约：repairer 签名为 (check, ctx, opts)；返回单个 action 或 action 数组。
  const repairOpts = { dry: dryRun || (!explicitlyDry && !execute), execute, executeExternal, auto };
  for (const f of findings) {
    const code = f.code ?? f.id;
    const handler = REPAIRERS.get(code);
    if (!handler) {
      actions.push(makeAction({ code, kind: "plan-only", plan: "no registered repairer" }));
      continue;
    }
    let produced = [];
    try {
      const result = await handler({ ...f, ctx }, ctx, repairOpts);
      produced = Array.isArray(result) ? result : [result];
    } catch (e) {
      actions.push(makeAction({ code, kind: "error", plan: `repairer threw: ${e?.message ?? e}` }));
      continue;
    }
    for (const p of produced) actions.push(normalizeAction(p, code));
  }

  // 2. 幂等性去重：同 code 同 target 的多次 plan → 只保留第一条
  const seen = new Set();
  const deduped = [];
  for (const a of actions) {
    const key = `${a.code}::${a.target ?? a.file ?? a.plan ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(a);
  }

  // 3. 执行阶段（仅 execute 时）：逐个 apply；写盘前备份，fixture 边界外拒绝
  if (execute) {
    for (const a of deduped) {
      await applyAction(a, ctx, { executeExternal });
      if (a.applied && a.backup) backups.push(a.backup);
    }
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
    payload: fields.payload ?? null,       // 字符串内容，或 edit-* 的转换函数
    content: fields.content ?? null,       // write-file / write-yaml 的正文
    verify: fields.verify ?? null,
    rollback: fields.rollback ?? null,
    exitCode: fields.exitCode ?? null,
    error: fields.error ?? null,
    backup: fields.backup ?? null,
    backupPath: fields.backupPath ?? null,
    // 双契约：
    status: fields.status ?? (applied ? "applied" : "planned"),
    applied,
  };
}

/** 规划态 action（executor 阶段才可能升级为 applied）。 */
function normalizeAction(result, code) {
  if (!result || typeof result !== "object") {
    return makeAction({ code, kind: "plan-only", plan: String(result ?? "") });
  }
  return makeAction({
    ...result,
    code,
    kind: result.kind ?? "plan-only",
    status: "planned",
    applied: false,
  });
}

/** 写入边界：injected 模式严格限 --root；live 模式限 $HOME 之内。 */
function writeAllowed(target, ctx) {
  const abs = resolve(String(target));
  if (ctx?.roots?.injected) {
    const root = resolve(ctx.roots.path);
    return abs === root || abs.startsWith(root + sep);
  }
  const home = resolve(ctx?.roots?.home ?? process.env.HOME ?? "/");
  return abs === home || abs.startsWith(home + sep);
}

function nowTs() { return new Date().toISOString().replace(/[:.]/g, "-"); }

/** 备份（若目标已存在）+ 写入。返回 backupPath 或 null。 */
function writeWithBackup(target, content) {
  mkdirSync(dirname(target), { recursive: true });
  let backupPath = null;
  if (existsSync(target)) {
    backupPath = `${target}.bak.${nowTs()}`;
    copyFileSync(target, backupPath);
  }
  writeFileSync(target, content);
  return backupPath;
}

/**
 * 执行一个 action。仅 write-file/write-yaml/edit-json/edit-yaml/exec 会被落盘；
 * plan-only 原样返回。写盘前做 fixture 边界检查与备份。
 */
async function applyAction(a, ctx, { executeExternal }) {
  const target = a.target ?? a.file;
  const markApplied = (backupPath) => {
    a.applied = true;
    a.status = "applied";
    if (backupPath) {
      a.backupPath = backupPath;
      a.backup = { file: target, backupPath, ts: nowTs() };
    }
  };

  switch (a.kind) {
    case "write-file":
    case "write-yaml": {
      if (!target) { a.error = "缺少 target"; return a; }
      if (!writeAllowed(target, ctx)) { a.error = `拒绝写入（越出允许边界）：${target}`; return a; }
      const content = a.content ?? (typeof a.payload === "string" ? a.payload : null);
      if (content == null) { a.error = "缺少 content"; return a; }
      try { markApplied(writeWithBackup(target, content)); }
      catch (e) { a.error = `写入失败：${e?.message ?? e}`; }
      return a;
    }
    case "edit-json": {
      if (!target) { a.error = "缺少 target"; return a; }
      if (!writeAllowed(target, ctx)) { a.error = `拒绝写入（越出允许边界）：${target}`; return a; }
      if (typeof a.payload !== "function") { a.error = "edit-json 需 payload 为函数"; return a; }
      let cur = null;
      try { cur = JSON.parse(readFileSync(target, "utf8")); } catch { cur = {}; }
      try {
        const next = a.payload(cur);
        markApplied(writeWithBackup(target, JSON.stringify(next, null, 2)));
      } catch (e) { a.error = `写入失败：${e?.message ?? e}`; }
      return a;
    }
    case "edit-yaml": {
      if (!target) { a.error = "缺少 target"; return a; }
      if (!writeAllowed(target, ctx)) { a.error = `拒绝写入（越出允许边界）：${target}`; return a; }
      if (typeof a.payload !== "function") { a.error = "edit-yaml 需 payload 为函数"; return a; }
      const text = readTextFile(target) ?? "";
      try {
        const next = a.payload(text);
        markApplied(writeWithBackup(target, next));
      } catch (e) { a.error = `写入失败：${e?.message ?? e}`; }
      return a;
    }
    case "exec": {
      const p = a.payload ?? {};
      if (!executeExternal) {
        a.note = `${a.note ?? a.plan ?? ""}（需 --yes 才执行外部命令）`.trim();
        return a;
      }
      if (!p.cmd) { a.error = "缺少 cmd"; return a; }
      try {
        const r = await runCapture(p.cmd, p.args ?? [], { timeoutMs: p.timeoutMs ?? 180000, cwd: p.cwd });
        a.exitCode = r.code;
        a.applied = r.code === 0;
        a.status = a.applied ? "applied" : "failed";
        if (r.code !== 0) a.error = (r.stderr || r.stdout || "").split(/\r?\n/).filter(Boolean).slice(-2).join(" ") || `exit ${r.code}`;
      } catch (e) { a.error = `执行失败：${e?.message ?? e}`; }
      return a;
    }
    default:
      return a; // plan-only：不动
  }
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
    content: MINIMAL_CORDIS_PATCH,
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
