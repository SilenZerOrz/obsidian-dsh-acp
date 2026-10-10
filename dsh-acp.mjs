#!/usr/bin/env node
// dsh-acp: ACP (Agent Client Protocol) adapter for DeepSeek Harness.
//
// Speaks ACP v1 over stdin/stdout (newline-delimited JSON-RPC). Each prompt
// turn is executed by spawning `dsh --profile headless "<prompt>"` (a fresh
// one-shot DSH task per turn). Output is streamed back to the ACP client as
// agent_message_chunk updates, then a final result (`end_turn`) is returned.
//
// ACP clients can drive this adapter exactly like they drive claude-agent-acp;
// Obsidian's "Agent Client" plugin is a supported client. The cordis plugin in
// this package also provides a `dsh.acp` service to manage this process.
//
// Session features (beyond the stateless baseline):
//   - Persistent session list (survives adapter restarts, so Obsidian's
//     "reload session list" shows real, durable sessions).
//   - session/fork — branch a new session from an existing one.
//   - session/resume + session/load — reopen an archived session.
//   - Each completed turn is mirrored into a DSH official archive under
//     <DSH_HOME>/sessions/<encoded-cwd>/session-<id>/session.jsonl so DSH web's
//     own conversation archive can read the ACP sessions back.

import { agent as acpAgent, methods, ndJsonStream, RequestError } from "@agentclientprotocol/sdk";
import { z as zod } from "zod";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { StringDecoder } from "node:string_decoder";
import {
  allSessions,
  createSession,
  ensureSession,
  getSession,
  forkSession,
  deleteSession as storeDelete,
  recordMessage,
  scanArchives,
  flushPersist,
  updateSessionMeta,
} from "./archive-store.mjs";
import { gcBeforeList, detectObsidianSessionsDirs, runGC } from "./gc.mjs";
import { resolveRuntimeMode, resolvePermissionConfig } from "./lib/runtime-switch.mjs";
import { detectDshBinary, resolveDshSpawnSpec } from "./doctor.mjs";
import { loadProviderCatalog } from "./lib/settings-provider-catalog.mjs";
import { validateCwd } from "./lib/cwd-validator.mjs";
import { hasHeadlessJson } from "./lib/version-detect.mjs";
import { readProfileDefaultModel } from "./lib/http-gateway.mjs";
import { PERMISSION_MODES } from "./lib/permission-gate.mjs";
import { createHeadlessParser } from "./lib/headless-json-parser.mjs";
import { createUpdateTranslator } from "./lib/acp-tool-translation.mjs";
import {
  probeDshWebGateway,
  forwardPromptViaHttp,
  shouldAttemptProxy,
  getProxyBaseUrl as _getProxyBaseUrl,
} from "./lib/proxy-mode.mjs";

// ---- Permissive params schemas (ACP SDK compatibility) --------------------
// The @agentclientprotocol/sdk 1.4.0 strict Zod schema for session/new +
// session/load REQUIRES `mcpServers: zMcpServer[]` even though the protocol
// says clients SHOULD send it (not MUST) and most clients (including
// Obsidian Agent Client as of 2026-09-18) omit it. The strict schema makes
// the SDK reject every session/new with:
//   "Invalid params: mcpServers Required value is missing"
// BEFORE the handler runs — the user-visible symptom is the Obsidian UI
// shows nothing happening after initialize (no sessionId, no prompts work,
// the chat input stays disabled).
//
// Fix: register each ACP request handler with a custom permissive params
// schema via `.request({ method, params: <zod> }, handler)` instead of the
// default `.onRequest(method, handler)` shorthand. The permissive schema
// only enforces `cwd: string` and lets everything else (mcpServers, _meta,
// additionalDirectories) be optional / default to empty.
//
// The `passThrough = zod.object({}).passthrough()` keeps unknown fields
// intact so downstream handlers still see them.

const passThrough = zod.object({}).passthrough();
const permissiveString = zod.string().optional();

/** Permissive session/new params — only `cwd` required, `mcpServers` defaults to []. */
const permissiveNewSession = zod.object({
  cwd: zod.string(),
  mcpServers: zod.array(passThrough).optional().default([]),
  additionalDirectories: zod.array(zod.string()).optional().default([]),
  _meta: passThrough.optional(),
}).passthrough();

/** Permissive session/load params — only `sessionId` + `cwd` required. */
const permissiveLoadSession = zod.object({
  sessionId: zod.string(),
  cwd: zod.string(),
  mcpServers: zod.array(passThrough).optional().default([]),
  additionalDirectories: zod.array(zod.string()).optional().default([]),
  _meta: passThrough.optional(),
}).passthrough();

/** Permissive session/prompt params — only `sessionId` + `prompt` required. */
const permissivePrompt = zod.object({
  sessionId: zod.string(),
  prompt: zod.union([zod.string(), zod.array(passThrough), passThrough]).optional(),
  _meta: passThrough.optional(),
}).passthrough();

/** Permissive setConfigOption params — only `sessionId` + `configId` + `value` required. */
const permissiveSetConfigOption = zod.object({
  sessionId: zod.string(),
  configId: zod.string(),
  value: zod.union([zod.string(), zod.number(), zod.boolean(), passThrough]).optional(),
  _meta: passThrough.optional(),
}).passthrough();

/** Permissive setMode params. */
const permissiveSetMode = zod.object({
  sessionId: zod.string(),
  modeId: zod.string(),
  _meta: passThrough.optional(),
}).passthrough();

/** Permissive authenticate / logout — accept any object. */
const permissiveAuth = passThrough;

/** Permissive listSessions / fork / resume / close / cancel — accept any object. */
const permissiveAny = passThrough;

// ---- Configuration -------------------------------------------------------
// `dsh --profile headless` runs the backend. GUI ACP clients (Obsidian) inherit
// a minimal environment that usually does NOT include shell PATH additions, so
// the plugin and the Obsidian custom-agent `env` should set DSH_BIN explicitly.
// DSH_BIN 定位与 Windows .cmd 垫片兼容（npm 全局安装的 dsh 无法被 Node 直接
// spawn：裸名 ENOENT、.cmd EINVAL）统一实现在 doctor.mjs：
//   detectDshBinary()      → 二进制/垫片路径
//   resolveDshSpawnSpec()  → { cmd, prefixArgs }，Windows 下解析垫片内的 JS
//                            入口并改用 process.execPath 直连拉起
import { mkdtempSync, existsSync, statSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, join as joinPath } from "node:path";

const DSH_BIN = detectDshBinary();
const DSH_SPAWN = resolveDshSpawnSpec(DSH_BIN);
/**
 * t51：prompt-spawn 的目标 profile。
 *
 * ⚠️ **不读 `DSH_PROFILE`** —— 那是给 dsh CLI / 其他组件（见 index.mjs、http-gateway、
 * doctor、runtime-switch）用的**外部**约定；dsh-acp 的 prompt-spawn 是**内部行为**，
 * 必须自己决定用哪个 profile。
 *
 * 用户 2026-10-10 拍板三条原则：
 *   ① 不读 DSH_PROFILE；
 *   ② 默认 `headless`（**prompt-capable**：`web` 是服务端 profile，
 *      `dsh --profile web "<prompt>"` 会带 `--json` 报 `unknown option '--json'`、
 *      不带则报 `too many arguments. Expected 0 arguments but got 1` ——
 *      同一缺陷两副面孔，且会导致 **LLM 从未真正跑起来 → 无内容可归档 →
 *      表象为「多轮无记忆」**）；
 *   ③ **不自动回退** —— 黑盒回退逻辑会引入难查的 bug；显式优先 + WARN 更稳。
 *
 * 覆盖方式：`DSH_ACP_SPAWN_PROFILE=<profile>`。
 */
const SPAWN_PROFILE = process.env.DSH_ACP_SPAWN_PROFILE || "headless";

// 显式告知：DSH_PROFILE 存在且与 spawnProfile 不同 ⇒ 对 prompt-spawn 无效（不是错误，是 NOTE）。
if (process.env.DSH_PROFILE && process.env.DSH_PROFILE !== SPAWN_PROFILE) {
  process.stderr.write(
    `[dsh-acp] NOTE: DSH_PROFILE=${process.env.DSH_PROFILE} ignored for ` +
    `prompt-spawn; using spawnProfile=${SPAWN_PROFILE}. ` +
    `Override with DSH_ACP_SPAWN_PROFILE.\n`,
  );
}

