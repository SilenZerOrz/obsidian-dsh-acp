// lib/selfcheck/index.mjs — 内核门面（auditAll / repairAll / formatReport / CHECKS）
//
// 三个自愈入口（适配器启动预检、doctor CLI、安装器）都只经由 lib/env-fix.mjs
// 使用本门面；入口之间不得互相调用，也不得各自实现探测/修复（01 §4.4）。

import { adapterPath, resolveRoots } from "./paths.mjs";
import { probeGateway } from "./platform.mjs";
import {
  CHECK_META,
  CHECK_ORDER,
  createContext,
  registerChecks,
  registerManagedAgent,
  runChecks,
} from "./audit.mjs";
import { registerRepairer, repairAll as repairFindings } from "./repair.mjs";
import { formatJson, formatStartupDiagnosis, formatStartupSummary, formatText } from "./degrade.mjs";

export const SCHEMA_VERSION = 1;

// ---- 在途异步任务跟踪（退出前 drain，避免 exit 与 closing handle 竞争） --------

const PENDING = new Set();

/** 登记一个在途 Promise（不改变其语义）。 */
export function trackPending(p) {
  const wrapped = Promise.resolve(p).catch(() => {}).finally(() => PENDING.delete(wrapped));
  PENDING.add(wrapped);
  return p;
}

/** 在途任务数（诊断用）。 */
export function pendingCount() {
  return PENDING.size;
}

/**
 * 退出前等待在途探测（最多 maxMs，超时即放弃）。
 * Windows 上 `process.exit()` 与仍在关闭的 handle 竞争会触发 libuv 断言
 * （0xC0000409），因此 CLI 收尾必须先 drain 一轮。
 */
export async function awaitPending(maxMs = 200) {
  if (!PENDING.size) return;
  const all = Promise.allSettled([...PENDING]);
  await Promise.race([
    all,
    new Promise((resolve) => {
      const t = setTimeout(resolve, maxMs);
      if (typeof t.unref === "function") t.unref();
    }),
  ]);
}

export {
  CHECK_META,
  CHECK_ORDER,
  createContext,
  registerChecks,
  registerManagedAgent,
  registerRepairer,
  runChecks,
  repairFindings as repairAll,
  formatJson,
  formatText,
  formatStartupDiagnosis,
  formatStartupSummary,
  probeGateway,
};

// ---- 运行时模式（proxy / spawn）诊断 ----------------------------------------

/**
 * 探测 dsh web 的 HTTP 网关，得出**实际运行时模式**与判定依据（R-16 / t3 验收第 4 条）。
 * spawn 是正常降级路径，绝不是错误。
 *
 * 实现要点：环境语义（shouldAttemptProxy / getProxyBaseUrl）仍取自 lib/proxy-mode.mjs
 * （单一来源），但探测本身使用资源卫生版 `probeGateway`（unref 定时器 + 消费响应体），
 * 并登记为"在途任务"，供 CLI 退出前 drain。
 */
export async function probeRuntimeMode(ctx) {
  const env = ctx?.env ?? process.env;
  try {
    const pm = await import("../../lib/proxy-mode.mjs");
    if (!pm.shouldAttemptProxy(env)) {
      return { mode: "spawn", reason: "DSH_ACP_PROXY_MODE 明确禁用网关探测 → spawn 模式（正常）" };
    }
    const baseUrl = pm.getProxyBaseUrl();
    const probe = await trackPending(probeGateway(baseUrl, { timeoutMs: 2000 }));
    if (probe.ok) {
      return {
        mode: "proxy",
        reason: `网关探针成功：${baseUrl}/acp/proxy/probe（mode=${probe.mode ?? "?"}, longReady=${probe.longReady === true}）`,
        baseUrl,
      };
    }
    return {
      mode: "spawn",
      reason: `网关探针失败：${probe.reason ?? "unknown"}（${baseUrl}）→ spawn 模式；这是独立启动时的正常降级，非故障`,
      baseUrl,
    };
  } catch (e) {
    return { mode: "spawn", reason: `网关探针不可用：${e?.message ?? e} → spawn 模式（正常降级）` };
  }
}

