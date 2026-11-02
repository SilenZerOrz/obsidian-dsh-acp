// test/fixtures/qwen-shenke-adapter.mjs — REAL OpenAI-compatible LlmAdapter for #96.
//
// ⚠️ 复用者注意（G-N6c）：本适配器的端点、模型名与密钥**全部来自你本机 dsh 配置**
//   （见同目录 `local-llm-config.mjs` 的解析规则；env `DSH_ACP_REAL_LLM_*` 优先级最高）。
//   换环境时请改本机 profile 配置或用 env 覆盖，**不要**在本文件里写死端点或模型名。
//
// #96 (第二刀副线) drives the SAME real reasoning LLM through BOTH the legacy
// (LongRuntime → ctx.llm.stream → chunk-mapper) and official (apply() → dsh
// agent loop) event producers, so we can empirically confirm the field-alignment
// assumption the #95 router depends on. The stub (spike-llm-stub.mjs) can't
// produce real `agent_thought_chunk` (it never emits reasoning deltas); this
// adapter maps a real reasoning model's OpenAI-compatible stream (which DOES
// carry `reasoning_content`) onto dsh's StreamChunk contract.
//
// SECURITY: the API key is read ONLY from env (never from a project .env, never
// imported, never logged). This file ships with ZERO secrets. When no key is
// available the consumer is expected to skip, not to fail.
//
// CONFIG / DEFAULT VALUES: **nothing is hardcoded here**. Resolution order for
// base / model / key (see qwenRealConfig()):
//   1. explicit env override:
//        DSH_ACP_REAL_LLM_BASE_URL | DSH_ACP_REAL_LLM_BASE — endpoint root (/v1 included)
//        DSH_ACP_REAL_LLM_MODEL                            — model id
//        DSH_ACP_REAL_LLM_KEY                              — bearer key (env only)
//   2. the local dsh profile's `cordis.patch.yml` (`llm-pi-ai` providers +
//      `agent-default-model`) — resolved at runtime, never copied into the repo.
//      The apiKeyEnv NAME comes from that file; the key VALUE comes from env.
//   3. neither ⇒ returns undefined ⇒ callers skip (qwenRealEnabled() is false).
//
// Provider id "qwen-shenke" is a test-local route (like stub), registered on
// the booted ctx via ctx.llm.registerAdapter before apply()/long-runtime use it.

import { loadDshLlm } from "./resolve-dsh-llm.mjs";
import { readLocalLlmConfig } from "./local-llm-config.mjs";

const { LlmAdapter } = await loadDshLlm();

export const QWEN_REAL_PROVIDER = "qwen-shenke";

/**
 * Resolve provider config: env override → local dsh profile config → undefined.
 *
 * Returns `{ base, model, key, apiKeyEnv?, profile? }` or `undefined` when no
 * usable source exists (caller must skip). Never throws.
 *
 * @param {NodeJS.ProcessEnv} [env]
 */
export function qwenRealConfig(env = process.env) {
  const envBase = env.DSH_ACP_REAL_LLM_BASE_URL || env.DSH_ACP_REAL_LLM_BASE;
  const envModel = env.DSH_ACP_REAL_LLM_MODEL;
  const envKey = env.DSH_ACP_REAL_LLM_KEY;
  if (envBase && envModel) {
    return { base: envBase, model: envModel, key: envKey, source: "env" };
  }

  // Local profile config (read-only; never copied into the repo).
  let local = null;
  try { local = readLocalLlmConfig({ env }); } catch { local = null; }
  if (!local) {
    // env partially set but incomplete, and no local config ⇒ unusable
    return undefined;
  }

  const key = envKey || (local.apiKeyEnv ? env[local.apiKeyEnv] : undefined);
  return {
    base: envBase || local.base,
    model: envModel || local.model,
    key,
    apiKeyEnv: local.apiKeyEnv ?? undefined,
    profile: local.profile,
    source: envBase || envModel ? "env+local" : "local",
  };
}

