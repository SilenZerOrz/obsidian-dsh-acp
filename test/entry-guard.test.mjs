// test/entry-guard.test.mjs — 回归：入口守卫经符号链接调用应正常工作。
//
// 背景（Phase 7-A, 0.3.5/0.3.6）：doctor.mjs 入口守卫用
//   process.argv[1] === fileURLToPath(import.meta.url)
// 比较；macOS `/tmp → /private/tmp` 符号链接下，argv[1]（未解析符号链接）与
// import.meta.url（已解析）字符串不等 → 守卫 false → doctor 静默 exit 0。
// 0.3.7 用 realpathSync 归一化修复。
//
// ⚠️ 关键：必须用**显式 `/tmp`**（Unix）来真正触发符号链接场景；
// `os.tmpdir()` 在 macOS 返回 `/var/folders/...`（非符号链接）→ 测不到 bug。
// Linux 上 `/tmp` 非符号链接 → 守卫本就工作，测试仍应通过。

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = dirname(fileURLToPath(import.meta.url)); // test/
const DOCTOR = join(REPO, "..", "doctor.mjs");

test("entry guard: doctor runs through a symlinked path", () => {
  // 优先用 /tmp（macOS 上是 /private/tmp 的符号链接 → 触发原 bug）；
  // 无 /tmp 则回落 os.tmpdir()（Linux/CI，守卫本就工作，仍应通过）。
  const base = existsSync("/tmp") ? "/tmp" : undefined;
  const dir = mkdtempSync(base ? join(base, "dsh-acp-eg-") : undefined);
  const link = join(dir, "doctor-link.mjs");
  try {
    symlinkSync(DOCTOR, link);
    const out = execFileSync(process.execPath, [link, "doctor"], {
      encoding: "utf8",
      timeout: 20000,
      env: { ...process.env },
    });
    // 修复前：符号链接下为静默空输出（0 行）；修复后：有诊断内容。
    assert.ok(out.trim().length > 0, "doctor 经符号链接调用应输出诊断内容（非空）");
    assert.match(out, /obsidian-dsh-acp doctor/, "应打印 doctor 标题行");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("entry guard: doctor runs via direct path (control)", () => {
  const out = execFileSync(process.execPath, [DOCTOR, "doctor"], {
    encoding: "utf8",
    timeout: 20000,
    env: { ...process.env },
  });
  assert.match(out, /obsidian-dsh-acp doctor/, "直连路径应正常输出");
});
