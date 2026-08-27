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

function persistIndex() {
  const idx = loadIndex();
  try {
    mkdirSync(storeRoot(), { recursive: true });
    writeFileSync(storeFile(), JSON.stringify(idx, null, 2), "utf8");
  } catch (err) {
    // Non-fatal: the adapter keeps running with in-memory state.
    console.warn(`[dsh-acp] cannot persist session index: ${err.message}`);
  }
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
  };
  idx.sessions[id] = rec;
  persistIndex();
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
  };
  idx.sessions[sessionId] = rec;
  persistIndex();
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
  };
  idx.sessions[id] = rec;
  persistIndex();
  return rec;
}

/** Delete a session record from the durable index AND its on-disk archive. */
export function deleteSession(sessionId) {
  const idx = loadIndex();
  const rec = idx.sessions[sessionId];
  // Also remove the on-disk archive directory. If we only drop the index
  // record, listSessions() re-surfaces the session via scanArchives() (disk
  // scan), so Obsidian shows "deleted" but the session reappears on reload.
  if (rec && rec.cwd) {
    const dir = archiveDir(rec.cwd, sessionId);
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch (err) {
      // Best-effort: index removal still succeeds if disk cleanup fails.
    }
  }
  delete idx.sessions[sessionId];
  persistIndex();
}

/** Append one message to a session record and mirror it to the DSH archive. */
export function recordMessage(sessionId, role, text) {
  const idx = loadIndex();
  const rec = idx.sessions[sessionId];
  if (!rec) return;
  rec.messages.push({ role, text, at: Date.now() });
  persistIndex();
  try {
    appendArchiveEvent(rec, role, text);
  } catch (err) {
    console.warn(`[dsh-acp] archive append failed: ${err.message}`);
  }
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
  if (!existsSync(logPath)) {
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

  // seq continues from existing file length (lines already written).
  let seq = 0;
  if (existsSync(logPath)) {
    try {
      seq = readFileSync(logPath, "utf8").trim().split("\n").length - 1;
    } catch {
      seq = 0;
    }
  }

  const msgId = `acp-${randomUUID()}`;
  const turn = Math.floor(seq / 3) + 1;

  const contentBlock = { type: "text", text: String(text ?? "") };
  const spliceEvent = {
    type: "agent/inbox/spliced",
    seq: seq++,
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
  };
  const turnStart = {
    type: "turn/start",
    seq: seq++,
    time: Date.now(),
    data: { turn },
  };
  const stepStart = {
    type: "step/start",
    seq: seq++,
    time: Date.now(),
    data: { turn, step: 1 },
  };
  const stepEnd = {
    type: "step/end",
    seq: seq++,
    time: Date.now(),
    data: { turn, step: 1 },
  };
  const turnEnd = {
    type: "turn/end",
    seq: seq++,
    time: Date.now(),
    data: { turn },
  };

  appendFileSync(logPath, lines
    .concat([JSON.stringify(spliceEvent)])
    .concat(role === "assistant"
      ? [JSON.stringify(stepStart), JSON.stringify(stepEnd), JSON.stringify(turnEnd)]
      : [JSON.stringify(turnStart)])
    .concat("\n")
    .join("\n"));

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
          const first = readFileSync(join(dirPath, log), "utf8")
            ? JSON.parse(readFileSync(join(dirPath, log), "utf8").split("\n")[0])
            : {};
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
