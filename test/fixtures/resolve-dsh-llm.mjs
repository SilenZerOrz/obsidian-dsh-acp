// test/fixtures/resolve-dsh-llm.mjs — 解析 @deepseek-ai/dsh-llm 的位置（去写死）。
//
// 为什么需要它：本仓不直接依赖 dsh-llm（它是 dsh 宿主的一部分），
// `require.resolve("@deepseek-ai/dsh-llm")` 在本仓恒为 MODULE_NOT_FOUND。
// 过去 fixtures 里写死了某台机器的绝对路径 —— 换机器 / 换 npm prefix 立刻炸。
//
// 解析顺序（首个命中即用）：
//   ① env `DSH_ACP_DSH_LLM`                —— 显式覆盖（指向 dsh-llm 的 lib/index.js 或其包根）
//   ② 本仓 Node 解析                       —— createRequire(import.meta.url).resolve(...)
//   ③ `${DSH_HOME:-~/.dsh}/profiles/node_modules/...`  —— dsh profile 的共享 node_modules
//   ④ 全局 dsh 安装                        —— `npm root -g` 反推 + `which dsh`
//   ⑤ 全部未中 → 抛 DshLlmNotFoundError（文案给可执行提示）
//
// 自检：`node test/fixtures/resolve-dsh-llm.mjs --selfcheck`
//   → 打印 resolved=<绝对路径> 与 source=<①..⑤>；**绝不打印任何 key**。

import { createRequire } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname, isAbsolute } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const PKG = "@deepseek-ai/dsh-llm";
const REL = `${PKG.replace("/", "/")}/lib/index.js`;
/** dsh-llm 的相对子路径（包根 → 入口）。 */
const ENTRY_REL = "lib/index.js";

/** Thrown when no dsh-llm install can be located. */
export class DshLlmNotFoundError extends Error {
  constructor(attempted) {
    super(
      `cannot locate ${PKG}.\n` +
      `Fix one of:\n` +
      `  - install dsh globally:  npm i -g @deepseek-ai/dsh   (then re-run)\n` +
      `  - point at it directly:  export DSH_ACP_DSH_LLM=/abs/path/to/${PKG}\n` +
      `    (accepts either the package root or its ${ENTRY_REL})\n` +
      `  - or make it resolvable from this repo (pnpm/npm install the dsh packages)\n` +
      `Attempted:\n` + attempted.map((s, i) => `  ${i + 1}. ${s}`).join("\n"),
    );
    this.name = "DshLlmNotFoundError";
    this.attempted = attempted;
  }
}

/** 把「包根」或「入口文件」统一成入口文件的绝对路径；不存在返回 null。 */
function toEntryPath(p) {
  if (!p || typeof p !== "string") return null;
  if (!isAbsolute(p)) return null;
  if (p.endsWith(`/${ENTRY_REL}`) || p.endsWith(`\\${ENTRY_REL}`)) {
    return existsSync(p) ? p : null;
  }
  // 当作包根
  const entry = join(p, ENTRY_REL);
  return existsSync(entry) ? entry : null;
}

/** 从 package.json 的 exports["."] 里取入口（若存在），避免死认 lib/index.js。 */
function entryFromPackageRoot(root) {
  const direct = toEntryPath(root);
  if (direct) return direct;
  try {
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    const ex = pkg.exports;
    const target = typeof ex === "string" ? ex : ex?.["."];
    const spec = typeof target === "string" ? target : target?.import ?? target?.default;
    if (typeof spec === "string") {
      const p = join(root, spec);
      if (existsSync(p)) return p;
    }
  } catch { /* fall through */ }
  return null;
}

/** npm 全局根（失败返回 null；永不抛）。 */
function npmGlobalRoot() {
  try {
    const out = execFileSync("npm", ["root", "-g"], {
      encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
    });
    const p = String(out).trim();
    return p || null;
  } catch {
    return null;
  }
}

