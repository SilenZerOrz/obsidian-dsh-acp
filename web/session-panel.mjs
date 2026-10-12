// web/session-panel.mjs — dsh web 「会话管理」面板的后端路由（REQ-P1b + P2 升级）
//
// 在 DSH web 侧挂出 /api-session/* 的 HTTP 路由，供前端 client.js 通过
// fetch() 调用。两条数据源并存：
//
//   * dsh 原生会话（左侧列表来源）：通过 ctx.get('sessionPersistence') 读 sp.list()
//     / sp.readFrom(id, 0) / sp.inspect(id)——左侧侧栏可见、可 dsh 接续、可共享工具
//     + preset + 自动压缩。导入走 ctx.get('agents').create(...) 优先，回退 sp.create
//     + sp.append（旧路径，工具不可见、不会自动压缩）；最终 warmProjection 让侧栏
//     不打开即显示标题/模型。
//   * dsh-acp 私有归档（~/.dsh-acp）：保留旧 API（list / export / archive / move /
//     obsidian-list / obsidian-import）。前端「DSH 原生会话」视图同时调用 dsh 原生
//     数据源，原有「会话」视图保留 ~/.dsh-acp 列表以维持管理能力（导出/归档/移动）。
//
// webServer 是可选 host 服务且晚挂载——apply 时 ctx.get('webServer') 仍为空，
// 必须经 ctx.inject(['webServer'], ...) 在服务可用时再注册路由；headless /
// 无 Web 的 profile（CI 冒烟、CLI-only 场景）回调永不执行，ACP adapter 与
// manage CLI 路径不受影响，插件不因缺服务抛错激活失败。
//
// 契约（与 dsh-chat-import 的 /api-import/* 一致）：
//   POST /api-session/list            body:{filter?:'active'|'archived'|'all', cwd?:string}
//                                   -> { ok:true, sessions:[{sessionId,title,cwd,archived,summary,updatedAt}] }
//   POST /api-session/export          body:{sessionId, format?:'acp'|'claude'|'markdown'}
//                                   -> { ok:true, text, sessionId, format }
//   POST /api-session/archive         body:{sessionId, archived:boolean}
//                                   -> { ok:true, session }
//   POST /api-session/delete          body:{sessionId, mode:'trash'|'restore'|'permDel'}
//                                   -> { ok:true, session } | { ok:true, deleted:true, sessionId }
//                                      仅 dsh-acp 私有归档范围；trash/restore 无损，permDel 真删
//   POST /api-session/move            body:{sessionId, cwd}
//                                   -> { ok:true, session }
//
//   POST /api-session/dsh-list        body:{}
//                                   -> { ok:true, sessions:[{sessionId,title,cwd,updatedAt,...}] }
//                                      调 sp.list()，与 dsh 主进程侧栏同源。
//   POST /api-session/dsh-read        body:{sessionId, fromSeq?:number}
//                                   -> { ok:true, sessionId, meta, events }
//                                      调 sp.readFrom(id, fromSeq||0)，供面板预览 /
//                                      dsh 接续展示。
//   POST /api-session/obsidian-list   body:{}
//                                   -> { ok:true, sessions:[...] }
//   POST /api-session/obsidian-import body:{path}
//                                   -> { ok:true, sessionId, title, imported, userTurns, cwd, native, via }
//                                      写入 dsh 原生会话（agents.create 优先，回退 sp.create+append）
//                                   / { ok:false, error }
//
// 设计要点：
//  * ctx 通过闭包持有（handler 内 ctx.get('sessionPersistence') / ctx.get('agents') /
//    ctx.get('workspaceRegistry') / ctx.get('sessionProjectionCache') 延迟取，host
//    服务晚挂载时也能稳健工作——即便 service 在路由注册后才发布，handler 触发时已就绪）。
//  * DSH 原生路由（dsh-list/dsh-read/obsidian-import）回退到原 ~/.dsh-acp 路径：
//    ctx.get('sessionPersistence') 返回 undefined → 返回 {ok:false, error:'...'}，
//    前端按用户场景降级（旧面板仍可用）。
//  * 不向 webServer 注册新服务，只复用现有 P1a 逻辑与 dsh 原生 host 服务——保持前端
//    可以独立升级而不影响 manage CLI / ACP 路径。
//  * 只依赖 @deepseek-ai/dsh-client-locale 不在本后端：locale 是前端服务。

