// web/obsidian-import.mjs — 一键导入 Obsidian Agent Client 生成的会话（P1b 功能 B +
// P2 升级：把 Obsidian 文本消息写入 dsh 原生会话存储，左侧列表立即可见、可 dsh 接续）
//
// Obsidian Agent Client 会在每个 vault 的 `.obsidian/plugins/agent-client/sessions/`
// 下保存会话 json（shape A：{version, sessionId, agentId, messages, savedAt}）。
// 本模块做两件事：
//   1) discoverObsidianSessions()  扫描配置的 Obsidian vaults，列出 agent-client 会话，
//      标注每个是否已被导入 dsh-acp store（按 sessionId 幂等去重）。
//   2) importObsidianSession(jsonPath)           写入 ~/.dsh-acp store（兼容旧路径）
//      importObsidianSessionAsDsh(ctx, jsonPath) 写入 dsh 原生会话（agents.create +
//      sp.create+append 回退），左侧可见、可接续、共享工具/preset
//
// vault 目录来源（优先级）：env DSH_ACP_OBSIDIAN_DIRS（分号分隔）> 内置探测
// ~/Documents/Obsidian Vault 与 ~/projects 及 $HOME 下 name 含 "Obsidian"/"Vault"/"Documents"
// 的目录（避免硬编码用户路径）。可覆盖防止探到无关目录。
import { readdirSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import { normalizeExternalSession, importExternalSessionFile } from "../import-session.mjs";
import { allSessions, updateSessionMeta, dshHome } from "../archive-store.mjs";

const OBSIDIAN_SUBDIR = ".obsidian/plugins/agent-client/sessions";

// ─── 已导入 Obsidian 会话的轻量索引 ────────────────────────────────
// 新导入路径 importObsidianSessionAsDsh 写入 dsh 原生存储（agents.create / sp.create），
// 并不落 ~/.dsh-acp store——因此 discoverObsidianSessions 不能只靠 allSessions()（旧
// store）判定「已导入」，否则导入成功后 imported 仍为 false（按钮无反应）。
// 这里维护一个独立 JSON 索引 { [obsidianPath]: { sessionId, at } }，导入成功后写入，
// discover 时合并判定，修复「导入后仍显示未导入」。
const obsidianImportedIndexPath = () => join(dshHome(), "obsidian-imported.json");

/** 记录一次已成功写入 dsh 原生存储的 Obsidian 导入（幂等，失败静默不影响导入）。 */
export function markObsidianImported(path, sessionId) {
  try {
    const file = obsidianImportedIndexPath();
    let idx = {};
    try { idx = JSON.parse(readFileSync(file, "utf8") || "{}"); } catch { idx = {}; }
    if (!idx || typeof idx !== "object") idx = {};
    idx[path] = { sessionId: sessionId ?? "", at: Date.now() };
    writeFileSync(file, JSON.stringify(idx, null, 2));
  } catch { /* 索引写入失败不阻塞导入主流程 */ }
}

/** 已导入的 Obsidian 会话 path 集合（合并旧 store meta + 新索引）。 */
function alreadyImportedObsidianPaths() {
  const imported = new Set();
  for (const s of allSessions()) {
    if (typeof s.obsidianSessionId === "string") imported.add(s.obsidianSessionId);
    if (typeof s.obsidianFile === "string") imported.add(s.obsidianFile);
  }
  try {
    const idx = JSON.parse(readFileSync(obsidianImportedIndexPath(), "utf8") || "{}");
    if (idx && typeof idx === "object") for (const p of Object.keys(idx)) imported.add(p);
  } catch { /* 索引不可读：仅用旧 store 判定 */ }
  return imported;
}

// DSH 会话事件版本号。
// 0.1.5 起 session 格式升到 V3（SESSION_FORMAT_VERSION = 3）；0.1.2 时代为 0。
// 导入写入的会话必须用宿主当前版本，否则 V3 宿主读 V0 会话会 fail-closed/崩溃。
// （dsh-session 包导出的 SESSION_FORMAT_VERSION 在 0.1.5 为 3。）
const SESSION_FORMAT_VERSION = 3;

// DSH 会话事件类型白名单（与 core.mjs SESSION_EVENT_TYPES 同款小子集；导入路径
// 只产 surface 类 + turn/step 框架 + session/title，足够原生侧恢复折叠视图）。
const SURFACE_EVENT_TYPES = new Set(["user/message", "assistant/message", "tool/result"]);

/** 解析 env 覆盖的 vault 列表（分号/逗号分隔，去空）。 */
function configuredVaults() {
  const raw = process.env.DSH_ACP_OBSIDIAN_DIRS || "";
  return raw.split(/[;,]/).map((s) => s.trim()).filter(Boolean);
}

/** 内置探测：扫描 $HOME 下可能装 Obsidian 的目录，找含 agent-client/sessions 的。 */
function detectVaults() {
  const home = homedir();
  const candidates = new Set();
  // 已知常见位置（不依赖探测也加一份）
  for (const p of [
    resolve(home, "Documents/Obsidian Vault"),
    resolve(home, "projects/app"),
  ]) {
    const sp = join(p, OBSIDIAN_SUBDIR);
    if (existsSync(sp)) candidates.add(p);
  }
  // 兜底：$HOME 一级目录里名字像 vault 的
  let entries = [];
  try { entries = readdirSync(home, { withFileTypes: true }); } catch { entries = []; }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const n = e.name;
    if (/obsidian|vault|documents/i.test(n)) {
      const sp = join(home, n, OBSIDIAN_SUBDIR);
      if (existsSync(sp)) candidates.add(join(home, n));
    }
  }
  return [...candidates];
}

