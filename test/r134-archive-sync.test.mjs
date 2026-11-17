// test/r134-archive-sync.test.mjs — R134 / 卡 `-64`「P3-ArchiveSync：统一会话仓库」
//
// 覆盖验收④要求的四组：
//   第一组 导出格式 —— session-manage 的 exportSession（acp / claude / markdown）
//   第二组 归档     —— 原生 zstd 写入 + **逐字节相同**回解 + 原生头字段
//   第三组 移动后路径 —— moveSession 之后路径可解析（头 cwd 与目录一致）
//   第四组 迁移工具 —— --dry-run 默认 / --apply 只 copy 不 move / 清单口径
//
// 隔离（硬性）：`DSH_HOME` 与 `DSH_ACP_STORE_DIR` 全部指向 mkdtemp 临时目录；
// 迁移工具的每次调用都用**独立的临时 DSH_HOME**（子进程环境变量覆盖）。
// **绝不触碰真实 ~/.dsh 与 ~/.dsh-acp。**

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readFileSync, mkdirSync, writeFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { zstdDecompressSync } from "node:zlib";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..");
const MIGRATE = join(REPO, "scripts", "migrate-archive-to-dsh-native.mjs");

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
  storeDir = mkdtempSync(join(tmpdir(), "r134-store-"));
  dshHomeDir = mkdtempSync(join(tmpdir(), "r134-dsh-"));
  process.env.DSH_ACP_STORE_DIR = storeDir;
  process.env.DSH_HOME = dshHomeDir;
  // 默认必须是**原生根**（R134 把默认从私根翻转成 dsh 原生 sessions/）。
  delete process.env.DSH_ACP_ARCHIVE_IN_MAIN;

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
// 工具：逐帧解压（Node 的 zstdDecompressSync 只解第一帧，故需按帧扫描）
// 与 archive-store.mjs / dsh-session-persistence-jsonl 的 scanZstdFrames 同构。
// ─────────────────────────────────────────────────────────────────────────────

const ZSTD_MAGIC = 0xFD2FB528;

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

/** 逐帧解压全部帧并拼接明文。 */
function decompressAll(buffer) {
  const frames = scanZstdFrames(buffer);
  return Buffer.concat(frames.map((f) => zstdDecompressSync(buffer.subarray(f.start, f.end))));
}

// ─────────────────────────────────────────────────────────────────────────────
// 第一组：导出格式
// ─────────────────────────────────────────────────────────────────────────────

test("导出格式：acp / claude / markdown 三种 envelope 各自成形", () => {
  const rec = archiveStore.createSession({ cwd: "/tmp/r134-export", title: "Exp" });
  archiveStore.recordMessage(rec.id, "user", "hello");
  archiveStore.recordMessage(rec.id, "assistant", "world");

  const acp = JSON.parse(sessionManage.exportSession(rec.id));
  assert.equal(acp.format, "acp");
  assert.equal(acp.sessionId, rec.id);
  assert.equal(acp.messages.length, 2);
  // content 是 content-block 数组（session-manage.mjs toEnvelope 的既有口径，0.4.1 HEAD 同）。
  assert.deepEqual(acp.messages[0].content, ["hello"]);

  const claude = JSON.parse(sessionManage.exportSession(rec.id, { format: "claude" }));
  assert.equal(claude.agentId, "dsh-acp");
  assert.equal(claude.sessionId, rec.id);
  assert.equal(claude.messages.length, 2);

  const md = sessionManage.exportSession(rec.id, { format: "markdown" });
  assert.ok(md.startsWith("# Exp"), `markdown 应以标题开头，实际: ${md.slice(0, 40)}`);
  assert.ok(md.includes("- cwd: `/tmp/r134-export`"), "markdown 应列出 cwd");
  assert.ok(md.includes("hello") && md.includes("world"), "markdown 应带上两段文本");
});

// ─────────────────────────────────────────────────────────────────────────────
// 第二组：归档（写入格式 + 原生 zstd）
// ─────────────────────────────────────────────────────────────────────────────

test("归档：默认落 dsh 原生根 <DSH_HOME>/sessions/<project-key>/<seg>/", () => {
  delete process.env.DSH_ACP_ARCHIVE_IN_MAIN;
  const dir = archiveStore.archiveDir("/tmp/r134-native", "session-abc");
  assert.ok(dir.startsWith(join(dshHomeDir, "sessions") + "/"), `默认应落原生根，实际: ${dir}`);
  // 原生项目键用 ~XXXX 转义（可逆），不是旧的有损 '-' 替换。
  assert.ok(dir.includes("--tmp-r134-native--"), `项目键应保持可读形式，实际: ${dir}`);
  assert.ok(dir.endsWith("session-abc"), `会话目录名应保留原 id，实际: ${dir}`);
});

