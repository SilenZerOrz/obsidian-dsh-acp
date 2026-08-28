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
} from "./archive-store.mjs";

// ---- Configuration -------------------------------------------------------
// `dsh --profile headless` runs the backend. GUI ACP clients (Obsidian) inherit
// a minimal environment that usually does NOT include shell PATH additions, so
// the plugin and the Obsidian custom-agent `env` should set DSH_BIN explicitly.
// Order: env DSH_BIN -> DSH_ACP_DSH (config file shim) -> "dsh" on PATH.
//
// To be robust against a GUI host that lacks shell PATH additions (Obsidian,
// native apps), we ALSO probe a few well-known install locations when DSH_BIN
// is unset, instead of relying on the bare "dsh" name resolving on PATH.
// This fixes "spawn dsh ENOENT" when the adapter runs under a minimal env.
import { accessSync, constants as fsConstants } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

function detectDshBinary() {
  // Priority: explicit env wins.
  if (process.env.DSH_BIN) return process.env.DSH_BIN;
  if (process.env.DSH_ACP_DSH) return process.env.DSH_ACP_DSH;
  // Known install locations (most likely first).
  const candidates = [
    process.env.DSH_HOME && join(process.env.DSH_HOME, "bin", "dsh"),
    join(homedir(), ".local", "bin", "dsh"),
    join(homedir(), ".npm-global", "bin", "dsh"),
    join("/opt/homebrew", "bin", "dsh"),
    join("/usr/local", "bin", "dsh"),
  ].filter(Boolean);
  for (const p of candidates) {
    if (isAbsolute(p)) {
      try {
        accessSync(p, fsConstants.X_OK);
        return p;
      } catch { /* not executable, try next */ }
    }
  }
  // Fall back to bare name (resolved against the process PATH).
  return "dsh";
}

const DSH_BIN = detectDshBinary();
const DSH_PROFILE = process.env.DSH_PROFILE ?? "headless";
const DSH_EXTRA_ARGS = (process.env.DSH_ARGS ?? "").split(" ").filter(Boolean);

