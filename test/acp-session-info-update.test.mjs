// test/acp-session-info-update.test.mjs — R146 (卡 -76) 行为单测.
//
// 判据（需求条目 R146）：会话建立后应向客户端发出
// `session/update { sessionUpdate: "session_info_update" }`，载荷至少含
// `title`（zSessionInfoUpdate 的全部字段都可选，见 SDK zod.gen.d.ts:7579）。
//
// 与 test/acp-available-commands.test.mjs 同一手法：打**真进程 + 真 JSON-RPC
// 线**——spawn `node dsh-acp.mjs`，走 stdin/stdout 的 NDJSON，发 initialize +
// session/new，逐行判帧。不是静态 grep。
//
// 隔离（硬性）：DSH_HOME / DSH_ACP_STORE_DIR 指向 mkdtemp，
// DSH_ACP_PROXY_MODE=false 固定 spawn 模式。**不触碰真实 ~/.dsh / ~/.dsh-acp，
// 不连 3080**；跑完 rmSync 临时目录。
//
// 顺序断言（"response first"）与 R132 同理：SDK 只在 handler resolve 之后才写
// request 的 response（registerAppRequest → await handler → respond），因此若有人
// 把 emit 改回同步/await，帧会抢在 response 前面，本条立刻红。

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ADAPTER = fileURLToPath(new URL("../dsh-acp.mjs", import.meta.url));
const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

/**
 * Spawn the adapter, drive initialize → session/new, collect every stdout line.
 *
 * @param {{ title?: string, timeoutMs?: number }} [opts]
 * @returns {Promise<{messages: object[], stderr: string, order: string[]}>}
 */
function driveSessionNew({ title, timeoutMs = 15_000 } = {}) {
  return new Promise((resolve, reject) => {
    const home = mkdtempSync(join(tmpdir(), "dsh-acp-sessioninfo-"));
    // `cwd` must be a real directory: validateCwdParam() rejects
    // session/new with -32602 otherwise (the frame would never be emitted).
    const cwd = REPO_ROOT;
    const child = spawn(process.execPath, [ADAPTER], {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        DSH_HOME: home,
        DSH_ACP_STORE_DIR: join(home, "store"),
        DSH_ACP_PROXY_MODE: "false", // 固定 spawn，别去探 3080
        DSH_ACP_RUNTIME_MODE: "spawn",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });

    const messages = [];
    const order = [];
    let stderr = "";
    let buf = "";

    const cleanup = () => {
      try { child.kill("SIGKILL"); } catch { /* already gone */ }
      try { rmSync(home, { recursive: true, force: true }); } catch { /* best-effort */ }
    };

    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(
        `timed out after ${timeoutMs}ms\norder=${order.join(",")}\nstderr=${stderr.slice(-1200)}`,
      ));
    }, timeoutMs);

    const finish = () => {
      clearTimeout(timer);
      cleanup();
      resolve({ messages, stderr, order });
    };

    child.stdout.on("data", (d) => {
      buf += d.toString();
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { continue; } // 非协议行不该出现；忽略而非炸
        messages.push(msg);
        if (msg.id === 2) order.push("session-new-response");
        if (msg.method === "session/update") {
          const u = msg.params?.update;
          if (u?.sessionUpdate === "session_info_update") order.push("session_info_update");
        }
        if (order.includes("session-new-response") && order.includes("session_info_update")) finish();
      }
    });

    child.stderr.on("data", (d) => { stderr += d.toString(); });
    child.on("error", (e) => { clearTimeout(timer); cleanup(); reject(e); });

    const send = (o) => child.stdin.write(JSON.stringify(o) + "\n");

    // Give the module a moment to finish its top-level imports before the first
    // line (the adapter prints its mode banner on stderr at import time).
    setTimeout(() => {
      send({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: "r146-test", version: "0.0.0" } },
      });
      send({
        jsonrpc: "2.0",
        id: 2,
        method: "session/new",
        params: {
          cwd,
          mcpServers: [],
          ...(title ? { _meta: { title } } : {}),
        },
      });
    }, 500);
  });
}

/** All session/update frames of one sessionUpdate type. */
function framesOf(messages, type) {
  return messages
    .filter((m) => m.method === "session/update" && m.params?.update?.sessionUpdate === type)
    .map((m) => m.params);
}

