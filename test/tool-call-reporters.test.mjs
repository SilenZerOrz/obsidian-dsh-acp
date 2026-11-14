// test/tool-call-reporters.test.mjs — P1-2 reporter 层单测.
//
// 三层断言：
//   1. 每个 reporter 的 toolUse() 纯函数契约（title / kind / content / locations）
//   2. factsFor() 的兜底：未知工具只给 title、异常输入不抛
//   3. 接线到 lib/acp-tool-translation.mjs 后**线上帧**的形状：
//      未知工具帧零回归、结果帧 content 不被 diff 覆盖、cwd 相对路径
//
// 纯函数 —— 无网络、无 ctx、无 fixture。

import { test } from "node:test";
import assert from "node:assert/strict";

import { ReadReporter, ReadImageReporter } from "../lib/tool-call-reporters/read.mjs";
import { EditReporter, StrReplaceEditorReporter, WriteReporter } from "../lib/tool-call-reporters/file-edit.mjs";
import { GlobReporter, GrepReporter } from "../lib/tool-call-reporters/search.mjs";
import { ShellReporter } from "../lib/tool-call-reporters/shell.mjs";
import { WebFetchReporter, WebSearchReporter } from "../lib/tool-call-reporters/web.mjs";
import { factsFor, reporterFor } from "../lib/tool-call-reporters/index.mjs";
import { createUpdateTranslator } from "../lib/acp-tool-translation.mjs";

const CWD = "/work/project";

// ---- 1. per-reporter facts -------------------------------------------------

test("read reporter: title carries the path + line window, kind read, jump location", () => {
  const facts = new ReadReporter().toolUse({ file_path: "src/a.ts", offset: 10, limit: 20 }, { cwd: CWD });
  assert.equal(facts.title, "Read src/a.ts (10 - 29)");
  assert.equal(facts.kind, "read");
  assert.deepEqual(facts.locations, [{ path: "src/a.ts", line: 10 }]);
  // No limit → an offset-only window reads "from line N" (claude's wording).
  const offsetOnly = new ReadReporter().toolUse({ file_path: "/elsewhere/b.md", offset: 4 }, { cwd: CWD });
  assert.equal(offsetOnly.title, "Read /elsewhere/b.md (from line 4)");
  // Absolute path inside the cwd is shown relative; outside stays absolute.
  assert.equal(new ReadReporter().toolUse({ file_path: `${CWD}/x.mjs` }, { cwd: CWD }).title, "Read x.mjs");
});

test("read_image reporter: image title stays kind read and keeps the location", () => {
  const facts = new ReadImageReporter().toolUse({ file_path: "assets/a.png" }, { cwd: CWD });
  assert.equal(facts.title, "Read image assets/a.png");
  assert.equal(facts.kind, "read");
  assert.deepEqual(facts.locations, [{ path: "assets/a.png" }]);
});

test("write reporter: edit kind + creation diff (oldText null)", () => {
  const facts = new WriteReporter().toolUse({ file_path: "src/new.mjs", content: "export const a = 1;\n" }, { cwd: CWD });
  assert.equal(facts.title, "Write src/new.mjs");
  assert.equal(facts.kind, "edit");
  assert.deepEqual(facts.locations, [{ path: "src/new.mjs" }]);
  assert.deepEqual(facts.content, [
    { type: "diff", path: "src/new.mjs", oldText: null, newText: "export const a = 1;\n" },
  ]);
});

test("edit reporter: edit kind + replacement diff from old_string/new_string", () => {
  const facts = new EditReporter().toolUse(
    { file_path: "src/a.ts", old_string: "const a = 1;", new_string: "const a = 2;" },
    { cwd: CWD },
  );
  assert.equal(facts.title, "Edit src/a.ts");
  assert.equal(facts.kind, "edit");
  assert.deepEqual(facts.content, [
    { type: "diff", path: "src/a.ts", oldText: "const a = 1;", newText: "const a = 2;" },
  ]);
  // A half-streamed input (path only) must NOT claim a deletion diff.
  const partial = new EditReporter().toolUse({ file_path: "src/a.ts" }, { cwd: CWD });
  assert.equal(partial.content, undefined);
  assert.equal(partial.title, "Edit src/a.ts");
});

