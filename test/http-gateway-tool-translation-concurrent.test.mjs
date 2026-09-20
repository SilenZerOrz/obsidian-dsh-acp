// test/http-gateway-tool-translation-concurrent.test.mjs — #95 Session B.
//
// Drives TWO HTTP prompts (session A + session B) through ONE gateway/router/ctx,
// each with its own SSE writer, and asserts full ISOLATION:
//
//   1. each writer sees EXACTLY ONE distinct params.sessionId (its own applyId),
//      and A's ≠ B's (translator/Writer are per-prompt, no cross-session bleed)
//   2. idsA ∩ idsB = ∅ — the tool_call_update toolCallIds never cross sessions
//      (rawInput is backfilled per-session, cached from that session's own start)
//   3. content-based assertions only (no reliance on frame arrival ORDER).
//
// ⚠️ SERIALIZATION, NOT CONCURRENCY — READ THIS BEFORE "FIXING" THE TEST.
//   Empirically (ms-timestamp dump) dsh apply() runs the two sessions' agent
//   loops SEQUENTIALLY, NOT interleaved: session A's full frame sequence lands,
//   then session B's — every frame within the same ms, 2 alternation runs, never
//   A/B interleaving even though the ConcurrentToolCallStubAdapter inserts
//   setImmediate scheduling points between chunks.
//
//   Root cause is dsh apply()'s GLOBAL single-flight executor, NOT the stub:
//     - lib/acp-official-router.mjs:98 — one createOfficialAcpRouter = one
//       dshAcpApply(ctx,{stream}) = ONE outbound stream + ONE drain loop (:118)
//       consuming ALL sessions' notifications.
//     - dsh executor side: admitAcpPrompt + settleAfterQuiescence + whenIdle
//       ("admit, enqueue, and settle ONE prompt at whole-Agent quiescence") —
//       all sessions' prompts are QUEUED SERIAL and run one at a time.
//   So this test's isolation assertions are valid under SERIAL execution — they
//   DO NOT prove concurrency isolation. Real concurrency across sessions is dsh
//   apply()'s responsibility and OUT OF SCOPE for this router.
//
// Session B scope (per plan): two sessions, tool frames don't cross, writers
// correct, translators independent — under SERIAL scheduling. Because apply()
// already serializes, Session C's per-session mutex is UNNECESSARY; Session C
// narrows to error propagation / detach cleanup / cross-turn translator
// lifetime / unbounded-queue pressure.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";

import { registerHttpGateway } from "../lib/http-gateway.mjs";
import { STUB_PROVIDER, STUB_MODEL, STUB_NOOP_TOOL, makeConcurrentToolCallStub } from "./fixtures/spike-llm-stub.mjs";
import { bootSpikeContext } from "./fixtures/spike-bootstrap.mjs";

let bootHandle;
let ctx;

before(async () => {
  bootHandle = await bootSpikeContext();
  ctx = bootHandle.ctx;
  // ONE shared concurrent stub instance — Session B must be safe even when two
  // sessions pump the same adapter.
  ctx.llm.registerAdapter([STUB_PROVIDER], makeConcurrentToolCallStub());
  ctx.tools.register({ ...STUB_NOOP_TOOL });
});

after(async () => {
  await bootHandle?.dispose();
});

function makeMockWebServer() {
  const handlers = new Map();
  return { handlers, register: (spec) => handlers.set(spec.path, spec.handler) };
}

