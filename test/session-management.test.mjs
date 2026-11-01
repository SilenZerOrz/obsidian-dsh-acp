// test/session-management.test.mjs — P1a-Test: 会话管理单测补。
//
// 覆盖三组（对应 需求文档 §5 P1a-Test）：
//   第一组 导出格式 —— toEnvelope / exportSession（acp / claude / markdown）
//   第二组 归档     —— archiveDir / archiveLogPath / appendArchiveEvent / scanArchives
//   第三组 移动     —— moveSession 之后的 cwd 与归档目录改名行为
//
// 隔离（硬性）：archive-store.mjs 的 storeRoot() 读 DSH_ACP_STORE_DIR、
// dshHome() 读 DSH_HOME（源码注释明写 "Overridable for tests"）。
// before() 把两者指向 mkdtemp 临时目录，after() 恢复并清理。
// **不触碰真实 ~/.dsh-acp 与 ~/.dsh。**

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let storeDir;
let dshHomeDir;
let savedEnv;
let archiveStore;
let sessionManage;

before(async () => {
  savedEnv = {
    DSH_ACP_STORE_DIR: process.env.DSH_ACP_STORE_DIR,
    DSH_HOME: process.env.DSH_HOME,
    DSH_ACP_ARCHIVE_IN_MAIN: process.env.DSH_ACP_ARCHIVE_IN_MAIN,
  };
  storeDir = mkdtempSync(join(tmpdir(), "sm-store-"));
  dshHomeDir = mkdtempSync(join(tmpdir(), "sm-dsh-"));
  process.env.DSH_ACP_STORE_DIR = storeDir;
  process.env.DSH_HOME = dshHomeDir;
  delete process.env.DSH_ACP_ARCHIVE_IN_MAIN;

  // Import AFTER env is set — module-level `storeRoot()`/`dshHome()` are
  // functions (read env lazily), so either order works, but importing here
  // keeps the intent explicit.
  archiveStore = await import("../archive-store.mjs");
  sessionManage = await import("../session-manage.mjs");
});

after(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try { rmSync(storeDir, { recursive: true, force: true }); } catch {}
  try { rmSync(dshHomeDir, { recursive: true, force: true }); } catch {}
});

// ─────────────────────────────────────────────────────────────────────────────
// 第一组：导出格式
// ─────────────────────────────────────────────────────────────────────────────

test("toEnvelope: defaults to format 'acp' and normalises roles + message ids", () => {
  const rec = {
    id: "dsh-x1",
    title: "T1",
    cwd: "/tmp/proj",
    messages: [
      { role: "user", text: "hi", at: 1000 },
      { role: "assistant", text: "yo", at: 2000 },
      { role: "system", text: "sys", at: 3000 }, // 非 assistant 一律归一为 user
    ],
  };
  const env = sessionManage.toEnvelope(rec);
  assert.equal(env.format, "acp", "default format must be 'acp'");
  assert.equal(env.sessionId, "dsh-x1");
  assert.equal(env.title, "T1");
  assert.equal(env.cwd, "/tmp/proj");
  assert.equal(env.archived, false);
  assert.ok(typeof env.exportedAt === "string" && env.exportedAt.length > 0);
  // messages: role 归一 + id 形如 m-<at> + content 是字符串数组
  assert.deepEqual(env.messages.map((m) => m.role), ["user", "assistant", "user"]);
  assert.deepEqual(env.messages.map((m) => m.id), ["m-1000", "m-2000", "m-3000"]);
  assert.deepEqual(env.messages[0].content, ["hi"]);
  assert.deepEqual(env.messages.map((m) => m.timestamp), [1000, 2000, 3000]);
});

test("toEnvelope: honours a custom format option", () => {
  const rec = { id: "dsh-x2", title: "T", cwd: "/c", messages: [] };
  assert.equal(sessionManage.toEnvelope(rec, { format: "claude" }).format, "claude");
});

