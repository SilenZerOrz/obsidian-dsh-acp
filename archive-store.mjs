// archive-store.mjs — persistent session store + DSH-format archive writer
// for dsh-acp.
//
// Two layers, both driven from this module:
//
//  1. A durable ACP session index (JSON) so ACP `session/list`, `list/load`,
//     `session/resume` and `session/fork` survive adapter restarts (this is
//     what makes Obsidian "reload session list" and "fork" actually work).
//
//  2. A best-effort writer that mirrors each completed ACP turn into a DSH
//     official archive at
//         <DSH_HOME>/sessions/<project-key>/<session-id>/session.v4.jsonl.zstd
//     using DeepSeek Harness' native event-log shape (zstd-compressed, native
//     v4 header) so the DSH web main process can read it back ("write ACP
//     sessions back into DSH web's own conversation archive").
//
// R134 / P3-ArchiveSync（0.4.2 W1）：归档目录统一到 dsh 原生 `~/.dsh/sessions/`。
// 关键点（全部经真机实测，见 docs/实施计划/0.4.2-会话仓库统一与双界面同步-实施计划.md）：
//   - 原生路径方案**不是**本仓旧的 `encodeWorkspace()`（`--a-b-c--`，有损替换），
//     而是 dsh-session-persistence-jsonl 的 `projectKey()`（`~XXXX` 转义 +
//     分隔符折叠）与 `encodeSegment()`。两套方案落在**不同命名空间**，混用
//     会让同一个 cwd 产生两个目录 ⇒ 读侧扫不到、写侧覆盖不到。
//   - 原生物理编码是 **zstd**（`session.v4.jsonl.zstd`），且原生 v4 头字段是
//     `{type,version,id,createdAt,isSeeded,delegationDepth}` + 可选
//     `{cwd,parentSession,origin,agentPreset}`。旧头的 `seedLength` 已退役
//     （原生读侧 `assertNoRetiredHeaderFields` 会拒），必须换掉。

import { mkdirSync, readdirSync, readFileSync, writeFileSync, existsSync, appendFileSync, renameSync, statSync, rmSync } from "node:fs";
import { join, sep } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import { zstdCompressSync, zstdDecompressSync, constants as zlibConstants } from "node:zlib";

// ---- Paths / encoding ----------------------------------------------------

const STORE_FILE_NAME = "dsh-acp-sessions.json";

/**
 * DSH 原生 Session 格式版本（dsh-session 的 SESSION_FORMAT_VERSION）。
 * 原生物理文件名 = `session.v<N>.jsonl` + 压缩后缀 `.zstd`。
 * 跟随宿主版本推进；本仓只写当前版本，宿主读侧负责向下迁移。
 */
export const NATIVE_SESSION_FORMAT_VERSION = 4;

/** 压缩后的原生事件日志文件名（dsh-session-format 的 generationLogFilename）。 */
export const NATIVE_SESSION_LOG_NAME = `session.v${NATIVE_SESSION_FORMAT_VERSION}.jsonl.zstd`;

/** 旧的未压缩日志文件名（保留：私有根回退模式与旧归档读取）。 */
export const LEGACY_SESSION_LOG_NAME = "session.jsonl";

/** Root for the durable ACP session index. Overridable for tests. */
export function storeRoot() {
  return process.env.DSH_ACP_STORE_DIR ?? join(homedir(), ".dsh-acp");
}

/** DSH_HOME (defaults to ~/.dsh), where official archives live. */
export function dshHome() {
  return process.env.DSH_HOME ?? join(homedir(), ".dsh");
}

/**
 * Encode an absolute cwd into the DSH sessions directory name.
 *
 * ⚠️ 历史实现（`--a-b-c--`，非字母数字一律替换为 `-`）是**有损**的：
 * `/a/b` 与 `/a-b` 会塌成同一个键。dsh 原生（`projectKey()`）改用
 * `~XXXX` 转义来保住可逆性。本函数**保留旧语义**（旧私有根的既有目录名
 * 依赖它，且 gc.mjs / 迁移工具按它寻址），新增的原生路径走
 * {@link nativeProjectKey}。
 *
 *   /home/user/projects/app -> --home-user-projects-app--
 */
export function encodeWorkspace(cwd) {
  const cleaned = String(cwd).replace(/^\/+/, "").replace(/[^A-Za-z0-9]/g, "-");
  return `--${cleaned}--`;
}

/**
 * DSH 原生的项目目录键（dsh-session-persistence-jsonl 的 `projectKey()`）。
 *
 * 与 {@link encodeWorkspace} **不是**同一个方案：分隔符（`/` `\` `:`）折叠
 * 成单个 `-`，其余不安全码元用 `~XXXX`（大写十六进制）转义，故可逆；
 * 长度上限 251。
 *
 *   /Users/jlwl/文档/.../项目-dsh-acp
 *     -> --Users-jlwl-~6587~6863-zyqWiki-Zyq-~5DE5~4F5C~6587~4EF6-dsh-acp--
 *
 * 本函数是 dsh 原生实现的**逐字镜像**（口径见
 * docs/实施计划/0.4.2-…-实施计划.md §二 W1「关键可行性实测」）。
 */