function makeMockReqRes({ body = "" } = {}) {
  const req = Object.assign(new EventEmitter(), { method: "POST", headers: {}, destroy: () => {} });
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

function parseSse(writes) {
  const out = [];
  let cur = null;
  for (const w of writes) {
    for (const line of w.split("\n")) {
      if (line.startsWith("event: ")) cur = { event: line.slice(7), data: null };
      else if (line.startsWith("data: ") && cur) { cur.data = JSON.parse(line.slice(6)); out.push(cur); cur = null; }
    }
  }
  return out;
}

function collectUpdates(events) {
  return events
    .filter((e) => e.event === "sessionUpdate")
    .map((e) => e.data?.params)
    .filter(Boolean); // {sessionId, update}
}

function oneLine(u) {
  let body = `sessionUpdate=${u.sessionUpdate}`;
  for (const k of ["toolCallId", "status", "title"]) if (u[k] !== undefined) body += ` ${k}=${JSON.stringify(u[k])}`;
  if (Array.isArray(u.content)) body += ` content=[len=${u.content.length}]`;
  if (u.rawInput !== undefined) body += ` rawInput=${JSON.stringify(u.rawInput)}`;
  return body;
}

function dumpFrames(label, ups) {
  const lines = ups.map((p, i) => `  [${i}] sessionId=${String(p.sessionId).slice(0, 8)} ${oneLine(p.update)}`).join("\n");
  return `${label} (${ups.length}):\n${lines}`;
}

const PROMPT_A = { sessionId: "http-sess-A", prompt: [{ type: "text", text: "use cwd project A" }] };
const PROMPT_B = { sessionId: "http-sess-B", prompt: [{ type: "text", text: "use cwd project B" }] };

test("Session B: two serial sessions — tool frames never cross wires, writers/translators isolated under apply() serialization", async () => {
  const ws = makeMockWebServer();
  registerHttpGateway(ctx, ws, {
    officialEnabled: true,
    officialMountConfig: { provider: STUB_PROVIDER, model: STUB_MODEL },
  });
  const promptHandler = ws.handlers.get("/acp/proxy/session/prompt");
  assert.ok(promptHandler, "prompt route should be registered");

  // Drive BOTH prompts truly concurrently (Promise.all), not sequentially.
  const rA = makeMockReqRes({ body: JSON.stringify(PROMPT_A) });
  const rB = makeMockReqRes({ body: JSON.stringify(PROMPT_B) });
  const aDone = new Promise((res) => rA.req.on("__res_ended__", res));
  const bDone = new Promise((res) => rB.req.on("__res_ended__", res));
  await Promise.all([
    (async () => { await promptHandler(rA.req, rA.res); await aDone; })(),
    (async () => { await promptHandler(rB.req, rB.res); await bDone; })(),
  ]);

  const upsA = collectUpdates(parseSse(rA.writes));
  const upsB = collectUpdates(parseSse(rB.writes));

  const FAIL = (msg) => {
    assert.fail(`${msg}\n${dumpFrames("writer A frames", upsA)}\n${dumpFrames("writer B frames", upsB)}`);
  };

  // -- PUMP sanity: both sessions' tool rounds must actually have run (each has
  //    a tool_call_update in_progress+completed). NOTE: these arrive SERIALLY
  //    (apply() single-flight), never interleaved — so we assert presence of the
  //    tool round per session, NOT order/overlap (order is apply()'s domain).
  const ta = upsA.filter((p) => p.update?.sessionUpdate === "tool_call_update").length;
  const tb = upsB.filter((p) => p.update?.sessionUpdate === "tool_call_update").length;
  if (ta < 2 || tb < 2) {
    FAIL(`expected ≥2 tool_call_update frames per session (in_progress+completed), got A=${ta} B=${tb}`);
  }

  // -- 1) each writer sees exactly ONE distinct sessionId, and A's ≠ B's.
  const sidsA = new Set(upsA.map((p) => p.sessionId));
  const sidsB = new Set(upsB.map((p) => p.sessionId));
  if (sidsA.size !== 1) FAIL(`writer A saw ${sidsA.size} distinct sessionIds: ${[...sidsA]}`);
  if (sidsB.size !== 1) FAIL(`writer B saw ${sidsB.size} distinct sessionIds: ${[...sidsB]}`);
  const sidA = [...sidsA][0];
  const sidB = [...sidsB][0];
  if (sidA === sidB) FAIL(`session A and B mapped to the SAME applyId ${sidA} — isolation broken`);

  // -- 1b) every A frame belongs to A's sessionId, every B frame to B's (no bleed).
  if (!upsA.every((p) => p.sessionId === sidA)) FAIL("writer A received a frame not tagged with A's sessionId");
  if (!upsB.every((p) => p.sessionId === sidB)) FAIL("writer B received a frame not tagged with B's sessionId");

  // -- 2) toolCallId sets are DISJOINT across sessions (no cross-talk).
  const idsA = new Set(upsA.map((p) => p.update?.toolCallId).filter(Boolean));
  const idsB = new Set(upsB.map((p) => p.update?.toolCallId).filter(Boolean));
  const shared = [...idsA].filter((id) => idsB.has(id));
  if (shared.length) {
    FAIL(`toolCallId cross-session leak: ${JSON.stringify(shared)} seen on both writers`);
  }

  // -- 2b) each session's in_progress -> completed tool frames are SELF-CONSISTENT
  //         (same toolCallId within a session) and never leak across sessions.
  //         NOTE: the official `tool_call`(start) has ALREADY been translated by
  //         the Session A layer into `tool_call_update in_progress` by the time
  //         these frames reach the SSE writer — so we key on in_progress (which
  //         carries the toolCallId + title), not the official `tool_call` frame.
  const inProgA = upsA.find((p) => p.update?.sessionUpdate === "tool_call_update" && p.update?.status === "in_progress");
  const finA = upsA.find((p) => p.update?.sessionUpdate === "tool_call_update" && p.update?.status === "completed");
  const inProgB = upsB.find((p) => p.update?.sessionUpdate === "tool_call_update" && p.update?.status === "in_progress");
  const finB = upsB.find((p) => p.update?.sessionUpdate === "tool_call_update" && p.update?.status === "completed");
  if (!inProgA || !finA || !inProgB || !finB) {
    FAIL(`missing in_progress/completed pairs — A:${!!inProgA}/${!!finA} B:${!!inProgB}/${!!finB}`);
  }
  // Same toolCallId within each session (start→finish continuity), distinct across.
  assert.equal(inProgA.update.toolCallId, finA.update.toolCallId, "A in_progress+completed must share toolCallId");
  assert.equal(inProgB.update.toolCallId, finB.update.toolCallId, "B in_progress+completed must share toolCallId");

  // -- 3) each session produced a legacy-shaped completed frame (rawInput backfilled, no empty content:[]).
  for (const [label, fin] of [["A", finA], ["B", finB]]) {
    const u = fin.update;
    if (u.status !== "completed") FAIL(`${label} completed frame status=${u.status}`);
    if (Array.isArray(u.content) && u.content.length === 0) FAIL(`${label} completed carried empty content:[] (not dropped)`);
    if (u.rawInput === undefined) FAIL(`${label} completed has no rawInput (not backfilled)`);
  }
  // Noop tool has no params → start.rawInput = {} → backfilled completed.rawInput = {}.
  assert.deepEqual(finA.update.rawInput, {}, "A completed.rawInput backfilled from A start (noop → {})");
  assert.deepEqual(finB.update.rawInput, {}, "B completed.rawInput backfilled from B start (noop → {})");

  const errorsA = parseSse(rA.writes).filter((e) => e.event === "error");
  const errorsB = parseSse(rB.writes).filter((e) => e.event === "error");
  if (errorsA.length || errorsB.length) {
    FAIL(`unexpected SSE error — A:${errorsA.length} B:${errorsB.length}`);
  }
});