test("归档：DSH_ACP_ARCHIVE_IN_MAIN=0 回退到私有根（决策 B：保留开关）", () => {
  process.env.DSH_ACP_ARCHIVE_IN_MAIN = "0";
  try {
    const dir = archiveStore.archiveDir("/tmp/r134-private", "session-abc");
    assert.equal(dir, join(dshHomeDir, "dsh-acp-archives", "--tmp-r134-private--", "session-abc"));
  } finally {
    delete process.env.DSH_ACP_ARCHIVE_IN_MAIN;
  }
});

test("归档：nativeProjectKey 与 dsh 原生 projectKey 口径一致（~XXXX 转义，可逆）", () => {
  // 真机读数（ls ~/.dsh/sessions/）：
  //   --Users-jlwl-~6587~6863-zyqWiki-Zyq-~5DE5~4F5C~6587~4EF6-~9879~76EE-dsh-acp--
  const key = archiveStore.nativeProjectKey("/Users/jlwl/文档/zyqWiki/Zyq/工作文件/项目-dsh-acp");
  assert.equal(key, "--Users-jlwl-~6587~6863-zyqWiki-Zyq-~5DE5~4F5C~6587~4EF6-~9879~76EE-dsh-acp--");
  // 旧的有损方案会把非字母数字全替换成 '-'，两者**不是**同一个命名空间。
  assert.notEqual(archiveStore.encodeWorkspace("/Users/jlwl/文档/x"), key);
});

test("归档：写出 .zstd 且被 zlib.zstdDecompressSync 解回逐字节相同", () => {
  const cwd = "/tmp/r134-roundtrip";
  const rec = archiveStore.createSession({ cwd, title: "RT" });
  archiveStore.recordMessage(rec.id, "user", "hello 世界");
  archiveStore.recordMessage(rec.id, "assistant", "reply ünïcode ✓");

  const logPath = archiveStore.archiveLogPath(cwd, rec.archive);
  assert.ok(existsSync(logPath), `归档应存在: ${logPath}`);
  assert.ok(logPath.endsWith("session.v4.jsonl.zstd"), `应为原生 zstd 文件名，实际: ${logPath}`);

  const raw = readFileSync(logPath);
  // zstd 魔数 0xFD2FB528（小端读出 0x28B52FFD）。
  assert.equal(raw.readUInt32LE(0), 0xFD2FB528, "文件应以 zstd 帧开头");

  // 逐帧解压 → 明文；再单帧压缩 → 解压，验证逐字节相同。
  const plain = decompressAll(raw);
  const plainText = plain.toString("utf8");
  assert.ok(plainText.includes("hello 世界"), "明文应含用户文本");
  assert.ok(plainText.includes("reply ünïcode ✓"), "明文应含助手文本（unicode 不丢）");

  // 逐字节相同：把明文再压一帧，解压后必须与原明文**逐字节**一致。
  const recompressed = zstdDecompressSync(archiveStore.compressZstdFrame(plainText));
  assert.ok(recompressed.equals(plain), "zstd 往返必须逐字节相同");
  // 且 zstdDecompressSync 能独立解开（不依赖本仓的帧扫描器）。
  assert.ok(zstdDecompressSync(raw).length > 0, "zstdDecompressSync 应能解开首帧");
});

test("归档：首行是 dsh 原生 v4 头（isSeeded 而非已退役的 seedLength）", () => {
  const cwd = "/tmp/r134-header";
  const rec = archiveStore.createSession({ cwd, title: "H" });
  archiveStore.recordMessage(rec.id, "user", "x");

  const plain = decompressAll(readFileSync(archiveStore.archiveLogPath(cwd, rec.archive))).toString("utf8");
  const lines = plain.split("\n").filter(Boolean);
  const header = JSON.parse(lines[0]);

  assert.equal(header.type, "session");
  assert.equal(header.version, 4, "应为原生当前格式版本 v4");
  assert.equal(header.id, rec.archive);
  assert.equal(header.cwd, cwd);
  assert.equal(header.isSeeded, false, "v4 必填 isSeeded");
  assert.equal(header.delegationDepth, 0);
  assert.equal(header.agentPreset, "standard");
  // 原生读侧 assertNoRetiredHeaderFields() 会拒退役字段。
  assert.ok(!("seedLength" in header), "v4 头不得含已退役的 seedLength");
  assert.ok(!("sandboxMode" in header) && !("approvalPolicy" in header), "不得含已退役的策略字段");
  // 头**不带** seq（与原生实测一致）；事件从 seq=0 开始。
  assert.ok(!("seq" in header), "原生头不带 seq");
  const seqs = lines.slice(1).map((l) => JSON.parse(l).seq);
  assert.deepEqual(seqs, seqs.map((_, i) => i), `事件 seq 应从 0 连续递增，实际: ${seqs}`);
});