export function nativeProjectKey(cwd) {
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

/**
 * DSH 原生的单路径段编码（`encodeSegment()`）：安全字符原样保留，
 * 其余用 `~XXXX` 转义 ⇒ 可逆且无路径穿越（`..` → `~002E~002E`）。
 */
export function nativeEncodeSegment(raw) {
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

/**
 * 归档根的选择（R134 统一后的口径）：
 *
 *   - 默认（`DSH_ACP_ARCHIVE_IN_MAIN` 未设或 `1`）⇒ **dsh 原生根**
 *     `<DSH_HOME>/sessions/`，与主进程同一命名空间、同一物理编码（zstd）。
 *   - `DSH_ACP_ARCHIVE_IN_MAIN=0` ⇒ 退回**私有根**
 *     `<DSH_HOME>/dsh-acp-archives/`（保留旧目录名方案 + 未压缩 jsonl），
 *     作为可回滚的逃生阀（0.4.2 计划 §二 W1 交付物 1 的「决策 B：保留开关」）。
 *
 * 旧语义是「默认私有根、`=1` 进主根」；R134 把默认翻转成主根，`=0` 才是
 * 私根。**旧代码里 `=1` 表示主根仍然成立**，因此这里只需要区分
 * 「显式 `0`」与「其它」。
 */
export function archiveRootName() {
  return process.env.DSH_ACP_ARCHIVE_IN_MAIN === "0" ? "dsh-acp-archives" : "sessions";
}

/** 是否使用 dsh 原生根（主根）。 */
export function usesNativeRoot() {
  return archiveRootName() === "sessions";
}

/**
 * 归档目录的**项目层**路径（cwd → 一个目录名）。
 * 原生根用 `nativeProjectKey()`；私根沿用旧的 `encodeWorkspace()`。
 */
export function archiveWorkspaceDir(cwd) {
  const key = usesNativeRoot() ? nativeProjectKey(cwd) : encodeWorkspace(cwd);
  return join(dshHome(), archiveRootName(), key);
}

/** Absolute path of the archive directory for one ACP/DSH session. */
export function archiveDir(cwd, sessionId) {
  const root = archiveWorkspaceDir(cwd);
  const seg = usesNativeRoot() ? nativeEncodeSegment(sessionId) : sessionId;
  return join(root, seg);
}

/**
 * Absolute path of the DSH event log for one session.
 *
 * 原生根 ⇒ `session.v4.jsonl.zstd`（zstd 物理编码，与主进程一致）；
 * 私根 ⇒ `session.jsonl`（未压缩，旧格式）。
 */
export function archiveLogPath(cwd, sessionId) {
  const name = usesNativeRoot() ? NATIVE_SESSION_LOG_NAME : LEGACY_SESSION_LOG_NAME;
  return join(archiveDir(cwd, sessionId), name);
}

// ---- Durable ACP session index ------------------------------------------

// M2.4 (2026-09-18): the per-session permission mode. Mirrors
// `PermissionMode` in lib/permission-gate.mjs. Exposed as a Set so the
// `updateSessionMeta` whitelist can guard against typos / unknown modes
// silently coercing a session into an unhandled mode.
export const PERMISSION_MODES = ["default", "acceptEdits", "dontAsk", "bypassPermissions"];
export const PERMISSION_MODES_SET = new Set(PERMISSION_MODES);

let cache = null;
// Ids recently deleted by THIS process. Kept in memory only, so the
// write-before-read merge (REQ-04) does not resurrect a session that a
// concurrent (stale) disk copy still contains.
const tombstones = new Set();

// Debounce handle for index writes (REQ-02): rapid recordMessage calls are
// coalesced so we don't full-rewrite the index on every single message.
let persistTimer = null;
let persistTimerPending = false;
const PERSIST_DEBOUNCE_MS = Number(process.env.DSH_ACP_PERSIST_DEBOUNCE_MS ?? 100);

function storeFile() {
  return join(storeRoot(), STORE_FILE_NAME);
}

function loadIndex() {
  if (cache) return cache;
  try {
    if (existsSync(storeFile())) {
      cache = JSON.parse(readFileSync(storeFile(), "utf8"));
    } else {
      cache = { sessions: {} };
    }
  } catch {
    cache = { sessions: {} };
  }
  return cache;
}

/**
 * Re-read the on-disk index and fold in any sessions OTHER processes wrote
 * (REQ-04 "write-before-read merge"): clear one process's stale cache from
 * clobbering another's newly created sessions. Sessions we tombstoned in this
 * process are not resurrected.
 */
function mergeDiskSessions() {
  try {
    if (!existsSync(storeFile())) return;
    const disk = JSON.parse(readFileSync(storeFile(), "utf8"));
    const diskSessions = (disk && disk.sessions) || {};
    const idx = loadIndex();
    for (const [sid, rec] of Object.entries(diskSessions)) {
      if (idx.sessions[sid] || tombstones.has(sid)) continue;
      // Trust the on-disk copy for sessions created by another process.
      idx.sessions[sid] = rec;
    }
  } catch { /* non-fatal */ }
}

/**
 * Write the merged index to disk. When `now` is false this is the debounced
 * path used by high-frequency recordMessage writes (REQ-02).
 */
function persistIndex(now = false) {
  if (!now) {
    schedulePersistDebounce();
    return;
  }
  if (persistTimer) {
    clearTimeout(persistTimer);
    persistTimer = null;
    persistTimerPending = false;
  }
  mergeDiskSessions();
  const idx = loadIndex();
  try {
    mkdirSync(storeRoot(), { recursive: true });
    // Atomic-ish write: write to a process-unique temp file then rename, so a
    // concurrent reader never sees a truncated/partial JSON mid-write, AND two
    // concurrent dsh-acp processes writing the same store don't clobber each
    // other's temp file (a fixed `.tmp` path caused an ENOENT-on-rename race,
    // REQ-04). Rename onto the target is atomic regardless of tmp uniqueness.
    const tmp = `${storeFile()}.tmp.${process.pid}.${randomUUID()}`;
    writeFileSync(tmp, JSON.stringify(idx, null, 2), "utf8");
    renameSync(tmp, storeFile());
  } catch (err) {
    // Non-fatal: the adapter keeps running with in-memory state.
    console.warn(`[dsh-acp] cannot persist session index: ${err.message}`);
  }
}

/** Debounced persist: coalesce repeated recordMessage writes (REQ-02). */
function schedulePersistDebounce() {
  if (persistTimer) return; // already scheduled
  persistTimerPending = true;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    persistTimerPending = false;
    persistIndex(true);
  }, PERSIST_DEBOUNCE_MS);
}