test("str_replace_editor reporter: the command decides read vs edit", () => {
  const view = new StrReplaceEditorReporter().toolUse({ command: "view", path: "src/a.ts" }, { cwd: CWD });
  assert.equal(view.kind, "read");
  assert.equal(view.title, "Read src/a.ts");
  const replace = new StrReplaceEditorReporter().toolUse(
    { command: "str_replace", path: "src/a.ts", old_str: "a", new_str: "b" },
    { cwd: CWD },
  );
  assert.equal(replace.kind, "edit");
  assert.deepEqual(replace.content, [{ type: "diff", path: "src/a.ts", oldText: "a", newText: "b" }]);
});

test("shell reporter: the command IS the title, the description is the card body", () => {
  const facts = new ShellReporter().toolUse({ command: "pnpm test", description: "Run the unit suite" });
  assert.equal(facts.title, "pnpm test");
  assert.equal(facts.kind, "execute");
  assert.deepEqual(facts.content, [{ type: "content", content: { type: "text", text: "Run the unit suite" } }]);
  // No command yet (streamed start) → the placeholder claude uses.
  assert.equal(new ShellReporter().toolUse({}).title, "Terminal");
});

test("search reporters: Find/grep titles, kind search, directory location", () => {
  const glob = new GlobReporter().toolUse({ pattern: "*.ts", path: "src" }, { cwd: CWD });
  assert.equal(glob.title, "Find `src` `*.ts`");
  assert.equal(glob.kind, "search");
  assert.deepEqual(glob.locations, [{ path: "src" }]);
  const grep = new GrepReporter().toolUse({ pattern: "TTL", path: "src", include: "*.mjs" }, { cwd: CWD });
  assert.equal(grep.title, 'grep --include="*.mjs" "TTL" src');
  assert.equal(grep.kind, "search");
});

test("web reporters: Search/Fetch titles, kind fetch, prompt as card body", () => {
  const search = new WebSearchReporter().toolUse({ queries: ["ACP tool call", "agent client"] });
  assert.equal(search.title, 'Search "ACP tool call" (+1 more)');
  assert.equal(search.kind, "fetch");
  const fetch = new WebFetchReporter().toolUse({ url: "https://example.com", prompt: "Summarize it" });
  assert.equal(fetch.title, "Fetch https://example.com");
  assert.equal(fetch.kind, "fetch");
  assert.deepEqual(fetch.content, [{ type: "content", content: { type: "text", text: "Summarize it" } }]);
});

// ---- 2. fallback -----------------------------------------------------------

test("generic reporter: an unknown/MCP tool keeps its name as title and claims nothing else", () => {
  const facts = factsFor("obsidian_memory_read", { file_path: "Codex/AGENTS.md" }, { cwd: CWD });
  assert.equal(facts.title, "obsidian_memory_read", "MCP tool title stays the tool name (claude parity)");
  assert.equal(facts.kind, undefined, "kind is left to the caller's upstream inference");
  assert.equal(facts.locations, undefined, "no locations guessed for an unknown tool");
  assert.equal(facts.content, undefined);
  assert.equal(reporterFor("obsidian_memory_read"), reporterFor("obsidian_memory_read"), "one cached instance");
});

test("factsFor never throws on malformed input or name", () => {
  assert.doesNotThrow(() => factsFor(undefined, null));
  assert.doesNotThrow(() => factsFor("read", "not-an-object"));
  assert.deepEqual(factsFor("read", null), { title: "Read file", kind: "read" });
  assert.equal(factsFor("", {}) .title, "Unknown Tool");
});

// ---- 3. wire integration ---------------------------------------------------