/** 返回 { dir, sessionId, agentId, title, savedAt, imported } 列表（已按最近 savedAt 排序）。 */
export function discoverObsidianSessions() {
  const dirs = configuredVaults().length
    ? configuredVaults().map((d) => ({ base: d, sp: join(d, OBSIDIAN_SUBDIR) }))
    : detectVaults().map((base) => ({ base, sp: join(base, OBSIDIAN_SUBDIR) }));

  // 已导入的 Obsidian sessionId/路径集合（幂等去重依据）：旧 ~/.dsh-acp meta + 新索引。
  const imported = alreadyImportedObsidianPaths();

  const out = [];
  for (const { base, sp } of dirs) {
    if (!existsSync(sp)) continue;
    let files = [];
    try { files = readdirSync(sp).filter((f) => f.endsWith(".json")); } catch { continue; }
    for (const f of files) {
      const p = join(sp, f);
      try {
        const data = JSON.parse(readFileSync(p, "utf8"));
        const sid = data?.sessionId ?? f.replace(/\.json$/, "");
        out.push({
          path: p,
          sessionId: sid,
          agentId: data?.agentId ?? "",
          title: (data && data.title) || pickObsidianTitle(data, sid),
          savedAt: data?.savedAt ?? "",
          messages: Array.isArray(data?.messages) ? data.messages.length : 0,
          // 对话轮数 = user 提问次数（供「会话」合并列表展示）
          userTurns: Array.isArray(data?.messages)
            ? data.messages.filter((m) => m && m.role === "user").length
            : 0,
          vault: base,
          imported: imported.has(sid) || imported.has(p),
        });
      } catch { /* skip unreadable */ }
    }
  }
  out.sort((a, b) => String(b.savedAt).localeCompare(String(a.savedAt)));
  return out;
}

function pickObsidianTitle(data, sid) {
  const first = Array.isArray(data?.messages) ? data.messages.find((m) => m?.role === "user") : null;
  const t = first && first.content && Array.isArray(first.content)
    ? first.content.map((b) => b?.text || "").join(" ").trim()
    : (first && first.text) || "";
  return (t ? t.slice(0, 40) : `Obsidian ${String(sid).slice(0, 8)}`);
}

/**
 * 一键导入一个 Obsidian 会话（jsonPath）到 dsh-acp store（旧 ~/.dsh-acp 路径）。
 * 复用 importExternalSessionFile（已含 normalize + createSession + recordMessage）。
 * 返回 { sessionId, title, imported, userTurns, cwd }。
 */