const DSH_EXTRA_ARGS = (process.env.DSH_ARGS ?? "").split(" ").filter(Boolean);

function dshBaseArgs() {
  return ["--profile", SPAWN_PROFILE, ...DSH_EXTRA_ARGS];
}

// ---- Logging -------------------------------------------------------------
// stdout is reserved for ACP protocol messages; everything else -> stderr.
const logDir = process.env.DSH_ACP_LOG_DIR;
let logFile = null;
if (logDir) {
  const { mkdirSync, appendFileSync, statSync, renameSync, rmSync } = await import("node:fs");
  const { join } = await import("node:path");
  try {
    mkdirSync(logDir, { recursive: true });
    logFile = join(logDir, "dsh-acp.log");
    // Size-capped, rolling logs (REQ-10): when dsh-acp.log exceeds
    // LOG_MAX_BYTES we rotate it to .1 / .2 … (up to LOG_KEEP) and start fresh,
    // so a long-running adapter never writes a single unbounded file forever.
    const LOG_MAX_BYTES = Number(process.env.DSH_ACP_LOG_MAX_BYTES ?? 5 * 1024 * 1024);
    const LOG_KEEP = Number(process.env.DSH_ACP_LOG_KEEP ?? 2);

    function rotateIfNeeded() {
      let size = 0;
      try { size = statSync(logFile).size; } catch { return; } // no file yet
      if (size < LOG_MAX_BYTES) return;
      // Shift existing rotated files one slot up (.2 -> .3, .1 -> .2), then
      // move the over-limit file to .1, and finally drop anything beyond
      // LOG_KEEP (so at most LOG_KEEP rotated files are kept).
      for (let i = LOG_KEEP; i >= 1; i--) {
        try { renameSync(`${logFile}.${i}`, `${logFile}.${i + 1}`); } catch { /* slot empty */ }
      }
      try { renameSync(logFile, `${logFile}.1`); } catch {}
      try { rmSync(`${logFile}.${LOG_KEEP + 1}`, { force: true }); } catch {}
    }

    const write = (...args) => {
      try {
        rotateIfNeeded();
        appendFileSync(logFile, `${new Date().toISOString()} pid=${process.pid} ${args.map(String).join(" ")}\n`);
      } catch {}
    };
    console.log = write;
    console.error = write;
    console.info = write;
    console.warn = write;
    console.debug = write;
  } catch (err) {
    console.error("dsh-acp: failed to init log file", err);
  }
}

// ---- Running DSH ---------------------------------------------------------
// Per-invocation model override via a disposable `--patch` overlay: dsh's patch
// format lets us re-target `agent-default-model` (provider+model) for THIS
// process only. The temp patch file is written to the OS temp dir, used by
// exactly one `dsh --profile headless` invocation, and removed afterwards — so
// per-session model switching never mutates the user's shared profile settings.
// FEAT (FE-1): the default provider used when a `provider/model` session value
// is missing its provider part. Mirrors the headless profile's `agent-default-model`.
// t38: 不再兜硬编码 "jl-token" —— env 缺失时为 null，交由 gateway/profile 决定，
// 避免与 profile 实际注册的 provider 名错配（NO_ADAPTER → 静默 cancelled）。
const DEFAULT_PROVIDER =
  process.env.DSH_ACP_DEFAULT_PROVIDER ||
  process.env.DSH_ACP_DEFAULT_MODEL?.split("/")[0] ||
  null;

/**
 * Split a `provider/model` combination (the flattened value we store on the
 * session and expose in the dropdown) into its parts. A bare model id (legacy
 * sessions) resolves to the default provider, matching how `agent-default-model`
 * is patched for a provider-less override.
 */
/** t38: 默认模型 id —— env → profile（agent-default-model）→ 原硬编码兜底。 */
function resolveDshAcpDefaultModelId() {
  if (process.env.DSH_ACP_DEFAULT_MODEL) return process.env.DSH_ACP_DEFAULT_MODEL;
  const p = readProfileDefaultModel();
  if (p) return `${p.provider}/${p.model}`;
  if (process.env.DSH_ACP_FALLBACK_MODEL) return process.env.DSH_ACP_FALLBACK_MODEL;
  process.stderr.write(
    "[dsh-acp] WARN: no DSH_ACP_DEFAULT_MODEL env, profile unreadable; " +
      "falling back to tool-capable default - provider name may mismatch -> NO_ADAPTER\n",
  );
  return "jl-token/gemini-2.5-pro"; // 805d20c: tool-capable 兜底
}

/** t44: per-session 历史上限（防 prompt 无界增长 / 防内存泄漏）。 */
// NOTE (0.3.4 known gap): HISTORY_MAX caps COUNT (100), not LENGTH.
// A single very long message can still blow the context window.
// Token/char budget deferred to 0.3.4 (see 0.3.3-整合开发计划 §0.3.4 种子).
const HISTORY_MAX = 100;

/**
 * t44 多轮记忆（第 1 层）：取某 session 的历史，供 proxy 转发时上行。
 *
 * ⚠️ 复用而非新建：`archive-store` 早已维护**持久**的 per-session 消息表
 * （`recordMessage()` → `rec.messages.push({role,text,at})` + 写 DSH archive），
 * 且 `getSession()` 已在 dsh-acp.mjs 顶部导入。故本函数只做「读取 + 裁剪 + 换形」，
 * 不另建 `Map`——避免出现两份会互相漂移的消息存储（沿 t42「中间透传层」教训）。
 * 追加与清理也由既有设施承担：追加=recordMessage，清理=deleteSession（删记录即清正）。
 *
 * 返回形状 `{role, content}[]`：`long-runtime` 的 `normalizeMessage` 接受的正是它。
 * 只取最近 HISTORY_MAX 条（在**读取侧**设上限，等价于写侧设上限的效果）。
 */
function getHistory(sessionId) {
  try {
    const rec = getSession(sessionId);
    const all = Array.isArray(rec?.messages) ? rec.messages : [];
    return all
      .slice(-HISTORY_MAX)
      .filter((m) => m && typeof m.text === "string" && m.text.length > 0
        && (m.role === "user" || m.role === "assistant"))
      .map((m) => ({
        role: m.role,
        content: m.text,
        // t46: 宿主 LlmRuntime.forAdapter() 对 **assistant** 条目会**无条件**取
        // `message.source` 再读 `source.replayState`
        //   （@deepseek-ai/dsh-llm/lib/index.js:2236-2241：
        //      if (message.role !== "assistant") return message;
        //      const source = message.source;
        //      if (source.replayState === void 0) return message;  ← 缺 source 即在此抛）
        // 缺 source ⇒ turn 2 崩溃「Cannot read properties of undefined (reading 'replayState')」。
        // 最小充分结构：只要 source 是对象且**不带** replayState 即走 early-return 原样放行；
        // host 自身的规范形状也是 { kind: "model", provider, model }——此处取最小子集 {kind:"model"}。
        // user 条目不补：host 对非 assistant 立即 return，不需要该字段。
        ...(m.role === "assistant" ? { source: { kind: "model" } } : {}),
      }));
  } catch {
    return [];
  }
}

function splitModel(combo) {
  if (!combo || typeof combo !== "string") return { provider: DEFAULT_PROVIDER, model: undefined };
  const idx = combo.indexOf("/");
  if (idx === -1) return { provider: DEFAULT_PROVIDER, model: combo };
  return { provider: combo.slice(0, idx), model: combo.slice(idx + 1) };
}

function modelPatchArgs(model, provider) {
  const dir = mkdtempSync(joinPath(tmpdir(), "dsh-acp-model-"));
  const file = joinPath(dir, "model.patch.yml");
  const prov = provider || DEFAULT_PROVIDER;
  writeFileSync(file, [
    `- id: agent-default-model`,
    `  name: '@deepseek-ai/dsh-agent-default-model'`,
    `  config:`,
    // t38: provider 为 null 时不写出 provider 行（不要产出 `provider: undefined/`），
    // 让该 patch 继承 dsh 自身的 agent-default-model，保持生成物是合法 YAML。
    ...(prov ? [`    provider: ${prov}`] : []),
    `    model: ${model}`,
    ``,
  ].join("\n"));
  return { file, cleanup: () => { try { rmSync(dir, { recursive: true, force: true }); } catch {} } };
}

