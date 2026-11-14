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
import { inferToolKind } from "./chunk-mapper.mjs";
import { contextWindowFor } from "./context-window.mjs";

/**
 * @param {{provider?: string, model?: string}} [target]
 *        P2-3 (R142): the model this spawn runs, used to resolve the
 *        usage_update `size` ceiling. dsh's `--json` stream never reports one,
 *        so this used to be hardcoded `size: 0`. Optional — omitting it keeps
 *        the previous behaviour for callers that don't know the model.
 */
export function createHeadlessParser(target) {
  const events = [];
  let sessionId = null;
  let cwd = null;
  let messageIdCounter = 0;
  let stopReason = "end_turn"; // default until turn_end overrides
  let sawFinal = false;
  const modelTarget = target && (target.provider || target.model)
    ? { provider: target.provider, model: target.model }
    : null;

  function allocMessageId(prefix) {
    messageIdCounter += 1;
    return `${prefix}-${messageIdCounter}`;
  }

  /**
   * P2-3: resolve the spawn-path context-window ceiling.
   *
   * Precedence matches lib/chunk-mapper.mjs exactly, so one rule governs both
   * producers: a producer-supplied value (dsh has none today, kept for
   * forward-compat) → the operator env override → auto-detection → 0.
   *
   * A PRESENT-but-unparsable override still means "unknown" (0) rather than
   * falling through to auto-detect — same airtight escape hatch as the bridge.
   */
  function resolveSpawnCeiling(usage) {
    const isSet = (v) => v !== undefined && v !== null && v !== "";
    const candidates = [
      usage && usage.contextWindow,
      usage && usage.size,
      process.env.DSH_ACP_CONTEXT_WINDOW,
    ];
    for (const candidate of candidates) {
      const n = typeof candidate === "string" ? Number(candidate) : candidate;
      if (typeof n === "number" && Number.isFinite(n) && n > 0) return Math.round(n);
    }
    if (candidates.some(isSet)) return 0;
    try {
      const auto = contextWindowFor(modelTarget ?? {});
      if (typeof auto === "number" && auto > 0) return auto;
    } catch {
      /* best-effort — a ceiling probe must never break the stream */
    }
    return 0;
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
                // P2-3 (R142): dsh's --json stream carries NO ceiling, so this
                // was hardcoded 0 → Obsidian rendered "Infinity %" on the spawn
                // path. Resolve it like the host does (profile-declared
                // contextWindow → dsh's compiled default), honouring the
                // DSH_ACP_CONTEXT_WINDOW override first. 0 only when genuinely
                // unreachable (see lib/context-window.mjs).
                size: resolveSpawnCeiling(evt.usage),
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

      case "thinking": {
        // P2-1 (R133, C3 ThinkingBlock): dsh DOES emit reasoning on the
        // `--json` path. Provenance — @deepseek-ai/dsh-headless@0.2.2-rc.3,
        // lib/json-stream-Dc3g2Bl1.js:204-209:
        //
        //   case "assistant/message":
        //     for (const block of event.data.message.content)
        //       if (block.type === "reasoning") write({ type: "thinking", text: block.text });
        //       else if (block.type === "text") write({ type: "text", text: block.text });
        //
        // The module header (:4-7) adds the guarantee that matters here: the
        // projection emits only COMMITTED content ("text and reasoning come
        // from committed `assistant/message` content, never from a live attempt
        // that may still be retried or discarded"). So a `thinking` event is
        // one complete reasoning block — same granularity as `text`, and the
        // same one-messageId-per-event allocation applies.
        //
        // Shape parity with the long/proxy producer: chunk-mapper's
        // reasoning block-start yields
        //   { sessionUpdate: "agent_thought_chunk", messageId, content: { type: "text", text } }
        // (lib/chunk-mapper.mjs:127-131) and the translator passes it through
        // verbatim (lib/acp-tool-translation.mjs:178-181). Emitting the same
        // triple here is what makes Obsidian render a ThinkingBlock.
        if (typeof evt.text === "string" && evt.text.length > 0) {
          frames.push({
            sessionUpdate: "agent_thought_chunk",
            messageId: allocMessageId("thought"),
            content: { type: "text", text: evt.text },
          });
        }
        break;
      }

      case "tool_call": {
        const { callId, tool: title, input } = evt;
        if (typeof callId !== "string") return frames;
        // OFFICIAL-shaped start frame. P0-1: the translator now PASSES THIS
        // THROUGH (status pending) instead of downgrading it, so the client
        // renders the pending card. P0-3: infer a real ToolKind from the name
        // (was hardcoded "other").
        const frame = {
          sessionUpdate: "tool_call",
          toolCallId: callId,
          name: title !== undefined ? String(title) : undefined,
          kind: inferToolKind(title), // ACP SDK requires `kind` on tool_call
          status: "pending",
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
        // P1-4 (2026-10-14): the finish frame now carries the tool RESULT for
        // BOTH outcomes. Previously `completed` emitted an empty content:[] and
        // dropped `result` (mirroring official apply()), so agent-client's
        // ToolCallCard showed "completed" with no output. Now:
        //   - content[{type:"content",content:{type:"text",text}}] = result
        //   - rawOutput = result text  (aligns claude-agent-acp rawOutput)
        // When `result` is absent we keep content:[] (translator drops empty
        // arrays → no content key on the wire, unchanged).
        const frame = {
          sessionUpdate: "tool_call_update",
          toolCallId: callId,
          status: isFailed ? "failed" : "completed",
          content: [],
        };
        if (result != null) {
          const text = typeof result === "string" ? result : JSON.stringify(result);
          if (text) {
            frame.content = [
              { type: "content", content: { type: "text", text } },
            ];
            frame.rawOutput = text;
          }
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