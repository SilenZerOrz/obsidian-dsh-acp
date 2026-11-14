// lib/context-window.mjs — P2-3: auto-resolve the context-window ceiling.
//
// WHY: ACP's `usage_update.size` is the DENOMINATOR of the client's
// "used / size" indicator. dsh's TokenUsage carries only token counts, so the
// adapter used to emit `size: 0` and Obsidian rendered "Infinity %". The
// stop-gap was the operator env `DSH_ACP_CONTEXT_WINDOW`; this module removes
// the need for it by resolving the ceiling the way the host itself does.
//
// Resolution order (highest first — the caller applies env BEFORE this):
//   1. the profile's own declaration: `llm-pi-ai.providers.<p>.models[].contextWindow`
//      — the same field dsh-llm-pi-ai reads (`lib/index.js:694`, "entry.contextWindow
//      ?? base?.contextWindow ?? request.defaultContextWindow");
//   2. the profile's `defaultContextWindow` (route-level override);
//   3. the compiled default of the INSTALLED `dsh-llm-pi-ai` / `dsh-llm-deepseek`
//      (their `DEFAULT_CONTEXT_WINDOW` constant) — i.e. the exact number the host
//      would use for a model whose profile entry omits `contextWindow`;
//   4. none ⇒ the caller keeps `0` ("unknown").
//
// Step 3 matters on this machine: the `jl-token` provider declares no
// `contextWindow` for any model, so steps 1-2 yield nothing while the host still
// runs a 1e6 window. Reading dsh's own constant keeps the denominator equal to
// what the host enforces rather than inventing a number here.
//
// Everything is injectable (`env`, `profileText`, `dshDefault`) so unit tests are
// deterministic and never depend on the developer's ~/.dsh.

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { parseProviderCatalog } from "./settings-provider-catalog.mjs";

/** Profile candidates, in order. Mirrors the runtime's own profile choice. */
const PROFILE_CANDIDATES = ["web", "headless", "desktop"];

/** Packages whose compiled `DEFAULT_CONTEXT_WINDOW` the host falls back to. */
const DSH_LLM_PACKAGES = ["dsh-llm-pi-ai", "dsh-llm-deepseek"];

/** (dshHome|profile|provider|model) → { size, source } | null */
const cache = new Map();

/** Test hook: forget every cached resolution. */
export function resetContextWindowCache() {
  cache.clear();
}

function dshHomeOf(env) {
  return (env.DSH_HOME && env.DSH_HOME.trim()) || join(homedir(), ".dsh");
}

/** Candidate profile dirs: DSH_PROFILE first (when set), then the defaults. */
function profileNames(env) {
  const out = [];
  if (env.DSH_PROFILE && env.DSH_PROFILE.trim()) out.push(env.DSH_PROFILE.trim());
  for (const p of PROFILE_CANDIDATES) if (!out.includes(p)) out.push(p);
  return out;
}

/** Read one profile's cordis.patch.yml; null when absent/unreadable. */
function readProfileText(file) {
  try {
    if (!existsSync(file)) return null;
    return readFileSync(file, "utf8").replace(/^﻿/, "");
  } catch {
    return null;
  }
}

