# Changelog

## 0.3.7 (2026-10-19)

### Fixed

- **入口守卫在 `/tmp` 符号链接下静默无输出**（macOS）
  - `doctor.mjs` 入口守卫用 `process.argv[1] === fileURLToPath(import.meta.url)` 比较，
    macOS `/tmp → /private/tmp` 符号链接下两者字符串不等 → doctor 静默 `exit 0`
  - 修复：`realpathSync` 归一化后比较（`doctor.mjs` 顶部补 `realpathSync` import）
  - 不影响真实安装（`~/.dsh/profiles/...` / `~/.npm-global/...` 不在 `/tmp` 下）；
    仅影响隔离测试（pre-existing since v0.3.4）

### Docs

- **补落 `docs/规范/敏感信息审查规范.md`**（0.3.5 时期报告"已建"但**实际从未存在**——
  工作树无 / git 历史零痕 / 全仓零引用）
  - L1/L2/L3 敏感等级定义 + fixture 硬约束 + 扫描范围 + 处置流程
  - 本地脱库（`docs/` 不进 git），仅作维护者参考
- **README×3 加 "Context window" 段**：说明 `DSH_ACP_CONTEXT_WINDOW` env
  （`usage_update.size=0` → 客户端 `Infinity%` 的解法；优先级
  `usage.contextWindow → usage.size → env`，见 `lib/chunk-mapper.mjs:296`）

### Tests

- `test/entry-guard.test.mjs`（新）：入口守卫经符号链接调用应正常输出
- `npm run test:unit`: 379 → **381/381/0**（+2）

## 0.3.6 (2026-10-19) — HOTFIX

### Fixed

- **默认 proxy/long 路径静默失败**（影响 0.3.4 / 0.3.5 所有用户）
  - 根因：`9462c8e` 引入 H1 预初始化 stub（`acpClient: { notify: async () => {} }`），
    `LongRuntime._notifyUpdate` 读 `this.acpClient`（stub），而 `request()` 走
    `this._liveAcpClient` —— 两个出口口径不一致 → 所有 `session/update` 帧被丢进 stub，
    客户端只收到 `result`，UI 表现为「发出去没反应、无报错」
  - 修复：`_notifyUpdate` 改为 `this._liveAcpClient ?? this.acpClient`（对齐 request 语义）；
    `ensureLongRuntime` 补装（stub 形状检测 → 换 bridge notifier）
  - 回归测试：`test/notify-live-client.test.mjs`（4 用例，覆盖 H1 预初始化顺序）
  - 证据：同 prompt before/after，3081 冷启 sessionUpdate 计数 0 → 521~910

- **usage 帧 `size: 0` 导致客户端 `Infinity %`**（cosmetic，不阻塞功能）
  - 新增 `resolveContextWindow()`：上游 contextWindow → `DSH_ACP_CONTEXT_WINDOW` → 0
  - 默认仍显示 `used/0 + Infinity%`；要真实百分比需设 `DSH_ACP_CONTEXT_WINDOW`
    或等 0.4 引入 model→context window 表（known-gaps P2-3）

### Known gaps（0.4 范围）

- **P1 工具调用在 legacy long 路径不可用**：`lib/long-runtime.mjs:387` 注释明确该路径
  无工具执行器（A3 决策 2026-10-13）。当前 web profile 默认走 legacy，P1 从架构上无法
  达成。修复路径：0.4 给 long 路径接执行器 或 打通官方桥所需服务。
- ⚠️ **不要用 `DSH_ACP_LONG_TOOLS=1` 去补 P1**：无执行器时暴露工具 schema 会让模型
  请求工具、以零可见文字收尾 —— 会把 P0 的修复打回「无文字」。
- `lib/headless-json-parser.mjs:96` 也有 `size: 0`，同类 cosmetic（未在 0.3.6 改）

### Deprecations

- `0.3.4` / `0.3.5` 的默认 proxy/long 路径静默失败，npm 已标记 deprecated，请升级 0.3.6

### Tests

- `npm run test:unit`: 372 → **379/379/0**（+7 新用例）

### Verification

- P0 真机 6/6 全中（macOS + dsh 0.2.0-rc.2）
- P1 0/5（架构缺口，非本版回归，见 Known gaps）
- 验收记录：`docs/规范/真机验收记录/verify-0.3.6-20261019.md`

