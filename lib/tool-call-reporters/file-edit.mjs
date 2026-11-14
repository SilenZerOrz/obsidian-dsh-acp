// lib/tool-call-reporters/file-edit.mjs — `write` / `edit` / `str_replace_editor`
// 报告器（kind = "edit"）。
//
// 对照黄金样本 claude-agent-acp@0.89.x `dist/tool-calls/reporters/file-edit.js`：
//   title    : `Write <path>` / `Edit <path>`（无路径时占位 `Preparing file…`）
//   kind     : "edit"
//   locations: [{ path }]
//   content  : [{ type: "diff", path, oldText, newText }] ← agent-client 渲染成
//              行级 diff 卡片；这是 C4 与 claude 版最大的可见差距之一。
//
// DSH 侧输入（@deepseek-ai/dsh-tool-fs，snake_case）：
//   write          : { file_path, content }
//   edit           : { file_path, old_string, new_string, replace_all? }
//   str_replace_editor (Claude-Code 风格): { command, path, old_str?, new_str?, file_text? }
//
// 约束：流式开始帧的 rawInput 可能只有半截字段 —— 只在拿得到内容时给 diff，
// 绝不用「空 newText」冒充「删除」（claude-agent-acp 的 partialRefinement 同样
// 不发不完整 content）。

import { firstString, textContent, toDisplayPath } from "./content.mjs";

const WRITE_CONTENT_KEYS = ["content", "file_text", "file_content"];

/** Read a path from any of the spellings the tool families use. */
function pathOf(input) {
  return firstString(input?.file_path, input?.path, input?.notebook_path);
}

/** The write payload, whichever key the tool family uses. */
function writeContentOf(input) {
  for (const key of WRITE_CONTENT_KEYS) {
    const value = input?.[key];
    if (typeof value === "string") return { content: value, key };
  }
  return { content: undefined, key: undefined };
}

/** `write` / `Write` / `str_replace_editor` command=create — full-file write. */
export class WriteReporter {
  toolUse(input, context = {}) {
    const filePath = pathOf(input);
    const { content } = writeContentOf(input);
    const facts = {
      title: filePath ? `Write ${toDisplayPath(filePath, context.cwd)}` : "Preparing file…",
      kind: "edit",
      ...(filePath ? { locations: [{ path: filePath }] } : {}),
    };
    if (filePath && typeof content === "string") {
      // oldText: null claims a creation. The input cannot tell whether the file
      // exists, so a client that renders diffs shows it as a new file — exactly
      // what claude-agent-acp sends for Write.
      facts.content = [{ type: "diff", path: filePath, oldText: null, newText: content }];
    } else if (!filePath && typeof content === "string") {
      facts.content = [textContent(content)];
    }
    return facts;
  }
}

/** `edit` / `Edit` / `str_replace_editor` str_replace — literal replacement. */
export class EditReporter {
  toolUse(input, context = {}) {
    const filePath = pathOf(input);
    const oldText = firstString(input?.old_string, input?.old_str);
    const newText =
      typeof input?.new_string === "string"
        ? input.new_string
        : typeof input?.new_str === "string"
          ? input.new_str
          : undefined;
    const facts = {
      title: filePath ? `Edit ${toDisplayPath(filePath, context.cwd)}` : "Edit",
      kind: "edit",
      ...(filePath ? { locations: [{ path: filePath }] } : {}),
    };
    if (filePath && (typeof oldText === "string" || typeof newText === "string")) {
      facts.content = [
        { type: "diff", path: filePath, oldText: oldText ?? null, newText: newText ?? "" },
      ];
    }
    return facts;
  }
}

/**
 * `str_replace_editor` — one tool over four commands (view / create /
 * str_replace / insert). The command decides whether it is a read or an edit.
 */
export class StrReplaceEditorReporter {
  toolUse(input, context = {}) {
    const command = firstString(input?.command);
    const filePath = pathOf(input);
    const displayPath = filePath ? toDisplayPath(filePath, context.cwd) : undefined;
    switch (command) {
      case "view":
        return {
          title: displayPath ? `Read ${displayPath}` : "Read file",
          kind: "read",
          ...(filePath ? { locations: [{ path: filePath }] } : {}),
        };
      case "create": {
        const content = firstString(input?.file_text);
        const facts = {
          title: displayPath ? `Write ${displayPath}` : "Preparing file…",
          kind: "edit",
          ...(filePath ? { locations: [{ path: filePath }] } : {}),
        };
        if (filePath && typeof content === "string") {
          facts.content = [{ type: "diff", path: filePath, oldText: null, newText: content }];
        }
        return facts;
      }
      case "str_replace":
        return new EditReporter().toolUse(
          { file_path: filePath, old_string: input?.old_str, new_string: input?.new_str },
          context,
        );
      // `insert` adds text at a boundary: there is no replaced range, so a diff
      // would have to invent one. Title + location only. The default (unknown
      // command) gets the same treatment — a mutation we cannot describe.
      case "insert":
      default:
        return {
          title: displayPath ? `Edit ${displayPath}` : "Edit",
          kind: "edit",
          ...(filePath ? { locations: [{ path: filePath }] } : {}),
        };
    }
  }
}
