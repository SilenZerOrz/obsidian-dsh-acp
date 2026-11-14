// lib/tool-call-reporters/generic.mjs — 未知工具 / MCP 工具的兜底报告器。
//
// 对照黄金样本 claude-agent-acp@0.89.x `dist/tool-calls/reporters/interaction.js`
// 的 GenericReporter：未知工具与 MCP 工具（`obsidian_memory_read`、
// `agent_teams_status` 等）**只回 toolName 作 title、kind = "other"**，不做任何
// 猜测 —— 这与 claude-agent-acp 对 MCP 工具的行为一致。
//
// 本实现的差异（有意）：`kind` 不强制写成 "other"，返回 undefined，让翻译层
// 保留上游 `inferToolKind()` 已推断出的 kind（`obsidian_memory_read` → "read"，
// 比统一 "other" 更贴近卡片语义）。只有上游也没有 kind 时才落 "other"。

/** A tool with no dedicated reporter: title is the tool name, nothing else. */
export class GenericReporter {
  /** @param {string} toolName */
  constructor(toolName) {
    this.toolName = toolName;
  }

  toolUse() {
    return { title: this.toolName || "Unknown Tool" };
  }
}
