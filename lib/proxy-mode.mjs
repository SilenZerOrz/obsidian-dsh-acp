// lib/proxy-mode.mjs — P3.0 commit 3: dsh-acp.mjs proxy 模式客户端
//
// 为什么需要这个模块(2026-09-17):
//   dsh-acp 走 long-runtime 时,long-runtime 必须在 dsh web 进程内
//   (in-process)以订阅 ctx.llm.stream / ctx.on('approval/request')。
//   但 Obsidian Agent Client 只支持 stdio spawn,Obsidian 拉起的
//   dsh-acp.mjs 是独立进程,拿不到 cordis ctx。
//
//   解法:dsh-acp.mjs 启动时探测 dsh web 是否暴露了 HTTP gateway
//   (commit 2 的 lib/http-gateway.mjs 在 webServer 上挂的 /acp/proxy/*)。
//   若探测成功,把 session/prompt 经 HTTP/SSE 转发到 dsh web,长流程在
//   dsh web 内真实跑,dsh-acp.mjs 只剩 thin proxy。
//
//   探测失败 / gateway 未启用 → 退回 spawn 模式(向后兼容)。
//
// 行为:
//   - probeDshWebGateway(baseUrl):GET /acp/proxy/probe,2s 超时。
//     返回 { ok, version, mode, longReady, reason, _baseUrl }。
//   - forwardPromptViaHttp({...}):POST /acp/proxy/session/prompt SSE 流。
//     把每个 sessionUpdate SSE 事件回调给 onUpdate(method, params),
//     收到 "result" SSE 时返回 { stopReason, usage },收到 "error" 时 throw。
//   - 探测与 prompt 都是非阻塞且 graceful,失败不破坏 spawn 路径。
//
// Phase D (2026-09-18): the outer AbortSignal now threads through to
// handleServerRequest and races the onRequest callback against an abort.
// Without it, an Obsidian Agent Client that silently drops a
// session/request_permission request leaves the in-flight Promise stranded
// even after the 10-minute PROMPT_TIMEOUT_MS aborts the fetch — the server
// side never finds out.

/**
 * Default dsh web base URL.
 *
 * NOTE: dsh web (launchd-managed at
 *   ~/Library/LaunchAgents/com.deepseek.harness.web.plist,
 *   program `dsh web --no-open`) listens on port **3080**, not the legacy 18789.
 * Earlier revisions of this constant assumed 18789 — that probe always
 * ECONNREFUSED on a real dsh-web installation, silently downgrading dsh-acp
 * to spawn mode. Keep this in sync with the dsh-web plist.
 */
export const PROXY_DEFAULT_BASE_URL = "http://127.0.0.1:3080";

/** Probe timeout: 2s — if dsh web is not up, fail fast and fall back to spawn. */
export const PROBE_TIMEOUT_MS = 2000;

/** Per-prompt timeout: 10 minutes (matches long-runtime default turn budget). */
export const PROMPT_TIMEOUT_MS = 600000;

import { abortOnSignal } from "./abort-utils.mjs";

/** Resolve dsh web base URL — env override wins. */
export function getProxyBaseUrl() {
  return process.env.DSH_ACP_HTTP_GATEWAY_URL || PROXY_DEFAULT_BASE_URL;
}

/**
 * Check whether `DSH_ACP_PROXY_MODE` allows running the probe at all.
 *
 *   "false" / "0" / "no" → opt-out, skip probe (force spawn).
 *   undefined / others    → opt-in (default).
 *
 * @param {NodeJS.ProcessEnv} [env=process.env]
 * @returns {boolean} true if probe should run
 */
export function shouldAttemptProxy(env = process.env) {
  const raw = env.DSH_ACP_PROXY_MODE;
  if (raw === undefined) return true;
  return !(raw === "false" || raw === "0" || raw === "no");
}

/**
 * Probe dsh web's HTTP gateway. Cheap + bounded.
 *
 * @param {string} [baseUrl=getProxyBaseUrl()]
 * @returns {Promise<{ ok: boolean, version?: string, mode?: string,
 *                     longReady?: boolean, reason?: string, _baseUrl: string }>}
 */
