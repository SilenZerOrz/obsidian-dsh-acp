# Changelog

## 0.4.2 (2026-11-17)

本批为 **0.4.2 收口轮**：会话仓库单一来源（W1）+ 跨界面会话实时同步（W2）+ G1 冷启收口，
并修掉 W1 外溢的测试侧过期断言。

### Added

- **W1 — 会话仓库单一来源（看板卡 `-64`）**：`archive-store.mjs` 写侧默认落 **dsh 原生根**
  `<DSH_HOME>/sessions/<project-key>/<seg>/session.v4.jsonl.zstd`（新增 zstd 写入器）；
  `DSH_ACP_ARCHIVE_IN_MAIN=0` 退回私根（保留上游开关）。读侧收敛为「`sessions/` 一次扫描为
  权威 + 索引仅作缓存 / tombstone」，去掉双 root 拼接。新增
  `scripts/migrate-archive-to-dsh-native.mjs`（`--dry-run` 默认、`--apply` 才写盘、**只 copy
  不 move**）。
- **W2 — 跨界面会话同步（看板卡 `-66`）**：`web/session-panel.mjs` 新增
  `GET /api-session/events`（SSE），订阅 `ctx.on('session/event')` 并发 `ready` / `session` /
  `fallback` 三帧（含心跳、有界队列、drain 背压等待）；`lib/client.js` 新增
  `useSessionEvents()`——`EventSource` 订阅 + 250ms 去抖刷新，收到 `fallback` 即 `close()`
  并切 5s 轮询，卸载清定时器与连接；接入 4 个会话列表组件。

### Fixed

- **归档断言写死旧布局（W1 外溢回归）**：`acp-feature-test.mjs` 的归档断言硬编码旧三层路径
  与旧文件名 `session.jsonl`，W1 改布局后误报「未归档」⇒ 改为递归搜索 `session*jsonl*`
  并对 `.zstd` 先解压再验内容（布局无关）。同处 delete 断言原用旧路径反推归档目录，
  新布局下必然推不中、`gone=true` 属**恒真假绿** ⇒ 改为取第 6 步实测命中的目录。

### Notes

- 协议/API **无不兼容变更**（无 `### Breaking`）。
- **版本级别：维护者裁定取 patch（`0.4.2`）**。W1/W2 含新端点（`/api-session/events`）与新
  脚本，按 `分支与版本规范` §2.1「新功能 → minor」本可归 minor；用户 2026-11-17 明确
  「非功能性大版本更新，倾向 `0.4.x` 的 tag」⇒ 定为 patch，差异如实登记。
- 新增入库测试：`test/r134-archive-sync.test.mjs`（zstd round-trip / 读侧单源 / 移动后路径
  解析）、`test/acp-session-events.test.mjs`（宽容解析 / 订阅不可用响亮降级 / 订阅幂等）；
  `.gitignore` 白名单同步放行。
- 发布门禁读数（2026-11-17）：`test:unit` **519 pass / 0 fail**；`test:officials`
  **27 pass / 0 fail**（9 skip = optional peer `@deepseek-ai/dsh-acp` 未安装）；
  `test:protocol` / `test:long` **ALL FEATURE CHECKS PASSED**；`doctor` ✅；
  `node --check` ×8 改动文件 OK。
- G1c 冷启复验：`launchctl kickstart -k gui/501/com.deepseek.harness.web` 后 probe
  `mode=long` / `longReady=true` / `official{importable:true,servicesReady:true}`；经
  `/acp/proxy/session/prompt` 发真实工具指令，回灌
  `tool_call → tool_call_update(completed) → agent_message_chunk`（帧计数已取）。
- `docs/` 仍只落本地、不上传 GitHub（用户 2026-11-03 裁定）。

## 0.4.1 (2026-11-17)

本批聚合 `v0.4.0..HEAD` 的 13 笔工作提交（`0.4.0` 发布物停在 `99f7e30`，不含 G2 根因修复与
后续 ACP 能力对齐）——**自 0.4.1 起，npm 上的版本才等于本机真机通过的代码**。

### Added

- **R147/R148 — 官方桥审批通路（T5）**：router 以 `{ global: true, prepend: true }`
  注册 `approval/request`，并把服务端发起的 `session/request_permission` 转发给客户端后
  回写应答（R147：此前被更早注册的 waterfall 吞掉，工具卡永久停在 `in_progress`）；
  转发前把审批请求的 `sessionId` 改写为客户端 id，避免客户端因 id 不匹配**整帧丢弃**
  （R148）。真机 Obsidian UI 验收：弹出 / allow 落盘 / reject 不落盘 fail-closed 三行全中。
- **R145 — `initialize` 能力声明**：补 `promptCapabilities`（image/audio/embeddedContext=false）
  与 `mcpCapabilities`（http/sse=false）；`agentInfo.version` 改为读
  `lib/package-version.mjs` 单一真源（此前硬编码 `"0.2.0"`，与 package.json 漂移）。
