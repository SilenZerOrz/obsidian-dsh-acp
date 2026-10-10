# obsidian-dsh-acp

`obsidian-dsh-acp` 是一个将 **DeepSeek Harness（DSH）** 接入 **Obsidian** 的
**ACP（Agent Client Protocol）** 插件/适配器：把它配置为 Obsidian **Agent
Client** 插件中的一个 *Custom Agent*（或作为 cordis 插件装进 DSH profile），
就能在 Obsidian 界面里直接通过 ACP 驱动 DSH，用 DeepSeek Harness 完成对话与
任务，而不需要切出 Obsidian。

这是一个 **ACP 服务器**（通过 stdin/stdout 讲 ACP v1 协议），作用是桥接：

```text
Obsidian (Agent Client 插件)
      │  ① 作为 Custom Agent 通过 ACP 拉起
      ▼
obsidian-dsh-acp (ACP server)
      │  ② 每次 prompt 拉一个
      ▼
dsh --profile headless "<prompt>"   (DeepSeek Harness 一次性任务)
```

它镜像了 `claude-agent-acp` 包装 Claude Code 的方式。每轮 prompt 会：拉一次
`dsh --profile headless "<prompt>"`（一次性任务），把 DSH 输出流式回传为
`agent_message_chunk` 更新，结束时返回 `end_turn` 结果。

支持会话管理：持久化的会话列表（Obsidian "Session history" 可 reload）、
`session/fork` 会话分支、以及把每轮对话写回 DSH 归档。

本仓库包含两个互补的部分：

1. **`dsh-acp.mjs`** —— 独立的 ACP 服务器二进制（`bin: dsh-acp`）。
   GUI ACP 客户端（Obsidian Agent Client）会直接将其作为子进程启动。
2. **`index.mjs`** —— 一个 [cordis][cordis] 插件，注册 `dsh.acp` 服务，并在 *harness
   内部* 管理适配器进程，可通过
   `dsh plugin --profile <name> add obsidian-dsh-acp` 使用。

## 工作原理

```text
Obsidian Agent Client ──(基于 stdin/stdout 的 ACP JSON-RPC)──▶ dsh-acp ──spawn──▶ dsh --profile headless "<prompt>"
                                   ▲  session/update 分块                        │
                                   └──────────────── stdout 流式返回 ─────────────┘
```

- 通过进程的 stdin/stdout 使用 ACP v1（换行分隔的 JSON-RPC）。
- 将 DSH 输出以 `agent_message_chunk` 更新流式返回，然后返回一个 `result`
  （`stopReason: "end_turn"`）。
- 会话无状态（每一回合相互独立）；`cwd` 会被保持。

## 双 runtime 架构（P2 长驻改造骨架）

为了在 Obsidian 端实现**工具审批弹窗**和**思考/执行过程实时显示**，adapter
需要从「每轮 spawn headless 子进程」切换到「**双 runtime 分发**」：

```text
┌─────────────────────────────────────────────────────────────────┐
│  入口 A：dsh-acp.mjs 独立二进制（Obsidian Agent Client 拉起）       │
│  · 无 cordis ctx，runtime.mode 永远 = "spawn"（向后兼容）          │
│  · 走现有 spawn 路径：spawn dsh --profile headless                 │
└─────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────┐
│  入口 B：index.mjs cordis 插件（dsh web 加载）                     │
│  · 与 dsh 同进程，runtime.mode 默认 = "long"                       │
│  · long 模式：in-process import lib/long-runtime.mjs              │
│  · 订阅 ctx.llm.stream() chunks → ACP sessionUpdate               │
│  · headless profile 自动降级 spawn（保护现有 headless 用户）       │
└─────────────────────────────────────────────────────────────────┘
```

**当前状态（0.3.3）**：long 模式已由 cordis 插件在 in-process 启动并端到端实现：
LLM 流（`ctx.llm.stream()` → ACP `sessionUpdate`）、4-mode 审批
（`DSH_ACP_PERMISSION_MODE`）、双层模型切换以及 temperature / reasoningEffort 均
接入并可用。spawn 路径 100% 不变。