test("exportSession: acp / claude / markdown produce their own shapes", () => {
  const rec = archiveStore.createSession({ cwd: "/tmp/export-proj", title: "Exp" });
  archiveStore.recordMessage(rec.id, "user", "hello");
  archiveStore.recordMessage(rec.id, "assistant", "world");

  // acp → JSON with envelope fields
  const acp = JSON.parse(sessionManage.exportSession(rec.id));
  assert.equal(acp.format, "acp");
  assert.equal(acp.sessionId, rec.id);
  assert.equal(acp.messages.length, 2);

  // claude → JSON with { sessionId, agentId, messages }
  const claude = JSON.parse(sessionManage.exportSession(rec.id, { format: "claude" }));
  assert.equal(claude.agentId, "dsh-acp");
  assert.equal(claude.sessionId, rec.id);
  assert.equal(claude.messages.length, 2);
  assert.equal(claude.messages[0].role, "user");

  // markdown → plain text with a heading + speaker labels
  const md = sessionManage.exportSession(rec.id, { format: "markdown" });
  assert.ok(md.startsWith("# Exp"), `markdown should start with the title heading, got: ${md.slice(0, 40)}`);
  assert.ok(md.includes("- cwd: `/tmp/export-proj`"), "markdown should list the cwd");
  assert.ok(md.includes("**你**:"), "markdown should label the user turn");
  assert.ok(md.includes("**AI**:"), "markdown should label the assistant turn");
  assert.ok(md.includes("hello") && md.includes("world"), "markdown should carry both texts");
});