/**
 * t50：`--json` 失败兜底。
 *
 * 背景（t49/t50 实测）：`hasHeadlessJson()` 现在会**真实试跑** `dsh --profile <p> --json --help`
 * 并要求 exit 0 —— 该探测在多数环境返回 true；但**真实调用**是
 * `dsh --profile <p> --json <prompt>`（带位置参数），在部分环境会被 dsh 以
 * `error: unknown option '--json'` 拒绝。即「--help 能过」不等于「带 prompt 也能过」。
 *
 * 故此处兜底：当 dsh **因 --json 被拒**而失败时，**去掉 --json 重试一次**。
 *
 * ⚠️ 守卫很窄：只匹配 `unknown option '--json'` —— 这是 **参数解析阶段**的失败，
 * 此时还没有任何模型输出被流式送出，故重试不会造成重复输出。
 */
async function runDsh(prompt, cwd, onChunk, signal, modelOverride, onFrame) {
  try {
    return await runDshInner(prompt, cwd, onChunk, signal, modelOverride, onFrame, false);
  } catch (e) {
    const msg = e && e.message ? String(e.message) : "";
    if (!/unknown option '--json'/.test(msg)) throw e;
    process.stderr.write("[dsh-acp] dsh rejected --json; retrying once without it\n");
    return await runDshInner(prompt, cwd, onChunk, signal, modelOverride, onFrame, true);
  }
}