**模式解析优先级**（`lib/runtime-switch.mjs::resolveRuntimeMode()`）：

1. `DSH_PROFILE=headless` → 强制 spawn（headless 用户不变）
2. `DSH_ACP_RUNTIME_MODE=long|spawn` 显式覆盖
3. `DSH_IN_CORDIS=1` → long（cordis 插件 in-process 标记）
4. 默认 spawn（standalone binary 向后兼容）

配置示例：

```bash
# 强制 long 模式（cordis 插件内）
DSH_ACP_RUNTIME_MODE=long node dsh-acp.mjs

# long 初始化失败时回退 spawn（默认开启）
DSH_ACP_SPAWN_FALLBACK=true DSH_ACP_RUNTIME_MODE=long node dsh-acp.mjs

# 4 种 permission 模式（默认 "default"，最安全）
DSH_ACP_PERMISSION_MODE=acceptEdits    # 或 dontAsk / bypassPermissions
DSH_ACP_PERMISSION_TIMEOUT_MS=300000   # 5min 超时默认 reject
DSH_ACP_PERMISSION_EDIT_TOOLS="Edit,Write,MultiEdit,NotebookEdit"
```

## 会话功能

在"无状态单回合"模型之上，`dsh-acp` 增加了一个持久会话层
（`archive-store.mjs`），提供三件事：

1. **重新加载会话列表** —— `session/list` 从磁盘上的 JSON 索引（默认
   `~/.dsh-acp/dsh-acp-sessions.json`）返回持久会话，因此 Obsidian 的
   "Session history" 重新加载时，即使适配器重启也能看到真实会话。初始化时
   适配器会声明 `sessionCapabilities.list`。
2. **会话分支（fork）** —— `session/fork` 把源会话的消息历史深拷贝到一个新的
   会话 id，记录父级链接，并声明 `sessionCapabilities.fork`，从而让客户端的
   "fork" 操作生效。
3. **备份每一回合** —— 每个完成的回合（用户 + 助手）都会追加写入到 DSH 格式的
   事件归档：
   `<DSH_HOME>/dsh-acp-archives/<encoded-cwd>/session-<id>/session.jsonl`。
   它存放在 `dsh-acp-archives/`（而不是 web 进程的 `sessions/`）下，以免普通
   `.jsonl` 与主进程 zstd 压缩的会话日志冲突。如需改为放进 `sessions/`，可设置
   `DSH_ACP_ARCHIVE_IN_MAIN=1`（仅当你以相同压缩模式运行归档时）。

4. **永久删除会话（v0.1.4）** —— `session/delete` 删除会话记录**并**同时清理磁盘归档目录（`<DSH_HOME>/dsh-acp-archives/` 与 `<DSH_HOME>/sessions/` 双 root，目录名按记录的 `session-<uuid>` 键），因此删除后不会在下次 list"复现"。适配器声明 `sessionCapabilities.delete`。

`session/resume` 和 `session/load` 可重新打开已保存的会话。

> **持久化与并发（v0.1.4）**：内存索引按短防抖（`DSH_ACP_PERSIST_DEBOUNCE_MS`）落盘并在退出前 flush，突发消息合并为少量磁盘写；多个适配器进程共享同一 store 时，写前先合并磁盘副本、且绝不复活已删除记录。完整 REQ 变更见 `docs/计划/开发现状.md`。

### 会话级模型切换 (v0.1.6)

每个会话都可以自带模型。适配器在 `session/new` / `session/load` / `session/resume`
上声明 `model` 这个 session config option（`SessionConfigSelect`），Obsidian 等
客户端就能给出模型下拉（机制同 claude）。`session/set_config_option` 把所选模型写
到该会话记录上；下一次 `prompt` 时，适配器会用
`dsh --profile headless --patch <disposable model overlay>` 启动，仅这一次调用
用所选模型——共享 profile 设置永远不会被改写。

