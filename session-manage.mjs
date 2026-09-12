// session-manage.mjs — session management module for the dsh-acp 双界面 plan.
//
// Provides the "会话管理" building blocks used by BOTH the Obsidian ACP adapter
// and (later) the DSH web panel: export / archive / move / list with archive
// filtering. Kept UI-agnostic so a CLI subcommand, an ACP method, or a web panel
// can all call the same logic.
//
// Operations make minimal assumptions about the store layout (delegating to
// archive-store.mjs), so switching to the unified DSH-native `sessions/` repo
// later (P3) only means swapping the store backend, not this module's API.

import {
  getSession,
  archiveSessionId,
  moveSession,
  updateSessionMeta,
  allSessions,
} from "./archive-store.mjs";
import { normalizeExternalSession } from "./import-session.mjs";

/** Format the message history of a session record as a standard envelope. */
export function toEnvelope(session, opts = {}) {
  const msgs = (Array.isArray(session?.messages) ? session.messages : []).map((m) => ({
    id: `m-${m.at ?? 0}`,
    role: m.role === "assistant" ? "assistant" : "user",
    content: [String(m.text ?? "")],
    timestamp: m.at ?? Date.now(),
  }));
  return {
    format: opts.format || "acp",
    sessionId: session.id,
    title: session.title,
    cwd: session.cwd,
    parentSessionId: session.parentSessionId ?? undefined,
    archived: session.archived ?? false,
    exportedAt: new Date().toISOString(),
    messages: msgs,
  };
}

/** Export a session to a JSON string. Supports acp / claude / markdown. */
export function exportSession(sessionId, opts = {}) {
  const rec = getSession(sessionId);
  if (!rec) throw new Error(`session ${sessionId} not found`);
  const format = opts.format || "acp";
  if (format === "claude") {
    // claude-agent-acp shape: { sessionId, agentId, messages:[{id,role,content,timestamp}] }
    return JSON.stringify({
      sessionId: rec.id,
      agentId: "dsh-acp",
      messages: (rec.messages || []).map((m) => ({
        id: `m-${m.at ?? 0}`,
        role: m.role === "assistant" ? "assistant" : "user",
        content: [String(m.text ?? "")],
        timestamp: m.at ?? Date.now(),
      })),
    }, null, 2);
  }
  if (format === "markdown") {
    const lines = [`# ${rec.title}`, "", `- cwd: \`${rec.cwd}\``];
    for (const m of rec.messages || []) {
      lines.push("", `**${m.role === "assistant" ? "AI" : "你"}**:`, String(m.text ?? ""));
    }
    return lines.join("\n");
  }
  return JSON.stringify(toEnvelope(rec, { format }), null, 2);
}

/** Toggle the archived flag on a session. Returns the updated record. */
export function archiveSession(sessionId, archived = true) {
  const rec = getSession(sessionId);
  if (!rec) throw new Error(`session ${sessionId} not found`);
  updateSessionMeta(sessionId, { archived: !!archived });
  return getSession(sessionId);
}

/** Move a session to a new working directory. */
export function manageMoveSession(sessionId, newCwd) {
  return moveSession(sessionId, newCwd);
}

/**
 * List managed sessions with archive filtering.
 * filter: 'active' | 'archived' | 'all' (default 'active').
 */
export function listManagedSessions(filter = "active", cwd) {
  const recs = allSessions();
  let out = recs;
  if (filter === "active") out = recs.filter((r) => r.archived !== true);
  else if (filter === "archived") out = recs.filter((r) => r.archived === true);
  if (cwd) out = out.filter((r) => r.cwd === cwd);
  return out.map((r) => ({
    sessionId: r.id,
    title: r.title,
    cwd: r.cwd,
    archived: r.archived === true,
    summary: r.summary ?? undefined,
    updatedAt: r.updated ?? Date.parse(r.createdAt ?? 0),
  }));
}

/** CLI entry: node dsh-acp.mjs manage <subcommand> ... */
export async function runManageCli(argv = process.argv.slice(3)) {
  const [cmd, ...rest] = argv;
  const flag = (name) => {
    const i = rest.indexOf("--" + name);
    return i >= 0 && rest[i + 1] ? rest[i + 1] : undefined;
  };
  switch (cmd) {
    case "list": {
      const filter = flag("filter") || "active";
      const rows = listManagedSessions(filter, flag("cwd"));
      console.log(`== sessions (${filter}) ==`);
      rows.forEach((r) => console.log(`  ${r.archived ? "[archived] " : ""}${r.sessionId}  ${r.title}  (${r.cwd || "?"})`));
      console.log(`共 ${rows.length} 条`);
      break;
    }
    case "export": {
      const id = rest.find((a) => !a.startsWith("--"));
      if (!id) throw new Error("usage: manage export <sessionId> [--format acp|claude|markdown] [--out file]");
      const text = exportSession(id, { format: flag("format") || "acp" });
      const out = flag("out");
      if (out) { const { writeFileSync } = await import("node:fs"); writeFileSync(out, text, "utf8"); console.log(`已导出到 ${out}`); }
      else console.log(text);
      break;
    }
    case "archive": {
      const id = rest.find((a) => !a.startsWith("--"));
      if (!id) throw new Error("usage: manage archive <sessionId> [--unarchive]");
      const rec = archiveSession(id, !(rest.includes("--unarchive")));
      console.log(rec.archived ? `✅ 已归档 ${id}` : `↩️ 已取消归档 ${id}`);
      break;
    }
    case "move": {
      const [id, newCwd] = rest.filter((a) => !a.startsWith("--"));
      if (!id || !newCwd) throw new Error("usage: manage move <sessionId> <newCwd>");
      const rec = manageMoveSession(id, newCwd);
      console.log(`✅ 已移动 ${id} → cwd: ${rec.cwd}`);
      break;
    }
    case "import": {
      const file = rest.find((a) => !a.startsWith("--"));
      if (!file) throw new Error("usage: manage import <sessionFile.json> [--title '..'] [--cwd /path]");
      const { importExternalSessionFile } = await import("./import-session.mjs");
      const r = importExternalSessionFile(file, { title: flag("title"), cwd: flag("cwd") });
      console.log(`✅ 导入成功: ${r.sessionId} 「${r.title}」 ${r.imported} 条消息`);
      break;
    }
    default:
      console.error("usage: node dsh-acp.mjs manage <list|export|archive|move|import> ...");
      process.exit(1);
  }
}