// ---- GC 状态（只读；绝不删除） ----------------------------------------------

/**
 * 只读汇总 GC 状态（供报告与 AC-20/AC-21 取证）。
 * **不得**触发删除：这里只做探测与对账推演。
 */
export async function gcStatus(ctx) {
  const env = ctx?.env ?? process.env;
  const enabled = env.DSH_ACP_GC !== "off";
  const out = {
    enabled,
    gate: enabled ? "probe" : "off(DSH_ACP_GC=off)",
    reportOnly: env.DSH_ACP_GC_REPORT_ONLY === "1",
    cleanRequested: env.DSH_ACP_GC_CLEAN === "1",
    referenceSetAvailable: false,
    sessionCount: 0,
    orphanCandidates: [],
    removed: [],
    skipped: true,
    code: null,
    sources: [],
    dirs: [],
    note: "只读推演：本路径不执行删除（REQ-12 / NFR-7）",
  };
  try {
    const gc = await import("../../gc.mjs");
    const detail = typeof gc.detectObsidianSessionsDirsDetailed === "function"
      ? gc.detectObsidianSessionsDirsDetailed({ roots: ctx?.roots, env })
      : { dirs: gc.detectObsidianSessionsDirs(), sources: [] };
    out.dirs = detail.dirs ?? [];
    out.sources = detail.sources ?? [];
    const ids = gc.collectObsidianSessionIds(out.dirs);
    out.referenceSetAvailable = out.dirs.length > 0 && ids.size > 0;
    const store = await import("../../archive-store.mjs");
    const sessions = store.allSessions();
    out.sessionCount = sessions.length;
    out.orphanCandidates = sessions
      .filter((s) => s && s.cwd && !ids.has(s.id))
      .map((s) => s.id);
    if (!out.referenceSetAvailable) {
      out.code = "GC_REFERENCE_SET_UNAVAILABLE";
      out.note = `参照集不可用（探测到 ${out.dirs.length} 个 sessions 目录 / ${ids.size} 个现存 id）→ 已跳过清理，索引内 ${out.sessionCount} 条会话不会被删除`;
    } else if (out.orphanCandidates.length) {
      out.note = `参照集可用（${ids.size} 个现存 id）；推演发现 ${out.orphanCandidates.length} 个孤儿候选，需显式开关（doctor --gc --yes 或 DSH_ACP_GC_CLEAN=1）才会删除`;
    } else {
      out.note = `参照集可用（${ids.size} 个现存 id）；无孤儿候选`;
    }
  } catch (e) {
    out.note = `GC 状态探测失败（已降级）：${e?.message ?? e}`;
  }
  return out;
}

// ---- 报告装配 ---------------------------------------------------------------

function actionToPlanEntry(a) {
  return {
    action: a.kind,
    target: a.target ?? null,
    command: a.command ?? null,
    registry: a.registry ?? null,
    version: a.version ?? null,
    backupPath: a.backupPath ?? null,
    note: a.note ?? null,
    code: a.code ?? null,
    status: a.status,
  };
}

/** 报告里只暴露 01 §3.3 的 Action 契约字段（不外泄文件内容/argv 等内部字段）。 */
function sanitizeAction(a) {
  return {
    id: a.id ?? null,
    code: a.code ?? null,
    kind: a.kind,
    target: a.target ?? null,
    file: a.file ?? null,
    backupPath: a.backupPath ?? null,
    command: a.command ?? null,
    registry: a.registry ?? null,
    version: a.version ?? null,
    manager: a.manager ?? null,
    status: a.status,
    severity: a.severity ?? null,
    note: a.note ?? null,
    rollback: a.rollback ?? null,
    verify: a.verify ?? null,
    verifyCmd: a.verifyCmd ?? null,
    exitCode: a.exitCode ?? null,
    verified: a.verified ?? null,
  };
}

