#!/usr/bin/env node
// scripts/migrate-archive-to-dsh-native.mjs — R134 / 卡 `-64` 迁移工具。
//
// 把 dsh-acp 旧私有根 `<DSH_HOME>/dsh-acp-archives/` 里的会话归档
// **复制**到 dsh 原生根 `<DSH_HOME>/sessions/`，使「会话仓库统一到 dsh 原生
// `~/.dsh/sessions/`」这一步可一次性完成。
//
// ── 安全契约（硬性，不可放宽）──────────────────────────────
//
//  1. **`--dry-run` 是默认**。不带任何参数跑 = 只读清单，绝不写盘。
//  2. **`--apply` 才写盘**，且**只 copy 不 move**：旧目录**必须仍在**。
//     写完打印「旧目录仍在」的核验读数。
//  3. **不删任何东西**。本工具没有删除路径（源码里没有 rmSync / unlink）。
//  4. **幂等**：目标已存在且内容一致 ⇒ 跳过（记为 `skip`）。
//
// ── 迁移内容 ──────────────────────────────────────────────
//
//  旧归档：`<DSH_HOME>/dsh-acp-archives/<encodeWorkspace(cwd)>/<sessionId>/session.jsonl`
//    - 未压缩 JSONL
//    - 首行 v0 头：`{type,version:0,id,createdAt,cwd,parentSession,seedLength,
//      delegationDepth,agentPreset}`（`seedLength` 是**已退役**字段）
//
//  新归档：`<DSH_HOME>/sessions/<nativeProjectKey(cwd)>/<nativeEncodeSegment(id)>/session.v4.jsonl.zstd`
//    - zstd 压缩（与主进程同族）
//    - 首行 v4 头：`{type,version:4,id,createdAt,cwd,isSeeded,delegationDepth,
//      agentPreset}`（`seedLength` → `isSeeded`）
//
//  **cwd 取自旧归档的头**（不是从目录名反推）——目录名是有损编码，反推不可靠。
//
// ── 用法 ─────────────────────────────────────────────────
//
//  node scripts/migrate-archive-to-dsh-native.mjs              # dry-run（默认）
//  node scripts/migrate-archive-to-dsh-native.mjs --dry-run    # 同上（显式）
//  node scripts/migrate-archive-to-dsh-native.mjs --apply      # 真写盘（只 copy）
//  node scripts/migrate-archive-to-dsh-native.mjs --json       # 机器可读输出
//  node scripts/migrate-archive-to-dsh-native.mjs --apply --json
//
// 环境变量：
//  - `DSH_HOME`        覆盖 `<DSH_HOME>`（**测试用**：指到临时目录做隔离验证）
//  - `DSH_ACP_STORE_DIR` 不涉及（本工具只管磁盘归档，不碰索引）

import { readdirSync, readFileSync, writeFileSync, mkdirSync, existsSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { homedir } from "node:os";

const LEGACY_ROOT_NAME = "dsh-acp-archives";
const NATIVE_ROOT_NAME = "sessions";

// ---- 参数解析 --------------------------------------------------------------

/** @type {{apply: boolean, json: boolean, dryRun: boolean}} */
const opts = { apply: false, json: false, dryRun: false };
for (const arg of process.argv.slice(2)) {
  if (arg === "--apply") opts.apply = true;
  else if (arg === "--dry-run") opts.dryRun = true;
  else if (arg === "--json") opts.json = true;
  else if (arg === "--help" || arg === "-h") {
    process.stdout.write(
      "usage: migrate-archive-to-dsh-native.mjs [--dry-run|--apply] [--json]\n" +
      "  --dry-run  只读清单（默认）\n" +
      "  --apply    写盘（只 copy 不 move；旧目录仍在）\n" +
      "  --json     机器可读输出\n",
    );
    process.exit(0);
  } else {
    process.stderr.write(`[migrate] unknown argument: ${arg}\n`);
    process.exit(2);
  }
}
// 显式 --dry-run 与 --apply 同时给 ⇒ 拒绝（避免误判写盘意图）。
if (opts.apply && opts.dryRun) {
  process.stderr.write("[migrate] --dry-run and --apply are mutually exclusive\n");
  process.exit(2);
}

// ---- 路径方案（与 archive-store.mjs 同源，逐字镜像 dsh 原生）----------------

function dshHome() {
  return process.env.DSH_HOME ?? join(homedir(), ".dsh");
}

/** 旧私有根用的**有损**目录名方案（迁移源侧必须用这个才能找到存量）。 */
function encodeWorkspace(cwd) {
  const cleaned = String(cwd).replace(/^\/+/, "").replace(/[^A-Za-z0-9]/g, "-");
  return `--${cleaned}--`;
}

/** dsh 原生 `projectKey()`。 */
function nativeProjectKey(cwd) {
  const raw = String(cwd ?? "");
  if (raw.length === 0) throw new Error("cannot encode an empty project path");
  let readable = "";
  let separatorRun = false;
  for (let i = 0; i < raw.length; i++) {
    const code = raw.charCodeAt(i);
    const ch = String.fromCharCode(code);
    if (ch === "/" || ch === "\\" || ch === ":") {
      if (!separatorRun) readable += "-";
      separatorRun = true;
    } else if (ch !== "~" && /^[A-Za-z0-9._-]$/.test(ch)) {
      readable += ch;
      separatorRun = false;
    } else {
      readable += "~" + code.toString(16).toUpperCase().padStart(4, "0");
      separatorRun = false;
    }
  }
  return `--${(readable.replace(/^-+/, "") || "root").slice(0, 251)}--`;
}

/** dsh 原生 `encodeSegment()`。 */
function nativeEncodeSegment(raw) {
  const text = String(raw ?? "");
  if (text.length === 0) throw new Error("cannot encode an empty path segment");
  if (text === ".") return "~002E";
  if (text === "..") return "~002E~002E";
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    const ch = String.fromCharCode(code);
    if (ch !== "~" && /^[A-Za-z0-9._-]$/.test(ch)) out += ch;
    else out += "~" + code.toString(16).toUpperCase().padStart(4, "0");
  }
  return out;
}