/** `which dsh` 反推：<prefix>/bin/dsh → <prefix>/lib/node_modules。 */
function dshBinGlobalRoot() {
  try {
    const out = execFileSync("which", ["dsh"], {
      encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
    });
    const bin = String(out).trim();
    if (!bin) return null;
    // <prefix>/bin/dsh → <prefix>/lib/node_modules
    return join(dirname(dirname(bin)), "lib", "node_modules");
  } catch {
    return null;
  }
}

/**
 * Resolve the absolute path to dsh-llm's entry file.
 *
 * @param {{ env?: NodeJS.ProcessEnv }} [opts]
 * @returns {{ path: string, source: string }}
 */
export function resolveDshLlmPath(opts = {}) {
  const env = opts.env ?? process.env;
  const attempted = [];

  // ① explicit env override
  const envOverride = env.DSH_ACP_DSH_LLM;
  if (envOverride) {
    attempted.push(`env DSH_ACP_DSH_LLM=${envOverride}`);
    const hit = entryFromPackageRoot(envOverride);
    if (hit) return { path: hit, source: "① env DSH_ACP_DSH_LLM" };
  } else {
    attempted.push("env DSH_ACP_DSH_LLM=<unset>");
  }

  // ② Node resolution from THIS fixture
  try {
    const req = createRequire(import.meta.url);
    const resolved = req.resolve(`${PKG}/${ENTRY_REL}`);
    attempted.push(`require.resolve("${PKG}/${ENTRY_REL}") → ${resolved}`);
    if (existsSync(resolved)) return { path: resolved, source: "② Node resolution (repo)" };
  } catch (e) {
    attempted.push(`require.resolve("${PKG}/${ENTRY_REL}") → ${e?.code ?? e?.message ?? "failed"}`);
  }

  // ③ dsh profile's shared node_modules
  try {
    const home = env.DSH_HOME || join(homedir(), ".dsh");
    const cand = join(home, "profiles", "node_modules", PKG);
    attempted.push(`dsh profiles node_modules → ${cand}`);
    const hit = entryFromPackageRoot(cand);
    if (hit) return { path: hit, source: "③ ${DSH_HOME}/profiles/node_modules" };
  } catch (e) {
    attempted.push(`dsh profiles node_modules → ${e?.message ?? "failed"}`);
  }

  // ④ global dsh install (npm root -g, then `which dsh` fallback)
  for (const [label, getRoot] of [
    ["npm root -g", npmGlobalRoot],
    ["which dsh", dshBinGlobalRoot],
  ]) {
    try {
      const root = getRoot();
      if (!root) {
        attempted.push(`${label} → <none>`);
        continue;
      }
      // 两个候选：全局根直接含 dsh-llm，或 dsh 包内的嵌套 node_modules
      const candidates = [
        join(root, PKG),
        join(root, "@deepseek-ai", "dsh", "node_modules", PKG),
      ];
      for (const cand of candidates) {
        attempted.push(`${label} → ${cand}`);
        const hit = entryFromPackageRoot(cand);
        if (hit) return { path: hit, source: `④ global dsh install (${label})` };
      }
    } catch (e) {
      attempted.push(`${label} → ${e?.message ?? "failed"}`);
    }
  }

  // ⑤ give up
  throw new DshLlmNotFoundError(attempted);
}

/**
 * Load dsh-llm's module namespace (same resolution as resolveDshLlmPath).
 *
 * @param {{ env?: NodeJS.ProcessEnv }} [opts]
 * @returns {Promise<any>}
 */
export async function loadDshLlm(opts = {}) {
  const { path } = resolveDshLlmPath(opts);
  return import(path);
}

// ---- selfcheck entry ------------------------------------------------------
const isSelfcheck = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]
  && process.argv.includes("--selfcheck");
if (isSelfcheck) {
  try {
    const { path, source } = resolveDshLlmPath();
    // 只打印路径与来源；**绝不打印任何 key / env 值**
    console.log(`resolved=${path}`);
    console.log(`source=${source}`);
    process.exit(0);
  } catch (e) {
    console.error(e?.message ?? String(e));
    process.exit(1);
  }
}
