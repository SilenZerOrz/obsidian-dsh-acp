// lib/version-detect.mjs — Detect installed dsh version + P2 long-runtime API availability.
//
// WHY THIS EXISTS (2026-09-17 S6+P3.0 design):
//
// P2 long-runtime (in-process host dsh ctx) depends on dsh subpackages that were
// REMOVED in 0.1.5-rc.1 (re-introduced in 0.1.6-alpha.1 devDeps):
//   - @deepseek-ai/dsh-agent-loop
//   - @deepseek-ai/dsh-llm
//   - @deepseek-ai/dsh-acp
//
// If we enable long-mode unconditionally, users on 0.1.5-rc.1/rc.2 will hit
// `ERR_MODULE_NOT_FOUND` at import time. This module provides a single source
// of truth for that check so:
//   - cordis plugin (index.mjs) can downgrade to spawn silently
//   - standalone binary (dsh-acp.mjs) — already spawn-only, but uses this
//     to log a hint when user explicitly asked for long
//   - docs / CLI can surface a friendly reason instead of cryptic stack
//
// S3 research reference: [[DSH工具/dsh-0.1.6-alpha.1版本变更与插件兼容性]] §二.

import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

// Subpackages whose presence indicates dsh 0.1.6-alpha.1+ (P2 long-runtime).
// Order matters: dsh-llm is the most central (ctx.llm.stream lives there);
// fall through to the others if a profile hoists only some.
const P2_PROBES = [
  "@deepseek-ai/dsh-llm",
  "@deepseek-ai/dsh-agent-loop",
  "@deepseek-ai/dsh-acp",
  "@deepseek-ai/dsh", // fallback for profiles that hoist the aggregator
];

/**
 * Absolute-path candidates for the dsh web profile's node_modules, where the
 * P2 subpackages actually live when hosted in-process by dsh web.
 *
 * The plugin gets `link`ed into the profile (node_modules/obsidian-dsh-acp ->
 * the source dir), so module resolution from the plugin file itself does NOT
 * reach `@deepseek-ai/dsh-llm` — that sits in the profile's node_modules:
 *   $DSH_HOME/profiles/web/node_modules/@deepseek-ai/
 *
 * We try DSH_HOME env first (dsh web sets it), then the conventional
 * ~/.dsh fallback, then generic module resolution (cwd / import.meta.url)
 * so the same code works for standalone test invocations.
 */
function p2CandidatePaths() {
  const dshHome =
    process.env.DSH_HOME ||
    (process.env.HOME ? `${process.env.HOME}/.dsh` : null);
  const home = process.env.HOME ? `${process.env.HOME}/.dsh` : null;
  // NOTE: root points at node_modules (WITHOUT the @deepseek-ai segment) —
  // pkg already carries the full "@deepseek-ai/xxx", so concatenating
  // `${root}/${pkg}` yields .../node_modules/@deepseek-ai/xxx/package.json.
  const roots = [
    dshHome && `${dshHome}/profiles/web/node_modules`,
    home && `${home}/profiles/web/node_modules`,
  ].filter(Boolean);

  const paths = [];
  for (const root of roots) {
    for (const pkg of P2_PROBES) {
      paths.push(`${root}/${pkg}/package.json`);
    }
  }
  return paths;
}

/** Fall back to generic module resolution from a few base paths. */
function moduleResolveRequire() {
  const bases = [
    process.cwd(),   // profile root when launched inside dsh web
    import.meta.url, // project source root (standalone)
  ];
  for (const base of bases) {
    try {
      const r = createRequire(base);
      r.resolve(`${P2_PROBES[0]}/package.json`); // smoke probe
      return r;
    } catch {
      // try next base
    }
  }
  return createRequire(import.meta.url);
}