可用模型默认来自 headless 目录（`DeepSeek-V4-Flash`、`Kimi-K2.6`、
`gemini-2.5-pro`、`Qwen3.8`），可通过 `DSH_ACP_MODELS`（逗号分隔 `id(display)`
对）和 `DSH_ACP_DEFAULT_MODEL` 覆盖。

### 会话摘要预览 (v0.1.6)

每轮交换结束后，`dsh-acp` 让模型用 **一行**（用对话所在语言）写出对话摘要，
并写回会话记录（`summary` / `summaryAt`）。`session/list` 在
`_meta.summary` / `_meta.summaryAt` 下把它返回给客户端，使「Session history」
面板能预览每条历史会话的主旨。摘要会在累积若干新消息后（带防抖）重新生成；
无需关闭摘要生成——它是 best-effort，绝不会阻塞响应。

### 导入外部 ACP 会话 (v0.1.6)

把另一个 ACP agent（如 claude / Obsidian Agent Client）导出的会话，导入到
dsh-acp 自己的 store：

```sh
node dsh-acp.mjs import <session.json> [--title '..'] [--cwd /path]
# 或在 Obsidian dsh-acp 会话内发送命令：
#   /import /path/to/claude-session.json
```

既接受 `claude-agent-acp` 格式
（`{ sessionId, messages:[{id,role,content,timestamp}] }`），也接受 dsh-acp 自身
的记录格式；只保留 `user` / `assistant` 轮，写进一个新的持久会话（含 DSH
归档）。导入后，客户端的会话列表里就会出现该会话。

### DSH web 会话面板与 Obsidian 原生导入（本地，P1b）

除仅服务 Obsidian 的适配器外，本包还附带一个 **dsh web 会话管理面板**
（cordis web 插件，默认 `enableWebPanel: true`）以及 **一键把会话写入
DSH 原生 store**（在 dsh 左侧对话列表可见、可恢复、共享工具/preset）的
Obsidian 导入功能。它沿用与 `dsh-chat-import` 相同的插件面。

- **面板**（`lib/client.js`、`web/session-panel.mjs`）：侧边栏
  `sidebar.footer.action` 按钮打开一个滑出面板，含三个 tab —— **Sessions**
  （自有 `~/.dsh-acp` store：list / export / archive / move）、**DSH Native**
  （通过 `sessionPersistence` 列出 dsh 的会话存储）以及 **Obsidian Import**（发现
  并一键导入 Obsidian Agent Client 的会话）。
- **DSH 原生集成**（`web/obsidian-import.mjs`）：在你的 vault 中发现
  Obsidian `agent-client/sessions/*.json`（可用 `DSH_ACP_OBSIDIAN_DIRS` 覆盖），
  并把每个文件导入 **dsh 原生会话存储** —— 通过 `sessionPersistence`
  （SessionHandle：`create(header)` → `append` → `flush` → `close`）写入，
  拼装出 DSH 的 `session` 事件（`assistant/message` 携带结算 `stream`），
  并挂到一个 workspace，使该会话出现在 dsh 的对话列表中且可被恢复。
- **兼容 dsh 0.1.5**：会话格式 V3（`SESSION_FORMAT_VERSION = 3`）、
  `sessionPersistence` 的 SessionHandle 模型、读 / 预览走
  `sp.open('read').read()`、以及归一化的快照 `sp.list()`。
- 在 `/api-session/*` 下注册的 HTTP 路由：`list`、`export`、`archive`、`move`、
  `dsh-list`、`dsh-read`、`obsidian-list`、`obsidian-import`。面板端点通过
  `ctx.get('sessionPersistence' | 'agents' | 'sessionProjectionCache' | ...)`
  读取 dsh host 服务；不可用 → 503；老 `~/.dsh-acp` 路由仍可用。

## 环境要求

