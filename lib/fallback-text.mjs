// lib/fallback-text.mjs — 工具轮无可见文本时的兜底文案 + 收尾提示（零依赖，纯函数）
//
// 背景：推理型模型常在一轮里只产出 reasoning + tool_call，不输出面向用户的
// 收尾正文 → 客户端只看到工具卡片，观感像"对话无输出"。此模块提供：
//   Layer A：合成一条显示用兜底文案（纯显示，不进历史）。
//   Layer B：可选（默认 off）的收尾提示，注入模型输入（不进用户可见正文）。
// 单一真源，供 dsh-acp.mjs 两条路径（proxy / spawn）共用 + 单元测试。

/**
 * 可见文本判定：去掉所有空白后仍有内容才算"可见"。
 * 与 dsh-acp.mjs t58 的 `proxyAssistantText.replace(/\s+/g,"").length` 同义。
 */
export function isVisibleText(s) {
  return String(s ?? "").replace(/\s+/g, "").length > 0;
}

/** 去重后的工具名列表（无名 → "(unnamed)"）。 */
export function dedupeToolNames(names) {
  const out = [];
  for (const n of Array.isArray(names) ? names : []) {
    const name = typeof n === "string" && n.trim() ? n.trim() : "(unnamed)";
    if (!out.includes(name)) out.push(name);
  }
  return out;
}

/**
 * Layer A 兜底文案（短版）。names 可为 string[]（工具名）或 {name} 数组。
 */
export function toolOnlyFallbackText(names) {
  const plain = dedupeToolNames(
    (Array.isArray(names) ? names : []).map((n) => (typeof n === "string" ? n : n?.name)),
  );
  const list = plain.join("、");
  return list
    ? `[已调用工具：${list}，无文字输出]`
    : "[已调用工具：无文字输出]";
}

/** Layer A 开关：默认 on；false/0/off/no（不分大小写）为关。 */
export function toolOnlyFallbackEnabled(env = process.env) {
  const v = String(env?.DSH_ACP_TOOL_ONLY_FALLBACK ?? "").trim().toLowerCase();
  return !(v === "false" || v === "0" || v === "off" || v === "no");
}

// Layer B：注入模型输入的收尾提示（不进用户可见正文）。
export const CLOSING_REPLY_NUDGE =
  "调用任何工具后，请务必用一到两句话向用户说明你做了什么、结论是什么；"
  + "不要把全部内容只放在推理里，也不要在只有工具调用的情况下结束本轮。";

/**
 * Layer B 开关：**默认 off**（每轮注入会改变 prompt 前缀 → 破坏缓存）。
 * 仅当 env DSH_ACP_CLOSING_REPLY_NUDGE 显式为真值（1/true/on/yes）才启用。
 */
export function closingReplyNudgeEnabled(env = process.env) {
  const v = String(env?.DSH_ACP_CLOSING_REPLY_NUDGE ?? "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "on" || v === "yes";
}

/** 可配置的收尾提示文案。 */
export function closingReplyNudgeText(env = process.env) {
  const t = env?.DSH_ACP_CLOSING_REPLY_NUDGE_TEXT;
  return typeof t === "string" && t.trim() ? t : CLOSING_REPLY_NUDGE;
}

/**
 * Layer B：把收尾提示前置为一条 system 消息（proxy 路径）。
 * 仅当 enabled 且 messages 非空时生效；**不修改传入数组**（返回新数组）。
 * @param {Array} messages  history（[{role,content}]）
 * @param {boolean} enabled
 * @returns {Array} 新数组（含前置 system），或原数组（未启用时）
 */
export function withClosingReplyNudge(messages, enabled, text = CLOSING_REPLY_NUDGE) {
  if (!enabled) return messages;
  const sys = { role: "system", content: [{ type: "text", text }] };
  if (!Array.isArray(messages) || messages.length === 0) return [sys];
  return [sys, ...messages];
}

/**
 * Layer B：把收尾提示前置到 prompt 文本（spawn 路径，无 system 通道）。
 * 仅当 enabled 时生效。
 */
export function withClosingReplyNudgeOnPrompt(promptText, enabled, text = CLOSING_REPLY_NUDGE) {
  if (!enabled) return promptText;
  return `[系统提示] ${text}\n\n${promptText}`;
}

/** Layer A 触发判据（纯函数；toolOnly=工具帧数）。reasoning-only 不触发。 */
export function shouldSynthesizeFallback({ visibleText, toolFrames }) {
  return Number(toolFrames) >= 1 && !isVisibleText(visibleText);
}
