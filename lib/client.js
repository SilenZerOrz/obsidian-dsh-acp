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
        "tab.sessions": "会话",
        "tab.import": "Obsidian 会话",
        "source.native": "原生",
        "source.obsidian": "Obsidian",
        "row.turns": "轮数",
        "merged.desc": "DSH 原生会话与 Obsidian（dsh-acp）会话合并列表",
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
        "close": "Close",
        "filter.active": "Active",
        "filter.archived": "Archived",
        "filter.all": "All",
        "filter": "Filter",
        "refresh": "Refresh",
        "export": "Export",
        "archive": "Archive",
        "unarchive": "Unarchive",
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
        "tab.sessions": "Sessions",
        "tab.import": "Obsidian Sessions",
        "source.native": "Native",
        "source.obsidian": "Obsidian",
        "row.turns": "Turns",
        "merged.desc": "Merged DSH native sessions and Obsidian (dsh-acp) sessions",
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
      header: { display: "flex", justifyContent: "space-between", alignItems: "center", padding: "14px 16px", borderBottom: "1px solid " + C.border },
      title: { fontSize: "14px", fontWeight: 600 },
      close: { background: "transparent", border: "none", color: C.dim, fontSize: "16px", cursor: "pointer", padding: "2px 6px", borderRadius: "8px" },
      toolbar: { display: "flex", gap: "6px", alignItems: "center", padding: "8px 12px", borderBottom: "1px solid " + C.border },
      select: { background: C.field, border: "1px solid " + C.border, color: C.text, borderRadius: "8px", padding: "5px 8px", fontSize: "13px", outline: "none" },
      toolBtn: { background: "transparent", border: "1px solid " + C.border, color: C.text, borderRadius: "8px", padding: "4px 10px", fontSize: "13px", cursor: "pointer" },
      list: { flex: "1", minHeight: "0", overflowY: "auto", padding: "8px" },
      item: { padding: "10px 12px", border: "1px solid " + C.border, borderRadius: "10px", marginBottom: "8px", background: C.field },
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

      return React.createElement("div", { style: styles.item },
        React.createElement("div", { style: styles.itemHeader },
          React.createElement("div", { style: styles.itemTitle, title: rec.sessionId }, rec.title || rec.sessionId),
          rec.archived && React.createElement("span", { style: { ...styles.badge, ...styles.badgeArchived } }, t("badge.archived"))),
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
        React.createElement("div", { style: styles.actions },
          React.createElement("button", { style: styles.actionBtn, disabled: busy, onClick: () => setExportOpen(true) }, t("export")),
          React.createElement("button", { style: styles.actionBtn, disabled: busy, onClick: runArchive },
            rec.archived ? t("unarchive") : t("archive")),
          React.createElement("button", { style: styles.actionBtn, disabled: busy, onClick: () => setMoveOpen(true) }, t("move"))),
        exportOpen && React.createElement(ExportModal, { rec, t, colors, styles, onClose: () => setExportOpen(false) }),
        moveOpen && React.createElement(MoveModal, { t, colors, styles, value: moveCwd, onChange: setMoveCwd, onCancel: () => { setMoveOpen(false); setMoveCwd(""); }, onConfirm: runMove, busy }));
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

    // ── 主面板：列表 + 过滤 + 刷新 ─────────────────────────────────────
    function PanelContent({ t, colors, styles, onClose }) {
      const [view, setView] = useState("sessions");

      return React.createElement(React.Fragment, null,
        React.createElement("div", { style: styles.header },
          React.createElement("div", { style: { display: "flex", gap: "10px", alignItems: "center" } },
            React.createElement("button", {
              style: { ...styles.close, ...(view === "sessions" ? { color: colors.accent, fontWeight: 600 } : {}) },
              onClick: () => setView("sessions"),
            }, t("tab.sessions")),
            React.createElement("button", {
              style: { ...styles.close, ...(view === "import" ? { color: colors.accent, fontWeight: 600 } : {}) },
              onClick: () => setView("import"),
            }, t("tab.import"))),
          React.createElement("button", { style: styles.close, onClick: onClose, title: t("close") }, "✕")),
        view === "import"
          ? React.createElement(ObsidianImport, { t, colors, styles })
          : React.createElement(SessionMergeList, { t, colors, styles, onClose }));
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

    // ── 侧边栏触发按钮（对齐 dsh-chat-import 同款窄宽降级样式） ──────────
    function TriggerButton({ wide }) {
      const t = useTranslate();
      const [open, setOpen] = useState(false);
      const colors = themeColors();
      const rail = wide === false;
      // 与 dsh-chat-import 同样走 footer.action 槽容器的设计令牌与字号
      const baseStyle = {
        boxSizing: "border-box",
        display: "flex", alignItems: "center", justifyContent: rail ? "center" : "flex-start",
        gap: rail ? "0" : "8px",
        background: "transparent", border: "none",
        color: "var(--dsw-alias-label-primary)",
        fontFamily: "inherit",
        borderRadius: rail ? "50%" : "10px",
        padding: rail ? "0" : "0 10px",
        height: rail ? "36px" : "38px",
        fontSize: "14px", lineHeight: "22px",
        cursor: "pointer",
        overflow: "hidden",
        flex: "0 0 auto",
        width: rail ? "36px" : "100%",
        minWidth: 0,
        whiteSpace: "nowrap",
      };
      const hoverBg = "var(--dsw-alias-interactive-bg-hover)";
      // SVG 图标：聊天气泡 + 三个点（保持 plugin 简洁风格；不沿用 dsh-chat-import 专属 logo）
      const Icon = React.createElement("svg", {
        width: rail ? 18 : 16, height: rail ? 18 : 16, viewBox: "0 0 24 24", fill: "none",
        xmlns: "http://www.w3.org/2000/svg", style: { flex: "none" }, "aria-hidden": true,
      },
        React.createElement("path", {
          d: "M4 5h16a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H8l-4 3V6a1 1 0 0 1 1-1z",
          stroke: "currentColor", strokeWidth: "1.6", strokeLinejoin: "round",
        }),
        React.createElement("circle", { cx: "9", cy: "11", r: "0.9", fill: "currentColor" }),
        React.createElement("circle", { cx: "12", cy: "11", r: "0.9", fill: "currentColor" }),
        React.createElement("circle", { cx: "15", cy: "11", r: "0.9", fill: "currentColor" }));
      return React.createElement(React.Fragment, null,
        React.createElement("button", {
          style: baseStyle,
          title: t("trigger.title"),
          "aria-label": t("trigger.label"),
          onClick: () => setOpen(true),
          onMouseEnter: (e) => { e.currentTarget.style.background = hoverBg; },
          onMouseLeave: (e) => { e.currentTarget.style.background = "transparent"; },
        },
          Icon,
          !rail && t("trigger.label")),
        open && React.createElement(ShellPanel, { onClose: () => setOpen(false) }));
    }

    // ── apply：locale 注册 + 槽挂载 ─────────────────────────────────────
    const name = "dsh-acp-panel";
    // locale 是晚挂载服务（dsh-client-locale 自身依赖 connection/remote），
    // 声明进 inject 让 apply 期 ctx.get('locale') 就绪（面板 i18n + 字典注册）。
    // uiWorkspace 同理——会话点击跳转要靠它打开 SPA 内会话视图。
    const inject = ["slots", "locale", "uiWorkspace"];

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