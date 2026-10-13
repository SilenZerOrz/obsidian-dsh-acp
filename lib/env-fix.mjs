// lib/env-fix.mjs — 环境自检与自愈的**权威入口模块**
//
// 三个自愈入口只 import 本模块（01 §3.1 / AD-12）：
//   ① 适配器启动预检（dsh-acp.mjs）
//   ② doctor CLI（doctor.mjs）
//   ③ 安装器（install.ps1 / install.sh）
//
// 本模块同时承载：
//   - 三层内核的 re-export（检测层 audit / 修复层 repair / 降级层 degrade）；
//   - GC 安全门门面（`gcStatus()` / `runGcIfExplicitlyEnabled()`，REQ-12）；
//   - 启动预检（`preflightForStartup`，REQ-09）；
//   - CLI 参数解析与**夹具根注入**（`parseDoctorArgs` / `prepareEnv`，契约 (c)）；
//   - 显式动词注册表（`registerVerb`，t11 的 --verify-claude / --e2e-claude 走这里，
//     默认自检绝不触发任何消耗模型额度的动作）。
//
// 环境变量清单见 agent-team-lab/fix/docs/14-dispatch-plan.md §5(g)。

import { discoverObsidianSessionsDirs, isDir, resolveRoots, rootsToEnv, vaultPaths } from "./selfcheck/paths.mjs";
import {
  auditAll,
  awaitPending,
  createContext,
  exitCodeFor,
  gcStatus,
  pendingCount,
  preflightForStartup,
  probeRuntimeMode,
  registerChecks,
  registerManagedAgent,
  registerRepairer,
  repairAll,
  trackPending,
} from "./selfcheck/index.mjs";
import { formatJson, formatStartupDiagnosis, formatStartupSummary, formatText } from "./selfcheck/degrade.mjs";
import { CHECK_META, CHECK_ORDER, readAgentDefaultModel } from "./selfcheck/audit.mjs";
import { buildPackageCommand, resolvePackageManager, selectRegistry, fallbackRegistry } from "./selfcheck/registry.mjs";
import { runCapture } from "./selfcheck/platform.mjs";
// t6-F8 (2026-10-12)：side-effect import — 把 4 个 cross-config-sync check
// 自动注册到 EXTRA_CHECKS。env-fix.mjs 是 doctor 三入口的统一门面，
// import 它 = 触发注册 = auditAll 默认会跑这 4 项。
import "./selfcheck/cross-config-sync.mjs";
// Layer C：对话输出兜底自检（工具轮无文本 → 兜底守卫/开关检查，plan-only）。
import "./selfcheck/conversation-output.mjs";
// t6-F5：兼容面（doctor.mjs 原直接 import 子模块以保留 9 个旧导出）也走本模块转发，
// 保证「三入口只经 lib/env-fix.mjs」这一不变式对 doctor.mjs 真正成立。
export {
  detectDshBinary,
  probeDshVersion,
  resolveDshSpawnSpec,
} from "./selfcheck/platform.mjs";
export { isDir, profileDir, readTextFile } from "./selfcheck/paths.mjs";
export { renderManualResidue, MANUAL_RESIDUE } from "./selfcheck/degrade.mjs";

export {
  // 内核
  auditAll,
  createContext,
  repairAll,
  gcStatus,
  preflightForStartup,
  probeRuntimeMode,
  exitCodeFor,
  registerChecks,
  registerManagedAgent,
  registerRepairer,
  // 退出前 drain（CLI 收尾必须调用；见 doctor.mjs 的 finish()）
  awaitPending,
  pendingCount,
  trackPending,
  // 问题码登记
  CHECK_META,
  CHECK_ORDER,
  // 路径 / vault（单一实现）
  resolveRoots,
  discoverObsidianSessionsDirs,
  vaultPaths,
  readAgentDefaultModel,
  // 降级层格式化（入口 1 的启动诊断直接使用；必须与 lib/selfcheck/degrade.mjs 同名）
  formatJson,
  formatText,
  formatStartupDiagnosis,
  formatStartupSummary,
};

