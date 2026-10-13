// lib/selfcheck/degrade.mjs — 输出格式 + 手工清理残留渲染
//
// 2026-10-13 重建。SELFCHECK.md §9。

// ---- MANUAL_RESIDUE：手工清理清单常量 --------------------------------------

/**
 * 手工清理残留（plan-only、unfixable）检查的默认描述。env-fix.mjs 与
 * doctor.mjs 共用。
 */
export const MANUAL_RESIDUE = Object.freeze([
  {
    code: "OBSIDIAN_DATA_JSON_MISSING",
    title: "Install Obsidian Agent Client",
    steps: [
      "Open Obsidian → Settings → Community plugins → Browse",
      "Search 'Agent Client' and install it",
      "Reload Obsidian, then run `dsh-acp doctor` again",
    ],
  },
  {
    code: "OBSIDIAN_VAULT_AMBIGUOUS",
    title: "Specify a single vault",
    steps: [
      "If you have multiple Obsidian vaults, set DSH_ACP_VAULT=<vault-name>",
      "Re-run `dsh-acp doctor --root <fixture>` if you were using a fixture root",
    ],
  },
  {
    code: "DSH_CLI_MISSING",
    title: "Install dsh CLI",
    steps: [
      "Run: `node ./node_modules/@deepseek-ai/dsh/bin/dsh.js --version` to confirm",
      "Or install globally: `npm i -g @deepseek-ai/dsh`",
    ],
  },
  {
    code: "DSH_ACP_PROVIDER_NAME_HYPHEN",
    title: "Patch 'jl-token' literal in dsh-acp.mjs",
    steps: [
      "Open src/dsh-acp.mjs and installed/dsh-acp.mjs",
      "Replace all occurrences of the string 'jl-token' with 'jltoken'",
      "Re-run `node build-deploy.sh` to redeploy",
    ],
  },
  {
    code: "GC_REFERENCE_SET_UNAVAILABLE",
    title: "Skip GC cleanup",
    steps: [
      "GC is gated on a populated Obsidian sessions directory",
      "If sessions dir is empty, cleanup is a no-op (safe to ignore)",
    ],
  },
  {
    code: "GC_REPORT_ONLY_IGNORED",
    title: "DSH_ACP_GC_REPORT_ONLY did not block deletion",
    steps: [
      "Verify the env var is set: `echo $DSH_ACP_GC_REPORT_ONLY`",
      "If not respected, this is a regression — file an issue",
    ],
  },
  {
    code: "GC_DESTRUCTIVE_PATH_ACTIVE",
    title: "Self-check path still deletes",
    steps: [
      "Self-check / list path must never call unlink",
      "If it does, this is a regression — file an issue",
    ],
  },
]);

// ---- 4 输出格式 -----------------------------------------------------------

/**
 * JSON 模式：完整 report。
 */
export function formatJson(report) {
  return JSON.stringify(report ?? {}, null, 2);
}

/**
 * 人类可读 text 模式。
 */
export function formatText(report, opts = {}) {
  const r = normalizeReport(report);
  const lines = [];
  lines.push(`dsh-acp self-check — ${r.root ?? "(unknown root)"}`);
  if (r.runtime) lines.push(`runtime: ${r.runtime}`);
  if (r.durationMs != null) lines.push(`durationMs: ${r.durationMs}`);
  lines.push("");
  if (r.error) {
    lines.push(`!! error: ${r.error}`);
  }
  if (Array.isArray(r.checks) && r.checks.length) {
    lines.push(`Checks (${r.checks.length}):`);
    for (const c of r.checks) {
      const tag = (c.status || "?").toUpperCase().padEnd(7);
      const sev = (c.severity || "low").padEnd(6);
      const fix = c.fixable ? "[fix]" : "[nofix]";
      const title = c.title ?? c.id ?? "(no title)";
      lines.push(`  ${tag} ${sev} ${fix} ${c.id} — ${title}${c.detail ? `\n        ${c.detail}` : ""}`);
    }
    lines.push("");
  }
  if (Array.isArray(r.findings) && r.findings.length) {
    lines.push(`Findings (${r.findings.length}):`);
    for (const f of r.findings) {
      lines.push(`  - ${f.id || f.code} [${f.status}]: ${f.detail ?? f.title ?? ""}`);
    }
    lines.push("");
  }
  if (Array.isArray(r.actions) && r.actions.length) {
    lines.push(`Actions (${r.actions.length}):`);
    for (const a of r.actions) {
      const mark = a.applied || a.status === "applied" ? "[applied]" : "[plan]";
      const err = a.error ? ` — ⚠ ${a.error}` : "";
      const tgt = a.target ?? a.file ? `\n        target: ${a.target ?? a.file}` : "";
      lines.push(`  ${mark} ${a.code}: ${a.plan ?? a.note ?? a.kind ?? ""}${tgt}${err}`);
    }
    lines.push("");
  }
  if (Array.isArray(r.backups) && r.backups.length) {
    lines.push(`Backups (${r.backups.length}):`);
    for (const b of r.backups) {
      lines.push(`  - ${b.file} -> ${b.backupPath ?? b.path ?? ""}`);
    }
    lines.push("");
  }
  if (Array.isArray(r.nextSteps) && r.nextSteps.length) {
    lines.push(`Next steps:`);
    for (const s of r.nextSteps) lines.push(`  - ${s}`);
  }
  if (r.gc) {
    lines.push("");
    lines.push(`GC: ${typeof r.gc === "string" ? r.gc : JSON.stringify(r.gc)}`);
  }
  return lines.join("\n");
}

