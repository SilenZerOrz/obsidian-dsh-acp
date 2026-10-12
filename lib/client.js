/* global window, document, fetch, MutationObserver, ResizeObserver, setTimeout */
// lib/client.js — obsidian-dsh-acp 的 Browser 侧 bundle（手写 CJS factory，供 dsh web
// 客户端 ModuleLoader 注入）。P1b：在 DSH web 侧边栏底部挂「会话管理」按钮 → 滑出
// 面板，复用 P1a 已实现的会话管理 core（fetch /api-session/{list,export,archive,move}
// → 调到 session-manage.mjs / archive-store.mjs）。
//
// 范式严格对齐 dsh-chat-import（生态参考）：
//   window.__ModuleLoader__.load({id, factory})
//     factory(require):
//       React = require("react")
//       module.exports = { name, inject, apply }
//       function apply(ctx):
//         ctx.slots.inject("sidebar.footer.action", () => ctx.slots.register(...))
//
// i18n：自有 ns "dsh-acp" 字典（zh/en 双语），经 @deepseek-ai/dsh-client-locale 的
// LocaleRuntime 随 DSH web 语言设置切换；locale 服务缺失时降级内置 zh 字典。
// 纯前端：不 import 任何 DSH host 模块，只消费注入的 slots/locale 与 react。

