// lib/headless-json-parser.mjs — pure NDJSON → ACP session/update translator.
//
// Why: dsh 0.1.7-rc.1's `dsh --profile headless --json` flag emits newline-
// delimited run events (session / status / text / tool_call / tool_result /
// final). Without a parser the spawn path at dsh-acp.mjs:303-307 can only
// forward stdout as plain text — structurally incapable of producing
// tool_call frames, which leaves 0.3.0 DoD #1 unreachable on the spawn path.
//
// This module converts each JSONL event into the OFFICIAL-shaped
// session/update frame that lib/acp-tool-translation.mjs already digests.
// The caller wires:
//
//   JSONL line → push(line) → official frames
//     → createUpdateTranslator().translate(frame) → legacy SSE frames
//
// keeping ONE translation spec across official apply() and headless JSONL
// paths (v2 plan §5.5.3 "single source, no drift").
//
// Reference schema: dsh 0.1.7-rc.1 `dsh --profile headless --json` output.
// Sample: test/fixtures/headless-tool-call-sample.jsonl (12 events, captured
// 2026-09-28). Spec lives in
// docs/实施计划/dsh-acp-official-bridge-v2-migration-plan.md §5.5.2.

/**
 * Create a per-prompt headless JSONL parser.
 *
 * Lifecycle: instantiate ONE parser per `dsh --json` spawn (mirrors the
 * per-prompt lifecycle of createUpdateTranslator). Discard the instance when
 * the spawn resolves/rejects; do NOT cache across prompts.
 *
 * @returns {{
 *   push: (line: string) => Array<object>,
 *   flush: () => { sessionId: string|null, cwd: string|null,
 *                  stopReason: string, events: Array<object>, sawFinal: boolean }
 * }}
 */