/** Any write path may mark an id as tombstoned so merges don't resurrect it. */
function tombstoneSession(sessionId) {
  tombstones.add(sessionId);
}

/**
 * Flush any pending debounced write immediately. Call before process exit so a
 * just-recorded message is not lost (REQ-02 durability).
 */
export function flushPersist() {
  if (persistTimer) {
    clearTimeout(persistTimer);
    persistTimer = null;
    persistTimerPending = false;
  }
  if (cache) persistIndex(true);
}

/** Every known ACP session record. Each record: {id,cwd,title,createdAt,parentSessionId,messages?}. */
export function allSessions() {
  return Object.values(loadIndex().sessions);
}

/** Load one session record by id (or undefined). */
export function getSession(sessionId) {
  return loadIndex().sessions[sessionId];
}

/** Get the archive on-disk session id used for a given (cwd, title). */
export function archiveSessionId(cwd, title) {
  return `session-${randomUUID()}`;
}

/** Create a brand-new session record. */
export function createSession({ cwd, title }) {
  const idx = loadIndex();
  const id = `dsh-${randomUUID()}`;
  const rec = {
    id,
    cwd: cwd ?? process.cwd(),
    title: title ?? "DSH",
    createdAt: new Date().toISOString(),
    parentSessionId: null,
    messages: [],
    archive: archiveSessionId(),
    archiveSeq: 0,
    // FEAT: session summary (one-line LLM summary) + current model override.
    summary: null,
    summaryAt: null,
    model: null,
  };
  idx.sessions[id] = rec;
  persistIndex(true);
  return rec;
}

/** Load or lazily create a session record by ACP id. */
export function ensureSession(sessionId, cwd) {
  const idx = loadIndex();
  if (idx.sessions[sessionId]) return idx.sessions[sessionId];
  const rec = {
    id: sessionId,
    cwd: cwd ?? process.cwd(),
    title: `DSH ${sessionId.slice(0, 8)}`,
    createdAt: new Date().toISOString(),
    parentSessionId: null,
    messages: [],
    archive: `session-${randomUUID()}`,
    archiveSeq: 0,
    summary: null,
    summaryAt: null,
    model: null,
  };
  idx.sessions[sessionId] = rec;
  persistIndex(true);
  return rec;
}

/**
 * Update settable session metadata (summary / model) and persist.
 * Only whitelisted keys are written; `updated` is always stamped.
 * Returns the updated record, or undefined if the session is unknown.
 */
export function updateSessionMeta(sessionId, patch = {}) {
  const idx = loadIndex();
  const rec = idx.sessions[sessionId];
  if (!rec) return undefined;
  if (typeof patch.summary === "string") rec.summary = patch.summary;
  if (typeof patch.summaryAt === "number") rec.summaryAt = patch.summaryAt;
  if (typeof patch.model === "string") rec.model = patch.model;
  // M1.3 fix (2026-09-18): setSessionConfigOption for temperature and
  // reasoningEffort was silently no-op because updateSessionMeta's whitelist
  // dropped both keys. Without these lines, Obsidian UI changes to those
  // fields never persisted to the session record and resume/load would
  // return stale values.
  if (typeof patch.temperature === "number" && Number.isFinite(patch.temperature)) {
    rec.temperature = patch.temperature;
  }
  if (typeof patch.reasoningEffort === "string") {
    rec.reasoningEffort = patch.reasoningEffort;
  }
  // M2.4 (2026-09-18): persist the per-session permission mode so
  // setSessionMode(acceptEdits/dontAsk/bypassPermissions) survives resume.
  // Without this whitelist entry the change was silently dropped and the
  // next session/load would return currentModeId="default" again.
  if (typeof patch.mode === "string" && PERMISSION_MODES_SET.has(patch.mode)) {
    rec.mode = patch.mode;
  }
  if (typeof patch.archived === "boolean") rec.archived = patch.archived;
  // 软删除旗标（回收站机制）：trashed=true 不删磁盘文件，仅从 active 列表隐藏；
  // 恢复时 trashed=false 即可，archive dir 完整保留 → 无损还原。
  // 与 archived（用户级归档）独立：archived 会话不再需要操作；trashed 会话待清空/恢复。
  if (typeof patch.trashed === "boolean") rec.trashed = patch.trashed;
  if (typeof patch.category === "string") rec.category = patch.category;
  if (typeof patch.obsidianSessionId === "string") rec.obsidianSessionId = patch.obsidianSessionId;
  if (typeof patch.obsidianFile === "string") rec.obsidianFile = patch.obsidianFile;
  rec.updated = Date.now();
  persistIndex(true);
  return rec;
}