/**
 * 全量检测（+ 按授权修复）。
 *
 * @param {object} o
 * @param {string} [o.mode]  report | fix | dry-run
 * @param {boolean} [o.execute]          允许写（--fix --yes / -Yes / --root 夹具）
 * @param {boolean} [o.executeExternal]  允许执行外部命令（包管理器 / dsh）
 * @param {object}  [o.ctx]              复用上下文（可选）
 */
export async function auditAll(o = {}) {
  const started = Date.now();
  const mode = o.mode ?? "report";
  const ctx = o.ctx ?? createContext({ ...o, mode });
  // 默认把已注册的全部 extra check 也跑（cross-config-sync 等制度化检查）。
  // 调用方想关掉：传 `extraChecks: []` 显式覆盖。
  if (Array.isArray(o.extraChecks)) {
    ctx.extraChecks = o.extraChecks;
  } else {
    const { registeredExtraChecks } = await import("./audit.mjs");
    ctx.extraChecks = registeredExtraChecks();
  }

  const { checks, agentChecks, findings } = await runChecks(ctx);
  const runtime = o.skipRuntimeProbe ? null : await probeRuntimeMode(ctx);
  const gc = o.skipGcStatus ? null : await gcStatus(ctx);

  const dryRun = mode === "dry-run" || o.dryRun === true;
  const execute = o.execute === true && !dryRun;
  const executeExternal = o.executeExternal === true && !dryRun;
  let repair = { actions: [], backups: [], escape: false, code: null };
  if (o.plan !== false) {
    repair = await repairFindings(findings, ctx, { ...o, dryRun: !execute && !executeExternal, execute, executeExternal });
  }

  const allChecks = [...checks, ...(agentChecks ?? [])];
  const fails = allChecks.filter((c) => c.status === "fail");
  const warns = allChecks.filter((c) => c.status === "warn");
  const report = {
    ok: fails.length === 0 && warns.length === 0,
    schemaVersion: SCHEMA_VERSION,
    adapterVersion: o.adapterVersion ?? null,
    mode: repair.escape ? "error" : mode,
    root: {
      injected: ctx.roots.injected,
      path: ctx.roots.path,
      dshHome: ctx.roots.dshHome,
      obsidianVault: ctx.vault().vault ?? ctx.explicitVault ?? null,
      home: ctx.roots.home,
      npmPrefix: ctx.roots.npmPrefix,
      adapter: ctx.roots.adapter,
    },
    runtime,
    checks: allChecks,
    findings,
    actions: (repair.actions ?? []).map(sanitizeAction),
    plan: (repair.actions ?? []).filter((a) => a.status === "planned").map(actionToPlanEntry),
    backups: repair.backups,
    gc,
    nextSteps: buildNextSteps({ checks: allChecks, repair, ctx, gc }),
    durationMs: Date.now() - started,
    error: repair.escape ? { code: repair.code, detail: "写入目标越出注入根 → 本批次零动作（FIXTURE_ESCAPE）" } : null,
  };
  if (agentChecks?.length) report.agentChecks = agentChecks;
  return report;
}

/** 退出码契约：0 = 无 fail/warn；1 = 有 fail/warn；2 = 参数/自身错误。 */
export function exitCodeFor(report) {
  if (!report) return 1;
  if (report.mode === "error" || report.error?.code === "FIXTURE_ESCAPE") return 2;
  const checks = report.checks ?? [];
  const bad = checks.some((c) => c.status === "fail" || c.status === "warn");
  return bad ? 1 : 0;
}

