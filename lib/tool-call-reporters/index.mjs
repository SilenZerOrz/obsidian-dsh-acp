// lib/tool-call-reporters/index.mjs — 工具卡 Reporter 层（P1-2）。
//
// 背景：上游 dsh 只给 ACP `tool_call` 帧一个 toolName 级别的 title 与一个
// 硬编码 `kind:"other"`（官方 apply() 路径）。claude-agent-acp 的卡片之所以
// 更丰富（"Read src/a.ts"、diff 预览、"grep -i \"x\" src"、"Find `dir` `*.ts`"），
// 是因为它有独立一层 reporter 逐工具推导 `title` / `kind` / `content` /
// `locations` —— 本模块就是那一层（黄金样本：
// claude-agent-acp@0.89.x `dist/tool-calls/reporters/`）。
//
// 契约（一个 reporter 只需实现 toolUse）：
//
//   toolUse(input, { cwd }) -> {
//     title?    : string        // 卡片标题（人读）
//     kind?     : string        // ACP ToolKind
//     content?  : ContentBlock[]// 卡片正文（diff / display 文本）
//     locations?: Array<{ path: string, line?: number }>
//   }
//
// 只回「本工具确实能确定」的字段；未实现的字段一律省略，由翻译层保留上游值。
// 这样未知工具（MCP 等）走过 GenericReporter 时，线上帧与改造前逐字节一致 ——
// 这是本次改动「零回归」的判据。
//
// 纯函数 + 无可变状态（reporter 实例无状态；GenericReporter 按名字缓存）。

import { GenericReporter } from "./generic.mjs";
import { EditReporter, StrReplaceEditorReporter, WriteReporter } from "./file-edit.mjs";
import { GlobReporter, GrepReporter } from "./search.mjs";
import { ReadImageReporter, ReadReporter } from "./read.mjs";
import { ShellReporter } from "./shell.mjs";
import { WebFetchReporter, WebSearchReporter } from "./web.mjs";

/**
 * Exact tool-name table. Names are matched exactly (never by substring): a
 * wrong guess would relabel an unrelated tool's card. Both DSH's snake_case
 * names and Claude Code's PascalCase names are listed so one table serves both
 * producers.
 */
const reporters = new Map();

function register(names, reporter) {
  for (const name of names) reporters.set(name, reporter);
}

const shell = new ShellReporter();

register(["read", "Read", "read_file", "view_file", "cat_file", "view"], new ReadReporter());
register(["read_image", "ReadImage"], new ReadImageReporter());
register(["write", "Write", "write_file"], new WriteReporter());
register(["edit", "Edit", "edit_file", "multi_edit", "apply_patch"], new EditReporter());
register(["str_replace_editor", "str_replace_based_edit_tool"], new StrReplaceEditorReporter());
register(["glob", "Glob", "find_files"], new GlobReporter());
register(["grep", "Grep", "search_files"], new GrepReporter());
register(["bash", "Bash", "pwsh", "PowerShell", "shell", "run_command", "execute_command"], shell);
register(["web_search", "WebSearch"], new WebSearchReporter());
register(["web_fetch", "WebFetch"], new WebFetchReporter());

/** Cache of GenericReporter per unknown name (one instance per tool, no churn). */
const genericByToolName = new Map();

/**
 * The reporter of a tool. MCP tools and unknown tools get the generic reporter.
 *
 * @param {string} [toolName]
 * @returns {{ toolUse: (input: object, context?: object) => object }}
 */
export function reporterFor(toolName) {
  const name = typeof toolName === "string" ? toolName : "";
  const known = reporters.get(name);
  if (known) return known;
  let generic = genericByToolName.get(name);
  if (!generic) {
    generic = new GenericReporter(name);
    genericByToolName.set(name, generic);
  }
  return generic;
}

/**
 * Derive the card facts of a tool call. Never throws: a malformed input or a
 * reporter bug degrades to "no facts" so the wire frame stays as it was.
 *
 * @param {string} [toolName]
 * @param {object} [rawInput]
 * @param {{ cwd?: string }} [context]
 * @returns {object} facts (possibly {})
 */
export function factsFor(toolName, rawInput, context = {}) {
  try {
    const reporter = reporterFor(toolName);
    const input = rawInput !== null && typeof rawInput === "object" ? rawInput : {};
    return reporter.toolUse(input, context) ?? {};
  } catch {
    return {};
  }
}

/**
 * Fold facts into an outgoing legacy frame **without dropping what the producer
 * already put there**. Fields the facts do not name stay untouched.
 *
 * @param {object} frame  the outgoing session/update frame (mutated in place)
 * @param {object} facts  result of {@link factsFor}
 * @param {{ includeContent?: boolean }} [options]
 * @returns {object} the same frame
 */
export function applyToolFacts(frame, facts, options = {}) {
  if (!frame || typeof frame !== "object" || !facts || typeof facts !== "object") return frame;

  if (typeof facts.title === "string" && facts.title.length > 0) {
    frame.title = facts.title;
  }
  // The reporter is the authority on kind: it knows `glob` is a search, which
  // the name-heuristic in chunk-mapper cannot tell (it matches "glob" as read).
  if (typeof facts.kind === "string" && facts.kind.length > 0) {
    frame.kind = facts.kind;
  }
  if (Array.isArray(facts.locations) && facts.locations.length > 0) {
    frame.locations = facts.locations;
  }
  // Content only on the START frame: an end frame's content is the tool RESULT,
  // which must never be replaced by the input's diff/display copy. A producer
  // that already attached content (any non-empty value) keeps it.
  const hasContent =
    frame.content !== undefined &&
    frame.content !== null &&
    !(Array.isArray(frame.content) && frame.content.length === 0);
  if (
    options.includeContent === true &&
    Array.isArray(facts.content) &&
    facts.content.length > 0 &&
    !hasContent
  ) {
    frame.content = facts.content;
  }
  return frame;
}