/** 报告格式化（唯一出口：文本走 stderr，JSON 走 stdout）。 */
export function formatReport(report, o = {}) {
  return o.json ? formatJson(report) : formatText(report, o);
}

// ---- 显式动词注册表（t11 扩展点） -------------------------------------------

const VERBS = new Map();

/**
 * 注册一个显式动词（如 `verify-claude` / `e2e-claude`）。
 * @param {string} name    CLI 上的 `--<name>`
 * @param {{description:string, consumesModel?:boolean, run:Function}} def
 */
export function registerVerb(name, def) {
  if (!name || typeof def?.run !== "function") throw new Error("registerVerb(name, {run}) 参数非法");
  VERBS.set(name, { consumesModel: false, description: "", ...def });
}

/** 已注册动词（只读）。 */
export function listVerbs() {
  return [...VERBS.entries()].map(([name, d]) => ({ name, description: d.description, consumesModel: d.consumesModel === true }));
}

export function getVerb(name) {
  return VERBS.get(name) ?? null;
}

/**
 * 内置动词：在某个目录内安装其声明的依赖。
 *
 * 用途：安装器处理 `link:<dir>` / `file:<dir>` 本地源时的「先装源依赖」步骤。
 * 之所以放进内核：安装器**不得**自己实现包管理器探测（AD-13 / 01 §4.4），也不得
 * 使用裸 `npm`/`pnpm`（本机 `Get-Command npm` → npm.ps1，执行策略等效 Restricted，
 * 必然 UnauthorizedAccess；`pnpm` 不在 PATH）。
 *
 * 显式授权：必须带 `--yes`（REQ-10：安装类动作默认只报告）。
 */
let builtinVerbsRegistered = false;
export function registerBuiltinVerbs() {
  if (builtinVerbsRegistered) return;
  builtinVerbsRegistered = true;
  registerVerb("install-deps", {
    description: "在 --dir 目录内安装其依赖（仅允许 node+npm-cli / npm.cmd / node+pnpm.mjs 三种形态，且显式带 --registry）",
    consumesModel: false,
    checks: [],
    run: async (o = {}) => {
      const env = o.env ?? process.env;
      const roots = o.roots ?? resolveRoots({ env });
      const dir = o.dir ?? process.cwd();
      if (o.yes !== true) {
        return { ok: false, code: "NOT_AUTHORIZED", dir, message: "install-deps 需要显式授权（--yes）" };
      }
      if (!isDir(dir)) return { ok: false, code: "DIR_NOT_FOUND", dir, message: `目录不存在：${dir}` };
      const manager = resolvePackageManager({ env, roots, node: o.node });
      if (!manager.available) {
        return { ok: false, code: "NO_PACKAGE_MANAGER", dir, message: `未找到允许的包管理器调用形态：${manager.notes.join("；") || "（无）"}` };
      }
      const reg = await selectRegistry({ env, roots });
      const cmd = buildPackageCommand({ pkg: null, registry: reg.selected, manager });
      if (!cmd) return { ok: false, code: "NO_COMMAND", dir, message: "无法构造安装命令（包管理器不可用）" };
      const r = runCapture(cmd.argv[0], cmd.argv.slice(1), {
        cwd: dir,
        env,
        timeoutMs: o.timeoutMs ?? 600000,
        allowTempFiles: true,
        maxBuffer: 32 * 1024 * 1024,
      });
      const ok = r.status === 0;
      const tail = (r.stderr || r.stdout || r.error || "").split(/\r?\n/).map((s) => s.trim()).filter(Boolean).slice(-3).join(" ");
      return {
        ok,
        code: ok ? null : "INSTALL_FAILED",
        dir,
        command: cmd.display,
        manager: cmd.manager,
        node: cmd.node,
        registry: cmd.registry,
        exitCode: r.status,
        message: ok
          ? `依赖已安装（包管理器 ${cmd.manager}；node ${cmd.node}；registry ${cmd.registry ?? "(未选定)"}）`
          : `安装失败（exit=${r.status ?? "null"}${r.error ? `，${r.error}` : ""}）：${tail}`,
      };
    },
  });
}

