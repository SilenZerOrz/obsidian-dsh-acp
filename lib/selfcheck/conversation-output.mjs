// lib/selfcheck/conversation-output.mjs — 「对话输出」自检（Layer C）
//
// 2026-10-13 新增。背景：推理型模型常在一轮里只产出 reasoning + tool_call，
// 不输出面向用户的收尾正文 → 客户端只看到工具卡片，观感像"对话无输出"。
// dsh-acp 加了 Layer A（显示兜底）+ Layer B（收尾提示，opt-in）两层。
//
// 本模块只做 **只读检测 + plan-only 修复**：确认这两层代码还在、开关没被静默关掉。
// **绝不谎称"已修复模型行为"** —— 模型行为无法由本插件自动改。

import { readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { registerChecks } from "./audit.mjs";
import { isFile, readTextFile } from "./paths.mjs";
import { registerRepairer } from "./repair.mjs";

const CHECK_META_EXTRA = Object.freeze({
  DSH_ACP_CONVERSATION_OUTPUT_GUARD: {
    severity: "high",
    fixable: false,
    title: "dsh-acp 缺「工具轮无文本」兜底代码（Layer A/B 被删或未部署）",
  },
  DSH_ACP_TOOL_ONLY_FALLBACK_DISABLED: {
    severity: "medium",
    fixable: true,
    title: "兜底开关被显式关闭（工具轮将只剩工具卡片、无收尾文字）",
  },
});

/** 定位 dsh-acp.mjs：优先 ctx.roots.adapter（若指向文件），否则按包内相对路径推断。 */
function locateAdapterSource(ctx) {
  const cands = [];
  const fromAdapter = ctx?.roots?.adapter;
  if (fromAdapter && isFile(fromAdapter)) cands.push(fromAdapter);
  try {
    // lib/selfcheck/conversation-output.mjs → ../../dsh-acp.mjs
    const here = fileURLToPath(import.meta.url);
    cands.push(join(dirname(here), "..", "..", "dsh-acp.mjs"));
  } catch { /* ignore */ }
  for (const c of cands) {
    if (isFile(c)) return c;
  }
  return null;
}

/** Check 1：源码守卫 —— Layer A（proxy+spawn）与 Layer B 的兜底点是否都在。 */
function checkConversationOutputGuard(ctx) {
  const src = locateAdapterSource(ctx);
  if (!src) {
    return {
      status: "skip",
      detail: "未定位到 dsh-acp.mjs 源码，跳过源码守卫检查（不做无依据的 pass）",
    };
  }
  const text = readTextFile(src);
  if (text === null) {
    return { status: "skip", detail: `${src} 不可读，跳过` };
  }
  const guards = [
    { id: "layerA-proxy", re: /proxyToolFrames >= 1 && visibleLen === 0/, what: "Layer A proxy 兜底触发点" },
    { id: "layerA-spawn", re: /shouldSynthesizeFallback\(\{\s*visibleText,\s*toolFrames/, what: "Layer A spawn 兜底" },
    { id: "layerA-synth", re: /toolOnlyFallbackText\(/, what: "Layer A 兜底文案合成" },
    { id: "layerB-nudge", re: /withClosingReplyNudge\(|withClosingReplyNudgeOnPrompt\(/, what: "Layer B 收尾提示注入" },
  ];
  const missing = guards.filter((g) => !g.re.test(text));
  if (missing.length > 0) {
    return {
      status: "fail",
      detail: `dsh-acp.mjs 缺少 ${missing.length} 个兜底守卫：${missing.map((m) => m.what).join("、")}`,
      evidence: [`源码：${src}`, ...missing.map((m) => `缺：${m.what} (${m.id})`)],
      action: { kind: "plan-only" },
    };
  }
  return { status: "pass", detail: `兜底守卫齐全（${guards.length} 项）` };
}

/** Check 2：开关状态 —— 兜底/提示是否被显式关闭。 */
function checkToolOnlyFallbackDisabled(ctx) {
  const env = ctx?.env ?? process.env;
  const off = (v) => ["false", "0", "off", "no"].includes(String(v ?? "").trim().toLowerCase());
  const disabled = [];
  if (off(env.DSH_ACP_TOOL_ONLY_FALLBACK)) disabled.push("DSH_ACP_TOOL_ONLY_FALLBACK");
  // Layer B 默认 off 是**设计**，不算"被关"——只在用户可能误以为开着时提示。
  if (disabled.length > 0) {
    return {
      status: "warn",
      detail: `${disabled.join(", ")} 已关闭 → 工具轮无收尾文字时客户端只剩工具卡片`,
      evidence: disabled.map((k) => `${k}=${env[k]}`),
      action: { kind: "plan-only" },
    };
  }
  return { status: "pass", detail: "兜底开关处于默认（开启）状态" };
}

// ---- 注册（顶层副作用） -----------------------------------------------------

const EXTRA_CHECKS = [
  { id: "DSH_ACP_CONVERSATION_OUTPUT_GUARD", severity: "high", fixable: false, title: CHECK_META_EXTRA.DSH_ACP_CONVERSATION_OUTPUT_GUARD.title, run: checkConversationOutputGuard },
  { id: "DSH_ACP_TOOL_ONLY_FALLBACK_DISABLED", severity: "medium", fixable: true, title: CHECK_META_EXTRA.DSH_ACP_TOOL_ONLY_FALLBACK_DISABLED.title, run: checkToolOnlyFallbackDisabled },
];

registerChecks(EXTRA_CHECKS);

// plan-only 修复：只给建议，绝不声称改动代码。
registerRepairer("DSH_ACP_CONVERSATION_OUTPUT_GUARD", () => ({
  kind: "plan-only",
  note: "源码级兜底守卫缺失（src/installed 可能不同步）。请更新/重装 obsidian-dsh-acp，"
    + "并确认 dsh-acp.mjs 已部署到 node_modules/obsidian-dsh-acp/dsh-acp.mjs。本项不会自动改代码。",
}));
registerRepairer("DSH_ACP_TOOL_ONLY_FALLBACK_DISABLED", () => ({
  kind: "plan-only",
  note: "取消设置 DSH_ACP_TOOL_ONLY_FALLBACK（默认即开启）。"
    + "Layer B 如需启用：设 DSH_ACP_CLOSING_REPLY_NUDGE=1（默认 off 以保护 prompt 缓存）。",
}));

export { CHECK_META_EXTRA, EXTRA_CHECKS };