export function importObsidianSession(jsonPath, opts = {}) {
  const data = JSON.parse(readFileSync(jsonPath, "utf8"));
  const norm = normalizeExternalSession(data);
  if (!norm) throw new Error(`no usable messages: ${jsonPath}`);
  const cwd = opts.cwd || (typeof data?.notesPath === "string" ? join(homedir(), data.notesPath) : norm.cwd);
  const rec = importExternalSessionFile(jsonPath, { cwd, title: opts.title || pickObsidianTitle(data, data?.sessionId) });
  // 记录来源（sessionId + 文件路径），供幂等去重。
  try {
    updateSessionMeta(rec.sessionId, {
      obsidianSessionId: String(data?.sessionId ?? ""),
      obsidianFile: jsonPath,
    });
  } catch {}
  return rec;
}

// ─── DSH 原生会话写入（agents.create + sp.create/append 回退）─────────────
// 复用 dsh-chat-import/lib/import-core.mjs 的 createSession / attachToWorkspace /
// warmProjection 同样的契约；不引入额外耦合——直接消费 host 服务（sessionPersistence /
// agents / workspaceRegistry / sessionProjectionCache / agentPresets / llm / agentDefaultModel）。
// Obsidian 的 text-only 消息序列被压成「user 提问 → assistant 回复」轮次对，每对一轮
//（缺 assistant 的尾随 user 单成一轮），再合成 turn/start + user/message + assistant/
// message + turn/end + 可选 session/title 事件序列（surface 事件带 surfaceOp:'append'）。

/** 把 Obsidian 的 [{role, text}] 序列按 user→assistant 配对折叠成 turns。 */
function pairObsidianTurns(messages) {
  const turns = [];
  let pending = null;
  for (const m of messages) {
    if (!m || typeof m !== "object") continue;
    if (m.role === "user") {
      if (pending) turns.push(pending); // 上一个 user 没等到 assistant，落单 user 轮
      pending = { prompt: m.text, response: null };
    } else if (m.role === "assistant") {
      if (!pending) pending = { prompt: "", response: null };
      pending.response = m.text;
      turns.push(pending);
      pending = null;
    }
  }
  if (pending) turns.push(pending);
  return turns;
}

/**
 * 把 Obsidian 文本消息合成 DSH 事件日志（turn/start + surface user/assistant +
 * turn/end + 可选 session/title）。seq 从 0 连续；surface 事件带 surfaceOp:'append'；
 * assistant 没有响应时只写 user/message（turn 内仍闭合，附 step/end + turn/end）。
 * 返回 { events, messages, turns }：events 用于 sp.append / agents.create seed；
 * messages/turns 供面板展示导入规模。
 */