function buildNextSteps({ checks, repair, ctx, gc }) {
  const steps = [];
  const failed = checks.filter((c) => c.status === "fail").map((c) => c.id);
  if (failed.length) {
    steps.push(`修复后复验：node dsh-acp.mjs doctor --json${ctx.roots.injected ? ` --root "${ctx.roots.path}"` : ""}`);
  }
  if (failed.includes("DSH_CLI_MISSING")) {
    steps.push("安装 dsh CLI 后重跑 doctor（版本一律运行时解析，不 pin 过时版本）");
  }
  if (failed.includes("HEADLESS_PROFILE_MISSING") || failed.includes("HEADLESS_PROFILE_INCOMPLETE")) {
    steps.push("用官方路径初始化/修复 profile：<dsh> plugin --profile headless add @deepseek-ai/dsh-headless");
  }
  if (failed.includes("HEADLESS_MODEL_PROVIDER_UNAVAILABLE")) {
    steps.push(`把 headless 的 agent-default-model.provider 对齐到本机可用 provider（可注入 DSH_ACP_AVAILABLE_PROVIDERS 指定）`);
  }
  const external = (repair.actions ?? []).filter((a) => a.status === "planned" && a.command);
  for (const a of external.slice(0, 4)) steps.push(a.command);
  if (gc && gc.code === "GC_REFERENCE_SET_UNAVAILABLE") {
    steps.push("GC 参照集不可用已跳过清理；如需 GC 生效请打开对应 Obsidian vault 或设置 DSH_ACP_GC_OBSIDIAN_DIRS");
  }
  steps.push(`如需清理孤儿会话（破坏性）：node ${JSON.stringify(adapterPath())} doctor --gc --yes${ctx.roots.injected ? " --root <夹具>" : ""}`);
  return steps;
}

// ---- 适配器启动预检（入口 1） -----------------------------------------------

/** 使适配器进程级不可用的阻断性问题码（其余问题一律降级为诊断，不阻断 ACP 握手）。 */
export const BLOCKING_CODES = Object.freeze(["ZOD_MISSING"]);

/**
 * 启动预检：快速模式（不联网），能自愈的自愈，不能自愈的给出可读诊断。
 * @returns {Promise<{ok:boolean, blocking:Array, checks:Array, findings:Array, actions:Array, backups:Array, runtime:object}>}
 */
export async function preflightForStartup(o = {}) {
  const env = o.env ?? process.env;
  if (env.DSH_ACP_SELFCHECK === "off") {
    return { ok: true, skipped: true, reason: "DSH_ACP_SELFCHECK=off（逃生阀）", blocking: [], checks: [], findings: [], actions: [], backups: [], runtime: null };
  }
  const ctx = createContext({ ...o, env, fast: true, mode: "report", allowCwd: true });
  const first = await runChecks(ctx);
  const blocking = first.checks.filter((c) => c.status === "fail" && BLOCKING_CODES.includes(c.id));

  let actions = [];
  let backups = [];
  const autofix = env.DSH_ACP_AUTOFIX === "1";
  const autofixInstall = autofix && (env.DSH_ACP_AUTOFIX_INSTALL === "1" || blocking.length > 0);
  if (autofix) {
    const r = await repairFindings(first.findings, ctx, {
      dryRun: false,
      execute: true,
      executeExternal: autofixInstall,
      externalTimeoutMs: Number(env.DSH_ACP_AUTOFIX_TIMEOUT_MS ?? 180000),
    });
    actions = r.actions;
    backups = r.backups;
  }

  let checks = first.checks;
  let findings = first.findings;
  let blockingFinal = blocking;
  if (autofix && actions.some((a) => a.status === "applied")) {
    ctx.bust();
    const again = await runChecks(ctx);
    checks = again.checks;
    findings = again.findings;
    blockingFinal = checks.filter((c) => c.status === "fail" && BLOCKING_CODES.includes(c.id));
  }

  return {
    ok: blockingFinal.length === 0,
    blocking: blockingFinal,
    checks,
    findings,
    actions,
    backups,
    runtime: null,
    autoFixed: actions.filter((a) => a.status === "applied").length,
  };
}