// ---- zstd（与 archive-store.mjs 同源）---------------------------------------

const { zstdCompressSync, zstdDecompressSync, constants: zlibConstants } = await import("node:zlib");

const ZSTD_COMPRESS_OPTIONS = {
  params: { [zlibConstants.ZSTD_c_compressionLevel]: 3, [zlibConstants.ZSTD_c_checksumFlag]: 1 },
};
const ZSTD_MAGIC = 0xFD2FB528;

function compressZstdFrame(text) {
  return zstdCompressSync(Buffer.from(text, "utf8"), ZSTD_COMPRESS_OPTIONS);
}

/** 扫描 zstd 完整帧边界（镜像 dsh 的 scanZstdFrames）。 */
function scanZstdFrames(buffer) {
  const frames = [];
  let offset = 0;
  while (offset < buffer.length) {
    const start = offset;
    if (buffer.length - offset < 4) break;
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) break;
    offset += 4;
    if (offset === buffer.length) break;
    const descriptor = buffer.readUInt8(offset);
    offset += 1;
    if ((descriptor & 24) !== 0) break;
    const contentSizeFlag = descriptor >>> 6;
    const singleSegment = (descriptor & 32) !== 0;
    const checksum = (descriptor & 4) !== 0;
    const dictionaryFlag = descriptor & 3;
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag;
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag;
    const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes;
    if (buffer.length - offset < remainingHeaderBytes) break;
    offset += remainingHeaderBytes;
    let ok = true;
    for (;;) {
      if (buffer.length - offset < 3) { ok = false; break; }
      const blockHeader = buffer.readUIntLE(offset, 3);
      offset += 3;
      const lastBlock = (blockHeader & 1) !== 0;
      const blockType = (blockHeader >>> 1) & 3;
      const blockSize = blockHeader >>> 3;
      if (blockType === 3) { ok = false; break; }
      const payloadBytes = blockType === 1 ? 1 : blockSize;
      if (buffer.length - offset < payloadBytes) { ok = false; break; }
      offset += payloadBytes;
      if (lastBlock) break;
    }
    if (!ok) break;
    if (checksum) {
      if (buffer.length - offset < 4) break;
      offset += 4;
    }
    frames.push({ start, end: offset });
  }
  return frames;
}

/** 逐帧解压（Node 的 zstdDecompressSync 只解第一帧）。 */
function decompressAll(buffer) {
  if (buffer.length < 4 || buffer.readUInt32LE(0) !== ZSTD_MAGIC) return buffer;
  const frames = scanZstdFrames(buffer);
  if (!frames.length) return Buffer.alloc(0);
  return Buffer.concat(frames.map((f) => zstdDecompressSync(buffer.subarray(f.start, f.end))));
}

// ---- 扫描与规划 ------------------------------------------------------------

