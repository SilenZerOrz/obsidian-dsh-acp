// test/fallback-text.test.mjs — lib/fallback-text.mjs 纯函数单测
import test from "node:test";
import assert from "node:assert/strict";

import {
  isVisibleText, dedupeToolNames, toolOnlyFallbackText,
  toolOnlyFallbackEnabled, closingReplyNudgeEnabled,
  withClosingReplyNudge, withClosingReplyNudgeOnPrompt,
  shouldSynthesizeFallback,
} from "../lib/fallback-text.mjs";

test("isVisibleText: whitespace-only is NOT visible (t56 reality)", () => {
  assert.equal(isVisibleText(""), false);
  assert.equal(isVisibleText("\n\n"), false);
  assert.equal(isVisibleText("   \t "), false);
  assert.equal(isVisibleText(null), false);
  assert.equal(isVisibleText(undefined), false);
  assert.equal(isVisibleText("x"), true);
  assert.equal(isVisibleText(" a "), true);
});

test("dedupeToolNames: dedupes + unnamed fallback", () => {
  assert.deepEqual(dedupeToolNames(["a", "a", "b"]), ["a", "b"]);
  assert.deepEqual(dedupeToolNames([]), []);
  assert.deepEqual(dedupeToolNames(["", "  "]), ["(unnamed)"]);
});

test("toolOnlyFallbackText: short form, deduped, marks synthesized", () => {
  const s = toolOnlyFallbackText(["obsidian_memory_read", "obsidian_memory_search"]);
  assert.equal(s, "[已调用工具：obsidian_memory_read、obsidian_memory_search，无文字输出]");
  assert.equal(toolOnlyFallbackText(["a", "a"]), "[已调用工具：a，无文字输出]");
  assert.equal(toolOnlyFallbackText([]), "[已调用工具：无文字输出]");
  // accepts {name} objects (proxy toolNames shape)
  assert.equal(toolOnlyFallbackText([{ name: "X" }, { name: "X" }]), "[已调用工具：X，无文字输出]");
});

test("toolOnlyFallbackEnabled: default on, opt-out values off", () => {
  assert.equal(toolOnlyFallbackEnabled({}), true);
  assert.equal(toolOnlyFallbackEnabled({ DSH_ACP_TOOL_ONLY_FALLBACK: "true" }), true);
  for (const v of ["false", "0", "off", "no", "FALSE", "Off"]) {
    assert.equal(toolOnlyFallbackEnabled({ DSH_ACP_TOOL_ONLY_FALLBACK: v }), false, `"${v}" should disable`);
  }
});

test("closingReplyNudgeEnabled: DEFAULT OFF (cache protection)", () => {
  assert.equal(closingReplyNudgeEnabled({}), false);
  assert.equal(closingReplyNudgeEnabled({ DSH_ACP_CLOSING_REPLY_NUDGE: "0" }), false);
  assert.equal(closingReplyNudgeEnabled({ DSH_ACP_CLOSING_REPLY_NUDGE: "false" }), false);
  for (const v of ["1", "true", "on", "yes", "TRUE"]) {
    assert.equal(closingReplyNudgeEnabled({ DSH_ACP_CLOSING_REPLY_NUDGE: v }), true, `"${v}" should enable`);
  }
});

test("withClosingReplyNudge: disabled → unchanged; enabled → leading system", () => {
  const hist = [{ role: "user", content: "hi" }];
  assert.equal(withClosingReplyNudge(hist, false), hist, "disabled returns the same array");
  const out = withClosingReplyNudge(hist, true, "NUDGE");
  assert.equal(out.length, 2);
  assert.equal(out[0].role, "system");
  assert.deepEqual(out[0].content, [{ type: "text", text: "NUDGE" }]);
  assert.equal(out[1], hist[0]);
  // caller array not mutated
  assert.equal(hist.length, 1);
  // empty history still yields the system message
  assert.equal(withClosingReplyNudge([], true, "N").length, 1);
});

test("withClosingReplyNudgeOnPrompt: disabled → unchanged; enabled → prefixed", () => {
  assert.equal(withClosingReplyNudgeOnPrompt("hello", false), "hello");
  const out = withClosingReplyNudgeOnPrompt("hello", true, "NUDGE");
  assert.match(out, /^\[系统提示\] NUDGE\n\nhello$/);
});

test("shouldSynthesizeFallback: tool-only triggers, reasoning-only does NOT", () => {
  assert.equal(shouldSynthesizeFallback({ visibleText: "", toolFrames: 1 }), true);
  assert.equal(shouldSynthesizeFallback({ visibleText: "  \n", toolFrames: 2 }), true);
  assert.equal(shouldSynthesizeFallback({ visibleText: "", toolFrames: 0 }), false, "no tools → no synth");
  assert.equal(shouldSynthesizeFallback({ visibleText: "ok", toolFrames: 1 }), false, "has text → no synth");
  assert.equal(shouldSynthesizeFallback({ visibleText: "", toolFrames: 1, thoughtFrames: 5 }), true);
});
