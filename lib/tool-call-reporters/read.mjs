// lib/tool-call-reporters/read.mjs — `read` / `read_image` / `Read` 报告器。
//
// 对照黄金样本 claude-agent-acp@0.89.x `dist/tool-calls/reporters/read.js`：
//   title    : `Read <path>` + 窗口后缀 `(1 - 200)` / `(from line N)`
//   kind     : "read"
//   locations: [{ path, line }]  ← agent-client 用它做「跳到文件」链接
//   content  : 无（文件正文由结果帧的 rawOutput/content 承担）
//
// DSH 的 `read` 输入是 { file_path, offset?, limit? }（snake_case，与 Claude Code
// 同字段名，见 @deepseek-ai/dsh-tool-fs README）。

import { firstString, positiveNumber, toDisplayPath } from "./content.mjs";

/** `read` (DSH) / `Read` (Claude Code) — line-numbered file window. */
export class ReadReporter {
  /**
   * @param {object} input raw tool input
   * @param {{ cwd?: string }} [context]
   */
  toolUse(input, context = {}) {
    const filePath = firstString(input?.file_path, input?.path);
    // Window suffix: claude-agent-acp prints the resolved line range when a
    // limit is given, else the start line when only `offset` is.
    const limit = positiveNumber(input?.limit);
    const offset = positiveNumber(input?.offset);
    let suffix = "";
    if (limit) {
      const start = offset ?? 1;
      suffix = ` (${start} - ${start + limit - 1})`;
    } else if (offset) {
      suffix = ` (from line ${offset})`;
    }
    return {
      title: filePath ? `Read ${toDisplayPath(filePath, context.cwd)}${suffix}` : "Read file",
      kind: "read",
      ...(filePath ? { locations: [{ path: filePath, line: offset ?? 1 }] } : {}),
    };
  }
}

/** `read_image` — an image read; the picture itself comes back in the result. */
export class ReadImageReporter {
  toolUse(input, context = {}) {
    const filePath = firstString(input?.file_path, input?.path);
    return {
      title: filePath ? `Read image ${toDisplayPath(filePath, context.cwd)}` : "Read image",
      kind: "read",
      ...(filePath ? { locations: [{ path: filePath }] } : {}),
    };
  }
}
