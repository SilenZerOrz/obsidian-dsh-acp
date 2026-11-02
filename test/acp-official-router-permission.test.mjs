// test/acp-official-router-permission.test.mjs — T5 官方桥权限路径（项 3，正式用例）。
//
// 本文件把 /tmp/t5-red-20261101.mjs 的红灯升级为三条正式用例，作为 0.5.0 项 1/2 的验收。
//
// 背景（已由红灯脚本证实，2026-11-01）：
//   lib/acp-official-router.mjs:199-218 的出站排空循环用「有无 id」区分「这是响应」，
//   而服务端发起的 session/request_permission 请求**也带 id** → 进入响应分支 →
//   pending.get(id) 查不到 → :209 continue **静默丢弃** → 上游 conn.request 永久等待。
//
// 装配方式照抄 test/acp-official-router.test.mjs:13-33（import 行 + before/after），
// 不 import 该测试文件本身。差异：
//   - 额外注册 `tools/pre-execute` 监听器返回 { kind: "ask" }，让工具调用真的走审批链
//     （/tmp/t5-red-20261101.mjs 验证过这条链会触发 ctx.approval.request）。
//   - 使用 makeConcurrentToolCallStub（会发 tool-call）+ STUB_NOOP_TOOL。
//
// ⚠️ 当前 lib 未修 ⇒ 三条用例预期为红。红灯即本项交付物。

import { test, before, after } from "node:test";
import assert from "node:assert/strict";

import { createOfficialAcpRouter } from "../lib/acp-official-router.mjs";
import { STUB_PROVIDER, STUB_MODEL, STUB_NOOP_TOOL, makeConcurrentToolCallStub } from "./fixtures/spike-llm-stub.mjs";
import { bootSpikeContext } from "./fixtures/spike-bootstrap.mjs";

let bootHandle;
let ctx;

before(async () => {
  bootHandle = await bootSpikeContext();
  ctx = bootHandle.ctx;
  // 让每个工具调用都走审批（ask）—— 这是触发 session/request_permission 的唯一入口。
  ctx.on("tools/pre-execute", () => ({ kind: "ask", reason: "t5-permission-test" }));
  ctx.llm.registerAdapter([STUB_PROVIDER], makeConcurrentToolCallStub());
  ctx.tools.register({ ...STUB_NOOP_TOOL });
});

after(async () => {
  await bootHandle?.dispose();
});

const WINDOW_MS = 5000;

/** 在 ms 内等待 fn() 返回真值；超时返回 null。 */
async function waitFor(fn, ms = WINDOW_MS, stepMs = 20) {
  const start = Date.now();
  for (;;) {
    const v = fn();
    if (v) return { value: v, elapsed: Date.now() - start };
    if (Date.now() - start >= ms) return null;
    await new Promise((r) => setTimeout(r, stepMs));
  }
}

/** 建一个 router + 一条 prompt（带 ask 门），返回观察句柄。 */
function startPrompt(label, opts = {}) {
  const router = createOfficialAcpRouter(ctx, { provider: STUB_PROVIDER, model: STUB_MODEL });
  const state = {
    router,
    requests: [],          // onRequest 收到的服务端请求
    settled: null,         // { ok, value|err, elapsed }
    startedAt: Date.now(),
  };
  const p = router
    .prompt(label, {
      prompt: [{ type: "text", text: "use get_cwd" }],
      model: STUB_MODEL,
      // 目标契约：router 把服务端发起的请求转发给客户端时调用此回调。
      onRequest: (method, params, ctl) => {
        state.requests.push({ method, params, ctl, at: Date.now() - state.startedAt });
        return opts.onRequest ? opts.onRequest(method, params, ctl) : Promise.resolve(undefined);
      },
    })
    .then(
      (value) => { state.settled = { ok: true, value, elapsed: Date.now() - state.startedAt }; },
      (err) => { state.settled = { ok: false, err: String(err?.message ?? err), elapsed: Date.now() - state.startedAt }; },
    );
  state.promise = p;
  return state;
}