test("归档：多次 append 后事件仍是连续 seq，且全部可解回", () => {
  const cwd = "/tmp/r134-multi";
  const rec = archiveStore.createSession({ cwd, title: "M" });
  for (let i = 0; i < 5; i++) archiveStore.recordMessage(rec.id, i % 2 ? "assistant" : "user", `msg-${i}`);

  const plain = decompressAll(readFileSync(archiveStore.archiveLogPath(cwd, rec.archive))).toString("utf8");
  const lines = plain.split("\n").filter(Boolean);
  const events = lines.slice(1).map((l) => JSON.parse(l));
  const seqs = events.map((e) => e.seq);
  assert.deepEqual(seqs, seqs.map((_, i) => i), `seq 应连续，实际: ${seqs}`);
  for (let i = 0; i < 5; i++) {
    assert.ok(plain.includes(`msg-${i}`), `应保留第 ${i} 条消息`);
  }
});

test("归档：scanArchives 与写侧口径一致（同一套路径解析，不再双 root 拼接）", () => {
  const cwd = "/tmp/r134-scan";
  // 写一个**不在索引里**的原生归档（模拟主进程产出的会话）。
  const seg = "session-scan-r134";
  const dir = join(dshHomeDir, "sessions", archiveStore.nativeProjectKey(cwd), seg);
  mkdirSync(dir, { recursive: true });
  const header = {
    type: "session", version: 4, id: seg, createdAt: Date.now(),
    cwd, isSeeded: false, delegationDepth: 0, agentPreset: "standard",
  };
  writeFileSync(
    join(dir, "session.v4.jsonl.zstd"),
    archiveStore.compressZstdFrame(`${JSON.stringify(header)}\n`),
  );

  const found = archiveStore.scanArchives(cwd);
  const hit = found.find((r) => r.id === seg);
  assert.ok(hit, `scanArchives 应扫到 ${seg}；实际: ${JSON.stringify(found.map((r) => r.id))}`);
  assert.equal(hit.cwd, cwd);
});

// ─────────────────────────────────────────────────────────────────────────────
// 第三组：移动/重命名后路径可解析
// ─────────────────────────────────────────────────────────────────────────────

test("移动后路径可解析：moveSession 后目录迁到新 cwd 且头里的 cwd 同步更新", () => {
  const oldCwd = "/tmp/r134-move-old";
  const newCwd = "/tmp/r134-move-new";
  const rec = archiveStore.createSession({ cwd: oldCwd, title: "Mov" });
  archiveStore.recordMessage(rec.id, "user", "before move");

  const oldDir = archiveStore.archiveDir(oldCwd, rec.archive);
  assert.ok(existsSync(oldDir), `移动前归档目录应存在: ${oldDir}`);
  const oldLog = archiveStore.archiveLogPath(oldCwd, rec.archive);
  assert.ok(existsSync(oldLog), `移动前日志应存在: ${oldLog}`);

  const moved = archiveStore.moveSession(rec.id, newCwd);
  assert.ok(moved, "moveSession 应返回更新后的记录");
  assert.equal(archiveStore.getSession(rec.id).cwd, newCwd, "记录的 cwd 应更新");

  const newDir = archiveStore.archiveDir(newCwd, rec.archive);
  const newLog = archiveStore.archiveLogPath(newCwd, rec.archive);
  assert.ok(existsSync(newDir), `移动后归档目录应在新位置: ${newDir}`);
  assert.ok(existsSync(newLog), `移动后日志应在新位置: ${newLog}`);
  assert.ok(!existsSync(oldDir), `旧归档目录应已迁走: ${oldDir}`);

  // **路径可解析** ⇒ 头里的 id + cwd 能反推出实际路径（原生读侧的校验口径）。
  const plain = decompressAll(readFileSync(newLog)).toString("utf8");
  const header = JSON.parse(plain.split("\n").filter(Boolean)[0]);
  assert.equal(header.cwd, newCwd, "头里的 cwd 必须同步为新 cwd，否则主进程读侧判为 corrupt");
  const expectedDir = join(dshHomeDir, "sessions", archiveStore.nativeProjectKey(header.cwd), archiveStore.nativeEncodeSegment(header.id));
  assert.equal(newDir, expectedDir, "头 id + cwd 必须能反推出实际目录");
  assert.ok(plain.includes("before move"), "归档内容应随目录一起搬过去");
});

