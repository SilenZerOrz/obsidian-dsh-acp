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
      state.indexMap.set(chunk.index, { kind: "text", messageId });
      return {
        sessionUpdate: "agent_message_chunk",
        messageId,
        content: { type: "text", text: "" },
      };
    }
    case "reasoning": {
      const messageId = fn_allocMessageId(state, "thought");
      state.indexMap.set(chunk.index, { kind: "thought", messageId });
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
  const update = {
    sessionUpdate: "tool_call_update",
    toolCallId: chunk.id,
    status: "in_progress",
  };
  if (chunk.name !== undefined) update.title = chunk.name;
  // We don't try to parse argumentsDelta incrementally — ACP clients expect
  // the full rawInput on completion. Track the accumulated JSON in state so
  // block-end can flush it.
  if (!slot.rawInputAccum) slot.rawInputAccum = "";
  slot.rawInputAccum += chunk.argumentsDelta;
  return update;
}

function mapBlockEnd(chunk, state) {
  const slot = state.indexMap.get(chunk.index);
  if (!slot) return null; // block-end without prior start/delta
  switch (slot.kind) {
    case "text": {
      // Final flush: emit the assembled text as a single agent_message_chunk
      // so clients that don't auto-coalesce deltas see the complete content.
      // We rely on the deltas to have streamed incrementally; this is a
      // belt-and-suspenders complete snapshot.
      return {
        sessionUpdate: "agent_message_chunk",
        messageId: slot.messageId,
        content: { type: "text", text: extractText(chunk.block) },
      };
    }
    case "thought": {
      return {
        sessionUpdate: "agent_thought_chunk",
        messageId: slot.messageId,
        content: { type: "text", text: extractText(chunk.block) },
      };
    }
    case "tool": {
      // Tool call completed. Emit completed status with rawInput.
      const update = {
        sessionUpdate: "tool_call_update",
        toolCallId: slot.messageId,
        status: "completed",
      };
      if (slot.rawInputAccum) {
        try {
          update.rawInput = JSON.parse(slot.rawInputAccum);
        } catch {
          // Malformed JSON — surface as rawInput string so client can still see it
          update.rawInput = slot.rawInputAccum;
        }
      }
      // Optional: surface tool output if ContentBlock has content
      const output = extractToolOutput(chunk.block);
      if (output !== undefined) update.content = output;
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