registerBuiltinVerbs();

// ---- CLI 参数解析（契约 (c) 的固定夹具布局与解析顺序） ----------------------

/**
 * 解析 doctor 参数。
 * @returns {{json:boolean, fix:boolean, auto:boolean, yes:boolean, dryRun:boolean, gc:boolean,
 *            gcReport:boolean, vault:string|null, root:string|null, dshHome:string|null,
 *            home:string|null, npmPrefix:string|null, adapter:string|null, registry:string|null,
 *            profile:string|null, noObsidian:boolean, fast:boolean, verbs:string[],
 *            errors:string[]}}
 */
export function parseDoctorArgs(argv = []) {
  const a = {
    json: false, fix: false, auto: false, yes: false, dryRun: false, gc: false, gcReport: false,
    applyLive: false,
    vault: null, root: null, dshHome: null, home: null, npmPrefix: null, adapter: null,
    registry: null, profile: null, dir: null, noObsidian: false, fast: false, verbose: false,
    verbs: [], errors: [],
  };
  const take = (key, i) => {
    const v = argv[i + 1];
    if (v === undefined || v.startsWith("--")) {
      a.errors.push(`参数 ${argv[i]} 缺少取值`);
      return i;
    }
    a[key] = v;
    return i + 1;
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const [flag, inline] = arg.includes("=") ? [arg.slice(0, arg.indexOf("=")), arg.slice(arg.indexOf("=") + 1)] : [arg, null];
    const setInline = (key) => { a[key] = inline; };
    switch (flag) {
      case "--json": a.json = true; break;
      case "--fix": a.fix = true; break;
      case "--auto": case "-a": a.auto = true; a.fix = true; break;
      case "--yes": case "-y": a.yes = true; break;
      // t6-F1②：显式声明「我知道这是 live 写入」——非注入模式下用于区分
      // 受控部署/人工确认与"随手一次 --fix --yes"。未提供时会打印 live 目标与哈希预演。
      case "--apply-live": a.applyLive = true; break;
      case "--dry-run": case "--dryrun": a.dryRun = true; break;
      case "--gc": a.gc = true; break;
      case "--gc-report": a.gcReport = true; break;
      case "--no-obsidian": a.noObsidian = true; break;
      case "--fast": a.fast = true; break;
      case "--verbose": a.verbose = true; break;
      case "--vault": case "--obsidian-vault": i = inline !== null ? (setInline("vault"), i) : take("vault", i); break;
      case "--root": i = inline !== null ? (setInline("root"), i) : take("root", i); break;
      case "--dsh-home": i = inline !== null ? (setInline("dshHome"), i) : take("dshHome", i); break;
      case "--home": i = inline !== null ? (setInline("home"), i) : take("home", i); break;
      case "--npm-prefix": i = inline !== null ? (setInline("npmPrefix"), i) : take("npmPrefix", i); break;
      case "--dir": case "--source-dir": i = inline !== null ? (setInline("dir"), i) : take("dir", i); break;
      case "--adapter": i = inline !== null ? (setInline("adapter"), i) : take("adapter", i); break;
      case "--registry": i = inline !== null ? (setInline("registry"), i) : take("registry", i); break;
      case "--profile": i = inline !== null ? (setInline("profile"), i) : take("profile", i); break;
      default: {
        if (flag.startsWith("--")) {
          const name = flag.slice(2);
          if (getVerb(name)) { a.verbs.push(name); break; }
          a.errors.push(`未知参数：${arg}`);
          break;
        }
        // 位置参数：容忍 `doctor --fix <root>` 的写法（把首个位置参数当 root）
        if (!a.root) a.root = arg;
        else a.errors.push(`多余的位置参数：${arg}`);
      }
    }
  }
  return a;
}