function runDshInner(prompt, cwd, onChunk, signal, modelOverride, onFrame, forceNoJson = false) {
  // 0.3.0 工具帧修复 (Path A): when dsh supports `--json`, drive stdout
  // through createHeadlessParser + createUpdateTranslator and forward each
  // legacy-shaped session/update to `onFrame`. dsh < 0.1.7-rc.1 lacks the
  // flag — fall back to plain-text forwarding via `onChunk` so old installs
  // keep working unchanged. See v2 plan §5.5.
  //
  // Env override `DSH_ACP_NO_HEADLESS_JSON=1` forces the plain-text path
  // even when --json is available (escape hatch for callers who want the
  // pre-0.3.0 behavior).
  // t50: forceNoJson 为 --json 被拒后的重试路径，强制走纯文本模式。
  const useStructured = !forceNoJson && hasHeadlessJson() && !process.env.DSH_ACP_NO_HEADLESS_JSON;
  return new Promise((resolve, reject) => {
    const args = [...dshBaseArgs(), prompt];
    // When a per-session model is chosen (and differs from the default we
    // leave to dsh), add a disposable patch overlay that pins agent-default-model.
    let patchInfo = null;
    if (modelOverride) {
      // modelOverride carries a `provider/model` value (FE-1). Split so the
      // disposable agent-default-model patch targets the right provider too,
      // not just the model.
      const { provider, model } = splitModel(modelOverride);
      patchInfo = modelPatchArgs(model, provider);
      args.splice(args.length - 1, 0, "--patch", patchInfo.file);
    }
    if (useStructured) {
      // Splice --json BEFORE the prompt positional arg (consistent with
      // where --patch is spliced — both flags precede the prompt).
      args.splice(args.length - 1, 0, "--json");
    }
    const effectiveCwd = cwd || process.cwd();
    // Bug B (2026-09-19, #63): pre-validate cwd so spawn doesn't fail with a
    // cryptic Node ENOENT/ENOTDIR/EACCES when the ACP client passes a stale
    // savedSession cwd (e.g. /Users/admin/... after a rename). Throw a clear,
    // client-actionable error that includes the offending path so the
    // Obsidian Agent Client can surface a real diagnostic instead of the
    // generic "I cannot access local files" placeholder.
    try {
      const st = statSync(effectiveCwd);
      if (!st.isDirectory()) {
        return reject(new Error(`dsh-acp: cwd is not a directory: ${effectiveCwd}`));
      }
    } catch (e) {
      if (e.code === "ENOENT") {
        return reject(new Error(`dsh-acp: cwd does not exist: ${effectiveCwd}`));
      }
      return reject(new Error(`dsh-acp: cwd is not accessible (${e.code ?? e.message}): ${effectiveCwd}`));
    }
    const child = spawn(DSH_SPAWN.cmd, [...DSH_SPAWN.prefixArgs, ...args], {
      cwd: effectiveCwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    let cancelled = false;
    // Incremental UTF-8 decoder (REQ-11): decode each chunk with a persistent
    // StringDecoder so a multi-byte char split across chunk boundaries is not
    // mangled into garbled text when streamed to the ACP client.
    const stdoutDecoder = new StringDecoder("utf8");

    // Structured-output plumbing (only allocated when useStructured). Both
    // instances are per-prompt — discarding after the close handler matches
    // the createUpdateTranslator lifecycle contract (no toolCallId cache
    // leak across turns).
    let parser = null;
    let translator = null;
    let stdoutBuf = ""; // accumulates decoded bytes between newlines
    if (useStructured) {
      parser = createHeadlessParser();
      translator = createUpdateTranslator();
    }

    function emitFromStructuredLine(line) {
      if (!parser || !translator) return;
      const officialFrames = parser.push(line);
      for (const f of officialFrames) {
        for (const legacy of translator.translate(f)) {
          // Mirror text content into `out` so the Promise's resolve() value
          // matches the plain-text fallback's `out.trim()` — callers that
          // ignore onFrame still get the assembled text.
          if (
            legacy &&
            legacy.sessionUpdate === "agent_message_chunk" &&
            legacy.content &&
            typeof legacy.content.text === "string"
          ) {
            out += legacy.content.text;
          }
          if (onFrame) {
            try {
              onFrame(legacy);
            } catch (cbErr) {
              // A throwing onFrame must not abort the spawn pipeline.
              // Log to stderr (stdout is the ACP JSON-RPC channel — see the
              // CRITICAL comment at line 627).
              try { process.stderr.write(`[dsh-acp] onFrame error: ${cbErr?.message ?? cbErr}\n`); } catch {}
            }
          }
        }
      }
    }

    if (signal) {
      if (signal.aborted) {
        child.kill("SIGTERM");
        cancelled = true;
      } else {
        signal.addEventListener("abort", () => {
          child.kill("SIGTERM");
          cancelled = true;
        }, { once: true });
      }
    }
    child.stdout.on("data", (chunk) => {
      const decoded = stdoutDecoder.write(chunk);
      if (!useStructured) {
        out += decoded;
        if (onChunk) onChunk(decoded);
        return;
      }
      // Line-buffer and parse JSONL. Track every complete line; the trailing
      // partial is drained in the close handler.
      stdoutBuf += decoded;
      let nlIdx;
      while ((nlIdx = stdoutBuf.indexOf("\n")) !== -1) {
        const line = stdoutBuf.slice(0, nlIdx);
        stdoutBuf = stdoutBuf.slice(nlIdx + 1);
        emitFromStructuredLine(line);
      }
    });
    child.stderr.on("data", (chunk) => { err += chunk.toString(); });
    child.on("error", (e) => reject(e));
    child.on("close", (code) => {
      if (patchInfo) patchInfo.cleanup();
      if (cancelled) return reject(new Error("cancelled"));
      // Drain any trailing non-newline-terminated JSONL line. Empty buffer
      // (most common — dsh flushes a final `\n`) is a no-op.
      if (useStructured && stdoutBuf.length > 0) {
        emitFromStructuredLine(stdoutBuf);
        stdoutBuf = "";
      }
      if (code === 0) {
        resolve(out.trim());
      } else {
        const detail = (err || out).trim() || `exit code ${code}`;
        reject(new Error(`dsh exited ${code}: ${detail.slice(0, 4000)}`));
      }
    });
  });
}

// Bug C (2026-09-19, #63): pre-validate ACP session cwd params so a stale
// savedSession path (e.g. /Users/admin/... after a rename) is rejected at the
// session/new|load|fork boundary with a clear InvalidParams error instead of
// propagating into runDsh() and bubbling up as an opaque spawn failure.
//
// Phase 3 (#3, 2026-09-25): shared with `lib/acp-official-router.mjs` via
// `lib/cwd-validator.mjs::validateCwd()`. The router path throws a plain Error
// with `code = "INVALID_CWD"` (no ACP SDK on that side); the protocol layer
// still wraps the result as a `RequestError` so the JSON-RPC envelope stays
// `code: -32602 InvalidParams` for clients. Both paths share one validation
// truth.
/**
 * @param {unknown} cwd
 * @param {string} opName  e.g. "session/new"
 * @returns {string|undefined} the cwd to use, or undefined to signal "no cwd
 *   supplied, fall back to process.cwd()".
 * @throws {RequestError} when cwd is non-empty, absolute, but missing or not
 *   a directory — surfaces to the ACP client as InvalidParams.
 */
function validateCwdParam(cwd, opName) {
  const res = validateCwd(cwd, opName);
  if (res.ok) return res.cwd;
  throw new RequestError(res.error.message);
}

// ---- ACP helpers ---------------------------------------------------------
function notifyUpdate(client, sessionId, update) {
  return client.notify(methods.client.session.update, { sessionId, update });
}

function textChunk(messageId, text) {
  return { messageId, content: { type: "text", text } };
}

// M2.4 (2026-09-18): expose all 4 permission modes (default/acceptEdits/dontAsk/
// bypassPermissions) so the ACP `modes` field matches claude-agent-acp's
// `availableModes`. The currently-active mode comes from the session
// record (`rec.mode`); unknown / missing values fall back to "default".
// See P4 差距记录 §2.3 + dsh-acp-权限链路工具卡断排查记录 §三.1.
//
// M2.4 revert (2026-09-19): UI regression — dsh-web session-management
// button click has no response. Revert to single-mode stub while we
// identify the offending field. Re-introduce 4-mode once frontend is
// confirmed safe (see docs/实施计划/P4-…-实施计划.md §0.7).
function initializeModes() {
  return {
    currentModeId: "default",
    availableModes: [
      { id: "default", name: "Default", description: "Ask before every tool call" },
    ],
  };
}

// ---- FEAT: per-session provider + model switching (FE-1) -----------------
// Models offered to Obsidian's configOption dropdown are enumerated from dsh's
// configured providers (`~/.dsh/settings.yaml` → llm-pi-ai.providers), each as
// a flattened "provider/model" value — still compatible with long-runtime's
// `extractProvider`. When settings.yaml is missing / has no providers, fall
// back to an env override (DSH_ACP_MODELS) then a small built-in default list.
const FALLBACK_MODELS = [
  // Default to a tool-capable model so out-of-the-box users (no settings.yaml,
  // no DSH_ACP_DEFAULT_MODEL) get tool-call frames on the 0.3.0+ spawn path.
  // DeepSeek-V4-Flash stays in the list as a known non-tool-capable option,
  // but no longer as the silent default. Override per-host via
  // DSH_ACP_DEFAULT_MODEL=<provider/model>.
  // t38: 默认模型改为读 profile（可注入 opts 供测试）；解析不到再退回原硬编码。
  { id: resolveDshAcpDefaultModelId() },
  { id: "Kimi-K2.6" },
  { id: "DeepSeek-V4-Flash" },
  { id: "Qwen3.8" },
];
function providerCatalogModels() {
  return loadProviderCatalog().map((c) => ({
    id: `${c.provider}/${c.model}`,
    name: c.name,
    provider: c.provider,
    model: c.model,
  }));
}
function availableModels() {
  const raw = process.env.DSH_ACP_MODELS;
  if (raw) {
    // Explicit env override wins (back-compat): bare ids resolve to the default provider.
    return raw.split(",").map((s) => s.trim()).filter(Boolean).map((s) => {
      const m = s.match(/^([^(]+)(?:\((.+)\))?$/);
      const id = m[1].trim();
      return { id, name: (m[2] ?? id).trim(), provider: DEFAULT_PROVIDER, model: id };
    });
  }
  const catalog = providerCatalogModels();
  if (catalog.length > 0) return catalog;
  return FALLBACK_MODELS.map((m) => ({
    id: m.id,
    name: m.id,
    provider: splitModel(m.id).provider,
    model: splitModel(m.id).model,
  }));
}

/**
 * Resolve the dropdown's current flattened `provider/model` value, tolerating a
 * legacy bare model id that predates FE-1. Falls back to the default provider's
 * first model (matching `agent-default-model`) then the first entry overall.
 */
function pickCurrentModel(model, models) {
  if (model) {
    if (models.some((m) => m.id === model)) return model; // already `provider/model`
    const bare = models.find((m) => m.model === model); // legacy bare id
    if (bare) return bare.id;
  }
  const def = models.find((m) => m.provider === DEFAULT_PROVIDER) ?? models[0];
  return def ? def.id : undefined;
}

/** Build the ACP `model` config option (select) for a session. */
function modelConfigOption(session) {
  const models = availableModels();
  const current = pickCurrentModel(session?.model, models);
  return {
    id: "model",
    name: "Model",
    description: "AI model to use for this session",
    category: "model",
    type: "select",
    currentValue: current,
    options: models.map((m) => ({ value: m.id, name: m.name })),
  };
}

/**
 * Per-session temperature override. P2.5: surfaced as a configOption so
 * Obsidian's settings panel can dial it without re-spawning dsh.
 *
 * ACP's zSessionConfigOption only supports `select`/`boolean` — a `number`
 * configOption crashes Obsidian's client renderer (it reads `.options.length`
 * on every configOption, which is undefined for number form). So temperature
 * is exposed as a DISCRETE select ladder; the persisted value stays a number
 * (setSessionConfigOption does Number(value) before writing).
 */
const TEMPERATURE_STEPS = [0, 0.25, 0.5, 0.7, 1, 1.25, 1.5, 2];

/** Snap a temperature to the nearest ladder step (0.7 default). */
function snapTemperature(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) value = 0.7;
  let best = TEMPERATURE_STEPS[0];
  let bestDiff = Infinity;
  for (const s of TEMPERATURE_STEPS) {
    const d = Math.abs(s - value);
    if (d < bestDiff) {
      bestDiff = d;
      best = s;
    }
  }
  return best;
}

function temperatureConfigOption(session) {
  const current = snapTemperature(session?.temperature);
  return {
    id: "temperature",
    name: "Temperature",
    description: "Sampling temperature (0 = deterministic, 2 = chaotic)",
    category: "model",
    type: "select",
    currentValue: String(current),
    options: TEMPERATURE_STEPS.map((v) => ({
      value: String(v),
      name: v === 0.7 ? "0.7 (default)" : String(v),
    })),
  };
}

/**
 * Per-session reasoning-effort override. Maps to dsh's ReasoningEffortId.
 * P2.5: surfaced as a configOption select.
 */
function reasoningEffortConfigOption(session) {
  // M2.1 (2026-09-18): align with claude-agent-acp's reasoningEffort levels
  // (low/medium/high/max). dsh keeps an additional `none` (disable thinking
  // entirely) as a dsh-specific option. The 5-level union is harmless — dsh-llm
  // accepts arbitrary reasoningEffort strings (lib/index.js:361 only uses the
  // value for cache invalidation, downstream provider decides meaning).
  const valid = ["none", "low", "medium", "high", "max"];
  const current = valid.includes(session?.reasoningEffort) ? session.reasoningEffort : "medium";
  return {
    id: "reasoningEffort",
    name: "Reasoning Effort",
    description: "How much the model should 'think' before answering",
    category: "model",
    type: "select",
    currentValue: current,
    options: [
      { value: "none", name: "None" },
      { value: "low", name: "Low" },
      { value: "medium", name: "Medium" },
      { value: "high", name: "High" },
      { value: "max", name: "Max" },
    ],
  };
}

function sessionConfigOptions(session) {
  return [
    modelConfigOption(session),
    temperatureConfigOption(session),
    reasoningEffortConfigOption(session),
  ];
}

/** Merge disk-scanned archives with the durable index for session/list. */
function listSessionRecords(cwd) {
  const indexRecords = allSessions().map((s) => ({
    id: s.id,
    title: s.title,
    cwd: s.cwd,
    parentSessionId: s.parentSessionId,
    summary: s.summary ?? undefined,
    summaryAt: s.summaryAt ?? undefined,
    createdAt: s.createdAt ?? undefined, // M1.1: ISO timestamp for updatedAt derivation
  }));
  const scanned = scanArchives(cwd).map((s) => ({ id: s.id, title: s.title, cwd: s.cwd, parentSessionId: null }));
  // De-dupe by id, index records first.
  const seen = new Set(indexRecords.map((s) => s.id));
  return indexRecords.concat(scanned.filter((s) => !seen.has(s.id)));
}

// ---- FEAT: session summary (one-line LLM preview) -------------------------
// Regenerate a session's one-line summary when its message count grows beyond
// a threshold since the last generation. Runs as a non-blocking background
// task after a prompt completes; failures are swallowed so they never affect
// the ACP response.
const SUMMARY_REFRESH_DELTA = 4;      // regenerate after N new messages
const SUMMARY_MAX_PROMPT_CHARS = 4000; // cap the messages excerpt sent to the LLM
const summaryLocks = new Set();       // sessionIds currently generating (avoid races)

function messagesExcerpt(session) {
  const parts = [];
  const msgs = Array.isArray(session?.messages) ? session.messages : [];
  for (const m of msgs.slice(-8)) {
    const label = m.role === "user" ? "USER" : "AI";
    const text = String(m.text ?? "").replace(/\s+/g, " ").slice(0, 200);
    if (text) parts.push(`${label}: ${text}`);
  }
  return parts.join("\n").slice(0, SUMMARY_MAX_PROMPT_CHARS);
}

function shouldRefreshSummary(session) {
  const msgCount = Array.isArray(session?.messages) ? session.messages.length : 0;
  // Generate on first meaningful exchange (>=2 messages), then refresh when the
  // message count has grown by SUMMARY_REFRESH_DELTA since the last summary.
  if (!session.summary) return msgCount >= 2;
  return msgCount - (session.summaryAt ? Math.ceil(session.summaryAt) : 0) >= SUMMARY_REFRESH_DELTA;
}

/** Recompute `rec.summary` via a one-shot dsh invocation (best-effort). */
async function regenerateSummary(session) {
  if (!session || summaryLocks.has(session.id)) return;
  const excerpt = messagesExcerpt(session);
  if (!excerpt) return;
  summaryLocks.add(session.id);
  try {
    const prompt = "Summarize the following conversation in ONE short sentence (Chinese if the conversation is Chinese, otherwise English). Return ONLY the sentence, no quotes, no prefix.\n\n" + excerpt;
    const text = await runDsh(prompt, session.cwd, null, undefined, session.model || undefined);
    const clean = (text || "").trim().slice(0, 300);
    if (clean) {
      const msgCount = Array.isArray(session.messages) ? session.messages.length : 0;
      updateSessionMeta(session.id, { summary: clean, summaryAt: msgCount });
    }
  } catch { /* best-effort: a failed summary never fails the session */ }
  finally { summaryLocks.delete(session.id); }
}

function createAgent() {
  return {
    async initialize() {
      return {
        protocolVersion: 1,
        agentCapabilities: {
          loadSession: true,
          sessionCapabilities: {
            list: {},
            delete: {},
            fork: {},
            resume: {},
            close: {},
          },
        },
        agentInfo: { name: "dsh-acp", title: "DeepSeek Harness", version: "0.2.0" },
      };
    },

    async newSession(params) {
      const cwd = validateCwdParam(params.cwd, "session/new");
      const rec = createSession({ cwd: cwd ?? params.cwd, title: params._meta?.title });
      return { sessionId: rec.id, modes: initializeModes(), configOptions: sessionConfigOptions(rec) };
    },

    async loadSession(params) {
      const cwd = validateCwdParam(params.cwd, "session/load");
      const rec = ensureSession(params.sessionId, cwd ?? params.cwd);
      return { sessionId: rec.id, modes: initializeModes(), configOptions: sessionConfigOptions(rec) };
    },

    async listSessions(params) {
      // Obsidian 会话 GC：以 Obsidian 本地 sessions 目录为权威，把用户已在
      // Obsidian 删除、但 adapter 仍残留磁盘归档的孤儿会话同步清理掉，避免
      // session/list 复活。失败不影响列表返回。见 gc.mjs。
      try {
        const gc = gcBeforeList();
        // CRITICAL: write to stderr, NOT stdout — stdout is the ACP JSON-RPC
        // channel. A stray `console.log` here was corrupting Obsidian's first
        // JSON-RPC parse (root cause of "Obsidian UI sees no progress" —
        // the JSON-RPC framing went off-rail before session/new ever landed).
        if (gc.removed && gc.removed.length) process.stderr.write(`[dsh-acp] gc: cleaned ${gc.removed.length} orphan session(s)\n`);
      } catch (e) { /* 不阻塞列表 */ }
      const cwd = params.cwd ?? process.cwd();
      const sessions = listSessionRecords(cwd).map((s) => ({
        sessionId: s.id,
        title: s.title,
        cwd: s.cwd,
        // M1.1 (2026-09-18): align with @agentclientprotocol/claude-agent-acp's
        // session/list schema — top-level `updatedAt` ISO timestamp lets ACP
        // clients (Obsidian, Claude Code, etc.) sort/display sessions by
        // recency without reaching into `_meta`. Falls back to summaryAt →
        // createdAt → undefined. Claude's reference impl uses
        // `new Date(session.lastModified).toISOString()`; we use summaryAt
        // when present since that's our last LLM-update marker.
        updatedAt: s.summaryAt ?? s.createdAt ?? undefined,
        // Some clients display parent/lineage when present.
        parentSessionId: s.parentSessionId ?? undefined,
        // FEAT: session summary preview rides in `_meta` — SessionInfo has a
        // reserved `_meta` object, whereas top-level summary/summaryAt are not
        // part of the ACP SessionInfo schema and get stripped on serialization.
        _meta: {
          summary: s.summary ?? undefined,
          summaryAt: s.summaryAt ?? undefined,
        },
      }));
      return { sessions, nextCursor: null };
    },

    // FEAT: advertise an "import session" command so history pages can render a
    // button. Obsidian surfaces these via the available_commands_update
    // session update; the actual import runs on `/import <path>` in prompt.
    importCmd() {
      return {
        name: "import",
        description: "Import an ACP-protocol (claude / Obsidian) session from a JSON file",
        input: { type: "unstructured" },
      };
    },

    async deleteSession(params) {
      storeDelete(params.sessionId);
      return { deleted: params.sessionId };
    },

    async resumeSession(params) {
      const rec = getSession(params.sessionId);
      if (!rec) throw new RequestError(`session ${params.sessionId} not found`);
      return { sessionId: rec.id, modes: initializeModes(), configOptions: sessionConfigOptions(rec) };
    },

    async forkSession(params) {
      const cwd = validateCwdParam(params.cwd, "session/fork");
      const rec = forkSession(params.sessionId, cwd ?? params.cwd);
      if (!rec) throw new RequestError(`source session ${params.sessionId} not found`);
      return { sessionId: rec.id, modes: initializeModes() };
    },

    async closeSession() { return undefined; },
    async setSessionMode(params) {
      // W1 (2026-10-09, t23): real implementation, replacing the M2.4 no-op stub.
      //
      // Provenance note: the original 4-mode implementation was searched for
      // across all 171 revs / all branches and is NOT in git history — the
      // revert commit df13641's parent already carried the one-liner stub, so
      // that work only ever existed in a working tree. This body is therefore
      // written fresh against the infrastructure that did survive:
      //   - lib/permission-gate.mjs:40  PERMISSION_MODES (single source of truth)
      //   - lib/permission-gate.mjs:165 PermissionGate.setMode() (validates + clears cache)
      //   - archive-store.mjs:270       updateSessionMeta() whitelists `mode`
      //   - globalThis.__DSH_LONG_RUNTIME__.gate (live long-runtime only)
      //
      // SCOPE NOTE (deliberate): `initializeModes()` still advertises only
      // `default`. Expanding the advertised list to 4 modes is what triggered
      // the M2.4 dsh-web UI regression, and spec §阶段1 does not ask for it, so
      // it is intentionally left alone. Consequence: we ACCEPT all 4 modes when
      // a client sends them, but still OFFER only `default` in the payload.
      const session = getSession(params.sessionId);
      if (!session) throw new RequestError(`session ${params.sessionId} not found`);

      const mode = params.modeId;
      if (typeof mode !== "string" || !PERMISSION_MODES.has(mode)) {
        // Reject loudly — never silently ignore an unknown mode.
        throw new RequestError(
          `invalid modeId ${JSON.stringify(mode)}: expected one of ${[...PERMISSION_MODES].join(", ")}`,
        );
      }

      // 1) live gate (spawn mode / uninitialised long-runtime => no gate, persist only)
      const rt = globalThis.__DSH_LONG_RUNTIME__;
      if (rt && rt.gate) rt.gate.setMode(mode);

      // 2) persist so resume/load keeps the choice (archive-store whitelists `mode`)
      updateSessionMeta(params.sessionId, { mode });

      // 3) echo the (unchanged) advertised modes payload
      return { modes: initializeModes() };
    },
    async setSessionConfigOption(params) {
      // Per-session config override (FEAT). Recognised configIds:
      //   "model"           — switch the session's model
      //   "temperature"     — P2.5: number 0..2
      //   "reasoningEffort" — P2.5 + M2.1: "none" | "low" | "medium" | "high" | "max"
      // Persist onto the session record so prompt() can apply it.
      const session = getSession(params.sessionId);
      if (!session) throw new RequestError(`session ${params.sessionId} not found`);
      if (params.configId === "model" && typeof params.value === "string") {
        const valid = availableModels().map((m) => m.id);
        if (valid.includes(params.value)) {
          updateSessionMeta(params.sessionId, { model: params.value });
        }
      } else if (params.configId === "temperature") {
        const n = Number(params.value);
        if (Number.isFinite(n) && n >= 0 && n <= 2) {
          updateSessionMeta(params.sessionId, { temperature: n });
        }
      } else if (params.configId === "reasoningEffort") {
        // M2.1 fix (2026-09-18): include "max" to match reasoningEffortConfigOption's
        // 5-level union. Without this, setSessionConfigOption silently rejected
        // "max" while the dropdown advertised it — a UI promise / handler gap.
        const valid = ["none", "low", "medium", "high", "max"];
        if (typeof params.value === "string" && valid.includes(params.value)) {
          updateSessionMeta(params.sessionId, { reasoningEffort: params.value });
        }
      }
      return { configOptions: sessionConfigOptions(getSession(params.sessionId) ?? session) };
    },
    async authenticate() { return undefined; },
    async logout() { return undefined; },

    async prompt(params, ctx) {
      const session = getSession(params.sessionId) ?? ensureSession(params.sessionId, params.cwd);
      const cwd = session.cwd ?? process.cwd();
      const promptText = extractPromptText(params.prompt);

      // P3.0 commit 3: dsh web HTTP/SSE proxy mode. Probe in runAcp() set
      // globalThis.__DSH_ACP_PROXY_BASE_URL__ when dsh web gateway is alive;
      // here we forward via fetch SSE and translate sessionUpdate events to
      // ctx.client.notify. Fallback path (proxy fail) throws and the caller
      // gets an end_turn error — long-runtime mode could retry via spawn.
      if (globalThis.__DSH_ACP_PROXY_BASE_URL__) {
        const baseUrl = globalThis.__DSH_ACP_PROXY_BASE_URL__;
        process.stderr.write(`[dsh-acp] proxy forward session=${params.sessionId}\n`);
        // t44: 必须在写入本轮 user 消息**之前**取历史——否则本轮 prompt 会
        // 同时出现在 history 与「当前 prompt」里，模型会看到两遍同一句话。
        const history = getHistory(params.sessionId);
        let proxyAssistantText = "";
        let proxyResult;
        let proxyErrorText;
        try {
          proxyResult = await forwardPromptViaHttp({
            baseUrl,
            sessionId: params.sessionId,
            prompt: params.prompt,
            model: session.model ?? undefined,
            temperature: typeof session.temperature === "number" ? session.temperature : undefined,
            reasoningEffort: session.reasoningEffort ?? undefined,
            // t44 多轮记忆（第 1 层）：把 per-session history 交给 proxy 上行。
            messages: history,
            signal: ctx.signal,
            onUpdate: async (method, p) => {
              // t44: proxy 路径的返回体只有 {stopReason, usage}（无 text），
              // 助手正文只经 sessionUpdate 事件到达 → 在此累积，供本轮结束后归档，
              // 否则 proxy 模式的 assistant 消息永不落库，下一轮 history 里没有它。
              try {
                const u = p?.update;
                if (u?.sessionUpdate === "agent_message_chunk"
                  && u?.content?.type === "text"
                  && typeof u.content.text === "string") {
                  proxyAssistantText += u.content.text;
                }
              } catch { /* best-effort */ }
              if (!ctx?.client) return;
              try {
                await ctx.client.notify(method, p);
              } catch (e) {
                process.stderr.write(`[dsh-acp] proxy→ctx notify failed: ${e?.message ?? e}\n`);
              }
            },
            // P3.0 tool-call fix (2026-09-18): server emits SSE "request"
            // events when long-runtime needs to call acpClient.request (e.g.
            // session/request_permission). Forward them to ctx.client.request
            // so the user can answer via Obsidian's permission prompt UI.
            onRequest: async (method, p) => {
              if (!ctx?.client) {
                throw new Error("no ACP client available for server request");
              }
              return await ctx.client.request(method, p);
            },
          });
        } catch (e) {
          // t48: 只**记录**错误文本，不再在此归档（归档统一挪到 finally）。
          // t47 定位：此前归档语句位于 `return proxyResult` 之前，出错时控制流
          // 直接跳到 catch → 归档**从未执行** → messages 只剩 user（roles=user,user）。
          proxyErrorText = `[dsh-acp error] ${e?.message ?? String(e)}`;
          process.stderr.write(`[dsh-acp] proxy forward failed: ${e?.message ?? e}; client will see end_turn\n`);
        } finally {
          // t48 单一归档点（A+B）：无论成功或失败都在此写 user + assistant。
          // ① 只此一处（原 try 内与调用前的归档均已删除）→ 不会重复写
          // ② 出错轮也落盘，assistant 文本带 `[dsh-acp error]` 前缀，便于下一轮
          //    模型/用户知道上一轮失败过（而不是像 t47 那样只剩 user）
          // ③ user 的归档放在这里是因为 history 已在上面**先**取好（防重复计数）
          try { recordMessage(session.id, "user", promptText); } catch { /* best-effort */ }
          try {
            const assistantText = proxyErrorText ?? proxyAssistantText;
            if (assistantText) recordMessage(session.id, "assistant", assistantText);
          } catch { /* best-effort */ }
        }
        // 保持原语义：proxy 失败仍向上抛（客户端看到 end_turn error）
        if (proxyErrorText) throw new Error(proxyErrorText);
        return proxyResult;
      }

      // P1.5 step 4: long-mode + mock-llm protocol test path. If long-runtime
      // is initialized (init() succeeded) AND mock-llm env is set, route the
      // turn through rt.prompt() with an acpClient wrapper that bridges
      // session/update notifications to ctx.notify. Real (non-mock) long mode
      // lands in P3.0 once ctx.llm.stream is exercised against real dsh.
      if (
        process.env.DSH_ACP_MOCK_LLM === "1" &&
        globalThis.__DSH_LONG_RUNTIME__?._initialized
      ) {
        const rt = globalThis.__DSH_LONG_RUNTIME__;
        // Temporarily swap acpClient so this turn's emits hit ctx.notify, and
        // expose the live ACP client (with .request for session/request_permission)
        // so the permission gate can ask the user when needed.
        const previousClient = rt.acpClient;
        const previousLive = rt._liveAcpClient;
        rt.acpClient = {
          async notify(method, p) {
            if (method !== "session/update" || !ctx?.client) return;
            try {
              await ctx.client.notify(methods.client.session.update, p);
            } catch (e) {
              process.stderr.write(`[dsh-acp] long→ctx notify failed: ${e?.message ?? e}\n`);
            }
          },
        };
        rt._liveAcpClient = ctx?.client
          ? { request: (m, p) => ctx.client.request(m, p) }
          : null;
        try {
          const result = await rt.prompt({
            sessionId: params.sessionId,
            prompt: params.prompt,
            sessionConfig: {
              model: session.model ?? undefined,
              temperature: typeof session.temperature === "number" ? session.temperature : undefined,
              reasoningEffort: session.reasoningEffort ?? undefined,
            },
          });
          return {
            stopReason: result.stopReason,
            usage: result.usage ?? { totalTokens: 0, inputTokens: 0, outputTokens: 0 },
          };
        } finally {
          rt.acpClient = previousClient;
          rt._liveAcpClient = previousLive;
        }
      }

      // FEAT: `/import <path>` command → import an external ACP (claude) session
      // into this session thread. Supports Obsidian's unstructured command input.
      const importMatch = promptText.trim().match(/^\/import\s+(.+)$/i);
      if (importMatch) {
        try {
          const { importExternalSessionFile } = await import("./import-session.mjs");
          const r = importExternalSessionFile(importMatch[1], { cwd });
          const text = `导入成功: 「${r.title}」 ${r.imported} 条消息 (sessionId=${r.sessionId})`;
          return { stopReason: "end_turn", text, usage: { totalTokens: 0, inputTokens: 0, outputTokens: 0 } };
        } catch (e) {
          return { stopReason: "end_turn", text: `导入失败: ${e.message}`, usage: { totalTokens: 0, inputTokens: 0, outputTokens: 0 } };
        }
      }

      if (logFile) console.log(`prompt session=${params.sessionId} cwd=${cwd} ${promptText.slice(0, 200)}`);
      const messageId = `msg-${randomUUID()}`;
      let receivedChunks = false;
      // Archive the user turn (function 3: write back to DSH archive).
      try { recordMessage(session.id, "user", promptText); } catch {}
      try {
        // 0.3.0 工具帧修复 (Path A): when dsh supports --json, `runDsh`
        // emits structured session/update frames via `onFrame`. The text-only
        // path (onChunk) is the legacy fallback for dsh < 0.1.7-rc.1 — see
        // v2 plan §5.5. We pass BOTH callbacks: runDsh picks the structured
        // path and ignores onChunk when --json is available.
        const output = await runDsh(
          promptText,
          cwd,
          (chunk) => {
            receivedChunks = true;
            notifyUpdate(ctx.client, params.sessionId, {
              sessionUpdate: "agent_message_chunk",
              ...textChunk(messageId, chunk),
            }).catch((e) => console.log(`notify error: ${e}`));
          },
          ctx.signal,
          session.model || undefined,
          (frame) => {
            // Structured frame from createUpdateTranslator (legacy shape).
            // Pass through verbatim to the ACP client — the same notifyUpdate
            // the legacy SSE channel already digests (see acp-tool-translation
            // spec for the official→legacy mapping this inherits).
            receivedChunks = true;
            notifyUpdate(ctx.client, params.sessionId, frame).catch(
              (e) => console.log(`notify error: ${e}`),
            );
          },
        );
        const finalText = output || "(no output)";
        // Archive the assistant turn.
        try { recordMessage(session.id, "assistant", finalText); } catch {}
        // FEAT: refresh the one-line session summary in the background.
        try {
          const srec = getSession(session.id);
          if (srec && shouldRefreshSummary(srec)) regenerateSummary(srec);
        } catch { /* best-effort */ }
        if (!receivedChunks) {
          await notifyUpdate(ctx.client, params.sessionId, {
            sessionUpdate: "agent_message_chunk",
            ...textChunk(messageId, finalText),
          });
        }
        return { stopReason: "end_turn", usage: { totalTokens: 0, inputTokens: 0, outputTokens: 0 } };
      } catch (err) {
        if (err.message === "cancelled") return { stopReason: "cancelled" };
        let msg = `\n[dsh-acp error] ${err.message}\n`;
        // 健康诊断注入：dsh 运行失败时，定位可修复问题并给出一键修复指引（版本无关）。
        // 若用户回复「修复 <序号>」/ 主动运行 doctor，可据此定位与修复。
        try {
          const { parseCredentialIssue, formatDiagnosis } = await import("./doctor.mjs");
          const issue = parseCredentialIssue(err.message);
          if (issue) {
            msg += formatDiagnosis([issue]);
          }
        } catch (e) { /* 诊断模块失败不影响主流程 */ }
        await notifyUpdate(ctx.client, params.sessionId, {
          sessionUpdate: "agent_message_chunk",
          ...textChunk(messageId, msg),
        });
        return { stopReason: "end_turn", usage: { totalTokens: 0, inputTokens: 0, outputTokens: 0 } };
      }
    },

    async cancel() { return undefined; },
  };
}

function extractPromptText(prompt) {
  if (typeof prompt === "string") return prompt;
  if (Array.isArray(prompt)) {
    return prompt.map((b) => (b?.type === "text" && typeof b.text === "string" ? b.text : "")).join("\n");
  }
  if (prompt && Array.isArray(prompt.content)) {
    return prompt.content.map((b) => (b?.type === "text" && typeof b.text === "string" ? b.text : "")).join("\n");
  }
  return String(prompt ?? "");
}

/**
 * Install a mock cordis ctx whose `llm.stream()` returns a scriptable async
 * iterable of StreamChunks. Used by acp-feature-test.mjs --mock-llm to exercise
 * the long-runtime init() path end-to-end without a real dsh process.
 *
 * Chunk script: read from DSH_ACP_MOCK_LLM_CHUNKS (JSON array, env var) or
 * fall back to a canned "hello world" sequence.
 *
 * @returns {Promise<object>} mock cordis ctx (shaped like dsh's: { llm, on, off })
 */
async function installMockCordisCtx() {
  const chunks = parseMockChunksEnv();
  return {
    llm: {
      stream(_options) {
        return (async function* () {
          for (const c of chunks) {
            if (_options && _options.signal && _options.signal.aborted) {
              throw new Error("aborted");
            }
            yield c;
          }
        })();
      },
    },
    on() {},
    off() {},
  };
}

function parseMockChunksEnv() {
  const raw = process.env.DSH_ACP_MOCK_LLM_CHUNKS;
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed;
    } catch (e) {
      process.stderr.write(`[dsh-acp] mock-llm: bad DSH_ACP_MOCK_LLM_CHUNKS JSON (${e.message}); using default\n`);
    }
  }
  // Default: a reasoning + text + usage + finish canned stream.
  return [
    { type: "block-start", index: 0, blockType: "reasoning" },
    { type: "reasoning-delta", index: 0, text: "thinking…" },
    { type: "block-end", index: 0, block: { type: "reasoning", text: "thinking…" } },
    { type: "block-start", index: 1, blockType: "text" },
    { type: "text-delta", index: 1, text: "mock-long: hello " },
    { type: "text-delta", index: 1, text: "world" },
    { type: "block-end", index: 1, block: { type: "text", text: "mock-long: hello world" } },
    { type: "usage", usage: { inputTokens: 5, outputTokens: 7, totalTokens: 12 } },
    { type: "finish", reason: { kind: "stop" } },
  ];
}

