// lib/acp-official-router.mjs — Phase 2 FIRST-CUT minimal official bridge router.
//
// Goal (approved first cut): mount ONE `apply()` and get a single client
// session running end-to-end through it, NON-concurrent. No multi-session,
// no concurrency queue, no approval routing — those are Phase 2 second-cut /
// Phase 3.
//
// Why this module exists (the two risks the first cut exists to pin):
//
//   1. sessionId 对齐 — apply() SELF-GENERATES a UUID sessionId on
//      session/new (verified: `randomUUID()` in dsh-acp source; it IGNORES any
//      caller-provided `params.sessionId`). The HTTP client's sessionId is a
//      client-owned LABEL, not apply()'s UUID. So this router keeps a
//      `clientId -> applyId` translation map. Client-facing ids stay stable
//      (no archive break); apply() internally speaks UUIDs.
//
//   2. NO auto-fallback — if apply() mount/init fails, we THROW. The caller
//      (http-gateway) surfaces an SSE error. We never silently fall back to
//      the legacy long-runtime path: silent fallback would mask a broken
//      official bridge and make "DSH_ACP_USE_OFFICIAL_BRIDGE=1" tests pass
//      while actually running legacy. Rollback is the explicit env switch.
//
// SSE format compatibility (verified in test/official-bridge-alignment):
//   apply() emits `session/update` notifications as
//     params = { sessionId: <applyId>, update: {...} }
//   where update = { sessionUpdate:"agent_message_chunk", messageId, content }.
//   Legacy chunk-mapper emits the SAME update shape. So onUpdate forwards
//   apply()'s notification VERBATIM — no translation needed except the
//   sessionId value, which the map under the caller resolves.

import { apply as dshAcpApply } from "@deepseek-ai/dsh-acp";
import { createUpdateTranslator } from "./acp-tool-translation.mjs";

/**
 * Object-level bidirectional stream pair for `apply(ctx, {stream})`.
 *
 * Mirror of the SDK's `ndJsonStream()` contract (and the Spike fixture): the
 * two ends operate on JSON-RPC message OBJECTS, not bytes.
 *   - stream.writable = OUTBOUND: apply() writes response/notification objects.
 *   - stream.readable = INBOUND:  apply() reads request objects.
 * The router writes requests on the inbound writer and reads outbound frames
 * from the outbound reader.
 *
 * @returns {{
 *   writable: import("node:stream/web").WritableStream,
 *   readable: import("node:stream/web").ReadableStream,
 *   inboundWrite: (obj: object) => void,
 *   outbound: AsyncIterable<object>,
 *   close: () => void,
 * }}
 */
export function createAcpStream() {
  const inbound = new TransformStream();   // router → apply (requests)
  const outbound = new TransformStream();  // apply → router (responses + notifications)
  const inboundW = inbound.writable.getWriter();
  const outboundR = outbound.readable.getReader();

  async function* outboundIter() {
    for (;;) {
      const { value, done } = await outboundR.read();
      if (done) return;
      if (value === undefined) continue;
      yield value;
    }
  }

  return {
    writable: outbound.writable,
    readable: inbound.readable,
    inboundWrite(obj) {
      inboundW.write(obj).catch(() => {});
    },
    outbound: outboundIter(),
    close() {
      inboundW.close().catch(() => {});
      outbound.writable.close().catch(() => {});
    },
  };
}

/**
 * Mount apply() + route one client session through it (non-concurrent).
 *
 * @param {object} ctx - dsh cordis context (must carry llm/agents/sessions/
 *                       sessionPersistence — verified by probeOfficialBridge).
 * @param {object} [config]
 * @param {string} [config.provider] - preferred LLM provider override.
 * @param {string} [config.model]   - preferred model override.
 * @param {number} [config.maxSessions] - cap on concurrently-mapped sessions
 *        (clientToApply.size). Zero/omitted = unbounded (back-compat). When the
 *        cap is reached, a NEW clientId is rejected (Session C #4 queue
 *        pressure) instead of growing the map without bound.
 * @returns {{
 *   prompt: (clientSessionId: string, opts: object) => Promise<object>,
 *   close: () => void,
 *   getApplyId: (clientSessionId: string) => string|undefined,
 *   forgetSession: (clientSessionId: string) => void, // Session C #2 detach
 *   sessionCount: () => number,                        // Session C #2/C4 inspect
 *   _stream: object, // exposed for tests
 * }}
 */
