// lib/http-gateway.mjs — P3.0 dsh web HTTP gateway.
//
// Phase D (2026-09-18): stranded-Promise fix. AbortSignals now thread through
// SseWriter.emitRequest, makePerPromptAcpClient, handleServerRequest and
// forwardPromptViaHttp so a turn / session cancel releases every pending
// permission request back to its caller with an AbortError. Previously the
// pending Promise in `_pendingRequests` would sit forever after the outer
// 10-minute fetch abort (proxy-mode.mjs::PROMPT_TIMEOUT_MS) — the server
// side had no way to learn the client disconnected.
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
import { makeAbortError } from "./abort-utils.mjs";
import { createOfficialAcpRouter } from "./acp-official-router.mjs";
import { createUpdateTranslator } from "./acp-tool-translation.mjs";

/**
 * Official-bridge mount signal (Phase 2 first cut).
 *
 * DECOUPLED from the probe: `DSH_ACP_USE_OFFICIAL_BRIDGE=1` now only governs
 * whether the gateway MOUNTS apply() and routes prompts through it. The
 * capability probe (probeOfficialBridge) stays a separate diagnostic that is
 * logged, never a mount gate — otherwise "BRIDGE=1 but probe says no-ability"
 * becomes an un-debuggable contradiction.
 *
 * @returns {boolean} true → route prompts through the official apply() path.
 */
export function officialBridgeEnabled(env = process.env) {
  return env.DSH_ACP_USE_OFFICIAL_BRIDGE === "1";
}

/**
 * Optional official-path mount overrides (env), for running apply() against a
 * specific provider/model. Falls back to the gateway default model so a fresh
 * apply() session can run a turn without an explicit model override.
 *
 * @param {object} env
 */
