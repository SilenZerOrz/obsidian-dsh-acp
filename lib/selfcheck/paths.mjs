// lib/selfcheck/paths.mjs — 路径 / vault 单一来源
//
// 2026-10-13 重建。基于现有 import 契约（lib/env-fix.mjs / lib/selfcheck/index.mjs /
// lib/selfcheck/cross-config-sync.mjs 的 import 语句）。零外部依赖。

import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

// ---- 基础 IO 包装（纯函数） ------------------------------------------------

export function isDir(p) {
  if (!p) return false;
  try { return statSync(p).isDirectory(); } catch { return false; }
}

export function isFile(p) {
  if (!p) return false;
  try { return statSync(p).isFile(); } catch { return false; }
}

export function readTextFile(p) {
  if (!p || !isFile(p)) return null;
  try { return readFileSync(p, "utf8"); } catch { return null; }
}

/** `~/.dsh/profiles/<name>`（绝对路径）。name 为空时返回 dshHome 本身。 */
export function profileDir(name, roots) {
  const base = roots?.dshHome ?? join(homedir(), ".dsh");
  if (!name) return base;
  return join(base, "profiles", name);
}

// ---- 根集合：dshHome / vault / home / npmPrefix / adapter / injected --------

/**
 * 解析所有相关根。env 透传是为了让"夹具注入"（`--root`）可改写。
 * @param {object} [opts]
 * @param {object} [opts.env]       process.env 兼容对象（默认 process.env）
 * @param {string} [opts.injected] 自定义根（用于 --root 夹具）
 * @returns {{
 *   injected: boolean, path: string, home: string, dshHome: string,
 *   obsidianDir: string, npmPrefix: string, adapter: string,
 *   homeConfig: string|null, vault: string|null,
 * }}
 */
export function resolveRoots(opts = {}) {
  const env = opts.env ?? process.env;
  const home = homedir();
  const dshHome = env.DSH_HOME || join(home, ".dsh");
  const npmPrefix = env.NPM_CONFIG_PREFIX || (process.platform === "win32"
    ? join(home, "AppData", "Roaming", "npm")
    : join(home, ".npm-global"));
  const obsidianDir = env.DSH_ACP_OBSIDIAN_DIR
    || (process.platform === "darwin" ? join(home, "Library", "Application Support", "obsidian")
       : process.platform === "win32" ? join(home, "AppData", "Roaming", "obsidian")
       : join(home, ".config", "obsidian"));
  const adapter = env.DSH_ACP_ADAPTER_PATH || process.cwd();
  const injected = !!opts.injected;
  const path = injected ? resolve(opts.injected) : dshHome;
  return {
    injected,
    path,
    home,
    dshHome: injected ? path : dshHome,
    obsidianDir,
    npmPrefix,
    adapter,
    homeConfig: null,
    vault: env.DSH_ACP_VAULT || null,
  };
}

// ---- 当前 adapter 路径（用于 doctor --gc 自指引） ---------------------------

/**
 * 当前 adapter 文件路径。优先 DSH_ACP_ADAPTER_PATH，否则按 import.meta 推断。
 * 推断失败时返回 process.cwd()/dsh-acp.mjs。
 */
export function adapterPath() {
  if (process.env.DSH_ACP_ADAPTER_PATH && isFile(process.env.DSH_ACP_ADAPTER_PATH)) {
    return process.env.DSH_ACP_ADAPTER_PATH;
  }
  try {
    const here = fileURLToPath(import.meta.url);
    // 假设 kernel 在 lib/selfcheck/paths.mjs
    return resolve(here, "..", "..", "..", "dsh-acp.mjs");
  } catch {
    return resolve(process.cwd(), "dsh-acp.mjs");
  }
}

// ---- Obsidian sessions 目录探测 ---------------------------------------------

/**
 * 探测 Obsidian 已知 session 目录的并集（macOS / Windows / Linux 通用）。
 * 返回 string[] 绝对路径。
 */
export function discoverObsidianSessionsDirs(roots) {
  const r = roots ?? resolveRoots();
  const candidates = [];
  const home = r.home;
  if (process.platform === "darwin") {
    candidates.push(join(home, "Library", "Application Support", "obsidian"));
    candidates.push(join(home, ".config", "obsidian"));
  } else if (process.platform === "win32") {
    candidates.push(join(home, "AppData", "Roaming", "obsidian"));
    candidates.push(join(home, ".config", "obsidian"));
  } else {
    candidates.push(join(home, ".config", "obsidian"));
  }
  // Obsidian plugin 数据目录（在 dshHome 下）
  candidates.push(join(r.dshHome, "plugins", "obsidian-dsh-acp"));
  return [...new Set(candidates.filter((d) => isDir(d)))];
}

// ---- root → 环境变量序列化（用于 spawn dsh 子进程） -------------------------

/**
 * 把 roots 转成 DSH_* 进程环境变量。spawn dsh 子进程时合并到 env。
 */
export function rootsToEnv(roots) {
  const r = roots ?? resolveRoots();
  return {
    DSH_HOME: r.dshHome,
    DSH_ACP_OBSIDIAN_DIR: r.obsidianDir,
    DSH_ACP_VAULT: r.vault ?? "",
    NPM_CONFIG_PREFIX: r.npmPrefix,
  };
}

// ---- vault 路径集合 ---------------------------------------------------------

/**
 * vault 路径集合。vault 字段在 roots 上，可为 null。
 * 返回 { vault: string|null, vaultConfig: string|null, vaultAgents: string|null }
 */
export function vaultPaths(roots) {
  const r = roots ?? resolveRoots();
  if (!r.vault) return { vault: null, vaultConfig: null, vaultAgents: null };
  const vaultConfig = join(r.vault, ".obsidian");
  const vaultAgents = join(vaultConfig, "agents");
  return {
    vault: r.vault,
    vaultConfig: isDir(vaultConfig) ? vaultConfig : null,
    vaultAgents: isDir(vaultAgents) ? vaultAgents : null,
  };
}
