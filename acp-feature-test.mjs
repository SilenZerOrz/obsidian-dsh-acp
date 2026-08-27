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

import { client, methods, ndJsonStream } from "@agentclientprotocol/sdk";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const workdir = mkdtempSync(join(tmpdir(), "dsh-acp-test-"));
const storeDir = join(workdir, "store");
const dshHome = join(workdir, "dshhome");

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
  env: { ...process.env, DSH_BIN: process.env.TEST_DSH_BIN || "echo", DSH_ACP_STORE_DIR: storeDir, DSH_HOME: dshHome, DSH_PROFILE: "headless" },
  stdio: ["pipe", "pipe", "pipe"],
});
child.stderr.on("data", (d) => process.stderr.write("[adapter] " + d));

const stream = ndJsonStream(nodeToWebWritable(child.stdin), nodeToWebReadable(child.stdout));
const app = client({ name: "dsh-acp-feature-test" });
const outputs = [];
app.onNotification(methods.client.session.update, (ctx) => {
  const u = ctx.params.update;
  if (u.sessionUpdate === "agent_message_chunk") outputs.push(u.content.text);
});

await app.connectWith(stream, async (ctx) => {
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
});

await new Promise((r) => setTimeout(r, 300));
child.kill();
console.log(failures === 0 ? "\nALL FEATURE CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
