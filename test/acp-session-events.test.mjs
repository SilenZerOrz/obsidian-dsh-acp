// test/acp-session-events.test.mjs — W2-a（卡 `-66`）跨界面会话同步：SSE 订阅契约单测
//
// 覆盖验收④的两半：
//   ① **宽容解析**：`normalizeSessionEventFrame` 对 unknown / 畸形输入**不抛**，
//      未知字段原样透传（上游 payload 结构未定档，窄解析会在上游加字段时炸）；
//   ② **响亮降级**：订阅不可用（无 `ctx.on` / 抛错 / 未返回注销器）必须返回
//      `{ok:false, reason}`，路由据此发 `fallback` 帧让前端切轮询 —— 不得静默变成
//      「永远收不到更新」。
// 另覆盖：订阅**幂等**（同一进程只订阅一次，否则每个事件会被推两遍）。
//
// 注：`subscribeSessionEvents` 的「已成功订阅」结果缓存在模块级，故本文件**先**跑
// 不可用分支、**后**跑可用分支（node:test 同文件内顺序执行）。

import test from "node:test";
import assert from "node:assert/strict";

const { normalizeSessionEventFrame, subscribeSessionEvents, sessionEventSubscriptionStatus } =
  await import("../web/session-panel.mjs");

test("W2-a 宽容解析：畸形输入不抛且字段兜底", () => {
  for (const bad of [null, undefined, {}, { header: null }, 0, "x", []]) {
    const f = normalizeSessionEventFrame(bad, undefined);
    assert.equal(typeof f, "object", `bad=${JSON.stringify(bad)}`);
    assert.equal(f.kind, "event");
    assert.equal(f.sessionId, "");
    assert.equal(f.type, "");
    assert.equal(f.seq, undefined);
    assert.equal(f.event, null);
    assert.equal(typeof f.at, "number");
  }
  const f2 = normalizeSessionEventFrame({ id: "s1" }, { seq: 7 });
  assert.equal(f2.sessionId, "s1");
  assert.equal(f2.seq, 7);
  assert.equal(f2.type, "");
});

test("W2-a 宽容解析：unknown 字段与 event 本体原样透传，header 只取白名单", () => {
  const ev = { type: "tool_call_update", seq: 12, weird: { a: [1, 2] }, data: { x: 1 } };
  const f = normalizeSessionEventFrame(
    { id: "s", header: { id: "s", cwd: "/tmp", agentPreset: "standard", extra: "nope" } },
    ev,
  );
  assert.equal(f.kind, "event");
  assert.equal(f.event, ev);                                  // 同一引用 ⇒ 未裁剪
  assert.deepEqual(f.event.weird, { a: [1, 2] });             // unknown 字段在
  assert.deepEqual(f.event.data, { x: 1 });
  assert.equal(f.header.cwd, "/tmp");
  assert.equal(f.header.agentPreset, "standard");
  assert.equal(f.header.extra, undefined);                    // 白名单外的头字段被丢
});

test("W2-a 归类：created / deleted / 其它", () => {
  const k = (type) => normalizeSessionEventFrame({ id: "a" }, { type }).kind;
  assert.equal(k("session/created"), "created");
  assert.equal(k("session/start"), "created");
  assert.equal(k("session/deleted"), "deleted");
  assert.equal(k("session/removed"), "deleted");
  assert.equal(k("turn/end"), "event");
  assert.equal(k("approval/policy"), "event");                // 实测活宿主会发的类型
});

test("W2-a 订阅不可用 ⇒ 必须响亮返回 ok:false（路由据此发 fallback 帧）", () => {
  assert.equal(subscribeSessionEvents(null).ok, false);
  assert.equal(subscribeSessionEvents(undefined).ok, false);
  const noOn = subscribeSessionEvents({});
  assert.equal(noOn.ok, false);
  assert.match(noOn.reason, /ctx\.on/);
  const noOff = subscribeSessionEvents({ on: () => undefined });
  assert.equal(noOff.ok, false, "未返回注销器必须视作订阅不可用");
  assert.match(noOff.reason, /注销器/);
  const thr = subscribeSessionEvents({ on: () => { throw new Error("boom"); } });
  assert.equal(thr.ok, false);
  assert.match(thr.reason, /boom/);
  assert.equal(sessionEventSubscriptionStatus().ok, false, "以上分支都不得建立订阅");
});

test("W2-a 订阅可用 ⇒ ok:true、返回注销器、且幂等（只订阅一次）", () => {
  let active = 0;
  const ctx = {
    on: (name, fn) => {
      assert.equal(name, "session/event");
      assert.equal(typeof fn, "function");
      active += 1;
      return () => { active -= 1; };
    },
  };
  const a = subscribeSessionEvents(ctx);
  assert.equal(a.ok, true);
  assert.equal(typeof a.off, "function");
  const b = subscribeSessionEvents(ctx);
  assert.equal(b, a, "重复订阅必须返回同一份（否则每个事件被推两遍）");
  assert.equal(active, 1);
  assert.equal(sessionEventSubscriptionStatus().ok, true);
});
