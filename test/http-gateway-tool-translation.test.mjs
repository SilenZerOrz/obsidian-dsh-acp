// test/http-gateway-tool-translation.test.mjs — #95 Session A: tool 事件翻译层 (red).
//
// Drives the REAL registerHttpGateway -> handleSessionPrompt OFFICIAL branch
// (officialEnabled=true) end-to-end with a STUB LLM that requests a tool, then
// asserts the SSE frames the Obsidian/HTTP client receives carry the LEGACY
// shape (per spec docs/实施计划/dsh-acp-official-bridge-tool-translation-spec.md):
//
//   - NO frame with sessionUpdate:"tool_call"              (must be translated away)
//   - tool_call_update {status:"in_progress", title}       (synthesized from official start)
//   - tool_call_update {status:"completed", rawInput}      (rawInput backfilled from start)
//   - NO empty content:[] on the completed frame           (dropped)
//
// This is the RED test: today the gateway forwards apply() frames VERBATIM
// (lib/http-gateway.mjs onUpdate), so these assertions FAIL, printing the raw
// official frame sequence. The translation layer (lib/acp-tool-translation.mjs,
// wired at that onUpdate) makes it green.
//
// Uses only Spike fixtures (bootSpikeContext + tool-call stub) — no network, no
// API key, no env-gating. Stub MUST emit tool_call; see makeToolCallStub().

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";

import { registerHttpGateway } from "../lib/http-gateway.mjs";
import {
  STUB_PROVIDER,
  STUB_MODEL,
  STUB_NOOP_TOOL,
  STUB_TOOL_CALL_ID,
  STUB_NOOP_TOOL_NAME,
  makeToolCallStub,
} from "./fixtures/spike-llm-stub.mjs";
import { bootSpikeContext } from "./fixtures/spike-bootstrap.mjs";

let bootHandle;
let ctx;

before(async () => {
  bootHandle = await bootSpikeContext();
  ctx = bootHandle.ctx;
  ctx.llm.registerAdapter([STUB_PROVIDER], makeToolCallStub());
  // Register the noop tool on the SAME ctx the router mounts onto, so the agent
  // loop can resolve the schema + execute the stub's `get_cwd` call.
  ctx.tools.register({ ...STUB_NOOP_TOOL });
});

after(async () => {
  await bootHandle?.dispose();
});

function makeMockWebServer() {
  const handlers = new Map();
  return {
    handlers,
    register: (spec) => { handlers.set(spec.path, spec.handler); },
  };
}

function makeMockReqRes({ method = "POST", body = "" } = {}) {
  const req = Object.assign(new EventEmitter(), { method, headers: {}, destroy: () => {} });
  const writes = [];
  const res = {
    writeHead() {},
    write(chunk) { writes.push(String(chunk)); },
    end(chunk) {
      if (chunk !== undefined) writes.push(String(chunk));
      req.emit("__res_ended__");
    },
  };
  queueMicrotask(() => {
    if (body) req.emit("data", Buffer.from(body));
    req.emit("end");
  });
  return { req, res, writes };
}

// Parse SSE write buffer into [{event, data}] pairs — data = {method, params}.
function parseSse(writes) {
  const out = [];
  let cur = null;
  for (const w of writes) {
    for (const line of w.split("\n")) {
      if (line.startsWith("event: ")) { cur = { event: line.slice(7), data: null }; }
      else if (line.startsWith("data: ") && cur) { cur.data = JSON.parse(line.slice(6)); out.push(cur); cur = null; }
    }
  }
  return out;
}

// Project the SSE writes onto the list of session/update frames the client saw.
function collectUpdates(events) {
  return events
    .filter((e) => e.event === "sessionUpdate")
    .map((e) => e.data?.params?.update)
    .filter(Boolean);
}

// Compact one-line view of a frame for the failure dump (title/kind/content/rawInput).
function oneLine(u) {
  let body = `sessionUpdate=${u.sessionUpdate}`;
  for (const k of ["toolCallId", "status", "title", "kind"]) {
    if (u[k] !== undefined) body += ` ${k}=${JSON.stringify(u[k])}`;
  }
  const ci = u.content;
  if (ci !== undefined) body += ` content=${Array.isArray(ci) ? `[len=${ci.length}]` : JSON.stringify(ci)}`;
  if (u.rawInput !== undefined) body += ` rawInput=${JSON.stringify(u.rawInput)}`;
  if (u.messageId) body += ` messageId=${u.messageId.slice(0, 8)}`;
  if (u.content?.type) body += ` content.type=${u.content.type}`;
  return body;
}