/**
 * Read the installed dsh version. Tries absolute profile paths first (the
 * real P2 location when hosted by dsh web), then generic module resolution.
 * Returns null if none resolve.
 *
 * Why not just `@deepseek-ai/dsh/package.json`? In a pnpm web profile,
 * the aggregator (`dsh`) is typically NOT hoisted (only the subpackages
 * used by the loaded bundles are). Probing the subpackages is both the
 * real availability check AND the version source.
 *
 * @returns {string | null}
 */
export function detectDshVersion() {
  // 1. Absolute profile paths — the real P2 home when dsh web hosts in-process.
  for (const candidate of p2CandidatePaths()) {
    try {
      const raw = readFileSync(candidate, "utf8");
      return JSON.parse(raw).version;
    } catch {
      // try next candidate
    }
  }
  // 2. Generic module resolution (cwd / import.meta.url).
  const require = moduleResolveRequire();
  for (const pkg of P2_PROBES) {
    try {
      return require(`${pkg}/package.json`).version;
    } catch {
      // try next
    }
  }
  return null;
}

/**
 * Whether the current dsh exposes P2 long-runtime APIs. Concretely: whether
 * `@deepseek-ai/dsh-{agent-loop,llm,acp}` resolve, which 0.1.5-rc.1/rc.2
 * do not provide.
 *
 * Acceptance matrix (per S3):
 *   - 0.1.6-alpha.x  ✅ (re-introduced P2 subpackages in devDeps)
 *   - 0.1.7+         ✅ (assumed — devDeps promoted)
 *   - 0.2.0-rc.2     ✅ (measured — desktop App anchor; see a1-audit E3/C2)
 *   - 0.2.1-alpha.1  ✅ (measured 2026-10-09 — current host baseline)
 *   - 0.2.x+         ✅ (assumed for anything newer)
 *   - 0.1.5-rc.x     ❌ (P2 subpackages removed)
 *   - 0.1.4 and earlier ❌
 *
 * NOTE (a1-audit C2): this gate is intentionally broad. It answers "are the P2
 * subpackages resolvable", NOT "is the host core version exactly X". Hosts may
 * anchor different core versions (desktop App = 0.2.0-rc.2 vs web/CLI =
 * 0.2.1-alpha.1) and both are P2-capable. Use probeHostApiSurface() below to
 * surface finer-grained host contract drift.
 *
 * @returns {boolean}
 */
export function hasP2Apis() {
  const v = detectDshVersion();
  if (!v) return false;
  return (
    /^0\.1\.6-alpha/.test(v) ||
    /^0\.1\.[7-9]/.test(v) ||
    /^0\.[2-9]/.test(v) ||
    /^1\./.test(v)
  );
}

/**
 * Human-readable reason P2 APIs are unavailable. Null when available.
 *
 * @returns {string | null}
 */
export function p2UnavailableReason() {
  const v = detectDshVersion();
  if (!v) return "no @deepseek-ai/dsh-* subpackages resolvable";
  if (hasP2Apis()) return null;
  return `dsh ${v} does not expose P2 long-runtime APIs (need 0.1.6-alpha.1+; see [[DSH工具/dsh-0.1.6-alpha.1版本变更与插件兼容性]])`;
}

// ---- host API surface probe (a1-audit G2, 0.2.1-alpha.1 适配) ---------------
//
// WHY THIS EXISTS:
// long-runtime.mjs leans on host internals that are NOT part of dsh's public
// plugin contract:
//   - the `agent/pre-step` waterfall event (lib/long-runtime.mjs:183-184)
//   - `ctx.systemPrompt.assemble()` (lib/long-runtime.mjs:489-500)
// Both are consumed behind "never throws" best-effort fallbacks, so if upstream
// renames or drops either, the plugin does NOT error — it degrades silently and
// only surfaces later as a distant symptom ("the LLM never sees tools" / no
// tool_call frames). See [[dsh新建会话失败-prompt-section重复注册]] §四.2:
// silencing one fail-closed contract check just moves the explosion point and
// the new error lands further from the root cause.
//
// This probe makes such drift OBSERVABLE. It never throws and never blocks a
// boot — missing markers are reported, not enforced. Two independent halves:
//   - static : source markers in the host package tree (works without a ctx)
//   - runtime: service/method presence on the live cordis ctx (when supplied)
// The static half is best-effort: when host files cannot be read it reports
// "unknown" rather than pretending "ok".

