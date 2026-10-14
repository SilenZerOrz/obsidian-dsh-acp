// lib/chunk-mapper.mjs — pure-function mapper from dsh LLM StreamChunk
// → ACP sessionUpdate.
//
// dsh chunk schema (from @deepseek-ai/dsh-llm/lib/types/types.d.ts):
//
//   type StreamChunk =
//     | { type: 'block-start';     index: number; blockType: ContentBlockType }
//     | { type: 'text-delta';      index: number; text: string }
//     | { type: 'reasoning-delta'; index: number; text: string }
//     | { type: 'tool-call-delta'; index: number; id: ToolCallId; name?: string; argumentsDelta: string }
//     | { type: 'block-end';       index: number; block: ContentBlock }
//     | { type: 'usage';           usage: TokenUsage }
//     | { type: 'finish';          reason: FinishReason; replayState?: ReplayEnvelope };
//
// ACP SDK v1.4.0 sessionUpdate shape (from @agentclientprotocol/sdk types.gen.d.ts):
//   sessionUpdate: "agent_message_chunk" | "agent_thought_chunk" |
//                  "tool_call_update"    | "usage_update"      | ...
//   ToolCallStatus: "pending" | "in_progress" | "completed" | "failed"
//
// The mapper is *pure* in the sense that it takes input (chunk, state) and
// produces output (Update | null). It mutates the passed-in `state` map to
// remember index→messageId bindings; that is the only side effect. Keeping
// the state outside makes the function trivially testable.
//
// Each call returns ONE sessionUpdate, OR `null` for chunks that produce no
// sessionUpdate (finish → handled by the bridge as the stream result).

/**
 * @typedef {Object} MapperState
 * @property {number} nextId - monotonic id counter
 * @property {Map<number, { kind: 'text'|'thought'|'tool', messageId: string }>} indexMap
 *           dsh block index → ACP message/tool id (allocated at block-start
 *           for text/reasoning, taken from chunk.id for tool-calls).
 */

/**
 * Allocate a fresh MapperState. The bridge owns one state per stream and
 * passes it into every chunkToUpdate() call.
 *
 * @returns {MapperState}
 */
export function createMapperState() {
  return { nextId: 1, indexMap: new Map() };
}

/**
 * Pure-function mapper: one dsh chunk → one ACP sessionUpdate (or null).
 *
 * @param {object} chunk - dsh StreamChunk
 * @param {MapperState} state - mutated in place to track index → messageId
 * @returns {object|null} ACP sessionUpdate payload; null for finish (bridge
 *          synthesizes the result), or for malformed chunks the bridge should
 *          log and skip.
 */
export function chunkToUpdate(chunk, state) {
  switch (chunk.type) {
    case "block-start":
      return mapBlockStart(chunk, state);
    case "text-delta":
      return mapTextDelta(chunk, state, "text");
    case "reasoning-delta":
      return mapTextDelta(chunk, state, "thought");
    case "tool-call-delta":
      return mapToolCallDelta(chunk, state);
    case "block-end":
      return mapBlockEnd(chunk, state);
    case "usage":
      return mapUsage(chunk);
    case "finish":
      // No sessionUpdate for finish — the bridge uses this to synthesize
      // the final ACP session/prompt result (stopReason + usage). The
      // mapper state already has all the deltas flushed.
      return null;
    default:
      // Unknown chunk type (forward-compat): skip rather than crash.
      return null;
  }
}

// --- per-type handlers ----------------------------------------------------

function fn_allocMessageId(state, prefix) {
  const id = `${prefix}-${state.nextId}`;
  state.nextId += 1;
  return id;
}

function mapBlockStart(chunk, state) {
  switch (chunk.blockType) {
    case "text": {
      const messageId = fn_allocMessageId(state, "msg");
      // P3.1 C1: deltasSent is flipped to true on the first text-delta
      // for this index. mapBlockEnd consults it and skips the redundant
      // final snapshot when deltas have already streamed the same chars.
      state.indexMap.set(chunk.index, { kind: "text", messageId, deltasSent: false });
      return {
        sessionUpdate: "agent_message_chunk",
        messageId,
        content: { type: "text", text: "" },
      };
    }
    case "reasoning": {
      const messageId = fn_allocMessageId(state, "thought");
      // Same dedup pattern as text — reasoning-delta + reasoning block-end
      // can also dup; mapBlockEnd.thought will skip when deltas already
      // streamed. (Untested in P2 E 套件 but the wire shape is identical.)
      state.indexMap.set(chunk.index, { kind: "thought", messageId, deltasSent: false });
      return {
        sessionUpdate: "agent_thought_chunk",
        messageId,
        content: { type: "text", text: "" },
      };
    }
    case "tool-call": {
      // Tool-call id is not known at block-start (it comes with the first
      // tool-call-delta). Reserve a slot keyed by index so we can update the
      // status when deltas arrive. messageId stays null until first delta.
      state.indexMap.set(chunk.index, { kind: "tool", messageId: null });
      return null;
    }
    default:
      // Unknown block type — skip
      return null;
  }
}

