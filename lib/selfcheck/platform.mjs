// lib/selfcheck/platform.mjs — dsh CLI / 版本 / spawn 参数 / HTTP 网关探测
//
// 2026-10-13 重建。基于 lib/env-fix.mjs + lib/selfcheck/index.mjs 的 import 契约。

import { spawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, basename, dirname, delimiter } from "node:path";

// ---- 子进程运行（带超时 / 资源卫生） ---------------------------------------

/**
 * 同步运行一个子进程，强制 timeout，unref 定时器，消费 stdout/stderr。
 * @param {string} cmd
 * @param {string[]} args
 * @param {object} [opts]
 * @param {number} [opts.timeoutMs=10000]
 * @param {object} [opts.env]
 * @param {string} [opts.cwd]
 * @returns {Promise<{stdout:string, stderr:string, code:number, signal:string|null, timedOut:boolean}>}
 */
export function runCapture(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    const timeoutMs = opts.timeoutMs ?? 10000;
    const child = spawn(cmd, args, {
      env: opts.env ?? process.env,
      cwd: opts.cwd,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill("SIGKILL"); } catch {}
    }, timeoutMs);
    if (typeof timer.unref === "function") timer.unref();
    child.stdout.on("data", (d) => { stdout += d.toString("utf8"); });
    child.stderr.on("data", (d) => { stderr += d.toString("utf8"); });
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ stdout, stderr: (stderr + (stderr ? "\n" : "") + e.message), code: -1, signal: null, timedOut });
    });
    child.on("exit", (code, signal) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, code: code ?? -1, signal, timedOut });
    });
  });
}

// ---- dsh 二进制定位 --------------------------------------------------------

const PATH_CANDIDATES = [
  "/usr/local/bin/dsh",
  "/opt/homebrew/bin/dsh",
  join(homedir(), ".local", "bin", "dsh"),
  join(homedir(), ".npm-global", "bin", "dsh"),
  join(homedir(), ".cargo", "bin", "dsh"),
];

function which(bin) {
  const env = process.env.PATH ?? "";
  const exts = process.platform === "win32" ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";") : [""];
  for (const dir of env.split(delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const p = join(dir, bin + ext);
      if (existsSync(p)) return p;
    }
  }
  return null;
}

/**
 * 探测 dsh 二进制路径。PATH → 候选绝对路径 → null。
 */
export function detectDshBinary() {
  const fromPath = which("dsh");
  if (fromPath) return fromPath;
  for (const p of PATH_CANDIDATES) {
    if (existsSync(p)) return p;
  }
  return null;
}

/**
 * 运行 `dsh --version`，解析版本号。
 * @returns {Promise<{ok:boolean, version:string|null, raw:string, reason?:string}>}
 */
export async function probeDshVersion(bin) {
  const exe = bin || detectDshBinary();
  if (!exe) return { ok: false, version: null, raw: "", reason: "dsh binary not found" };
  const r = await runCapture(exe, ["--version"], { timeoutMs: 5000 });
  if (r.timedOut) return { ok: false, version: null, raw: r.stdout, reason: "timeout" };
  if (r.code !== 0) return { ok: false, version: null, raw: r.stdout, reason: `exit ${r.code}` };
  const m = r.stdout.match(/(\d+\.\d+\.\d+(?:-[\w.]+)?)/);
  return { ok: true, version: m ? m[1] : null, raw: r.stdout };
}

/**
 * 把 dsh 解析成可 spawn 的形态。Windows 上 dsh 可能是 .cmd / .ps1，需
 * 用 `node <entry>` 或 `cmd /c` 形式。
 * @returns {Promise<{cmd:string, args:string[], env:object}|null>}
 */
export async function resolveDshSpawnSpec() {
  const bin = detectDshBinary();
  if (!bin) return null;
  if (process.platform !== "win32") {
    return { cmd: bin, args: [], env: {} };
  }
  // Windows: 优先 node + .js 入口；否则 cmd /c <bin>
  const name = basename(bin).toLowerCase();
  if (name.endsWith(".cmd") || name.endsWith(".bat")) {
    return { cmd: "cmd.exe", args: ["/c", bin], env: {} };
  }
  if (name.endsWith(".ps1")) {
    return { cmd: "powershell.exe", args: ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", bin], env: {} };
  }
  return { cmd: bin, args: [], env: {} };
}

// ---- HTTP 网关探测（unref 定时器 + 响应体消费） -----------------------------

import http from "node:http";
import https from "node:https";
import { URL } from "node:url";

/**
 * 探测 dsh web 的 HTTP 网关。返回 { ok, mode?, longReady?, reason? }。
 * 资源卫生：定时器 unref + 响应体消费（避免 libuv 0xC0000409 on Windows）。
 * @param {string} baseUrl  e.g. "http://127.0.0.1:3080"
 * @param {object} [opts]
 * @param {number} [opts.timeoutMs=2000]
 * @param {string} [opts.path="/acp/proxy/probe"]
 */
export function probeGateway(baseUrl, opts = {}) {
  return new Promise((resolve) => {
    if (!baseUrl) {
      resolve({ ok: false, reason: "no baseUrl" });
      return;
    }
    let url;
    try { url = new URL(baseUrl); } catch (e) {
      resolve({ ok: false, reason: `bad baseUrl: ${e.message}` });
      return;
    }
    const timeoutMs = opts.timeoutMs ?? 2000;
    const probePath = opts.path ?? "/acp/proxy/probe";
    const lib = url.protocol === "https:" ? https : http;
    const req = lib.request({
      hostname: url.hostname,
      port: url.port || (url.protocol === "https:" ? 443 : 80),
      path: probePath,
      method: "GET",
      timeout: timeoutMs,
      headers: { "user-agent": "dsh-acp-selfcheck/1" },
    }, (res) => {
      // 消费响应体（关键：避免 socket hanging close）
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (c) => { body += c; });
      res.on("end", () => {
        if (res.statusCode && res.statusCode >= 200 && res.statusCode < 500) {
          let mode = null, longReady = null;
          try {
            const j = JSON.parse(body);
            mode = j.mode ?? null;
            longReady = j.longReady ?? null;
          } catch { /* non-JSON OK */ }
          resolve({ ok: true, mode, longReady, status: res.statusCode });
        } else {
          resolve({ ok: false, reason: `http ${res.statusCode}`, status: res.statusCode });
        }
      });
    });
    req.on("timeout", () => {
      try { req.destroy(); } catch {}
      resolve({ ok: false, reason: "timeout" });
    });
    req.on("error", (e) => {
      resolve({ ok: false, reason: e.code || e.message });
    });
    req.end();
  });
}
