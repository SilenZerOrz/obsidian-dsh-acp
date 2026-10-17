// test/session-id-translate.test.mjs
//
// H-b 修法 A 的纯函数单测 —— **不依赖 @deepseek-ai/dsh-acp / cordis / spike-bootstrap**。
// 因此可在 `npm run test:unit`（→ test:all）环境直接运行。
//
// 用例：
//   1. id 翻译正确：applyToClient 有映射 → 帧 sessionId = client label，不等于 applyId
//   2. map 缺失 → 产生含 "[dsh-acp error]" 的可见文本帧，sessionId=null（不透传错误 id），log 非空
//   3. N 个输出帧 → 恰好 N 次调用，每次 sessionId = client id
//   4. 工具帧翻译器产出 2 帧时，2 帧都用 client label（覆盖 tool_call 起止）

import { test } from "node:test";
import assert from "node:assert/strict";
import { translateNotifyFrames } from "../lib/acp-session-id-translate.mjs";

const APPLY_ID = "5d0bffb4-c8b7-4c46-88c7-fa71ab54fb3e"; // apply() 自生成 UUID
const CLIENT_ID = "dsh-73dd400a-8db7-45b6-b7a4-6ce63dd57b09"; // agent-client label

function mapWith(applyId, clientId) {
  const m = new Map();
  if (applyId !== undefined) m.set(applyId, clientId);
  return m;
}

test("1. id 翻译正确：帧 sessionId = client label，且不等于 applyId", () => {
  const params = {
    sessionId: APPLY_ID,
    update: { sessionUpdate: "agent_message_chunk", messageId: "m1", content: { type: "text", text: "hi" } },
  };
  const { frames, log } = translateNotifyFrames({
    applyToClient: mapWith(APPLY_ID, CLIENT_ID),
    applyId: APPLY_ID,
    params,
  });
  assert.equal(log, null, "无 map miss → 不应有诊断 log");
  assert.equal(frames.length, 1);
  assert.equal(frames[0].sessionId, CLIENT_ID);
  assert.notEqual(frames[0].sessionId, APPLY_ID);
  assert.equal(frames[0].update.sessionUpdate, "agent_message_chunk");
  assert.equal(frames[0].update.content.text, "hi");
});

test("2. map 缺失 → 含 [dsh-acp error] 的可见文本帧，sessionId=null，log 非空", () => {
  const { frames, log } = translateNotifyFrames({
    applyToClient: mapWith(undefined, undefined), // 空表
    applyId: APPLY_ID,
    params: { sessionId: APPLY_ID, update: { sessionUpdate: "agent_message_chunk", messageId: "m2" } },
  });
  assert.ok(typeof log === "string" && log.includes("[dsh-acp error]"), "log 必须含 [dsh-acp error]");
  assert.equal(frames.length, 1);
  assert.equal(frames[0].sessionId, null, "错误帧 sessionId 必须为 null（不透传 applyId）");
  assert.notEqual(frames[0].sessionId, APPLY_ID, "绝不能透传错误 id");
  assert.equal(frames[0].update.sessionUpdate, "agent_message_chunk");
  assert.ok(frames[0].update.content.text.includes("[dsh-acp error]"),
    "可见文本帧必须含 [dsh-acp error]");
});

test("3. N 个输出帧 → 恰好 N 次调用，每次 sessionId = client id（无 fan-out）", () => {
  const N = 5;
  let calls = 0;
  const translate = (u) => {
    // 模拟翻译器把 1 个入帧映射成 N 个出帧
    return Array.from({ length: N }, (_, i) => ({ sessionUpdate: "agent_message_chunk", messageId: `${u.messageId}-${i}` }));
  };
  const { frames } = translateNotifyFrames({
    applyToClient: mapWith(APPLY_ID, CLIENT_ID),
    applyId: APPLY_ID,
    params: { sessionId: APPLY_ID, update: { sessionUpdate: "agent_message_chunk", messageId: "m3" } },
    translate,
  });
  assert.equal(frames.length, N, `应恰好 N=${N} 帧`);
  for (const f of frames) {
    calls += 1;
    assert.equal(f.sessionId, CLIENT_ID, "每帧 sessionId 必须是 client id");
    assert.notEqual(f.sessionId, APPLY_ID);
  }
  assert.equal(calls, N, "调用次数必须 = 帧数");
});

test("4. 工具帧（翻译器 1→2）两帧都用 client label", () => {
  const translate = () => ([
    { sessionUpdate: "tool_call_update", toolCallId: "tc1", status: "in_progress" },
    { sessionUpdate: "tool_call_update", toolCallId: "tc1", status: "completed", rawInput: { path: "x" } },
  ]);
  const { frames } = translateNotifyFrames({
    applyToClient: mapWith(APPLY_ID, CLIENT_ID),
    applyId: APPLY_ID,
    params: { sessionId: APPLY_ID, update: { sessionUpdate: "tool_call", toolCallId: "tc1" } },
    translate,
  });
  assert.equal(frames.length, 2);
  assert.ok(frames.every((f) => f.sessionId === CLIENT_ID));
  assert.ok(frames.every((f) => f.sessionId !== APPLY_ID));
});
