// test/proxy-history.test.mjs — t44 proxy 多轮记忆四层贯通。零依赖。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url);
const src = (p) => readFileSync(new URL(p, ROOT), "utf8");

// --- L2: 行为级。用 stub fetch 捕获真实 POST body ---------------------------
function stubFetch(capture) {
  const prev = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    capture.url = String(url);
    capture.body = JSON.parse(init.body);
    // 回一个最小 SSE 流：一个 result 事件即结束
    const sse = 'event: result\ndata: {"stopReason":"end_turn","usage":{"totalTokens":1}}\n\n';
    return new Response(sse, { status: 200 });
  };
  return () => { globalThis.fetch = prev; };
}

test("L2 行为: POST body 含 messages（per-session history 上行）", async () => {
  const { forwardPromptViaHttp } = await import("../lib/proxy-mode.mjs");
  const cap = {}; const restore = stubFetch(cap);
  try {
    await forwardPromptViaHttp({
      baseUrl: "http://127.0.0.1:1", sessionId: "s1", prompt: "上一轮我让你记住 778899，是多少？",
      messages: [{ role: "user", content: "请记住 778899" }, { role: "assistant", content: "好的，记住了" }],
      onUpdate: async () => {}, onRequest: async () => ({}),
    });
    assert.equal(cap.url, "http://127.0.0.1:1/acp/proxy/session/prompt");
    assert.ok(Array.isArray(cap.body.messages), "body 必须含 messages 数组");
    assert.equal(cap.body.messages.length, 2);
    assert.deepEqual(cap.body.messages[0], { role: "user", content: "请记住 778899" });
    assert.equal(cap.body.messages[1].role, "assistant");
  } finally { restore(); }
});

test("L2 反例: 无 history 时 POST body **不含** messages key（向后兼容）", async () => {
  const { forwardPromptViaHttp } = await import("../lib/proxy-mode.mjs");
  const cap = {}; const restore = stubFetch(cap);
  try {
    await forwardPromptViaHttp({ baseUrl: "http://127.0.0.1:1", sessionId: "s1", prompt: "hi",
      onUpdate: async () => {}, onRequest: async () => ({}) });
    assert.equal("messages" in cap.body, false, "turn 1 不得凭空带 messages");
  } finally { restore(); }
});

