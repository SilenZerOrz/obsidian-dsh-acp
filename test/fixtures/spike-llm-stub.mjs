// test/fixtures/spike-llm-stub.mjs — LlmAdapter stub for the Spike.
//
// Per the v2 plan §2.2 A1 (preferred) decision: real dsh agent loop + stub
// LLM provider. We extend the real `LlmAdapter` from @deepseek-ai/dsh-llm so
// the LlmRegistry can `registerAdapter(['stub'], us)` cleanly.
//
// StreamChunk shape comes straight from dsh-llm/lib/typert.host.js:462
//   | { type: 'block-start'; index; blockType }
//   | { type: 'text-delta';  index; text }
//   | { type: 'reasoning-delta'; index; text }
//   | { type: 'tool-call-delta'; index; id; name?; argumentsDelta }
//   | { type: 'block-end';   index; block: ContentBlock }
//   | { type: 'usage';       usage: TokenUsage }
//   | { type: 'finish';      reason: FinishReason; replayState? }
//
// We deliberately do NOT yield `tool-call-delta` — dsh-agent-loop may try to
// resolve a tool schema we don't have, and S4a is about text-only冒烟. If S4a
// fails specifically on missing tool schema, S4b (Phase 3) will add the
// minimal noop tool; we capture the stack from this run as evidence.
//
// Provider name is "stub" by design — it's NOT a real dsh-discovered route.

// dsh-llm 由本地安装解析（env DSH_ACP_DSH_LLM → 本仓 → dsh profile → 全局 dsh），
// 不在本文件写死任何机器路径。见 test/fixtures/resolve-dsh-llm.mjs。
import { loadDshLlm } from "./resolve-dsh-llm.mjs";
const { LlmAdapter } = await loadDshLlm();

const FIXTURE_TEXT = "hello from stub";

export class StubLlmAdapter extends LlmAdapter {
  /** dsh-llm calls this once per registered provider; keep id stable. */
  providerInfo(provider) {
    return { id: provider, name: "Spike Stub LLM" };
  }

  providerRetryPolicy(_provider) {
    return undefined;
  }

  imageRequestPricing() {
    return undefined;
  }

  async listModels(_provider) {
    return [
      {
        provider: "stub",
        id: "stub-model-1",
        name: "Stub Model 1",
      },
    ];
  }

  async resolveModel(provider, model, _signal) {
    return {
      provider,
      id: model,
      name: "Stub Model 1",
      context: { contextWindow: 8192 },
      defaultMaxTokens: 1024,
    };
  }

  async prepareCall(provider, model, _signal) {
    const resolved = await this.resolveModel(provider, model, _signal);
    return {
      model: resolved,
      // SDK contract: prepareCall.stream is the path agent-loop takes.
      // We delegate to `this.stream` so behavior stays in one place.
      stream: (options) => this.stream(options),
    };
  }

  /** The hot path: dsh-agent-loop calls this to get text chunks. */
  async *stream(_options) {
    yield { type: "block-start", index: 0, blockType: "text" };
    yield { type: "text-delta", index: 0, text: FIXTURE_TEXT };
    yield {
      type: "block-end",
      index: 0,
      block: { type: "text", text: FIXTURE_TEXT },
    };
    yield {
      type: "usage",
      usage: {
        inputTokens: 1,
        outputTokens: 1,
        totalTokens: 2,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      },
    };
    yield {
      type: "finish",
      reason: { kind: "stop" },
    };
  }
}

export const STUB_FIXTURE_TEXT = FIXTURE_TEXT;
export const STUB_PROVIDER = "stub";
export const STUB_MODEL = "stub-model-1";

// ---------------------------------------------------------------------------
// Tool-calling stub variant (#95 Session A).
//
// The base StubLlmAdapter deliberately emits NO `tool-call-delta` (S4a text-only).
// Session A's translation layer needs an agent loop that actually requests a
// tool, so we add a SEPARATE named export — the existing default exports above
// stay byte-for-byte unchanged, so the 5 files importing
// StubLlmAdapter/STUB_* /STUB_FIXTURE_TEXT keep passing without touching them.
//
// Shape parity: this mirrors the REAL QwenShenkeAdapter's chunk sequence for a
// tool round (deepseek adapter parity — verified against dsh-llm-deepseek).
// Block indexes: 0=reasoning, 1=text, tool blocks start at 2 (same as qwen).
//
//   turn 1 (model requests tool): reasoning block -> tool-call block
//     (block-start tool-call + tool-call-delta {id,name,argumentsDelta}, the
//      block-end {type:"tool-call",...} deferred to the finish marker)
//   turn 2 (after agent executes tool + feeds result back): reasoning -> text
//
// The agent loop resolves the tool SCHEMA from ctx.tools (registered by the
// test) and executes by name; the stub only needs to emit the tool-call block,
// it never sees the schema. The adapter is stateful (turns alternate) — a fresh
// instance per consumer via makeToolCallStub(), so tests stay isolated.
// ---------------------------------------------------------------------------