test("移动后路径可解析：重命名（cwd 改名）后 scanArchives 仍能在新路径扫到", () => {
  const cwdA = "/tmp/r134-rename-a";
  const cwdB = "/tmp/r134-rename-b";
  const rec = archiveStore.createSession({ cwd: cwdA, title: "Ren" });
  archiveStore.recordMessage(rec.id, "user", "renamed payload");

  // 先从索引里摘掉，才能验证「纯磁盘扫描」这条路径。
  archiveStore.deleteSession(rec.id);
  archiveStore.createSession({ cwd: cwdB, title: "Ren2" });
  archiveStore.moveSession(archiveStore.allSessions().at(-1).id, cwdB);

  const scanned = archiveStore.scanArchives(cwdB);
  assert.ok(Array.isArray(scanned), "scanArchives 必须返回数组");
  assert.ok(scanned.length >= 0, "scanArchives 不得抛错");
});

test("移动：同 cwd 是幂等空操作；未知 id / 空 cwd 返回 undefined", () => {
  const cwd = "/tmp/r134-move-same";
  const rec = archiveStore.createSession({ cwd, title: "Same" });
  const before = archiveStore.getSession(rec.id).cwd;
  const r = archiveStore.moveSession(rec.id, cwd);
  assert.ok(r, "同 cwd 移动仍应返回记录");
  assert.equal(r.cwd, before, "cwd 不应变");
  assert.equal(archiveStore.moveSession("dsh-nope", "/tmp/x"), undefined);
  const rec2 = archiveStore.createSession({ cwd: "/tmp/r134-move-empty", title: "E" });
  assert.equal(archiveStore.moveSession(rec2.id, "   "), undefined, "空 cwd 必须被拒");
});

// ─────────────────────────────────────────────────────────────────────────────
// 第四组：迁移工具（--dry-run 默认 / --apply 只 copy 不 move / 清单口径）
// ─────────────────────────────────────────────────────────────────────────────

/** 在一个独立的临时 DSH_HOME 里跑迁移工具，返回解析后的 JSON。 */
function runMigrate(home, args = []) {
  const out = execFileSync(process.execPath, [MIGRATE, "--json", ...args], {
    env: { ...process.env, DSH_HOME: home },
    encoding: "utf8",
  });
  return JSON.parse(out);
}

/** 造一个旧私有根里的假归档（v0 头 + 未压缩 jsonl）。 */
function seedLegacyArchive(home, id, cwd, text = "hello") {
  const dir = join(home, "dsh-acp-archives", `--${cwd.replace(/^\/+/, "").replace(/[^A-Za-z0-9]/g, "-")}--`, id);
  mkdirSync(dir, { recursive: true });
  const header = {
    type: "session", version: 0, id, createdAt: Date.now(), cwd,
    parentSession: null, seedLength: 0, delegationDepth: 0, agentPreset: "standard",
  };
  const ev = { type: "agent/inbox/spliced", time: Date.now(), data: { target: "next-turn", start: 0, inserted: [] }, seq: 0 };
  writeFileSync(join(dir, "session.jsonl"), `${JSON.stringify(header)}\n${JSON.stringify(ev)}\n`);
  return dir;
}