function mapTextDelta(chunk, state, kind /* "text" | "thought" */) {
  const slot = state.indexMap.get(chunk.index);
  if (!slot || slot.kind !== kind) return null; // deltas without block-start
  // P3.1 C1: first delta for this index → mark the slot so mapBlockEnd
  // knows to skip the redundant snapshot. Subsequent deltas only need to
  // be flagged once (idempotent).
  slot.deltasSent = true;
  const sessionUpdate = kind === "text" ? "agent_message_chunk" : "agent_thought_chunk";
  return {
    sessionUpdate,
    messageId: slot.messageId,
    content: { type: "text", text: chunk.text },
  };
}

function mapToolCallDelta(chunk, state) {
  // Either block-start has reserved this index, or the delta arrives first
  // (delta-only protocol — tolerated by dsh's BlockAssembler). Either way,
  // bind the messageId from chunk.id the first time we see it.
  let slot = state.indexMap.get(chunk.index);
  if (!slot) {
    slot = { kind: "tool", messageId: null };
    state.indexMap.set(chunk.index, slot);
  }
  if (slot.messageId === null) {
    slot.messageId = chunk.id;
  } else if (slot.messageId !== chunk.id) {
    // id change mid-stream — unusual but tolerated (use latest).
    slot.messageId = chunk.id;
  }
  if (!slot.rawInputAccum) slot.rawInputAccum = "";
  slot.rawInputAccum += chunk.argumentsDelta;
  if (chunk.name !== undefined) slot.toolName = chunk.name;

  // P0-1 (frame alignment): the FIRST delta for this tool emits an ACP
  // `tool_call` START frame (status "pending") — the frame claude-agent-acp
  // sends (tool-calls/renderer.js toolCall()) and that agent-client renders
  // as the initial pending card. Subsequent deltas refine it with
  // `tool_call_update` (status "in_progress").
  if (!slot.startEmitted) {
    slot.startEmitted = true;
    return {
      sessionUpdate: "tool_call",
      toolCallId: chunk.id,
      ...(chunk.name !== undefined ? { name: chunk.name, title: chunk.name } : {}),
      kind: inferToolKind(chunk.name),
      status: "pending",
      // Input is still streaming at the start; the completion frame carries
      // the full rawInput. Send an empty object so the field is present.
      rawInput: {},
    };
  }
  const update = {
    sessionUpdate: "tool_call_update",
    toolCallId: chunk.id,
    status: "in_progress",
  };
  if (chunk.name !== undefined) update.title = chunk.name;
  return update;
}

/**
 * P0-3 (frame alignment): map a tool name to an ACP ToolKind so agent-client
 * renders the right type icon. Mirrors claude-agent-acp's kind categories
 * (tool-calls/renderer.js): read / edit / execute / search / fetch / think /
 * other (+ delete / move / switch_mode which the ACP enum also allows).
 */
export function inferToolKind(toolName) {
  const n = String(toolName ?? "").toLowerCase();
  if (!n) return "other";
  if (/delete|remove|\brm\b|rm_/.test(n)) return "delete";
  if (/move|rename/.test(n)) return "move";
  if (/read|cat|view|open|get_|list|ls\b|glob/.test(n)) return "read";
  if (/write|edit|create|patch|modify|apply|insert|replace/.test(n)) return "edit";
  if (/grep|search|find|query|lookup/.test(n)) return "search";
  if (/bash|shell|exec|run|command|pwd|terminal|spawn/.test(n)) return "execute";
  if (/web|fetch|http|curl|url|download/.test(n)) return "fetch";
  if (/think|reason|reflect/.test(n)) return "think";
  if (/switch|mode/.test(n)) return "switch_mode";
  return "other";
}

