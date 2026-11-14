// test/r145-initialize-capabilities.test.mjs — R145 / 卡 -75 行为单测.
//
// 判据（任务卡 -75 验收口径）：
//   ① `initialize` 回包出现 `promptCapabilities` 与 `mcpCapabilities`；
//   ② `agentInfo.version` === package.json 的 version（不再硬编码 "0.2.0"）；
//   ③ `HTTP_GATEWAY_VERSION` === package.json 的 version（不再硬编码 "0.2.6-dev"）。
//
// 与 acp-available-commands.test.mjs 同样打真进程 + 真 JSON-RPC 线：
// spawn `node dsh-acp.mjs`，发 initialize，收 stdout 的响应帧。
//
// 隔离（硬性）：DSH_HOME / DSH_ACP_STORE_DIR 指向 mkdtemp，DSH_ACP_PROXY_MODE=false
// 固定 spawn 模式，DSH_BIN 指向不存在的路径（本测试不跑 prompt，无需真 dsh）。
// 不触碰真实 ~/.dsh / ~/.dsh-acp，不连 3080。

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { HTTP_GATEWAY_VERSION } from "../lib/http-gateway.mjs";

const REPO = fileURLToPath(new URL("..", import.meta.url));
const ADAPTER = join(REPO, "dsh-acp.mjs");
const PKG_VERSION = JSON.parse(readFileSync(join(REPO, "package.json"), "utf8")).version;

/** Spawn the adapter and return the `initialize` response result. */
function driveInitialize(timeoutMs = 15_000) {
  return new Promise((resolve, reject) => {
    const home = mkdtempSync(join(tmpdir(), "dsh-acp-r145-"));
    const child = spawn(process.execPath, [ADAPTER], {
      cwd: REPO,
      env: {
        ...process.env,
        DSH_HOME: join(home, "home"),
        DSH_ACP_STORE_DIR: join(home, "store"),
        DSH_ACP_PROXY_MODE: "false", // 固定 spawn，别去探 3080
        DSH_ACP_RUNTIME_MODE: "spawn",
        DSH_BIN: join(home, "no-such-dsh"), // 本测试不跑 prompt
      },
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stderr = "";
    let buf = "";
    const cleanup = () => {
      try { child.kill("SIGKILL"); } catch { /* already gone */ }
      try { rmSync(home, { recursive: true, force: true }); } catch { /* best-effort */ }
    };

    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`timed out after ${timeoutMs}ms\nstderr=${stderr.slice(-1200)}`));
    }, timeoutMs);

    child.stdout.on("data", (d) => {
      buf += d.toString();
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg.id === 1 && msg.result) {
          clearTimeout(timer);
          cleanup();
          resolve({ result: msg.result, stderr });
        }
      }
    });
    child.stderr.on("data", (d) => { stderr += d.toString(); });
    child.on("error", (e) => { clearTimeout(timer); cleanup(); reject(e); });

    const send = (o) => child.stdin.write(JSON.stringify(o) + "\n");
    setTimeout(() => {
      send({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: "r145-test", version: "0.0.0" } },
      });
    }, 500);
  });
}

test("R145: initialize declares promptCapabilities + mcpCapabilities (验收③)", async () => {
  const { result, stderr } = await driveInitialize();
  const caps = result.agentCapabilities ?? {};
  assert.ok(caps.promptCapabilities, `promptCapabilities missing; caps=${JSON.stringify(caps)}\nstderr=${stderr.slice(-600)}`);
  assert.ok(caps.mcpCapabilities, `mcpCapabilities missing; caps=${JSON.stringify(caps)}`);
  // 如实声明：当前 prompt 通路只保留 text 块（extractPromptText），
  // 且未挂载任何 MCP 传输 —— 三个布尔值必须都是 false。
  assert.equal(caps.promptCapabilities.image, false);
  assert.equal(caps.promptCapabilities.audio, false);
  assert.equal(caps.promptCapabilities.embeddedContext, false);
  assert.equal(caps.mcpCapabilities.http, false);
  assert.equal(caps.mcpCapabilities.sse, false);
  // protocolVersion 不得被本任务改动。
  assert.equal(result.protocolVersion, 1);
});

test("R145: agentInfo.version is the package.json version (验收①/③)", async () => {
  const { result } = await driveInitialize();
  assert.equal(result.agentInfo?.version, PKG_VERSION);
  assert.equal(result.agentInfo?.name, "dsh-acp");
});

test("R145: HTTP_GATEWAY_VERSION is the package.json version (验收①)", () => {
  assert.equal(HTTP_GATEWAY_VERSION, PKG_VERSION);
});
