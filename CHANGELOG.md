# Changelog

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
