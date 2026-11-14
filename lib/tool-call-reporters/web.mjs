// lib/tool-call-reporters/web.mjs — `web_search` / `web_fetch` 报告器
// （kind = "fetch"）。
//
// 对照黄金样本 claude-agent-acp@0.89.x `dist/tool-calls/reporters/web.js`：
//   WebSearch: title `Search "<query>"`，无 query 时 "Web search"
//   WebFetch : title `Fetch <url>`（+ `(from char N)`），prompt 作为 display 文本
//
// DSH 侧输入（@deepseek-ai/dsh-tool-web）：web_search { queries } /
// web_fetch { url }。queries 是数组（1-4 条），标题取首条并标注总数，避免把
// 4 条查询塞进一张卡片的标题。

import { firstString, textContent } from "./content.mjs";

/** `web_search` / `WebSearch` — the hits come back in the result frame. */
export class WebSearchReporter {
  toolUse(input) {
    const queries = Array.isArray(input?.queries)
      ? input.queries.filter((q) => typeof q === "string" && q.length > 0)
      : [];
    const query = firstString(input?.query, queries[0]);
    if (!query) return { title: "Web search", kind: "fetch" };
    const extra = queries.length > 1 ? ` (+${queries.length - 1} more)` : "";
    return { title: `Search "${query}"${extra}`, kind: "fetch" };
  }
}

/** `web_fetch` / `WebFetch` — the page text comes back in the result frame. */
export class WebFetchReporter {
  toolUse(input) {
    const url = firstString(input?.url);
    const from = typeof input?.offset === "number" && input.offset > 0 ? ` (from char ${input.offset})` : "";
    const prompt = firstString(input?.prompt);
    return {
      title: url ? `Fetch ${url}${from}` : "Fetch",
      kind: "fetch",
      ...(prompt ? { content: [textContent(prompt)] } : {}),
    };
  }
}