function dumpFrames(label, frames) {
  const lines = frames.map((u, i) => `  [${i}] ${oneLine(u)}`).join("\n");
  return `${label} (${frames.length}):\n${lines}`;
}

// Read a rendered frame (~x2 for the noop tool's output schema) or rawInput.
async function drivePrompt(body) {
  const ws = makeMockWebServer();
  registerHttpGateway(ctx, ws, {
    officialEnabled: true,
    officialMountConfig: { provider: STUB_PROVIDER, model: STUB_MODEL },
  });
  const promptHandler = ws.handlers.get("/acp/proxy/session/prompt");
  assert.ok(promptHandler, "prompt route should be registered");

  const { req, res, writes } = makeMockReqRes({ method: "POST", body: JSON.stringify(body) });
  const ended = new Promise((r) => req.on("__res_ended__", r));
  await promptHandler(req, res);
  await Promise.race([ended, new Promise((_, rej) => setTimeout(() => rej(new Error("prompt SSE never ended")), 30000))]);
  return { events: parseSse(writes), writes };
}

test("Session A: tool 事件经翻译层后，SSE 输出 legacy 形状（tool_call_update，非 tool_call）", async () => {
  const BODY = {
    sessionId: "http-sess-tool-1",
    prompt: [{ type: "text", text: "use get_cwd" }],
  };
  const { events, writes } = await drivePrompt(BODY);
  const updates = collectUpdates(events);

  const FAIL = (msg) => {
    assert.fail(`${msg}\n${dumpFrames("raw sessionUpdate frames (verbatim from onUpdate)", updates)}`);
  };

  // 1) Legacy never emits sessionUpdate:"tool_call" — translation must map the
  //    official start frame into a tool_call_update (in_progress).
  const rawToolCall = updates.find((u) => u.sessionUpdate === "tool_call");
  if (rawToolCall) {
    FAIL(`translation layer missing: saw sessionUpdate:"tool_call" (${oneLine(rawToolCall)}) — must be translated to tool_call_update(in_progress)`);
  }

  // 2) The synthesized in_progress frame carries the title from the start frame.
  const inProgress = updates.filter(
    (u) => u.sessionUpdate === "tool_call_update" && u.status === "in_progress",
  );
  if (inProgress.length === 0) {
    FAIL("translation layer missing: no tool_call_update(in_progress) — official start frame must be synthesized into one");
  }
  if (inProgress[0].title !== STUB_NOOP_TOOL_NAME) {
    FAIL(`in_progress frame must carry title=${STUB_NOOP_TOOL_NAME} (from official start), got ${JSON.stringify(inProgress[0].title)}`);
  }

  // 3) The completed frame carries rawInput backfilled from the start frame.
  const finished = updates.filter(
    (u) => u.sessionUpdate === "tool_call_update" && u.status === "completed",
  );
  if (finished.length === 0) {
    FAIL("translation layer missing: no tool_call_update(completed) — official finish frame must be translated");
  }
  const fin = finished[0];
  // rawInput must ALWAYS be present on the legacy completed frame (spec rule 2 —
  // backfilled from the cached start.rawInput, because official finish omits it).
  if (fin.rawInput === undefined) {
    FAIL(`translation layer missing: completed frame has no rawInput (official finish omits it; must backfill from start). frame=${oneLine(fin)}`);
  }

  // 4) The official empty content:[] must be dropped (not forwarded as a frame).
  if (Array.isArray(fin.content) && fin.content.length === 0) {
    FAIL(`translation layer missing: completed frame carries empty content:[] (must be dropped). frame=${oneLine(fin)}`);
  }

  // 5) toolCallId passthrough is identical across in_progress + completed.
  if (inProgress[0].toolCallId !== fin.toolCallId) {
    FAIL(`toolCallId mismatch in_progress=${JSON.stringify(inProgress[0].toolCallId)} vs completed=${JSON.stringify(fin.toolCallId)}`);
  }
  assert.equal(fin.toolCallId, STUB_TOOL_CALL_ID, "toolCallId should be the stub's tool-call id");

  // 6) result event still carries stopReason (translation must not break the turn).
  const errors = events.filter((e) => e.event === "error");
  if (errors.length) {
    FAIL(`unexpected SSE error: ${JSON.stringify(errors[0].data)}`);
  }
  const results = events.filter((e) => e.event === "result");
  if (results.length !== 1 || !results[0].data.stopReason) {
    FAIL(`expected 1 result w/ stopReason, got ${results.length}`);
  }
  assert.ok(results[0].data.stopReason, "result carries stopReason");
});
