#!/usr/bin/env node
// dsh-acp: ACP (Agent Client Protocol) adapter for DeepSeek Harness.
//
// Speaks ACP v1 over stdin/stdout (newline-delimited JSON-RPC). Each prompt
// turn is executed by spawning `dsh --profile headless "<prompt>"` (per user
// choice, a fresh one-shot DSH session per turn). Output is streamed back to
// the client as agent_message_chunk updates, then a final result is returned.
//
// ACP clients can drive this adapter exactly like they drive claude-agent-acp;
// Obsidian's "Agent Client" plugin is a supported client.

import { agent as acpAgent, methods, ndJsonStream, RequestError } from "@agentclientprotocol/sdk";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";

// ---- Logging -------------------------------------------------------------
// stdout is reserved for ACP messages; everything else goes to stderr so it
// never corrupts the protocol stream (mirrors claude-agent-acp behavior).
const logDir = process.env.DSH_ACP_LOG_DIR;
let logFile = null;
if (logDir) {
  const { mkdirSync, appendFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  try {
    mkdirSync(logDir, { recursive: true });
    logFile = join(logDir, "dsh-acp.log");
    const write = (...args) => {
      try {
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

// ---- Configuration -------------------------------------------------------
// DSH_BIN defaults to "dsh" on PATH. GUI clients (e.g. Obsidian Agent Client)
// inherit a minimal environment that usually does NOT include the user's shell
// PATH additions (npm global bin), so set DSH_BIN explicitly when needed.
const DSH_BIN = process.env.DSH_BIN ?? "dsh";
const DSH_PROFILE = process.env.DSH_PROFILE ?? "headless";
const DSH_EXTRA_ARGS = (process.env.DSH_ARGS ?? "").split(" ").filter(Boolean);

function dshBaseArgs() {
  return ["--profile", DSH_PROFILE, ...DSH_EXTRA_ARGS];
}

// ---- Session state -------------------------------------------------------
// dsh-acp keeps only a lightweight in-memory index of sessions. Sessions are
// presumed stateless because every prompt turn spawns a fresh headless DSH
// invocation. cwd is honored so DSH runs in the workspace the client selects.
const sessions = new Map(); // sessionId -> { id, cwd, title, createdAt }

function newSessionId() {
  return `dsh-${randomUUID()}`;
}

// ---- Running DSH ---------------------------------------------------------
// Run `dsh --profile headless "<prompt>"` once. Resolves with the captured
// stdout text OR streams it via the optional onChunk callback.
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
      const text = chunk.toString();
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
        // DSH may have failed to boot (e.g. profile not initialized). Surface
        // the captured stderr to make failures debuggable over ACP.
        const detail = (err || out).trim() || `exit code ${code}`;
        reject(new Error(`dsh exited ${code}: ${detail.slice(0, 4000)}`));
      }
    });
  });
}

// ---- ACP handler helpers -------------------------------------------------
// Send a session/update notification to the client. On the agent side, this
// uses the client-notification method namespace (`client.session.update`).
function notifyUpdate(client, sessionId, update) {
  return client.notify(methods.client.session.update, { sessionId, update });
}

function textChunk(messageId, text) {
  return {
    messageId,
    content: { type: "text", text },
  };
}