export function createOfficialAcpRouter(ctx, config = {}) {
  const stream = createAcpStream();
  // Session C #4: bound the live-session map. 0/undefined = unbounded.
  const maxSessions = config.maxSessions ?? 0;

  dshAcpApply(ctx, {
    provider: config.provider,
    model: config.model,
    stream: { writable: stream.writable, readable: stream.readable },
  });

  /** clientId -> applyId (apply() self-generates UUID; see header). */
  const clientToApply = new Map();
  /** applyId -> clientId (reverse, for notification routing). */
  const applyToClient = new Map();

  /** pending JSON-RPC requests: id -> { resolve, reject }. */
  const pending = new Map();
  /** applyId -> Set<onUpdate> callbacks to route session/update to. */
  const notifiers = new Map();

  let nextId = 1;
  const nextRequestId = () => nextId++;

  // Drain apply()'s outbound frames.
  (async () => {
    try {
      for await (const frame of stream.outbound) {
        const { id, method, params } = frame ?? {};
        if (typeof id === "number" || typeof id === "string") {
          if (frame.error !== undefined) {
            const p = pending.get(id);
            if (p) { pending.delete(id); p.reject(frame.error); }
          } else if (frame.result !== undefined) {
            const p = pending.get(id);
            if (p) { pending.delete(id); p.resolve(frame.result); }
          }
          continue;
        }
        // Notification (no id) — route session/update by applyId.
        if (method === "session/update") {
          const applyId = params?.sessionId;
          if (typeof applyId === "string") {
            const fns = notifiers.get(applyId);
            if (fns) for (const fn of fns) { try { fn(params); } catch { /* best-effort */ } }
          }
        }
      }
    } catch {
      // Frame loop only exits on stream close; let pending reject then.
      for (const [, p] of pending) p.reject(Object.assign(new Error("acp stream closed"), { code: "ACP_CLOSED" }));
      pending.clear();
    }
  })();

  function send(method, params) {
    const id = nextRequestId();
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      stream.inboundWrite({ jsonrpc: "2.0", id, method, params });
    });
  }

  async function ensureSession(clientId) {
    const existing = clientToApply.get(clientId);
    if (existing) return existing;
    // Session C #4: reject a NEW session when the live map is at cap. Keeps
    // the queue bounded under load instead of growing without limit — a client
    // that keeps opening fresh sessionIds can't exhaust memory. Reuse of an
    // ALREADY-mapped clientId is unaffected (hits the `existing` branch above).
    if (maxSessions > 0 && clientToApply.size >= maxSessions) {
      throw new Error(
        `too many sessions: maxSessions=${maxSessions} reached (${clientToApply.size}); ` +
        `rejecting new client session "${clientId}"`,
      );
    }
    const res = await send("session/new", { cwd: process.cwd(), mcpServers: [] });
    if (res?.sessionId) {
      clientToApply.set(clientId, res.sessionId);
      applyToClient.set(res.sessionId, clientId);
      return res.sessionId;
    }
    throw new Error(`official apply session/new returned no sessionId: ${JSON.stringify(res) ?? String(res)}`);
  }

  function attach(applyId, onUpdate) {
    let s = notifiers.get(applyId);
    if (!s) { s = new Set(); notifiers.set(applyId, s); }
    s.add(onUpdate);
    return () => { s.delete(onUpdate); if (s.size === 0) notifiers.delete(applyId); };
  }

  return {
    getApplyId(clientId) {
      return clientToApply.get(clientId);
    },

    /**
     * Session C #2 — detach cleanup. Drop a client's mapping + notifier set so a
     * disconnected client can't leak (and a reused clientId re-maps cleanly).
     * Call from the gateway's disconnect/teardown path.
     *
     * @param {string} clientId - client session label to forget.
     */
    forgetSession(clientId) {
      const applyId = clientToApply.get(clientId);
      clientToApply.delete(clientId);
      if (applyId !== undefined) {
        applyToClient.delete(applyId);
        const fns = notifiers.get(applyId);
        if (fns) { fns.clear(); notifiers.delete(applyId); }
      }
    },

    /** Session C #2/#4 — number of currently-mapped live sessions. */
    sessionCount() {
      return clientToApply.size;
    },

    /**
     * Run one prompt turn on the given client session (non-concurrent; a
     * second concurrent prompt on the same clientId is undefined behavior in
     * this first cut — the caller's per-session mutex serializes them).
     *
     * @param {string} clientSessionId - the HTTP-layer session label.
     * @param {object} opts
     * @param {object|Array} opts.prompt - ACP prompt content blocks.
     * @param {(params: object) => void} [opts.onUpdate] - called with each
     *        `{sessionId, update}` notification params for this session.
     * @returns {Promise<{stopReason?: string, usage?: object}>}
     */
    async prompt(clientSessionId, opts) {
      const applyId = await ensureSession(clientSessionId);
      // #95 Session A: PER-PROMPT tool translator. apply() emits OFFICIAL tool
      // frames (tool_call start + tool_call_update finish w/ empty content:[]);
      // the router forwards LEGACY shape downstream (tool_call_update in_progress
      // + completed w/ rawInput). translate() maps tool frames and passes
      // message/thought/usage VERBATIM. Per-prompt instance owns the
      // rawInputByToolCall Map and is discarded at finally — never cached at
      // session level, so a reused toolCallId across turns can't poison it.
      const translator = createUpdateTranslator();
      const innerOnUpdate = opts.onUpdate ?? (() => {});
      const detach = attach(applyId, (params) => {
        const { update } = params ?? {};
        const out = translator.translate(update);
        // Each out frame becomes its own session/update notification. Tool
        // translation may yield 1 frame (pass-through) or 2 frames (tool_call
        // start → legacy in_progress + completion → legacy completed with
        // rawInput backfill). Non-tool frames yield exactly 1.
        for (const o of out) {
          innerOnUpdate({ ...params, update: o });
        }
      });
      try {
        const result = await send("session/prompt", {
          sessionId: applyId,
          prompt: opts.prompt,
          ...(opts.model ? { model: opts.model } : {}),
        });
        if (result && result.error !== undefined && !result.stopReason) {
          throw new Error(`official prompt failed: ${JSON.stringify(result)}`);
        }
        return { stopReason: result?.stopReason, usage: result?.usage };
      } finally {
        detach();
      }
    },

    close() {
      stream.close();
    },

    _stream: stream,
  };
}
