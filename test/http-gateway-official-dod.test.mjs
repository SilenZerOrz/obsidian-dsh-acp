// test/http-gateway-official-dod.test.mjs — Phase 3 DoD 三条 (#1/#2/#3) 真 LLM 验证.
//
// 复用 fixture (bootSpikeContext + QwenShenkeAdapter + createOfficialAcpRouter) +
// 复用官方 router + 真实推理模型（端点/模型由本地 dsh profile 配置解析，未写死）。
//
// ENV-GATED: 跳过整个文件若 DSH_ACP_REAL_LLM_KEY 未设.
// timeout: DSH_ACP_REAL_LLM_TIMEOUT (默认 60s).
//
// DoD #1 tool_call_update (in_progress + completed, 同 toolCallId)
// DoD #2 session/request_permission 弹窗 (5s 内出现则 PASS; 超 5s 不出现 = FAIL = 缺口)
// DoD #3 cwd 越权校验 (越权 cwd 出现 error/non-end_turn = PASS; 正常 end_turn = FAIL = 缺口)
//
// 不入 git (gitignored — 探索性 DoD 测试). 见 docs/实施计划/0.3.0-rc.1-known-gaps.md.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createOfficialAcpRouter } from "../lib/acp-official-router.mjs";
import { bootSpikeContext } from "./fixtures/spike-bootstrap.mjs";
import {
  QwenShenkeAdapter,
  QWEN_REAL_PROVIDER,
  qwenRealConfig,
  qwenRealEnabled,
} from "./fixtures/qwen-shenke-adapter.mjs";

const REAL_ENABLED = qwenRealEnabled();
const TIMEOUT_MS = Number(process.env.DSH_ACP_REAL_LLM_TIMEOUT ?? 60_000);
const PERMISSION_GRACE_MS = 5_000; // #2: 5s 内无 permission 帧 = FAIL

const NOOP_TOOL = {
  name: "get_cwd",
  description:
    "Return the absolute current working directory path as a single string.",
  parameters: { type: "object", properties: {}, additionalProperties: false },
  output: {
    schema: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
      additionalProperties: false,
    },
    render: (result) =>
      typeof result === "string" ? result : JSON.stringify(result),
  },
  async execute() {
    return { path: process.cwd() };
  },
};

const TOOL_PROMPT =
  "Use the get_cwd tool to find the current working directory, then reply with one short line giving that path.";

let bootOfficial;

before(async (t) => {
  if (!REAL_ENABLED) {
    t.skip();
    return;
  }
  process.stderr.write(
    `[dod] node=${process.version} timeout=${TIMEOUT_MS}ms base=${qwenRealConfig().base}\n`,
  );
  const cfg = qwenRealConfig();
  const adapter = new QwenShenkeAdapter(cfg);
  bootOfficial = await bootSpikeContext();
  bootOfficial.ctx.llm.registerAdapter([QWEN_REAL_PROVIDER], adapter);
  bootOfficial.ctx.tools.register({ ...NOOP_TOOL });
});

after(async () => {
  await bootOfficial?.dispose();
});

async function withinTimeout(p, label) {
  return Promise.race([
    p,
    new Promise((_, rej) =>
      setTimeout(
        () => rej(new Error(`${label} timed out after ${TIMEOUT_MS}ms`)),
        TIMEOUT_MS,
      ),
    ),
  ]);
}

async function runPrompt(promptText, opts = {}) {
  const cfg = qwenRealConfig();
  const router = createOfficialAcpRouter(bootOfficial.ctx, {
    provider: QWEN_REAL_PROVIDER,
    model: cfg.model,
  });
  const frames = [];
  let firstFrameAt = null;
  let lastActivityAt = null;
  try {
    const result = await withinTimeout(
      router.prompt(opts.sessionId ?? "dod-sess", {
        prompt: [{ type: "text", text: promptText }],
        model: cfg.model,
        onUpdate: (params) => {
          const now = Date.now();
          if (firstFrameAt === null) firstFrameAt = now;
          lastActivityAt = now;
          frames.push({ params, at: now });
        },
      }),
      opts.label ?? "prompt",
    );
    return { ok: true, frames, result, firstFrameAt, lastActivityAt };
  } catch (e) {
    return {
      ok: false,
      frames,
      error: e.message,
      firstFrameAt,
      lastActivityAt,
    };
  } finally {
    router.close();
  }
}