/** Move a session to a new cwd: update record + relocate its archive dir. */
export function moveSession(sessionId, newCwd) {
  const idx = loadIndex();
  const rec = idx.sessions[sessionId];
  if (!rec) return undefined;
  if (typeof newCwd !== "string" || !newCwd.trim()) return undefined;
  const oldCwd = rec.cwd;
  if (oldCwd === newCwd) return rec;
  // Move the on-disk archive dir from <enc(oldCwd)> to <enc(newCwd)>.
  const oldDir = archiveDir(oldCwd, rec.archive ?? rec.id);
  const newDir = archiveDir(newCwd, rec.archive ?? rec.id);
  if (existsSync(oldDir) && !existsSync(newDir)) {
    try {
      mkdirSync(newDir, { recursive: true });
      renameSync(oldDir, newDir);
      // R134（验收③：移动/重命名后路径可解析）：原生根下会话目录名是
      // `nativeEncodeSegment(archiveId)`，而**头里的 id 是 archiveId 原值**。
      // 目录名经转义后可能与 id 不等（`~XXXX` 段），主进程读侧会用
      // 「头 id + cwd」反推期望路径并比对 ⇒ 转义不一致会被判为
      // "corrupt session log"。移动后必须把头里的 cwd 同步改成新 cwd，
      // 否则头仍指向旧 cwd ⇒ 同样对不上。
      //
      // 只有原生根需要这一步（原生读侧会做 cwd↔路径一致性校验）；
      // 私根（旧未压缩格式）不校验，保持原行为不动。
      if (usesNativeRoot()) rewriteNativeArchiveCwd(newDir, newCwd);
    } catch (e) {
      console.warn(`[dsh-acp] move archive for ${sessionId} failed: ${e.message}`);
    }
  }
  rec.cwd = newCwd;
  rec.updated = Date.now();
  persistIndex(true);
  return rec;
}

/**
 * 把原生归档头里的 `cwd` 改写成新 cwd（移动后保持「头 id + cwd ⇒ 路径」可解析）。
 *
 * 只改**头帧**（第一帧），事件帧原样保留（append 语义）。实现方式：解压全部
 * 帧 → 只重写首行 → 重新压缩成「头帧 + 事件帧」两帧 → 原子发布。
 * 事件帧被重新压缩（不是字节级搬运），但明文逐字节相同，故内容无损。
 */
function rewriteNativeArchiveCwd(dirPath, newCwd) {
  const logPath = join(dirPath, NATIVE_SESSION_LOG_NAME);
  if (!existsSync(logPath)) return;
  const plain = readArchivePlaintext(logPath);
  if (!plain) return;
  const lines = plain.split("\n").filter(Boolean);
  if (!lines.length) return;
  let header;
  try { header = JSON.parse(lines[0]); } catch { return; }
  if (!header || header.type !== "session") return;
  if (header.cwd === newCwd) return;
  header.cwd = newCwd;
  const headerFrame = compressZstdFrame(`${JSON.stringify(header)}\n`);
  const bodyFrame = compressZstdFrame(lines.slice(1).map((l) => `${l}\n`).join(""));
  writeZstdFramesAtomic(logPath, [headerFrame, bodyFrame]);
}

/**
 * Fork a session: deep-copy the source record into a new id, keep its
 * message history, record the parent link, and give it a fresh on-disk
 * archive id so it does not clobber the parent's files.
 * Returns the new record.
 */
