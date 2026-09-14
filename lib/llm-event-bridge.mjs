// lib/llm-event-bridge.mjs — bridges dsh LLM stream (async iterable of
// StreamChunks) to ACP sessionUpdate callbacks.
//
// One LLMStreamBridge per active prompt. Owns:
//   - one MapperState (held in chunk-mapper) for index→messageId tracking
//   - the latest usage chunk (kept until the result is built)
//   - the finish reason (kept until the result is built)
//
// The bridge is intentionally decoupled from the ACP client: it accepts an
// `onUpdate` callback that the caller wires to `client.sessionUpdate()`.
// That keeps the bridge unit-testable without an ACP server.
//
// Usage:
//:
//   const bridge = new LLMStreamBridge({ onUpdate: async (u) => client.update(u) });
//   const result = await bridge.pump(ctx.llm.stream({ messages, ... }));
//   // → { stopReason: "end_turn", usage: { inputTokens, outputTokens, totalTokens } }

import { chunkToUpdate, createMapperState } from "./chunk-mapper.mjs";

/**
 * @typedef {Object} BridgeOptions
 * @property {(update: object) => Promise<void> | void} onUpdate
 *           called once per non-null sessionUpdate produced by the mapper.
 * @property {(chunk: object) => void} [onRawChunk]
 *           optional debug hook; fired with every chunk before mapping.
 * @property {(err: Error) => void} [onError]
 *           optional error sink; called when the stream throws.
 */

/**
 * @typedef {Object} BridgeResult
 * @property {"end_turn"|"max_tokens"|"max_turn_requests"|"refusal"|"cancelled"} stopReason
 * @property {object|null} usage - last `usage` chunk's payload (or null if no usage arrived)
 * @property {object|null} finishReason - dsh FinishReason from the terminal chunk (or null)
 */

export class LLMStreamBridge {
  /** @param {BridgeOptions} opts */
  constructor(opts) {
    if (!opts || typeof opts.onUpdate !== "function") {
      throw new TypeError("LLMStreamBridge requires opts.onUpdate");
    }
    this._onUpdate = opts.onUpdate;
    this._onRawChunk = opts.onRawChunk || null;
    this._onError = opts.onError || null;
    this._state = createMapperState();
    this._usage = null;
    this._finishReason = null;
    this._emittedCount = 0;
    this._error = null;
  }

  /** How many sessionUpdates have been emitted (for tests + telemetry). */
  get emittedCount() {
    return this._emittedCount;
  }

  /** Current mapper state (read-only use only). */
  get mapperState() {
    return this._state;
  }

  /**
    * Pump one async-iterable stream of dsh StreamChunks end-to-end, emitting
    * sessionUpdates and returning the terminal result.
    *
    * If the stream throws, the bridge calls onError (if provided) and
    * returns `{ stopReason: "cancelled", usage, finishReason: null }`. The
    * thrown error is *not* rethrown — the caller decides how to surface it
    * (typically: include in the ACP result or session archive).
    *
    * @param {AsyncIterable<object>} chunkStream
    * @returns {Promise<BridgeResult>}
    */
  async pump(chunkStream) {
    try {
      for await (const chunk of chunkStream) {
        if (this._onRawChunk) this._onRawChunk(chunk);
        // Remember terminal data so we can build the result after the loop.
        if (chunk && chunk.type === "usage" && chunk.usage) {
          this._usage = chunk.usage;
        }
        if (chunk && chunk.type === "finish" && chunk.reason) {
          this._finishReason = chunk.reason;
        }
        const update = chunkToUpdate(chunk, this._state);
        if (update !== null) {
          await this._onUpdate(update);
          this._emittedCount += 1;
        }
      }
    } catch (err) {
      this._error = err;
      if (this._onError) {
        try {
          this._onError(err);
        } catch {
          /* swallow sink errors */
        }
      }
    }
    return this._buildResult();
  }

  /** @returns {BridgeResult} */
  _buildResult() {
    if (this._error && !this._finishReason) {
      // Stream threw before delivering a finish chunk — synthesize "cancelled"
      // so the caller still gets a result to send back to the client.
      return {
        stopReason: "cancelled",
        usage: this._usage,
        finishReason: null,
      };
    }
    return {
      stopReason: mapStopReason(this._finishReason),
      usage: this._usage,
      finishReason: this._finishReason,
    };
  }
}

/**
 * Map dsh FinishReason → ACP StopReason.
 *
 * dsh `FinishReason.kind`:
 *   "stop"      — normal completion
 *   "max-tokens"— model hit token limit
 *   "aborted"   — user/cancel cut the stream short
 *   "error"     — terminal error (already surfaced by LlmRuntime)
 *
 * ACP StopReason: end_turn | max_tokens | max_turn_requests | refusal | cancelled
 *
 * @param {object|null} reason - dsh FinishReason
 * @returns {"end_turn"|"max_tokens"|"cancelled"}
 */
export function mapStopReason(reason) {
  if (!reason || typeof reason !== "object") return "end_turn";
  switch (reason.kind) {
    case "stop":
      return "end_turn";
    case "max-tokens":
      return "max_tokens";
    case "aborted":
      return "cancelled";
    case "error":
      // ACP has no "error" stopReason; surface as cancelled and let the
      // caller log + archive the error separately.
      return "cancelled";
    default:
      // Unknown future reason — treat as normal completion so the client
      // doesn't get stuck waiting.
      return "end_turn";
  }
}