export function synthesizeDshEvents({ sessionId, title, turns, createdAt, provider, model }) {
  const events = [];
  let seq = 0;
  let turnIdx = 0;
  const baseTime = createdAt || Date.now();
  const push = (type, data, surface) => {
    const ev = { type, seq: seq++, time: baseTime, data };
    if (surface) ev.surfaceOp = "append";
    events.push(ev);
    return ev;
  };
  const mname = model || provider || "unknown";

  for (const t of turns) {
    turnIdx += 1;
    push("turn/start", { turn: turnIdx });
    push("step/start", { turn: turnIdx, step: 1 });
    push("user/message", {
      id: `import:obsidian:${sessionId}:u${turnIdx}`,
      role: "user",
      content: [{ type: "text", text: t.prompt || "" }],
      source: { kind: "user" },
    }, true);
    if (t.response != null) {
      // 0.1.5 要求 assistant/message 携带 **compact timed stream**（数组）—
      // session-stats / session-projection 在 fold 时调用 dsh-llm 的
      // assistantStreamFirstTokenTime(stream) → runFirstTokenTime(record) →
      // firstRunMemberTime(run) 读 run.texts.length（或 run.args for tool-call）。
      //
      // 若 stream 里 record 是 chat content blocks（{type:"text", text:"..."}），
      // record.type 既不是 "chunk" 也不是 "text-chunks"/"reasoning-chunks"/
      // "tool-call-chunks" → 直接走 runFirstTokenTime → record.texts 是 undefined
      // → "Cannot read properties of undefined (reading 'length')"。
      //
      // 正确 compact format（参考 dsh-llm/lib/index.js:1210-1240）：每条 record
      // 是 { type:"chunk", time, chunk:{type:"text-delta", index, text} }
      // 或     { type:"text-chunks", time0, dt, index, texts:["..."] }。
      // 这里用 chunk record 最简单，每 turn 一条。
      push("assistant/message", {
        turn: turnIdx,
        step: 1,
        stream: [{
          type: "chunk",
          time: baseTime,
          chunk: { type: "text-delta", index: 0, text: t.response },
        }],
        message: {
          id: `import:obsidian:${sessionId}:a${turnIdx}`,
          role: "assistant",
          content: [{ type: "text", text: t.response }],
          source: { kind: "model", provider, model: mname },
        },
      }, true);
    }
    push("step/end", { turn: turnIdx, step: 1 });
    push("turn/end", { turn: turnIdx, reason: { kind: "completed" } });
  }

  const normalizedTitle = (title || "").trim();
  if (normalizedTitle.length > 0) {
    push("session/title", {
      title: normalizedTitle.slice(0, 80),
      messageSeqs: [],
      source: { kind: "user" },
    });
  }

  // 清洗：把所有 undefined 递归替换成 null——dsh 事件要求无损 JSON 可序列化，
  // JSON.stringify 会丢弃 undefined（非无损），null 才是可无损的占位。
  const clean = (v) => {
    if (Array.isArray(v)) return v.map(clean);
    if (v && typeof v === "object") {
      const out = {};
      for (const k of Object.keys(v)) {
        const val = clean(v[k]);
        // 跳过 undefined 键；其余（含 null）都保留
        if (val !== undefined) out[k] = val;
      }
      return out;
    }
    return v === undefined ? null : v;
  };
  events.forEach((e) => { e.data = clean(e.data); if (e.raw && e.raw !== undefined) e.raw = clean(e.raw); });

  return {
    events,
    messages: events.filter((e) => SURFACE_EVENT_TYPES.has(e.type)).length,
    turns: turns.length,
  };
}

/** `ctx.get('agents').create` + agentPresets/agentDefaultModel 接线（参考 dsh-chat-import
 * lib/import-core.mjs createSession）。失败回退 sp.create + sp.append。 */