export function forkSession(sourceSessionId, cwd) {
  const src = getSession(sourceSessionId);
  if (!src) return null;
  const idx = loadIndex();
  const id = `dsh-${randomUUID()}`;
  const rec = {
    id,
    cwd: cwd ?? src.cwd,
    title: `Fork: ${src.title}`,
    createdAt: new Date().toISOString(),
    parentSessionId: src.id,
    messages: Array.isArray(src.messages) ? src.messages.map((m) => ({ ...m })) : [],
    archive: `session-${randomUUID()}`,
    // Fresh archive dir, so its event seq starts from 0 (not inherited).
    archiveSeq: 0,
    // M1.2 fix (2026-09-18): copy sessionConfig fields + metadata so the
    // forked session preserves model/temperature/reasoningEffort/summary/
    // category/obsidianFile. Without these, forking a tuned session silently
    // reverted it to defaults — same root cause as the M1.3 updateSessionMeta
    // whitelist gap (silent drop of important fields).
    model: src.model,
    temperature: src.temperature,
    reasoningEffort: src.reasoningEffort,
    // M2.4 (2026-09-18): also copy the permission mode so a forked session
    // inherits the parent's acceptEdits/dontAsk/bypassPermissions choice
    // instead of silently falling back to "default".
    mode: src.mode,
    summary: src.summary,
    summaryAt: src.summaryAt,
    category: src.category,
    obsidianSessionId: src.obsidianSessionId,
    obsidianFile: src.obsidianFile,
  };
  idx.sessions[id] = rec;
  persistIndex(true);
  return rec;
}

/** Delete a session record from the durable index AND its on-disk archives. */
export function deleteSession(sessionId) {
  const idx = loadIndex();
  const rec = idx.sessions[sessionId];
  // Also remove the on-disk archives. If we only drop the index record, the
  // session can re-surface on reload from disk — hence both roots are cleared
  // below. Note which reader sees which root:
  //   - scanArchives() reads ONLY the **authoritative** root (default
  //     <DSH_HOME>/sessions/, resolved via archiveWorkspaceDir()). It does NOT
  //     scan <DSH_HOME>/dsh-acp-archives/, so an adapter-written archive left
  //     there is invisible to it.
  //   - dsh-acp's own visibility comes from the INDEX (allSessions() inside
  //     listSessionRecords()), not from scanning. Dropping the index record is
  //     what actually hides it on the adapter side.
  // Clearing both roots keeps the two readers honest: neither can resurrect a
  // deleted session.
  if (rec && rec.cwd) {
    // The on-disk archive dir is named after `rec.archive` (session-<uuid>),
    // NOT the ACP id (`dsh-<uuid>`). archiveDir(cwd, sessionId) would build
    // a `.../dsh-<uuid>` path that does not exist, so it never removed
    // anything. Remove both roots that scanArchives() reads:
    //   1) <DSH_HOME>/dsh-acp-archives/<enc>/<archive>  (adapter-written)
    //   2) <DSH_HOME>/sessions/<enc>/<archive>          (DSH web official)
    //
    // R134：两套 root 的**项目层键名方案不同**（原生 `nativeProjectKey()`，
    // 旧 `encodeWorkspace()`），会话目录名也不同（原生 `nativeEncodeSegment()`，
    // 旧原样）。故两个 root 各按自己的方案各算一遍路径。
    const archiveId = rec.archive ?? rec.id;
    const candidates = [
      // 旧私有根（旧键名方案 + 原样目录名）。
      join(dshHome(), "dsh-acp-archives", encodeWorkspace(rec.cwd), archiveId),
      // 原生根（原生键名方案 + 转义目录名）。
      join(dshHome(), "sessions", nativeProjectKey(rec.cwd), nativeEncodeSegment(archiveId)),
      // 原生根里也可能残留旧键名方案写的目录（历史 `DSH_ACP_ARCHIVE_IN_MAIN=1`
      // 的产物），一并清掉。
      join(dshHome(), "sessions", encodeWorkspace(rec.cwd), archiveId),
    ];
    for (const target of candidates) {
      try {
        rmSync(target, { recursive: true, force: true });
      } catch (err) {
        // Best-effort: index removal still succeeds if a disk cleanup fails.
      }
    }
  }
  delete idx.sessions[sessionId];
  tombstoneSession(sessionId);
  persistIndex(true);
}

/** Append one message to a session record and mirror it to the DSH archive. */
export function recordMessage(sessionId, role, text) {
  const idx = loadIndex();
  const rec = idx.sessions[sessionId];
  if (!rec) return;
  rec.messages.push({ role, text, at: Date.now() });
  try {
    // Append the archive first so rec.archiveSeq (REQ-03) is up to date before
    // the index is persisted, keeping seq crash-consistent.
    appendArchiveEvent(rec, role, text);
  } catch (err) {
    console.warn(`[dsh-acp] archive append failed: ${err.message}`);
  }
  persistIndex();
}

// ---- DSH-format archive writer (best effort) ----------------------------

/**
 * Zstd 压缩选项：与 dsh-session-persistence-jsonl 的 `CHECKSUM_OPTIONS` 对齐
 * （带 xxhash64 校验和），使主进程读侧可以用同一套 frame 校验通过。
 */
const ZSTD_COMPRESS_OPTIONS = {
  params: { [zlibConstants.ZSTD_c_compressionLevel]: 3, [zlibConstants.ZSTD_c_checksumFlag]: 1 },
};

/**
 * 压缩一段 JSONL 文本为一个**独立可解码**的 zstd frame。
 * 原生写侧对「头帧」与「事件批次帧」分别压缩再拼接，本函数对应其中一次调用。
 */
export function compressZstdFrame(text) {
  return zstdCompressSync(Buffer.from(text, "utf8"), ZSTD_COMPRESS_OPTIONS);
}