export function createHeadlessParser() {
  const events = [];
  let sessionId = null;
  let cwd = null;
  let messageIdCounter = 0;
  let stopReason = "end_turn"; // default until turn_end overrides
  let sawFinal = false;

  function allocMessageId(prefix) {
    messageIdCounter += 1;
    return `${prefix}-${messageIdCounter}`;
  }

  /**
   * Feed ONE JSONL line (with or without trailing newline). Returns the
   * official-shaped session/update frames emitted by this line; an empty
   * array means the line carried no frames (silent events, blank lines,
   * malformed JSON, unknown event types — all swallowed defensively).
   *
   * The function is total: it never throws. Malformed input is treated as a
   * no-op so a single bad line from a mid-stream dsh crash can't tear down
   * the spawn's caller.
   *
   * @param {string} line  one JSONL event (no embedded newlines expected)
   * @returns {Array<object>}  zero or more session/update frames
   */
  function push(line) {
    if (typeof line !== "string") return [];
    const trimmed = line.trim();
    if (trimmed.length === 0) return [];

    let evt;
    try {
      evt = JSON.parse(trimmed);
    } catch {
      // Forward-compat: tolerate malformed lines (e.g. late dsh stderr bleed
      // onto stdout, or a partial line on SIGTERM). Don't crash the parser.
      return [];
    }
    if (!evt || typeof evt !== "object") return [];

    const frames = [];

    switch (evt.type) {
      case "session": {
        // sessionId + cwd are metadata — capture for flush(); no frames.
        if (typeof evt.sessionId === "string") sessionId = evt.sessionId;
        if (typeof evt.cwd === "string") cwd = evt.cwd;
        break;
      }

      case "status": {
        switch (evt.phase) {
          case "step_end": {
            if (evt.usage && typeof evt.usage === "object") {
              const totalTokens = typeof evt.usage.totalTokens === "number"
                ? evt.usage.totalTokens
                : 0;
              frames.push({
                sessionUpdate: "usage_update",
                used: totalTokens,
                size: 0,
                // Carry the breakdown so legacy clients (which only know
                // `used`+`size`) can still surface it on the side. The
                // official apply() path's usage_update is `{used,size}`-only
                // and the translator passes it through verbatim — extra keys
                // are forward-compat (no client reads them today).
                inputTokens: evt.usage.inputTokens ?? 0,
                outputTokens: evt.usage.outputTokens ?? 0,
              });
            }
            break;
          }
          case "turn_end": {
            const kind = evt.reason?.kind;
            if (kind === "completed") stopReason = "end_turn";
            else if (kind === "error") stopReason = "refusal";
            else if (kind === "cancelled") stopReason = "cancelled";
            else if (kind === "max_tokens") stopReason = "max_tokens";
            // Other reason kinds (timeout, model_anomaly, ...) intentionally
            // leave the default "end_turn" — keep the legacy SSE consumer's
            // happy-path intact and surface oddities upstream.
            break;
          }
          // turn_start / step_start → no frames (internal pacing only).
          default:
            break;
        }
        break;
      }

      case "text": {
        if (typeof evt.text === "string" && evt.text.length > 0) {
          // Each JSONL `text` event is a complete agent-side text block;
          // dsh doesn't stream it as deltas on the headless --json path, so
          // allocating a fresh messageId per event is correct. (Legacy SSE
          // consumers coalesce repeated `agent_message_chunk` frames with
          // distinct messageIds by rendering them in order — verified by the
          // chunk-mapper reference impl.)
          frames.push({
            sessionUpdate: "agent_message_chunk",
            messageId: allocMessageId("msg"),
            content: { type: "text", text: evt.text },
          });
        }
        break;
      }

      case "tool_call": {
        const { callId, tool: title, input } = evt;
        if (typeof callId !== "string") return frames;
        // OFFICIAL-shaped start frame. The translator maps this to legacy
        // tool_call_update{in_progress, title} and caches rawInput for the
        // matching finish backfill. The cache key is toolCallId.
        const frame = {
          sessionUpdate: "tool_call",
          toolCallId: callId,
          kind: "other", // ACP SDK v1.4.0 requires `kind` on tool_call
          status: "in_progress",
          rawInput: input && typeof input === "object" ? input : {},
        };
        if (title !== undefined) frame.title = String(title);
        frames.push(frame);
        break;
      }

      case "tool_result": {
        const { callId, status, result } = evt;
        if (typeof callId !== "string") return frames;
        const isFailed = status === "failed";
        // OFFICIAL-shaped finish frame. For `completed`, mirror official
        // apply()'s empirical empty content:[] — the translator drops empty
        // arrays (legacy finish contract: no content key). For `failed`,
        // surface the error string in the canonical ACP `content` shape; the
        // updated translator (see lib/acp-tool-translation.mjs) forwards
        // non-empty content so legacy clients can render the error inline.
        const frame = {
          sessionUpdate: "tool_call_update",
          toolCallId: callId,
          status: isFailed ? "failed" : "completed",
          content: [],
        };
        if (isFailed) {
          const errText = typeof result === "string"
            ? result
            : (result == null ? "" : String(result));
          frame.content = [
            {
              type: "content",
              content: { type: "text", text: errText },
            },
          ];
        }
        frames.push(frame);
        break;
      }

      case "final": {
        // Duplicate of the last text + tool result. Drop silently.
        sawFinal = true;
        break;
      }

      default:
        // Unknown event type (forward-compat for future dsh versions):
        // skip rather than crash. We log nothing here — the parser is pure
        // and any diagnostics belong one layer up (the spawn wrapper).
        return [];
    }

    for (const f of frames) events.push(f);
    return frames;
  }

  /**
   * Drain the parser after the spawn closes. Returns the accumulated
   * official-shaped frames plus the inferred stopReason (default
   * `end_turn` when no turn_end arrived — e.g. SIGKILL). The caller hands
   * the events to createUpdateTranslator().
   *
   * @returns {{ sessionId: string|null, cwd: string|null,
   *             stopReason: string, events: object[], sawFinal: boolean }}
   */
  function flush() {
    return {
      sessionId,
      cwd,
      stopReason,
      events,
      sawFinal,
    };
  }

  return { push, flush };
}