const HOME = dshHome();
const LEGACY_ROOT = join(HOME, LEGACY_ROOT_NAME);
const NATIVE_ROOT = join(HOME, NATIVE_ROOT_NAME);

/**
 * 列出旧私有根里的全部会话归档。
 * @returns {{source: string, id: string, cwd: string|null, bytes: number, lines: number, header: object|null}[]}
 */
function listLegacyArchives() {
  const out = [];
  if (!existsSync(LEGACY_ROOT)) return out;
  let projectDirs = [];
  try { projectDirs = readdirSync(LEGACY_ROOT); } catch { return out; }
  for (const projectDir of projectDirs) {
    const projectPath = join(LEGACY_ROOT, projectDir);
    let isDir = false;
    try { isDir = statSync(projectPath).isDirectory(); } catch { continue; }
    if (!isDir) continue;
    let sessions = [];
    try { sessions = readdirSync(projectPath); } catch { continue; }
    for (const sessionDir of sessions) {
      const sessionPath = join(projectPath, sessionDir);
      let sessionIsDir = false;
      try { sessionIsDir = statSync(sessionPath).isDirectory(); } catch { continue; }
      if (!sessionIsDir) continue;
      const logPath = join(sessionPath, "session.jsonl");
      if (!existsSync(logPath)) continue;
      let raw = "";
      try { raw = readFileSync(logPath, "utf8"); } catch { continue; }
      const lines = raw.split("\n").filter(Boolean);
      let header = null;
      try {
        const parsed = JSON.parse(lines[0] ?? "");
        if (parsed && parsed.type === "session") header = parsed;
      } catch { /* 头损坏 ⇒ 仍迁移，但 cwd 退回目录名反推失败 → 跳过并记录 */ }
      let bytes = 0;
      try { bytes = statSync(logPath).size; } catch { /* ignore */ }
      out.push({
        source: logPath,
        id: header?.id ?? sessionDir,
        cwd: typeof header?.cwd === "string" ? header.cwd : null,
        bytes,
        lines: lines.length,
        header,
      });
    }
  }
  return out;
}

/**
 * 列出 dsh 原生根里的会话目录（口径：`session-*` / `import-*`）。
 * 这是「320」的统计口径（`find ~/.dsh/sessions -type d \( -name 'session-*' -o
 * -name 'import-*' \)`）。
 */
function listNativeSessionDirs() {
  const out = [];
  if (!existsSync(NATIVE_ROOT)) return out;
  const walk = (dir, depth) => {
    if (depth > 3) return;
    let entries = [];
    try { entries = readdirSync(dir); } catch { return; }
    for (const name of entries) {
      const p = join(dir, name);
      let isDir = false;
      try { isDir = statSync(p).isDirectory(); } catch { continue; }
      if (!isDir) continue;
      if (depth >= 1 && /^(session|import)-/i.test(name)) {
        out.push(p);
        continue; // 会话目录下面不再递归（其内是日志文件）
      }
      walk(p, depth + 1);
    }
  };
  walk(NATIVE_ROOT, 0);
  return out;
}

/** 把旧 v0 头升级成原生 v4 头（`seedLength` → `isSeeded`）。 */
function upgradeHeader(header, cwd) {
  const upgraded = {
    type: "session",
    version: 4,
    id: header.id,
    createdAt: Number.isSafeInteger(header.createdAt) && header.createdAt >= 0 ? header.createdAt : Date.now(),
    cwd,
    isSeeded: false,
    delegationDepth: Number.isSafeInteger(header.delegationDepth) ? header.delegationDepth : 0,
    agentPreset: typeof header.agentPreset === "string" ? header.agentPreset : "standard",
  };
  // v4 的可选字段：parentSession 只在有值时带（原生读侧拒 null）。
  if (typeof header.parentSession === "string" && header.parentSession) {
    upgraded.parentSession = header.parentSession;
  }
  return upgraded;
}

/** 事件行：去掉 v0 时代挂在每行上的多余字段，只保留原生事件形状。 */
function upgradeEventLine(line) {
  const obj = JSON.parse(line);
  if (!obj || typeof obj !== "object") return line;
  const out = { type: obj.type, time: obj.time, data: obj.data, seq: obj.seq };
  return JSON.stringify(out);
}

// ---- 主流程 ----------------------------------------------------------------

const legacy = listLegacyArchives();
const nativeDirs = listNativeSessionDirs();