function resolveOfficialMountConfig(env = process.env) {
  const cfg = {};
  if (env.DSH_ACP_OFFICIAL_PROVIDER) cfg.provider = env.DSH_ACP_OFFICIAL_PROVIDER;
  if (env.DSH_ACP_OFFICIAL_MODEL) cfg.model = env.DSH_ACP_OFFICIAL_MODEL;
  if (cfg.model === undefined) cfg.model = resolveHttpGatewayDefaultModel(env);
  return cfg;
}

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
    /**
     * Per-writer pending-request registry. acpClient.request() emits an SSE
     * "request" event with a correlationId and waits for a matching resolve
     * via handlePermissionResponse(). Keyed by correlationId so concurrent
     * permission prompts (rare but possible) don't collide.
     *
     * @type {Map<string, { resolve: (v: any) => void, reject: (e: Error) => void, method: string }>}
     */
    this._pendingRequests = new Map();
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

  /**
   * Register a pending client request (long-runtime → ACP client). Emits an
   * SSE "request" event carrying correlationId/method/params, and returns a
   * Promise that resolves when handlePermissionResponse() looks up the same
   * correlationId and resolves it.
   *
   * Phase D (2026-09-18): optional `signal` aborts the pending Promise with
   * an AbortError and removes it from `_pendingRequests`. Without this, a
   * turn-cancel that races with an in-flight permission prompt leaves the
   * entry stranded in the map — even after the outer SSE response closes —
   * and long-runtime's awaited Promise sits forever. Pair with abortOnSignal
   * in proxy-mode.mjs::handleServerRequest for the matching client side.
   *
   * @param {string} method - JSON-RPC method name (e.g. "session/request_permission")
   * @param {object} params
   * @param {AbortSignal} [signal] - cancellation source; aborting rejects the
   *           returned Promise with an AbortError and deletes the entry.
   * @returns {Promise<any>}
   */
  emitRequest(method, params, signal) {
    if (this.closed) {
      return Promise.reject(new Error("SSE writer closed; cannot send request"));
    }
    const correlationId = `req-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    return new Promise((resolve, reject) => {
      const entry = { resolve, reject, method };
      this._pendingRequests.set(correlationId, entry);
      const onAbort = () => {
        // Phase D: release the pending Promise so the caller's race can
        // settle. The Promise has already been removed from the map so a
        // late-arriving permission-response POST will 404 (the
        // handlePermissionResponse code handles that gracefully).
        this._pendingRequests.delete(correlationId);
        reject(makeAbortError(signal?.reason));
      };
      if (signal) {
        if (signal.aborted) {
          onAbort();
          return;
        }
        signal.addEventListener("abort", onAbort, { once: true });
        // Wrap resolve/reject so we always clean up the listener on settle.
        const cleanup = () => signal.removeEventListener("abort", onAbort);
        const wrappedResolve = (v) => { cleanup(); resolve(v); };
        const wrappedReject = (e) => { cleanup(); reject(e); };
        this._pendingRequests.set(correlationId, {
          resolve: wrappedResolve,
          reject: wrappedReject,
          method,
        });
      }
      try {
        this.emit("request", { correlationId, method, params });
      } catch (err) {
        this._pendingRequests.delete(correlationId);
        if (signal) signal.removeEventListener("abort", onAbort);
        reject(err);
      }
    });
  }

  /**
   * Resolve a pending request registered via emitRequest(). Called by
   * handlePermissionResponse() when the proxy client POSTs back the
   * Obsidian Agent Client's reply.
   *
   * @param {string} correlationId
   * @param {{ ok: true, result: any } | { ok: false, error: string }} reply
   * @returns {boolean} true if a pending request was found and resolved
   */
  resolveRequest(correlationId, reply) {
    const entry = this._pendingRequests.get(correlationId);
    if (!entry) return false;
    this._pendingRequests.delete(correlationId);
    if (reply?.ok) entry.resolve(reply.result);
    else entry.reject(new Error(reply?.error ?? "permission request failed"));
    return true;
  }

  /**
   * Reject all pending requests (e.g. when the SSE connection closes).
   * Prevents stuck Promises when the client disconnects mid-permission-prompt.
   */
  rejectAllPending(reason) {
    for (const [, entry] of this._pendingRequests) {
      try {
        entry.reject(new Error(reason));
      } catch {
        /* ignore */
      }
    }
    this._pendingRequests.clear();
  }

  /** 关闭 SSE 流(写一条 end marker 后 end res)。 */
  close() {
    if (this.closed) return;
    this.closed = true;
    // Reject any pending permission requests so the gate doesn't hang forever.
    this.rejectAllPending("SSE writer closed");
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
 *   - writersBySessionId indexes the same writers by sessionId so
 *     handlePermissionResponse() can route a permission-reply POST back to
 *     the correct writer.
 *
 * @returns {{ emitter: EventEmitter, attachWriter: function, detachWriter: function,
 *             findWriterBySession: function(string): (object|undefined) }}
 */
export function createNotifyBridge() {
  const emitter = new EventEmitter();
  emitter.setMaxListeners(64); // allow many concurrent prompts
  const writers = new Set();
  /** @type {Map<string, Set<object>>} sessionId → writers bound to that session */
  const writersBySessionId = new Map();

  emitter.on("notify", (method, params) => {
    for (const w of writers) {
      w.emit("sessionUpdate", { method, params });
    }
  });

  return {
    emitter,
    attachWriter(writer, sessionId) {
      writers.add(writer);
      if (typeof sessionId === "string" && sessionId) {
        let set = writersBySessionId.get(sessionId);
        if (!set) {
          set = new Set();
          writersBySessionId.set(sessionId, set);
        }
        set.add(writer);
        writer._boundSessionId = sessionId;
      }
    },
    detachWriter(writer) {
      writers.delete(writer);
      const sid = writer._boundSessionId;
      if (sid) {
        const set = writersBySessionId.get(sid);
        if (set) {
          set.delete(writer);
          if (set.size === 0) writersBySessionId.delete(sid);
        }
        writer._boundSessionId = null;
      }
    },
    /**
     * Find the first active writer bound to a given sessionId. Used by
     * handlePermissionResponse() to route a reply POST back to the right
     * SSE writer. Returns undefined when no active writer for that session
     * (e.g. prompt already ended) — caller should respond 404.
     *
     * @param {string} sessionId
     * @returns {object|undefined}
     */
    findWriterBySession(sessionId) {
      if (typeof sessionId !== "string" || !sessionId) return undefined;
      const set = writersBySessionId.get(sessionId);
      if (!set || set.size === 0) return undefined;
      // First one is fine: concurrent prompts on the same session are rare and
      // a correlationId lookup (resolveRequest) is what disambiguates.
      return set.values().next().value;
    },
  };
}

/**
 * Construct the acpClient object that long-runtime.init() expects.
 * notify(method, params) routes through the in-process emitter. request(method,
 * params) emits an SSE "request" event on the captured writer and waits for
 * the proxy client to POST a reply to /acp/proxy/permission-response.
 *
 * Why per-writer (not per-bridge) (2026-09-18 P3.0 tool-call fix):
 *   long-runtime is shared across prompts (singleton), so the acpClient
 *   passed to init() is created once. But request() must reach the SPECIFIC
 *   writer that owns the originating turn — permission replies can't fan out
 *   to all writers, only the originating one. The fix: build the per-prompt
 *   acpClient INSIDE handleSessionPrompt (closure over that turn's writer)
 *   and inject it into long-runtime via a one-shot setter (see the prompt
 *   handler for the swap pattern). The bridge-level makeNotifyAcpClient is
 *   kept for notify-only callers and shared with spawn-mode callers.
 *
 * @param {ReturnType<typeof createNotifyBridge>} bridge
 */
export function makeNotifyAcpClient(bridge) {
  return {
    async notify(method, params) {
      bridge.emitter.emit("notify", method, params);
    },
    // Default request() throws — the per-writer closure below overrides this
    // for HTTP/SSE proxy turns via long-runtime's _liveAcpClient swap pattern.
    async request(_method, _params) {
      throw new Error(
        "http-gateway: request() not wired for this acpClient — use per-writer client or spawn mode",
      );
    },
  };
}

/**
 * Build a per-prompt acpClient bound to ONE specific SSE writer. The writer
 * is captured in closure so long-runtime.request() routes the SSE "request"
 * event to the correct connection (concurrent prompts on different sessions
 * stay isolated) and the reply POST from the proxy client can resolve the
 * matching pending Promise.
 *
 * Phase D (2026-09-18): accepts an optional `signal` and threads it through
 * to every `request()` call so a turn cancel propagates all the way into the
 * pending permission request and releases long-runtime's awaited Promise.
 *
 * Callers (handleSessionPrompt) inject this client into long-runtime via
 * `runtime._liveAcpClient = client` for the duration of the turn, then
 * restore the previous value in finally.
 *
 * @param {SseWriter} writer - the SSE writer for this turn
 * @param {AbortSignal} [signal] - per-turn cancellation; aborts every
 *           pending permission request issued through this client.
 * @returns {{ notify: function, request: function, _signal: AbortSignal }}
 */
export function makePerPromptAcpClient(writer, signal) {
  const client = {
    // Expose the bound writer for debugging + tests (bidirectional routing).
    _writer: writer,
    _signal: signal ?? null,
    async notify(method, params) {
      writer.emit("sessionUpdate", { method, params });
    },
    async request(method, params) {
      return writer.emitRequest(method, params, signal);
    },
  };
  return client;
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
  // Phase 1 (migration plan): static probe of the official bridge. This does
  // NOT mount `apply()` — just verifies the package imports and the cordis ctx
  // has every service `apply()` reaches for. Phase 2 will route prompts here.
  let official = null;
  try {
    const { probeOfficialBridge } = await import("./official-acp-bridge.mjs");
    official = await probeOfficialBridge(ctx);
  } catch (e) {
    official = { error: `probe threw: ${e?.message ?? String(e)}` };
  }
  const body = {
    ok: true,
    version: HTTP_GATEWAY_VERSION,
    mode: longReady ? "long" : "spawn-hint",
    longReady,
    official,
  };
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

/**
 * Resolve the default model that the HTTP gateway seeds into long-runtime
 * on first lazy init.
 *
 * Order (matches dsh-acp.mjs FE-1 pickCurrentModel fallback so the two entry
 * paths agree on the same default):
 *   1. process.env.DSH_ACP_DEFAULT_MODEL (explicit user override)
 *   2. "jl-token/DeepSeek-V4-Flash" — matches dsh-acp.mjs's
 *      DEFAULT_PROVIDER + FALLBACK_MODELS[0] (what the dropdown defaults to
 *      when no provider catalog is available).
 *
 * Exported for unit testing; ensureLongRuntime() calls this internally.
 *
 * @param {NodeJS.ProcessEnv} [env=process.env]
 * @returns {string}
 */
export function resolveHttpGatewayDefaultModel(env = process.env) {
  return env.DSH_ACP_DEFAULT_MODEL || "jl-token/DeepSeek-V4-Flash";
}

/**
 * Lazy-initialize long-runtime if not yet ready. Throws if P2 unavailable.
 *
 * Seeds defaultModel via resolveHttpGatewayDefaultModel() so a freshly created
 * ACP session (which has no `model` set until the client emits
 * setSessionConfigOption) can still run a turn.
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
  // P3.0 follow-up (2026-09-17): ensureLongRuntime must seed long-runtime's
  // defaultModel so a freshly created ACP session (which has no `model` set
  // until the client emits setSessionConfigOption) can still run a turn.
  // Without this, every proxy-mode turn fails with
  //   "LongRuntime.prompt: no model configured"  (real-machine repro below).
  await rt.init({
    cordisCtx: ctx,
    acpClient: makeNotifyAcpClient(bridge),
    permissionConfig: resolvePermissionConfig(),
    cwd: process.cwd(),
    model: resolveHttpGatewayDefaultModel(),
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
 *   - "request"         → outbound client request needing a reply
 *                         (correlationId, method, params) — proxy client
 *                         forwards via onRequest() then POSTs back to
 *                         /acp/proxy/permission-response.
 *   - "result"          → final { stopReason, usage } object
 *   - "error"           → { message } (turn failed; res closes after)
 */
async function handleSessionPrompt(req, res, ctx, bridge, official = null) {
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

  // Phase 2 first cut — OFFICIAL path (DSH_ACP_USE_OFFICIAL_BRIDGE=1).
  // Deliberately NO auto-fallback to legacy: if apply() mount/prompt fails the
  // client sees an error, never a silently-legacy "success". Rollback is the
  // explicit env switch + restart. See handleOfficialSessionPrompt.
  if (official?.enabled) {
    await handleOfficialSessionPrompt(req, res, ctx, bridge, official, body, sessionId);
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
  // Pass sessionId so handlePermissionResponse can route replies back to the
  // originating writer.
  const writer = new SseWriter(res);
  bridge.attachWriter(writer, sessionId);

  // Phase D (2026-09-18): own a per-turn AbortController so a client
  // disconnect (req "aborted") releases the pending permission Promise. We
  // also forward into long-runtime via _activeAbortController (set by
  // LongRuntime.prompt) so PermissionGate can race gate.resolve against the
  // same signal.
  const turnAbort = new AbortController();
  const onReqAborted = () => turnAbort.abort(req.aborted ? "client disconnected" : undefined);
  req.on("aborted", onReqAborted);
  if (req.aborted) onReqAborted();

  // Inject a per-prompt acpClient into long-runtime so its request() calls
  // route through THIS writer (not the shared bridge-level notify-only client
  // passed during init()). The runtime singleton survives across prompts, so
  // we must restore the previous client in finally.
  const previousLiveClient = rt._liveAcpClient;
  rt._liveAcpClient = makePerPromptAcpClient(writer, turnAbort.signal);

  try {
    const result = await rt.prompt({
      sessionId,
      prompt: body.prompt,
      sessionConfig: {
        model: typeof body.model === "string" ? body.model : undefined,
        temperature: typeof body.temperature === "number" ? body.temperature : undefined,
        reasoningEffort: typeof body.reasoningEffort === "string" ? body.reasoningEffort : undefined,
      },
      signal: turnAbort.signal,
    });
    writer.emit("result", {
      stopReason: result.stopReason,
      usage: result.usage ?? { totalTokens: 0, inputTokens: 0, outputTokens: 0 },
    });
  } catch (e) {
    writer.emit("error", { message: e?.message ?? String(e) });
    // Phase D (D3): if we caught a turn failure (provider lookup, stream
    // crash, etc.) AND there are still permission requests pending on this
    // writer, release them with the same error so long-runtime's await
    // unblocks instead of hanging on a never-arriving reply.
    if (writer._pendingRequests && writer._pendingRequests.size > 0) {
      writer.rejectAllPending(`session failed: ${e?.message ?? String(e)}`);
    }
  } finally {
    // Phase D: abort any still-pending requests so the close path below
    // doesn't have to wait for them to settle on their own.
    try { turnAbort.abort("session ended"); } catch { /* best-effort */ }
    rt._liveAcpClient = previousLiveClient;
    bridge.detachWriter(writer);
    writer.close();
    req.removeListener("aborted", onReqAborted);
  }
}

/**
 * Phase 2 first cut — single client session through the official apply() path.
 *
 * NO auto-fallback: on any apply() mount/prompt failure we emit an SSE error
 * and close. The legacy path is NOT consulted. This makes an official-mode
 * regression loud (client sees an error) instead of silently serving legacy —
 * the failure mode the user explicitly ruled out.
 *
 * sessionId semantics: the HTTP layer's `sessionId` is a client-owned LABEL.
 * apply() self-generates a UUID and ignores caller-provided ids, so the router
 * translates label -> apply-UUID internally. Notifications (which carry the
 * apply-UUID) are routed back to THIS writer via the router's per-prompt
 * notifier (single-session, non-concurrent for this first cut).
 *
 * @param {import("node:http").ServerResponse} res
 * @param {object} ctx - dsh cordis context.
 * @param {ReturnType<typeof createNotifyBridge>} bridge
 * @param {{ enabled: boolean, getRouter: () => Promise<object> }} official
 * @param {object} body - parsed POST body (sessionId, prompt, model, ...).
 * @param {string} sessionId - client session label.
 */
async function handleOfficialSessionPrompt(req, res, ctx, bridge, official, body, sessionId) {
  const writer = new SseWriter(res);
  bridge.attachWriter(writer, sessionId);

  const turnAbort = new AbortController();
  const onReqAborted = () => turnAbort.abort(req.aborted ? "client disconnected" : undefined);
  req.on("aborted", onReqAborted);
  if (req.aborted) onReqAborted();

  let router;
  try {
    router = await official.getRouter(); // lazy mount; THROWS on failure (no fallback)
  } catch (e) {
    writer.emit("error", { message: `official bridge mount failed: ${e?.message ?? String(e)}` });
    try { turnAbort.abort("mount failed"); } catch {}
    bridge.detachWriter(writer);
    writer.close();
    req.removeListener("aborted", onReqAborted);
    return;
  }

  // #95 Session A: PER-SESSION tool translator. apply() emits OFFICIAL tool
  // frames (tool_call start + tool_call_update finish w/ empty content:[]); the
  // legacy SSE clients downstream digest the LEGACY shape (tool_call_update
  // in_progress + completed w/ rawInput). translate() maps the tool frames and
  // passes message/thought/usage through VERBATIM. A fresh instance is created
  // per prompt call (owns its rawInputByToolCall Map) and discarded here — never
  // cached at session level, so a reused toolCallId across turns can't poison it.
  const translator = createUpdateTranslator();

  try {
    const result = await router.prompt(sessionId, {
      prompt: body.prompt,
      model: typeof body.model === "string" ? body.model : undefined,
      // Forward apply()'s session/update notifications to this SSE writer as
      // { method:"session/update", params } — the legacy envelope (verified in
      // official-bridge-alignment.test). Only the tool frames are translated;
      // every other frame passes through untouched.
      onUpdate: (params) => {
        const { update } = params ?? {};
        for (const out of translator.translate(update)) {
          writer.emit("sessionUpdate", {
            method: "session/update",
            params: { sessionId: params?.sessionId, update: out },
          });
        }
      },
      signal: turnAbort.signal,
    });
    writer.emit("result", {
      stopReason: result.stopReason,
      usage: result.usage ?? { totalTokens: 0, inputTokens: 0, outputTokens: 0 },
    });
  } catch (e) {
    writer.emit("error", { message: e?.message ?? String(e) });
  } finally {
    try { turnAbort.abort("session ended"); } catch { /* best-effort */ }
    bridge.detachWriter(writer);
    writer.close();
    req.removeListener("aborted", onReqAborted);
  }
}

/**
 * Permission-response endpoint — POST /acp/proxy/permission-response.
 *
 * The proxy client (dsh-acp.mjs) calls this AFTER receiving an SSE "request"
 * event, asking the user via ctx.client.request(method, params), and getting
 * back a result. We find the originating writer by sessionId, look up the
 * pending Promise by correlationId, and resolve/reject it.
 *
 * Body: { sessionId: string, correlationId: string,
 *         ok: true, result: any } | { ok: false, error: string }
 *
 * Response (JSON):
 *   - { ok: true } when a pending request was found and resolved
 *   - { ok: false, error } when no active writer / unknown correlationId /
 *     writer already closed (200 either way — caller treats as best-effort)
 */
async function handlePermissionResponse(req, res, _ctx, bridge) {
  let body;
  try {
    body = await readJsonBody(req);
  } catch (e) {
    res.writeHead(400, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: false, error: `invalid body: ${e?.message ?? String(e)}` }));
    return;
  }

  const sessionId = typeof body.sessionId === "string" ? body.sessionId : "";
  const correlationId = typeof body.correlationId === "string" ? body.correlationId : "";
  if (!sessionId || !correlationId) {
    res.writeHead(400, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: false, error: "sessionId and correlationId required" }));
    return;
  }

  const writer = bridge.findWriterBySession(sessionId);
  if (!writer) {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: false, error: "no active writer for session (prompt may have ended)" }));
    return;
  }

  const reply = body.ok === true
    ? { ok: true, result: body.result }
    : { ok: false, error: typeof body.error === "string" ? body.error : "permission request failed" };
  const resolved = writer.resolveRequest(correlationId, reply);

  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ ok: resolved, error: resolved ? undefined : "unknown correlationId (may have timed out)" }));
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

  // Phase 2 first cut: build the official-router handle (lazy mount) ONCE if
  // the env switch is on. `getRouter()` is idempotent. Decoupled from the
  // probe: this env only governs MOUNT; probe is a separate diagnostic (logged).
  // `options.officialEnabled` / `options.officialMountConfig` let tests inject
  // provider/model (e.g. the stub LLM) without polluting process env.
  const officialEnabled = options.officialEnabled ?? officialBridgeEnabled();
  let officialRouter = null;
  const official = {
    enabled: officialEnabled,
    async getRouter() {
      if (officialRouter === null) {
        officialRouter = createOfficialAcpRouter(ctx, options.officialMountConfig ?? resolveOfficialMountConfig());
      }
      return officialRouter;
    },
  };
  if (officialEnabled) {
    try {
      process.stderr.write("[dsh-acp] official bridge ENABLED (DSH_ACP_USE_OFFICIAL_BRIDGE=1); /acp/proxy/session/prompt routes via apply()\n");
    } catch { /* best-effort log */ }
  }

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
      handler: async (req, res) => handleSessionPrompt(req, res, ctx, bridge, official),
    });
    // Permission reply endpoint — proxy client POSTs the Obsidian Agent Client's
    // response here after receiving an SSE "request" event. Routes by
    // sessionId + correlationId back to the originating writer's pending
    // Promise (see SseWriter.emitRequest / resolveRequest).
    ws.register({
      kind: "exact",
      path: "/acp/proxy/permission-response",
      handler: async (req, res) => handlePermissionResponse(req, res, ctx, bridge),
    });
  }

  // M0.2 WARM-UP (2026-09-18): fire-and-forget ensureLongRuntime so the probe
  // endpoint returns longReady=true on first request. Without this, dsh web
  // cold cache shows longReady=false and obsidian's first prompt takes the
  // spawn-hint fallback path (slower; user reports first-prompt lag).
  //
  // Failure semantics: warm-up is non-fatal — handleSessionPrompt's own
  // ensureLongRuntime() call will retry on the first real prompt. We bound
  // the warm-up to 5s so a slow cordis ctx init can't hang registerHttpGateway
  // (which itself is called from ctx.inject(["webServer"], ...) and must
  // return promptly to avoid blocking plugin apply).
  //
  // Phase 2 first cut — SKIP the legacy warm-up in official mode. The legacy
  // LongRuntime.init() installs an `agent/pre-step` listener (and an
  // `approval/request` listener) on the SHARED cordis ctx. apply() mounts its
  // OWN `agent/pre-step` listener on the same ctx; when the legacy listener is
  // present (it neither calls `next()` nor returns a value, so it collapses the
  // pre-step middleware chain), every apply() turn dies with "Cannot read
  // properties of undefined (reading 'kind')" at dsh-agent's `decision.kind`.
  // In official mode long-runtime is never used, so its hooks must not be
  // installed onto a ctx that apply() owns. (Verified empirically: installing a
  // no-op `agent/pre-step` listener alone reproduces the failure; the
  // `approval/request` listener alone does not.)
  if (enablePrompt && !officialEnabled) {
    const warmUp = ensureLongRuntime(ctx, bridge);
    const warmUpTimer = setTimeout(() => {
      try {
        process.stderr.write(
          "[dsh-acp] long-runtime warm-up still pending after 5s (continuing; lazy init will retry on first prompt)\n",
        );
      } catch {}
    }, 5000);
    warmUpTimer.unref?.();
    warmUp
      .then(() => {
        clearTimeout(warmUpTimer);
      })
      .catch((e) => {
        clearTimeout(warmUpTimer);
        try {
          process.stderr.write(
            `[dsh-acp] long-runtime warm-up failed (lazy init will retry on first prompt): ${e?.message ?? e}\n`,
          );
        } catch {}
      });
  }

  return bridge;
}