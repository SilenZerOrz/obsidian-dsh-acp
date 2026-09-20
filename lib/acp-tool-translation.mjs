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
//   legacy start     : sessionUpdate:"tool_call_update" {toolCallId, status:"in_progress",
//                      title}        // never emits "tool_call"
//   legacy finish    : sessionUpdate:"tool_call_update" {toolCallId, status:"completed",
//                      rawInput}     // rawInput = parsed accumulated arguments; no content key
//
// Translation rules:
//   1. official "tool_call" (start)      → legacy "tool_call_update" in_progress
//        - title comes from the START frame; ALSO cache start.rawInput by
//          toolCallId here (official finish omits rawInput).
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
      // Official START frame → legacy in_progress tool_call_update.
      const { toolCallId, title } = update;
      // Cache rawInput for the finish backfill. Defensive: if the start frame
      // lacks rawInput, cache {} so the finish frame still carries a value.
      rawInputByToolCall.set(toolCallId, update.rawInput ?? {});
      seenToolFrame = true;
      return [
        {
          sessionUpdate: "tool_call_update",
          toolCallId,
          status: "in_progress",
          ...(title !== undefined ? { title } : {}),
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
      // Drop the official empty content:[] (empirically always []) — never
      // forward it as a frame. (Legacy finish has no content key.)
      return [legacy];
    }

    // Non-tool frames (agent_thought_chunk / agent_message_chunk / usage_update,
    // or any future frame type) pass through VERBATIM — zero side effects.
    return [update];
  }

  return { translate, _rawInputByToolCall: rawInputByToolCall, _seenToolFrame: () => seenToolFrame };
}