export const STUB_NOOP_TOOL_NAME = "get_cwd";
export const STUB_TOOL_CALL_ID = "tool-stub-call-1";
export const STUB_TOOL_AFTER_TEXT = "tool result received: { path: '/workspace' }";

/**
 * A tool-calling LlmAdapter for the Session A translation red test.
 * Deterministically alternates: call #1 emits a tool-call block (drives the
 * agent loop's official `tool_call` start + `tool_call_update` finish frames);
 * call #2 emits a text answer (drives the trailing agent_message_chunk).
 */
export class ToolCallStubAdapter extends LlmAdapter {
  constructor() {
    super();
    this._calls = 0;
  }

  providerInfo(provider) {
    return { id: provider, name: "Spike Tool-Call Stub LLM" };
  }
  providerRetryPolicy() {
    return undefined;
  }
  imageRequestPricing() {
    return undefined;
  }
  async listModels(provider) {
    return [{ provider, id: STUB_MODEL, name: "Stub Model 1" }];
  }
  async resolveModel(provider, model, _signal) {
    return {
      provider,
      id: model,
      name: "Stub Model 1",
      context: { contextWindow: 8192 },
      defaultMaxTokens: 1024,
    };
  }
  async prepareCall(provider, model, _signal) {
    const resolved = await this.resolveModel(provider, model, _signal);
    return { model: resolved, stream: (options) => this.stream(options) };
  }

  async *stream(_options) {
    this._calls += 1;
    // Turn 1: reasoning -> tool-call block (block-end deferred to finish). Turn
    // 2 (agent fed the tool result back): reasoning -> text answer. Any further
    // calls just repeat a text answer so the loop always terminates.
    if (this._calls === 1) {
      yield { type: "block-start", index: 0, blockType: "reasoning" };
      yield { type: "reasoning-delta", index: 0, text: "need cwd" };
      const toolIdx = 2;
      yield { type: "block-start", index: toolIdx, blockType: "tool-call" };
      yield {
        type: "tool-call-delta",
        index: toolIdx,
        id: STUB_TOOL_CALL_ID,
        name: STUB_NOOP_TOOL_NAME,
        argumentsDelta: "{}",
      };
      // Defer the tool block-end to the finish marker (deepseek parity).
      yield { type: "block-end", index: 0, block: { type: "reasoning", text: "need cwd" } };
      yield {
        type: "block-end",
        index: toolIdx,
        block: { type: "tool-call", id: STUB_TOOL_CALL_ID, name: STUB_NOOP_TOOL_NAME, arguments: "{}" },
      };
      yield { type: "usage", usage: { inputTokens: 5, outputTokens: 1, totalTokens: 6, cacheReadTokens: 0, cacheWriteTokens: 0 } };
      yield { type: "finish", reason: { kind: "stop" } };
      return;
    }
    // Turn 2+: text answer (reasoning block first, then text).
    yield { type: "block-start", index: 0, blockType: "reasoning" };
    yield { type: "reasoning-delta", index: 0, text: "answering" };
    yield { type: "block-end", index: 0, block: { type: "reasoning", text: "answering" } };
    yield { type: "block-start", index: 1, blockType: "text" };
    yield { type: "text-delta", index: 1, text: STUB_TOOL_AFTER_TEXT };
    yield { type: "block-end", index: 1, block: { type: "text", text: STUB_TOOL_AFTER_TEXT } };
    yield { type: "usage", usage: { inputTokens: 3, outputTokens: 1, totalTokens: 4, cacheReadTokens: 0, cacheWriteTokens: 0 } };
    yield { type: "finish", reason: { kind: "stop" } };
  }
}

/** Fresh ToolCallStubAdapter instance (per test/consumer, keeps turns isolated). */
export function makeToolCallStub() {
  return new ToolCallStubAdapter();
}

