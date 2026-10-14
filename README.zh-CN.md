# obsidian-dsh-acp

[English](README.md) · **简体中文** · [Русский](README.ru.md)

[![npm version](https://img.shields.io/npm/v/obsidian-dsh-acp?color=blue)](https://www.npmjs.com/package/obsidian-dsh-acp)
[![npm downloads](https://img.shields.io/npm/dm/obsidian-dsh-acp)](https://www.npmjs.com/package/obsidian-dsh-acp)
[![license](https://img.shields.io/npm/l/obsidian-dsh-acp)](LICENSE)
[![node](https://img.shields.io/node/v/obsidian-dsh-acp)](package.json)
[![dsh](https://img.shields.io/badge/dsh-%E2%89%A50.1.6--alpha.1-blueviolet)](https://github.com/deepseek-ai/deepseek-harness)

> 在 **[Obsidian](https://obsidian.md)** 里直接使用
> **[DeepSeek Harness（DSH）](https://github.com/deepseek-ai/deepseek-harness)** ——
> 一个把 Obsidian 变成完整 DSH 客户端的 ACP 适配器。

## 这是什么？

`obsidian-dsh-acp` 是一个 **[ACP（Agent Client Protocol）](https://github.com/evalstate/agent-client-protocol)**
服务器，把 DSH 接入 Obsidian。把它配置为 Obsidian **Agent Client** 社区插件里的
*Custom Agent*（或作为 cordis 插件装进 DSH profile），就能在 Obsidian 界面里驱动
DeepSeek Harness —— 对话、工具调用、会话历史 —— 全程不用切出 Obsidian。

```text
Obsidian（Agent Client 插件）
      │  ① 作为 Custom Agent 通过 ACP 启动它
      ▼
obsidian-dsh-acp（ACP 服务器，v1 over stdin/stdout）
      │  ② 每个 turn 一条 prompt
      ▼
dsh  （headless 一次性任务，或长驻的 dsh web gateway）
```

它的工作方式与 `claude-agent-acp` 包装 Claude Code 类似：每个 turn 把 DSH 输出以
`agent_message_chunk` 增量流回客户端，结束时返回 `end_turn`。

## 功能

- 💬 **在 Obsidian 里对话** —— 从 Agent Client 侧边栏直接向 DSH 发 prompt。
- 🧰 **工具调用卡片** —— 客户端渲染工具卡片（`in_progress` → `completed`），
  每步显示 token 用量。*（需要支持工具的模型）*
- 🗂️ **会话管理** —— 持久会话列表、**fork**、**resume**、**永久删除**；适配器重启后仍在。
- 🔀 **按会话切换模型** —— 客户端里的模型下拉框；所选模型只作用于该会话
  （绝不改动共享的 profile 配置）。
- 🧠 **推理与实时流** —— long 模式（在 dsh web profile 内）显示实时推理 / 执行过程。
- 📥 **导入外部会话** —— 把其它 ACP agent（如 Claude / Agent Client）导出的会话
  导入本地 DSH 会话库。
- 🩺 **自检与一键修复** —— `dsh-acp doctor` 诊断环境漂移，并能自动修复大部分问题。
- 🧹 **自动清理** —— 每次 `session/list` 与 Obsidian 自身的会话列表对账清理孤儿
  （保守策略；仍在 Obsidian 里的会话永不删除）。

## 截图

在 Obsidian Agent Client 里注册为自定义 agent、运行一次对话、浏览会话历史：

![Agent settings](assets/screenshots/obsidian-agent-client-settings.png)
![Chat panel](assets/screenshots/obsidian-agent-client-chat.png)
![Session history](assets/screenshots/obsidian-agent-client-session-history.png)

## 环境要求

- **Node.js >= 22.13**
- 一个能启动的 **`dsh`** 后端（见 [Headless profile 引导](#headless-profile-引导)）
- **Obsidian** + **Agent Client** 社区插件（走 Obsidian 路径时）

## 安装

### 一键安装（推荐）

安装脚本会（a）通过官方的 `dsh plugin add` 把插件装进某个 DSH profile，并
（b）把一个 Obsidian **Agent Client** 自定义 agent 接到 ACP 服务器上。它**幂等**、
改动文件前先**备份**、支持**任意 Obsidian vault**，可用 `--dry-run` 预览。

```bash
# 先预览（不改动任何东西）
./install.sh --obsidian-vault /path/to/any/vault --dry-run

# 装进 "web" profile 并接好 Obsidian
./install.sh --obsidian-vault /path/to/any/vault

# 装进其它 profile / 跳过 Obsidian
./install.sh --profile headless --obsidian-vault /path/to/any/vault
./install.sh --no-obsidian
```

全部选项见 `./install.sh --help`（`--profile`、`--dsh-home`、`--package`、
`--node-bin`、`--dry-run`、`--uninstall` 等）。

**Windows：** 改用 PowerShell 版 —— `.\install.ps1 -ObsidianVault 'D:\path\to\vault'`
（加 `-DryRun` 预览，`-Uninstall` 还原）。它会写入指向 `dsh.cmd` 垫片的 `DSH_BIN`，
并把「插件目标 profile」与「适配器运行时 profile」分开。

### 手动配置（Obsidian Agent Client）

1. 安装并启用 **Agent Client** 社区插件
   （设置 → 第三方插件 → 浏览 → 搜索 "Agent Client"）。
2. 设置 → **Custom Agents** → **Add**，填写：
   - **ID**：`dsh-acp`
   - **Display name**：`DeepSeek Harness (ACP)`
   - **Command**：本包 `dsh-acp.mjs` 的绝对路径
   - **Args**：*（留空）*
3. 把插件的 **`nodePath`** 指向一个真实的 `node`（>= 22.13）。
4. 重载 Obsidian（`Cmd/Ctrl-R`），在 agent 选择器里选 *DeepSeek Harness (ACP)*。

> **`customAgent.env` 是 `{ key, value }` 对象数组 —— 不是 `"KEY=VALUE"` 字符串。**
> Agent Client 从该数组构建子进程环境；纯字符串条目会被静默忽略。

## 快速上手

1. 首次发 prompt 前，在会话面板里**选一个支持工具的模型**（如 `gemini-2.5-pro`），
   并确保它配好了有效的 API key。工具卡片只在模型支持工具调用时出现。
2. 发一条 prompt。DSH 跑完这个 turn，把回答流回 Obsidian。

如果首轮报 `AUTH: Authentication Fails` 或什么都不返回，说明默认模型要么不支持
工具、要么没配凭据 —— 在模型选择器里换一个配好的模型重试。

## 用法

```bash
dsh-acp                       # 启动 ACP 服务器（默认）
dsh-acp doctor                # 健康检查 + 一键修复指引
dsh-acp import <file>         # 导入外部 ACP 会话 JSON
dsh-acp manage <verb> ...     # list / export / archive / move / import 会话
dsh-acp --help                # 完整帮助
```

### 健康检查与修复（`doctor`）

当 DSH 或 Obsidian 报告连接问题（"ACP connection closed"、"dsh exited 1"、
`MISSING_CREDENTIAL` 等）时，运行：

```bash
dsh-acp doctor                  # 诊断，打印可直接复制的修复命令
dsh-acp doctor --repair         # 自检全量修复 —— 预览（零写盘）
dsh-acp doctor --repair --apply # 执行修复（每个文件先自动备份）
```

`doctor` **与版本无关**：只做通用检查（dsh 二进制、dsh 版本、凭据、headless
profile 健康度），不依赖任何特定 dsh 版本的内部 API。

### 工具轮无文字兜底

推理型模型有时只调工具、不产出面向用户的文字（答案全留在了推理流里）。若不处理，
客户端只会看到一张工具卡片 + 空白回复。为此 `dsh-acp` 会合成一条**如实**提示，保证
这一轮**始终有可见输出**：

```
[模型请求调用工具：<工具名>；当前运行模式不执行工具，本轮无结果与文字]
```

这是**纯显示**——不改协议、不改归档历史。可用 `DSH_ACP_TOOL_ONLY_FALLBACK=off` 关闭。

**proxy/long 工具门控（默认关）。** proxy/long 运行时路径只调用一次
`ctx.llm.stream()`，**没有工具执行器**。在该路径暴露工具 schema 会让模型请求根本
不会执行的工具、然后无正文结束。因此该路径**默认不暴露工具**：

```bash
DSH_ACP_LONG_TOOLS=1 dsh-acp ...   # 开启（须设在 dsh web 进程环境）
```

**需要真正执行工具**？走 **spawn** 路径（去掉 `DSH_ACP_HTTP_GATEWAY_URL`、设
`DSH_ACP_PROXY_MODE=false`）—— 真 `dsh` 后端自带 agent loop。

**可选的收尾句提示（默认关）。** 开启后引导模型在调工具后补一句收尾：

```bash
DSH_ACP_CLOSING_REPLY_NUDGE=1 dsh-acp ...
```

开启后，发给模型的 prompt 会前置一句简短指令（"调完工具后告诉用户你做了什么"）。
该提示**仅模型可见**，绝不显示为用户文字。

> ⚠️ 开启后每个工具轮都会改变 prompt 前缀 → **prompt 缓存失效** → 成本上升。
> 除非清楚取舍，否则保持默认关闭。文案可用 `DSH_ACP_CLOSING_REPLY_NUDGE_TEXT` 覆盖。

> **proxy 路径下记忆工具不执行**（无执行器），且 headless profile 未加载
> `ui-obsidian-memory`。同 session 回忆正常（靠会话历史）；跨 session 记忆不可用。
> 详见 `docs/known-gaps.md`。

### 会话清理（`gc`，自动）

Obsidian 的删除按钮只删它自己的本地会话文件，从不发 ACP `session/delete` —— 所以
本适配器的持久索引会变陈旧、已删会话可能「复活」。适配器在每次 `session/list` 时
自动对账（保守策略 —— 仍在 Obsidian 里的会话永不删除）。

```bash
dsh-acp doctor         # 显示探测到的 Obsidian 会话目录 + 孤儿数量
dsh-acp doctor --gc    # 立即执行清理
```

| 环境变量 | 默认 | 含义 |
|---|---|---|
| `DSH_ACP_GC` | `on` | `off` 关闭自动 GC |
| `DSH_ACP_GC_REPORT_ONLY` | `0` | `1` = 只报告不删除（dry-run） |

## 配置

### Obsidian ↔ 适配器传输（proxy vs spawn）

适配器按 prompt 选择传输方式：

- **proxy** *（推荐，当有 dsh web gateway 在跑时）* —— 把 turn 通过 HTTP/SSE 转发给
  已在运行的 gateway，一个长驻进程服务模型；
- **spawn** *（兜底）* —— 自己起一个 `dsh --profile headless "<prompt>"` 子进程。

建议的自定义 agent `env` 条目：

| key | value | 作用 |
|---|---|---|
| `DSH_ACP_HTTP_GATEWAY_URL` | `http://127.0.0.1:3080` | 指向 dsh web gateway |
| `DSH_ACP_PROXY_MODE` | `true` | 请求 proxy 传输 |

两者都不设时，适配器用 **spawn（headless）** —— 需要系统上有 `dsh` CLI
（`DSH_ACP_SPAWN_PROFILE` 可覆盖 profile，默认 `headless`，也就是那个能接收 prompt
的 profile）。

### 常用环境变量

| 变量 | 含义 | 默认 |
|---|---|---|
| `DSH_BIN` | `dsh` 可执行文件 | PATH 上的 `dsh` |
| `DSH_ACP_SPAWN_PROFILE` | spawn 传输用的 profile | `headless` |
| `DSH_ACP_DEFAULT_MODEL` | 新会话默认 `provider/model` | *（profile）* |
| `DSH_ACP_MODELS` | 覆盖模型下拉框（逗号分隔 `id(显示名)`） | *（catalog）* |
| `DSH_ACP_PERMISSION_MODE` | `default` / `acceptEdits` / `dontAsk` / `bypassPermissions` | `default` |
| `DSH_ACP_LOG_DIR` | 运行时日志目录 | *（关闭）* |
| `DSH_ACP_STORE_DIR` | 持久会话 JSON 索引目录 | `~/.dsh-acp` |

<details>
<summary><b>进阶 →</b> 完整适配器环境变量表</summary>

| 变量 | 含义 | 默认 |
|---|---|---|
| `DSH_PROFILE` | 启动的 profile（其它组件用） | — |
| `DSH_ARGS` | prompt 之前的额外参数（空格分隔） | *（无）* |
| `DSH_ACP_LOG_MAX_BYTES` | 日志轮转大小上限（字节） | `5242880`（5 MB） |
| `DSH_ACP_LOG_KEEP` | 保留的轮转日志数 | `2` |
| `DSH_ACP_PERSIST_DEBOUNCE_MS` | 索引写入的防抖窗口 | `100` |
| `DSH_ACP_PERMISSION_TIMEOUT_MS` | 审批自动拒绝超时 | `300000` |
| `DSH_ACP_PERMISSION_EDIT_TOOLS` | 视作编辑类的工具 | `Edit,Write,MultiEdit,NotebookEdit` |
| `DSH_ACP_RUNTIME_MODE` | `long` / `spawn` 显式覆盖 | *（自动）* |
| `DSH_ACP_SPAWN_FALLBACK` | long 初始化失败时回退 spawn | `true` |
| `DSH_ACP_USE_OFFICIAL_BRIDGE` | 尝试官方 dsh bridge | `0` |
| `DSH_ACP_ARCHIVE_IN_MAIN` | 把 turn 归档放进 `sessions/` | `0` |

</details>

## Headless profile 引导

`dsh --profile headless` 需要一个它能解析的默认模型 provider。用一个**直接**的
`llm-pi-ai` patch 条目给 headless profile 自己的设置：

- `~/.dsh/profiles/headless/cordis.patch.yml` —— 一个 `llm-pi-ai` provider 块 +
  把 `agent-default-model` 设成你选的 `provider/model`。
- `~/.dsh/profiles/headless/package.json` —— `dsh-llm`、`dsh-agent-loop`、
  `dsh-acp`、`dsh-base`、`dsh-headless` 固定到与全局 `dsh` 相同版本。
- `~/.dsh/profiles/headless/pnpm-workspace.yaml` —— `overrides:` 固定
  `@deepseek-ai/dsh-*` 核心包 + `allowBuilds:` 放行原生模块。

用 `dsh-acp doctor` 验证 —— 它会报告 headless profile 的配置错误并给出可直接复制的
修复命令。

## 已知限制

- **spawn 路径无权限弹窗** —— 该路径下 bash / 写文件等工具不经确认直接执行。需要
  审批时用 `DSH_ACP_PERMISSION_MODE`（仅在 long-runtime 路径生效）。
- **官方 dsh bridge 是可选且目前通常不可用**（在 dsh web profile 上）；适配器会自动
  回退到独立的 spawn 路径。

## 开发

```bash
npm run test:unit       # 单元测试（node --test）
npm run test:protocol   # ACP 协议测试（spawn）
npm run test:long       # long-runtime 测试
npm run test:all        # unit + protocol + long
```

## License

[MIT](LICENSE)

[acp]: https://github.com/evalstate/agent-client-protocol
[cordis]: https://github.com/cordiverse/cordis