// ---- FEAT (P2.0): dual-runtime dispatch ----------------------------------
// Resolves runtime.mode at startup. Long mode requires a dsh cordis ctx
// accessible via globalThis.__DSH_CORDIS_CTX__ (set by the cordis plugin when
// hosting in-process). The standalone binary never has this, so it falls back
// to spawn mode.
//
// P1.5 step 4: DSH_ACP_MOCK_LLM=1 installs a fake cordis ctx so protocol tests
// can exercise the long path end-to-end without a real dsh process.
//
// All dispatch logs go to stderr — stdout is reserved for ACP JSON-RPC.
async function runAcpDualMode() {
  const mode = resolveRuntimeMode();
  const permissionConfig = resolvePermissionConfig();
  process.stderr.write(`[dsh-acp] runtime mode: ${mode} permission.mode=${permissionConfig.mode}\n`);

  if (mode === "spawn") return runAcp();

  // Long mode: requires cordis ctx injected by the cordis plugin.
  // P1.5 step 4: --mock-llm flag installs a fake ctx so protocol tests can
  // exercise the long path end-to-end without a real dsh process.
  let cordisCtx = globalThis.__DSH_CORDIS_CTX__;
  if (!cordisCtx && process.env.DSH_ACP_MOCK_LLM === "1") {
    cordisCtx = await installMockCordisCtx();
    process.stderr.write("[dsh-acp] mock-llm: installed fake cordis ctx (test mode)\n");
  }
  if (!cordisCtx) {
    process.stderr.write("[dsh-acp] long mode requested but no cordis ctx available; falling back to spawn\n");
    return runAcp();
  }

  // Lazy import so standalone binary never pays the cost.
  const { getLongRuntime } = await import("./lib/long-runtime.mjs");
  const rt = getLongRuntime();
  try {
    // P1.5: init() now succeeds. acpClient is a stub here; the prompt()
    // handler in createAgent() swaps in a ctx-forwarding wrapper when
    // DSH_ACP_MOCK_LLM=1 is set. P2.0 will add ctx.on('approval/request') +
    // agent/pre-step wiring here.
    await rt.init({
      cordisCtx,
      acpClient: { notify: async () => {} },
      permissionConfig,
      cwd: process.cwd(),
      model:
        process.env.DSH_ACP_DEFAULT_MODEL ??
        process.env.DSH_ACP_DEFAULT_MODEL_FOR_TEST ??
        (() => { const p = readProfileDefaultModel(); return p ? `${p.provider}/${p.model}` : "default/test-model"; })(),
    });
    // Stash the runtime on globalThis so the ACP prompt handler can route
    // long-mode turns through it.
    globalThis.__DSH_LONG_RUNTIME__ = rt;
    process.stderr.write("[dsh-acp] long mode init succeeded (P1.5)\n");
    return runAcp();
  } catch (err) {
    const msg = err && err.message ? err.message : String(err);
    process.stderr.write(`[dsh-acp] long mode init failed: ${msg}\n`);
    const fallback = (process.env.DSH_ACP_SPAWN_FALLBACK ?? "true") !== "false";
    if (!fallback) throw err;
    return runAcp();
  }
}

