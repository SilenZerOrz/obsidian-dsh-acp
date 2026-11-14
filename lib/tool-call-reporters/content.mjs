// lib/tool-call-reporters/content.mjs — 共享的小工具：ACP content block 构造 +
// 路径展示 + 宽松取值。
//
// 对照黄金样本 claude-agent-acp@0.89.x `dist/tool-calls/content.js`：只移植
// **本插件用得到** 的三个（textContent / toDisplayPath / markdownEscape），其余
// （document / image / tool_reference 等 Claude Code 专有 block 类型）不搬。
//
// 纯函数、无 IO、无 ctx —— reporter 层要能在单测里直接跑。

import path from "node:path";

/** One ACP `content` block carrying text (the shape agent-client renders). */
export function textContent(text) {
  return { type: "content", content: { type: "text", text: String(text) } };
}

/**
 * Convert an absolute file path to a project-relative path for display.
 * Returns the original path if it is outside the project directory or when no
 * cwd is known (mirrors claude-agent-acp content.js#toDisplayPath).
 *
 * @param {string} filePath
 * @param {string} [cwd]
 * @returns {string}
 */
export function toDisplayPath(filePath, cwd) {
  if (!cwd || typeof filePath !== "string") return filePath;
  try {
    const resolvedCwd = path.resolve(cwd);
    const resolvedFile = path.resolve(resolvedCwd, filePath);
    if (resolvedFile === resolvedCwd) return ".";
    if (resolvedFile.startsWith(resolvedCwd + path.sep)) {
      return path.relative(resolvedCwd, resolvedFile);
    }
  } catch {
    // Malformed path (exotic separators) → show it untouched rather than throw.
  }
  return filePath;
}

/**
 * Fence text as a markdown code block, using a fence longer than any fence that
 * already appears in the text (mirrors claude-agent-acp content.js#markdownEscape).
 */
export function markdownEscape(text) {
  const value = String(text);
  let escape = "```";
  for (const [m] of value.matchAll(/^```+/gm)) {
    while (m.length >= escape.length) escape += "`";
  }
  return escape + "\n" + value + (value.endsWith("\n") ? "" : "\n") + escape;
}

/** First non-empty string among the arguments (tolerates a missing input). */
export function firstString(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}

/** A positive finite number, else undefined (guards streamed/partial input). */
export function positiveNumber(value) {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}
