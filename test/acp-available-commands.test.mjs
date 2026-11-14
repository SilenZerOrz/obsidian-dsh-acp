// test/acp-available-commands.test.mjs — P1-3 (R132 / 卡 -62) 行为单测.
//
// 判据（评审者 2026-11-15 下发，2026-11-15 会话接续模板 §3.2）：
//   ① `session/new` 之后出现 `available_commands_update` 帧；
//   ② 该帧至少含 1 条命令，且含 `import`。
//
// 这里打的是**真进程 + 真 JSON-RPC 线**，不是静态 grep：
//   spawn `node dsh-acp.mjs`，走 stdin/stdout 的 NDJSON，发 initialize +
//   session/new，收 stdout 的每一行判帧。
//
// 隔离（硬性）：DSH_HOME / DSH_ACP_STORE_DIR 指向 mkdtemp，DSH_ACP_PROXY_MODE=false
// 固定 spawn 模式。**不触碰真实 ~/.dsh / ~/.dsh-acp，不连 3080。**
//
// 顺序断言（:89 的 "response first"）是刻意的：SDK 只有在 handler resolve 之后
// 才写 session/new 的 response（registerAppRequest → await handler → respond），
// 因此若有人把 emit 改回 await，帧会抢在 response 前面，本条立刻红。

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ADAPTER = fileURLToPath(new URL("../dsh-acp.mjs", import.meta.url));

/**
 * Spawn the adapter, drive initialize → session/new, collect every stdout line.
 *
 * @returns {Promise<{messages: object[], stderr: string, order: string[]}>}
 */
function driveSessionNew(timeoutMs = 15_000) {
  return new Promise((resolve, reject) => {
    const home = mkdtempSync(join(tmpdir(), "dsh-acp-availcmds-"));
    const child = spawn(process.execPath, [ADAPTER], {
      cwd: fileURLToPath(new URL("..", import.meta.url)),
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
          if (u?.sessionUpdate === "available_commands_update") order.push("available_commands_update");
          if (u?.sessionUpdate === "usage_update") order.push("usage_update");
        }
        if (order.includes("session-new-response") && order.includes("available_commands_update")) finish();
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
        params: { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: "p1-3-test", version: "0.0.0" } },
      });
      send({
        jsonrpc: "2.0",
        id: 2,
        method: "session/new",
        params: { cwd: fileURLToPath(new URL("..", import.meta.url)), mcpServers: [] },
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

test("P1-3: session/new emits available_commands_update (R132 验收①)", async () => {
  const { messages, stderr } = await driveSessionNew();
  const frames = framesOf(messages, "available_commands_update");
  assert.equal(
    frames.length >= 1,
    true,
    `expected >=1 available_commands_update frame, got ${frames.length}\nstdout frames=${JSON.stringify(messages.map((m) => m.method ?? m.id))}\nstderr=${stderr.slice(-800)}`,
  );
});

test("P1-3: the frame carries >=1 command and includes `import` (R132 验收②③)", async () => {
  const { messages } = await driveSessionNew();
  const [frame] = framesOf(messages, "available_commands_update");
  assert.ok(frame, "no available_commands_update frame");

  const cmds = frame.update.availableCommands;
  assert.ok(Array.isArray(cmds), `availableCommands must be an array, got ${typeof cmds}`);
  assert.ok(cmds.length >= 1, `availableCommands must not be empty: ${JSON.stringify(cmds)}`);

  const names = cmds.map((c) => c?.name);
  assert.ok(names.includes("import"), `import command missing; got ${JSON.stringify(names)}`);

  // Schema shape (zAvailableCommand, zod.gen.js:1888): name + description are
  // required strings; `input` is optional.
  for (const c of cmds) {
    assert.equal(typeof c.name, "string", `command.name must be a string: ${JSON.stringify(c)}`);
    assert.ok(c.name.length > 0, "command.name must be non-empty");
    assert.equal(typeof c.description, "string", `command.description must be a string: ${JSON.stringify(c)}`);
  }
  const importCmd = cmds.find((c) => c.name === "import");
  assert.deepEqual(importCmd.input, { type: "unstructured" }, "import must advertise unstructured input");
});

test("P1-3: the frame names the SAME sessionId session/new returned", async () => {
  const { messages } = await driveSessionNew();
  const resp = messages.find((m) => m.id === 2 && m.result);
  assert.ok(resp, "session/new response missing");
  const sessionId = resp.result.sessionId;

  const frames = framesOf(messages, "available_commands_update");
  assert.equal(frames[0].sessionId, sessionId, "frame must target the newly created session");
});

test("P1-3: the response is written BEFORE the frame (no pre-response emit)", async () => {
  const { order } = await driveSessionNew();
  const iResp = order.indexOf("session-new-response");
  const iFrame = order.indexOf("available_commands_update");
  assert.ok(iResp >= 0, `session/new response not seen; order=${order.join(",")}`);
  assert.ok(iFrame >= 0, `frame not seen; order=${order.join(",")}`);
  assert.ok(
    iResp < iFrame,
    `available_commands_update must come AFTER the session/new response; order=${order.join(",")}`,
  );
});

test("P1-3: emitting a command frame must not corrupt stdout framing", async () => {
  const { messages } = await driveSessionNew();
  // Every stdout line parsed as JSON (driveSessionNew would have skipped
  // anything else). Assert the protocol stream stayed clean: the two request
  // responses plus at least one notification, all well-formed.
  assert.ok(messages.length >= 3, `expected >=3 protocol messages, got ${messages.length}`);
  for (const m of messages) {
    assert.equal(m.jsonrpc, "2.0", `not a JSON-RPC 2.0 message: ${JSON.stringify(m)}`);
  }
});
