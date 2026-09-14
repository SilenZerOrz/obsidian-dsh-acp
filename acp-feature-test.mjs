#!/usr/bin/env node
// acp-feature-test.mjs — protocol-level verification for dsh-acp session
// features (list / fork / resume / capability declaration).
//
// Spawns the adapter with DSH_BIN=echo (stubbed backend) so only the ACP
// protocol layer is exercised, in an isolated DSH_HOME. Verifies:
//   1. initialize advertises sessionCapabilities { list, fork, resume, delete }
//   2. session/new creates a durable session
//   3. session/list returns it
//   4. session/fork duplicates it with a new id
//   5. session/resume opens an existing session
//   6. a prompt round-trips through echo and archives a user/assistant turn
//
// Uses only the generic ctx.request(...) client API (no helper sugar).
//
// P2: --runtime {spawn|long} flag selects which runtime mode the adapter
// uses. In a standalone-binary test (no cordis ctx), long mode will log
// "long mode init failed" and fall back to spawn (P1.0 placeholder behavior).

import { client, methods, ndJsonStream } from "@agentclientprotocol/sdk";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// CLI: --runtime spawn|long  (default: spawn, backward-compatible)
// CLI: --mock-llm           (long mode with fake cordis ctx, no real dsh)
function parseFlags(argv) {
  const idx = argv.indexOf("--runtime");
  let runtimeMode = "spawn";
  if (idx !== -1) {
    const v = argv[idx + 1];
    if (v !== "spawn" && v !== "long") {
      console.error(`Unknown --runtime value: ${v}; expected spawn|long`);
      process.exit(2);
    }
    runtimeMode = v;
  }
  const mockLlm = argv.includes("--mock-llm");
  if (mockLlm && runtimeMode !== "long") {
    console.error("--mock-llm requires --runtime long");
    process.exit(2);
  }
  return { runtimeMode, mockLlm };
}
const { runtimeMode, mockLlm } = parseFlags(process.argv.slice(2));

const workdir = mkdtempSync(join(tmpdir(), "dsh-acp-test-"));
const storeDir = join(workdir, "store");
const dshHome = join(workdir, "dshhome");

const app = client({ name: "dsh-acp-feature-test" });
const outputs = [];
app.onNotification(methods.client.session.update, (ctx) => {
  const u = ctx.params.update;
  // For --mock-llm: collect ALL sessionUpdate types (thought + text + tool + usage)
  // so we can prove the long bridge emits the full stream shape, not just text.
  if (mockLlm) {
    outputs.push(u);
  } else if (u.sessionUpdate === "agent_message_chunk") {
    outputs.push(u.content.text);
  }
});

const adapterBin = join(process.cwd(), "dsh-acp.mjs");

let failures = 0;
function check(name, cond, extra = "") {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.log(`  ✗ ${name} ${extra}`); }
}

function nodeToWebWritable(s) {
  return new WritableStream({ write(c) { return new Promise((res, rej) => s.write(Buffer.from(c), (e) => e ? rej(e) : res())); } });
}
function nodeToWebReadable(s) {
  return new ReadableStream({ start(c) { s.on("data", (d) => c.enqueue(new Uint8Array(d))); s.on("end", () => c.close()); } });
}

const child = spawn(process.execPath, [adapterBin], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    DSH_BIN: process.env.TEST_DSH_BIN || "echo",
    DSH_ACP_STORE_DIR: storeDir,
    DSH_HOME: dshHome,
    DSH_PROFILE: "headless",
    DSH_ACP_GC: "off",
    // P2: runtime-mode flag (resolved by dsh-acp.mjs's lib/runtime-switch).
    DSH_ACP_RUNTIME_MODE: runtimeMode,
    // P1.0: spawn fallback is on by default; long-mode init throws placeholder
    // so the adapter falls back to spawn and the protocol-layer test still runs.
    DSH_ACP_SPAWN_FALLBACK: "true",
    // P1.5 step 4: --mock-llm installs a fake cordis ctx that returns a
    // canned StreamChunk sequence. Used to exercise the long path end-to-end.
    ...(mockLlm ? { DSH_ACP_MOCK_LLM: "1", DSH_ACP_DEFAULT_MODEL_FOR_TEST: "default/test-model" } : {}),
  },
  stdio: ["pipe", "pipe", "pipe"],
});
child.stderr.on("data", (d) => process.stderr.write("[adapter] " + d));

const stream = ndJsonStream(nodeToWebWritable(child.stdin), nodeToWebReadable(child.stdout));