/** Host source markers the plugin's long-runtime depends on. */
const HOST_API_MARKERS = [
  { id: "host:agent/pre-step", pkg: "dsh-agent-loop", file: "lib/index.js", marker: "agent/pre-step" },
  { id: "host:systemPrompt.assemble", pkg: "dsh-system-prompt", file: "lib/index.js", marker: "async assemble(" },
];

/**
 * node_modules roots that may carry `@deepseek-ai/*` for the *host* (i.e. not
 * the plugin's own deps). Covers the profile layout used by `dsh web` and the
 * global CLI install. Kept separate from p2CandidatePaths() because the host
 * marker packages are not always directly visible under the profile root —
 * pnpm may hoist them into `.pnpm` only (see a1-audit conflict C4).
 *
 * @returns {string[]}
 */
function hostNodeModuleRoots() {
  const dshHome =
    process.env.DSH_HOME ||
    (process.env.HOME ? `${process.env.HOME}/.dsh` : null);
  const home = process.env.HOME ? `${process.env.HOME}/.dsh` : null;
  const npmGlobal = process.env.HOME
    ? `${process.env.HOME}/.npm-global/lib/node_modules/@deepseek-ai/dsh/node_modules`
    : null;
  return [
    dshHome && `${dshHome}/profiles/web/node_modules`,
    home && `${home}/profiles/web/node_modules`,
    npmGlobal,
  ].filter((p) => typeof p === "string" && p.length > 0);
}

/** Static half: look for each marker in the resolvable host source. */
function probeStaticMarkers() {
  return HOST_API_MARKERS.map((m) => {
    for (const root of hostNodeModuleRoots()) {
      const path = `${root}/@deepseek-ai/${m.pkg}/${m.file}`;
      try {
        const src = readFileSync(path, "utf8");
        return {
          id: m.id,
          verdict: src.includes(m.marker) ? "ok" : "missing",
          detail: `${path} (${src.includes(m.marker) ? "marker found" : `marker "${m.marker}" absent`})`,
        };
      } catch {
        // not under this root — try the next one
      }
    }
    return { id: m.id, verdict: "unknown", detail: "host source not resolvable from profile/global roots" };
  });
}

/** Runtime half: services/methods on the live cordis ctx, when available. */
function probeRuntimeSurface(ctx) {
  if (!ctx) return [];
  const checks = [
    ["ctx.systemPrompt.assemble", () => typeof ctx.systemPrompt?.assemble === "function"],
    ["ctx.tools.wireSchemas", () => typeof ctx.tools?.wireSchemas === "function"],
  ];
  return checks.map(([id, getter]) => {
    let verdict = "missing";
    try {
      verdict = getter() ? "ok" : "missing";
    } catch {
      verdict = "unknown";
    }
    return { id, verdict, detail: "live cordis ctx" };
  });
}

/**
 * Probe the host API surface the plugin depends on.
 *
 * @param {object|null} [ctx] optional live cordis ctx (adds runtime checks)
 * @returns {{dshVersion: string|null, checks: Array<{id:string,verdict:string,detail:string}>, missing: string[], unknown: string[], ok: boolean}}
 */
export function probeHostApiSurface(ctx = null) {
  const checks = [...probeStaticMarkers(), ...probeRuntimeSurface(ctx)];
  const missing = checks.filter((c) => c.verdict === "missing").map((c) => c.id);
  const unknown = checks.filter((c) => c.verdict === "unknown").map((c) => c.id);
  return {
    dshVersion: detectDshVersion(),
    checks,
    missing,
    unknown,
    ok: missing.length === 0,
  };
}