import {
  listManagedSessions,
  exportSession,
  archiveSession,
  trashSession,
  manageMoveSession,
} from "../session-manage.mjs";
import { deleteSession } from "../archive-store.mjs";
import {
  discoverObsidianSessions,
  importObsidianSession,
  importObsidianSessionAsDsh,
  markObsidianImported,
} from "./obsidian-import.mjs";

/** 读请求 body 的 JSON（空 body 按 {}；畸形 JSON 由路由 catch 兜底）。 */
async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(String(chunk));
  return JSON.parse(chunks.join("") || "{}");
}

/** 统一错误响应：始终 200 + {ok:false, error}（与 /api-import/* 一致，便于前端 readJson 兜底）。 */
function sendError(res, statusCode, message) {
  res.writeHead(statusCode, { "content-type": "application/json" });
  res.end(JSON.stringify({ ok: false, error: String(message) }));
}

/** dsh 原生 list 响应字段归一。
 *  0.1.5 `sp.list()` 返回 `{header, revision, eventCount, sizeBytes}`（SessionPersistenceSnapshot）
 *  —— 先取 .header；0.1.2 直接返回 header 数组（{id,title,cwd,...}）。两者都归一成同一形状。 */
function summarizeDshHeader(h) {
  if (!h || typeof h !== "object") return null;
  const src = h && typeof h === "object" && h.header && typeof h.header === "object"
    ? h.header
    : h;
  const sessionId = src.id || src.sessionId;
  if (!sessionId) return null;
  return {
    sessionId,
    id: sessionId,
    title: typeof src.title === "string" ? src.title : "",
    cwd: typeof src.cwd === "string" ? src.cwd : "",
    archived: src.archived === true,
    updatedAt: typeof src.updatedAt === "number" ? src.updatedAt
      : (typeof src.updated === "number" ? src.updated : Date.now()),
    source: typeof src.source === "string" ? src.source : "",
    // 透传会话总结概要（dsh 原生压缩/摘要若提供，则直接用于前端「会话」列表展示）
    ...(typeof src.summary === "string" && src.summary ? { summary: src.summary } : {}),
    // 透传任意额外字段（model / agentPreset / 等）便于面板展示
    ...(src.model ? { model: src.model } : {}),
    ...(src.agentPreset ? { agentPreset: src.agentPreset } : {}),
    ...(src.parentSessionId ? { parentSessionId: src.parentSessionId } : {}),
    // 0.1.5 snapshot 附带：事件数 / 字节数 / 修订 token（面板可显示大小）
    ...(typeof h?.eventCount === "number" ? { eventCount: h.eventCount } : {}),
    ...(typeof h?.sizeBytes === "number" ? { sizeBytes: h.sizeBytes } : {}),
  };
}

/** 读 dsh 原生会话的「对话轮数 + 概要」，用于「会话」合并列表展示（有则显、无则占位）。
 *  轮数 = 事件中 turn/start 数量；概要 = header.summary（压缩摘要）或首条 user 消息前 40 字。
 *  读取失败返回空字段，不阻塞列表。 */