// ---- Wiring --------------------------------------------------------------
function runAcp() {
	// P3.0 commit 3: 探测 dsh web HTTP gateway (lib/http-gateway.mjs 在 webServer
	// 上挂的 /acp/proxy/{probe,session/prompt})。若 ok,设 globalThis 标记,
	// prompt() 入口见标记即转发到 HTTP/SSE,长流程在 dsh web 内 long-runtime
	// 真实跑(思考/工具/审批可见),dsh-acp.mjs 仅 thin proxy。
	// probe 是 async,不阻塞 JSON-RPC 输入。initialize 几乎瞬间完成,首个 prompt
	// 触发时 probe 通常已完成,后续 turn 一定走 proxy。
	// 失败/超时/未启用:stderr 一行 hint,继续 spawn(向后兼容)。
	if (shouldAttemptProxy()) {
		probeDshWebGateway().then((probe) => {
			if (probe.ok) {
				globalThis.__DSH_ACP_PROXY_BASE_URL__ = probe._baseUrl;
				process.stderr.write(
					`[dsh-acp] proxy mode: ${probe._baseUrl} (gateway v${probe.version ?? "?"}, mode=${probe.mode ?? "?"}, longReady=${probe.longReady === true})\n`,
				);
			} else if (probe.reason) {
				process.stderr.write(`[dsh-acp] probe failed (${probe.reason}); spawn mode\n`);
			}
		}).catch((e) => {
			process.stderr.write(`[dsh-acp] probe exception: ${e?.message ?? e}; spawn mode\n`);
		});
	}
	// 自然退出 - 8s 后强退,保证所有 timer fire
//	setTimeout(() => { process.stderr.write(`[dsh-acp] DIAG: 8s timeout exit\n`); process.exit(0); }, 8000);

	const input = nodeToWebWritable(process.stdout);
  const output = nodeToWebReadable(process.stdin);
  const stream = ndJsonStream(input, output);
  const h = createAgent();
  const connection = acpAgent({ name: "dsh-acp" })
    .request({ method: methods.agent.initialize, params: permissiveAny }, (ctx) => h.initialize(ctx.params))
    .request({ method: methods.agent.session.new, params: permissiveNewSession }, (ctx) => h.newSession(ctx.params))
    .request({ method: methods.agent.session.load, params: permissiveLoadSession }, (ctx) => h.loadSession(ctx.params))
    .request({ method: methods.agent.session.list, params: permissiveAny }, (ctx) => h.listSessions(ctx.params))
    .request({ method: methods.agent.session.delete, params: permissiveAny }, (ctx) => h.deleteSession(ctx.params))
    .request({ method: methods.agent.session.resume, params: permissiveAny }, (ctx) => h.resumeSession(ctx.params))
    .request({ method: methods.agent.session.fork, params: permissiveAny }, (ctx) => h.forkSession(ctx.params))
    .request({ method: methods.agent.session.close, params: permissiveAny }, (ctx) => h.closeSession(ctx.params))
    .request({ method: methods.agent.session.setMode, params: permissiveSetMode }, (ctx) => h.setSessionMode(ctx.params))
    .request({ method: methods.agent.session.setConfigOption, params: permissiveSetConfigOption }, (ctx) => h.setSessionConfigOption(ctx.params))
    .request({ method: methods.agent.authenticate, params: permissiveAuth }, (ctx) => h.authenticate(ctx.params))
    .request({ method: methods.agent.logout, params: permissiveAuth }, (ctx) => h.logout(ctx.params))
    .request({ method: methods.agent.session.prompt, params: permissivePrompt }, (ctx) => h.prompt(ctx.params, ctx))
    .notification({ method: methods.agent.session.cancel, params: permissiveAny }, (ctx) => h.cancel(ctx.params))
    .connect(stream);
  connection.closed.then(() => { flushPersist(); process.exit(0); });
  // Flush any debounced index write before exiting (REQ-02 durability).
  process.on("SIGTERM", () => { flushPersist(); process.exit(0); });
  process.on("SIGINT", () => { flushPersist(); process.exit(0); });
  process.stdin.resume();
  return connection;
}