// ────────────────────────────────────────────────────────────
// DoD #1 — tool_call_update in_progress + completed (same toolCallId)
// ────────────────────────────────────────────────────────────
test(
  "DoD#1: official 路径 tool_call_update 两段 (in_progress + completed)",
  { skip: !REAL_ENABLED },
  async () => {
    const { ok, frames, error } = await runPrompt(TOOL_PROMPT, {
      label: "DoD#1",
      sessionId: "dod-1",
    });
    assert.ok(ok, `prompt 失败: ${error}`);
    const inProgress = frames
      .map((f) => f.params?.update)
      .filter(
        (u) =>
          u?.sessionUpdate === "tool_call_update" &&
          u?.status === "in_progress",
      );
    const completed = frames
      .map((f) => f.params?.update)
      .filter(
        (u) =>
          u?.sessionUpdate === "tool_call_update" &&
          u?.status === "completed",
      );
    process.stderr.write(
      `[DoD#1] frames=${frames.length} inProgress=${inProgress.length} completed=${completed.length}\n`,
    );
    assert.ok(
      inProgress.length >= 1,
      `DoD#1 FAIL: 没收到 tool_call_update{status:in_progress}`,
    );
    assert.ok(
      completed.length >= 1,
      `DoD#1 FAIL: 没收到 tool_call_update{status:completed}`,
    );
    // Same toolCallId across the two frames (per spec §0.3).
    const ipId = inProgress[0]?.toolCallId;
    const cmpId = completed[0]?.toolCallId;
    assert.equal(
      ipId,
      cmpId,
      `DoD#1: toolCallId 不一致 (in_progress=${ipId} vs completed=${cmpId})`,
    );
  },
);

// ────────────────────────────────────────────────────────────
// DoD #2 — session/request_permission 弹窗
// 5s 内无 permission 帧 = FAIL (缺口), 不 skip.
// ────────────────────────────────────────────────────────────
test(
  "DoD#2: official 路径 permission 弹窗 (5s 兜底)",
  { skip: !REAL_ENABLED },
  async () => {
    const startedAt = Date.now();
    // 自己拼一个版本: 5s 内若 frames 出现 permission 帧则立刻 resolve 测试.
    const cfg = qwenRealConfig();
    const router = createOfficialAcpRouter(bootOfficial.ctx, {
      provider: QWEN_REAL_PROVIDER,
      model: cfg.model,
    });
    const frames = [];
    let firstFrameAt = null;
    let permissionAt = null;
    const p = router
      .prompt("dod-2", {
        prompt: [{ type: "text", text: TOOL_PROMPT }],
        model: cfg.model,
        onUpdate: (params) => {
          const now = Date.now();
          if (firstFrameAt === null) firstFrameAt = now;
          frames.push({ params, at: now });
          // The router code (acp-official-router.mjs) does NOT emit
          // session/request_permission SSE 'request' frames (no PermissionGate
          // wired). Detect any frame carrying a permission request shape —
          // empirically: SSE 'request' event with method="session/request_permission"
          // arrives via _stream. Since the current router doesn't expose 'request'
          // frames, this is expected to FAIL until wiring is added.
          const method = params?.method ?? params?.update?.method;
          if (
            method === "session/request_permission" ||
            params?.update?.sessionUpdate === "permission_request"
          ) {
            permissionAt = now;
          }
        },
      })
      .then((result) => ({ ok: true, frames, result, firstFrameAt, permissionAt }))
      .catch((e) => ({
        ok: false,
        frames,
        error: e.message,
        firstFrameAt,
        permissionAt,
      }));

    // Watch for permission frame for PERMISSION_GRACE_MS, then race against full timeout.
    let resolved = null;
    const watchHandle = setInterval(() => {
      if (permissionAt !== null && resolved === null) {
        resolved = "permission";
        clearInterval(watchHandle);
        // already in flight; let the prompt settle (its own close path).
      }
      if (
        resolved === null &&
        Date.now() - startedAt > PERMISSION_GRACE_MS
      ) {
        resolved = "no-permission";
        clearInterval(watchHandle);
      }
    }, 250);

    const settled = await withinTimeout(p, "DoD#2").catch((e) => ({
      ok: false,
      error: e.message,
    }));
    clearInterval(watchHandle);

    process.stderr.write(
      `[DoD#2] frames=${frames.length} firstFrameAt=${
        firstFrameAt ? firstFrameAt - startedAt : "none"
      }ms permissionAt=${
        permissionAt ? permissionAt - startedAt : "none"
      }ms prompt.ok=${settled.ok}\n`,
    );

    if (permissionAt !== null) {
      assert.ok(
        settled.ok,
        `DoD#2 prompt 不该 fail 在 permission 帧出现后: ${settled.error}`,
      );
      return; // PASS
    }

    // No permission frame within grace window = FAIL (缺口).
    assert.fail(
      `DoD#2 FAIL: ${PERMISSION_GRACE_MS}ms 内无 session/request_permission 帧 (frames=${frames.length}, settled.ok=${settled.ok}${
        settled.error ? ", error=" + settled.error : ""
      }) — 缺口: 官方路径未挂 PermissionGate`,
    );
  },
);