export async function probeDshWebGateway(baseUrl = getProxyBaseUrl()) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), PROBE_TIMEOUT_MS);
  try {
    const res = await fetch(`${baseUrl}/acp/proxy/probe`, {
      method: "GET",
      signal: ctl.signal,
    });
    if (!res.ok) return { ok: false, reason: `http-${res.status}`, _baseUrl: baseUrl };
    const body = await res.json().catch(() => ({}));
    if (body?.ok !== true) return { ok: false, reason: "probe-body-invalid", _baseUrl: baseUrl };
    return {
      ok: true,
      version: typeof body.version === "string" ? body.version : undefined,
      mode: typeof body.mode === "string" ? body.mode : undefined,
      longReady: body.longReady === true,
      _baseUrl: baseUrl,
    };
  } catch (e) {
    return {
      ok: false,
      reason: e?.name === "AbortError" ? "probe-timeout" : (e?.message ?? String(e)),
      _baseUrl: baseUrl,
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Parse a chunk of SSE text into zero or more events. Exported for unit tests.
 *
 * SSE wire format (per RFC):
 *   - Lines starting with "event: " set the event name.
 *   - Lines starting with "data: " append JSON payload.
 *   - Events are delimited by a blank line ("\n\n").
 *
 * Strategy: split on "\n\n", each chunk can carry multiple events OR a partial
 * one. We emit events whose data line was present; lines without "data:" are
 * treated as keepalive/ping and ignored.
 *
 * @param {string} buffer
 * @returns {{ events: Array<{event: string, data: string}>, remainder: string }}
 */
export function parseSseBuffer(buffer) {
  const parts = buffer.split("\n\n");
  const remainder = parts.pop() ?? "";
  const events = [];
  for (const part of parts) {
    if (!part) continue;
    let event = "message";
    let data = "";
    for (const line of part.split("\n")) {
      if (line.startsWith("event: ")) event = line.slice(7).trim();
      else if (line.startsWith("data: ")) data += line.slice(6);
    }
    if (data) events.push({ event, data });
  }
  return { events, remainder };
}

/**
 * Forward one prompt turn to dsh web's HTTP gateway. Streams sessionUpdate
 * SSE events to onUpdate, resolves with the final result envelope.
 *
 * When the server emits an SSE "request" event (long-runtime needs to call
 * acpClient.request, e.g. session/request_permission), forward to onRequest
 * then POST the reply back to /acp/proxy/permission-response. The
 * correlationId routes the reply back to the originating pending Promise
 * inside the server-side writer.
 *
 * @param {object} args
 * @param {string} args.baseUrl
 * @param {string} args.sessionId
 * @param {string|object|Array} args.prompt - raw ACP prompt payload
 * @param {string} [args.model]
 * @param {number} [args.temperature]
 * @param {string} [args.reasoningEffort]
 * @param {(method: string, params: object) => Promise<void>|void} args.onUpdate
 * @param {(method: string, params: object) => Promise<any>} [args.onRequest] -
 *           handler for server-initiated client requests (typically delegates
 *           to ctx.client.request). Defaults to throwing — without it, any
 *           permission prompt will reject and the turn will cancel.
 * @param {AbortSignal} [args.signal] - outer abort (e.g. ACP session cancel)
 * @returns {Promise<{ stopReason: string, usage: object }>}
 */
export async function forwardPromptViaHttp({
  baseUrl,
  sessionId,
  prompt,
  model,
  temperature,
  reasoningEffort,
  onUpdate,
  onRequest,
  signal,
}) {
  const ctl = new AbortController();
  const onAbort = () => ctl.abort();
  if (signal) {
    if (signal.aborted) ctl.abort();
    else signal.addEventListener("abort", onAbort, { once: true });
  }
  // Outer turn-budget timer (default 10min) — covers the entire prompt
  // including any permission waits. The server has its own per-request
  // timeout; this is just the safety net for the client.
  const timer = setTimeout(() => ctl.abort(), PROMPT_TIMEOUT_MS);

  try {
    const r = await fetch(`${baseUrl}/acp/proxy/session/prompt`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sessionId,
        prompt,
        model,
        temperature,
        reasoningEffort,
      }),
      signal: ctl.signal,
    });
    if (!r.ok || !r.body) throw new Error(`prompt http ${r.status}`);
    const reader = r.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const { events, remainder } = parseSseBuffer(buf);
      buf = remainder;
      for (const ev of events) {
        let payload;
        try {
          payload = JSON.parse(ev.data);
        } catch {
          continue;
        }
        if (ev.event === "result") {
          return {
            stopReason: typeof payload.stopReason === "string" ? payload.stopReason : "end_turn",
            usage: payload.usage ?? { totalTokens: 0, inputTokens: 0, outputTokens: 0 },
          };
        } else if (ev.event === "error") {
          throw new Error(payload?.message ?? "proxy error event");
        } else if (ev.event === "sessionUpdate") {
          await onUpdate(payload?.method ?? "session/update", payload?.params ?? {});
        } else if (ev.event === "request") {
          // Server-initiated client request (typically session/request_permission).
          // Fire-and-await onRequest (raced against the outer abort signal),
          // then POST the reply back so the server's pending Promise resolves
          // and long-runtime can continue. Phase D threads `signal` through
          // so a turn cancel (Obsidian disconnect, upstream ctx.signal abort)
          // releases the SSE writer's pending entry instead of stranding it.
          await handleServerRequest({
            baseUrl,
            sessionId,
            correlationId: payload?.correlationId,
            method: payload?.method,
            params: payload?.params,
            onRequest,
            signal,
          });
        }
      }
    }
    // Stream ended without explicit result — treat as graceful end_turn.
    return {
      stopReason: "end_turn",
      usage: { totalTokens: 0, inputTokens: 0, outputTokens: 0 },
    };
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener("abort", onAbort);
  }
}