## 0.3.5

### Added

- **doctor 层 6：headless 凭据检查**（`diagnoseHeadlessProfile`）
  - 检测条件：`dsh CLI >= 0.2.1-rc.2` + `profile=headless` + `cordis.patch.yml` 含 `apiKeyEnv`
  - 检查 `process.env` + `$DSH_HOME/.env` 是否含对应 key
  - 缺失 → 报 `headless-credential-env / high` + `.env` 写入命令 + Windows `icacls`
  - 保守策略：版本不可判定或 `< 0.2.1-rc.2` → 跳过不报
  - 测试钩子 `__setTestVersion`（test-only）

### Changed

- **`parseCredentialIssue` 双提示**：headless 与 web/desktop 场景并列，不再依赖 `DSH_PROFILE` env var

### Tests

- `test/doctor-headless-profile.test.mjs`: +4 层 6 用例 +1 `parseCredentialIssue` 双提示用例
- `npm run test:unit`: 367 → **372/372/0**

### Docs

- `docs/规范/发布SOP.md` §A15：test 文件敏感串双层扫描（L1 工作区 + L2 已提交 diff + 工作树补扫）

## Known limitation (0.3.4, 2026-10-18)

**Headless credential store not read since dsh CLI 0.2.1-rc.2**

- `dsh-headless@0.2.1-rc.2` disables the managed credential store by design;
  `.credentials.yaml` is ignored for `headless` profile.
- Fallback chain: `process.env` → `<cwd>/.env` → `$DSH_HOME/.env`.
- dsh-acp does **not** forward credentials from `.credentials.yaml` to the
  spawned `dsh` process (by design; see section "Headless credential setup"
  in README).
- Fix: create `~/.dsh/.env` with `<apiKeyEnv>=<key>` matching your provider
  config in `~/.dsh/profiles/*/cordis.patch.yml`.

### dsh CLI compatibility matrix

| dsh CLI | headless 凭据来源 | 需配 `~/.dsh/.env`? |
|---|---|---|
| 0.2.0-rc.2 及更早 | `.credentials.yaml` | ❌ |
| 0.2.1-rc.2 及更新 | `.env` 回退 | ✅ |

## 0.3.4

### Breaking
- **proxy/long 路径默认不再向模型暴露工具 schema**（`DSH_ACP_LONG_TOOLS=1` 才开启，
  须设在 **dsh web 进程环境**）。原因：该路径只调用一次 `ctx.llm.stream()`、**没有工具
  执行器**；暴露 schema 会让模型请求根本不会执行的工具、以 `finishReason=tool-calls`
  结束且无正文。**需要工具执行请走 spawn 路径**（去掉 `DSH_ACP_HTTP_GATEWAY_URL`、
  设 `DSH_ACP_PROXY_MODE=false`，用扁平 id `jl-token/<model>`）。

### Fixed
- **sessionId 翻译（H-b）**：官方桥 `apply()` 在 `session/new` 自生成 UUID，与
  agent-client `session/new` 拿到的 client label 不一致 → 通知被客户端丢弃 → UI
  转圈无响应。修复：
  - router 层按 `applyToClient` 反查翻译（缺失时发可见 `[dsh-acp error]` 帧，不静默丢）；
  - gateway / adapter 出口各加 assert+rewrite+warn 兜底（per-turn 一次告警）。
- **model 兜底（H3c-1）**：`init` 路径（`index.mjs` 的 H1 inject + `startLong` 两处）
  补 `model: resolveHttpGatewayDefaultModel()`，修复 `defaultModel=null` 导致
  `LongRuntime.prompt: no model configured` 的问题；`long-runtime` 抛错前再兜一次
  硬编码默认模型作纵深防御。
- **单测门禁（C1 遗留）**：同步 4 处 C1 dedup 落地后陈旧的计数断言
  （`long-runtime.test.mjs:161` + `llm-event-bridge.test.mjs` 3 处）。`npm run test:unit`
  现 **380/380/0**。