test("exportSession: unknown sessionId throws", () => {
  assert.throws(
    () => sessionManage.exportSession("dsh-does-not-exist"),
    /not found/,
    "exporting a missing session must throw",
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// 第二组：归档
// ─────────────────────────────────────────────────────────────────────────────

test("archiveSessionId: always returns a fresh 'session-<uuid>'", () => {
  const a = archiveStore.archiveSessionId("/tmp/a", "t");
  const b = archiveStore.archiveSessionId("/tmp/a", "t");
  assert.match(a, /^session-[0-9a-f-]{36}$/, `expected session-<uuid>, got ${a}`);
  assert.notEqual(a, b, "two calls must produce different ids");
});

test("archiveDir: default root is <DSH_HOME>/dsh-acp-archives/<enc>/<id>", () => {
  delete process.env.DSH_ACP_ARCHIVE_IN_MAIN;
  const dir = archiveStore.archiveDir("/tmp/proj", "session-abc");
  assert.equal(dir, join(dshHomeDir, "dsh-acp-archives", "--tmp-proj--", "session-abc"));
});

test("archiveDir: DSH_ACP_ARCHIVE_IN_MAIN=1 switches the root to <DSH_HOME>/sessions/", () => {
  process.env.DSH_ACP_ARCHIVE_IN_MAIN = "1";
  try {
    const dir = archiveStore.archiveDir("/tmp/proj", "session-abc");
    assert.equal(dir, join(dshHomeDir, "sessions", "--tmp-proj--", "session-abc"));
  } finally {
    delete process.env.DSH_ACP_ARCHIVE_IN_MAIN;
  }
});

test("encodeWorkspace: leading / dropped, non-alnum → '-', wrapped in --…--", () => {
  assert.equal(archiveStore.encodeWorkspace("/home/user/projects/app"), "--home-user-projects-app--");
  assert.equal(archiveStore.encodeWorkspace("/tmp/a_b.c"), "--tmp-a-b-c--");
});

test("archiveLogPath: <archiveDir>/session.jsonl", () => {
  delete process.env.DSH_ACP_ARCHIVE_IN_MAIN;
  const dir = archiveStore.archiveDir("/tmp/p", "session-x");
  assert.equal(archiveStore.archiveLogPath("/tmp/p", "session-x"), join(dir, "session.jsonl"));
});

test("appendArchiveEvent: writes a session header + seq'd events, readable back as JSONL", () => {
  const rec = archiveStore.createSession({ cwd: "/tmp/arch-proj", title: "Arch" });
  const logPath = archiveStore.appendArchiveEvent(rec, "user", "hello");
  archiveStore.appendArchiveEvent(rec, "assistant", "world");

  assert.ok(existsSync(logPath), `archive log should exist at ${logPath}`);
  const lines = readFileSync(logPath, "utf8").split("\n").filter(Boolean);
  assert.ok(lines.length >= 2, `expected >=2 lines, got ${lines.length}`);
  const objs = lines.map((l) => JSON.parse(l));

  // Header line must be a DSH 'session' event and only appear ONCE.
  const headers = objs.filter((o) => o.type === "session");
  assert.equal(headers.length, 1, `expected exactly 1 session header, got ${headers.length}`);
  assert.equal(headers[0].version, 0);
  assert.equal(headers[0].cwd, "/tmp/arch-proj");
  assert.equal(headers[0].agentPreset, "standard");

  // Every non-header line carries a numeric seq, strictly increasing from 0.
  const events = objs.filter((o) => o.type !== "session");
  assert.ok(events.length >= 2, `expected >=2 events, got ${events.length}`);
  assert.deepEqual(events.map((e) => e.seq), events.map((_, i) => i));

  // The user turn is an agent/inbox/spliced carrying the text; the assistant
  // turn additionally closes a turn (turn/end).
  const spliced = events.filter((e) => e.type === "agent/inbox/spliced");
  assert.ok(spliced.length >= 2, `expected spliced events for both turns, got ${spliced.length}`);
  assert.equal(spliced[0].data.inserted[0].content[0].text, "hello");
  assert.equal(spliced[0].data.inserted[0].role, "user");
  assert.ok(events.some((e) => e.type === "turn/end"), "assistant turn should close with turn/end");
});

test("scanArchives: reads back sessions written under <DSH_HOME>/sessions", () => {
  // Write a fake DSH-official archive directly (scanArchives reads sessions/, not
  // dsh-acp-archives/), then assert it is surfaced.
  const cwd = "/tmp/scan-proj";
  const enc = archiveStore.encodeWorkspace(cwd);
  const archive = "session-scan-1";
  const dir = join(dshHomeDir, "sessions", enc, archive);
  mkdirSync(dir, { recursive: true });
  const header = {
    type: "session", version: 0, id: archive, createdAt: Date.now(),
    cwd, parentSession: null, seedLength: 0, delegationDepth: 0, agentPreset: "standard",
  };
  writeFileSync(join(dir, "session.jsonl"), JSON.stringify({ ...header, seq: 0 }) + "\n");

  const found = archiveStore.scanArchives(cwd);
  assert.ok(Array.isArray(found), "scanArchives must return an array");
  const hit = found.find((r) => r.archive === archive || r.id === archive);
  assert.ok(hit, `scanArchives should surface ${archive}; got ${JSON.stringify(found.map((r) => r.id ?? r.archive))}`);
});

// ─────────────────────────────────────────────────────────────────────────────
// 第三组：移动后路径重命名
// ─────────────────────────────────────────────────────────────────────────────

test("moveSession: updates cwd and relocates the archive dir to the new workspace", () => {
  delete process.env.DSH_ACP_ARCHIVE_IN_MAIN;
  const oldCwd = "/tmp/move-old";
  const newCwd = "/tmp/move-new";
  const rec = archiveStore.createSession({ cwd: oldCwd, title: "Mov" });
  archiveStore.recordMessage(rec.id, "user", "before move");

  const oldDir = archiveStore.archiveDir(oldCwd, rec.archive);
  assert.ok(existsSync(oldDir), `archive dir should exist before move: ${oldDir}`);

  const moved = archiveStore.moveSession(rec.id, newCwd);
  assert.ok(moved, "moveSession should return the updated record");
  assert.equal(archiveStore.getSession(rec.id).cwd, newCwd, "record cwd must be the new cwd");

  const newDir = archiveStore.archiveDir(newCwd, rec.archive);
  assert.ok(existsSync(newDir), `archive dir should exist at the NEW workspace after move: ${newDir}`);
  assert.ok(!existsSync(oldDir), `OLD archive dir should be gone after move: ${oldDir}`);

  // The archived content travelled with the directory.
  const log = join(newDir, "session.jsonl");
  assert.ok(existsSync(log), `archive log should be at the new location: ${log}`);
  assert.ok(readFileSync(log, "utf8").includes("before move"), "archived text should survive the move");
});

test("moveSession: same-cwd is a no-op that returns the record unchanged", () => {
  const cwd = "/tmp/move-same";
  const rec = archiveStore.createSession({ cwd, title: "Same" });
  const before = archiveStore.getSession(rec.id).cwd;
  const r = archiveStore.moveSession(rec.id, cwd);
  assert.ok(r, "same-cwd move should still return the record");
  assert.equal(r.cwd, before, "cwd must be unchanged");
});

test("moveSession: unknown id returns undefined; empty cwd returns undefined", () => {
  assert.equal(archiveStore.moveSession("dsh-nope", "/tmp/x"), undefined);
  const rec = archiveStore.createSession({ cwd: "/tmp/move-empty", title: "E" });
  assert.equal(archiveStore.moveSession(rec.id, "   "), undefined, "blank cwd must be rejected");
});
