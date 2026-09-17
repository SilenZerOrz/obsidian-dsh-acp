// lib/http-gateway.mjs — P3.0 dsh web HTTP gateway.
//
// 为什么需要这个模块(2026-09-17):
//   dsh-acp 的 P2 long-runtime 必须跑在 dsh web 进程内(in-process),以访问
//   ctx.llm.stream / ctx.on('agent/pre-step') / ctx.on('approval/request')。
//   但 Obsidian Agent Client 只支持 stdio spawn,Obsidian 端 spawn 出来的
//   dsh-acp.mjs 是独立进程,拿不到 dsh web 的 cordis ctx。
//
//   解法:让 dsh web (index.mjs) 暴露 HTTP 端点,dsh-acp.mjs 当作 thin proxy
//   把 stdio JSON-RPC 转发到 HTTP。这样 Obsidian 看到的是同一个 stdio server,
//   而 long-runtime 在 dsh web 进程内真实运行。
//
// 设计:
//   - 在 webServer 上 register 2 个端点:
//       GET  /acp/proxy/probe           → 健康检查(JSON)
//       POST /acp/proxy/session/prompt  → SSE 流:接受 prompt,
//                         调 long-runtime.prompt(),把每个 sessionUpdate
//                         通过 SSE 推送,最后写 result event,关闭流
//   - 其他 ACP capability (initialize / session/new / session/list 等) 仍
//     由 dsh-acp.mjs 独立处理(无 cordis ctx 也能走 — 走 spawn 路径或
//     in-memory session state)
//   - acpClient.notify 通过 InProcessEmitter 推到 SSE writer
//
// commit 2 范围:只实现 probe + session/prompt,commit 3 (dsh-acp.mjs proxy 端)
// 才接 init/new/list capability 转发。

import { EventEmitter } from "node:events";

/**
 * P3.0 HTTP gateway 版本号 (与 package.json 同步;commit 2 = 0.2.6-dev)。
 * dsh-acp.mjs proxy 探测时用 version 字段判断 server 兼容性。
 */
export const HTTP_GATEWAY_VERSION = "0.2.6-dev";

/**
 * 单连接 SSE writer — 包装 Node http.ServerResponse 为 SSE 友好 stream。
 * 调用方负责 end() / destroy()。每个新 prompt 都创建一个新 writer。
 */
export class SseWriter {
  /**
   * @param {import("node:http").ServerResponse} res
   */
  constructor(res) {
    this.res = res;
    this.closed = false;
  }

  /**
   * 写一条 SSE event。如果 res 已经关闭则 silently 忽略。
   * @param {string} event
   * @param {object} data
   */
  emit(event, data) {
    if (this.closed) return;
    try {
      this.res.write(`event: ${event}\n`);
      this.res.write(`data: ${JSON.stringify(data)}\n\n`);
    } catch {
      /* ignore — connection probably dropped */
      this.closed = true;
    }
  }

  /** 关闭 SSE 流(写一条 end marker 后 end res)。 */
  close() {
    if (this.closed) return;
    this.closed = true;
    try {
      this.res.end();
    } catch {
      /* ignore */
    }
  }
}

/**
 * Read JSON body from an HTTP request. Mirrors the pattern used by
 * web/session-panel.mjs — limit body to 8 MB to avoid DoS.
 *
 * @param {import("node:http").IncomingMessage} req
 * @returns {Promise<object>}
 */
function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    const MAX = 8 * 1024 * 1024;
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX) {
        reject(new Error("request body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw.trim()) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (e) {
        reject(new Error(`invalid JSON body: ${e?.message ?? e}`));
      }
    });
    req.on("error", reject);
  });
}

/**
 * Create the in-process bridge between long-runtime.acpClient.notify(...) and
 * the active SSE writer(s). The emitter is stored on the gateway singleton so
 * long-runtime.init({ acpClient }) can use it directly.
 *
 * Behavior:
 *   - Each SSE connection registers a writer via attachWriter() BEFORE
 *     triggering a long-runtime turn, then detaches via detachWriter() after
 *     the turn resolves.
 *   - Multiple writers are supported (one per concurrent prompt), each gets
 *     every notify call (filtering by sessionId is the long-runtime's job —
 *     or future v2 can route by sessionId).
 *
 * @returns {{ emitter: EventEmitter, attachWriter: function, detachWriter: function }}
 */
export function createNotifyBridge() {
  const emitter = new EventEmitter();
  emitter.setMaxListeners(64); // allow many concurrent prompts
  const writers = new Set();

  emitter.on("notify", (method, params) => {
    for (const w of writers) {
      w.emit("sessionUpdate", { method, params });
    }
  });

  return {
    emitter,
    attachWriter(writer) {
      writers.add(writer);
    },
    detachWriter(writer) {
      writers.delete(writer);
    },
  };
}

/**
 * Construct the acpClient object that long-runtime.init() expects.
 * notify(method, params) routes through the in-process emitter.
 *
 * @param {ReturnType<typeof createNotifyBridge>} bridge
 */
export function makeNotifyAcpClient(bridge) {
  return {
    async notify(method, params) {
      bridge.emitter.emit("notify", method, params);
    },
    async request(_method, _params) {
      // v1 stub: long-runtime calls request() for session/request_permission
      // via PermissionGate. The full request/response flow goes through
      // a different channel (commit 3 wires SSE bidirectional); for now
      // throw so permission-gate will treat this as "no client, deny".
      throw new Error(
        "http-gateway: request() not wired in commit 1; use spawn mode for permission-gated turns",
      );
    },
  };
}