// --- L1+L2 贯通: 真实 archive-store 往返（隔离 store，不碰真实 ~/.dsh）-------
test("L1 行为: recordMessage → getSession().messages 往返（复用持久存储）", async () => {
  const dir = mkdtempSync(join(tmpdir(), "t44-"));
  const prevStore = process.env.DSH_ACP_STORE_DIR, prevHome = process.env.DSH_HOME;
  // 必须在 import archive-store 之前设好隔离目录
  process.env.DSH_ACP_STORE_DIR = dir; process.env.DSH_HOME = join(dir, "dsh");
  try {
    const mod = await import(`../archive-store.mjs?iso=${Date.now()}`);
    const rec = mod.createSession({ cwd: dir, title: "t44" });
    // turn 1：用户+助手各一条（正是 dsh-acp.mjs 的 recordMessage 调用形态）
    mod.recordMessage(rec.id, "user", "请记住 778899");
    mod.recordMessage(rec.id, "assistant", "好的，记住了");
    // getHistory 的复用基础：读回来 + 换成 {role, content}
    const stored = mod.getSession(rec.id).messages;
    assert.equal(stored.length, 2);
    assert.deepEqual(stored.map((m) => ({ role: m.role, content: m.text })),
      [{ role: "user", content: "请记住 778899" }, { role: "assistant", content: "好的，记住了" }]);
  } finally {
    if (prevStore === undefined) delete process.env.DSH_ACP_STORE_DIR; else process.env.DSH_ACP_STORE_DIR = prevStore;
    if (prevHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = prevHome;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("e2e: turn 2 能看到 turn 1；turn 1 反例为空", async () => {
  const dir = mkdtempSync(join(tmpdir(), "t44e-"));
  const prevStore = process.env.DSH_ACP_STORE_DIR, prevHome = process.env.DSH_HOME;
  process.env.DSH_ACP_STORE_DIR = dir; process.env.DSH_HOME = join(dir, "dsh");
  try {
    const mod = await import(`../archive-store.mjs?iso2=${Date.now()}`);
    const s = mod.createSession({ cwd: dir, title: "e2e" });
    // turn 1 开始前：历史必须为空（反例）
    assert.deepEqual(mod.getSession(s.id).messages ?? [], [], "turn 1 不得凭空带历史");
    // turn 1 结束
    mod.recordMessage(s.id, "user", "请记住 778899");
    mod.recordMessage(s.id, "assistant", "好的，记住了");
    // turn 2 开始前：历史里能看到 turn 1
    const h = mod.getSession(s.id).messages.map((m) => ({ role: m.role, content: m.text }));
    assert.equal(h.length, 2, "turn 2 应看到 turn 1 的两条消息");
    assert.ok(h.some((m) => m.content.includes("778899")), "turn 2 必须能看到 turn 1 的关键信息");
  } finally {
    if (prevStore === undefined) delete process.env.DSH_ACP_STORE_DIR; else process.env.DSH_ACP_STORE_DIR = prevStore;
    if (prevHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = prevHome;
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- 字段名一致性 + 中间层守卫（沿 t42 教训，逐层 grep 比对）---------------
test("四层字段名一致: 全部用 messages（逐层 grep 比对，防错位）", () => {
  const l1 = src("dsh-acp.mjs");
  const l2 = src("lib/proxy-mode.mjs");
  const l3 = src("lib/http-gateway.mjs");
  const l4 = src("lib/long-runtime.mjs");
  assert.match(l1, /messages: (history|outboundMessages),/, "L1 必须传 messages");
  assert.match(l2, /\{\s*messages\s*\}/, "L2 必须把 messages 放进 POST body");
  assert.match(l3, /Array\.isArray\(body\.messages\)[^}]*\? \{ messages: body\.messages \}/, "L3 必须读 body.messages 并传给 sessionConfig");
  assert.match(l4, /history: sessionConfig\.messages \?\? \[\]/, "L4 读取处必须仍是 sessionConfig.messages");
  // 防错位：不得出现 content/history/messagesBySession 等替代名
  assert.equal(/sessionConfig\.history\b/.test(l3), false, "L3 不得误用 history 作为 sessionConfig 字段");
});

test("L1 中间层守卫: getHistory 存在、上限 100、且在记录本轮 user 之前取（防重复计数）", () => {
  const l1 = src("dsh-acp.mjs");
  assert.match(l1, /const HISTORY_MAX = 100;/, "必须有 100 条上限");
  assert.match(l1, /function getHistory\(sessionId\)/, "必须有 getHistory");
  assert.match(l1, /slice\(-HISTORY_MAX\)/, "必须按上限裁剪");
  // 顺序：取历史必须在 recordMessage(user) 之前，否则本轮 prompt 会出现两遍
  const iHist = l1.indexOf("const history = getHistory(params.sessionId);");
  const iRec = l1.indexOf('recordMessage(session.id, "user", promptText);');
  assert.ok(iHist > 0 && iRec > iHist, "getHistory 必须早于本轮 user 落库");
  // proxy 路径必须归档 assistant（否则下一轮历史缺它）。
  // t48 更新：该断言原钉在「try 内 return 之前」的旧形态上，而 t48 因 t47 定位
  // （出错时控制流跳过该行）已把归档统一挪进 finally ⇒ 旧形态**按设计消失**，
  // 故此断言改为要求 finally 内的新形态（属需求变更导致的断言更新，非回归）。
  assert.match(l1, /recordMessage\(session\.id, "assistant", assistantText\)/, "proxy 路径必须在 finally 内归档 assistant");
  assert.match(l1, /const assistantText = proxyErrorText \?\? proxyAssistantText;/, "assistant 文本 = 错误文本 优先，其次 SSE 累积");
  assert.match(l1, /return proxyResult;/, "proxy 路径必须返回结果（曾因漏 return 而回归）");
});

// --- t46: 宿主 forAdapter() 契约（assistant 条目必须有 source 对象）---------
/**
 * 忠实模拟宿主 @deepseek-ai/dsh-llm/lib/index.js:2236-2248 的 forAdapter() 访问序。
 * 逐字对应：role!=='assistant' → 原样返回；否则取 message.source → 读 source.replayState。
 */
function hostForAdapterSim(messages) {
  return messages.map((message) => {
    if (message.role !== "assistant") return message;
    const source = message.source;                       // ← 缺 source 时此处得到 undefined
    if (source.replayState === void 0) return message;    // ← 于是这一行抛
    return message;
  });
}

test("t46 反例: assistant 条目**缺** source → 宿主访问 source.replayState 抛错（复现 Windows 崩溃）", () => {
  const buggy = [{ role: "assistant", content: "好的，记住了" }];   // t44 的形状
  assert.throws(() => hostForAdapterSim(buggy),
    /Cannot read properties of undefined \(reading 'replayState'\)/,
    "这正是 Windows 侧 turn 2 的崩溃原文");
});

test("t46 正向: assistant 带 source{kind:'model'} → 宿主不抛（replayState 缺失即 early-return 放行）", () => {
  const fixed = [{ role: "assistant", content: "好的，记住了", source: { kind: "model" } }];
  assert.doesNotThrow(() => hostForAdapterSim(fixed), "最小 source 结构即足够");
  // 语义：因 replayState === undefined，宿主原样返回（不重写 source）
  const out = hostForAdapterSim(fixed);
  assert.equal(out[0], fixed[0], "应原样返回同一个对象引用（early-return 未构造新对象）");
});

test("t46 user 条目不需要 source（宿主对非 assistant 立即 return）", () => {
  const msgs = [{ role: "user", content: "请记住 778899" }];
  assert.doesNotThrow(() => hostForAdapterSim(msgs));
  assert.equal("source" in msgs[0], false);
});

test("t46 源码守卫: getHistory 只为 assistant 补 source，且 user 不补", () => {
  const l1 = src("dsh-acp.mjs");
  assert.match(l1, /\.\.\.\(m\.role === "assistant" \? \{ source: \{ kind: "model" \} \} : \{\}\)/,
    "getHistory 的 map 里必须按 role 条件补 source");
  // 防回归：不得给所有条目无条件加 source
  assert.equal(/\.map\(\(m\) => \(\{ role: m\.role, content: m\.text, source:/.test(l1), false,
    "不得无条件给 user 也加 source");
});

test("t46 端到端形态: 真实 getHistory 形状经宿主模拟后不抛，且 user/assistant 都保留内容", () => {
  // 按 getHistory 的实测输出形状构造（read 侧 slice/filter 后再 map）
  const history = [
    { role: "user", content: "请记住 778899" },
    { role: "assistant", content: "好的，记住了", source: { kind: "model" } },
  ];
  const out = hostForAdapterSim(history);
  assert.equal(out.length, 2);
  assert.ok(out.some((m) => m.content.includes("778899")));
});

// --- t48: proxy 归档移入 finally（单一归档点）+ 出错轮也归档 -----------------
test("t48 源码守卫: 归档在 finally 内，且 proxy 块恰好一处 user + 一处 assistant", () => {
  const l1 = src("dsh-acp.mjs");
  // 1) finally 块内必须有这两条归档
  const fi = l1.indexOf("} finally {\n          // t48 单一归档点");
  assert.ok(fi > 0, "必须存在标注为 t48 单一归档点的 finally 块");
  const fin = l1.slice(fi, fi + 900);
  assert.match(fin, /recordMessage\(session\.id, "user", promptText\)/, "finally 内必须归档 user");
  assert.match(fin, /recordMessage\(session\.id, "assistant", assistantText\)/, "finally 内必须归档 assistant");
  // 2) 旧的「try 内 return 之前」的归档形态必须已消失（否则会重复写）
  assert.equal(/if \(proxyAssistantText\) recordMessage\(session\.id, "assistant", proxyAssistantText\);/.test(l1),
    false, "旧的 try 内归档必须已删除，防重复");
  // 3) 调用**前**的 user 归档也必须已删除（改为 finally 单点）
  assert.equal(/const history = getHistory\(params\.sessionId\);\n\s*try \{ recordMessage\(session\.id, "user", promptText\); \} catch \{\}/.test(l1),
    false, "调用前的 user 归档必须已删除");
  // 4) catch 只记错误文本、不归档
  assert.match(l1, /proxyErrorText = `\[dsh-acp error\] \$\{e\?\.message \?\? String\(e\)\}`/,
    "catch 必须把错误文本记为 [dsh-acp error] 前缀");
  // 5) 失败仍向上抛（保持原语义）
  assert.match(l1, /if \(proxyErrorText\) throw new Error\(proxyErrorText\)/, "proxy 失败必须仍上抛");
});

test("t48 行为: finally 的两条归档 → 恰好 2 条 [user, assistant]（成功轮）", async () => {
  const dir = mkdtempSync(join(tmpdir(), "t48-ok-"));
  const ps = process.env.DSH_ACP_STORE_DIR, ph = process.env.DSH_HOME;
  process.env.DSH_ACP_STORE_DIR = dir; process.env.DSH_HOME = join(dir, "dsh");
  try {
    const m = await import(`../archive-store.mjs?t48a=${Date.now()}`);
    const s = m.createSession({ cwd: dir, title: "ok" });
    // 模拟 finally 单点归档：user + assistant
    m.recordMessage(s.id, "user", "请记住 778899");
    m.recordMessage(s.id, "assistant", "好的，记住了");
    const msgs = m.getSession(s.id).messages;
    assert.equal(msgs.length, 2, "必须恰好 2 条（非 3/4 —— 单归档点）");
    assert.deepEqual(msgs.map(x => x.role), ["user", "assistant"]);
  } finally {
    if (ps === undefined) delete process.env.DSH_ACP_STORE_DIR; else process.env.DSH_ACP_STORE_DIR = ps;
    if (ph === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = ph;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("t48 行为: 出错轮 → [user, assistant([dsh-acp error] …)]，且 turn2 能在历史里看到它", async () => {
  const dir = mkdtempSync(join(tmpdir(), "t48-err-"));
  const ps = process.env.DSH_ACP_STORE_DIR, ph = process.env.DSH_HOME;
  process.env.DSH_ACP_STORE_DIR = dir; process.env.DSH_HOME = join(dir, "dsh");
  try {
    const m = await import(`../archive-store.mjs?t48b=${Date.now()}`);
    const s = m.createSession({ cwd: dir, title: "err" });
    const errorText = `[dsh-acp error] dsh exited 1: error: unknown option '--json'`;
    // 模拟 finally：出错轮也归档（assistantText = proxyErrorText）
    m.recordMessage(s.id, "user", "记住 778899");
    m.recordMessage(s.id, "assistant", errorText);
    const msgs = m.getSession(s.id).messages;
    assert.equal(msgs.length, 2, "出错轮同样是恰好 2 条（不是 1 条，也不是 3 条）");
    assert.deepEqual(msgs.map(x => x.role), ["user", "assistant"]);
    assert.match(msgs[1].text, /^\[dsh-acp error\]/, "出错轮的 assistant 必须带 [dsh-acp error] 前缀");
    // turn2 的前置：历史里能看到 turn1 的 assistant(error)（t47 时这里是缺的）
    assert.ok(msgs.some(x => x.role === "assistant" && x.text.includes("unknown option")),
      "turn2 必须能看到 turn1 的 assistant 归档（含错误信息）");
  } finally {
    if (ps === undefined) delete process.env.DSH_ACP_STORE_DIR; else process.env.DSH_ACP_STORE_DIR = ps;
    if (ph === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = ph;
    rmSync(dir, { recursive: true, force: true });
  }
});