/**
 * 依据解析结果准备运行环境。
 * 契约 (c) 规则 1：**必须在 import 业务模块之前**设置 DSH_HOME / DSH_ACP_STORE_DIR /
 * DSH_ACP_GC_OBSIDIAN_DIRS，因此调用方要先 await 本函数、再动态 import 内核。
 *
 * @returns {{roots:object, env:object}}
 */
export function prepareEnv(parsed, baseEnv = process.env) {
  const roots = resolveRoots({
    env: baseEnv,
    root: parsed?.root ?? null,
    dshHome: parsed?.dshHome ?? null,
    vault: parsed?.vault ?? null,
    home: parsed?.home ?? null,
    npmPrefix: parsed?.npmPrefix ?? null,
    adapterPath: parsed?.adapter ?? null,
  });
  const env = rootsToEnv(roots, baseEnv);
  if (parsed?.profile) env.DSH_ACP_RUNTIME_PROFILE = parsed.profile;
  if (parsed?.registry) env.DSH_ACP_NPM_REGISTRY = parsed.registry;
  if (parsed?.noObsidian) env.DSH_ACP_SKIP_OBSIDIAN = "1";
  return { roots, env };
}

// ---- GC 门面（REQ-12） ------------------------------------------------------

/**
 * 仅在**显式开关**下执行清理；否则只报告（默认零副作用）。
 *
 * 显式开关（缺一不可）：`opts.clean === true`（doctor --gc --yes）或
 * `DSH_ACP_GC_CLEAN=1`；且参照集必须可用（gc.mjs 内部失效保护）。
 *
 * @param {object} o
 * @param {object} [o.ctx]
 * @param {boolean} [o.clean] 调用方是否显式要求清理（--gc + --yes / 交互确认）
 * @param {boolean} [o.reportOnly] 调用方**明确要求只报告**（`--gc-report`，t6-F4）：
 *   此时无论 DSH_ACP_GC_CLEAN 是否存在都不得删除；env 开关只对「未表态」的调用方生效。
 * @param {Function} [o.log]
 */
export async function runGcIfExplicitlyEnabled(o = {}) {
  const ctx = o.ctx ?? null;
  const env = o.env ?? ctx?.env ?? process.env;
  const gc = await import("../gc.mjs");
  const reportOnlyRequested = o.reportOnly === true;
  const explicit = !reportOnlyRequested
    && (o.clean === true || (o.allowEnvSwitch !== false && env.DSH_ACP_GC_CLEAN === "1"));
  const dirs = typeof gc.detectObsidianSessionsDirsDetailed === "function"
    ? gc.detectObsidianSessionsDirsDetailed({ roots: ctx?.roots, env }).dirs
    : gc.detectObsidianSessionsDirs({ env });
  const log = o.log ?? (() => {});
  const before = gc.collectObsidianSessionIds(dirs);
  const report = gc.runGC(dirs, {
    clean: explicit,
    reportOnly: reportOnlyRequested || env.DSH_ACP_GC_REPORT_ONLY === "1" || !explicit,
    env,
    log,
  });
  if (reportOnlyRequested && env.DSH_ACP_GC_CLEAN === "1") {
    log("[gc] 调用方明确要求只报告（--gc-report）：DSH_ACP_GC_CLEAN=1 已按只报告处理，本次不删除任何会话。");
  }
  if (explicit && Array.isArray(report.wouldRemove) && report.wouldRemove.length) {
    log(`[gc] 将删除 ${report.wouldRemove.length} 个孤儿会话（参照集可用 ${before.size} 个现存 id）：`);
    for (const id of report.wouldRemove.slice(0, 12)) log(`[gc]   - ${id}`);
  }
  return report;
}

/** GC 门控摘要（供文本报告）。 */
export function gcGateSummary(env = process.env) {
  return {
    gcDisabled: env.DSH_ACP_GC === "off",
    reportOnly: env.DSH_ACP_GC_REPORT_ONLY === "1",
    cleanEnvSwitch: env.DSH_ACP_GC_CLEAN === "1",
  };
}