function mapBlockEnd(chunk, state) {
  const slot = state.indexMap.get(chunk.index);
  if (!slot) return null; // block-end without prior start/delta
  switch (slot.kind) {
    case "text": {
      // P3.1 C1 fix: when deltas have already streamed the same chars,
      // the block-end snapshot would re-emit the full text and the
      // downstream client would see it twice (verified empirically in P2
      // E 套件 hasSnapshotDup=true, hasDoubled=true). Skip the snapshot
      // so the client only sees the deltas (which ARE the full text).
      // Verified pre-fix: deltas are INCREMENTAL (each delta carries only
      // new chars, not cumulative). The accumulator in long-runtime.mjs
      // joins the deltas into the canonical finalText.
      if (slot.deltasSent) return null;
      // Fallback path: deltas were never sent (e.g. mock LLM emits only
      // block-start + block-end). Keep the original "belt-and-suspenders
      // complete snapshot" behavior so we don't regress single-frame
      // producers.
      return {
        sessionUpdate: "agent_message_chunk",
        messageId: slot.messageId,
        content: { type: "text", text: extractText(chunk.block) },
      };
    }
    case "thought": {
      // Same dedup pattern as text. reasoning-delta + block-end has the
      // same wire shape; skip when reasoning deltas already streamed.
      if (slot.deltasSent) return null;
      return {
        sessionUpdate: "agent_thought_chunk",
        messageId: slot.messageId,
        content: { type: "text", text: extractText(chunk.block) },
      };
    }
    case "tool": {
      // Tool call completed. Emit completed status.
      const update = {
        sessionUpdate: "tool_call_update",
        toolCallId: slot.messageId,
        status: "completed",
      };
      if (slot.toolName !== undefined) {
        update.title = slot.toolName;
        // P0-3: keep kind on the completion frame (claude-agent-acp's
        // refinement() carries kind/title/locations on the update too).
        update.kind = inferToolKind(slot.toolName);
      }
      // rawInput = the request params (kept for back-compat: some consumers
      // read it). P0-2: it is NOT the result.
      if (slot.rawInputAccum) {
        try {
          update.rawInput = JSON.parse(slot.rawInputAccum);
        } catch {
          update.rawInput = slot.rawInputAccum;
        }
      }
      // Optional: surface tool output if ContentBlock has content
      const output = extractToolOutput(chunk.block);
      if (output !== undefined) {
        update.content = output;
        // P0-2 (frame alignment): the RESULT goes in `rawOutput` — what
        // claude-agent-acp sends on the completion frame (renderer.js: the
        // tool_result path sets `rawOutput: chunk.content`). Raw text form so
        // agent-client can render it directly.
        update.rawOutput = toolOutputText(chunk.block);
      }
      return update;
    }
    default:
      return null;
  }
}

function mapUsage(chunk) {
  // ACP UsageUpdate requires `used` and `size` (in tokens). dsh TokenUsage
  // has { inputTokens, outputTokens, totalTokens }. We use totalTokens as
  // `used` and leave `size` as 0 unless the consumer provides it.
  const used = chunk.usage && typeof chunk.usage.totalTokens === "number"
    ? chunk.usage.totalTokens
    : 0;
  return {
    sessionUpdate: "usage_update",
    used,
    size: 0,
  };
}

// --- ContentBlock helpers -------------------------------------------------

/**
 * Extract the text payload from a dsh ContentBlock. dsh ContentBlock is a
 * discriminated union (text / reasoning / tool-call / etc.); for text and
 * reasoning blocks the text field holds the payload.
 */
function extractText(block) {
  if (block && typeof block.text === "string") return block.text;
  return "";
}

/**
 * Extract tool output from a completed tool-call block, if any. ACP ToolCall
 * can carry `content` (a list of {type, ...}) or a rawOutput string.
 */
function extractToolOutput(block) {
  if (!block || !block.content) return undefined;
  // dsh tool-call blocks typically have { toolCallId, toolCallName, content }
  // where content is an array of ContentBlock. Map to ACP-friendly shape.
  if (Array.isArray(block.content)) {
    return block.content.map((c) => {
      if (c.type === "text" && typeof c.text === "string") {
        return { type: "content", content: { type: "text", text: c.text } };
      }
      return { type: "content", content: { type: "text", text: JSON.stringify(c) } };
    });
  }
  return undefined;
}

/** P0-2: flatten a tool-call block's content to a raw text string (rawOutput). */
function toolOutputText(block) {
  if (!block || !block.content) return undefined;
  if (typeof block.content === "string") return block.content;
  if (Array.isArray(block.content)) {
    const parts = block.content
      .map((c) => (c && c.type === "text" && typeof c.text === "string" ? c.text : JSON.stringify(c)))
      .filter((s) => typeof s === "string" && s.length > 0);
    return parts.length ? parts.join("\n") : undefined;
  }
  return undefined;
}