/**
 * Adapter 启动期诊断：把 blocking finding 顶到最前。
 */
export function formatStartupDiagnosis(report) {
  const r = normalizeReport(report);
  const blocking = (r.findings ?? []).filter((f) => f.status === "fail");
  if (blocking.length === 0) return "self-check: ok\n";
  const lines = [`self-check: ${blocking.length} blocking failure(s)`];
  for (const f of blocking.slice(0, 5)) {
    lines.push(`  [${f.id || f.code}] ${f.title ?? ""} — ${f.detail ?? ""}`);
  }
  if (blocking.length > 5) lines.push(`  … and ${blocking.length - 5} more`);
  return lines.join("\n");
}

/**
 * Adapter 启动期摘要：单行。
 */
export function formatStartupSummary(report) {
  const r = normalizeReport(report);
  const f = r.findings ?? [];
  const fail = f.filter((x) => x.status === "fail").length;
  const warn = f.filter((x) => x.status === "warn").length;
  return `self-check: ${f.length} finding(s) (${fail} fail / ${warn} warn) root=${r.root ?? "?"} durationMs=${r.durationMs ?? "?"}`;
}

/**
 * 渲染手工清理残留（unfixable findings 的 human guidance）。
 */
export function renderManualResidue(entries) {
  const list = Array.isArray(entries) && entries.length
    ? entries
    : MANUAL_RESIDUE;
  const lines = ["Manual cleanup residue:"];
  for (const e of list) {
    lines.push(`  • ${e.title} (${e.code})`);
    for (const s of e.steps ?? []) lines.push(`      - ${s}`);
  }
  return lines.join("\n");
}

// ---- 单入口 formatReport（route by o.json） --------------------------------

export function formatReport(report, opts = {}) {
  if (opts?.json) return formatJson(report);
  return formatText(report, opts);
}

// ---- 退出码 ---------------------------------------------------------------

export function exitCodeFor(report) {
  const r = normalizeReport(report);
  if (r.error || r.code === "FIXTURE_ESCAPE") return 2;
  const findings = r.findings ?? [];
  if (findings.some((f) => f.status === "fail" || f.status === "warn")) return 1;
  return 0;
}

// ---- helpers --------------------------------------------------------------

function normalizeReport(r) {
  if (!r) return {};
  return {
    root: coerceRoot(r.root ?? r.roots),
    runtime: coerceRuntime(r.runtime),
    durationMs: r.durationMs ?? null,
    error: coerceError(r.error),
    code: r.code ?? null,
    checks: r.checks ?? [],
    findings: r.findings ?? [],
    actions: r.actions ?? [],
    backups: r.backups ?? [],
    nextSteps: r.nextSteps ?? [],
    gc: r.gc ?? null,
  };
}

/** root 可为 string 或 {path,...} 对象。 */
function coerceRoot(root) {
  if (!root) return null;
  if (typeof root === "string") return root;
  if (typeof root === "object") return root.path ?? root.dshHome ?? null;
  return String(root);
}

/** runtime 可为 string 或 {mode,reason,...} 对象。 */
function coerceRuntime(rt) {
  if (!rt) return null;
  if (typeof rt === "string") return rt;
  if (typeof rt === "object") return rt.mode ?? null;
  return String(rt);
}

/** error 可为 string 或 {code,detail} 对象。 */
function coerceError(err) {
  if (!err) return null;
  if (typeof err === "string") return err;
  if (typeof err === "object") return err.detail ?? err.code ?? null;
  return String(err);
}
