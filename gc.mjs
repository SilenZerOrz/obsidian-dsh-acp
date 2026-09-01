// gc.mjs — Obsidian 会话垃圾回收（GC）
//
// 背景：Obsidian Agent Client 的删除按钮只删它本地 sessions/<id>.json 与
// savedSessions，从不发 ACP session/delete，导致 adapter 自己的持久索引和
// 磁盘归档（~/.dsh-acp + ~/.dsh/dsh-acp-archives）残留 → session/list 复活。
//
// 本模块让 adapter 以 Obsidian 本地 sessions 目录为"权威已存在清单"对账：
//  adapter 索引里存在、但 Obsidian 本地 sessions 无记录、且 adapter 有磁盘
//  归档的会话 → 判定为用户在 Obsidian 删除 → 从 adapter 索引 + 磁盘同步清理。
//
// 设计原则（版本无关，不依赖任何 dsh 版本特有的 API）：
//  - 只读 Obsidian 的 agent-client sessions 目录做对账，绝不读 dsh 内部。
//  - 严格误删保护：Obsidian sessions 目录里还存在的会话，绝不清。
//  - 只清理 "adapter 自己有磁盘归档 + Obsidian 已删" 的孤儿。
//
// 配置：
//  - DSH_ACP_GC=off                关闭 GC（默认自动探测 + 自动对账）
//  - DSH_ACP_GC_OBSIDIAN_DIRS      额外指定的 agent-client sessions 目录（逗号分隔）
//  - DSH_ACP_GC_REPORT_ONLY=1      只报告不动手（dry-run）
//  - DSH_ACP_GC_VERBOSE=1          list 时把清理/检测情况打印到 stderr 日志

import {
  existsSync,
  readdirSync,
  readFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  deleteSession,
  allSessions,
  dshHome,
  encodeWorkspace,
} from "./archive-store.mjs";

export const GC_ENABLED = process.env.DSH_ACP_GC !== "off";
const REPORT_ONLY = process.env.DSH_ACP_GC_REPORT_ONLY === "1";
const VERBOSE = process.env.DSH_ACP_GC_VERBOSE === "1";
// 保守模式：仅清理 "adapter 有磁盘归档 + Obsidian 已删" 的孤儿；否则清
// "adapter 索引存在 + Obsidian 已删" 的所有孤儿（session/list 读索引即复活）。
const NEED_ARCHIVE = process.env.DSH_ACP_GC_NEED_ARCHIVE === "1";
const log = (...a) => { if (VERBOSE) { try { console.error("[dsh-acp gc]", ...a); } catch {} } };

const COMMON_VAULT_ROOTS = [
  join(homedir(), "Documents"),
  join(homedir(), "文档"),
];

function isAgentSessionsDir(p) {
  return (
    /[\\/]\.obsidian[\\/]plugins[\\/]agent-client[\\/]sessions$/.test(p) &&
    (() => { try { return existsSync(p); } catch { return false; } })()
  );
}

/**
 * 探测 Obsidian agent-client sessions 目录（GC 对账源）。
 * 优先级：显式配置 DSH_ACP_GC_OBSIDIAN_DIRS > 常见 vault 位置自动扫描。
 * 返回绝对路径数组（去重、必须存在）。
 */
export function detectObsidianSessionsDirs() {
  const found = [];
  const pushUnique = (p) => { if (p && isAgentSessionsDir(p) && !found.includes(p)) found.push(p); };

  if (process.env.DSH_ACP_GC_OBSIDIAN_DIRS) {
    for (const d of process.env.DSH_ACP_GC_OBSIDIAN_DIRS.split(",")) {
      pushUnique(d.trim());
    }
  }
  if (GC_ENABLED) {
    for (const root of COMMON_VAULT_ROOTS) {
      let entries = [];
      try { entries = readdirSync(root); } catch { continue; }
      for (const e of entries) {
        pushUnique(join(root, e, ".obsidian", "plugins", "agent-client", "sessions"));
      }
    }
  }
  return found;
}

/** 收集一组 Obsidian sessions 目录里的"现存 sessionId"集合。 */
export function collectObsidianSessionIds(dirs) {
  const ids = new Set();
  for (const dir of dirs) {
    let entries = [];
    try { entries = readdirSync(dir); } catch { continue; }
    for (const f of entries) {
      if (!f.endsWith(".json")) continue;
      ids.add(f.replace(/\.json$/, ""));
      try {
        const j = JSON.parse(readFileSync(join(dir, f), "utf8"));
        if (j && typeof j.sessionId === "string") ids.add(j.sessionId);
      } catch { /* 文件名已足够 */ }
    }
  }
  return ids;
}

/** 磁盘上该会话的归档目录（双 root）是否至少存在一个。 */
export function hasArchiveOnDisk(rec) {
  const enc = encodeWorkspace(rec.cwd);
  const root = dshHome();
  const name = rec.archive ?? rec.id;
  return (
    (() => { try { return existsSync(join(root, "dsh-acp-archives", enc, name)); } catch { return false; } })() ||
    (() => { try { return existsSync(join(root, "sessions", enc, name)); } catch { return false; } })()
  );
}

/**
 * GC 主入口：对账并清理孤儿。
 * @param {string[]} [obsidianDirs] 已探测到的 sessions 目录；缺省自动探测
 * @returns {{enabled:boolean, dirs:string[], removed:string[], reportOnly:boolean, skippedSymlink:string[]}}
 */
export function runGC(obsidianDirs = detectObsidianSessionsDirs()) {
  if (!GC_ENABLED) return { enabled: false, dirs: [], removed: [], reportOnly: REPORT_ONLY };
  const obsidianIds = collectObsidianSessionIds(obsidianDirs);
  const removed = [];

  for (const rec of allSessions()) {
    const id = rec.id;
    if (!rec || !rec.cwd) continue;
    // 误删保护：Obsidian 现在还显示的（本地 sessions 有记录）→ 绝不清
    if (obsidianIds.has(id)) continue;
    // 保守模式才要求"adapter 有磁盘归档"；默认清理所有不在 Obsidian 的索引孤儿
    if (NEED_ARCHIVE && !hasArchiveOnDisk(rec)) continue;
    removed.push(id);
    try {
      deleteSession(id);
      log(`cleaned orphan ${id}`);
    } catch (e) { log(`clean ${id} failed: ${e.message}`); }
  }
  return { enabled: true, dirs: obsidianDirs, removed, reportOnly: REPORT_ONLY };
}

/** list 前调用的便捷封装：自动探测 + GC，返回报告；异常不影响主流程。 */
export function gcBeforeList() {
  try {
    return runGC();
  } catch (e) {
    log(`gc error: ${e.message}`);
    return { enabled: true, dirs: [], removed: [], error: String(e && e.message || e) };
  }
}