test("R146: session/new emits session_info_update", async () => {
  const { messages, stderr } = await driveSessionNew();
  const frames = framesOf(messages, "session_info_update");
  assert.equal(
    frames.length >= 1,
    true,
    `expected >=1 session_info_update frame, got ${frames.length}\n` +
      `stdout frames=${JSON.stringify(messages.map((m) => m.method ?? m.id))}\n` +
      `stderr=${stderr.slice(-800)}`,
  );
});

test("R146: the frame targets the sessionId session/new returned", async () => {
  const { messages } = await driveSessionNew();
  const resp = messages.find((m) => m.id === 2 && m.result);
  assert.ok(resp, "session/new response missing");
  const frames = framesOf(messages, "session_info_update");
  assert.ok(frames.length >= 1, "no session_info_update frame");
  assert.equal(frames[0].sessionId, resp.result.sessionId, "frame must target the newly created session");
});

test("R146: the frame carries a non-empty title and an ISO-8601 updatedAt", async () => {
  const { messages } = await driveSessionNew();
  const [frame] = framesOf(messages, "session_info_update");
  assert.ok(frame, "no session_info_update frame");

  // zSessionInfoUpdate (zod.gen.d.ts:7579): title / updatedAt are optional
  // nullable strings — but a frame with both empty says nothing, so we require
  // the title (the payload this adapter promises) and validate the timestamp
  // shape whenever present.
  const { title, updatedAt } = frame.update ?? {};
  assert.equal(typeof title, "string", `title must be a string, got ${JSON.stringify(title)}`);
  assert.ok(title.length > 0, "title must be non-empty");

  if (updatedAt !== undefined && updatedAt !== null) {
    assert.equal(typeof updatedAt, "string", `updatedAt must be a string, got ${typeof updatedAt}`);
    const ms = Date.parse(updatedAt);
    assert.equal(Number.isFinite(ms), true, `updatedAt must be an ISO-8601 timestamp, got ${JSON.stringify(updatedAt)}`);
  }
});

test("R146: a client-supplied _meta.title is published back as the frame title", async () => {
  const want = "R146 面板标题探针";
  const { messages } = await driveSessionNew({ title: want });
  const [frame] = framesOf(messages, "session_info_update");
  assert.ok(frame, "no session_info_update frame");
  assert.equal(frame.update.title, want, "frame title must be the session title");
});

test("R146: the response is written BEFORE the frame (no pre-response emit)", async () => {
  const { order } = await driveSessionNew();
  const iResp = order.indexOf("session-new-response");
  const iFrame = order.indexOf("session_info_update");
  assert.ok(iResp >= 0, `session/new response not seen; order=${order.join(",")}`);
  assert.ok(iFrame >= 0, `frame not seen; order=${order.join(",")}`);
  assert.ok(
    iResp < iFrame,
    `session_info_update must come AFTER the session/new response; order=${order.join(",")}`,
  );
});

test("R146: emitting the info frame must not corrupt stdout framing", async () => {
  const { messages } = await driveSessionNew();
  // Every stdout line parsed as JSON (driveSessionNew skips anything else).
  // Assert the protocol stream stayed clean: the two responses plus at least
  // one notification, all well-formed JSON-RPC 2.0.
  assert.ok(messages.length >= 3, `expected >=3 protocol messages, got ${messages.length}`);
  for (const m of messages) {
    assert.equal(m.jsonrpc, "2.0", `not a JSON-RPC 2.0 message: ${JSON.stringify(m)}`);
  }
});

// --- 验收① ：一轮成功 prompt 之后也要发该帧（updatedAt 刷新） ---------------
//
// 用一个 stub dsh 二进制（DSH_BIN → 只 echo 一行并 exit 0）+ 纯文本路径
// （DSH_ACP_NO_HEADLESS_JSON=1），把一轮 spawn prompt 打进真进程。这样无需
// 真 LLM、无需宿主，也能验证「prompt 成功后 prompt() 末尾会再发一帧」。

/**
 * Spawn the adapter with a stub dsh, drive initialize → session/new →
 * session/prompt, and collect every session/update frame.
 *
 * @returns {Promise<{frames: object[], promptResult: object|undefined, stderr: string}>}
 */
