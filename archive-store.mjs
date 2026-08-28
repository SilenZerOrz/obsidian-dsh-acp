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
//         <DSH_HOME>/sessions/<encoded-cwd>/session-<id>/session.jsonl
//     using DeepSeek Harness' native event-log shape so the DSH web main
//     process can read it back ("write ACP sessions back into DSH web's own
//     conversation archive").

import { mkdirSync, readdirSync, readFileSync, writeFileSync, existsSync, appendFileSync, renameSync, statSync, rmSync } from "node:fs";
import { join, sep } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";

// ---- Paths / encoding ----------------------------------------------------

const STORE_FILE_NAME = "dsh-acp-sessions.json";

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
 * Mirror of DSH's scheme: drop the leading "/", replace every non
 * [A-Za-z0-9] char with "-", then wrap in "--…--".
 *   /Users/jlwl/.npm-global/bin -> --Users-jlwl-.npm-global-bin--
 */
export function encodeWorkspace(cwd) {
  const cleaned = String(cwd).replace(/^\/+/, "").replace(/[^A-Za-z0-9]/g, "-");
  return `--${cleaned}--`;
}

/** Absolute path of the archive directory for one ACP/DSH session. */
export function archiveDir(cwd, sessionId) {
  // Default note: write archives under a dedicated dsh-acp root
  // (<DSH_HOME>/dsh-acp-archives by default) rather than the web process's
  // sessions/ tree, so an uncompressed .jsonl we emit never clashes with the
  // main process's zstd-compressed session logs (DSH aborts on a mismatch).
  // Set DSH_ACP_ARCHIVE_IN_MAIN=1 to place them under sessions/ instead.
  if (process.env.DSH_ACP_ARCHIVE_IN_MAIN === "1") {
    return join(dshHome(), "sessions", encodeWorkspace(cwd), sessionId);
  }
  return join(dshHome(), "dsh-acp-archives", encodeWorkspace(cwd), sessionId);
}

/** Absolute path of the (uncompressed) DSH event log for one session. */
export function archiveLogPath(cwd, sessionId) {
  return join(archiveDir(cwd, sessionId), "session.jsonl");
}

// ---- Durable ACP session index ------------------------------------------

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
    // Atomic-ish write: write to a temp file then rename, so a concurrent
    // reader never sees a truncated/partial JSON mid-write.
    const tmp = `${storeFile()}.tmp`;
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
  };
  idx.sessions[sessionId] = rec;
  persistIndex(true);
  return rec;
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
  };
  idx.sessions[id] = rec;
  persistIndex(true);
  return rec;
}

/** Delete a session record from the durable index AND its on-disk archives. */
export function deleteSession(sessionId) {
  const idx = loadIndex();
  const rec = idx.sessions[sessionId];
  // Also remove the on-disk archives. If we only drop the index record,
  // listSessionRecords() re-surfaces the session via scanArchives() (which scans
  // BOTH the dsh-acp archive root and the DSH web official sessions root), so
  // Obsidian shows "deleted" but the session reappears on reload.
  if (rec && rec.cwd) {
    // The on-disk archive dir is named after `rec.archive` (session-<uuid>),
    // NOT the ACP id (`dsh-<uuid>`). archiveDir(cwd, sessionId) would build
    // a `.../dsh-<uuid>` path that does not exist, so it never removed
    // anything. Remove both roots that scanArchives() reads:
    //   1) <DSH_HOME>/dsh-acp-archives/<enc>/<archive>  (adapter-written)
    //   2) <DSH_HOME>/sessions/<enc>/<archive>          (DSH web official)
    const enc = encodeWorkspace(rec.cwd);
    for (const root of [join(dshHome(), "dsh-acp-archives"), join(dshHome(), "sessions")]) {
      try {
        rmSync(join(root, enc, rec.archive), { recursive: true, force: true });
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
 * Append a user/assistant turn to the DSH official archive for `rec`.
 * Writes an uncompressed session.jsonl at
 *   <DSH_HOME>/sessions/<encoded-cwd>/<archive>/session.jsonl
 * using DSH's native event-log event shape (session header + seq'd events).
 * The file is created on first write with a `session` header line.
 */
export function appendArchiveEvent(rec, role, text) {
  const cwd = rec.cwd ?? process.cwd();
  const logPath = archiveLogPath(cwd, rec.archive ?? rec.id);
  mkdirSync(join(logPath, ".."), { recursive: true });

  const lines = [];
  const firstWrite = !existsSync(logPath);
  if (firstWrite) {
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
        for (const line of readFileSync(logPath, "utf8").split("\n")) {
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
  appendFileSync(logPath, payload);

  // Track where the next append's seq starts, so we never re-read the file
  // (REQ-03). `seq` now equals events written this call + all prior ones.
  rec.archiveSeq = seq;

  return logPath;
}

// ---- Disk scanning for official archives (reload support) ---------------

/**
 * Scan <DSH_HOME>/sessions/<encoded-cwd>/ for directories that look like DSH
 * sessions. Returns records for any that are not already in the durable ACP
 * index, so an "official" archive the DSH web process produced is also visible
 * through `session/list` (cross-restart + cross-process reload).
 */
export function scanArchives(cwd) {
  const base = join(dshHome(), "sessions");
  if (!existsSync(base)) return [];
  const idx = loadIndex();
  const known = new Set(Object.values(idx.sessions).map((s) => s.id));
  const out = [];
  let entries = [];
  try {
    const ws = join(base, encodeWorkspace(cwd));
    if (existsSync(ws)) entries = readdirSync(ws);
  } catch { /* ignore */ }

  const byDir = new Map();
  for (const rec of Object.values(idx.sessions)) {
    byDir.set(rec.archive ?? rec.id, rec);
  }

  for (const dir of entries) {
    if (!/^session-/i.test(dir)) continue;
    const candidateId = byDir.has(dir) ? byDir.get(dir).id : dir;
    const dirPath = join(base, encodeWorkspace(cwd), dir);
    let title = dir;
    try {
      const files = readdirSync(dirPath);
      const log = files.find((f) => f === "session.jsonl" || f === "session.jsonl.zstd");
      if (log) {
        try {
          // Read the file once and reuse it (REQ-12): the old code issued two
          // readFileSync calls — one truthiness probe, one real read.
          const raw = readFileSync(join(dirPath, log), "utf8");
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