- **chunk-mapper（C1）**：块结束快照在增量 delta 已发送时跳过，消除整段重复。
- **long-runtime（C2）**：provider 缺失时给出可读报错，不再出现无意义的 `"default"`。
- **spawn（C3）**：裸模型 id 回退到默认 provider，不再因 `$.provider` 缺失被拒。
- **dropdown 看不到模型**：根因是 dsh 每次启动把 `~/.dsh/settings.yaml` 改名
  `.imported`（legacy 导入），而 dsh-acp 的 `loadProviderCatalog()` 仍读该路径 →
  读空 → 回退 4 个硬编码模型（缺 `DeepSeek-V4.1-Flash`）。改为**优先读
  `<profileDir>/cordis.patch.yml`**（与 dsh web UI 同源）+ 多级 fallback。
- **self-check 误报（A1/A2）**：Obsidian 探测漏了 Shared-Plugins 目录与 obsidian.json
  vault 注册表；cordis 列表段（`- id: <section>`）YAML 解析失败；`customAgents` 实际是
  list 而非 object；3 个 cross-config check 基准由 `settings.yaml` 改为 `cordis.patch.yml`；
  `PROVIDER_NAME_HYPHEN` 注释排除覆盖 `//`。
- **工具轮无可见文本（Layer A）**：模型只调工具、不产出收尾文字时，合成**如实**提示
  `[模型请求调用工具：<names>；当前运行模式不执行工具，本轮无结果与文字]`（纯显示，
  不改协议/历史；**不再声称"已调用"**）。同时修复 spawn 路径 `receivedChunks`
  把工具帧误当文本、导致兜底不触发的 bug。

### Added
- **self-check kernel**：`lib/selfcheck/*` 16 个固定检查 + 可插拔扩展（cross-config
  4 项 + conversation-output 2 项，共 22 项）+ 修复管线（dry-run / FIXTURE_ESCAPE /
  写前备份 / 幂等去重）。
- **CLI `dsh-acp doctor --repair [--apply]`**：自检全量修复；默认**预览（零写盘）**，
  `--apply` 才落盘（每个文件先备份 `.bak.<ts>`）。legacy `doctor --fix <item>` 不变。
- **`DSH_ACP_LONG_TOOLS`**（opt-in，默认 **off**）：proxy 路径恢复暴露工具 schema（当前
  仍无执行器，仅调试用）。
- **`DSH_ACP_CLOSING_REPLY_NUDGE`**（opt-in，默认 **off**）：工具轮后引导模型补收尾句；
  因每轮会改 prompt 前缀、破坏缓存，故默认关闭。文案可用
  `DSH_ACP_CLOSING_REPLY_NUDGE_TEXT` 覆盖。
- **`DSH_ACP_TOOL_ONLY_FALLBACK`**（默认 on）：关闭 Layer A 兜底显示。
- **纯函数 `lib/acp-session-id-translate.mjs`** + 单测 `test/session-id-translate.test.mjs`
  （4 用例，已登记进 `test:unit`）。
- `docs/SELFCHECK.md` / `docs/releasing.md` / `docs/known-gaps.md`。

### Changed

- **测试资产分层**：`npm run test:unit` 不再包含依赖 `test/fixtures/` 的测试
  （`test/cwd-validator.test.mjs` 移至新建的 `npm run test:local`；
  `test/headless-json-parser.test.mjs` 的 fixture 已内联为常量）。
  依据 `docs/规范/测试资产规范.md`（本次转 living）。

### Docs
- README 三语（en / zh-CN / ru）：语言切换行 + badges + 标准 OSS 章节结构；「工具轮
  无文字兜底」章节更新为如实文案 + `DSH_ACP_LONG_TOOLS` 门控说明。
- `docs/规范/发布SOP.md` / `docs/规范/分支与版本规范.md` 更新（本地）。

### Known gaps
- proxy 与 spawn 下 memory 工具均不执行；跨 session 记忆不可用（实测 0/3 答对）。
  详见 `docs/known-gaps.md`。
- **官方桥为实验性**，0.3.4 默认 legacy（`DSH_ACP_USE_OFFICIAL_BRIDGE` 默认 `0`）。
  启用需三件套 env 同设：`DSH_ACP_USE_OFFICIAL_BRIDGE=1` +
  `DSH_ACP_OFFICIAL_PROVIDER=<provider>` + `DSH_ACP_OFFICIAL_MODEL=<model>`。
- **权限路径挂起**（官方桥 + router 组合下 `session/request_permission` 未处理）：
  0.3.4 的 web profile composition **不暴露 bash/write 工具**，用户实际碰不到；
  计划 **0.3.5 修**。

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
