// lib/acp-tool-translation.mjs — official → legacy tool 事件翻译层 (#95 Session A).
//
// Why: official apply() and legacy chunk-mapper are two entirely different
// producers of session/update events. message/thought chunks and usage_update
// are shape-aligned and pass through verbatim (docs + #96 empirical). ONLY the
// tool frames diverge, and legacy SSE clients already digest the legacy shape —
// so the gateway translates official tool frames into legacy tool_call_update
// semantics before pushing them out on the wire.
//
// Empirical shape (docs/实施计划/dsh-acp-official-bridge-tool-translation-spec.md):
//   official start   : sessionUpdate:"tool_call" {toolCallId, title, kind:"other",
//                      status:"in_progress", rawInput}
//   official finish  : sessionUpdate:"tool_call_update" {toolCallId, status:"completed",
//                      content:[]}   // EMPTY content array; NO rawInput, NO title
//   legacy start     : sessionUpdate:"tool_call" {toolCallId, status:"pending",
//                      title}        // P0-1 (2026-10-14): now PASSES THROUGH tool_call
//                                      // (was: downgraded to tool_call_update)
//   legacy finish    : sessionUpdate:"tool_call_update" {toolCallId, status:"completed",
//                      rawInput}     // rawInput = parsed accumulated arguments; no content key
//
// Translation rules:
//   1. official "tool_call" (start)      → PASSED THROUGH verbatim (P0-1, 2026-10-14)
//        - previously downgraded to legacy "tool_call_update" in_progress, which
//          meant agent-client never rendered the pending card. Now the ACP
//          `tool_call` start frame reaches the client (status pending), matching
//          claude-agent-acp (tool-calls/renderer.js toolCall()).
//        - ALSO cache start.rawInput by toolCallId (official finish omits rawInput).
//   2. official "tool_call_update" (finish) → legacy "tool_call_update" finished
//        - rawInput is BACKFILLED from the cached start.rawInput.
//        - drop the empty content:[] (never forward it as a frame).
//   3. any other frame                    → returned VERBATIM (zero side effects).
//        - never reconstruct, never normalize, never add fields.
//
// Lifecycle: this is a PER-SESSION, STATEFUL translator. The gateway must create
// ONE instance per handleOfficialSessionPrompt call (owns a rawInputByToolCall
// Map) and discard it when the prompt resolves/rejects. Do NOT cache it at
// session level — across turns the Map would leak and a reused toolCallId could
// be poisoned. (Session B multi-session concurrency relies on this.)

export function createUpdateTranslator() {
  /** toolCallId → the rawInput captured on the official start frame. */
  const rawInputByToolCall = new Map();
  /** Whether any legacy tool frame was emitted (diagnostic only, unused now). */
  let seenToolFrame = false;

  /**
   * Translate ONE session/update frame (the `params.update` object) for the
   * legacy wire. Returns the frame(s) to emit; never throws.
   *
   * @param {object} update  the `update` field of a session/update params.
   * @returns {Array<object>} frames to emit (may be empty if dropped).
   */
  function translate(update) {
    if (!update || typeof update !== "object") return [update];

    if (update.sessionUpdate === "tool_call") {
      // P0-1 (frame alignment): PASS THROUGH the `tool_call` START frame
      // instead of downgrading it to `tool_call_update{in_progress}`.
      // claude-agent-acp sends `tool_call` (status pending) and agent-client
      // renders the pending card from it; downgrading meant the client never
      // saw the start frame. Keep the rawInput cache for the finish backfill.
      const { toolCallId } = update;
      rawInputByToolCall.set(toolCallId, update.rawInput ?? {});
      seenToolFrame = true;
      return [
        {
          ...update,
          sessionUpdate: "tool_call",
          status: update.status ?? "pending",
        },
      ];
    }

    if (update.sessionUpdate === "tool_call_update") {
      // Official FINISH frame → legacy finished tool_call_update. rawInput is
      // backfilled from the start-frame cache (official finish omits it).
      const { toolCallId, status } = update;
      const cached = rawInputByToolCall.get(toolCallId);
      rawInputByToolCall.delete(toolCallId); // consume → no leak across turns
      const legacy = { sessionUpdate: "tool_call_update", toolCallId, status };
      // Defensive: official finish carries NO rawInput, so we normally backfill
      // the cached start.rawInput. If we never saw a matching start (model
      // anomaly / dropped frame / reused id), fall back to {} rather than crash
      // or emit a rawInput-less completed frame.
      legacy.rawInput = cached !== undefined ? cached : {};
      // Non-empty `content` (typically a failed tool's error message — see
      // lib/headless-json-parser.mjs emitting the failed tool_result case) is
      // forwarded verbatim so legacy clients can render the error inline.
      // Official apply()'s completed frames empirically send content:[]; that
      // empty array still gets dropped here (matches pre-existing behavior and
      // the documented "no content key" legacy finish contract).
      if (Array.isArray(update.content) && update.content.length > 0) {
        legacy.content = update.content;
        // P0-2/P1-4 (2026-10-14): prefer an explicit incoming `rawOutput`
        // (the parser already sets it). Fall back to deriving it from content
        // items — dsh content items are `{type:"content",content:{type:"text",
        // text}}` (nested), so look inside `c.content.text` too.
        if (typeof update.rawOutput === "string") {
          legacy.rawOutput = update.rawOutput;
        } else {
          const parts = update.content
            .map((c) => {
              if (typeof c === "string") return c;
              if (c && c.type === "text" && typeof c.text === "string") return c.text;
              if (c && c.content && c.content.type === "text" && typeof c.content.text === "string") return c.content.text;
              return typeof c === "object" ? JSON.stringify(c) : String(c);
            })
            .filter((s) => typeof s === "string" && s.length > 0);
          if (parts.length) legacy.rawOutput = parts.join("\n");
        }
      }
      // P0-3: carry kind through if the upstream start frame had one.
      if (update.kind !== undefined) legacy.kind = update.kind;
      return [legacy];
    }

    // Non-tool frames (agent_thought_chunk / agent_message_chunk / usage_update,
    // or any future frame type) pass through VERBATIM — zero side effects.
    return [update];
  }

  return { translate, _rawInputByToolCall: rawInputByToolCall, _seenToolFrame: () => seenToolFrame };
}