// The noop tool the test registers on ctx.tools so the agent loop can resolve
// the schema + execute the stub's `get_cwd` call. Mirrors NOOP_TOOL in the
// real-LLM tool test (output.schema object-rooted, render is a function).
export const STUB_NOOP_TOOL = {
  name: STUB_NOOP_TOOL_NAME,
  description: "Return the absolute current working directory path as a single string.",
  parameters: { type: "object", properties: {}, additionalProperties: false },
  output: {
    schema: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
      additionalProperties: false,
    },
    // F1 (2026-10-31): dsh-tools' ToolOutputDefinition.render contract is
    // `(args, value) => ContentBlock[]` (dsh-tools/lib/types/index.d.ts:110).
    // This used to return a bare string, so dsh-tools/lib/index.js:1454
    // (`result.content.some(...)`) threw "content.some is not a function" and
    // every tool call ended `status: "failed"` — the agent loop then retried
    // forever (900+ session/update frames per test). Must stay ContentBlock[].
    render: (_args, value) => [
      { type: "text", text: typeof value === "string" ? value : JSON.stringify(value) },
    ],
  },
  async execute() {
    return { path: "/workspace" };
  },
};

// ---------------------------------------------------------------------------
// Session B concurrency stub (#95 Session B).
//
// Unlike ToolCallStubAdapter (which keys its turn on a per-instance `_calls`
// counter — fine for one session, BROKEN when two sessions share one adapter
// instance), ConcurrentToolCallStubAdapter is safe under concurrency:
//
//   - turn decision is PER-CALL and driven by options.messages.length. The
//     agent loop passes the full accumulated conversation per turn:
//       turn 1 = 1 message (user)      → emit a tool-call block
//       turn 2 = 2+ (tool result fed back) → emit a text answer
//     No shared counter → two sessions' interleaved calls never collide.
//
//   - toolCallId is derived from the first user message text, so each session
//     (A vs B, distinct prompts) gets its OWN toolCallId — Session B asserts
//     idsA ∩ idsB = ∅ (no cross-talk). Deterministic, no randomness.
//
//   - every chunk is separated by `await this._scheduleTick()` (default
//     setImmediate, injectable via the constructor). This yields to the event
//     loop between chunks so two concurrently-pumped streams can actually
//     interleave — without it the test would be pseudoconcurrent (green but
//     sequencing, not parallelism, is what's under test).
// ---------------------------------------------------------------------------

const defaultTick = () => new Promise((resolve) => setImmediate(resolve));

/**
 * Concurrency-safe, schedulable tool-calling stub for the Session B isolation
 * red test. Single shared instance may be pumped by two sessions at once.
 *
 * @param {() => Promise<void>} [scheduleTick] - injected yield between chunks
 *        (defaults to setImmediate). Tests can pass a no-op to force a
 *        deterministic sequence, or leave it to observe true interleaving.
 */
export class ConcurrentToolCallStubAdapter extends LlmAdapter {
  constructor(scheduleTick = defaultTick) {
    super();
    this._scheduleTick = scheduleTick;
  }

  providerInfo(provider) {
    return { id: provider, name: "Spike Concurrent Tool-Call Stub" };
  }
  providerRetryPolicy() {
    return undefined;
  }
  imageRequestPricing() {
    return undefined;
  }
  async listModels(provider) {
    return [{ provider, id: STUB_MODEL, name: "Stub Model 1" }];
  }
  async resolveModel(provider, model, _signal) {
    return {
      provider,
      id: model,
      name: "Stub Model 1",
      context: { contextWindow: 8192 },
      defaultMaxTokens: 1024,
    };
  }
  async prepareCall(provider, model, _signal) {
    const resolved = await this.resolveModel(provider, model, _signal);
    return { model: resolved, stream: (options) => this.stream(options) };
  }