window.__ModuleLoader__.load({
  id: "obsidian-dsh-acp",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
    const React = require("react");
    const { useState, useEffect, useRef } = React;

    // ── 文案字典（自有 ns "dsh-acp"；zh 为现状中文，en 为翻译）─────────────
    const LOCALE_NS = "dsh-acp";
    const DICT = {
      zh: {
        "trigger.title": "acp 会话管理（列出会话 / 导出 / 归档 / 移动）",
        "trigger.label": "acp 会话管理",
        "panel.title": "acp 会话管理",
        "panel.subtitle": "DSH 会话与 Obsidian 会话一站式管理",
        "close": "关闭",
        "filter.active": "活动",
        "filter.archived": "已归档",
        "filter.all": "全部",
        "filter": "筛选",
        "refresh": "刷新",
        "export": "导出",
        "archive": "归档",
        "unarchive": "取消归档",
        "move": "移动…",
        "move.confirm": "移动",
        "move.cancel": "取消",
        "move.placeholder": "新的 cwd（绝对路径）",
        "export.format": "导出格式",
        "export.copy": "复制到剪贴板",
        "export.close": "关闭",
        "export.copied": "已复制",
        "loading": "加载中…",
        "empty": "没有会话",
        "error.load": "加载失败：{msg}",
        "error.route": "服务响应异常（路由可能未注册，请重启 dsh 后重试）",
        "summary.empty": "(无摘要)",
        "badge.archived": "已归档",
        "row.cwd": "工作区",
        "row.summary": "摘要",
        "row.sessionId": "会话 ID",
        "row.updatedAt": "更新时间",
        "tab.native": "原生 dsh 会话",
        "tab.obsidian": "obsidian 会话",
        "source.native": "原生",
        "source.obsidian": "Obsidian",
        "row.turns": "轮数",
        "native.desc": "DSH 原生 session（与左侧侧栏同源；可打开/复制 ID）",
        "obsidian.desc": "obsidian dsh-acp 私有归档（活动 / 已归档 / 回收站 三态）",
        // trash 系列键（line 105-131 en 块补到这里）
        "trash": "删除",
        "restore": "恢复",
        "permDel": "永久删除",
        "trash.confirm": "删除「{title}」？",
        "trash.confirm2": "为防误操作，请输入标题的末两字：{hint}",
        "trash.confirm2.wrong": "输入不匹配，未删除",
        "trash.done": "已移入回收站",
        "restore.done": "已从回收站恢复",
        "permDel.done": "已永久删除",
        "filter.trashed": "回收站",
        "empty.trash": "清空回收站",
        "empty.trash.confirm": "将永久删除回收站中的 {n} 条会话（不可逆！）是否继续？",
        "empty.trash.done": "已清空回收站（{n} 条）",
        "import.button": "导入 Obsidian 会话…",
        "search.placeholder": "搜索 会话 ID / 标题 / 来源",
        "search.clear": "清空",
        "search.empty": "没有匹配的会话",
        "row.sessionId.copy": "复制 ID",
        "copy.id": "复制会话 ID",
        "row.open": "打开会话",
        "row.open.hint": "在 DSH web 中打开此会话",
        "row.open.unavailable": "uiWorkspace 服务不可用，无法跳转（请复制 ID 到 left sidebar 搜索）",
        "row.open.importedReload": "已导入到 DSH（新会话 ID 见「会话」列表），但 DSH web 的会话列表需刷新后才能打开——请刷新页面后在左侧搜索新 ID",
        "row.open.notListed": "该会话不在 DSH web 当前会话列表中（可能需切到对应工作区/刷新后重试）：{id}",
        "import.title": "从 Obsidian 导入",
        "import.desc": "导入 Obsidian Agent Client 生成的会话（claude / dsh-acp 等，可一键导入）",
        "import.all": "一键导入全部未导入",
        "import.imported": "已导入",
        "import.notImported": "未导入",
        "import.single": "导入",
        "import.done": "已导入",
        "import.empty": "未发现 Obsidian 会话",
        "import.agent": "来源",
        "import.messages": "{n} 条消息",
        "import.vault": "库",
      },
      en: {
        "trigger.title": "acp session manager (list / export / archive / move)",
        "trigger.label": "ACP Sessions",
        "panel.title": "ACP Session Manager",
        "panel.subtitle": "Manage DSH and Obsidian sessions in one place",
        "close": "Close",
        "filter.active": "Active",
        "filter.archived": "Archived",
        "filter.all": "All",
        "filter": "Filter",
        "refresh": "Refresh",
        "export": "Export",
        "archive": "Archive",
        "unarchive": "Unarchive",
        "trash": "Delete",
        "restore": "Restore",
        "permDel": "Permanently delete",
        "trash.confirm": "Delete \"{title}\"?",
        "trash.confirm2": "To prevent mistakes, type the last 2 characters of the title: {hint}",
        "trash.confirm2.wrong": "Input mismatch, not deleted",
        "trash.done": "Moved to trash",
        "restore.done": "Restored from trash",
        "permDel.done": "Permanently deleted",
        "filter.trashed": "Trash",
        "empty.trash": "Empty trash",
        "empty.trash.confirm": "Permanently delete {n} sessions in trash (irreversible!). Continue?",
        "empty.trash.done": "Trash emptied ({n} sessions)",
        "tab.native": "DSH Native",
        "tab.obsidian": "Obsidian",
        "native.desc": "DSH native sessions (same source as left sidebar; open/copy ID)",
        "obsidian.desc": "obsidian dsh-acp private archive (active / archived / trash)",
        "import.button": "Import Obsidian sessions…",
        "move": "Move…",
        "move.confirm": "Move",
        "move.cancel": "Cancel",
        "move.placeholder": "New cwd (absolute path)",
        "export.format": "Format",
        "export.copy": "Copy to clipboard",
        "export.close": "Close",
        "export.copied": "Copied",
        "loading": "Loading…",
        "empty": "No sessions",
        "error.load": "Load failed: {msg}",
        "error.route": "Service response abnormal (route may not be registered, please restart dsh)",
        "summary.empty": "(no summary)",
        "badge.archived": "Archived",
        "row.cwd": "Workspace",
        "row.summary": "Summary",
        "row.sessionId": "Session ID",
        "row.updatedAt": "Updated",
        "source.native": "Native",
        "source.obsidian": "Obsidian",
        "row.turns": "Turns",
        "search.placeholder": "Search session ID / title / source",
        "search.clear": "Clear",
        "search.empty": "No matching sessions",
        "row.sessionId.copy": "Copy ID",
        "copy.id": "Copy session ID",
        "row.open": "Open",
        "row.open.hint": "Open this session in DSH web",
        "row.open.unavailable": "uiWorkspace service unavailable; copy ID and search in left sidebar",
        "row.open.importedReload": "Imported into DSH; refresh the page, then search the new ID in the left sidebar",
        "row.open.notListed": "This session is not in DSH web's current list (switch workspace or refresh and retry): {id}",
        "import.title": "Import from Obsidian",
        "import.desc": "Import sessions generated by Obsidian Agent Client (claude / dsh-acp etc.), one-click import",
        "import.all": "Import all unimported",
        "import.imported": "Imported",
        "import.notImported": "Not imported",
        "import.single": "Import",
        "import.done": "Imported",
        "import.empty": "No Obsidian sessions found",
        "import.agent": "Agent",
        "import.messages": "{n} messages",
        "import.vault": "Vault",
      },
    };

    // 模板参数填充：{name} → params[name]（locale 服务 translate 内部同款；fallback 用）
    function fill(text, params) {
      if (!params) return text;
      return String(text).replace(/\{(\w+)\}/g, (m, k) => (k in params ? String(params[k]) : m));
    }

    // locale 服务（ctx.get('locale')，apply 时设置；缺失时 UI 降级 zh 字典）
    let localeSvc = null;
    // uiWorkspace 服务（dsh-client-ui-workspace 暴露）：用于在 dsh web SPA 内
    // 切换/打开指定 sessionId。openSession(sessionId) 会调用内部 sessions.open
    // 并清空右侧 layout panel——这是 dsh web 唯一支持的「程序化选会话」入口，
    // URL 路由不暴露 sessionId（实测手动点开会话地址栏不变）。
    let uiWorkspaceSvc = null;
    // dsh-better-sidebar（可选 peer）的 tab 注册服务：安装了就把「acp 会话管理」
    // 注册为它的侧边栏 tab（footer 按钮点击 → openTab 打开/聚焦 tab 并展开面板）；
    // 未安装则为 null，footer 按钮回退到自绘 ShellPanel。late-mounted：在
    // ctx.inject(['betterSidebar']) 回调里赋值。范式对齐 dsh-chat-import v0.11.3
    // lib/client.js:297-316（late mount + 版本分支 + title thunk + 失败回退）。
    let betterSidebarService = null;
    const ACP_TAB_TYPE = "dsh-acp-sessions";
    // 与 lib/sidebar-compat.mjs 同步（浏览器 bundle 不做构建、各存一份）。dsh-
    // better-sidebar 0.19 起 openTab 的 seed.path 变成「要打开的工作区资源地址」，
    // 相对路径按会话 cwd 解析、目录不存在即 ENOENT → 400，tab 打不开；而 0.18 恰
    // 恰只有带 path/url 才会自动展开面板。同一个 seed 在两版里语义相反，按服务自
    // 报版本分支；版本缺失/非语义化按新版处理（不带 path 一定能开，是唯一不报错
    // 的一侧）。
    const supportsPathlessTabOpen = (version) => {
      const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(typeof version === "string" ? version : "");
      if (!m) return true;
      return Number(m[1]) > 0 || Number(m[2]) >= 19;
    };
    const acpTabSeed = (version) => (supportsPathlessTabOpen(version)
      ? { type: ACP_TAB_TYPE }
      : { type: ACP_TAB_TYPE, path: ACP_TAB_TYPE });

    // 组件侧翻译 hook：订阅 locale/change 触发重渲染；无服务时查 zh 字典兜底
    function useTranslate() {
      const [, force] = useState(0);
      useEffect(() => {
        if (!localeSvc) return undefined;
        return localeSvc.subscribe(() => force((x) => x + 1));
      }, []);
      return (key, params) => {
        if (!localeSvc) return fill(DICT.zh[key] || key, params);
        return localeSvc.bind(LOCALE_NS)(key, params);
      };
    }

    // ── 颜色：复用 DSH 设计令牌（--dsw-alias-*），与 dsh-chat-import 同款 ───
    const themeColors = () => ({
      bg: "var(--dsw-specific-menu)",
      border: "var(--dsw-alias-border-l2)",
      field: "var(--dsw-alias-bg-layer-1)",
      text: "var(--dsw-alias-label-primary)",
      dim: "var(--dsw-alias-label-secondary)",
      dimmer: "var(--dsw-alias-label-tertiary)",
      accent: "var(--dsw-alias-brand-primary)",
      accentForeground: "var(--dsw-alias-label-primary-foreground)",
      hover: "var(--dsw-alias-interactive-bg-hover)",
      success: "var(--dsw-alias-state-success-primary)",
      warn: "var(--dsw-alias-state-warn-primary)",
      error: "var(--dsw-alias-state-error-primary)",
    });

    // 滑入动画（一次性注入，幂等防重复）
    if (typeof document !== "undefined" && !document.querySelector("style[data-dsh-acp-slide]")) {
      const tag = document.createElement("style");
      tag.dataset.dshAcpSlide = "1";
      tag.textContent = "@keyframes dsh-acp-slide-in { from { transform: translateX(24px); opacity: 0; } to { transform: translateX(0); opacity: 1; } }";
      document.head.appendChild(tag);
    }

    const makeStyles = (C) => ({
      overlay: { position: "fixed", inset: 0, background: "rgba(0,0,0,.45)", zIndex: 9998, display: "flex", justifyContent: "flex-end" },
      panel: {
        position: "fixed", top: "40px", right: 0, bottom: 0, width: "480px", maxWidth: "94vw",
        background: C.bg, borderLeft: "1px solid " + C.border, color: C.text,
        font: "13px/1.6 system-ui, sans-serif", zIndex: 9999, display: "flex", flexDirection: "column",
        boxShadow: "-8px 0 32px rgba(0,0,0,.35)",
        animation: "dsh-acp-slide-in .18s ease-out",
      },
      header: { display: "flex", justifyContent: "space-between", alignItems: "center", gap: "12px", padding: "14px 16px", borderBottom: "1px solid " + C.border, flex: "none" },
      headerLeft: { display: "flex", gap: "10px", alignItems: "center", minWidth: 0, flex: "1 1 auto" },
      title: { fontSize: "14px", fontWeight: 600 },
      subtitle: { fontSize: "11px", color: C.dimmer, marginTop: "2px" },
      close: { background: "transparent", border: "none", color: C.dim, fontSize: "16px", cursor: "pointer", padding: "4px 8px", borderRadius: "8px", flex: "none" },
      closeHover: { background: "var(--dsw-alias-interactive-bg-hover)" },
      toolbar: { display: "flex", gap: "6px", alignItems: "center", padding: "8px 12px", borderBottom: "1px solid " + C.border, flex: "none" },
      select: { background: C.field, border: "1px solid " + C.border, color: C.text, borderRadius: "8px", padding: "5px 8px", fontSize: "13px", outline: "none" },
      toolBtn: { background: "transparent", border: "1px solid " + C.border, color: C.text, borderRadius: "8px", padding: "4px 10px", fontSize: "13px", cursor: "pointer" },
      list: { flex: "1", minHeight: "0", overflowY: "auto", padding: "10px", scrollbarWidth: "thin", scrollbarColor: C.dimmer + " transparent" },
      item: { padding: "11px 13px", border: "1px solid " + C.border, borderRadius: "10px", marginBottom: "8px", background: C.field, transition: "background .12s ease, border-color .12s ease" },
      itemHover: { background: "var(--dsw-alias-interactive-bg-hover)" },
      itemHeader: { display: "flex", alignItems: "center", gap: "8px", marginBottom: "6px" },
      itemTitle: { fontSize: "13px", fontWeight: 600, flex: "1", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
      badge: { fontSize: "11px", padding: "1px 6px", borderRadius: "8px", border: "1px solid " + C.border, color: C.dim, flex: "none" },
      badgeArchived: { color: C.warn, borderColor: C.warn },
      meta: { color: C.dimmer, fontSize: "12px", marginTop: "2px", display: "flex", gap: "8px", alignItems: "center", flexWrap: "wrap" },
      metaLabel: { color: C.dim, flex: "none", minWidth: "60px" },
      metaValue: { color: C.text, flex: "1", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
      summary: { marginTop: "6px", color: C.text, fontSize: "12px", lineHeight: 1.5, padding: "6px 8px", background: C.bg, borderRadius: "6px" },
      actions: { display: "flex", gap: "6px", marginTop: "8px", flexWrap: "wrap" },
      actionBtn: { background: "transparent", border: "1px solid " + C.border, color: C.text, borderRadius: "8px", padding: "3px 10px", fontSize: "12px", cursor: "pointer" },
      actionPrimary: { background: C.accent, color: C.accentForeground, borderColor: C.accent, fontWeight: 600 },
      status: { padding: "40px 16px", textAlign: "center", color: C.dimmer },
      error: { padding: "16px", textAlign: "center", color: C.error },
      modal: { position: "absolute", inset: 0, background: "rgba(0,0,0,.5)", zIndex: 2, display: "flex", alignItems: "center", justifyContent: "center", padding: "16px" },
      modalCard: { background: C.bg, border: "1px solid " + C.border, borderRadius: "12px", padding: "16px", maxWidth: "360px", width: "100%" },
      modalTitle: { fontWeight: 600, marginBottom: "8px", fontSize: "13px" },
      modalInput: { width: "100%", boxSizing: "border-box", background: C.field, border: "1px solid " + C.border, color: C.text, borderRadius: "8px", padding: "6px 8px", fontSize: "13px", outline: "none", marginBottom: "12px" },
      modalActions: { display: "flex", gap: "8px", justifyContent: "flex-end" },
      pre: { whiteSpace: "pre-wrap", wordBreak: "break-word", background: C.field, border: "1px solid " + C.border, borderRadius: "8px", padding: "10px", fontSize: "12px", maxHeight: "320px", overflow: "auto", color: C.text },
    });

    // 健壮 JSON 读取：先取文本再解析，空/非 JSON 响应返回 null（避免 resp.json()
    // 对空响应抛原始异常）。对齐 dsh-chat-import client.js 同款封装。
    const readJson = async (resp) => {
      try { return JSON.parse(await resp.text()); } catch { return null; }
    };

    // POST /api-session/<path>，body 序列化为 JSON；统一兜底 5xx 错误。
    const apiPost = async (path, body) => {
      try {
        const resp = await fetch("/api-session/" + path, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body || {}),
        });
        const data = await readJson(resp);
        if (!data) throw new Error("bad response");
        if (data.ok !== true) throw new Error(data.error || "unknown error");
        return data;
      } catch (err) {
        throw new Error(err && err.message ? err.message : String(err));
      }
    };

    // 时间格式化（updatedAt 显示用）
    function fmtTime(ts) {
      if (!ts) return "";
      const d = new Date(ts);
      if (Number.isNaN(d.getTime())) return "";
      const p = (n) => String(n).padStart(2, "0");
      return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate()) + " " + p(d.getHours()) + ":" + p(d.getMinutes());
    }

    // ── 子组件：列表条目 ───────────────────────────────────────────────
    function SessionItem({ rec, t, colors, styles, onChanged }) {
      const [busy, setBusy] = useState(false);
      const [err, setErr] = useState(null);
      const [moveOpen, setMoveOpen] = useState(false);
      const [moveCwd, setMoveCwd] = useState("");
      const [exportOpen, setExportOpen] = useState(false);
      // 软删/硬删二次确认弹窗：hint = 标题末两字；用户需输入末两字才放行。
      // 适用 trash(软删) 与 permDel(硬删)；restore 无需二次确认（无损）。
      const [delConfirm, setDelConfirm] = useState(null); // { mode:'trash'|'permDel', hint, value }
      const [delInput, setDelInput] = useState("");

      const runArchive = async () => {
        setBusy(true); setErr(null);
        try {
          await apiPost("archive", { sessionId: rec.sessionId, archived: !rec.archived });
          onChanged();
        } catch (e) { setErr(e.message); }
        finally { setBusy(false); }
      };

      const runMove = async () => {
        const cwd = moveCwd.trim();
        if (!cwd) return;
        setBusy(true); setErr(null);
        try {
          await apiPost("move", { sessionId: rec.sessionId, cwd });
          setMoveOpen(false); setMoveCwd("");
          onChanged();
        } catch (e) { setErr(e.message); }
        finally { setBusy(false); }
      };

      // 通用：按 mode 调 /api-session/delete；onChanged 让父级刷新。
      const runDelete = async (mode) => {
        setBusy(true); setErr(null);
        try {
          await apiPost("delete", { sessionId: rec.sessionId, mode });
          onChanged();
        } catch (e) { setErr(e.message); }
        finally { setBusy(false); }
      };

      // 开启 trash/permDel 二次确认弹窗。hint 取标题末两字（中文/emoji 取末尾 2 char）。
      // 标题为空/单字符时用 sessionId 末两字兜底。
      const openDeleteConfirm = (mode) => {
        const title = (rec.title || rec.sessionId || "").trim();
        const hint = title.length >= 2
          ? title.slice(-2)
          : (title || (rec.sessionId || "").slice(-2));
        setDelConfirm({ mode, hint });
        setDelInput("");
      };

      // 二次确认弹窗的"确认"按钮：仅当输入 == hint 时才调 runDelete。
      const confirmDelete = () => {
        if (!delConfirm) return;
        if (delInput !== delConfirm.hint) {
          setErr(t("trash.confirm2.wrong"));
          setDelConfirm(null);
          setDelInput("");
          return;
        }
        const mode = delConfirm.mode;
        setDelConfirm(null);
        setDelInput("");
        runDelete(mode);
      };

      const cancelDelete = () => { setDelConfirm(null); setDelInput(""); };

      // 行内按钮：按 rec.trashed 切换。
      // - 活动会话（未 trashed）：export / archive / move / delete
      // - 回收站会话（trashed）：export / restore / permDel
      const isTrashed = rec.trashed === true;
      const actionButtons = isTrashed
        ? [
            React.createElement("button", { key: "exp", style: styles.actionBtn, disabled: busy, onClick: () => setExportOpen(true) }, t("export")),
            React.createElement("button", { key: "rst", style: styles.actionBtn, disabled: busy, onClick: () => runDelete("restore") }, t("restore")),
            React.createElement("button", { key: "pdm", style: { ...styles.actionBtn, color: colors.error }, disabled: busy, onClick: () => openDeleteConfirm("permDel") }, t("permDel")),
          ]
        : [
            React.createElement("button", { key: "exp", style: styles.actionBtn, disabled: busy, onClick: () => setExportOpen(true) }, t("export")),
            React.createElement("button", { key: "arc", style: styles.actionBtn, disabled: busy, onClick: runArchive }, rec.archived ? t("unarchive") : t("archive")),
            React.createElement("button", { key: "mov", style: styles.actionBtn, disabled: busy, onClick: () => setMoveOpen(true) }, t("move")),
            React.createElement("button", { key: "trm", style: { ...styles.actionBtn, color: colors.error }, disabled: busy, onClick: () => openDeleteConfirm("trash") }, t("trash")),
          ];

      return React.createElement("div", { style: styles.item },
        React.createElement("div", { style: styles.itemHeader },
          React.createElement("div", { style: styles.itemTitle, title: rec.sessionId }, rec.title || rec.sessionId),
          rec.archived && !isTrashed && React.createElement("span", { style: { ...styles.badge, ...styles.badgeArchived } }, t("badge.archived")),
          isTrashed && React.createElement("span", { style: { ...styles.badge, color: colors.warn, borderColor: colors.warn } }, t("filter.trashed"))),
        React.createElement("div", { style: styles.meta },
          React.createElement("span", { style: styles.metaLabel }, t("row.cwd")),
          React.createElement("span", { style: styles.metaValue, title: rec.cwd }, rec.cwd || "—")),
        React.createElement("div", { style: styles.meta },
          React.createElement("span", { style: styles.metaLabel }, t("row.sessionId")),
          React.createElement("span", { style: styles.metaValue, title: rec.sessionId }, rec.sessionId)),
        React.createElement("div", { style: styles.meta },
          React.createElement("span", { style: styles.metaLabel }, t("row.updatedAt")),
          React.createElement("span", { style: styles.metaValue }, fmtTime(rec.updatedAt))),
        React.createElement("div", { style: styles.summary }, rec.summary ? rec.summary : t("summary.empty")),
        err && React.createElement("div", { style: { color: colors.error, fontSize: "12px", marginTop: "6px" } }, err),
        React.createElement("div", { style: styles.actions }, actionButtons),
        exportOpen && React.createElement(ExportModal, { rec, t, colors, styles, onClose: () => setExportOpen(false) }),
        moveOpen && React.createElement(MoveModal, { t, colors, styles, value: moveCwd, onChange: setMoveCwd, onCancel: () => { setMoveOpen(false); setMoveCwd(""); }, onConfirm: runMove, busy }),
        delConfirm && React.createElement(DeleteConfirmModal, {
          t, colors, styles,
          mode: delConfirm.mode,
          title: rec.title || rec.sessionId,
          hint: delConfirm.hint,
          value: delInput,
          onChange: setDelInput,
          onCancel: cancelDelete,
          onConfirm: confirmDelete,
          busy,
        }));
    }

    // ── 子组件：trash / permDel 二次确认弹窗（输入标题末两字才放行）──────────
    // restore 无需此弹窗（无损）。trash/permDel 用同款弹窗，仅文案不同。
    function DeleteConfirmModal({ t, colors, styles, mode, title, hint, value, onChange, onCancel, onConfirm, busy }) {
      useEffect(() => {
        const onKey = (e) => {
          if (e.key === "Escape") onCancel();
          else if (e.key === "Enter") onConfirm();
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
      }, [onCancel, onConfirm]);
      const titleText = mode === "permDel" ? t("permDel") : t("trash");
      return React.createElement("div", { style: styles.modal },
        React.createElement("div", { style: styles.modalCard },
          React.createElement("div", { style: styles.modalTitle }, titleText),
          React.createElement("div", { style: { color: colors.dim, fontSize: "12px", marginBottom: "8px" } }, t("trash.confirm", { title: title })),
          React.createElement("div", { style: { color: colors.dim, fontSize: "12px", marginBottom: "4px" } }, t("trash.confirm2", { hint })),
          React.createElement("input", {
            style: styles.modalInput,
            placeholder: hint,
            value: value,
            autoFocus: true,
            onChange: (e) => onChange(e.target.value),
            onKeyDown: (e) => { if (e.key === "Enter") onConfirm(); },
          }),
          React.createElement("div", { style: styles.modalActions },
            React.createElement("button", { style: styles.actionBtn, onClick: onCancel, disabled: busy }, t("move.cancel")),
            React.createElement("button", {
              style: { ...styles.actionBtn, color: colors.error, opacity: value === hint ? 1 : 0.5 },
              onClick: onConfirm,
              disabled: busy || value !== hint,
            }, titleText))));
    }

    // ── 子组件：移动 cwd 弹窗 ──────────────────────────────────────────
    function MoveModal({ t, colors, styles, value, onChange, onCancel, onConfirm, busy }) {
      useEffect(() => {
        const onKey = (e) => { if (e.key === "Escape") onCancel(); };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
      }, [onCancel]);
      return React.createElement("div", { style: styles.modal },
        React.createElement("div", { style: styles.modalCard },
          React.createElement("div", { style: styles.modalTitle }, t("move")),
          React.createElement("input", {
            style: styles.modalInput,
            placeholder: t("move.placeholder"),
            value: value,
            autoFocus: true,
            onChange: (e) => onChange(e.target.value),
            onKeyDown: (e) => { if (e.key === "Enter") onConfirm(); },
          }),
          React.createElement("div", { style: styles.modalActions },
            React.createElement("button", { style: styles.actionBtn, onClick: onCancel, disabled: busy }, t("move.cancel")),
            React.createElement("button", { style: { ...styles.actionBtn, ...styles.actionPrimary }, onClick: onConfirm, disabled: busy || !value.trim() }, t("move.confirm")))));
    }

    // ── 子组件：导出预览弹窗（带格式选择 + 复制） ────────────────────────
    function ExportModal({ rec, t, colors, styles, onClose }) {
      const [format, setFormat] = useState("acp");
      const [text, setText] = useState("");
      const [loading, setLoading] = useState(true);
      const [err, setErr] = useState(null);
      const [copied, setCopied] = useState(false);
      useEffect(() => {
        let alive = true;
        setLoading(true); setErr(null);
        apiPost("export", { sessionId: rec.sessionId, format })
          .then((data) => { if (alive) setText(data.text || ""); })
          .catch((e) => { if (alive) setErr(e.message); })
          .finally(() => { if (alive) setLoading(false); });
        return () => { alive = false; };
      }, [format, rec.sessionId]);
      useEffect(() => {
        const onKey = (e) => { if (e.key === "Escape") onClose(); };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
      }, [onClose]);
      const doCopy = async () => {
        try {
          if (navigator && navigator.clipboard && navigator.clipboard.writeText) {
            await navigator.clipboard.writeText(text);
          }
          setCopied(true);
          setTimeout(() => setCopied(false), 1200);
        } catch (_) { /* ignore */ }
      };
      return React.createElement("div", { style: styles.modal },
        React.createElement("div", { style: { ...styles.modalCard, maxWidth: "560px" } },
          React.createElement("div", { style: styles.modalTitle }, t("export") + " · " + (rec.title || rec.sessionId)),
          React.createElement("div", { style: { display: "flex", gap: "6px", alignItems: "center", marginBottom: "8px" } },
            React.createElement("span", { style: { color: colors.dim, fontSize: "12px" } }, t("export.format")),
            React.createElement("select", { style: styles.select, value: format, onChange: (e) => setFormat(e.target.value) },
              React.createElement("option", { value: "acp" }, "acp"),
              React.createElement("option", { value: "claude" }, "claude"),
              React.createElement("option", { value: "markdown" }, "markdown"))),
          err && React.createElement("div", { style: { color: colors.error, fontSize: "12px", marginBottom: "6px" } }, err),
          loading
            ? React.createElement("div", { style: { color: colors.dim, padding: "8px 0" } }, t("loading"))
            : React.createElement("pre", { style: styles.pre }, text),
          React.createElement("div", { style: styles.modalActions },
            React.createElement("button", { style: styles.actionBtn, onClick: doCopy, disabled: loading || !!err }, copied ? t("export.copied") : t("export.copy")),
            React.createElement("button", { style: styles.actionBtn, onClick: onClose }, t("export.close")))));
    }

    // ── Obsidian 导入视图：发现 + 一键导入 ──────────────────────────────
    function ObsidianImport({ t, colors, styles }) {
      const [list, setList] = useState(null);
      const [err, setErr] = useState(null);
      const [busy, setBusy] = useState(false);

      const load = () => {
        setErr(null);
        apiPost("obsidian-list", {})
          .then((d) => setList(Array.isArray(d.sessions) ? d.sessions : []))
          .catch((e) => setErr(e.message));
      };
      useEffect(() => { load(); }, []);

      const doImport = async (path) => {
        setBusy(true); setErr(null);
        try {
          await apiPost("obsidian-import", { path });
          load();
        } catch (e) { setErr(e.message); }
        finally { setBusy(false); }
      };
      const doImportAll = async () => {
        const un = (list || []).filter((s) => !s.imported);
        if (un.length === 0) return;
        setBusy(true); setErr(null);
        try {
          for (const s of un) { try { await apiPost("obsidian-import", { path: s.path }); } catch (_) {} }
          load();
        } finally { setBusy(false); }
      };

      const un = (list || []).filter((s) => !s.imported);
      const vlu = (s) => { try { return String(s.vault || "").split("/").pop().split("\\").pop(); } catch { return ""; } };

      return React.createElement(React.Fragment, null,
        React.createElement("div", { style: { padding: "12px 14px", borderBottom: "1px solid " + colors.border } },
          React.createElement("div", { style: { fontWeight: 600, marginBottom: "4px" } }, t("import.title")),
          React.createElement("div", { style: { color: colors.dimmer, fontSize: "12px" } }, t("import.desc")),
          un.length > 0 && React.createElement("button", {
            style: { ...styles.toolBtn, marginTop: "10px", background: colors.accent, color: colors.accentForeground, borderColor: colors.accent },
            onClick: doImportAll, disabled: busy,
          }, t("import.all") + " (" + un.length + ")")),
        err && React.createElement("div", { style: styles.error }, t("error.load", { msg: err })),
        React.createElement("div", { style: styles.list },
          !list
            ? React.createElement("div", { style: styles.status }, t("loading"))
            : list.length === 0
              ? React.createElement("div", { style: styles.status }, t("import.empty"))
              : list.map((s) =>
                  React.createElement("div", { key: s.path, style: { ...styles.item, opacity: s.imported ? 0.55 : 1 } },
                    React.createElement("div", { style: styles.itemHeader },
                      React.createElement("div", { style: styles.itemTitle, title: s.path }, s.title || s.sessionId),
                      React.createElement("span", { style: { ...styles.badge, ...(s.imported ? styles.badgeArchived : {}) } },
                        s.imported ? t("import.imported") : t("import.notImported"))),
                    React.createElement("div", { style: styles.meta },
                      React.createElement("span", { style: styles.metaLabel }, t("import.agent")),
                      React.createElement("span", { style: styles.metaValue }, s.agentId || "—")),
                    React.createElement("div", { style: styles.meta },
                      React.createElement("span", { style: styles.metaLabel }, t("import.messages", { n: s.messages })),
                      React.createElement("span", { style: styles.metaValue }, s.imported ? "" : (s.imported ? t("import.imported") : (t("import.vault") + ": " + vlu(s))))),
                    !s.imported && React.createElement("div", { style: styles.actions },
                      React.createElement("button", { style: { ...styles.actionBtn, ...styles.actionPrimary }, disabled: busy, onClick: () => doImport(s.path) }, t("import.single")))))));
    }

    // ── 「会话」合并列表视图：DSH 原生会话 + Obsidian(dsh-acp) 会话，标注来源 ──
    // 并行拉 dsh-list（原生）与 obsidian-list（Obsidian 侧 agentId=dsh-acp 的 acp 会话），
    // 归一化合并成一个列表，每行标注「原生 / Obsidian」徽标 + 对话轮数 + 总结概要。
    function SessionMergeList({ t, colors, styles, onClose }) {
      const [rows, setRows] = useState(null);
      const [err, setErr] = useState(null);
      const [query, setQuery] = useState("");
      const [copied, setCopied] = useState("");

      const load = () => {
        setErr(null);
        Promise.all([
          apiPost("dsh-list", {}).catch(() => ({ sessions: [] })),
          apiPost("obsidian-list", {}).catch(() => ({ sessions: [] })),
        ])
          .then(([native, obsidian]) => {
            const merged = [];
            // dsh-obsidian-* 是我们通过 Obsidian 导入写进 dsh 原生存储的会话——
            // 它确实来自 dsh 原生数据源，但语义上是"由 Obsidian 导入产生"。
            // 合并列表里标为 obsidian 来源 + 在 obsidian 列表里跳过（避免重复）。
            const importedFromNative = new Set();
            // DSH 原生会话（轮数/概要由后端 dsh-list 补齐）
            for (const r of (Array.isArray(native.sessions) ? native.sessions : [])) {
              if (!r || !r.sessionId) continue;
              const isObsidianImport = r.sessionId.startsWith("dsh-obsidian-");
              if (isObsidianImport) importedFromNative.add(r.sessionId);
              merged.push({
                key: "n-" + r.sessionId,
                sessionId: r.sessionId,
                title: r.title || r.sessionId,
                source: isObsidianImport ? "obsidian" : "native",
                turns: typeof r.turns === "number" ? r.turns : null,
                summary: r.summary || "",
                updatedAt: r.updatedAt || 0,
              });
            }
            // Obsidian dsh-acp 会话（仅展示我们插件在 Obsidian 生成的 acp 会话）。
            // 已被 dsh-list 包含的（导入到原生存储）跳过，避免重复行——
            // 重复行会导致「复制 ID」点击错位 + 计数失真。
            for (const s of (Array.isArray(obsidian.sessions) ? obsidian.sessions : [])) {
              if (!s || s.agentId !== "dsh-acp") continue;
              if (importedFromNative.has(s.sessionId)) continue;
              merged.push({
                key: "o-" + s.sessionId,
                sessionId: s.sessionId,
                title: s.title || s.sessionId,
                source: "obsidian",
                // 仅「纯 Obsidian」会话带 path（Obsidian vault 里的 .json 文件绝对路径）。
                // 已导入到 dsh 原生存储的 dsh-obsidian-* 走 native 分支带 source:"obsidian"
                // 但无 path —— 用「是否有 path」区分两者，决定点击时是「打开」还是「先导入再打开」。
                ...(typeof s.path === "string" && s.path ? { path: s.path } : {}),
                turns: typeof s.userTurns === "number" ? s.userTurns : null,
                summary: "",
                updatedAt: s.savedAt ? new Date(s.savedAt).getTime() : 0,
              });
            }
            merged.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
            setRows(merged);
          })
          .catch((e) => setErr(e.message));
      };
      useEffect(() => { load(); }, []);

      const copyId = async (id) => {
        try {
          if (navigator && navigator.clipboard && navigator.clipboard.writeText) {
            await navigator.clipboard.writeText(id);
          }
          setCopied(id);
          setTimeout(() => setCopied((cur) => (cur === id ? "" : cur)), 1200);
        } catch (_) { /* 复制失败不阻塞 */ }
      };

      // 行点击：dsh web SPA 唯一支持的程序化选会话入口是 uiWorkspace.openSession。
      // dsh web URL 不暴露 sessionId（实测手动开会话地址栏不变），所以 hash/path 跳转无效。
      // 三种行类型，点击行为不同：
      //   1. native 行（含已导入到 dsh 原生存储的 dsh-obsidian-*）：直接 openSession 切换布局
      //   2. 纯 obsidian 行（带 path，未导入）：先调 obsidian-import 导入为 dsh 原生会话，
      //      拿到新 sessionId 后再 openSession，最后关面板
      //   3. uiWorkspace 缺失 / 导入失败：降级复制 ID + 提示，不死锁
      const openSession = async (row) => {
        if (!uiWorkspaceSvc || typeof uiWorkspaceSvc.openSession !== "function") {
          copyId(row.sessionId);
          setErr(t("row.open.unavailable"));
          setTimeout(() => setErr((cur) => cur === t("row.open.unavailable") ? null : cur), 2400);
          return;
        }
        try {
          let targetId = row.sessionId;
          // 纯 Obsidian 会话（未导入）：先导入到 dsh 原生存储，目标 ID 换成导入后的新会话。
          if (row.path) {
            setErr(null);
            const res = await apiPost("obsidian-import", { path: row.path });
            if (res && res.sessionId) targetId = res.sessionId;
            // 导入后立刻 openSession：dsh web SPA 的 summaries 是跳转前拉的，
            // 新会话可能还没进本地 list —— 兜底：忽略 select 抛出的 unknown session，
            // 提示用户刷新后再搜（导入本身已成功，dsh 存储里有）。
          }
          uiWorkspaceSvc.openSession(targetId);
          onClose && onClose();
        } catch (e) {
          // openSession 对「不在 SPA summaries 列表里的会话」会抛 unknown session。
          // 对纯 obsidian 行：导入已成功，给可理解的提示；对 native 行：真实失败。
          const msg = (e && e.message) || String(e);
          if (row.path && /unknown session/i.test(msg)) {
            setErr(t("row.open.importedReload"));
          } else {
            setErr(msg.startsWith("sessions.select") ? t("row.open.notListed", { id: row.sessionId }) : msg);
          }
        }
      };

      // 搜索过滤：按 sessionId/title/来源包含 query（不区分大小写）
      const q = (query || "").trim().toLowerCase();
      const filtered = !rows ? [] : (!q ? rows : rows.filter((r) => {
        const id = (r.sessionId || "").toLowerCase();
        const title = (r.title || "").toLowerCase();
        const src = r.source === "native" ? "native" : "obsidian";
        return id.includes(q) || title.includes(q) || src.includes(q);
      }));

      return React.createElement(React.Fragment, null,
        React.createElement("div", { style: { padding: "10px 14px", borderBottom: "1px solid " + colors.border, color: colors.dimmer, fontSize: "12px", display: "flex", alignItems: "center" } },
          React.createElement("span", { style: { flex: 1 } }, t("merged.desc")),
          React.createElement("button", { style: styles.toolBtn, onClick: load }, t("refresh"))),
        // 搜索框：按 sessionId / 标题 / 来源 过滤
        React.createElement("div", { style: { padding: "8px 14px", borderBottom: "1px solid " + colors.border, display: "flex", alignItems: "center", gap: "8px" } },
          React.createElement("input", {
            type: "text",
            value: query,
            placeholder: t("search.placeholder"),
            onChange: (e) => setQuery(e.target.value),
            style: {
              flex: 1,
              padding: "6px 8px",
              fontSize: "12px",
              background: "var(--dsw-alias-surface-secondary, transparent)",
              color: "var(--dsw-alias-text-default)",
              border: "1px solid " + colors.border,
              borderRadius: "4px",
              outline: "none",
            },
          }),
          q && React.createElement("button", {
            style: { ...styles.toolBtn, padding: "4px 8px" },
            onClick: () => setQuery(""),
            title: t("search.clear"),
          }, "✕"),
          q && React.createElement("span", {
            style: { color: colors.dimmer, fontSize: "11px" },
          }, filtered.length + " / " + (rows ? rows.length : 0))),
        err && React.createElement("div", { style: styles.error }, t("error.load", { msg: err })),
        React.createElement("div", { style: styles.list },
          !rows
            ? React.createElement("div", { style: styles.status }, t("loading"))
            : filtered.length === 0
              ? React.createElement("div", { style: styles.status }, q ? t("search.empty") : t("empty"))
              : filtered.map((r) => {
                  const isNative = r.source === "native";
                  // 行整体可点击：调 uiWorkspace.openSession 切换 SPA 会话视图。
                  // 复制按钮调用 stopPropagation 避免触发行 onClick。
                  return React.createElement("div", {
                    key: r.key,
                    style: { ...styles.item, cursor: "pointer" },
                    onClick: () => openSession(r),
                    onMouseEnter: (e) => { e.currentTarget.style.background = styles.itemHover.background; },
                    onMouseLeave: (e) => { e.currentTarget.style.background = colors.field; },
                    title: isNative ? t("row.open.hint") : t("row.open.unavailable"),
                  },
                    React.createElement("div", { style: styles.itemHeader },
                      React.createElement("div", { style: styles.itemTitle, title: r.sessionId }, r.title),
                      React.createElement("span", {
                        style: isNative
                          ? { ...styles.badge, color: colors.accent, borderColor: colors.accent }
                          : { ...styles.badge, color: colors.warn, borderColor: colors.warn },
                      }, isNative ? t("source.native") : t("source.obsidian"))),
                    // 会话 ID 行：等宽字体 + 灰色 + 复制按钮
                    React.createElement("div", { style: styles.meta },
                      React.createElement("span", { style: styles.metaLabel }, t("row.sessionId")),
                      React.createElement("span", {
                        style: {
                          ...styles.metaValue,
                          fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
                          fontSize: "11px",
                          color: colors.dim,
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                          maxWidth: "260px",
                        },
                        title: r.sessionId,
                      }, r.sessionId),
                      React.createElement("button", {
                        style: { ...styles.actionBtn, marginLeft: "6px", padding: "2px 6px", fontSize: "11px" },
                        onClick: (e) => { e.stopPropagation(); copyId(r.sessionId); },
                        title: t("copy.id"),
                      }, copied === r.sessionId ? t("copied") : t("copy")),
                      // 「打开」按钮：点击行整体等同，但显式按钮便于发现。
                      React.createElement("button", {
                        style: { ...styles.actionBtn, marginLeft: "6px", padding: "2px 6px", fontSize: "11px" },
                        onClick: (e) => { e.stopPropagation(); openSession(r); },
                        title: t("row.open.hint"),
                      }, t("row.open"))),
                    React.createElement("div", { style: styles.meta },
                      React.createElement("span", { style: styles.metaLabel }, t("row.turns")),
                      React.createElement("span", { style: styles.metaValue },
                        typeof r.turns === "number" ? String(r.turns) : "—")),
                    React.createElement("div", { style: styles.meta },
                      React.createElement("span", { style: styles.metaLabel }, t("row.summary")),
                      React.createElement("span", { style: styles.metaValue }, r.summary || t("summary.empty"))),
                    React.createElement("div", { style: styles.meta },
                      React.createElement("span", { style: styles.metaLabel }, t("row.updatedAt")),
                      React.createElement("span", { style: styles.metaValue }, fmtTime(r.updatedAt))));
                })));
    }

    // ── 子组件：原生 dsh 会话（与左侧侧栏同源；纯 list + open + copy ID） ──
    // 数据走 sp.list()（/api-session/dsh-list）；dsh 原生 SessionController 不暴露
    // delete API，所以这个视图只提供「打开会话」+「复制 ID」两类操作；archive/move/
    // trash/restore/permDel 这些强需求走 obsidian 子组件（dsh-acp 私有归档）。
    function AcpNativeSessionList({ t, colors, styles, onClose }) {
      const [rows, setRows] = useState(null);
      const [err, setErr] = useState(null);
      const [query, setQuery] = useState("");
      const [copied, setCopied] = useState("");

      const load = () => {
        setErr(null);
        apiPost("dsh-list", {})
          .then((res) => {
            const all = Array.isArray(res.sessions) ? res.sessions : [];
            // 排除已导入的 dsh-obsidian-*（那些在 obsidian 会话视图里展示，避免重复）
            const rows = all
              .filter((r) => r && r.sessionId && !r.sessionId.startsWith("dsh-obsidian-"))
              .map((r) => ({
                sessionId: r.sessionId,
                title: r.title || r.sessionId,
                turns: typeof r.turns === "number" ? r.turns : null,
                summary: r.summary || "",
                cwd: r.cwd || "",
                updatedAt: r.updatedAt || 0,
              }));
            rows.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
            setRows(rows);
          })
          .catch((e) => setErr((e && e.message) || String(e)));
      };
      useEffect(() => { load(); }, []);

      const copyId = async (id) => {
        try {
          if (navigator && navigator.clipboard && navigator.clipboard.writeText) {
            await navigator.clipboard.writeText(id);
          }
          setCopied(id);
          setTimeout(() => setCopied((cur) => (cur === id ? "" : cur)), 1200);
        } catch (_) { /* 复制失败不阻塞 */ }
      };

      const openSession = (id) => {
        if (!uiWorkspaceSvc || typeof uiWorkspaceSvc.openSession !== "function") {
          copyId(id);
          setErr(t("row.open.unavailable"));
          setTimeout(() => setErr((cur) => cur === t("row.open.unavailable") ? null : cur), 2400);
          return;
        }
        try { uiWorkspaceSvc.openSession(id); onClose && onClose(); }
        catch (e) { setErr((e && e.message) || String(e)); }
      };

      const q = (query || "").trim().toLowerCase();
      const filtered = !rows ? [] : (!q ? rows : rows.filter((r) => {
        const id = (r.sessionId || "").toLowerCase();
        const title = (r.title || "").toLowerCase();
        return id.includes(q) || title.includes(q);
      }));

      return React.createElement(React.Fragment, null,
        React.createElement("div", {
          style: { padding: "10px 14px", borderBottom: "1px solid " + colors.border, color: colors.dimmer, fontSize: "12px", display: "flex", alignItems: "center" },
        },
          React.createElement("span", { style: { flex: 1 } }, t("native.desc")),
          React.createElement("button", { style: styles.toolBtn, onClick: load }, t("refresh"))),
        React.createElement("div", {
          style: { padding: "8px 14px", borderBottom: "1px solid " + colors.border, display: "flex", alignItems: "center", gap: "8px" },
        },
          React.createElement("input", {
            type: "text",
            value: query,
            placeholder: t("search.placeholder"),
            onChange: (e) => setQuery(e.target.value),
            style: {
              flex: 1,
              padding: "6px 8px",
              fontSize: "12px",
              background: "var(--dsw-alias-surface-secondary, transparent)",
              color: "var(--dsw-alias-text-default)",
              border: "1px solid " + colors.border,
              borderRadius: "4px",
              outline: "none",
            },
          }),
          q && React.createElement("button", {
            style: { ...styles.toolBtn, padding: "4px 8px" },
            onClick: () => setQuery(""),
            title: t("search.clear"),
          }, "✕"),
          q && React.createElement("span", { style: { color: colors.dimmer, fontSize: "11px" } },
            filtered.length + " / " + (rows ? rows.length : 0))),
        err && React.createElement("div", { style: styles.error }, t("error.load", { msg: err })),
        React.createElement("div", { style: styles.list },
          !rows
            ? React.createElement("div", { style: styles.status }, t("loading"))
            : filtered.length === 0
              ? React.createElement("div", { style: styles.status }, q ? t("search.empty") : t("empty"))
              : filtered.map((r) =>
                  React.createElement("div", {
                    key: r.sessionId,
                    style: { ...styles.item, cursor: "pointer" },
                    onClick: () => openSession(r.sessionId),
                    onMouseEnter: (e) => { e.currentTarget.style.background = styles.itemHover.background; },
                    onMouseLeave: (e) => { e.currentTarget.style.background = colors.field; },
                    title: t("row.open.hint"),
                  },
                    React.createElement("div", { style: styles.itemHeader },
                      React.createElement("div", { style: styles.itemTitle, title: r.sessionId }, r.title)),
                    React.createElement("div", { style: styles.meta },
                      React.createElement("span", { style: styles.metaLabel }, t("row.sessionId")),
                      React.createElement("span", {
                        style: {
                          ...styles.metaValue,
                          fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
                          fontSize: "11px",
                          color: colors.dim,
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                          maxWidth: "260px",
                        },
                        title: r.sessionId,
                      }, r.sessionId),
                      React.createElement("button", {
                        style: { ...styles.actionBtn, marginLeft: "6px", padding: "2px 6px", fontSize: "11px" },
                        onClick: (e) => { e.stopPropagation(); copyId(r.sessionId); },
                        title: t("copy.id"),
                      }, copied === r.sessionId ? t("copied") : t("copy")),
                      React.createElement("button", {
                        style: { ...styles.actionBtn, marginLeft: "6px", padding: "2px 6px", fontSize: "11px" },
                        onClick: (e) => { e.stopPropagation(); openSession(r.sessionId); },
                        title: t("row.open.hint"),
                      }, t("row.open"))),
                    React.createElement("div", { style: styles.meta },
                      React.createElement("span", { style: styles.metaLabel }, t("row.cwd")),
                      React.createElement("span", { style: styles.metaValue }, r.cwd || "—")),
                    React.createElement("div", { style: styles.meta },
                      React.createElement("span", { style: styles.metaLabel }, t("row.turns")),
                      React.createElement("span", { style: styles.metaValue },
                        typeof r.turns === "number" ? String(r.turns) : "—")),
                    React.createElement("div", { style: styles.meta },
                      React.createElement("span", { style: styles.metaLabel }, t("row.summary")),
                      React.createElement("span", { style: styles.metaValue }, r.summary || t("summary.empty"))),
                    React.createElement("div", { style: styles.meta },
                      React.createElement("span", { style: styles.metaLabel }, t("row.updatedAt")),
                      React.createElement("span", { style: styles.metaValue }, fmtTime(r.updatedAt))))
                )));
    }

    // ── 子组件：obsidian 会话（含 dsh-acp 私有归档 3 chip + import 入口） ──
    // 数据走 listManagedSessions(filter) (/api-session/list)；trash / restore / permDel /
    // archive / move / export 完整操作保留（来自 SessionItem）。
    // 顶部「导入 Obsidian 会话…」按钮展开 ObsidianImport 内嵌视图（与历史 3 subTab
    // sessions/archive/import 行为等价，但合并到同一个 subTab 节省导航层级）。
    function AcpObsidianSessionList({ t, colors, styles }) {
      const [importing, setImporting] = useState(false);
      return React.createElement(React.Fragment, null,
        // 顶部 import 入口
        React.createElement("div", {
          style: {
            padding: "8px 14px",
            borderBottom: "1px solid " + colors.border,
            display: "flex",
            alignItems: "center",
            gap: "8px",
          },
        },
          React.createElement("span", { style: { flex: 1, color: colors.dimmer, fontSize: "12px" } },
            t("obsidian.desc")),
          React.createElement("button", {
            type: "button",
            style: styles.toolBtn,
            onClick: () => setImporting((v) => !v),
            title: t("import.button"),
          }, importing ? "✕" : t("import.button"))),
        importing
          ? React.createElement(ObsidianImport, { t, colors, styles })
          : React.createElement(AcpArchiveList, { t, colors, styles }));
    }

    // ── 主面板内容：列表/导入视图切换（不含 header/overlay/close，共享给 ShellPanel 与 better-sidebar tab） ──
    // better-sidebar tab 模式下不渲染 title/subtitle/✕（由 better-sidebar 提供 tab chrome）；
    // 自绘 ShellPanel 模式下由 PanelContent 包一层 header。范式对齐 dsh-chat-import v0.11.3
    // lib/client.js ImportTabContent（embedded 模式复用同一份内容）。
    function AcpTabContent({ t, colors, styles, onClose }) {
      const [view, setView] = useState("native");
      const subTab = (id, label) => React.createElement("button", {
        type: "button",
        onClick: () => setView(id),
        style: {
          flex: "1", padding: "8px 0", border: "none", cursor: "pointer",
          fontSize: "13px", fontWeight: 600,
          background: view === id ? colors.field : "transparent",
          color: view === id ? colors.text : colors.dim,
          borderBottom: view === id ? "2px solid " + colors.accent : "2px solid transparent",
        },
      }, label);
      // 两个 subTab：原生 dsh 会话（sp.list()，仅打开/复制 ID）+ obsidian 会话（dsh-acp
      // 私有归档 3 chip + 顶部内嵌 import）。原 3 subTab (sessions/archive/import) 已被
      // #28/#30 拆分 + 合并——见 AcpNativeSessionList / AcpObsidianSessionList。
      return React.createElement(React.Fragment, null,
        React.createElement("div", {
          style: { display: "flex", flexShrink: 0, borderBottom: "1px solid " + colors.border },
        },
          subTab("native", t("tab.native")),
          subTab("obsidian", t("tab.obsidian"))),
        view === "obsidian"
          ? React.createElement(AcpObsidianSessionList, { t, colors, styles })
          : React.createElement(AcpNativeSessionList, { t, colors, styles, onClose }));
    }

    // ── 子组件：dsh-acp 私有归档（archive-store.mjs 维护的 session 记录）──────
    // 与 SessionMergeList 互不干扰：merge list 走 dsh 原生 + Obsidian 两路数据源；
    // 这里专管 dsh-acp 自己的 ~/.dsh-acp/sessions/<cwd>/<archive>/ 归档，
    // 提供 archive/move/export/trash/restore/permDel 完整操作 + 回收站。
    // 范围：仅 dsh-acp 私有（dsh native session 删除待 ctx.sessionPersistence 评估后扩展）。
    function AcpArchiveList({ t, colors, styles }) {
      const [rows, setRows] = useState(null);
      const [err, setErr] = useState(null);
      const [filter, setFilter] = useState("active"); // active | archived | trashed

      const load = () => {
        setErr(null);
        apiPost("list", { filter })
          .then((res) => setRows(Array.isArray(res.sessions) ? res.sessions : []))
          .catch((e) => setErr(e.message));
      };
      useEffect(() => { load(); }, [filter]);

      // 「清空回收站」——连续 permDel 每条 trashed 记录（每条都要 confirm，按 dsh-acp
      // 私有归档的 trashSession 已设旗标，所以 r.trashed === true）。逐条二次确认
      // 太啰嗦；这里走：先 confirm 总条数 → 弹出标题列表 → 用户勾选确认 → 逐条 permDel。
      const emptyTrash = async () => {
        if (!rows || !rows.length) return;
        if (!window.confirm(t("empty.trash.confirm", { n: rows.length }))) return;
        setErr(null);
        for (const r of rows) {
          try { await apiPost("delete", { sessionId: r.sessionId, mode: "permDel" }); }
          catch (e) { setErr(`清理 ${r.sessionId} 失败：${e.message}`); }
        }
        load();
      };

      // filter chip：active / archived / trashed；trashed 显示「清空回收站」按钮
      const chip = (id, label) => React.createElement("button", {
        type: "button",
        onClick: () => setFilter(id),
        style: {
          padding: "4px 10px",
          fontSize: "12px",
          border: "1px solid " + colors.border,
          borderRadius: "12px",
          cursor: "pointer",
          background: filter === id ? colors.accent : "transparent",
          color: filter === id ? colors.accentForeground : colors.text,
          borderColor: filter === id ? colors.accent : colors.border,
        },
      }, label);

      return React.createElement(
        React.Fragment,
        null,
        // 顶部：filter chip 行 + 操作按钮
        React.createElement(
              "div",
              { style: { padding: "8px 14px", borderBottom: "1px solid " + colors.border, display: "flex", alignItems: "center", gap: "6px", flexWrap: "wrap" } },
              chip("active", t("filter.active")),
              chip("archived", t("filter.archived")),
              chip("trashed", t("filter.trashed")),
              React.createElement("span", { style: { flex: 1 } }),
              filter === "trashed" && rows && rows.length > 0
                && React.createElement(
                  "button",
                  {
                    type: "button",
                    style: { ...styles.toolBtn, color: colors.error, borderColor: colors.error },
                    onClick: emptyTrash,
                    title: t("empty.trash"),
                  },
                  t("empty.trash")
                ),
              React.createElement(
                "button",
                { type: "button", style: styles.toolBtn, onClick: load, title: t("refresh") },
                t("refresh")
              )
            ),
        err && React.createElement("div", { style: styles.error }, t("error.load", { msg: err })),
        React.createElement(
          "div",
          { style: styles.list },
          !rows
            ? React.createElement("div", { style: styles.status }, t("loading"))
            : rows.length === 0
              ? React.createElement("div", { style: styles.status }, t("empty"))
              : rows.map((r) =>
                  React.createElement(SessionItem, { key: r.sessionId, rec: r, t, colors, styles, onChanged: load })
                )
        )
      );
    }

    // ── ShellPanel 用的包装：自带 header（title + subtitle + ✕）+ AcpTabContent ──────
    function PanelContent({ t, colors, styles, onClose }) {
      return React.createElement(React.Fragment, null,
        React.createElement("div", { style: styles.header },
          React.createElement("div", { style: styles.headerLeft },
            React.createElement("div", { style: { minWidth: 0, flex: "1 1 auto" } },
              React.createElement("div", { style: styles.title }, t("panel.title")),
              React.createElement("div", { style: styles.subtitle }, t("panel.subtitle")))),
          React.createElement("button", { style: styles.close, onClick: onClose, title: t("close") }, "✕")),
        React.createElement(AcpTabContent, { t, colors, styles, onClose }));
    }

    // ── better-sidebar tab 组件：渲染 AcpTabContent，关闭 = 关闭该 tab（service 在
    // apply 里 registerTab 时闭包）。面板展开由 openTab 负责，组件自身不碰 panel 状态。
    // 范式对齐 dsh-chat-import v0.11.3 ImportTabComponent。──────────────────────────
    function AcpTabComponent(props) {
      const t = useTranslate();
      const colors = themeColors();
      const styles = makeStyles(colors);
      return React.createElement(AcpTabContent, {
        t, colors, styles,
        onClose: () => { if (betterSidebarService) betterSidebarService.closeTab(props.tab.id); },
      });
    }

    // ── ShellPanel：遮罩 + 右侧滑出面板 ─────────────────────────────────
    function ShellPanel({ onClose }) {
      const t = useTranslate();
      const colors = themeColors();
      const styles = makeStyles(colors);
      useEffect(() => {
        const onKey = (e) => { if (e.key === "Escape") onClose(); };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
      }, [onClose]);
      return React.createElement("div", { style: styles.overlay, onClick: onClose },
        React.createElement("div", { style: styles.panel, onClick: (e) => e.stopPropagation() },
          React.createElement(PanelContent, { t, colors, styles, onClose })));
    }

    // ── 侧边栏触发按钮：footer 布局感知，不遮盖同槽其它插件（生态对齐 dsh-chat-import）
    //
    // footerActions 是默认不换行的 flex 行；cordis 徽标 `width: calc(100% + 4px)`、
    // 市场 launcher、usage-billing 计费卡等不可收缩、占满整行，nowrap 时会把本按钮
    // 挤出容器并被侧边栏 overflow:hidden 裁剪、或压住同槽条目（早期 width:100% +
    // flex:0 0 auto 独占整行即「遮盖其它插件位置」的根因）。沿用 dsh-chat-import
    // issue #31/#25/#39 的布局事实判定（与「它是谁」无关，新增来源无需补选择器）：
    //   ① 检测到整宽占用者 → 宽态下把容器换成 flex-wrap，让本按钮以整宽行落到
    //      占用者下方纵向堆叠（不压会话列表末尾行）；
    //   ② nowrap 无占用者 + row 容器 → flex:1 1 auto 与同槽其它入口共享一行；
    //   ③ column / wrap 容器 → 保持 flex:0 0 auto + width:100%，高度随内容；
    //   ④ rail 态恒为 36×36 圆钮、不浮层（56px 纵栏里浮层必压同列占用者）。
    // 仅宽态换行（rail 容器 width:auto，换行破坏 56px 纵栏图标堆叠居中）。
    const FOOTER_OCCUPANT_LEGACY = ["[data-cordis-badge]", ".dshMarketLauncher", "[data-testid='billing-trigger']", ".cm-footer-stack"];
    const isFooterSqueezed = (scrollWidth, clientWidth) => Number.isFinite(scrollWidth)
      && Number.isFinite(clientWidth) && scrollWidth > clientWidth + 1;
    const isFooterOccupant = (entry, context) => {
      if (!entry || entry.visible !== true) return false;
      if (entry.position === "fixed" || entry.position === "absolute") return false;
      if (!(entry.width > 0) || !(entry.height > 0)) return false;
      if (context && context.squeezed === true) return true;
      return Number.isFinite(context && context.containerWidth) && entry.width >= context.containerWidth - 1;
    };
    const footerOccupantRect = () => {
      if (typeof document === "undefined") return null;
      const marker = document.querySelector("[data-slot='sidebar.footer.action']");
      const container = marker && marker.parentElement;
      if (!container) return null;
      const crect = container.getBoundingClientRect();
      if (crect.width <= 0) return null;
      const context = {
        containerWidth: crect.width,
        squeezed: isFooterSqueezed(marker.scrollWidth, marker.clientWidth),
      };
      let best = null;
      const consider = (el) => {
        const cs = getComputedStyle(el);
        const r = el.getBoundingClientRect();
        if (isFooterOccupant({
          visible: cs.display !== "none" && cs.visibility !== "hidden" && cs.opacity !== "0",
          position: cs.position, width: r.width, height: r.height,
        }, context) && (!best || r.top < best.top)) {
          best = { top: r.top, left: r.left, width: r.width, height: r.height };
        }
      };
      for (const el of container.children) {
        if (el === marker || el.contains(marker)) continue;
        consider(el);
      }
      if (!best) {
        for (const sel of FOOTER_OCCUPANT_LEGACY) {
          const el = document.querySelector(sel);
          if (el && !el.contains(marker)) consider(el);
        }
      }
      if (best) return best;
      const mrect = marker.getBoundingClientRect();
      return context.squeezed && mrect.width > 0
        ? { top: mrect.top, left: mrect.left, width: mrect.width, height: mrect.height }
        : null;
    };
    const footerLayout = () => {
      if (typeof document === "undefined") return { wraps: false, dir: null };
      const marker = document.querySelector("[data-slot='sidebar.footer.action']");
      if (!marker || !marker.parentElement) return { wraps: false, dir: null };
      const cs = getComputedStyle(marker.parentElement);
      return { wraps: cs.flexWrap === "wrap", dir: cs.flexDirection };
    };
    /** 容器级拥挤信号：footerActions 自身的 scrollWidth > clientWidth。
     *  比 marker（SlotOutlet 用 display:contents 包裹，scrollWidth/clientWidth
     *  恒为 0）的 isFooterSqueezed 更可靠——多个 width:100% 子项（如 cost-meter
     *  的 .cm-footer-stack）在 nowrap 行内被 flex-shrink 等比压缩到 containerWidth/N，
     *  isFooterOccupant 的 `width >= containerWidth` 判定会 miss，但容器溢出
     *  永远是真：子项装不下。检测到即视为拥挤，应强制 wrap 让整宽条目各自成行。
     * 这是 chat-import 现有机制（#31/#25/#39）的盲区补偿：#39 修了「单占用者」，
     * 没修「多个 width:100% 互相把对方挤到不整宽」的复合场景。 */
    const isFooterContainerCramped = (container) => {
      if (!container) return false;
      return container.scrollWidth > container.clientWidth + 1;
    };

    // acp 会话管理图标（聊天气泡 + 三个点）：TriggerButton 与 better-sidebar tab
    // 共用同一份，保持 plugin 简洁风格、不沿用 dsh-chat-import 专属 logo。
    function AcpLogoIcon({ size, style }) {
      const s = typeof size === "number" ? size : 16;
      return React.createElement("svg", {
        width: s, height: s, viewBox: "0 0 24 24", fill: "none",
        xmlns: "http://www.w3.org/2000/svg", "aria-hidden": true,
        style: style || undefined,
      },
        React.createElement("path", {
          d: "M4 5h16a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H8l-4 3V6a1 1 0 0 1 1-1z",
          stroke: "currentColor", strokeWidth: "1.6", strokeLinejoin: "round",
        }),
        React.createElement("circle", { cx: "9", cy: "11", r: "0.9", fill: "currentColor" }),
        React.createElement("circle", { cx: "12", cy: "11", r: "0.9", fill: "currentColor" }),
        React.createElement("circle", { cx: "15", cy: "11", r: "0.9", fill: "currentColor" }));
    }

    // 侧边栏触发按钮（对齐 dsh-chat-import 同款窄宽降级 + footer 布局感知样式）
    function TriggerButton({ wide }) {
      const t = useTranslate();
      const [open, setOpen] = useState(false);
      const rail = wide === false;
      const [layout, setLayout] = useState(() => footerLayout());
      const [anchor, setAnchor] = useState(() => footerOccupantRect());
      useEffect(() => {
        let wrapContainer = null;
        let wrapOriginal = "";
        const check = () => {
          const marker = document.querySelector("[data-slot='sidebar.footer.action']");
          const container = marker && marker.parentElement;
          if (container && container !== wrapContainer) {
            wrapContainer = container;
            wrapOriginal = container.style.flexWrap || "";
          }
          const occupant = footerOccupantRect();
          // 宽态 + (检测到整宽占用者 OR 容器本身溢出) → 给 footerActions 换行，
          // 让本按钮以整宽行落到占用者下方（与「插件/设置」纵向堆叠），避免
          // fixed 浮层压会话列表末尾行。容器溢出比 occupant 检测更可靠——
          // display:contents marker 让 scrollWidth 恒 0，多个 width:100% 子项
          // 在 nowrap 下被 flex-shrink 等比压成一行（每个占 ~1/N）时
          // isFooterOccupant 全 miss，但 container.scrollWidth>clientWidth 是
          // 布局真值（装不下）。rail 容器 width:auto 不换行（破坏 56px 纵栏图标
          // 堆叠居中）；已 wrap / 既无占用者也未溢出不动容器（保持共享一行）。
          // 写入 inline 有 `!== "wrap"` 守卫不循环。
          const root = document.querySelector("[data-dsh-sidebar-root]");
          const wideNow = !root || root.getAttribute("data-dsh-sidebar-wide") !== "false";
          const cramped = isFooterContainerCramped(container);
          if (wideNow && container && (occupant || cramped) && container.style.flexWrap !== "wrap") {
            container.style.flexWrap = "wrap";
          }
          setLayout((prev) => {
            const next = footerLayout();
            return prev.wraps === next.wraps && prev.dir === next.dir ? prev : next;
          });
          setAnchor((prev) => {
            if (!prev && !occupant) return prev;
            if (prev && occupant && prev.top === occupant.top && prev.left === occupant.left
              && prev.width === occupant.width && prev.height === occupant.height) return prev;
            return occupant;
          });
        };
        check();
        const mo = new MutationObserver(check);
        mo.observe(document.documentElement, {
          childList: true, subtree: true, attributes: true,
          attributeFilter: ["data-cordis-badge", "data-testid", "style", "class"],
        });
        window.addEventListener("resize", check);
        return () => {
          mo.disconnect();
          window.removeEventListener("resize", check);
          if (wrapContainer) wrapContainer.style.flexWrap = wrapOriginal;
        };
      }, []);
      // rail 态恒不浮层（56px 纵栏同槽占用者与本按钮同列，浮层会正压其行）
      const floating = !rail && !layout.wraps && !!anchor;
      const rowFree = !layout.wraps && !!layout.dir && layout.dir.startsWith("row");
      // 视觉对齐侧边栏「设置」按钮（宽态 12px 圆角、38px，透明底，16px 图标 + 文字；
      // rail 态 36×36、圆角 50%、单图标 18px 居中）。
      const baseStyle = {
        boxSizing: "border-box",
        display: "flex", alignItems: "center",
        justifyContent: rail ? "center" : undefined,
        gap: rail ? "0" : "8px",
        background: "transparent", border: "none",
        color: "var(--dsw-alias-label-primary)",
        fontFamily: "inherit",
        borderRadius: rail ? "50%" : "12px",
        padding: rail ? "0" : "0 10px 0 8px",
        height: rail ? "36px" : "38px",
        fontSize: "14px", lineHeight: "22px",
        cursor: "pointer",
        overflow: "hidden",
      };
      const triggerStyle = floating
        ? {
          ...baseStyle, position: "fixed",
          left: Math.round(anchor.left) + "px",
          bottom: Math.round(window.innerHeight - anchor.top + 6) + "px",
          // 层级 1：与侧边栏普通内容同层，低于一切弹层/遮罩——任何弹出框打开都自然
          // 盖住本按钮，不能用高 z-index 浮在弹层上
          zIndex: 1,
          width: rail ? "36px" : Math.round(anchor.width) + "px",
          whiteSpace: "nowrap",
        }
        : {
          ...baseStyle,
          // - wrap 容器（占用者被换行 / tokenledger 注入）：width:100% 让各整宽条目
          //   各自成行、order 决定堆叠
          // - column 容器（如 usage-stats 纵排）：flex-basis 沿主轴=高度，grow:1 会把
          //   按钮整高拉伸压住同槽按钮 → 保持 0 0 auto + width:100%
          // - row 容器（默认 nowrap 无占用者）：flex:1 1 auto 与同槽入口共享一行（半宽）
          ...(rail || !rowFree
            ? { flex: "0 0 auto", width: rail ? "36px" : "100%" }
            : { flex: "1 1 auto", width: "auto", minWidth: 0 }),
          whiteSpace: "nowrap",
        };
      const hoverBg = "var(--dsw-alias-interactive-bg-hover)";
      // 复用模块级 AcpLogoIcon（也供 better-sidebar tab 用）
      const iconSize = rail ? 18 : 16;
      // 按钮常显：面板打开时全屏遮罩（z 9998）盖在内容层按钮之上，无需卸载
      return React.createElement(React.Fragment, null,
        React.createElement("button", {
          style: triggerStyle,
          title: t("trigger.title"),
          "aria-label": t("trigger.label"),
          onClick: () => {
            // better-sidebar 已安装 → 打开/聚焦「acp 会话管理」tab 并展开侧边栏面板；
            // 未安装 → 回退自绘 ShellPanel。seed 形态按服务版本给（见 acpTabSeed）。
            // 范式对齐 dsh-chat-import v0.11.3 lib/client.js:1900-1912。
            if (betterSidebarService) {
              try {
                betterSidebarService.openTab(acpTabSeed(betterSidebarService.version));
                return;
              } catch (err) {
                console.warn("[obsidian-dsh-acp] better-sidebar openTab 失败（回退自绘面板）：" + String((err && err.message) || err));
              }
            }
            setOpen(true);
          },
          onMouseEnter: (e) => { e.currentTarget.style.background = hoverBg; },
          onMouseLeave: (e) => { e.currentTarget.style.background = "transparent"; },
        },
          React.createElement(AcpLogoIcon, { size: iconSize, style: { flex: "none" } }),
          !rail && t("trigger.label")),
        open && React.createElement(ShellPanel, { onClose: () => setOpen(false) }));
    }

    // ── apply：locale 注册 + 槽挂载 ─────────────────────────────────────
    const name = "dsh-acp-panel";
    // locale 是晚挂载服务（dsh-client-locale 自身依赖 connection/remote），
    // 声明进 inject 让 apply 期 ctx.get('locale') 就绪（面板 i18n + 字典注册）。
    // uiWorkspace 同理——会话点击跳转要靠它打开 SPA 内会话视图。
    const inject = ["slots", "locale", "uiWorkspace", "betterSidebar"];

    function apply(ctx) {
      // 注册面板字典：locale 服务存在时随 DSH web 语言切换；缺失时 useTranslate 降级内置 zh 字典。
      const locale = ctx.get("locale");
      if (locale && typeof locale.register === "function" && typeof locale.bind === "function") {
        localeSvc = locale;
        ctx.effect(() => locale.register(LOCALE_NS, { zh: DICT.zh, en: DICT.en }));
      }
      // 捕获 uiWorkspace（dsh-client-ui-workspace）。缺失时不抛——面板仍可开，
      // 但「点击行跳转到会话」按钮会降级为「仅复制 ID + 提示」。
      const ws = ctx.get("uiWorkspace");
      if (ws && typeof ws.openSession === "function") uiWorkspaceSvc = ws;
      // dsh-better-sidebar（可选 peer）：安装了就把「acp 会话管理」注册为它的侧
      // 边栏 tab，footer 按钮点击改为 openTab（展开面板 + 新开/聚焦 tab）；未安装
      // 则保持自绘 ShellPanel 回退。better-sidebar 是晚挂载服务（依赖 sessions/
      // connection/workspaces 等），ctx.inject 等服务就绪再注册（不阻塞本插件激
      // 活、不硬依赖）。范式对齐 dsh-chat-import v0.11.3 lib/client.js:1938-1958。
      if (typeof ctx.inject === "function") {
        ctx.inject(["betterSidebar"], (sctx) => {
          const service = sctx && sctx.betterSidebar;
          if (!service || typeof service.registerTab !== "function") return;
          betterSidebarService = service;
          try {
            // 注销器交给 fiber：插件被禁用/HMR 时 better-sidebar 自动移除该 tab。
            ctx.effect(() => service.registerTab({
              id: ACP_TAB_TYPE,
              // 标题随 DSH web 语言切换（better-sidebar 每次渲染调用 thunk）
              title: () => (localeSvc ? localeSvc.bind(LOCALE_NS)("trigger.label") : (DICT.zh["trigger.label"] || "acp 会话管理")),
              icon: (size) => React.createElement(AcpLogoIcon, { size }),
              single: true,
              order: 100,
              component: AcpTabComponent,
            }), "obsidian-dsh-acp: better-sidebar tab registration");
          } catch (err) {
            console.warn("[obsidian-dsh-acp] better-sidebar tab 注册失败（回退自绘面板）：" + String((err && err.message) || err));
            betterSidebarService = null;
          }
        });
      }
      // 侧边栏底部「会话管理」按钮：slots.inject 挂起等 sidebar.footer.action 槽被
      // ui-sidebar 声明就绪（裸 slots.register 要求槽在 apply 期已存在，advanced
      // shell 下声明时序不保证先于本插件）。这是 dsh-chat-import / dsh-community-
      // market 等生态插件的官方挂法。
      if (typeof ctx.slots?.inject === "function") {
        ctx.slots.inject("sidebar.footer.action", () => {
          if (typeof ctx.slots.register !== "function") return;
          // 闭包内的 ctx 可能在槽就绪时被 cordis 替换；用 ctx.slots 提供的最新引用。
          const currentCtx = ctx;
          currentCtx.slots.register(
            { name: "sidebar.footer.action", id: "dsh-acp-panel", order: 1 },
            TriggerButton,
          );
        });
      }
    }

    module.exports = { name, inject, apply };
    return module.exports;
  },
});