/**
 * One-line human-readable summary of probeHostApiSurface() for boot logs.
 *
 * @param {object|null} [ctx]
 * @returns {string}
 */
export function hostApiSurfaceSummary(ctx = null) {
  const r = probeHostApiSurface(ctx);
  const head = `host API surface (dsh ${r.dshVersion ?? "unresolved"})`;
  if (r.missing.length === 0 && r.unknown.length === 0) return `${head}: OK`;
  const parts = [];
  if (r.missing.length > 0) parts.push(`missing: ${r.missing.join(", ")}`);
  if (r.unknown.length > 0) parts.push(`unverified: ${r.unknown.join(", ")}`);
  return `${head}: drift — ${parts.join("; ")}`;
}

// ---- 0.3.0 工具帧修复 (Path A) ---------------------------------------------
// dsh 0.1.7-rc.1 introduced `dsh --profile headless --json`, which emits
// newline-delimited run events (session / status / text / tool_call /
// tool_result / final). 0.1.6-alpha.x and earlier omit the flag — older dsh
// builds only support plain-text stdout, which is structurally incapable of
// producing tool_call frames. See v2 plan §5.5 0.3.0 工具帧修复 (Path A).
//
// Probe via `dsh --profile headless --help` once (cached). The flag check is
// substring-based because dsh's help output formats the option list per line
// (`--json             write newline-delimited...`). Spawning once on first
// call is fine — the result is memoized on the module-level `jsonCache`.

// t50: 缓存按 profile 分桶。原实现用单一布尔缓存 + 硬编码 --profile headless，
// 导致探测结论被跨 profile 复用（本机 DSH_PROFILE=web 时仍按 headless 探测）。
const jsonCacheByProfile = new Map();

/**
 * Whether the installed dsh supports `dsh --profile headless --json`
 * (newline-delimited run events). Memoized after the first call.
 *
 * Probe strategy: spawn `dsh --profile headless --help` synchronously once
 * and grep stdout+stderr for the literal `--json` token. The probe itself
 * is fast (~50 ms in practice) and dsh never prints `--json` to help unless
 * the flag is real — false positives are essentially impossible without a
 * dsh bug.
 *
 * Returns `false` on any spawn failure (binary missing / non-zero exit /
 * timeout). This intentionally degrades to the plain-text fallback path
 * rather than crashing the spawn caller.
 *
 * @returns {boolean}
 */
export function hasHeadlessJson(profile = process.env.DSH_PROFILE || "headless") {
  const key = String(profile);
  if (jsonCacheByProfile.has(key)) return jsonCacheByProfile.get(key);
  let ok = false;
  try {
    // t50 两处修正：
    //  ① **profile 跟随实际** —— 原实现硬编码 ["--profile","headless","--help"]，
    //     而 spawn 路径用的是 DSH_PROFILE；跨 profile 复用探测结论会产生误判。
    //  ② **由「文本嗅探」改为「真实试跑该 flag」** —— 原实现只 grep help 文本里有没有
    //     `--json`，但「help 里提到」≠「真实调用被接受」。现在直接跑
    //     `dsh --profile <profile> --json --help`，要求 exit 0 且输出不含
    //     "unknown option"，否则判为不支持。
    const r = spawnSync("dsh", ["--profile", key, "--json", "--help"], {
      encoding: "utf8",
      timeout: 5000,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const blob = `${r.stdout || ""}${r.stderr || ""}`;
    ok = r.status === 0 && !/unknown option/i.test(blob);
  } catch {
    ok = false;
  }
  jsonCacheByProfile.set(key, ok);
  return ok;
}

/**
 * Reset the cached probe (test helper — lets unit tests force re-probe after
 * stubbing `spawnSync`). Not used by production code.
 */
export function _resetHeadlessJsonCache(profile = null) {
  if (profile === null) jsonCacheByProfile.clear();
  else jsonCacheByProfile.delete(String(profile));
}