/**
 * Forward one server-initiated request to onRequest and POST the reply.
 *
 * Why (2026-09-18 P3.0 tool-call fix):
 *   Without this handler, an SSE "request" event would just sit in the
 *   parser — long-runtime's request() promise never resolves, the LLM
 *   stream stalls, the user sees nothing, and eventually the outer
 *   PROMPT_TIMEOUT_MS aborts the whole fetch. Calling onRequest (which
 *   in dsh-acp.mjs proxies to ctx.client.request → Obsidian Agent
 *   Client → user clicks Allow) and POSTing the reply back completes
 *   the round-trip.
 *
 * @param {object} args
 * @param {string} args.baseUrl
 * @param {string} args.sessionId
 * @param {string} args.correlationId
 * @param {string} args.method
 * @param {object} args.params
 * @param {(method: string, params: object) => Promise<any>} [args.onRequest]
 */
async function handleServerRequest({
  baseUrl,
  sessionId,
  correlationId,
  method,
  params,
  onRequest,
  signal,
}) {
  if (!correlationId || typeof correlationId !== "string") {
    process.stderr.write("[dsh-acp] proxy request event missing correlationId; ignoring\n");
    return;
  }
  let result;
  let error;
  // Phase D: race the user-facing onRequest against the outer abort signal.
  // If Obsidian Agent Client silently drops the request_permission or the
  // turn is cancelled mid-flight, this Promise rejects with AbortError and
  // we POST `{ok:false, error:"aborted"}` back so the server releases its
  // pending Promise (instead of stranding it).
  try {
    if (typeof onRequest !== "function") {
      throw new Error("no onRequest handler wired — server permission request cannot be answered");
    }
    result = await Promise.race([
      Promise.resolve().then(() => onRequest(method, params)),
      abortOnSignal(signal, "onRequest aborted"),
    ]);
  } catch (e) {
    error = e?.message ?? String(e);
    // Mark AbortError so the server side can distinguish "user cancelled"
    // from "user clicked reject". The server's SseWriter will reject its
    // own pending Promise with the same error name.
    if (e && e.name === "AbortError") {
      error = `aborted: ${e.message ?? ""}`.trim();
    }
  }
  try {
    await fetch(`${baseUrl}/acp/proxy/permission-response`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(
        error ? { ok: false, sessionId, correlationId, error } : { ok: true, sessionId, correlationId, result },
      ),
    });
  } catch (e) {
    // Best-effort — if the reply POST fails the server's pending Promise
    // will time out and the turn will be cancelled, but we shouldn't
    // crash the SSE reader.
    process.stderr.write(`[dsh-acp] permission-response POST failed: ${e?.message ?? e}\n`);
  }
}