async function createDshSession(ctx, meta, events) {
  const sp = ctx.get?.("sessionPersistence");
  const agents = ctx.get?.("agents");
  const errors = [];

  if (agents && typeof agents.create === "function") {
    let _agentOptions;
    let _presetId;
    try {
      const ap = ctx.get?.("agentPresets");
      let presetId;
      if (ap && typeof ap.resolve === "function") {
        try {
          const preset = await ap.resolve();
          if (preset && typeof preset.id === "string" && preset.id) presetId = preset.id;
        } catch { /* 无默认 preset：继续，工具仍可 mount */ }
      }
      const agentOptions = await resolveAgentOptions(ctx);
      _agentOptions = agentOptions;
      _presetId = presetId;
      await agents.create({
        sessionId: meta.id,
        meta: { ...meta, ...(presetId ? { agentPreset: presetId } : {}) },
        seed: events,
        ...(agentOptions ? { agentOptions } : {}),
        setup: (agentCtx) => {
          const ap2 = ctx.get?.("agentPresets");
          return ap2 && typeof ap2.mount === "function"
            ? ap2.mount(agentCtx, presetId).then(() => {})
            : undefined;
        },
      });
      return { via: "agents.create", presetId: presetId ?? null };
    } catch (err) {
      // 临时诊断：把 agents.create 失败原因 + stack + seed 序列 + args 写到 log，
      // 下次重启 dsh web 后导入新 session 时观察，确定 0.1.5 的拒绝点。
      const msg = String((err && err.message) || err);
      const stack = String((err && err.stack) || "").split("\n").slice(0, 8).join("\n");
      console.warn("[dsh-acp] agents.create failed (will fallback to sp.create):", msg);
      console.warn("[dsh-acp] agents.create stack (first 8 frames):\n" + stack);
      console.warn("[dsh-acp] seed events (first 6 types/seqs):",
        events.slice(0, 6).map((e) => `${e.seq}:${e.type}`).join(", "));
      console.warn("[dsh-acp] meta keys:", Object.keys(meta || {}).join(","));
      console.warn("[dsh-acp] meta cwd:", String(meta?.cwd));
      console.warn("[dsh-acp] meta id:", String(meta?.id));
      console.warn("[dsh-acp] meta title:", String(meta?.title));
      console.warn("[dsh-acp] meta agentPreset:", String(meta?.agentPreset));
      console.warn("[dsh-acp] agentOptions (captured in try):", JSON.stringify(_agentOptions || {}));
      console.warn("[dsh-acp] presetId (captured in try):", String(_presetId));
      errors.push(`agents.create: ${msg}`);
    }
  }

  // 0.1.5：sessionPersistence 改为 SessionHandle 模型
  //   sp.create(header) → SessionHandle → handle.append(events) → handle.flush() → handle.close()
  // header 必需 isSeeded(boolean) + version/id/createdAt；cwd/agentPreset 可选。
  if (sp && typeof sp.create === "function") {
    try {
      const header = {
        version: meta.version,
        id: meta.id,
        createdAt: meta.createdAt,
        ...(typeof meta.cwd === "string" && meta.cwd ? { cwd: meta.cwd } : {}),
        ...(typeof meta.agentPreset === "string" && meta.agentPreset ? { agentPreset: meta.agentPreset } : {}),
        isSeeded: false,
      };
      const handle = await sp.create(header);
      try {
        if (typeof handle?.append === "function") await handle.append(events);
        if (typeof handle?.flush === "function") await handle.flush();
      } finally {
        if (typeof handle?.close === "function") await handle.close();
      }
      return { via: "sessionPersistence", presetId: null, fallback: errors };
    } catch (err) {
      errors.push(`sp.create+append(0.1.5 SessionHandle): ${String((err && err.message) || err)}`);
    }
  }

  throw new Error("dsh 原生会话写入失败：无可用 host 服务（agents / sessionPersistence 均不可用或报错）\n" + errors.join("\n"));
}

/** 解析 dsh 当前默认模型的 { provider, model }（用于 assistant/message 的 model source）。
 *  无可用服务/无默认模型返回 {}（调用方可避免注入非法字段）。 */
async function defaultModelInfo(ctx) {
  try {
    const o = await resolveAgentOptions(ctx);
    if (o && typeof o.provider === "string" && typeof o.model === "string") {
      return { provider: o.provider, model: o.model };
    }
  } catch {}
  return {};
}

async function resolveAgentOptions(ctx) {
  try {
    const adm = ctx.get?.("agentDefaultModel");
    const llm = ctx.get?.("llm");
    if (!adm || typeof adm.currentSelection !== "function") return undefined;
    if (!llm || typeof llm.resolveModelInfo !== "function") return undefined;
    const selection = adm.currentSelection();
    if (!selection || typeof selection.provider !== "string" || typeof selection.model !== "string") return undefined;
    const info = await llm.resolveModelInfo(selection.provider, selection.model);
    const maxTokens = info && typeof info.defaultMaxTokens === "number" && info.defaultMaxTokens > 0 ? info.defaultMaxTokens : undefined;
    return { provider: selection.provider, model: selection.model, ...(maxTokens ? { maxTokens } : {}) };
  } catch {
    return undefined;
  }
}

