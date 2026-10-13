# Changelog

## 0.3.4

### Fixed
- **chunk-mapper（C1）**：块结束快照在增量 delta 已发送时跳过，消除整段重复。
- **long-runtime（C2）**：provider 缺失时给出可读报错，不再出现无意义的 `"default"`。
- **spawn（C3）**：裸模型 id 回退到默认 provider，不再因 `$.provider` 缺失被拒。
- **dropdown 看不到模型**：根因是 dsh 每次启动把 `~/.dsh/settings.yaml` 改名
  `.imported`（legacy 导入），而 dsh-acp 的 `loadProviderCatalog()` 仍读该路径 →
  读空 → 回退 4 个硬编码模型（缺 `DeepSeek-V4.1-Flash`）。改为**优先读
  `<profileDir>/cordis.patch.yml`**（与 dsh web UI 同源）+ 多级 fallback。
- **self-check 误报**：`doctor` 的 Obsidian 探测漏了 Shared-Plugins 目录与
  obsidian.json vault 注册表；cordis 列表段（`- id: <section>`）YAML 解析失败；
  `customAgents` 实际是 list 而非 object。
- **工具轮无可见文本（Layer A）**：模型只调工具、不产出收尾文字时，合成
  `[已调用工具：<names>，无文字输出]`（纯显示，不改协议/历史）。同时修复 spawn
  路径 `receivedChunks` 把工具帧误当文本、导致兜底不触发的 bug。

### Added
- **self-check kernel**：`lib/selfcheck/*` 16 个固定检查 + 可插拔扩展（cross-config
  4 项 + conversation-output 2 项，共 22 项）+ 修复管线（dry-run / FIXTURE_ESCAPE /
  写前备份 / 幂等去重）。
- **CLI `dsh-acp doctor --repair [--apply]`**：自检全量修复；默认**预览（零写盘）**，
  `--apply` 才落盘（每个文件先备份 `.bak.<ts>`）。legacy `doctor --fix <item>` 不变。
- **`DSH_ACP_CLOSING_REPLY_NUDGE`**（opt-in，默认 **off**）：工具轮后引导模型补收尾句；
  因每轮会改 prompt 前缀、破坏缓存，故默认关闭。文案可用
  `DSH_ACP_CLOSING_REPLY_NUDGE_TEXT` 覆盖。
- **`DSH_ACP_TOOL_ONLY_FALLBACK`**（默认 on）：关闭 Layer A 兜底显示。
- `docs/SELFCHECK.md`：self-check 架构参考。

### Docs
- README 三语（en / zh-CN / ru）重写：语言切换行 + badges + 标准 OSS 章节结构；
  新增「工具轮无文字兜底」章节。
- `docs/规范/发布SOP.md` / `docs/规范/分支与版本规范.md` 更新（本地）。

### Notes
- 两处 **upstream deviation**（源自 `github.com/SilenZerOrz/obsidian-dsh-acp@windows-support-032`）：
  `lib/selfcheck/cross-config-sync.mjs`（list-item 支持 + 模型去重）、
  `lib/settings-provider-catalog.mjs`（cordis.patch.yml 数据源 + fallback 链）。

## 0.3.3

### Fixed
- **proxy 多轮无记忆**：`setSessionMode`/history 链路逐层贯通——`getHistory()` 的 assistant 条目补齐宿主要求的
  `source` 字段（`forAdapter()` 会无条件访问 `source.replayState`），并把 per-session history 透传为
  POST `messages` → `sessionConfig.messages` → `long-runtime.prompt()`。
- **归档漏写（出错轮次）**：user/assistant 的 `recordMessage` 统一移入 `finally` 单一归档点，
  出错轮的 assistant 文本带 `[dsh-acp error]` 前缀（此前出错会绕过归档，导致 `messages` 只剩 user）。
- **首轮抢跑探针**：proxy 探测此前是 fire-and-forget，启动后第一条 prompt 可能早于探测完成而误走 spawn 路径；
  改为 per-prompt 惰性判定 + 超时（`DSH_ACP_PROBE_TIMEOUT_MS`，默认 3000ms），超时即回退 spawn。
- **prompt-spawn profile 错配**：不再盲目继承 `DSH_PROFILE`；改用 `DSH_ACP_SPAWN_PROFILE`（默认 `headless`），
  并在两者不一致时打 NOTE。此前 `DSH_PROFILE=web` 会让 `dsh --profile web "<prompt>"` 报
  `unknown option '--json'` / `too many arguments`，导致模型从未真正运行。
- **`hasHeadlessJson()` 探测**：不再硬编码 `--profile headless`，改为按实际 profile **真实试跑**该 flag；
  并新增 `--json` 被拒时去掉该 flag 重试一次的兜底。
- **错误可见性**：`finishReason.kind === "error"` 时填充 `result.error`/`errorCode`，并在 cancelled + text 时
  把真实原因转发给客户端（此前为静默 cancelled）。

### Added
- 一轮**有工具调用但无任何可见文本**时，合成一条最小提示
  `[已调用工具：<name>（无文字输出）]`（纯显示，不进入历史）。
- README（en / zh-CN / ru）新增「Obsidian agent-client 集成」节，说明 `customAgent.env`
  使用 `{ key, value }` 格式以及 `DSH_ACP_HTTP_GATEWAY_URL` / `DSH_ACP_PROXY_MODE` 两项配置。

### Notes
- `DSH_PROFILE` 仍用于其他组件（gateway / doctor / runtime-switch），仅 prompt-spawn 不再读取它。