  async *stream(options) {
    const messages = options?.messages ?? [];
    // First user text distinguishes the session → per-session toolCallId.
    const firstText = firstUserText(messages);
    const toolCallId = `${firstText}-tool-1`;
    // EMPIRICAL (probed real apply() messages):
    //   turn-1 main ask   : len>=3, no tool-result  → tool turn
    //   title-gen call    : len===1 (only user)     → TEXT (never emit a tool!)
    //   post-tool turn    : has a content block {type:"tool-result"} → TEXT
    // A shared-counter (Session A) approach breaks under concurrency, and a
    // naive "len<2" approach misfires both on turn-1 (len=4) and the title-gen
    // call (len=1). So: tool turn iff len>1 AND no tool-result block present.
    // F2 (2026-10-31): dsh feeds tool output back as a `role: "tool"` message
    // whose content blocks are plain `{type:"text"}`, NOT `{type:"tool-result"}`
    // (verified with an [MSGS] probe: len grows 6→8→11→13, each pair being
    // `{role:"assistant",content:["reasoning","tool-call"]}` + `{role:"tool",
    // content:["text"]}`). Without the role check `hasToolResult` never fired,
    // so `isToolTurn` stayed true on every turn and the loop retried forever.
    // Keep the legacy `tool-result` block check for older/other message shapes.
    const hasToolResult = messages.some(
      (m) =>
        m?.role === "tool" ||
        (Array.isArray(m?.content) && m.content.some((p) => p?.type === "tool-result")),
    );
    const isToolTurn = messages.length > 1 && !hasToolResult;

    await this._scheduleTick();
    yield { type: "block-start", index: 0, blockType: "reasoning" };
    yield { type: "reasoning-delta", index: 0, text: isToolTurn ? "need cwd" : "answering" };
    await this._scheduleTick();
    yield { type: "block-end", index: 0, block: { type: "reasoning", text: isToolTurn ? "need cwd" : "answering" } };

    if (isToolTurn) {
      const toolIdx = 2;
      await this._scheduleTick();
      yield { type: "block-start", index: toolIdx, blockType: "tool-call" };
      yield {
        type: "tool-call-delta",
        index: toolIdx,
        id: toolCallId,
        name: STUB_NOOP_TOOL_NAME,
        argumentsDelta: "{}",
      };
      await this._scheduleTick();
      yield {
        type: "block-end",
        index: toolIdx,
        block: { type: "tool-call", id: toolCallId, name: STUB_NOOP_TOOL_NAME, arguments: "{}" },
      };
    } else {
      await this._scheduleTick();
      yield { type: "block-start", index: 1, blockType: "text" };
      yield { type: "text-delta", index: 1, text: STUB_TOOL_AFTER_TEXT };
      await this._scheduleTick();
      yield { type: "block-end", index: 1, block: { type: "text", text: STUB_TOOL_AFTER_TEXT } };
    }

    yield { type: "usage", usage: { inputTokens: 4, outputTokens: 1, totalTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 } };
    await this._scheduleTick();
    yield { type: "finish", reason: { kind: "stop" } };
  }
}

/** Fresh ConcurrentToolCallStubAdapter (default setImmediate scheduling). */
export function makeConcurrentToolCallStub() {
  return new ConcurrentToolCallStubAdapter();
}

/** Extract the first user text from dsh messages ([{role,content:[{type,text}]}]). */
function firstUserText(messages) {
  for (const m of messages ?? []) {
    if (m?.role === "user") {
      const c = m?.content;
      if (Array.isArray(c)) {
        const t = c.find((p) => p?.type === "text" && typeof p.text === "string");
        if (t) return t.text;
      } else if (typeof c === "string") {
        return c;
      }
    }
  }
  return "session";
}

// ---------------------------------------------------------------------------
// Session C (#95) failing stub — drives the error-propagation red test.
//
// A provider that fails CONDITIONALLY on the FIRST TURN's user text containing
// "boom": stream() throws, so a prompt whose text says "boom" errors mid-turn
// while another prompt on the SAME provider (no "boom") succeeds. This lets
// Session C C1 (error propagation) drive ONE shared router with two sessions —
// A fails, B succeeds — to prove A's error doesn't poison B.
//
// Registered under a SEPARATE provider name (FAIL_PROVIDER) so the SAME ctx can
// host both this and the healthy STUB_PROVIDER if a test needs both.
// ---------------------------------------------------------------------------

export const FAIL_PROVIDER = "fail";
export const FAIL_MODEL = "fail-model";

export class FailingLlmAdapter extends StubLlmAdapter {
  providerInfo(provider) {
    return { id: provider, name: "Conditional-Fail Stub LLM" };
  }
  async *stream(options) {
    const text = firstUserText(options?.messages ?? []);
    if (/boom/i.test(text)) throw new Error("boom: Session C failing adapter");
    yield *super.stream(options);
  }
}

/** Fresh FailingLlmAdapter (state-free — safe to share). */
export function makeFailingStub() {
  return new FailingLlmAdapter();
}

// ---------------------------------------------------------------------------
// #100 spike: SlowToolCallStub — a stub that DELIBERATELY prolongs the turn so
// two independent subprocess apply() runs get a wall-clock window to overlap.
// __delay_ticks (default 30) async setImmediate hops ≈ a few ms — enough to
// stretch a turn without making the spike hang.

export const SLOW_PROVIDER = "slow";
export const SLOW_MODEL = "slow-model-1";

export class SlowToolCallStub extends StubLlmAdapter {
  constructor(delayTicks = 30) {
    super();
    this.delayTicks = delayTicks;
  }
  providerInfo(provider) {
    return { id: provider, name: "Slow Spike Stub LLM" };
  }
  async *stream(options) {
    // Stretch the turn: N "async no-op" ticks so the run's wall-clock is long
    // enough to reveal overlap with a sibling process.
    for (let i = 0; i < this.delayTicks; i++) await new Promise((r) => setImmediate(r));
    yield *super.stream(options);
  }
}

/** Fresh SlowToolCallStub (state-free — safe to share). */
export function makeSlowToolCallStub(delayTicks) {
  return new SlowToolCallStub(delayTicks);
}