/** 把导入会话挂到 cwd 对应的工作区（fallback 源目录）。失败仅记录，不阻塞导入。 */
async function attachToWorkspace(ctx, meta, sourcePath) {
  const wr = ctx.get?.("workspaceRegistry");
  if (!wr || typeof wr.resolveByPath !== "function") return false;
  const candidates = [];
  if (meta.cwd) candidates.push(meta.cwd);
  if (sourcePath) {
    try {
      const target = await ctx.fs.resolve(sourcePath);
      const info = await ctx.fs.stat(target);
      candidates.push(info && info.type === "directory" ? sourcePath : join(sourcePath, ".."));
    } catch { /* 源路径 stat 失败：跳过 */ }
  }
  for (const path of candidates) {
    try {
      let ws = await wr.resolveByPath(path);
      if (!ws) ws = await wr.create(path);
      await ws.attachSession(meta.id);
      return true;
    } catch (err) {
      console.warn("[dsh-acp] workspace attach failed for " + path + ": " + String((err && err.message) || err));
    }
  }
  return false;
}

/** 预热投影缓存：让侧边栏无需打开会话即可显示标题/模型等元数据。
 * 0.1.5 sessionProjectionCache.coldSnapshot 的签名在不同版本间不稳定：
 *   - 早期：coldSnapshot(sessionId)
 *   - 中期：coldSnapshot(sessionId, offset) — offset 必填非负整数
 *   - 较新：coldSnapshot(sessionId, offset, options) — options.at 可能被读取
 * 这里依次尝试 3 种签名，任意一个成功即返回 true；全失败静默返回 false
 *（不污染 log；projection 不预热只影响侧栏首屏显示，不影响主界面加载会话）。
 */
async function warmProjection(ctx, sessionId) {
  const cache = ctx.get?.("sessionProjectionCache");
  if (!cache || typeof cache.coldSnapshot !== "function") return false;
  const attempts = [
    [sessionId, 0],
    [sessionId, 0, {}],
    [sessionId, { offset: 0 }],
  ];
  for (const args of attempts) {
    try {
      await cache.coldSnapshot(...args);
      return true;
    } catch { /* 试下一个签名 */ }
  }
  return false;
}

/**
 * 写入 dsh 原生会话存储（左侧列表可见、可接续、共享工具/preset/compression）。
 * 流程：normalize → 合成 events → agents.create / sp.create+append → attachToWorkspace
 * → warmProjection。
 * 返回 { sessionId, title, imported, userTurns, cwd, via }；失败抛错（路由层兜底 500）。
 */
export async function importObsidianSessionAsDsh(ctx, jsonPath, opts = {}) {
  if (!ctx || typeof ctx.get !== "function") {
    throw new Error("ctx 不可用：dsh 原生导入需要 cordis 上下文（host 服务）");
  }
  const data = JSON.parse(readFileSync(jsonPath, "utf8"));
  const norm = normalizeExternalSession(data);
  if (!norm) throw new Error(`no usable messages: ${jsonPath}`);
  const cwd = opts.cwd || (typeof data?.notesPath === "string" ? join(homedir(), data.notesPath) : norm.cwd);
  const title = opts.title || pickObsidianTitle(data, data?.sessionId);

  const turns = pairObsidianTurns(norm.messages);
  if (turns.length === 0) throw new Error(`no usable turns: ${jsonPath}`);

  const sessionId = opts.sessionId || `dsh-obsidian-${randomUUID()}`;
  const createdAt = Date.now();
  const meta = {
    version: SESSION_FORMAT_VERSION,
    id: sessionId,
    createdAt,
    cwd,
    title,
  };
  const syn = synthesizeDshEvents({
    sessionId,
    title,
    turns,
    createdAt,
    // assistant/message 需要有效的 model source，否则 agents.create 拒绝
    // （"message must have model source"）。用 dsh 当前默认模型兜底。
    ...(await defaultModelInfo(ctx)),
  });

  const writeRes = await createDshSession(ctx, meta, syn.events);
  const attached = await attachToWorkspace(ctx, meta, jsonPath);
  const warmed = await warmProjection(ctx, sessionId);

  return {
    sessionId,
    title,
    imported: syn.messages,
    turns: syn.turns,
    userTurns: turns.filter((t) => t.prompt).length,
    cwd,
    via: writeRes.via,
    presetId: writeRes.presetId,
    workspaceAttached: attached,
    projectionWarmed: warmed,
    native: true,
  };
}

export { normalizeExternalSession };