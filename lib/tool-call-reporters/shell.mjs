// lib/tool-call-reporters/shell.mjs — `bash` / `pwsh` 报告器（kind = "execute"）。
//
// 对照黄金样本 claude-agent-acp@0.89.x `dist/tool-calls/reporters/bash.js`：
//   title  = 命令行本身（客户端把 title 当命令预览用），无命令时 "Terminal"
//   kind   = "execute"
//   content= 输入里的 description 作为 display 文本（人读的描述；title 留给命令）
//
// DSH 侧输入：bash { command, description?, timeout? } / pwsh 同形。
// 注意：claude 还把 `command: true` 交给 renderer 决定走 terminal 通道；本插件
// 不实现 ACP terminal 扩展（agent-client 走普通 content），因此不上报该字段。

import { firstString, textContent } from "./content.mjs";

/** `bash` / `pwsh` / `Bash` / `PowerShell` — a command run in a shell. */
export class ShellReporter {
  toolUse(input) {
    const command = firstString(input?.command, input?.cmd);
    const description = firstString(input?.description, input?.command_description);
    return {
      title: command ?? "Terminal",
      kind: "execute",
      ...(description ? { content: [textContent(description)] } : {}),
    };
  }
}