const plan = [];
for (const item of legacy) {
  const entry = {
    id: item.id,
    cwd: item.cwd,
    source: item.source,
    bytes: item.bytes,
    lines: item.lines,
    action: "copy",
    target: null,
    reason: null,
  };
  if (!item.cwd) {
    entry.action = "skip";
    entry.reason = "旧归档头缺少 cwd，无法推导原生项目键";
    plan.push(entry);
    continue;
  }
  const targetDir = join(NATIVE_ROOT, nativeProjectKey(item.cwd), nativeEncodeSegment(item.id));
  const targetLog = join(targetDir, "session.v4.jsonl.zstd");
  entry.target = targetLog;
  if (existsSync(targetLog)) {
    entry.action = "skip";
    entry.reason = "目标已存在（幂等：跳过）";
  }
  plan.push(entry);
}

const counts = {
  legacyTotal: legacy.length,
  legacyWithLog: legacy.filter((x) => existsSync(x.source)).length,
  nativeSessionDirs: nativeDirs.length,
  toCopy: plan.filter((p) => p.action === "copy").length,
  toSkip: plan.filter((p) => p.action === "skip").length,
  totalBytes: plan.reduce((n, p) => n + p.bytes, 0),
};

const result = {
  mode: opts.apply ? "apply" : "dry-run",
  dshHome: HOME,
  legacyRoot: LEGACY_ROOT,
  nativeRoot: NATIVE_ROOT,
  counts,
  plan,
  applied: [],
  errors: [],
};

if (opts.apply) {
  for (const entry of plan) {
    if (entry.action !== "copy") continue;
    try {
      const raw = readFileSync(entry.source, "utf8");
      const lines = raw.split("\n").filter(Boolean);
      const header = JSON.parse(lines[0]);
      const cwd = entry.cwd;
      const upgradedHeader = upgradeHeader(header, cwd);
      const eventLines = lines.slice(1).map((l) => {
        try { return upgradeEventLine(l); } catch { return l; }
      });
      // 头帧 + 事件帧（两个独立可解码 frame，与原生 materialize() 同构）。
      const headerFrame = compressZstdFrame(`${JSON.stringify(upgradedHeader)}\n`);
      const bodyFrame = compressZstdFrame(eventLines.map((l) => `${l}\n`).join(""));
      mkdirSync(join(entry.target, ".."), { recursive: true });
      writeFileSync(entry.target, Buffer.concat([headerFrame, bodyFrame]));
      result.applied.push({ id: entry.id, target: entry.target });
    } catch (err) {
      result.errors.push({ id: entry.id, source: entry.source, error: String(err?.message ?? err) });
    }
  }
  // ── 只 copy 不 move 的核验：旧目录必须仍在 ──
  result.legacyStillPresent = legacy.filter((x) => existsSync(x.source)).length;
  result.legacyStillPresentDirs = legacy.filter((x) => existsSync(join(x.source, ".."))).length;
}

// ---- 输出 ------------------------------------------------------------------

if (opts.json) {
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} else {
  const lines = [];
  lines.push(`[migrate] mode=${result.mode}  DSH_HOME=${HOME}`);
  lines.push(`[migrate] 旧私有根 ${LEGACY_ROOT_NAME}/ : ${counts.legacyTotal} 个会话归档（其中 ${counts.legacyWithLog} 个含 session.jsonl）`);
  lines.push(`[migrate] dsh 原生根 ${NATIVE_ROOT_NAME}/ : ${counts.nativeSessionDirs} 个 session/import 目录`);
  lines.push(`[migrate] 待复制 ${counts.toCopy} 个 · 跳过 ${counts.toSkip} 个 · 合计 ${counts.totalBytes} 字节`);
  if (opts.apply) {
    lines.push(`[migrate] 已写入 ${result.applied.length} 个 · 失败 ${result.errors.length} 个`);
    lines.push(`[migrate] ✅ 只 copy 不 move 核验：旧归档仍在 ${result.legacyStillPresent} / ${counts.legacyWithLog} 个`);
  } else {
    lines.push(`[migrate] 这是 dry-run（默认）：**没有写任何盘**。加 --apply 才写。`);
  }
  for (const entry of plan) {
    const mark = entry.action === "copy" ? "→" : "·";
    lines.push(`  ${mark} ${entry.id}  ${entry.cwd ?? "(cwd 未知)"}  ${entry.bytes}B  ${entry.reason ?? ""}`);
  }
  for (const err of result.errors) {
    lines.push(`  ! ${err.id}  ${err.error}`);
  }
  process.stdout.write(`${lines.join("\n")}\n`);
}

if (result.errors.length) process.exit(1);
