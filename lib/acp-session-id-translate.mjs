// lib/acp-session-id-translate.mjs — 纯函数：把 apply() 的 sessionId 翻译成 client label。
//
// 背景（H-b）：官方桥 apply() 在 session/new 自生成 UUID 当 sessionId（IGNORES 调用方
// 传入的 params.sessionId）；agent-client 端用自己 session/new 响应里的 id 当 label。
// 两个 id 不同命名空间 → 官方桥发出的 session/update 通知里 params.sessionId 是 UUID，
// agent-client 收到后与自己 label 不匹配 → 通知全部被丢弃 → UI 转圈无响应。
//
// 本模块把该翻译抽成**不依赖 @deepseek-ai/dsh-acp、不依赖 cordis / spike-bootstrap**
// 的纯函数，使单测可在 `npm run test:unit`（→ test:all）环境直接运行。
//
// 纯函数契约：
//   输入 applyToClient(Map<applyId, clientId>)、applyId、params({sessionId, update})、
//         translate(update)=>update[]、errorMessageId
//   输出 { frames: Array<{sessionId, update}>, log: string|null }
//     - frames：按顺序要发给客户端（agent-client）的 notification params 列表
//     - log：需要写 stderr 的诊断行（map miss 时非 null），否则 null
//   无副作用（不写 stderr、不读时钟）——调用方负责 emit frames + 写 log。

/**
 * 把一个 apply() 出站通知翻译成 client 面向的帧列表。
 *
 * @param {object} args
 * @param {Map<string,string>} args.applyToClient - applyId → client label 反查表
 * @param {string} args.applyId - 本次通知所属的 apply() UUID
 * @param {{sessionId?: string, update?: object}} args.params - apply() 出站通知 params
 * @param {(update: object) => object[]} [args.translate] - 工具帧翻译器（缺省 = 恒等单帧）
 * @param {() => string} [args.errorMessageId] - map miss 错误帧的 messageId 工厂（缺省 = 常量）
 * @returns {{frames: Array<{sessionId: string|null, update: object}>, log: string|null}}
 */
export function translateNotifyFrames({ applyToClient, applyId, params, translate, errorMessageId }) {
  const { update } = params ?? {};
  const identity = (u) => [u];
  const xlate = typeof translate === "function" ? translate : identity;
  const out = xlate(update);

  const clientLabel = applyToClient instanceof Map ? applyToClient.get(applyId) : undefined;
  const frames = [];
  let log = null;

  for (const o of out) {
    if (!clientLabel) {
      // map miss：绝不能静默吞掉通知，也绝不能透传错误 id。
      // 写 log + 发一条可见的 [dsh-acp error] 文本帧（sessionId 故意置 null，
      // 让客户端能识别这是本地生成的诊断帧，而非某 session 的正常输出）。
      const mid = typeof errorMessageId === "function" ? errorMessageId() : "dsh-acp-err";
      log =
        `[dsh-acp error] router.attach: applyId=${applyId} not in applyToClient ` +
        `map; notification dropped. update=${JSON.stringify(o?.sessionUpdate ?? o)}\n`;
      frames.push({
        sessionId: null,
        update: {
          sessionUpdate: "agent_message_chunk",
          messageId: mid,
          content: {
            type: "text",
            text: `[dsh-acp error] sessionId 翻译失败（router map miss, applyId=${applyId}）`,
          },
        },
      });
      continue;
    }
    frames.push({ sessionId: clientLabel, update: o });
  }

  return { frames, log };
}