- **R146 — `session_info_update` 发帧**：`session/new` / `load` / `resume` / `fork` 及
  每轮对话结束后发 `session/update { sessionUpdate: "session_info_update" }`，面板标题与
  最后活动时间随之刷新（此前从不发送，标题停在 `session/new` 时的占位值）。
- **P1-2 — 工具卡 Reporter 层**：`lib/tool-call-reporters/`（read / edit / shell / search /
  web / generic …）产出 tool-specific 的 rich `title` / `content` / `locations`；
  未知 MCP 工具帧与改动前**逐字节相同**（零回归）。
- **P1-3 — `available_commands_update` 发帧**：`session/new` 之后广播可用命令，
  客户端命令面板不再为空。
- **P2-1 — spawn 路径 reasoning**：spawn 路径产出 `agent_thought_chunk`，思考过程在面板可见。
- **U3 — 官方桥策略**：启用改为 env 可覆盖，默认「探针 auto」；探针新增 `hostServices`
  只读诊断（approval / tools / systemPrompt）。

### Fixed

- **G2 根因**：官方桥改为经 `ctx.inject` 挂载，并拆分 provider / model。
- **P0 取证可见性**：官方桥上游错误整帧 surface 到 SSE 与宿主 stderr（此前静默）。
- **P2-2**：官方桥 `0.2.2-rc.3` 可用性重探 + 探针不变量守卫。
- **P2-3**：`usage_update.size` 自动解析。

### Notes

- 协议/API **无不兼容变更**（无 `### Breaking`）。
- **版本级别：维护者 2026-11-17 裁定取 patch（`0.4.1`）**。内容含新功能（能力声明 /
  命令广播 / 会话信息帧 / Reporter 层 / spawn 路径 reasoning），按 `分支与版本规范`
  §2.1「新功能 → minor」本可归 minor；0.x 期由维护者拍板定为 patch，该差异如实登记
  （依据 §2.2「由用户拍板后再 tag」）。
- `docs/` 仍只落本地、不上传 GitHub（用户 2026-11-03 裁定）。
- 新增入库测试：`tool-call-reporters` / `acp-available-commands` / `r145-initialize-capabilities` /
  `r147-approval-bridge` / `r148-request-sessionid-rewrite` / `official-bridge-policy` /
  `official-bridge-probe-matrix` / `acp-session-info-update`（`.gitignore` 白名单同步）。
- 发布门禁读数（2026-11-17）：`test:unit` **498 pass / 0 fail**；`test:officials`
  **27 pass / 0 fail**（9 skip = optional peer `@deepseek-ai/dsh-acp` 未安装）；
  `test:protocol` / `test:long` **ALL FEATURE CHECKS PASSED**；`doctor` ✅。

## 0.4.0 (2026-11-01)

### Fixed

- **TD-2 — mode 持久化读回**（T3）：`initializeModes()` → `initializeModes(rec)`，`currentModeId`
  由 `rec?.mode ?? "default"` 决定；`newSession` / `loadSession` / `resumeSession` /
  `forkSession` / `setSessionMode` **5 处调用点**全部传入会话记录。
  存储层早在 `archive-store.mjs:342` 就写了 `mode: src.mode`，缺的只是 ACP 层读回
  ⇒ `setSessionMode(acceptEdits)` 后重新 `session/load` 现在返回 `currentModeId='acceptEdits'`，
  `session/fork` 也继承父会话的 mode。
- **TD-1 — 错误码规范化**（T4）：6 处 `new RequestError("<字符串>")` 改为**整数码**——
  `-32602`（Invalid params，5 处：`session not found` ×3 / `invalid modeId` / `source session not found`）
  与 `-32603`（Internal error，1 处：cwd 校验失败）。
  原写法把字符串塞进 `code`，`.message` 为空，SDK 发现 `code` 非整数后**降级为
  `-32600 Invalid request`**，客户端可能显示空白错误。现在错误码正确。

### Notes

- `availableModes` **仍只广播 `[default]`**（SCOPE NOTE 保持不动，M2.4 UI 回归的既定约束）；
  本版本只修「读回 `currentModeId`」，不重新引入 4-mode 广播。

## 0.3.9 (2026-11-01)

### Changed

- **测试资产入库（13 个文件）** —— `test/*.test.mjs` 此前被 `.gitignore:42`（`test/*`）忽略，
  全新克隆跑不了 `test:officials` / `test:realllm`。本次把白名单外的 13 个用例入库，
  `.gitignore` 的 `!test/` 放行条数 **22 → 24**
  （`test/acp-official-router-permission.test.mjs` 属权限路径修复，随 0.4.1 入库 ——
  原记「随 0.5.0」，0.5.0 计划已取消，编号改判为 0.4.1）。
- **C1 断言滞后修复** —— `test/official-acp-bridge.test.mjs`：断言改为检查 `advisoryServices`，
  与实现一致 ⇒ `tests 9 / pass 9 / fail 0`。