function nodeToWebWritable(nodeStream) {
  const { WritableStream } = globalThis;
  return new WritableStream({
    write(chunk) {
      return new Promise((resolve, reject) => {
        nodeStream.write(Buffer.from(chunk), (err) => (err ? reject(err) : resolve()));
      });
    },
  });
}
function nodeToWebReadable(nodeStream) {
  const { ReadableStream } = globalThis;
  return new ReadableStream({
    start(controller) {
      nodeStream.on("data", (chunk) => controller.enqueue(new Uint8Array(chunk)));
      nodeStream.on("end", () => controller.close());
      nodeStream.on("error", (err) => controller.error(err));
    },
  });
}

// CLI 子命令：
//   dsh-acp doctor [--auto] [--gc]            健康诊断 + 修复指引
//   dsh-acp import <file> [--title][--cwd]    导入外部 ACP (claude) 会话
//   dsh-acp manage <list|export|archive|move|import> ...  会话管理
if (process.argv[2] === "--help" || process.argv[2] === "-h") {
  console.log(`dsh-acp — ACP adapter for DeepSeek Harness

Usage:
  dsh-acp                       Start ACP server (default: dual-mode spawn/long)
  dsh-acp doctor [--auto]       Health diagnosis + copy-pasteable fix guidance
  dsh-acp import <file>         Import external ACP (claude) session
  dsh-acp manage <verb> ...     Session management (list/export/archive/move/import)
  dsh-acp --help | -h           Show this help

Subcommand details:
  doctor [--auto] [--gc]
      Run 5-layer headless profile check; --auto applies safe fixes, --gc reclaims
      orphan session files.
  import <file> [--title=<t>] [--cwd=<dir>]
      Import an ACP session JSON file into the local session store.
  manage <list|export|archive|move|import> ...
      Operate on the local session store (see 'dsh-acp manage list' for ids).

Environment:
  DSH_ACP_PROXY_MODE    "true" routes through dsh web HTTP gateway (default),
                        "false" forces direct spawn of 'dsh --profile headless --json'.
  DSH_ACP_PROFILE_DIR   Override headless profile location (default ~/.dsh/profiles/headless).
`);
  process.exit(0);
} else if (process.argv[2] === "doctor") {
  const { runDoctorCli } = await import("./doctor.mjs");
  await runDoctorCli(process.argv.slice(3));
} else if (process.argv[2] === "import") {
  const { runImportCli } = await import("./import-session.mjs");
  await runImportCli(process.argv.slice(3));
} else if (process.argv[2] === "manage") {
  const { runManageCli } = await import("./session-manage.mjs");
  await runManageCli(process.argv.slice(3));
} else {
  // Default: dual-mode ACP server (spawn or long per env).
  runAcpDualMode().catch((err) => {
    console.error("[dsh-acp] fatal:", err && err.message ? err.message : err);
    process.exit(1);
  });
}