/** True when a usable real-LLM key is available (env-gating). */
export function qwenRealEnabled(env = process.env) {
  const cfg = qwenRealConfig(env);
  return !!cfg && typeof cfg.key === "string" && cfg.key.length > 0;
}

/**
 * Real reasoning model via an OpenAI-compatible chat/completions SSE endpoint.
 * Maps `delta.reasoning_content` → reasoning block (→ agent_thought_chunk) and
 * `delta.content` → text block (→ agent_message_chunk), mirroring the stub's
 * block/delta/finish chunk shape so dsh's plumbing (both producers) accepts it.
 */
export class QwenShenkeAdapter extends LlmAdapter {
  constructor(config = {}) {
    super();
    this.config = { ...(qwenRealConfig() ?? {}), ...config };
  }

  providerInfo(provider) {
    return { id: provider, name: "Real reasoning model (local profile config)" };
  }

  providerRetryPolicy() {
    return undefined;
  }

  imageRequestPricing() {
    return undefined;
  }

  async listModels(provider) {
    return [{ provider, id: this.config.model, name: this.config.model }];
  }

  async resolveModel(provider, model, _signal) {
    return {
      provider,
      id: model,
      name: this.config.model,
      context: { contextWindow: 32768 },
      defaultMaxTokens: 8192,
    };
  }

  async prepareCall(provider, model, signal) {
    const resolved = await this.resolveModel(provider, model, signal);
    return { model: resolved, stream: (options) => this.stream(options) };
  }