/**
 * 解压一个 zstd 文件的明文。
 *
 * ⚠️ Node 的 `zstdDecompressSync` **只解第一帧**（拼接帧时后续帧被静默丢弃）。
 * 本仓写侧采用**单帧**策略（见 {@link appendArchiveEvent}），故正常情况下
 * 一个文件就是**一个** frame，`zstdDecompressSync` 可直接解开。
 * 但历史存量 / 迁移进来的文件可能是多帧拼接，故这里做兜底：先试单帧，
 * 若解出的明文不含全部内容，再按帧边界逐帧解压并拼接。
 */
export function decompressZstdFrame(buffer) {
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  if (buf.length < 4 || buf.readUInt32LE(0) !== ZSTD_MAGIC) {
    // Not a zstd frame ⇒ treat as plain text (legacy uncompressed log).
    return buf;
  }
  const frames = scanZstdFrames(buf);
  if (!frames.length) return Buffer.alloc(0);
  if (frames.length === 1) return zstdDecompressSync(buf.subarray(frames[0].start, frames[0].end));
  const parts = [];
  for (const frame of frames) {
    parts.push(zstdDecompressSync(buf.subarray(frame.start, frame.end)));
  }
  return Buffer.concat(parts);
}

/** zstd 帧魔数（小端读出为 0x28B52FFD）。 */
const ZSTD_MAGIC = 0xFD2FB528;

/**
 * 扫描一个 zstd 字节流里的**完整帧**边界。
 *
 * 这是 dsh-session-persistence-jsonl `scanZstdFrames()` 的镜像（同一份
 * Zstandard 帧格式规范）：逐帧解析 frame header + block header，产出
 * `[start, end)` 区间。末尾不完整的帧（torn write）被丢弃。
 */
function scanZstdFrames(buffer) {
  const frames = [];
  let offset = 0;
  while (offset < buffer.length) {
    const start = offset;
    if (buffer.length - offset < 4) break; // torn: fewer than 4 bytes left
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) break; // not a frame boundary
    offset += 4;
    if (offset === buffer.length) break; // torn: magic only
    const descriptor = buffer.readUInt8(offset);
    offset += 1;
    if ((descriptor & 24) !== 0) break; // reserved frame-header bits
    const contentSizeFlag = descriptor >>> 6;
    const singleSegment = (descriptor & 32) !== 0;
    const checksum = (descriptor & 4) !== 0;
    const dictionaryFlag = descriptor & 3;
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag;
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag;
    const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes;
    if (buffer.length - offset < remainingHeaderBytes) break; // torn header
    offset += remainingHeaderBytes;
    let frameOk = true;
    for (;;) {
      if (buffer.length - offset < 3) { frameOk = false; break; } // torn block header
      const blockHeader = buffer.readUIntLE(offset, 3);
      offset += 3;
      const lastBlock = (blockHeader & 1) !== 0;
      const blockType = (blockHeader >>> 1) & 3;
      const blockSize = blockHeader >>> 3;
      if (blockType === 3) { frameOk = false; break; } // reserved block type
      const payloadBytes = blockType === 1 ? 1 : blockSize;
      if (buffer.length - offset < payloadBytes) { frameOk = false; break; } // torn block
      offset += payloadBytes;
      if (lastBlock) break;
    }
    if (!frameOk) break;
    if (checksum) {
      if (buffer.length - offset < 4) break; // torn checksum
      offset += 4;
    }
    frames.push({ start, end: offset });
  }
  return frames;
}

/**
 * 原生 v4 头（`type: "session"`）。
 *
 * 原生读侧 `isHeaderLine()` 要求必填
 * `{type,version,id,createdAt,isSeeded,delegationDepth}`，可选
 * `{cwd,parentSession,origin,agentPreset}`，且
 * `assertNoRetiredHeaderFields()` 会拒 `sandboxMode` / `approvalPolicy`。
 * 旧版的 `seedLength` 是**已退役**字段，必须用 `isSeeded` 取代。
 */
export function nativeSessionHeader(rec, cwd) {
  const header = {
    type: "session",
    version: NATIVE_SESSION_FORMAT_VERSION,
    id: rec.archive ?? rec.id,
    createdAt: Number.isSafeInteger(rec.createdAt) && rec.createdAt >= 0
      ? rec.createdAt
      : (typeof rec.createdAt === "string" ? Date.parse(rec.createdAt) : Date.now()),
    cwd,
    isSeeded: false,
    delegationDepth: 0,
    agentPreset: "standard",
  };
  if (typeof rec.parentSessionId === "string" && rec.parentSessionId) header.parentSession = rec.parentSessionId;
  return header;
}

/**
 * 把一段（或多段）zstd frame 原子发布到目标路径。
 * @param {Buffer[]} frames - 已压缩的 frame 缓冲区，按顺序拼接。
 */