function dshBaseArgs() {
  return ["--profile", DSH_PROFILE, ...DSH_EXTRA_ARGS];
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
function runDsh(prompt, cwd, onChunk, signal) {
  return new Promise((resolve, reject) => {
    const args = [...dshBaseArgs(), prompt];
    const child = spawn(DSH_BIN, args, {
      cwd: cwd || process.cwd(),
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
      const text = stdoutDecoder.write(chunk);
      out += text;
      if (onChunk) onChunk(text);
    });
    child.stderr.on("data", (chunk) => { err += chunk.toString(); });
    child.on("error", (e) => reject(e));
    child.on("close", (code) => {
      if (cancelled) return reject(new Error("cancelled"));
      if (code === 0) {
        resolve(out.trim());
      } else {
        const detail = (err || out).trim() || `exit code ${code}`;
        reject(new Error(`dsh exited ${code}: ${detail.slice(0, 4000)}`));
      }
    });
  });
}

// ---- ACP helpers ---------------------------------------------------------
function notifyUpdate(client, sessionId, update) {
  return client.notify(methods.client.session.update, { sessionId, update });
}

function textChunk(messageId, text) {
  return { messageId, content: { type: "text", text } };
}

const DEFAULTS = {
  initializeModes: () => ({
    currentModeId: "default",
    availableModes: [{ id: "default", name: "Default", description: "Standard mode" }],
  }),
};

/** Merge disk-scanned archives with the durable index for session/list. */
function listSessionRecords(cwd) {
  const indexRecords = allSessions().map((s) => ({
    id: s.id,
    title: s.title,
    cwd: s.cwd,
    parentSessionId: s.parentSessionId,
  }));
  const scanned = scanArchives(cwd).map((s) => ({ id: s.id, title: s.title, cwd: s.cwd, parentSessionId: null }));
  // De-dupe by id, index records first.
  const seen = new Set(indexRecords.map((s) => s.id));
  return indexRecords.concat(scanned.filter((s) => !seen.has(s.id)));
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
      const rec = createSession({ cwd: params.cwd, title: params._meta?.title });
      return { sessionId: rec.id, modes: DEFAULTS.initializeModes() };
    },

    async loadSession(params) {
      const rec = ensureSession(params.sessionId, params.cwd);
      return { sessionId: rec.id, modes: DEFAULTS.initializeModes() };
    },

    async listSessions(params) {
      const cwd = params.cwd ?? process.cwd();
      const sessions = listSessionRecords(cwd).map((s) => ({
        sessionId: s.id,
        title: s.title,
        cwd: s.cwd,
        // Some clients display parent/lineage when present.
        parentSessionId: s.parentSessionId ?? undefined,
      }));
      return { sessions, nextCursor: null };
    },

    async deleteSession(params) {
      storeDelete(params.sessionId);
      return { deleted: params.sessionId };
    },

    async resumeSession(params) {
      const rec = getSession(params.sessionId);
      if (!rec) throw new RequestError(`session ${params.sessionId} not found`);
      return { sessionId: rec.id, modes: DEFAULTS.initializeModes() };
    },

    async forkSession(params) {
      const rec = forkSession(params.sessionId, params.cwd);
      if (!rec) throw new RequestError(`source session ${params.sessionId} not found`);
      return { sessionId: rec.id, modes: DEFAULTS.initializeModes() };
    },

    async closeSession() { return undefined; },
    async setSessionMode() { return undefined; },
    async setSessionConfigOption(params) {
      const session = getSession(params.sessionId);
      return { configOptions: session?.configOptions ?? [] };
    },
    async authenticate() { return undefined; },
    async logout() { return undefined; },

    async prompt(params, ctx) {
      const session = getSession(params.sessionId) ?? ensureSession(params.sessionId, params.cwd);
      const cwd = session.cwd ?? process.cwd();
      const promptText = extractPromptText(params.prompt);
      if (logFile) console.log(`prompt session=${params.sessionId} cwd=${cwd} ${promptText.slice(0, 200)}`);
      const messageId = `msg-${randomUUID()}`;
      let receivedChunks = false;
      // Archive the user turn (function 3: write back to DSH archive).
      try { recordMessage(session.id, "user", promptText); } catch {}
      try {
        const output = await runDsh(promptText, cwd, (chunk) => {
          receivedChunks = true;
          notifyUpdate(ctx.client, params.sessionId, {
            sessionUpdate: "agent_message_chunk",
            ...textChunk(messageId, chunk),
          }).catch((e) => console.log(`notify error: ${e}`));
        }, ctx.signal);
        const finalText = output || "(no output)";
        // Archive the assistant turn.
        try { recordMessage(session.id, "assistant", finalText); } catch {}
        if (!receivedChunks) {
          await notifyUpdate(ctx.client, params.sessionId, {
            sessionUpdate: "agent_message_chunk",
            ...textChunk(messageId, finalText),
          });
        }
        return { stopReason: "end_turn", usage: { totalTokens: 0, inputTokens: 0, outputTokens: 0 } };
      } catch (err) {
        if (err.message === "cancelled") return { stopReason: "cancelled" };
        const msg = `\n[dsh-acp error] ${err.message}\n`;
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

// ---- Wiring --------------------------------------------------------------
function runAcp() {
  const input = nodeToWebWritable(process.stdout);
  const output = nodeToWebReadable(process.stdin);
  const stream = ndJsonStream(input, output);
  const h = createAgent();
  const connection = acpAgent({ name: "dsh-acp" })
    .onRequest(methods.agent.initialize, (ctx) => h.initialize(ctx.params))
    .onRequest(methods.agent.session.new, (ctx) => h.newSession(ctx.params))
    .onRequest(methods.agent.session.load, (ctx) => h.loadSession(ctx.params))
    .onRequest(methods.agent.session.list, (ctx) => h.listSessions(ctx.params))
    .onRequest(methods.agent.session.delete, (ctx) => h.deleteSession(ctx.params))
    .onRequest(methods.agent.session.resume, (ctx) => h.resumeSession(ctx.params))
    .onRequest(methods.agent.session.fork, (ctx) => h.forkSession(ctx.params))
    .onRequest(methods.agent.session.close, (ctx) => h.closeSession(ctx.params))
    .onRequest(methods.agent.session.setMode, (ctx) => h.setSessionMode(ctx.params))
    .onRequest(methods.agent.session.setConfigOption, (ctx) => h.setSessionConfigOption(ctx.params))
    .onRequest(methods.agent.authenticate, (ctx) => h.authenticate(ctx.params))
    .onRequest(methods.agent.logout, (ctx) => h.logout(ctx.params))
    .onRequest(methods.agent.session.prompt, (ctx) => h.prompt(ctx.params, ctx))
    .onNotification(methods.agent.session.cancel, (ctx) => h.cancel(ctx.params))
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

runAcp();