await app.connectWith(stream, async (ctx) => {
  console.log(`== runtime mode requested: ${runtimeMode} (headless profile will force spawn when no cordis ctx) ==`);
  // 1. capability declaration
  const init = await ctx.request(methods.agent.initialize, { protocolVersion: 1, clientCapabilities: {} });
  const caps = init.agentCapabilities || {};
  const sc = caps.sessionCapabilities || {};
  console.log("== initialize ==");
  console.log("  agentInfo:", JSON.stringify(init.agentInfo));
  console.log("  loadSession:", caps.loadSession, " sessionCapabilities:", JSON.stringify(sc));
  check("declares sessionCapabilities.list", !!sc.list);
  check("declares sessionCapabilities.fork", !!sc.fork);
  check("declares sessionCapabilities.resume", !!sc.resume);
  check("loadSession === true", caps.loadSession === true);

  // 2. new session
  const ns = await ctx.request(methods.agent.session.new, { cwd: workdir, mcpServers: [] });
  const s1 = ns.sessionId;
  console.log("== new ==", s1);
  check("new session created", !!s1);

  // 3. list
  const list1 = await ctx.request(methods.agent.session.list, { cwd: workdir });
  console.log("== list ==", JSON.stringify((list1.sessions || []).map((s) => s.title)));
  check("list returns >=1 session", (list1.sessions || []).length >= 1);

  // 6. prompt round-trips and archives
  outputs.length = 0;
  const pr = await ctx.request(methods.agent.session.prompt, { sessionId: s1, prompt: [{ type: "text", text: "hello from test" }] });
  if (mockLlm) {
    // --mock-llm path: outputs holds full sessionUpdate objects emitted by
    // long-runtime's LLMStreamBridge. Verify we saw reasoning + text + usage.
    const types = outputs.map((u) => u.sessionUpdate);
    console.log("== prompt (long+mock-llm) ==", JSON.stringify(types), "stopReason=", pr.stopReason);
    check("long runtime emitted agent_thought_chunk", types.includes("agent_thought_chunk"));
    check("long runtime emitted agent_message_chunk", types.includes("agent_message_chunk"));
    check("long runtime emitted usage_update", types.includes("usage_update"));
    const thoughtUpdates = outputs.filter((u) => u.sessionUpdate === "agent_thought_chunk");
    const thoughtText = thoughtUpdates.map((u) => u.content?.text ?? "").join("");
    check("thought chunk carries the canned reasoning text", thoughtText.includes("thinking"));
    // The streamed text-chunks include init="" + 2 deltas + 1 block-end snapshot.
    // The snapshot is authoritative (it contains "mock-long: " prefix that the
    // mock chunks only emit at block-end, not in the deltas). So we check the
    // final assembled text == prompt result.text, and that it equals the
    // expected canned message.
    const textUpdates = outputs.filter((u) => u.sessionUpdate === "agent_message_chunk");
    const finalSnapshot = textUpdates[textUpdates.length - 1]?.content?.text ?? "";
    check("final text block carries the canned message", finalSnapshot === "mock-long: hello world");
    check("prompt ended end_turn", pr.stopReason === "end_turn");
    // Skip archive/delete checks below: --mock-llm doesn't exercise archive paths.
    return;
  }
  const joined = outputs.join("");
  console.log("== prompt ==", JSON.stringify(joined), "stopReason=", pr.stopReason);
  check("prompt produced echo output", joined.length > 0);
  check("prompt ended end_turn", pr.stopReason === "end_turn");

  // 4. fork
  const fk = await ctx.request(methods.agent.session.fork, { sessionId: s1, cwd: workdir, mcpServers: [] });
  const forkId = fk.sessionId;
  console.log("== fork ==", forkId);
  check("fork returns new sessionId != source", !!forkId && forkId !== s1);

  // list after fork -> 2
  const list2 = await ctx.request(methods.agent.session.list, { cwd: workdir });
  const ids2 = (list2.sessions || []).map((s) => s.sessionId);
  console.log("== list after fork ==", ids2.length, "sessions");
  check("list after fork has 2 sessions", ids2.length === 2);
  check("forked session present", ids2.includes(forkId));

  // 5. resume original
  let resumeOk = false;
  try {
    const rs = await ctx.request(methods.agent.session.resume, { sessionId: s1, cwd: workdir });
    resumeOk = rs.sessionId === s1;
  } catch (e) { resumeOk = false; }
  console.log("== resume ==", resumeOk ? "OK" : "FAILED");
  check("resume returns original sessionId", resumeOk);

  // archive check
  let archived = false;
  try {
    for (const rootName of ["dsh-acp-archives", "sessions"]) {
      const rootPath = join(dshHome, rootName);
      if (!existsSync(rootPath)) continue;
      for (const enc of readdirSync(rootPath)) {
        const sub = join(rootPath, enc);
        for (const sid of existsSync(sub) ? readdirSync(sub) : []) {
          const log = join(sub, sid, "session.jsonl");
          if (existsSync(log) && readFileSync(log, "utf8").includes("hello from test")) archived = true;
        }
      }
    }
  } catch {}
  console.log("== archive ==", archived ? "user turn written to DSH_HOME/sessions" : "NOT FOUND");
  check("user message archived under DSH_HOME/sessions", archived);

  // 7. delete: remove on-disk archive dirs AND stop session/list from re-surfacing it
  // (REQ-01 regression: before the fix, deleteSession dropped only the index record,
  //  so scanArchives() re-surfaced the "deleted" session on the next list.)
  let archivalDir = null;
  try {
    const indexPath = join(storeDir, "dsh-acp-sessions.json");
    const json = JSON.parse(readFileSync(indexPath, "utf8"));
    const rec = json.sessions[s1];
    const enc = encodeWorkspaceForTest(workdir);
    for (const rootName of ["dsh-acp-archives", "sessions"]) {
      const cand = join(dshHome, rootName, enc, rec.archive);
      if (existsSync(cand)) archivalDir = cand;
    }
  } catch {}
  const hadArchiveDir = !!archivalDir;

  const del = await ctx.request(methods.agent.session.delete, { sessionId: s1 });
  const gone = archivalDir ? !existsSync(archivalDir) : true;
  console.log("== delete ==", del.deleted, "archiveDirGone=", gone);
  check("delete returns the deleted sessionId", del.deleted === s1);
  check("on-disk archive dir removed after delete", gone);
  if (hadArchiveDir && !gone) {
    console.log("    (remnant still exists at " + archivalDir + ")");
  }

  // list must not re-surface the deleted session (scanArchives no longer finds it)
  const list3 = await ctx.request(methods.agent.session.list, { cwd: workdir });
  const ids3 = (list3.sessions || []).map((s) => s.sessionId);
  console.log("== list after delete ==", ids3.length, "sessions");
  check("deleted session absent from session/list", !ids3.includes(s1));
});

await new Promise((r) => setTimeout(r, 300));
child.kill();
console.log(failures === 0 ? "\nALL FEATURE CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