// ---- Agent implementation ------------------------------------------------
function createAgent() {
  const handler = {
    async initialize(req) {
      return {
        protocolVersion: 1,
        agentCapabilities: {
          loadSession: false,
        },
        agentInfo: {
          name: "dsh-acp",
          title: "DeepSeek Harness",
          version: "0.1.0",
        },
      };
    },

    async newSession(params) {
      const id = newSessionId();
      const cwd = params.cwd ?? process.cwd();
      sessions.set(id, { id, cwd, title: params._meta?.title ?? "DSH", createdAt: new Date().toISOString() });
      return {
        sessionId: id,
        modes: {
          currentModeId: "default",
          availableModes: [
            { id: "default", name: "Default", description: "Standard DeepSeek Harness mode" },
          ],
        },
      };
    },

    async loadSession(params) {
      // Stateless adapter: loading an unknown session creates a new logical one.
      if (!sessions.has(params.sessionId)) {
        sessions.set(params.sessionId, {
          id: params.sessionId,
          cwd: params.cwd ?? process.cwd(),
          title: "DSH",
          createdAt: new Date().toISOString(),
        });
      }
      return { sessionId: params.sessionId, modes: DEFAULTS.initializeModes() };
    },

    async listSessions() {
      return { sessions: [...sessions.values()].map((s) => ({ sessionId: s.id, title: s.title })) };
    },

    async deleteSession(params) {
      sessions.delete(params.sessionId);
      return { deleted: params.sessionId };
    },

    async resumeSession(params) {
      if (!sessions.has(params.sessionId)) {
        throw new RequestError(`session ${params.sessionId} not found`);
      }
      return { sessionId: params.sessionId, modes: DEFAULTS.initializeModes() };
    },

    async closeSession() {
      return undefined;
    },

    async setSessionMode() {
      return undefined;
    },

    async setSessionConfigOption(params) {
      const session = sessions.get(params.sessionId);
      return { configOptions: session?.configOptions ?? [] };
    },

    async authenticate() {
      // No auth needed: DSH is a local CLI. Signals success without prompting.
      return undefined;
    },

    async logout() {
      return undefined;
    },

    async prompt(params, ctx) {
      const session = sessions.get(params.sessionId);
      const cwd = session?.cwd ?? process.cwd();
      const promptText = extractPromptText(params.prompt);

      if (logFile) console.log(`prompt session=${params.sessionId} cwd=${cwd} ${promptText.slice(0, 200)}`);

      const messageId = `msg-${randomUUID()}`;
      // Stream dsh output to the client as it is produced.
      let receivedChunks = false;
      try {
        const output = await runDsh(promptText, cwd, (chunk) => {
          receivedChunks = true;
          // Stream each emitted line as an agent_message_chunk update.
          const text = chunk;
          notifyUpdate(ctx.client, params.sessionId, {
            sessionUpdate: "agent_message_chunk",
            ...textChunk(messageId, text),
          }).catch((e) => console.log(`notify error: ${e}`));
        }, ctx.signal);

        // Guard: if nothing was streamed (or the process buffered everything),
        // synthesize at least one assistant message so the client has content.
        if (!receivedChunks) {
          await notifyUpdate(ctx.client, params.sessionId, {
            sessionUpdate: "agent_message_chunk",
            ...textChunk(messageId, output || "(no output)"),
          });
        }

        return {
          stopReason: "end_turn",
          usage: {
            totalTokens: 0,
            inputTokens: 0,
            outputTokens: 0,
          },
        };
      } catch (err) {
        if (err.message === "cancelled") {
          return { stopReason: "cancelled" };
        }
        const msg = `\n[dsh-acp error] ${err.message}\n`;
        await notifyUpdate(ctx.client, params.sessionId, {
          sessionUpdate: "agent_message_chunk",
          ...textChunk(messageId, msg),
        });
        return { stopReason: "end_turn", usage: { totalTokens: 0, inputTokens: 0, outputTokens: 0 } };
      }
    },

    async cancel(params) {
      // No-op: cancellation handled via AbortSignal in prompt().
      return undefined;
    },
  };

  return handler;
}

function extractPromptText(prompt) {
  if (typeof prompt === "string") return prompt;
  if (Array.isArray(prompt)) {
    return prompt
      .map((b) => (b?.type === "text" && typeof b.text === "string" ? b.text : ""))
      .join("\n");
  }
  if (prompt && Array.isArray(prompt.content)) {
    return prompt.content
      .map((b) => (b?.type === "text" && typeof b.text === "string" ? b.text : ""))
      .join("\n");
  }
  return String(prompt ?? "");
}

const DEFAULTS = {
  initializeModes: () => ({
    currentModeId: "default",
    availableModes: [{ id: "default", name: "Default", description: "Standard mode" }],
  }),
};

// ---- Wiring (mirrors claude-agent-acp runAcp) ----------------------------
function runAcp() {
  const input = nodeToWebWritable(process.stdout);
  const output = nodeToWebReadable(process.stdin);
  const stream = ndJsonStream(input, output);

  let agent;
  const h = createAgent();
  const connection = acpAgent({ name: "dsh-acp" })
    .onRequest(methods.agent.initialize, (ctx) => h.initialize(ctx.params))
    .onRequest(methods.agent.session.new, (ctx) => h.newSession(ctx.params))
    .onRequest(methods.agent.session.load, (ctx) => h.loadSession(ctx.params))
    .onRequest(methods.agent.session.list, (ctx) => h.listSessions(ctx.params))
    .onRequest(methods.agent.session.delete, (ctx) => h.deleteSession(ctx.params))
    .onRequest(methods.agent.session.resume, (ctx) => h.resumeSession(ctx.params))
    .onRequest(methods.agent.session.close, (ctx) => h.closeSession(ctx.params))
    .onRequest(methods.agent.session.setMode, (ctx) => h.setSessionMode(ctx.params))
    .onRequest(methods.agent.session.setConfigOption, (ctx) => h.setSessionConfigOption(ctx.params))
    .onRequest(methods.agent.authenticate, (ctx) => h.authenticate(ctx.params))
    .onRequest(methods.agent.logout, (ctx) => h.logout(ctx.params))
    .onRequest(methods.agent.session.prompt, (ctx) => h.prompt(ctx.params, ctx))
    .onNotification(methods.agent.session.cancel, (ctx) => h.cancel(ctx.params))
    .connect(stream);
  agent = { dispose: async () => process.exit(0) };

  connection.closed.then(() => process.exit(0));
  process.on("SIGTERM", () => process.exit(0));
  process.on("SIGINT", () => process.exit(0));
  process.stdin.resume();
  return { connection, agent };
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

const { connection, agent } = runAcp();
