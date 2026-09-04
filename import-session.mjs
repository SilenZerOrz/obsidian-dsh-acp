// import-session.mjs — import an ACP-protocol session (e.g. claude-agent-acp /
// Obsidian Agent Client) into the dsh-acp durable session store.
//
// ACP clients store sessions as JSON with a `messages` array; the exact shape
// differs by client. This module focuses on the two shapes we actually see in
// the wild (both used by Obsidian Agent Client sessions):
//
//   shape A (claude via claude-agent-acp):
//     { sessionId, agentId, messages: [{ id, role, content, timestamp }], ... }
//     content: string OR array of { type:"text"|"text_with_context", text }.
//
//   shape B (dsh-acp itself, i.e. our own on-disk records round-tripped):
//     { id, title, messages: [{ role, text, at }], cwd, ... }
//
// Extraction is tolerant: it walks common fields (`content.text`,
// `content[].text`, `text`, `message.content`) and keeps only user/assistant
// turns, dropping empty/system ones.
import { readFileSync, existsSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import {
  createSession,
  ensureSession,
  recordMessage,
  updateSessionMeta,
} from "./archive-store.mjs";

/** Pick the first plausible text out of a message's `content`. */
function extractText(msg) {
  const c = msg?.content;
  if (c == null) return msg?.text ?? "";
  // Array of content blocks (claude / ACP style).
  if (Array.isArray(c)) {
    return c.map((b) => (typeof b?.text === "string" ? b.text : "")).join("\n").trim();
  }
  // Object with a text field.
  if (typeof c === "object") return (typeof c.text === "string" ? c.text : "").trim();
  // Plain string.
  if (typeof c === "string") return c.trim();
  return "";
}

function extractRole(msg) {
  const r = String(msg?.role ?? "").toLowerCase();
  if (r === "user" || r === "human") return "user";
  if (r === "assistant" || r === "ai" || r === "model") return "assistant";
  return "";
}

/** Choose a title for the imported session. */
function pickTitle(data) {
  if (typeof data?.title === "string" && data.title.trim()) return data.title.slice(0, 80);
  const f = data?.sessionId ?? data?.id;
  return `Imported ${String(f ?? "session").slice(0, 16)}`;
}

/**
 * Normalize an external session JSON into { title, cwd, messages:[{role,text}] }.
 * Returns null if no usable content was found.
 */
export function normalizeExternalSession(data) {
  if (!data || typeof data !== "object") return null;
  // messages may live under `messages`, `items`, or `history`.
  const raw = data.messages ?? data.items ?? data.history ?? [];
  if (!Array.isArray(raw)) return null;
  const messages = [];
  for (const m of raw) {
    if (!m || typeof m !== "object") continue;
    const role = extractRole(m);
    if (!role) continue;
    const text = extractText(m);
    if (!text) continue;
    messages.push({ role, text });
  }
  if (messages.length === 0) return null;
  return {
    title: pickTitle(data),
    cwd: typeof data?.cwd === "string" ? data.cwd : process.cwd(),
    messages,
  };
}

/**
 * Import an external session JSON file into the dsh-acp store.
 * Returns { sessionId, title, imported, cwd } or throws on invalid input.
 */
export function importExternalSessionFile(filePath, opts = {}) {
  const abs = isAbsolute(filePath) ? filePath : resolve(process.cwd(), filePath);
  if (!existsSync(abs)) throw new Error(`file not found: ${abs}`);
  const data = JSON.parse(readFileSync(abs, "utf8"));
  const norm = normalizeExternalSession(data);
  if (!norm) throw new Error(`no usable user/assistant messages found in ${abs}`);
  const cwd = opts.cwd || norm.cwd;
  const title = opts.title || norm.title;

  // Create a fresh dsh-acp session record, then append every message so it is
  // both in the durable record and written to the DSH archive format.
  const rec = createSession({ cwd, title });
  let userTurns = 0;
  for (const m of norm.messages) {
    recordMessage(rec.id, m.role, m.text);
    if (m.role === "user") userTurns++;
  }
  return { sessionId: rec.id, title, imported: norm.messages.length, userTurns, cwd };
}

/**
 * CLI entry: `node import-session.mjs <file.json> [--title "x"] [--cwd /path]`
 * or wired into dsh-acp doctor-style subcommands as `node dsh-acp.mjs import <file>`.
 */
export async function runImportCli(argv = process.argv.slice(3)) {
  const fileArg = argv.find((a) => !a.startsWith("--"));
  if (!fileArg) {
    console.error("usage: node dsh-acp.mjs import <external-session.json> [--title '..'] [--cwd /path]");
    process.exit(1);
  }
  const title = (() => {
    const i = argv.indexOf("--title");
    return i >= 0 && argv[i + 1] ? argv[i + 1] : undefined;
  })();
  const cwd = (() => {
    const i = argv.indexOf("--cwd");
    return i >= 0 && argv[i + 1] ? argv[i + 1] : undefined;
  })();
  try {
    const r = importExternalSessionFile(fileArg, { title, cwd });
    console.log(`✅ 导入成功: ${r.sessionId}`);
    console.log(`   title: ${r.title}`);
    console.log(`   消息: ${r.imported} 条 (user ${r.userTurns})  → cwd: ${r.cwd}`);
  } catch (e) {
    console.error(`❌ 导入失败: ${e.message}`);
    process.exit(1);
  }
}
