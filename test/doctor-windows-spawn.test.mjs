#!/usr/bin/env node
// test/doctor-windows-spawn.test.mjs — resolveDshSpawnSpec 的契约测试
//
// 背景（PR #1 / 26f2f10）：npm 全局安装的 dsh 在 Windows 上只有 .cmd/.ps1/sh
// 垫片。Node spawn（无 shell）对裸名不做 PATHEXT 解析（ENOENT），且 Node
// >= 18.20 出于 CVE-2024-27980 禁止无 shell 直接 spawn .cmd/.bat（EINVAL）。
// 因此适配器解析 cmd-shim 内的 JS 入口，改用 process.execPath 直连拉起。
//
// 本测试用 Object.defineProperty 临时改写 process.platform 来覆盖 win32
// 分支；用真实临时 .cmd 文件驱动 parseCmdShimEntry（含 %dp0% 替换）。
// 关键：非 win32 必须**原样透传**（回归保护——macOS/Linux 行为不得改变）。

import { mkdtempSync, writeFileSync, rmSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { strict as assert } from "node:assert";
import { test } from "node:test";

const { resolveDshSpawnSpec } = await import("../doctor.mjs");

/** 临时改写 process.platform，返回还原函数。 */
function withPlatform(value, fn) {
  const desc = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { value, configurable: true });
  try {
    return fn();
  } finally {
    Object.defineProperty(process, "platform", desc);
  }
}

/** 造一个临时 cmd-shim 文件（内容仿 npm cmd-shim 形态）。 */
function makeShim(dir, name, body) {
  const p = join(dir, name);
  writeFileSync(p, body);
  try { chmodSync(p, 0o755); } catch { /* win32 no-op */ }
  return p;
}

const NPM_SHIM_BODY = [
  "@ECHO off",
  "GOTO start",
  ":find_dp0",
  "SET dp0=%~dp0",
  "EXIT /b",
  ":start",
  "SETLOCAL",
  "CALL :find_dp0",
  "",
  'IF EXIST "%dp0%\\node.exe" (',
  '  SET "_prog=%dp0%\\node.exe"',
  ") ELSE (",
  '  SET "_prog=node"',
  "  SET PATHEXT=%PATHEXT:;.JS;=;%",
  ")",
  "",
  'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js" %*',
  "",
].join("\r\n");

// --- 非 win32：原样透传（回归保护） --------------------------------------

test("non-win32: binPath is passed through unchanged, prefixArgs empty", () => {
  withPlatform("darwin", () => {
    assert.deepEqual(resolveDshSpawnSpec("/usr/local/bin/dsh"), {
      cmd: "/usr/local/bin/dsh",
      prefixArgs: [],
    });
    assert.deepEqual(resolveDshSpawnSpec("dsh"), { cmd: "dsh", prefixArgs: [] });
  });
});

test("non-win32: linux behaves like darwin", () => {
  withPlatform("linux", () => {
    assert.deepEqual(resolveDshSpawnSpec("/opt/dsh"), {
      cmd: "/opt/dsh",
      prefixArgs: [],
    });
  });
});

// --- win32：显式 .cmd 垫片路径 → 解析 JS 入口，改用 node ---------------

test("win32: absolute .cmd shim → cmd=process.execPath, prefixArgs=[entry]", () => {
  const dir = mkdtempSync(join(tmpdir(), "dsh-acp-shim-"));
  try {
    const shim = makeShim(dir, "dsh.cmd", NPM_SHIM_BODY);
    withPlatform("win32", () => {
      const spec = resolveDshSpawnSpec(shim);
      assert.equal(spec.cmd, process.execPath, "must launch via node");
      assert.equal(spec.prefixArgs.length, 1);
      // %dp0% 必须被替换成垫片所在目录，且是绝对路径的 .js 入口
      assert.ok(
        /node_modules.*dsh.*lib.*bin\.js$/.test(spec.prefixArgs[0]),
        `entry must be the parsed JS path, got: ${spec.prefixArgs[0]}`,
      );
      assert.ok(
        spec.prefixArgs[0].startsWith(dir),
        `%dp0% must be substituted with the shim dir (${dir}), got: ${spec.prefixArgs[0]}`,
      );
      assert.ok(!/%dp0%/i.test(spec.prefixArgs[0]), "%dp0% must be fully replaced");
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("win32: .bat shim is treated like .cmd", () => {
  const dir = mkdtempSync(join(tmpdir(), "dsh-acp-shim-"));
  try {
    const shim = makeShim(dir, "dsh.bat", NPM_SHIM_BODY);
    withPlatform("win32", () => {
      const spec = resolveDshSpawnSpec(shim);
      assert.equal(spec.cmd, process.execPath);
      assert.equal(spec.prefixArgs.length, 1);
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- win32：裸名 → 在 PATH 上找 <name>.cmd ------------------------------

test("win32: bare name resolves to <name>.cmd found on PATH", () => {
  const dir = mkdtempSync(join(tmpdir(), "dsh-acp-path-"));
  const prevPath = process.env.PATH;
  try {
    makeShim(dir, "dsh.cmd", NPM_SHIM_BODY);
    process.env.PATH = dir;
    withPlatform("win32", () => {
      const spec = resolveDshSpawnSpec("dsh");
      assert.equal(spec.cmd, process.execPath, "must find dsh.cmd on PATH and use node");
      assert.equal(spec.prefixArgs.length, 1);
    });
  } finally {
    process.env.PATH = prevPath;
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- 边界：无 shim / 内容异常 ------------------------------------------

test("win32: bare name with no .cmd on PATH → falls back to bare binPath", () => {
  const emptyDir = mkdtempSync(join(tmpdir(), "dsh-acp-empty-"));
  const prevPath = process.env.PATH;
  try {
    process.env.PATH = emptyDir; // no dsh.cmd here
    withPlatform("win32", () => {
      assert.deepEqual(resolveDshSpawnSpec("dsh"), { cmd: "dsh", prefixArgs: [] });
    });
  } finally {
    process.env.PATH = prevPath;
    rmSync(emptyDir, { recursive: true, force: true });
  }
});

test("win32: .cmd shim with no quoted .js entry → falls back to the shim path", () => {
  const dir = mkdtempSync(join(tmpdir(), "dsh-acp-badshim-"));
  try {
    const shim = makeShim(dir, "dsh.cmd", "@ECHO off\r\nREM no js entry here\r\n");
    withPlatform("win32", () => {
      const spec = resolveDshSpawnSpec(shim);
      // Cannot parse → must NOT invent a node launch; surface the raw path.
      assert.deepEqual(spec, { cmd: shim, prefixArgs: [] });
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("win32: already .exe → no shim parsing, passed through", () => {
  withPlatform("win32", () => {
    assert.deepEqual(resolveDshSpawnSpec("C:\\tools\\dsh.exe"), {
      cmd: "C:\\tools\\dsh.exe",
      prefixArgs: [],
    });
  });
});

// --- 回归：detectDshBinary 仍是导出且 DSH_BIN 优先 -----------------------

test("detectDshBinary: DSH_BIN env wins", async () => {
  const { detectDshBinary } = await import("../doctor.mjs");
  const prev = process.env.DSH_BIN;
  try {
    process.env.DSH_BIN = "C:\\explicit\\dsh.cmd";
    assert.equal(detectDshBinary(), "C:\\explicit\\dsh.cmd");
  } finally {
    if (prev === undefined) delete process.env.DSH_BIN;
    else process.env.DSH_BIN = prev;
  }
});
