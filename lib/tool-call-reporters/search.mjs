// lib/tool-call-reporters/search.mjs — `glob` / `grep` 报告器（kind = "search"）。
//
// 对照黄金样本 claude-agent-acp@0.89.x `dist/tool-calls/reporters/search.js`：
//   Glob: title `Find \`<path>\` \`<pattern>\``, locations [{ path }]
//   Grep: title 等价 grep 命令行（`-i` / `-A n` / `-l` / `--include=` / pattern / path）
//
// DSH 侧输入（@deepseek-ai/dsh-tool-fs-search）：
//   glob: { pattern, path? }
//   grep: { pattern, path?, include? }
//
// 备注：chunk-mapper 的 `inferToolKind("glob")` 因 `read` 正则先命中 "glob" 而
// 返回 "read"；reporter 层是权威，这里统一给 "search"（与 claude 一致），
// 由翻译层在 kind 冲突时采用 reporter 的值。

import { firstString, positiveNumber, toDisplayPath } from "./content.mjs";

/** `glob` / `Glob` — file discovery. */
export class GlobReporter {
  toolUse(input, context = {}) {
    const dir = firstString(input?.path);
    const pattern = firstString(input?.pattern);
    let label = "Find";
    if (dir) label += ` \`${toDisplayPath(dir, context.cwd)}\``;
    if (pattern) label += ` \`${pattern}\``;
    return {
      title: label,
      kind: "search",
      ...(dir ? { locations: [{ path: dir }] } : {}),
    };
  }
}

/** `grep` / `Grep` — content search; the title is the equivalent grep line. */
export class GrepReporter {
  toolUse(input, context = {}) {
    const dir = firstString(input?.path, input?.file_path);
    const include = firstString(input?.include, input?.glob);
    const pattern = firstString(input?.pattern);
    let label = "grep";
    // Claude Code exposes flags; DSH exposes neither, but the same input object
    // reaches this reporter, so honour the flags when a model sends them.
    for (const flag of ["-i", "-n"]) {
      if (input?.[flag] === true) label += ` ${flag}`;
    }
    for (const flag of ["-A", "-B", "-C"]) {
      if (positiveNumber(input?.[flag]) !== undefined) label += ` ${flag} ${input[flag]}`;
    }
    if (input?.output_mode === "files_with_matches") label += " -l";
    else if (input?.output_mode === "count") label += " -c";
    if (positiveNumber(input?.head_limit) !== undefined) label += ` | head -${input.head_limit}`;
    if (include) label += ` --include="${include}"`;
    if (pattern) label += ` "${pattern}"`;
    if (dir) label += ` ${toDisplayPath(dir, context.cwd)}`;
    return { title: label, kind: "search" };
  }
}