  /** The hot path — called by BOTH legacy ctx.llm.stream() and the official agent loop. */
  async *stream(options) {
    const { base, model, key } = this.config;
    if (!key) throw new Error("QwenShenkeAdapter: no DSH_ACP_REAL_LLM_KEY set");
    const messages = (options?.messages ?? []).map(toOpenAiMessage);
    // Forward tool schemas (dsh format {name, description, parameters}) onto the
    // OpenAI wire as `tools`, exactly mirroring dsh-llm-deepseek (index.js:228-244).
    const tools = options?.tools?.map((tool) => ({
      type: "function",
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      },
    }));
    const controller = new AbortController();
    const link = () => controller.abort();
    const signal = options?.signal;
    if (signal) {
      if (signal.aborted) controller.abort();
      else signal.addEventListener("abort", link, { once: true });
    }
    try {
      const res = await fetch(`${base}/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${key}`,
        },
        body: JSON.stringify({
          model,
          messages,
          stream: true,
          // The routed model is a reasoning model; keep the reply short so the
          // smoke turn completes quickly while still emitting real reasoning deltas.
          max_tokens: 512,
          ...(tools !== void 0 && tools.length > 0 ? { tools } : {}),
        }),
        signal: controller.signal,
      });
      if (!res.ok || !res.body) {
        const detail = await res.text().catch(() => "");
        throw new Error(`Qwen chat/completions HTTP ${res.status}: ${detail.slice(0, 200)}`);
      }

      // Stream indexes: 0 = reasoning block, 1 = text block.
      let idx0started = false;
      let idx0ended = false;
      let idx1started = false;
      let reasoningBuf = "";
      let textBuf = "";
      // Tool blocks per wire `call.index`, block-ends deferred to finish
      // (mirrors dsh-llm-deepseek translate$1: tool identity arrives on the
      // first delta; the tool-call block-end is emitted only at [DONE]).
      const toolBlocks = new Map();
      const toolOrder = [];
      let ncalls = 2; // next available index for tool blocks

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let sseBuf = "";

      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        sseBuf += decoder.decode(value, { stream: true });
        let nl;
        while ((nl = sseBuf.indexOf("\n")) >= 0) {
          const line = sseBuf.slice(0, nl).trim();
          sseBuf = sseBuf.slice(nl + 1);
          if (!line.startsWith("data:")) continue;
          const data = line.slice(5).trim();
          if (data === "[DONE]") continue;
          let msg;
          try { msg = JSON.parse(data); } catch { continue; }
          const choice = msg?.choices?.[0];
          if (!choice) continue;
          const delta = choice.delta ?? {};
          const finish = choice.finish_reason;

          if (typeof delta.reasoning_content === "string" && delta.reasoning_content.length > 0) {
            if (!idx0started) {
              yield { type: "block-start", index: 0, blockType: "reasoning" };
              idx0started = true;
            }
            reasoningBuf += delta.reasoning_content;
            yield { type: "reasoning-delta", index: 0, text: delta.reasoning_content };
          }
          if (typeof delta.content === "string" && delta.content.length > 0) {
            if (!idx1started) {
              // Close the reasoning block first so block order is clean.
              if (idx0started && !idx0ended) {
                yield { type: "block-end", index: 0, block: { type: "reasoning", text: reasoningBuf } };
                idx0ended = true;
              }
              yield { type: "block-start", index: 1, blockType: "text" };
              idx1started = true;
            }
            textBuf += delta.content;
            yield { type: "text-delta", index: 1, text: delta.content };
          }
          // OpenAI-compatible `tool_calls` deltas → one dsh tool-call block per
          // wire index (identity: id + name, accumulate `arguments` across deltas).
          for (const call of delta.tool_calls ?? []) {
            let block = toolBlocks.get(call.index);
            if (!block) {
              block = { index: ncalls++, id: "", name: "", args: "" };
              toolBlocks.set(call.index, block);
              toolOrder.push(block);
              yield { type: "block-start", index: block.index, blockType: "tool-call" };
            }
            if (typeof call.id === "string" && call.id.length > 0) block.id = call.id;
            if (typeof call.function?.name === "string" && call.function.name.length > 0) block.name = call.function.name;
            const fragment = call.function?.arguments ?? "";
            block.args += fragment;
            yield {
              type: "tool-call-delta",
              index: block.index,
              id: block.id,
              ...(block.name ? { name: block.name } : {}),
              argumentsDelta: fragment,
            };
          }

          if (finish) {
            if (idx0started && !idx0ended) {
              yield { type: "block-end", index: 0, block: { type: "reasoning", text: reasoningBuf } };
              idx0ended = true;
            }
            if (idx1started) {
              yield { type: "block-end", index: 1, block: { type: "text", text: textBuf } };
            }
            yield* closeToolBlocks(toolOrder); // tool block-ends deferred to finish (deepseek parity)
            const usage = msg?.usage;
            if (usage) {
              yield {
                type: "usage",
                usage: {
                  inputTokens: usage.prompt_tokens ?? 0,
                  outputTokens: usage.completion_tokens ?? 0,
                  totalTokens: usage.total_tokens ?? 0,
                  cacheReadTokens: 0,
                  cacheWriteTokens: 0,
                },
              };
            }
            const kind = finish === "length" ? "max-tokens" : finish === "content_filter" ? "refusal" : "stop";
            yield { type: "finish", reason: { kind } };
            return;
          }
        }
      }
      // Stream ended without an explicit finish — synthesize one so the turn
      // always reaches a terminal chunk.
      if (idx0started && !idx0ended) {
        yield { type: "block-end", index: 0, block: { type: "reasoning", text: reasoningBuf } };
      }
      if (idx1started) {
        yield { type: "block-end", index: 1, block: { type: "text", text: textBuf } };
      }
      yield* closeToolBlocks(toolOrder);
      yield { type: "finish", reason: { kind: "stop" } };
    } finally {
      if (signal) signal.removeEventListener("abort", link);
    }
  }
}

/** Emit each accumulated tool-call block's deferred block-end (in order). */
function* closeToolBlocks(toolOrder) {
  for (const b of toolOrder) {
    yield {
      type: "block-end",
      index: b.index,
      block: { type: "tool-call", id: b.id, name: b.name ?? "", arguments: b.args },
    };
  }
}

/** Map dsh message format ({role, content:[{type,text}]}) → OpenAI string-content message. */
function toOpenAiMessage(m) {
  const role = m?.role ?? "user";
  let content = m?.content;
  if (Array.isArray(content)) {
    content = content
      .filter((p) => p?.type === "text" && typeof p.text === "string")
      .map((p) => p.text)
      .join("\n");
  }
  if (typeof content !== "string") content = "";
  return { role, content };
}
