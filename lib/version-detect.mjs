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
 *   - 0.2.x+         ✅ (assumed)
 *   - 0.1.5-rc.x     ❌ (P2 subpackages removed)
 *   - 0.1.4 and earlier ❌
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