// ────────────────────────────────────────────────────────────
// DoD #3 — cwd 越权校验
// 路由器 (acp-official-router.mjs) cwd: process.cwd() 写死, 不接受 opts.cwd.
// 故"越权 cwd = 当前 process.cwd()", 正常 in_progress + completed,
// 预期 FAIL (缺口). 但仍实测, 留数据.
// ────────────────────────────────────────────────────────────
test(
  "DoD#3: official 路径 cwd 越权校验",
  { skip: !REAL_ENABLED },
  async () => {
    // router.prompt 不接受 cwd opts. process.cwd() 是测试运行目录.
    // 尝试传 opts.cwd = "/etc" 看路由器是否忽略 / 是否被 dsh apply 校验.
    const cfg = qwenRealConfig();
    const router = createOfficialAcpRouter(bootOfficial.ctx, {
      provider: QWEN_REAL_PROVIDER,
      model: cfg.model,
    });
    const frames = [];
    let firstFrameAt = null;
    try {
      const result = await withinTimeout(
        router.prompt("dod-3", {
          prompt: [{ type: "text", text: TOOL_PROMPT }],
          model: cfg.model,
          cwd: "/etc", // 路由器代码忽略 — 仍用 process.cwd()
          onUpdate: (params) => {
            const now = Date.now();
            if (firstFrameAt === null) firstFrameAt = now;
            frames.push({ params, at: now });
          },
        }),
        "DoD#3",
      );
      process.stderr.write(
        `[DoD#3] cwd=/etc passed to router; result.stopReason=${result.stopReason}\n`,
      );
      // If we get here with stopReason="end_turn" and frames included
      // tool_call_update, the越权 cwd was NOT rejected → 缺口.
      const hadToolFrames = frames.some(
        (f) =>
          f.params?.update?.sessionUpdate === "tool_call_update" ||
          f.params?.update?.sessionUpdate === "tool_call",
      );
      if (
        result.stopReason === "end_turn" &&
        hadToolFrames
      ) {
        assert.fail(
          `DoD#3 FAIL: 越权 cwd=/etc 被接受 (stopReason=end_turn, 有 tool_call 帧) — 缺口: 官方路径未做 cwd 校验`,
        );
      }
      if (
        result.stopReason !== "end_turn" ||
        result.error !== undefined
      ) {
        // Some non-end-turn reason = rejection-like signal.
        process.stderr.write(
          `[DoD#3] ok PASS path: stopReason=${result.stopReason}\n`,
        );
        return;
      }
      assert.fail(
        `DoD#3 FAIL: 越权 cwd 未拒绝 (stopReason=${result.stopReason}, error=${result.error})`,
      );
    } catch (e) {
      // Catch from withinTimeout (timeout) OR thrown from router.prompt on
      // genuine cwd rejection. Distinguish:
      if (e.message?.includes("timed out")) {
        assert.fail(
          `DoD#3 FAIL: 越权 cwd 跑通但 prompt timeout (${e.message}) — 缺口: 官方路径既未拒, 也未正常完成`,
        );
        return;
      }
      // Genuine rejection = PASS.
      process.stderr.write(`[DoD#3] prompt rejected: ${e.message}\n`);
    } finally {
      router.close();
    }
  },
);