function writeZstdFramesAtomic(targetPath, frames) {
  const tmp = `${targetPath}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(tmp, Buffer.concat(frames));
  try {
    renameSync(tmp, targetPath);
  } catch (err) {
    try { rmSync(tmp, { force: true }); } catch {}
    throw err;
  }
}

/**
 * 读取归档日志的明文（自动识别 zstd / 未压缩）。
 *
 * zstd 文件可能是**多帧拼接**（头帧 + 若干事件批次帧），由
 * {@link decompressZstdFrame} 逐帧解压后拼接明文。
 * @returns {string|null} 明文 JSONL；文件不存在返回 null。
 */
export function readArchivePlaintext(logPath) {
  if (!existsSync(logPath)) return null;
  const raw = readFileSync(logPath);
  // zstd 魔数 0xFD2FB528（小端读出即 0x28B52FFD）。
  if (raw.length >= 4 && raw.readUInt32LE(0) === 0xFD2FB528) {
    return decompressZstdFrame(raw).toString("utf8");
  }
  return raw.toString("utf8");
}

/**
 * Append a user/assistant turn to the DSH official archive for `rec`.
 *
 * 原生根（默认）⇒ 写 `<DSH_HOME>/sessions/<project-key>/<seg>/session.v4.jsonl.zstd`，
 * 物理编码与 dsh 主进程一致（zstd + 校验和）。
 * 私根（`DSH_ACP_ARCHIVE_IN_MAIN=0`）⇒ 写未压缩 `session.jsonl`（旧格式）。
 *
 * 两边都用 DSH 的原生事件形状：首行是 `session` 头，其后是带 `seq` 的事件，
 * `seq` 从 0 开始（**头不带 seq**，与原生实测一致）。
 */
export function appendArchiveEvent(rec, role, text) {
  const cwd = rec.cwd ?? process.cwd();
  const logPath = archiveLogPath(cwd, rec.archive ?? rec.id);
  mkdirSync(join(logPath, ".."), { recursive: true });

  const native = usesNativeRoot();
  const lines = [];
  const firstWrite = !existsSync(logPath);
  if (firstWrite) {
    if (native) {
      // 原生 v4 头：字段集与主进程读侧 `isHeaderLine()` 一致。
      lines.push(JSON.stringify(nativeSessionHeader(rec, cwd)));
    } else {
      // 私根旧格式：保留 v0 头（含已退役的 seedLength）以兼容旧读取方。
      const header = {
        type: "session",
        version: 0,
        id: rec.archive ?? rec.id,
        createdAt: Date.now(),
        cwd,
        parentSession: rec.parentSessionId ?? null,
        seedLength: 0,
        delegationDepth: 0,
        agentPreset: "standard",
      };
      lines.push(JSON.stringify(header));
    }
  }

  // seq is kept in memory (rec.archiveSeq) instead of re-reading the whole
  // .jsonl and counting lines on every append (REQ-03). For a first write on a
  // pre-existing file (e.g. a legacy session created before archiveSeq existed,
  // or an archive written by another process), seed once from the file's
  // existing events (counts only seq-bearing lines, robust to blank lines).
  let seq = rec.archiveSeq;
  if (seq == null) {
    seq = 0;
    if (!firstWrite) {
      try {
        const plain = readArchivePlaintext(logPath) ?? "";
        for (const line of plain.split("\n")) {
          if (!line) continue;
          const parsed = JSON.parse(line);
          if (parsed && typeof parsed.seq === "number") seq = Math.max(seq, parsed.seq + 1);
        }
      } catch {
        seq = 0;
      }
    }
  } else if (firstWrite) {
    // Fresh file: no prior events, nothing to carry over.
    seq = 0;
  }

  const msgId = `acp-${randomUUID()}`;
  const turn = Math.floor(seq / 3) + 1;

  const contentBlock = { type: "text", text: String(text ?? "") };
  // Only the events actually written may consume seq values. Building every
  // event type unconditionally (as the pre-REQ-03 code did) over-incremented
  // the counter for user turns, desyncing it from the on-disk line count once
  // we cached seq in memory.
  const events = [{
    type: "agent/inbox/spliced",
    time: Date.now(),
    data: {
      target: "next-turn",
      start: 0,
      inserted: [
        {
          content: [contentBlock],
          source: { kind: role === "user" ? "user" : "assistant", rpcId: `acp-${randomUUID()}` },
          role,
          id: msgId,
        },
      ],
    },
  }];
  if (role === "assistant") {
    events.push(
      { type: "step/start", time: Date.now(), data: { turn, step: 1 } },
      { type: "step/end", time: Date.now(), data: { turn, step: 1 } },
      { type: "turn/end", time: Date.now(), data: { turn } },
    );
  } else {
    events.push({ type: "turn/start", time: Date.now(), data: { turn } });
  }

  // Assign strictly sequential seq to the events we are about to write.
  const eventLines = events.map((e) => JSON.stringify({ ...e, seq: seq++ }));

  // Append exactly one line per event, each newline-terminated, so a legacy
  // reader that counts lines agrees with rec.archiveSeq (no blank lines the
  // old "<...>\n".join("\n") approach used to leave between appends).
  const payload = lines.concat(eventLines).map((l) => `${l}\n`).join("");

  if (native) {
    // ── 原生根：**单帧重写** ──────────────────────────────────────
    //
    // 为什么是单帧（而不是 dsh 主进程那种「头帧 + 事件帧」多帧拼接）：
    //   Node 的 `zstdDecompressSync` 对**多帧 concat 只解第一帧并静默丢帧**
    //   （实测：3 帧 33B → 只回 2B）。验收① 的字面判据是
    //   「写出 .zstd 且被 `zlib.zstdDecompressSync` 解回**逐字节相同**」——
    //   该判据**只有在单帧时客观成立**。
    //
    // 所以：每次写入都把**整个文件**重写为**一个** zstd frame
    // （读旧明文 → 追加新行 → 整帧重新压缩 → 原子写回）。
    //
    // 代价：每次 append 都重写全文件（O(n)）。本仓的会话日志很小
    // （实测均值 ~7 KB），可接受；换来的是「文件 = 一个 frame」这一
    // 强不变式，主进程与任何第三方工具都能用 `zstdDecompressSync` 直接解开。
    //
    // 兼容性：若目标已存在且是**多帧**（历史存量 / 迁移产物），先按帧边界
    // 解出全部明文再重写，把它收敛成单帧。
    const existingPlain = firstWrite ? "" : (readArchivePlaintext(logPath) ?? "");
    const existingLines = existingPlain.split("\n").filter(Boolean);
    const merged = existingLines.length
      ? `${existingPlain.endsWith("\n") ? existingPlain : `${existingPlain}\n`}${eventLines.map((l) => `${l}\n`).join("")}`
      : `${lines.map((l) => `${l}\n`).join("")}${eventLines.map((l) => `${l}\n`).join("")}`;
    writeZstdFramesAtomic(logPath, [compressZstdFrame(merged)]);
  } else {
    appendFileSync(logPath, payload);
  }

  // Track where the next append's seq starts, so we never re-read the file
  // (REQ-03). `seq` now equals events written this call + all prior ones.
  rec.archiveSeq = seq;

  return logPath;
}

// ---- Disk scanning for official archives (reload support) ---------------

/**
 * 扫描**唯一权威根**下的会话目录，返回索引里没有的记录。
 *
 * R134（0.4.2 W1 交付物 2）：读侧**单一来源**。
 * 旧实现只扫 `<DSH_HOME>/sessions/<encodeWorkspace(cwd)>/`，与写侧默认的
 * 私有根 `<DSH_HOME>/dsh-acp-archives/<encodeWorkspace(cwd)>/` **不是同一
 * 个命名空间**（原生键用 `~XXXX` 转义，旧键用有损 `-` 替换），于是：
 *   - 写侧写进私有根的会话，读侧扫不到 ⇒ `session/list` 看不见自己的会话；
 *   - `dsh-acp.mjs` 的 `listSessionRecords()` 只能靠「索引 ∪ 扫描」双拼，
 *     两边口径不一致（磁盘上到底有几个会话 = 说不清）。
 *
 * 现在：**扫描与写入共用同一套路径解析**（{@link archiveWorkspaceDir}），
 * 因此「磁盘扫描口径」与「写侧口径」逐字一致；`session/list` 只保留一个
 * 来源（磁盘权威 + 索引作为 tombstone/元数据缓存）。
 *
 * 兼容：私根回退模式（`DSH_ACP_ARCHIVE_IN_MAIN=0`）下扫私根；否则扫原生根。
 * 旧私有根的**存量**目录由迁移工具负责 copy 进原生根（只 copy 不 move）。
 */
export function scanArchives(cwd) {
  const base = archiveWorkspaceDir(cwd);
  if (!existsSync(base)) return [];
  const idx = loadIndex();
  const known = new Set(Object.values(idx.sessions).map((s) => s.id));
  const out = [];
  let entries = [];
  try {
    entries = readdirSync(base);
  } catch { /* ignore */ }

  const byDir = new Map();
  for (const rec of Object.values(idx.sessions)) {
    byDir.set(rec.archive ?? rec.id, rec);
  }

  for (const dir of entries) {
    const dirPath = join(base, dir);
    // 只看目录（原生根里项目层下就是会话目录）。
    let isDir = false;
    try { isDir = statSync(dirPath).isDirectory(); } catch { continue; }
    if (!isDir) continue;
    // 原生会话目录名可以是 `session-<uuid>` 或 `import-<uuid>`（导入器产出），
    // 两者都是合法的会话目录；旧实现只认 `session-`，会漏掉 `import-`。
    if (!/^(session|import)-/i.test(dir)) continue;
    const candidateId = byDir.has(dir) ? byDir.get(dir).id : dir;
    let title = dir;
    try {
      const files = readdirSync(dirPath);
      const log = files.find((f) => /^session(\.v\d+)?\.jsonl(\.zstd)?$/.test(f));
      if (log) {
        try {
          // Read the file once and reuse it (REQ-12): the old code issued two
          // readFileSync calls — one truthiness probe, one real read.
          // 原生根是 zstd ⇒ readArchivePlaintext 自动识别物理编码。
          const raw = readArchivePlaintext(join(dirPath, log)) ?? "";
          const firstLine = raw.split("\n")[0];
          const first = firstLine ? JSON.parse(firstLine) : {};
          if (first.type === "session" && first.id) title = first.id;
        } catch { /* keep dir name */ }
      }
    } catch { /* ignore */ }
    if (!known.has(candidateId)) {
      out.push({ id: candidateId, title, cwd });
    }
  }
  return out;
}