async function summarizeDshSessionDetail(sp, sessionId) {
  const detail = { turns: 0, summary: "", title: "" };
  try {
    if (typeof sp.open !== "function") return detail;
    const handle = await sp.open(sessionId, "read");
    try {
      const r = await handle.read(0);
      const events = (r && Array.isArray(r.events)) ? r.events : [];
      // 标题：sp.list() 的 header 没有 title 字段（header schema 仅含
      // version/id/createdAt/cwd/parentSession/isSeeded/origin/delegationDepth/agentPreset），
      // 标题通过 session/title 事件折叠得到。dsh 自身的 left sidebar 走
      // sessionProjectionCache.cachedSnapshot(含 values.title)；我们的 /dsh-list 是直接
      // 落盘快照，没拿投影——所以手工 fold 一份，从尾部向前取最后一个 session/title。
      let lastTitleEvent = null;
      for (const e of events) {
        if (!e || typeof e !== "object") continue;
        if (e.type === "turn/start") detail.turns++;
        if (!detail.summary && e.type === "user/message") {
          const c = e.data && Array.isArray(e.data.content) ? e.data.content : [];
          detail.summary = c
            .map((b) => (b && b.text) || "").join(" ").replace(/\s+/g, " ").trim().slice(0, 40);
        }
        if (e.type === "session/title" && e.data && typeof e.data.title === "string") {
          lastTitleEvent = e; // 不立即覆盖：保留最后一个（findLast 等价）
        }
      }
      if (lastTitleEvent) detail.title = lastTitleEvent.data.title;
      const hdr = handle.header || {};
      if (!detail.summary && typeof hdr.summary === "string" && hdr.summary) {
        detail.summary = hdr.summary.slice(0, 80);
      }
    } finally {
      if (typeof handle?.close === "function") await handle.close();
    }
  } catch { /* 读取失败：保留空字段 */ }
  return detail;
}

/** 注册 P1b 面板路由到 dsh webServer。ctx 是 apply 的外层 ctx（handler 闭包用它访问
 * host 服务；webServer 经 ctx.inject 延迟挂载，handler 触发时 host 服务应已就绪）。 */