/**
 * Set common SSE response headers (Content-Type, Cache-Control, X-Accel-Buffering).
 * Must be called BEFORE first res.write().
 *
 * @param {import("node:http").ServerResponse} res
 */
function setSseHeaders(res) {
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    "connection": "keep-alive",
    "x-accel-buffering": "no",
  });
}

/**
 * Probe endpoint — GET /acp/proxy/probe.
 *
 * Response: { ok, version, mode, longReady }
 *   - ok: always true (or 500 if long-runtime not initialized)
 *   - version: HTTP_GATEWAY_VERSION
 *   - mode: "long" when long-runtime initialized, else "spawn" hint
 *   - longReady: boolean — whether getLongRuntime()._initialized
 */
async function handleProbe(_req, res, ctx) {
  let longReady = false;
  try {
    const { getLongRuntime } = await import("./long-runtime.mjs");
    longReady = getLongRuntime()._initialized === true;
  } catch {
    /* long-runtime not available (no P2 subpackages) */
  }
  const body = {
    ok: true,
    version: HTTP_GATEWAY_VERSION,
    mode: longReady ? "long" : "spawn-hint",
    longReady,
  };
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

/**
 * Lazy-initialize long-runtime if not yet ready. Throws if P2 unavailable.
 *
 * @param {object} ctx - dsh cordis context
 * @param {ReturnType<typeof createNotifyBridge>} bridge
 * @returns {Promise<object>} the LongRuntime instance
 */
async function ensureLongRuntime(ctx, bridge) {
  const { getLongRuntime } = await import("./long-runtime.mjs");
  const rt = getLongRuntime();
  if (rt._initialized) return rt;

  const { resolvePermissionConfig } = await import("./runtime-switch.mjs");
  await rt.init({
    cordisCtx: ctx,
    acpClient: makeNotifyAcpClient(bridge),
    permissionConfig: resolvePermissionConfig(),
    cwd: process.cwd(),
  });
  return rt;
}

/**
 * Prompt endpoint — POST /acp/proxy/session/prompt (SSE stream).
 *
 * Body: { sessionId: string, prompt: string|object|object[], model?: string,
 *         temperature?: number, reasoningEffort?: string }
 *
 * SSE events:
 *   - "sessionUpdate"   → ACP sessionUpdate payload (agent_message_chunk /
 *                         agent_thought_chunk / tool_call_update / etc.)
 *   - "result"          → final { stopReason, usage } object
 *   - "error"           → { message } (turn failed; res closes after)
 */
async function handleSessionPrompt(req, res, ctx, bridge) {
  setSseHeaders(res);

  // Read body BEFORE writing first SSE event (can't change status after).
  let body;
  try {
    body = await readJsonBody(req);
  } catch (e) {
    res.write(`event: error\ndata: ${JSON.stringify({ message: e?.message ?? String(e) })}\n\n`);
    res.end();
    return;
  }

  const sessionId = typeof body.sessionId === "string" ? body.sessionId : "";
  if (!sessionId) {
    res.write(`event: error\ndata: ${JSON.stringify({ message: "sessionId required" })}\n\n`);
    res.end();
    return;
  }

  // Long-runtime init may fail (no P2 subpackages / ctx not ready) — surface
  // the error as SSE error event and let dsh-acp.mjs fallback to spawn mode.
  let rt;
  try {
    rt = await ensureLongRuntime(ctx, bridge);
  } catch (e) {
    res.write(`event: error\ndata: ${JSON.stringify({ message: `long-runtime init failed: ${e?.message ?? String(e)}` })}\n\n`);
    res.end();
    return;
  }

  // Attach this SSE writer so acpClient.notify() events flow into the stream.
  const writer = new SseWriter(res);
  bridge.attachWriter(writer);

  try {
    const result = await rt.prompt({
      sessionId,
      prompt: body.prompt,
      sessionConfig: {
        model: typeof body.model === "string" ? body.model : undefined,
        temperature: typeof body.temperature === "number" ? body.temperature : undefined,
        reasoningEffort: typeof body.reasoningEffort === "string" ? body.reasoningEffort : undefined,
      },
    });
    writer.emit("result", {
      stopReason: result.stopReason,
      usage: result.usage ?? { totalTokens: 0, inputTokens: 0, outputTokens: 0 },
    });
  } catch (e) {
    writer.emit("error", { message: e?.message ?? String(e) });
  } finally {
    bridge.detachWriter(writer);
    writer.close();
  }
}

/**
 * Register the HTTP gateway on a dsh web webServer instance.
 *
 * @param {object} ctx - dsh cordis context (for long-runtime + logger)
 * @param {object} ws - webServer service (must expose .register())
 * @param {object} [options]
 * @param {boolean} [options.enablePrompt=true] - register /acp/proxy/session/prompt
 * @returns {ReturnType<typeof createNotifyBridge>} the in-process bridge (caller
 *           may keep it for advanced use; long-runtime uses it internally via
 *           ensureLongRuntime())
 */
export function registerHttpGateway(ctx, ws, options = {}) {
  const enablePrompt = options.enablePrompt !== false;
  const bridge = createNotifyBridge();

  // Probe is always on — used by dsh-acp.mjs to detect "long mode available".
  ws.register({
    kind: "exact",
    path: "/acp/proxy/probe",
    handler: async (req, res) => handleProbe(req, res, ctx),
  });

  if (enablePrompt) {
    ws.register({
      kind: "exact",
      path: "/acp/proxy/session/prompt",
      handler: async (req, res) => handleSessionPrompt(req, res, ctx, bridge),
    });
  }

  return bridge;
}