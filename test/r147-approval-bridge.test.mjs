// test/r147-approval-bridge.test.mjs — R147 审批桥契约（真机 T5 挂死的回归护栏）。
//
// 真机根因（2026-11-15，活宿主取证）：
//   `approval/request` 是 cordis 的 **app 级 waterfall**（hook 列表全局共享，按注册顺序
//   由外向内执行）。宿主里已有监听器在本插件挂载**之前**注册，且第一个永久不 settle
//   （@deepseek-ai/dsh-api-remotes 的 forwardWaterfall 把请求推给 Remote 消费者并 await，
//   没有消费者应答就永不返回）⇒ `approval/asked` 之后没有 `approval/decided`，
//   session/request_permission 帧永远发不出，turn 挂死到 abort。
//
// 修法契约（lib/acp-official-router.mjs installApprovalBridge）：
//   1. 以 `{ global: true, prepend: true }` 注册 ⇒ 排在整条链最前，不被挡住；
//   2. 命中本 router 的会话 ⇒ 端到客户端问一次，**不回 next()**（链上其余监听器不得再答）；
//   3. 不是本 router 的会话 ⇒ 立刻 `next()`，宿主的自有应答者（Web GUI 会话）不受影响。
//
// 本文件用「先注册的探针监听器」把 1/3 两条钉死：
//   用例 A 有 onRequest（我们的会话）⇒ 探针不得被调用（证明 prepend 生效、没有放行后续链）；
//   用例 B 无 onRequest（非我们的会话）⇒ 探针必须被调用（证明 next() 放行、没有影子劫持）。
// 若 prepend 被去掉，用例 A 会红（探针先答，onRequest 收不到请求）。

import { test, before, after } from "node:test";
import assert from "node:assert/strict";

import { createOfficialAcpRouter } from "../lib/acp-official-router.mjs";
import { STUB_PROVIDER, STUB_MODEL, STUB_NOOP_TOOL, makeConcurrentToolCallStub } from "./fixtures/spike-llm-stub.mjs";
import { bootSpikeContext } from "./fixtures/spike-bootstrap.mjs";

let bootHandle;
let ctx;
/** 先于 router 挂载注册的「更早监听器」——代表宿主里挡在链前的既有监听器。 */
let earlyProbeCalls = 0;
let disposeEarlyProbe = null;

before(async () => {
  bootHandle = await bootSpikeContext();
  ctx = bootHandle.ctx;
  ctx.on("tools/pre-execute", () => ({ kind: "ask", reason: "r147-bridge-test" }));
  ctx.llm.registerAdapter([STUB_PROVIDER], makeConcurrentToolCallStub());
  ctx.tools.register({ ...STUB_NOOP_TOOL });
  disposeEarlyProbe = ctx.on("approval/request", () => {
    earlyProbeCalls += 1;
    return "rejected";
  });
});

after(async () => {
  try { disposeEarlyProbe?.(); } catch {}
  await bootHandle?.dispose();
});

const WINDOW_MS = 5000;

async function waitFor(fn, ms = WINDOW_MS, stepMs = 20) {
  const start = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() - start >= ms) return null;
    await new Promise((r) => setTimeout(r, stepMs));
  }
}

/** 跑一条带 ask 门的 prompt；onRequest 可选（缺省 = 假装不是本 router 的会话）。 */
function startPrompt(label, onRequest) {
  const router = createOfficialAcpRouter(ctx, { provider: STUB_PROVIDER, model: STUB_MODEL });
  const state = { router, requests: [], settled: null };
  router
    .prompt(label, {
      prompt: [{ type: "text", text: "use get_cwd" }],
      model: STUB_MODEL,
      ...(onRequest ? { onRequest } : {}),
    })
    .then(
      (value) => { state.settled = { ok: true, value }; },
      (err) => { state.settled = { ok: false, err: String(err?.message ?? err) }; },
    );
  return state;
}

test("R147-A: bridge answers first (prepend) and does NOT hand the chain on when the session is ours", async () => {
  earlyProbeCalls = 0;
  let sawRequest = null;
  const st = startPrompt("r147-case-a", (method, params) => {
    sawRequest = { method, params };
    return Promise.resolve({ outcome: { outcome: "selected", optionId: "allow-once" } });
  });

  const settled = await waitFor(() => st.settled);
  assert.ok(sawRequest, `our session's client must receive the permission request; settled=${JSON.stringify(st.settled)}`);
  assert.equal(sawRequest.method, "session/request_permission");
  assert.deepEqual(
    (sawRequest.params?.options ?? []).map((o) => o.optionId),
    ["allow-once", "reject-once"],
    "the approval bridge must advertise exactly the dsh-supported outcomes",
  );
  assert.equal(earlyProbeCalls, 0,
    "a listener registered BEFORE the bridge must not also be asked — answering must not continue the chain");
  assert.ok(settled, "turn must complete once the client allows (regression: hung forever at approval/asked)");
  assert.ok(st.settled.ok, `turn should succeed after allow, got ${JSON.stringify(st.settled)}`);
  try { st.router.close(); } catch {}
});

test("R147-B: a session that is NOT ours falls through via next() (no shadowing of host answerers)", async () => {
  earlyProbeCalls = 0;
  // 不传 onRequest ⇒ serverRequestHandlers 无此会话 ⇒ 桥必须 next() 放行给更早的监听器。
  const st = startPrompt("r147-case-b", null);

  const settled = await waitFor(() => st.settled);
  assert.ok(earlyProbeCalls > 0,
    "an approval for a session this router does not own must reach the host's own answerer");
  assert.ok(settled,
    `fail-closed still settles the turn (no permanent wait); settled=${JSON.stringify(st.settled)}`);
  try { st.router.close(); } catch {}
});