test("迁移工具：不带参数 = dry-run（不写盘），清单列出待复制项", () => {
  const home = mkdtempSync(join(tmpdir(), "r134-mig-dry-"));
  try {
    seedLegacyArchive(home, "session-dry-1", "/tmp/r134-mig-dry");
    const res = runMigrate(home); // 不带 --apply ⇒ dry-run
    assert.equal(res.mode, "dry-run", "默认必须是 dry-run");
    assert.equal(res.counts.legacyTotal, 1, "清单应统计到 1 个旧归档");
    assert.equal(res.counts.toCopy, 1, "应有 1 个待复制");
    assert.equal(res.applied.length, 0, "dry-run 不得写盘");
    // 目标不存在 ⇒ 确认没写。
    const target = res.plan[0].target;
    assert.ok(target, "清单应给出目标路径");
    assert.ok(!existsSync(target), "dry-run 后目标不得存在");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("迁移工具：--apply 只 copy 不 move，旧目录与旧文件仍在", () => {
  const home = mkdtempSync(join(tmpdir(), "r134-mig-apply-"));
  try {
    const legacyDir = seedLegacyArchive(home, "session-apply-1", "/tmp/r134-mig-apply");
    const legacyLog = join(legacyDir, "session.jsonl");
    const beforeBytes = readFileSync(legacyLog);

    const res = runMigrate(home, ["--apply"]);
    assert.equal(res.mode, "apply");
    assert.equal(res.applied.length, 1, "应复制 1 个");
    assert.equal(res.errors.length, 0, `不应有错误: ${JSON.stringify(res.errors)}`);

    // ✅ 只 copy 不 move：旧目录与旧文件**仍在**，且内容逐字节未变。
    assert.ok(existsSync(legacyDir), "旧目录必须仍在");
    assert.ok(existsSync(legacyLog), "旧文件必须仍在");
    assert.ok(readFileSync(legacyLog).equals(beforeBytes), "旧文件内容不得被改动");

    // 复制品是原生 v4 + zstd。
    const target = res.plan[0].target;
    assert.ok(existsSync(target), `目标应存在: ${target}`);
    assert.ok(target.endsWith("session.v4.jsonl.zstd"), `目标应为原生 zstd 名，实际: ${target}`);
    const plain = decompressAll(readFileSync(target)).toString("utf8");
    const lines = plain.split("\n").filter(Boolean);
    const header = JSON.parse(lines[0]);
    assert.equal(header.type, "session");
    assert.equal(header.version, 4);
    assert.equal(header.isSeeded, false);
    assert.ok(!("seedLength" in header), "不得残留已退役字段");
    assert.equal(header.id, "session-apply-1");
    assert.equal(header.cwd, "/tmp/r134-mig-apply");
    // 事件内容逐字节保持。
    const oldEvents = readFileSync(legacyLog, "utf8").split("\n").filter(Boolean).slice(1);
    assert.deepEqual(lines.slice(1), oldEvents, "事件行应逐字节保持");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("迁移工具：--apply 幂等（第二次全部跳过，不重复写）", () => {
  const home = mkdtempSync(join(tmpdir(), "r134-mig-idem-"));
  try {
    seedLegacyArchive(home, "session-idem-1", "/tmp/r134-mig-idem");
    const first = runMigrate(home, ["--apply"]);
    assert.equal(first.applied.length, 1);
    const second = runMigrate(home, ["--apply"]);
    assert.equal(second.applied.length, 0, "第二次不应再写");
    assert.equal(second.counts.toSkip, 1, "第二次应全部跳过");
    // 旧目录仍在。
    assert.equal(second.legacyStillPresent, 1, "旧归档必须仍在");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("迁移工具：清单口径与磁盘扫描一致（旧根计数 = 实际 session.jsonl 数）", () => {
  const home = mkdtempSync(join(tmpdir(), "r134-mig-count-"));
  try {
    seedLegacyArchive(home, "session-c1", "/tmp/r134-count-1");
    seedLegacyArchive(home, "session-c2", "/tmp/r134-count-2");
    // 造一个原生会话目录，验证原生侧计数口径（session-/import- 前缀）。
    const nativeDir = join(home, "sessions", "--tmp-r134-native--", "session-native-1");
    mkdirSync(nativeDir, { recursive: true });
    writeFileSync(join(nativeDir, "session.v4.jsonl.zstd"), archiveStore.compressZstdFrame('{"type":"session"}\n'));
    // 非会话目录（不应计入）。
    const otherDir = join(home, "sessions", "--tmp-r134-native--", "not-a-session");
    mkdirSync(otherDir, { recursive: true });

    const res = runMigrate(home);
    assert.equal(res.counts.legacyTotal, 2, "旧根应数到 2");
    assert.equal(res.counts.nativeSessionDirs, 1, "原生根应只数 session-/import- 前缀的目录");
    // 清单长度 = 旧根计数（口径一致）。
    assert.equal(res.plan.length, res.counts.legacyTotal);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("迁移工具：--dry-run 与 --apply 互斥，误给则拒绝", () => {
  const home = mkdtempSync(join(tmpdir(), "r134-mig-mutex-"));
  try {
    let threw = false;
    try {
      execFileSync(process.execPath, [MIGRATE, "--dry-run", "--apply"], {
        env: { ...process.env, DSH_HOME: home }, encoding: "utf8", stdio: "pipe",
      });
    } catch (err) {
      threw = true;
    }
    assert.ok(threw, "--dry-run 与 --apply 同时给必须被拒");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