- Node.js >= 22.13
- 可正常启动的 `dsh` 后端（参见 [Headless profile 引导](#headless-profile-引导)）

## dsh 版本支持

> **peer 区间必须带显式预发布分支。** `node-semver` 只有当范围里*某个*比较符与该版本的 `major.minor.patch` 元组完全一致、且自身也带预发布标签时，才会放行预发布版本。因此一个「看起来够宽」的范围（如 `>=0.1.6-alpha.1 <0.3.0-0`）会**静默排除所有 `0.2.x` 预发布宿主**——包括我们两个真实锚点。故本插件声明的区间把它们显式并列：
>
> `>=0.1.6-alpha.1 <0.3.0-0 || 0.2.0-rc.1 || 0.2.0-rc.2 || 0.2.1-alpha.1`
>
> （单一真值源：`package.json` → `peerDependencies["@deepseek-ai/dsh-acp"]`；经 `peerDependenciesMeta` 标为 `optional`。该规则上游 awesome-dsh-plugin `contributing.md` 亦有明载。）


| dsh 版本 | legacy spawn | P2 长驻 | official 桥 |
|---|---|---|---|
| `0.3.0` | ✅ | ✅ | ✅（env 开关，**官方桥 opt-in 需 dsh 上游**；Path A spawn 路径自含 tool 帧，详见下方 Known Limitations） |
| `0.1.6-alpha.x` / `0.1.7+` | ✅ | ✅ | ✅（env 开关） |
| `0.1.5-rc.3` | ✅ | ❌ | ✅（env 开关） |

**`0.1.5-rc.3` 是优雅降级。** P2 子包（`@deepseek-ai/dsh-{agent-loop,llm,acp}`）
由 `lib/version-detect.mjs::hasP2Apis()` 在运行时探测。在 `0.1.5-rc.x` 上探测结果为
`false`，会强制 `runtime.mode = spawn`——适配器继续工作，会话功能完整
（V3 会话、`session/list`、`session/fork`、`session/delete`、归档），只是没有 P2
长驻特性（工具审批弹窗、思考/工具实时流）。

这是**保守门禁，不是 bug**：rc 线实际含这些子包，但长驻模式尚未在 rc.3 上验证，
适配器宁可回退 spawn 路径，也不冒 import 时 `ERR_MODULE_NOT_FOUND` 的风险。

**Peer 区间（0.3.3 发行版）。** 插件把 `@deepseek-ai/dsh-acp` 的 peer 声明为显式
并列形式 `>=0.1.6-alpha.1 <0.3.0-0 || <预发布线 A> || <预发布线 B> || <预发布线 C>`
（权威字符串见 `package.json` 的 `peerDependencies` / `peerDependenciesMeta` —
末尾那几条 `||` 列出本次发版所实测过的 dsh 在途预发布线）。
依据 `awesome-dsh-plugin` contributing 指南里写的 node-semver 规则：
**没有显式列出每条预发布线的 peer 范围会静默排除所有预发布宿主版本** —— 因此上
面的 `||` 段是让插件能装上当前 dsh 预发布构建、而不是被静默拒绝的关键。

## 文件

| 路径 | 作用 |
|------|------|
| `dsh-acp.mjs` | 独立的 ACP 服务器二进制（`bin: dsh-acp`，双 runtime 分发入口） |
| `archive-store.mjs` | 持久会话存储 + DSH 归档写入器 |
| `index.mjs` | cordis 插件入口（`dsh.acp` 服务 + 适配器进程管理器；long 模式 in-process host） |
| `lib/runtime-switch.mjs` | 双 runtime mode 解析 + 4-mode permission config + tryLongFallbackSpawn |
| `lib/long-runtime.mjs` | long 模式 LongRuntime class（接入 ctx.llm.stream、4-mode 审批、温度 / 推理强度切换） |
| `lib/client.js` | dsh web React 面板（**默认不随 npm 包发布** npm `files`，仅 `test/p1b-dsh-web-ui` 分支打包） |
| `cordis.patch.yml` | 供 `dsh plugin ... add obsidian-dsh-acp` 使用的插件插入层 |
| `install.sh` | 一键安装脚本（DSH profile + Obsidian custom agent） |
| `install.ps1` | Windows 一键安装脚本（install.sh 的 PowerShell 版；分离 `-PluginProfile` / `-RuntimeProfile`，写入 `DSH_BIN=<dsh.cmd>`） |

### 0.3.0 — Tool call frames in spawn path

> **稳定版（2026-09-28，npm `latest`）**：当 LLM 触发工具调用时，工具调用帧自动
> 出现。需要在代理选择器里选一个 tool-capable 的模型；adapter 本身无需任何配置。

**What you get**

- Obsidian Agent Client 中工具调用卡片（`in_progress` → `completed` 状态）
- 工具调用状态跨轮保持
- 每步显示 token 用量
- 独立 `dsh-acp.mjs` 二进制即可工作 — 无需 dsh web / cordis ctx。

> 在 Obsidian 中用真 LLM + 真 ACP 客户端实测。

### Official bridge (opt-in, status: requires dsh upstream)

> **状态（2026-09-28）**：代码已发，但**当前 dsh web profile 下不可用**。设
> `DSH_ACP_USE_OFFICIAL_BRIDGE=1` 启用；如不可用，adapter 自动回退默认模式。

- **上游跟踪**：
  [Discussion #7748](https://github.com/deepseek-ai/deepseek-harness/discussions/7748)
  （`deepseek-ai/deepseek-harness`）。

## 一键安装

包内附带 `install.sh` —— 一个参数化安装脚本，可以 (a) 通过官方 `dsh plugin add`
把插件装进 DSH profile，(b) 给 Obsidian **Agent Client** 配置自定义代理，并可选配置
环境变量。它**幂等**、改任何文件前都会**备份**、支持**任意 Obsidian vault**，并可用
`--dry-run` 预演。

```bash
# 先预演（推荐，不改任何东西）
./install.sh --obsidian-vault /任意/vault/路径 --dry-run

# 正式安装进 "web" profile + 配置 Obsidian
./install.sh --obsidian-vault /任意/vault/路径

# 装进其它 DSH profile
./install.sh --profile headless --obsidian-vault /任意/vault/路径

# 只装 DSH，跳过 Obsidian
./install.sh --no-obsidian
```

运行 `./install.sh --help` 查看全部选项。要点：

| 选项 | 含义 |
|------|------|
| `--profile <name>` | 安装到的 DSH profile（默认 `web`） |
| `--dsh-home <dir>` | DSH 数据根（默认 `$DSH_HOME` 或 `~/.dsh`） |
| `--obsidian-vault <dir>` | 任意要配置的 Obsidian vault（支持任意路径） |
| `--package <src>` | 插件来源：`<tgz>` / `<npm 包名>` / `link:<目录>` |
| `--node-bin <path>` | 自定义代理使用的 node 二进制 |
| `--profile-env` | 打印推荐的适配器环境变量 |
| `--no-obsidian` | 跳过 Obsidian 配置步骤 |
| `--dry-run` | 只预演，不做任何改动 |
| `--uninstall` | 恢复备份 + 卸载 DSH profile 插件（`dsh plugin remove`）+ 移除 Obsidian 本脚本添加的配置 |

**Windows**：请改用 PowerShell 版本 `install.ps1`。它把「插件安装目标 profile」
（`-PluginProfile`，默认 `web`）与「适配器运行时 profile」（`-RuntimeProfile`，默认
`headless`）分离——两者混用正是 `DSH_PROFILE=web` 无法跑一次性 prompt 的原因
（web app 不接受位置参数 prompt）。它同时把 `DSH_BIN=<dsh.cmd 绝对路径>` 写进
custom agent 的 env（Node 无法直接 spawn npm 垫片；适配器会解析 cmd-shim 后经
node 拉起），设置 `nodePath` / `command=node.exe + args=[adapter]`，且不写 PATH
（Agent Client 会与父进程 env 合并）。

```powershell
.\install.ps1 -ObsidianVault 'D:\path\to\vault' -DryRun     # 预演
.\install.ps1 -ObsidianVault 'D:\path\to\vault'             # 安装
.\install.ps1 -ObsidianVault 'D:\path\to\vault' -SkipPlugin # 只重配 Obsidian
.\install.ps1 -Uninstall -ObsidianVault 'D:\path\to\vault'  # 还原
```

## 独立使用

安装包之后（或直接从检出目录运行）：

```bash
node dsh-acp.mjs            # 在 stdin/stdout 上提供 ACP v1 服务
node dsh-acp.mjs doctor     # 健康检查 + 一键修复提示（v0.1.x 实验性）
```

### 健康检查 / 修复（`doctor`，实验性）

当 DSH 或 Obsidian 报告连接问题（"ACP connection closed"、"dsh exited 1"、
`MISSING_CREDENTIAL` …）时，适配器会在 ACP 回复里**自动注入一段诊断块**，
带可一键复制粘贴执行的修复命令。你也可以单独跑一次健康检查：

```bash
node dsh-acp.mjs doctor            # 诊断 + 输出可一键修复的命令
node dsh-acp.mjs doctor --auto              # 仅预览修复计划（不写任何文件）
node dsh-acp.mjs doctor --auto --apply      # 才执行；且只执行 user-authorized 项（manual 项永不自动执行）
```

`doctor` 是 **版本无关的** —— 它能同时在 `0.1.1-rc.2` 和 `0.1.2-alpha` 的 dsh 上
工作，只做通用检查（dsh 二进制、dsh 版本、缺失的 API key 凭据、npm 更新提示）。
它不依赖任何 dsh 特定版本内部 API。

doctor 在 R2 阶段已覆盖 **8 项 Obsidian 侧依赖检查**（vault 配置、Agent Client
插件状态、`data.json` 自定义代理、`DSH_BIN` 解析、API key、profile 路径、归档
目录、cordis 服务注册），并通过 R3 的 `--fix <item>` / `--auto` 提供一键修复：
仅对用户授权项写入，写入前自动备份；改动**不热生效**，需重启 Obsidian。

### 会话垃圾回收（`gc`，自动）

**问题：** Obsidian Agent Client 的 delete 按钮只删它本地的
`sessions/<id>.json`，从来不发 ACP `session/delete` —— 所以
obsidian-dsh-acp 自己的持久索引 + 归档会过期，会话在下一次 `session/list` 时
「复现」了。

**修复（自动）：** 每次 `session/list` 时，适配器会拿自己的持久会话索引与
Obsidian 本地的 `agent-client/sessions` 目录对账，删掉 Obsidian 已经不再追踪的
会话（含磁盘归档）。这处是保守策略 —— Obsidian 仍存在的会话**绝不**删除。

**检测 / 手动触发：**
```bash
node dsh-acp.mjs doctor          # 展示检测到了哪些 Obsidian sessions 目录，以及 orphan 数量
node dsh-acp.mjs doctor --gc     # 立刻跑一次垃圾回收
```

**配置环境变量：**
| 变量 | 默认 | 含义 |
|---|---|---|
| `DSH_ACP_GC` | `on` | `off` 关闭自动 GC |
| `DSH_ACP_GC_OBSIDIAN_DIRS` | *（自动检测）* | 逗号分隔的额外 `agent-client/sessions` 目录用于对账 |
| `DSH_ACP_GC_NEED_ARCHIVE` | `0` | 为 `1` 时，只删除仍然带磁盘归档的 orphan |
| `DSH_ACP_GC_REPORT_ONLY` | `0` | `1` = dry-run（仅报告，绝不删除） |
| `DSH_ACP_GC_VERBOSE` | `0` | `1` = 把 GC 操作写到 stderr |

### 配置（Obsidian Agent Client）

配置自定义代理有两种方式：**一键安装**（运行 `install.sh --obsidian-vault <vault>`，
见上文）或如下**手动配置**。

**Obsidian 内手动操作步骤：**

1. 安装 **Agent Client** 社区插件（设置 → 第三方插件 → 浏览 → 搜索 "Agent Client"）
   并启用。
2. 打开插件设置 → **Custom Agents** → **Add**。
3. 填写：
   - **ID**：`dsh-acp`
   - **Display name**：`DeepSeek Harness (ACP)`
   - **Command**：本包 `dsh-acp.mjs` 的绝对路径
   - **Args**：*（空）*
   - **Env**（可选）：如 `DSH_ACP_LOG_DIR` → `/绝对/路径/到/logs`
4. 将插件的 **nodePath** 设为真实的 `node` 二进制（>= 22.13），以便 shebang 解析。
5. 重载 Obsidian（Cmd-R），在代理选择器中选中 *DeepSeek Harness (ACP)*。

如果直接编辑 `data.json`：

```json
{
  "id": "dsh-acp",
  "displayName": "DeepSeek Harness (ACP)",
  "command": "/absolute/path/to/dsh-acp/dsh-acp.mjs",
  "args": [],
  "env": [{ "name": "DSH_ACP_LOG_DIR", "value": "/absolute/path/to/dsh-acp/logs" }]
}
```

### 首次使用

第一次发 prompt 之前，请在代理选择器（Session 面板）里选一个 **tool-capable 且
已配 API key** 的模型（例如 `gemini-2.5-pro`）。

**原因**：工具调用帧只会在选用的模型支持 tool/function calling 时出现。如果没
选模型，spawn 路径会 fallback 到 headless profile 的默认值
（`deepseek-official/deepseek-v4-flash`）。如果该默认值不支持工具调用，或你没
配 DeepSeek 官方 API key，第一条 prompt 就会报 `AUTH: Authentication Fails`，
或者工具调用完全不出现。

**修复**：要么 (a) 在 session 面板先选好 tool-capable 且已配 key 的模型再发
prompt，要么 (b) 在 `~/.dsh/profiles/headless/settings.yaml` 里给
`deepseek-official` 配上凭据**并**确认默认模型支持 tool calling。

### 已知限制

0.3.0 用的是 **Path A**（spawn 路径 + `--json`）来产出工具调用帧，**不**走
dsh 官方桥。因此：

- **无审批弹窗**：bash / 写文件等工具直接执行，不弹审批框。延续 v0.2.x 行为，
  只是工具帧从无到有。如需审批弹窗，可用 `DSH_ACP_PERMISSION_MODE`（仅对
  dsh long-runtime 路径生效），或等官方桥支持（需 dsh 上游修复）。
- **dsh web profile 不支持官方桥**：即使你设 `DSH_ACP_USE_OFFICIAL_BRIDGE=1`，
  dsh web profile 当前不暴露官方桥所需的 4 个核心 service（`llm` /
  `sessionPersistence` / `agents` / `sessions`）。Path A 不依赖此功能，单独
  `dsh-acp.mjs` 二进制即可工作。

## cordis 插件用法

通过官方插件机制安装进某个 DSH profile（`package.json` 中的 `dsh.bundle` manifest
使其可用 `dsh plugin add` 安装）：

```bash
# 从 npm registry（发布后）
dsh plugin --profile web add obsidian-dsh-acp

# 从本地发布产物（tarball）
dsh plugin --profile web add ./obsidian-dsh-acp-0.1.0.tgz

# 从本地检出（符号链接，开发模式）
dsh plugin --profile web add -w link:/path/to/dsh-acp
```

验证插件注册进 profile 的配置树：

```bash
dsh --profile web --dump-config | grep -A1 "dsh-acp"
# -> # == obsidian-dsh-acp
#    - id: dsh-acp
#      name: obsidian-dsh-acp
```

插件读取 `cordis.patch.yml`，将 `dsh-acp` 条目插入到该 profile 的插件树中，然后暴露
`dsh.acp` 服务：

- `ctx.get("dsh.acp")` —— `DshAcpService` 实例。
- `service.start()` / `service.stop()` —— 启动 / 终止适配器子进程。
- `service.process` —— 存活的 `ChildProcess`（未运行时为 null）。

### 适配器环境变量

被拉起的 `dsh --profile <name>` 进程读取这些环境变量。按需为适配器设置（Obsidian
custom-agent 的 `env`，或 profile/托管进程）：

| 变量 | 含义 | 默认值 |
|----------|---------|---------|
| `DSH_BIN` | `dsh` 可执行文件 | PATH 上的 `dsh` |
| `DSH_PROFILE` | 启动使用的 profile | `headless` |
| `DSH_ARGS` | 提示词之前附加的参数（空格分隔） | *（无）* |
| `DSH_ACP_LOG_DIR` | 运行时日志目录 | *（禁用）* |
| `DSH_ACP_LOG_MAX_BYTES` | 日志轮转的大小上限（字节） | `5242880`（5 MB） |
| `DSH_ACP_LOG_KEEP` | 保留的轮转 `.1`/`.2`… 日志份数 | `2` |
| `DSH_ACP_STORE_DIR` | 持久会话 JSON 索引目录 | `~/.dsh-acp` |
| `DSH_ACP_PERSIST_DEBOUNCE_MS` | 索引合并写的防抖窗口（毫秒） | `100` |
| `DSH_ACP_ARCHIVE_IN_MAIN` | 将回合归档放到 `sessions/` 而非 `dsh-acp-archives/` | `0` |

配置（由 loader 提供）：

```yaml
# cordis.patch.yml 条目的示例
- id: dsh-acp
  name: dsh-acp
  config:
    spawn: true        # 在 app/ready 时启动适配器
    profile: headless  # 适配器使用的 DSH profile
    env: {}            # 适配器进程的额外环境变量
```

## Headless profile 引导

`dsh --profile headless` 需要一个 headless profile 能够解析的默认模型提供商。如果全局
的 `$DSH_HOME/settings.yaml` 固定使用一个仅限 web 的提供商（例如
`my-web-only-provider`），请为 headless profile 提供它自己的设置：

- `~/.dsh/profiles/headless/settings.yaml` —— 一条 `llm-pi-ai` 路由 +
  `agent-default-model`。
- `~/.dsh/profiles/headless/cordis.patch.yml` —— 通过 `settings` id 覆盖挂载该设置文件，
  并设置 `agent-default-model`。

## Obsidian agent-client 集成（proxy 与 spawn）

要在 Obsidian 里跑本适配器，需在 Agent Client 插件设置中新增一个 **custom agent**。
有两点容易写错，务必注意：

1. **`customAgent.env` 是 `{ key, value }` 对象数组，不是 `"KEY=VALUE"` 字符串。**
   Agent Client 用 reduce 遍历该数组来构造子进程环境
   （`env.reduce((acc, { key, value }) => …)`），写成纯字符串条目会被忽略。
2. 适配器**按轮次**选择传输方式：
   * **proxy**（本机有 dsh web 网关时推荐）—— 把该轮经 HTTP/SSE 转给已在运行的网关；
   * **spawn**（回退）—— 自己起一个 `dsh --profile <profile> <prompt>` 子进程。

推荐的两项 `env`：

| key | value | 作用 |
|---|---|---|
| `DSH_ACP_HTTP_GATEWAY_URL` | `http://127.0.0.1:3080` | 指向 dsh web 网关 |
| `DSH_ACP_PROXY_MODE` | `true` | 要求使用 proxy 传输 |

**两项都不配**时，适配器走 **spawn（headless）**，这需要系统已安装 `dsh` CLI
（`DSH_ACP_SPAWN_PROFILE` 可覆盖 profile，默认 `headless` —— 它是**支持 prompt 位置参数**
的那个；`web` 是服务端 profile，不接受 prompt 位置参数）。

## 许可证

[MIT](LICENSE)

[acp]: https://github.com/evalstate/agent-client-protocol
[cordis]: https://github.com/cordiverse/cordis