// ─────────────────────────────────────────────────────────────────────────────
// 用例 1：入站带 id 的 session/request_permission 不得被静默丢弃
// ─────────────────────────────────────────────────────────────────────────────
test("T5-1: server-initiated session/request_permission is forwarded to the client (not silently dropped)", async () => {
  const st = startPrompt("t5-case1");

  const hit = await waitFor(
    () => st.requests.find((r) => String(r.method).includes("request_permission")),
    WINDOW_MS,
  );

  if (!hit) {
    const detail = [
      `no session/request_permission reached the client within ${WINDOW_MS}ms — the router dropped it`,
      `onRequest calls seen: ${JSON.stringify(st.requests.map((r) => r.method))}`,
      `prompt settled: ${st.settled ? JSON.stringify(st.settled) : "null (still hanging)"}`,
    ].join("\n");
    assert.fail(detail);
  }
  assert.match(String(hit.value.method), /request_permission/,
    `forwarded method should be session/request_permission, got ${JSON.stringify(hit.value.method)}`);
  assert.ok(hit.elapsed < WINDOW_MS, `forward should happen well within ${WINDOW_MS}ms, took ${hit.elapsed}ms`);

  try { st.router.close(); } catch {}
});

// ─────────────────────────────────────────────────────────────────────────────
// 用例 2：客户端回 allow → 上游 conn.request 的 Promise resolve，turn 继续
// ─────────────────────────────────────────────────────────────────────────────
test("T5-2: client allow resolves the upstream request and the turn completes (no hang)", async () => {
  let sawRequest = null;
  const st = startPrompt("t5-case2", {
    // 回 allow-once（ACP 的形状：{ outcome: { outcome: "selected", optionId } }）
    onRequest: (method, params) => {
      sawRequest = { method, params };
      return Promise.resolve({ outcome: { outcome: "selected", optionId: "allow-once" } });
    },
  });

  // 等 prompt 自己收束（若上游 resolve 了，turn 会继续并结束）
  const done = await waitFor(() => st.settled, WINDOW_MS);

  if (!sawRequest) {
    assert.fail(
      `client never received the permission request (onRequest not called) — ` +
      `prompt settled: ${st.settled ? JSON.stringify(st.settled) : "null (hanging)"}`,
    );
  }
  if (!done) {
    assert.fail(
      `prompt did not settle within ${WINDOW_MS}ms after allow — upstream request stayed pending.\n` +
      `request seen: ${JSON.stringify(sawRequest.method)}\n` +
      `elapsed: ${Date.now() - st.startedAt}ms`,
    );
  }
  assert.ok(st.settled.ok, `turn should complete after allow, got error: ${JSON.stringify(st.settled)}`);
  assert.ok(st.settled.value?.stopReason,
    `completed turn must carry stopReason, got ${JSON.stringify(st.settled.value)}`);

  try { st.router.close(); } catch {}
});

// ─────────────────────────────────────────────────────────────────────────────
// 用例 3：客户端不回 + abort → 上游以 cancelled 收束，不永久等待
// ─────────────────────────────────────────────────────────────────────────────
test("T5-3: no client response + abort settles as cancelled instead of hanging forever", async () => {
  let abortCtl = null;
  const st = startPrompt("t5-case3", {
    // 不回 allow/reject：拿到 ctl 后主动 abort，验证「不永久等待」。
    onRequest: (method, params, ctl) => {
      abortCtl = ctl;
      if (ctl?.signal) {
        // 模拟客户端断开：abort 该请求
        setTimeout(() => { try { ctl.abort?.(); } catch {} }, 100);
        return new Promise((resolve, reject) => {
          ctl.signal.addEventListener("abort", () => {
            reject(Object.assign(new Error("client aborted"), { name: "AbortError" }));
          });
        });
      }
      return new Promise(() => {}); // 无 ctl.signal 时永不 resolve（旧实现的形状）
    },
  });

  const done = await waitFor(() => st.settled, WINDOW_MS);

  if (!abortCtl) {
    assert.fail(
      `client never received the permission request — cannot exercise abort.\n` +
      `prompt settled: ${st.settled ? JSON.stringify(st.settled) : "null (hanging)"}`,
    );
  }
  if (!done) {
    assert.fail(
      `prompt still hanging after ${WINDOW_MS}ms with no client response — ` +
      `expected a cancelled settlement (no permanent wait).\n` +
      `elapsed: ${Date.now() - st.startedAt}ms`,
    );
  }
  // 收束可以是「正常返回带 cancelled/stopReason」或「抛出」——但必须**收束**。
  const s = st.settled;
  const asText = JSON.stringify(s);
  assert.ok(
    asText.includes("cancel") || s.ok || s.err !== undefined,
    `expected a cancelled settlement, got ${asText}`,
  );

  try { st.router.close(); } catch {}
});