function driveSuccessfulPrompt(timeoutMs = 20_000) {
  return new Promise((resolve, reject) => {
    const home = mkdtempSync(join(tmpdir(), "dsh-acp-sessioninfo-prompt-"));
    const binDir = join(home, "bin");
    const stub = join(binDir, "dsh-stub");
    mkdirSync(binDir, { recursive: true });
    writeFileSync(stub, "#!/bin/sh\necho 'R146 canned answer'\nexit 0\n", "utf8");
    chmodSync(stub, 0o755);

    const child = spawn(process.execPath, [ADAPTER], {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        DSH_HOME: home,
        DSH_ACP_STORE_DIR: join(home, "store"),
        DSH_ACP_PROXY_MODE: "false", // 固定 spawn，别去探 3080
        DSH_ACP_RUNTIME_MODE: "spawn",
        DSH_ACP_SPAWN_PROFILE: "headless",
        DSH_BIN: stub,
        DSH_ACP_NO_HEADLESS_JSON: "1", // 走纯文本路径，桩二进制只需 echo
      },
      stdio: ["pipe", "pipe", "pipe"],
    });

    const messages = [];
    let stderr = "";
    let buf = "";
    let sessionId;

    const cleanup = () => {
      try { child.kill("SIGKILL"); } catch { /* already gone */ }
      try { rmSync(home, { recursive: true, force: true }); } catch { /* best-effort */ }
    };

    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`timed out after ${timeoutMs}ms\nstderr=${stderr.slice(-1200)}`));
    }, timeoutMs);

    const finish = () => {
      clearTimeout(timer);
      cleanup();
      resolve({
        frames: messages.filter((m) => m.method === "session/update").map((m) => m.params),
        promptResult: messages.find((m) => m.id === 3)?.result,
        stderr,
      });
    };

    child.stdout.on("data", (d) => {
      buf += d.toString();
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        messages.push(msg);
        if (msg.id === 2 && msg.result) sessionId = msg.result.sessionId;
      }
    });

    child.stderr.on("data", (d) => { stderr += d.toString(); });
    child.on("error", (e) => { clearTimeout(timer); cleanup(); reject(e); });

    const send = (o) => child.stdin.write(JSON.stringify(o) + "\n");

    setTimeout(() => {
      send({
        jsonrpc: "2.0", id: 1, method: "initialize",
        params: { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: "r146-prompt-test", version: "0.0.0" } },
      });
      send({ jsonrpc: "2.0", id: 2, method: "session/new", params: { cwd: REPO_ROOT, mcpServers: [] } });
      const poll = setInterval(() => {
        if (!sessionId) return;
        clearInterval(poll);
        send({
          jsonrpc: "2.0", id: 3, method: "session/prompt",
          params: { sessionId, prompt: [{ type: "text", text: "hello" }] },
        });
        const done = setInterval(() => {
          if (messages.some((m) => m.id === 3 && m.result)) { clearInterval(done); finish(); }
        }, 50);
      }, 50);
    }, 500);
  });
}

test("R146 验收①: a successful prompt emits session_info_update again (updatedAt refresh)", async () => {
  const { frames, promptResult, stderr } = await driveSuccessfulPrompt();
  assert.ok(promptResult, `session/prompt produced no result\nstderr=${stderr.slice(-800)}`);
  assert.equal(promptResult.stopReason, "end_turn", "the stubbed turn must finish cleanly");

  const info = frames.filter((f) => f?.update?.sessionUpdate === "session_info_update");
  assert.ok(
    info.length >= 2,
    `expected >=2 session_info_update frames (session/new + post-prompt), got ${info.length}\n` +
      `frames=${JSON.stringify(frames.map((f) => f?.update?.sessionUpdate))}\nstderr=${stderr.slice(-800)}`,
  );

  // The post-prompt frame must carry the turn's activity time, i.e. a stamp
  // at or after the session/new one — recordMessage() wrote it during prompt.
  const stamps = info.map((f) => Date.parse(f.update.updatedAt)).filter(Number.isFinite);
  assert.ok(stamps.length >= 2, `both frames need a parseable updatedAt: ${JSON.stringify(info)}`);
  assert.ok(
    stamps[stamps.length - 1] >= stamps[0],
    `post-prompt updatedAt must not predate the session/new one: ${JSON.stringify(info.map((f) => f.update.updatedAt))}`,
  );
});