/** `defaultContextWindow: <n>` anywhere in the text (route-level override). */
function parseDefaultContextWindow(text) {
  const m = /^\s*defaultContextWindow:\s*(\d+)\s*$/m.exec(text ?? "");
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/**
 * Locate a dsh-llm package's lib/index.js among the places dsh installs into.
 *
 * Deliberately dependency-free and non-fatal: this is a best-effort probe of an
 * OPTIONAL upstream package, so every miss returns null instead of throwing.
 */
function findDshLlmLib(pkg, env) {
  const home = dshHomeOf(env);
  const candidates = [
    fileURLToPath(new URL(`../node_modules/@deepseek-ai/${pkg}/lib/index.js`, import.meta.url)),
    join(home, "profiles", "node_modules", "@deepseek-ai", pkg, "lib", "index.js"),
    join(home, "node_modules", "@deepseek-ai", pkg, "lib", "index.js"),
  ];
  for (const p of candidates) if (existsSync(p)) return p;
  return null;
}

/**
 * The host's compiled fallback window (`DEFAULT_CONTEXT_WINDOW = 1e6`).
 *
 * @returns {{ size: number, from: string } | null}
 */
function dshCompiledDefault(env) {
  for (const pkg of DSH_LLM_PACKAGES) {
    const lib = findDshLlmLib(pkg, env);
    if (!lib) continue;
    const text = readProfileText(lib);
    if (!text) continue;
    const m = /DEFAULT_CONTEXT_WINDOW\s*=\s*(\d+(?:e\d+)?)/i.exec(text);
    if (!m) continue;
    const n = Number(m[1]);
    if (Number.isFinite(n) && n > 0) return { size: Math.round(n), from: `${pkg}:DEFAULT_CONTEXT_WINDOW` };
  }
  return null;
}

/**
 * Resolve the ceiling for one `provider/model` pair.
 *
 * @param {object} [opts]
 * @param {string} [opts.provider]     dsh provider id (e.g. "jl-token")
 * @param {string} [opts.model]        bare model id (e.g. "gemini-2.5-pro")
 * @param {NodeJS.ProcessEnv} [opts.env]
 * @param {string} [opts.profileText]  inject a profile body (tests) — skips fs
 * @param {number|null} [opts.dshDefault] inject the compiled default (tests)
 * @returns {{ size: number, source: string } | null} null = unknown
 */
export function resolveContextWindowCeiling(opts = {}) {
  const env = opts.env ?? process.env;
  const provider = typeof opts.provider === "string" ? opts.provider : null;
  const model = typeof opts.model === "string" ? opts.model : null;

  const cacheKey = [
    opts.profileText ? "inline" : dshHomeOf(env),
    opts.profileText ? "" : profileNames(env).join(","),
    provider ?? "",
    model ?? "",
    typeof opts.dshDefault === "number" ? opts.dshDefault : "",
  ].join("|");
  if (!opts.profileText && cache.has(cacheKey)) return cache.get(cacheKey);

  const result = (() => {
    // ---- 1/2. profile-declared ceilings ----
    if (provider && model) {
      const texts = opts.profileText !== undefined
        ? [{ name: "inline", text: opts.profileText }]
        : profileNames(env).map((name) => ({
            name,
            text: readProfileText(join(dshHomeOf(env), "profiles", name, "cordis.patch.yml")),
          }));
      for (const { name, text } of texts) {
        if (!text) continue;
        const hit = parseProviderCatalog(text).find(
          (e) => e.provider === provider && e.model === model,
        );
        if (hit && typeof hit.contextWindow === "number") {
          return { size: hit.contextWindow, source: `profile:${name}:models[].contextWindow` };
        }
        const routeDefault = parseDefaultContextWindow(text);
        if (routeDefault !== null) {
          return { size: routeDefault, source: `profile:${name}:defaultContextWindow` };
        }
      }
    }

    // ---- 3. the host's compiled default ----
    const compiled = typeof opts.dshDefault === "number"
      ? (opts.dshDefault > 0 ? { size: Math.round(opts.dshDefault), from: "injected" } : null)
      : dshCompiledDefault(env);
    if (compiled) return { size: compiled.size, source: `dsh:${compiled.from}` };

    // ---- 4. unreachable ----
    return null;
  })();

  if (!opts.profileText) cache.set(cacheKey, result);
  return result;
}

/**
 * Convenience: just the number, or null.
 * @param {object} [opts] same as resolveContextWindowCeiling
 * @returns {number|null}
 */
export function contextWindowFor(opts = {}) {
  const hit = resolveContextWindowCeiling(opts);
  return hit ? hit.size : null;
}