test("translator: tool_call start gets rich title/kind/locations (read)", () => {
  const t = createUpdateTranslator({ cwd: CWD });
  const [start] = t.translate({
    sessionUpdate: "tool_call",
    toolCallId: "c1",
    name: "read",
    title: "read",
    status: "pending",
    rawInput: { file_path: `${CWD}/src/a.ts`, offset: 10 },
  });
  assert.equal(start.sessionUpdate, "tool_call");
  assert.equal(start.status, "pending");
  assert.equal(start.title, "Read src/a.ts (from line 10)");
  assert.equal(start.kind, "read");
  assert.deepEqual(start.locations, [{ path: `${CWD}/src/a.ts`, line: 10 }]);
  // The producer's rawInput survives untouched (clients render it in "Input").
  assert.deepEqual(start.rawInput, { file_path: `${CWD}/src/a.ts`, offset: 10 });
  assert.equal(start.name, "read", "name is never dropped");
});

test("translator: bash/edit start frames carry tool-specific content", () => {
  const t = createUpdateTranslator({ cwd: CWD });
  const [bash] = t.translate({
    sessionUpdate: "tool_call",
    toolCallId: "c-bash",
    name: "bash",
    status: "pending",
    rawInput: { command: "pwd", description: "Print working directory" },
  });
  assert.equal(bash.title, "pwd");
  assert.equal(bash.kind, "execute");
  assert.deepEqual(bash.content, [
    { type: "content", content: { type: "text", text: "Print working directory" } },
  ]);

  const [edit] = t.translate({
    sessionUpdate: "tool_call",
    toolCallId: "c-edit",
    name: "edit",
    status: "pending",
    rawInput: { file_path: "src/a.ts", old_string: "a", new_string: "b" },
  });
  assert.equal(edit.title, "Edit src/a.ts");
  assert.equal(edit.kind, "edit");
  assert.deepEqual(edit.locations, [{ path: "src/a.ts" }]);
  assert.equal(edit.content[0].type, "diff");
  assert.equal(edit.content[0].newText, "b");
});

test("translator: finish frame keeps the RESULT content and still refines the title", () => {
  const t = createUpdateTranslator({ cwd: CWD });
  t.translate({
    sessionUpdate: "tool_call",
    toolCallId: "c2",
    name: "read",
    status: "pending",
    rawInput: { file_path: "src/a.ts" },
  });
  const [finish] = t.translate({
    sessionUpdate: "tool_call_update",
    toolCallId: "c2",
    status: "completed",
    content: [{ type: "content", content: { type: "text", text: "1\thello" } }],
  });
  assert.equal(finish.sessionUpdate, "tool_call_update");
  assert.equal(finish.status, "completed");
  assert.deepEqual(finish.rawInput, { file_path: "src/a.ts" }, "rawInput backfilled from the start cache");
  assert.deepEqual(
    finish.content,
    [{ type: "content", content: { type: "text", text: "1\thello" } }],
    "the tool RESULT is never replaced by reporter content",
  );
  assert.equal(finish.rawOutput, "1\thello");
  assert.equal(finish.title, "Read src/a.ts", "end frame refines the title too");
  assert.equal(finish.kind, "read");
  assert.deepEqual(finish.locations, [{ path: "src/a.ts", line: 1 }]);
  // Both per-call caches are consumed → no leak across turns.
  assert.equal(t._rawInputByToolCall.size, 0);
  assert.equal(t._toolNameByToolCall.size, 0);
});

test("translator: unknown tool frames are byte-identical to pre-P1-2 (zero regression)", () => {
  const t = createUpdateTranslator({ cwd: CWD });
  const incoming = {
    sessionUpdate: "tool_call",
    toolCallId: "c3",
    name: "obsidian_memory_list",
    title: "obsidian_memory_list",
    kind: "other",
    status: "pending",
    rawInput: { path: "Codex" },
  };
  const [out] = t.translate(incoming);
  assert.deepEqual(out, incoming, "no locations / content / kind rewrite for an unknown tool");
  assert.equal("locations" in out, false);
  assert.equal("content" in out, false);
});

test("translator: cwd is optional — an absolute path is shown verbatim without it", () => {
  const t = createUpdateTranslator();
  const [out] = t.translate({
    sessionUpdate: "tool_call",
    toolCallId: "c4",
    name: "read",
    status: "pending",
    rawInput: { file_path: "/work/project/src/a.ts" },
  });
  assert.equal(out.title, "Read /work/project/src/a.ts");
});