- **C2 断言滞后修复** —— `test/http-gateway-tool-translation.test.mjs` 与
  `test/http-gateway-tool-translation-concurrent.test.mjs`：断言改为期望官方 `tool_call`
  起帧**透传**（此前期望被降级为 `tool_call_update{in_progress}`）。
- **`test:officials` 进程退出等待归零** —— 4 个 http-gateway 文件的「退出等待」由 ~29.5s
  降至 0.12–0.14s；耗时判据由绝对秒数改为「**无额外退出等待**」。

### Notes

- 本版本**不含运行时改动**：`lib/` 与 `dsh-acp.mjs` 与 0.3.8 一致；
  面向使用者的 npm 包内容与 0.3.8 等价（差异仅 `package.json` 版本号与 `CHANGELOG.md`）。

## 0.3.8 (2026-10-31)

### Added

- **ACP stdout 协议纯净性守卫**（`lib/acp-stdout-guard.mjs`，P0）
  - ACP 走 stdio 的 NDJSON 帧协议，**stdout 是协议信道**；adapter 内任何 `console.log`
    都会往 stdout 写非协议文本 → 客户端帧解析失败
  - `installAcpStdoutGuard({ logFile })`：把 `console.log/info/debug` 重定向到 stderr；
    幂等（`Symbol.for("obsidian-dsh-acp.stdout-guard")` 打标）；已有 `logFile` 重定向时跳过
  - `dsh-acp.mjs` 两处 `.catch((e) => console.log(...))` → `diagNotifyError(e, ...)`；
    默认 CLI 分支在 `runAcpDualMode()` **之前**安装守卫
- **防退化断言** `test/acp-stdout-purity.test.mjs`（7/7）
  - 5 项行为测试 + **2 项源码门**（静态断言 `installAcpStdoutGuard(` 在 `runAcpDualMode().catch(` 之前；
    文件内 `console.log(` 调用点数符合约束）
- **doctor 第 6 层：headless 凭据诊断**
  - 正则提取 headless profile `cordis.patch.yml` 的 `apiKeyEnv:` 名单，若某名字既不在
    `process.env` 也不在 `$DSH_HOME/.env` → 报 `headless-credential-env`（severity **high**）
  - 提示里**只列键名**，不含值；dsh 版本不可判定或 `< 0.2.1-rc.2` 时保守不报

### Changed

- **peer 依赖范围化简**（`@deepseek-ai/dsh-acp`）：`>=0.1.6-alpha.1 <0.3.0-0`
  - 移除 3 个冗余 `||` 备选项（`0.2.0-rc.1` / `0.2.0-rc.2` / `0.2.1-alpha.1`）
  - 依据 semver 2.0.0 §11：预发布版本低于其对应正式版，三者均落在 `<0.3.0-0` 内，**语义等价**
- **凭据载体修正**：`cordis.patch.yml` 两处 `apiKeyEnv` 拼写 `DEEPSEKLOCAL_API_KEY` → `DEEPSEEKLOCAL_API_KEY`
  （web line 65 / headless line 19）
- **测试基础设施**：`peerDependenciesMeta` 4 处 `"optional": "true"`（字符串）→ `true`（布尔）
- **`test:officials` 加 `--test-force-exit`**（消除 stdio 句柄导致的进程退出延迟）

### Fixed

- **`test:officials` 挂起**（`acp-official-router-session-c`）
  - 根因：测试 fixture 违反 dsh-tools 契约，非实现缺陷
    - `STUB_NOOP_TOOL.output.render` 返回裸字符串，契约要求 `ContentBlock[]`
      → `dsh-tools:1454` `content.some(...)` 抛错 → 每次 tool_call `status:"failed"` → agent loop 无限重试
    - `hasToolResult` 只认 `{type:"tool-result"}`，实际 dsh 回灌的是 `{role:"tool"}`
      → 判据永不命中 → `isToolTurn` 恒真
  - 修复后：整包 **>600s 挂死 → 17s**，`cancelled: 3 → 0`

### Known issues (not fixed in 0.3.8)

- **C1**：`official-acp-bridge` 测试断言 `missingServices.includes("subagents")`，
  实现已把 `subagents` 移入 `advisoryServices` → **测试滞后实现**（改断言即可，非实现缺陷）
- **C2**：`http-gateway-tool-translation(-concurrent)` 测试断言「必须翻译成 `tool_call_update`」，
  实现自 P0-1 起 **PASS THROUGH `tool_call`** → 同上

> 按 D10-a 口径，门槛 3 = `cancelled = 0`（已达成）；C1/C2 的 3 个 fail 不计入 0.3.8 门槛，
> 登记为 0.3.9 / 0.4 独立项。详见 `docs/计划文档.md` §8.4 / §8.5。

### Tests

- `test:unit` **388/388/0**
- `test:protocol` / `test:long` **各 37/0**
- `test:officials` **27 tests / 15 pass / 3 fail(C1/C2) / 0 cancelled / 9 skipped**

---

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