export function registerSessionPanelRoutes(ctx, ws) {
  // ─── 旧路径：dsh-acp 私有归档 ~/.dsh-acp（list / export / archive / move）───

  // 列出会话（支持 filter active/archived/all，cwd 可选）。
  ws.register({
    kind: "exact",
    path: "/api-session/list",
    handler: async (req, res) => {
      try {
        const body = await readBody(req);
        const filter = ["active", "archived", "trashed", "all"].includes(body.filter) ? body.filter : "active";
        const cwd = typeof body.cwd === "string" && body.cwd ? body.cwd : undefined;
        const sessions = listManagedSessions(filter, cwd);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, sessions, filter }));
      } catch (err) {
        sendError(res, 500, (err && err.message) || err);
      }
    },
  });

  // 导出单个会话（text 字段，前端按 format 决定如何展示/下载）。
  ws.register({
    kind: "exact",
    path: "/api-session/export",
    handler: async (req, res) => {
      try {
        const body = await readBody(req);
        const sessionId = typeof body.sessionId === "string" ? body.sessionId : "";
        if (!sessionId) {
          sendError(res, 400, "sessionId 必填");
          return;
        }
        const format = ["acp", "claude", "markdown"].includes(body.format) ? body.format : "acp";
        const text = exportSession(sessionId, { format });
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, sessionId, format, text }));
      } catch (err) {
        sendError(res, 500, (err && err.message) || err);
      }
    },
  });

  // 切换归档标志（archived:true=归档；false=取消归档）。
  ws.register({
    kind: "exact",
    path: "/api-session/archive",
    handler: async (req, res) => {
      try {
        const body = await readBody(req);
        const sessionId = typeof body.sessionId === "string" ? body.sessionId : "";
        if (!sessionId) {
          sendError(res, 400, "sessionId 必填");
          return;
        }
        if (typeof body.archived !== "boolean") {
          sendError(res, 400, "archived 必填（true/false）");
          return;
        }
        const session = archiveSession(sessionId, body.archived);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, session }));
      } catch (err) {
        sendError(res, 500, (err && err.message) || err);
      }
    },
  });

  // 软删/恢复/永久删除（trashed:true=进回收站，false=从回收站恢复；mode=permDel 真删不可逆）
  // 范围：仅 dsh-acp 私有归档（~/.dsh-acp/sessions/<cwd>/<archive>/）。dsh native session
  // 删除走 ctx.sessionPersistence，步骤 5 评估 native API 后再扩展。
  // body:{ sessionId, mode:'trash'|'restore'|'permDel' }
  // 返回：{ ok:true, session }（trash/restore）/ { ok:true, deleted:true }（permDel）
  ws.register({
    kind: "exact",
    path: "/api-session/delete",
    handler: async (req, res) => {
      try {
        const body = await readBody(req);
        const sessionId = typeof body.sessionId === "string" ? body.sessionId : "";
        if (!sessionId) { sendError(res, 400, "sessionId 必填"); return; }
        const mode = body.mode;
        if (mode !== "trash" && mode !== "restore" && mode !== "permDel") {
          sendError(res, 400, "mode 必填，且必须是 trash | restore | permDel 之一");
          return;
        }
        if (mode === "permDel") {
          // 真删：archive-store.deleteSession 已清理 dsh-acp-archives + sessions 两 root
          deleteSession(sessionId);
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: true, deleted: true, sessionId }));
          return;
        }
        // trash / restore → 软删旗标切换（无损）
        const session = trashSession(sessionId, mode === "trash");
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, session }));
      } catch (err) {
        sendError(res, 500, (err && err.message) || err);
      }
    },
  });

  // 移动会话到新的 cwd（同时迁移磁盘 archive 目录，由 archive-store.moveSession 完成）。
  ws.register({
    kind: "exact",
    path: "/api-session/move",
    handler: async (req, res) => {
      try {
        const body = await readBody(req);
        const sessionId = typeof body.sessionId === "string" ? body.sessionId : "";
        const cwd = typeof body.cwd === "string" ? body.cwd : "";
        if (!sessionId || !cwd) {
          sendError(res, 400, "sessionId 与 cwd 必填");
          return;
        }
        const session = manageMoveSession(sessionId, cwd);
        if (!session) {
          sendError(res, 404, `session ${sessionId} 未找到`);
          return;
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, session }));
      } catch (err) {
        sendError(res, 500, (err && err.message) || err);
      }
    },
  });

  // ─── 新路径：dsh 原生会话（与左侧侧栏同源；sp.list / sp.readFrom / agents.create）───

  // 列出 dsh 原生会话（sp.list() 返 [{id,title,cwd,updatedAt,...}]）。前端用于
  // 「DSH 原生会话」视图——和左侧侧栏完全一致的数据源，可 dsh 接续。
  ws.register({
    kind: "exact",
    path: "/api-session/dsh-list",
    handler: async (req, res) => {
      try {
        await readBody(req);
        const sp = ctx.get?.("sessionPersistence");
        if (!sp || typeof sp.list !== "function") {
          sendError(res, 503, "dsh 原生 sessionPersistence 服务不可用（profile 无 web 宿主或未挂载）");
          return;
        }
        const headers = await sp.list();
        const sessions = [];
        for (const h of (Array.isArray(headers) ? headers : [])) {
          const rec = summarizeDshHeader(h);
          if (!rec) continue;
          // 补对话轮数 + 概要 + 标题（供「会话」合并列表展示；读取失败保留已有字段）。
          // 标题回填：仅当 header.title 为空时才用事件 fold 出来的标题，避免覆盖 dsh 原生
          // 已写入 header 的标题（极少数路径会写）。
          try {
            const detail = await summarizeDshSessionDetail(sp, rec.sessionId);
            if (detail && typeof detail.turns === "number") rec.turns = detail.turns;
            if (detail && detail.summary && !rec.summary) rec.summary = detail.summary;
            if (detail && typeof detail.title === "string" && detail.title && !rec.title) {
              rec.title = detail.title;
            }
          } catch { /* 忽略 */ }
          sessions.push(rec);
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, sessions }));
      } catch (err) {
        sendError(res, 500, (err && err.message) || err);
      }
    },
  });

  // 读 dsh 原生会话内容（供 dsh 接续/预览）。
  // 0.1.5：sp.open(id,'read') → handle.read(offset)（返回 {events, eventState}）
  // 0.1.2：sp.readFrom(id, fromSeq)（返回 {meta, events}）——兼容保留。
  ws.register({
    kind: "exact",
    path: "/api-session/dsh-read",
    handler: async (req, res) => {
      try {
        const body = await readBody(req);
        const sessionId = typeof body.sessionId === "string" ? body.sessionId : "";
        if (!sessionId) {
          sendError(res, 400, "sessionId 必填");
          return;
        }
        const fromSeq = Number.isFinite(body.fromSeq) ? Math.max(0, Math.trunc(body.fromSeq)) : 0;
        const sp = ctx.get?.("sessionPersistence");
        if (!sp) {
          sendError(res, 503, "dsh 原生 sessionPersistence 服务不可用");
          return;
        }
        let meta = null;
        let events = [];
        if (typeof sp.open === "function" && typeof sp.list === "function") {
          // 0.1.5 路径：open read handle → handle.read
          const handle = await sp.open(sessionId, "read");
          try {
            const r = await handle.read(fromSeq);
            events = (r && Array.isArray(r.events)) ? r.events : [];
            meta = handle.header || null;
          } finally {
            if (typeof handle?.close === "function") await handle.close();
          }
        } else if (typeof sp.readFrom === "function") {
          // 0.1.2 路径（兼容）
          const data = await sp.readFrom(sessionId, fromSeq);
          meta = (data && data.meta) || null;
          events = (data && data.events) || (Array.isArray(data) ? data : []);
        } else {
          sendError(res, 503, "sessionPersistence 缺少 open/readFrom 能力");
          return;
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, sessionId, fromSeq, meta, events }));
      } catch (err) {
        sendError(res, 500, (err && err.message) || err);
      }
    },
  });

  // 发现 Obsidian Agent Client 会话（一键导入的候选列表）。
  // body: {} -> { ok, sessions:[{sessionId, agentId, title, messages, vault, imported}] }
  ws.register({
    kind: "exact",
    path: "/api-session/obsidian-list",
    handler: async (req, res) => {
      try {
        await readBody(req);
        const sessions = discoverObsidianSessions();
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, sessions }));
      } catch (err) {
        sendError(res, 500, (err && err.message) || err);
      }
    },
  });

  // 一键导入一个 Obsidian Agent Client 会话 → 写入 dsh 原生会话存储（左侧可见）。
  // body: { path } -> { ok, sessionId, title, imported, userTurns, cwd, native, via }
  //                / { ok:false, error }
  ws.register({
    kind: "exact",
    path: "/api-session/obsidian-import",
    handler: async (req, res) => {
      try {
        const body = await readBody(req);
        const p = typeof body.path === "string" && body.path ? body.path : "";
        if (!p) { sendError(res, 400, "path 必填"); return; }
        const sp = ctx.get?.("sessionPersistence");
        const agents = ctx.get?.("agents");
        if (!sp && !agents) {
          sendError(res, 503, "dsh 原生 sessionPersistence / agents 服务均不可用，无法写入原生会话（请确认当前 profile 含 web 宿主）");
          return;
        }
        const r = await importObsidianSessionAsDsh(ctx, p);
        // 成功写入 dsh 原生后标记该 Obsidian 会话已导入（修复「导入后仍显示未导入 / 按钮无反应」）
        markObsidianImported(p, r.sessionId);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, ...r }));
      } catch (err) {
        sendError(res, 500, (err && err.message) || err);
      }
    },
  });
}