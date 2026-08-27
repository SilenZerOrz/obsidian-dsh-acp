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

`session/resume` 和 `session/load` 可重新打开已保存的会话。

## 环境要求

- Node.js >= 22.13
- 可正常启动的 `dsh` 后端（参见 [Headless profile 引导](#headless-profile-引导)）

## 文件

| 路径 | 作用 |
|------|------|
| `dsh-acp.mjs` | 独立的 ACP 服务器二进制（`bin: dsh-acp`） |
| `archive-store.mjs` | 持久会话存储 + DSH 归档写入器 |
| `index.mjs` | cordis 插件入口（`dsh.acp` 服务 + 适配器进程管理器） |
| `cordis.patch.yml` | 供 `dsh plugin ... add obsidian-dsh-acp` 使用的插件插入层 |
| `scripts/dsh-acp.js` | ACP 服务器适配器（运行时参考副本） |
| `scripts/test-client.js` | 用于独立验证的 ACP 客户端测试工具 |
| `acp-feature-test.mjs` | 协议层功能测试（list / fork / resume / archive） |
| `install.sh` | 一键安装脚本（DSH profile + Obsidian custom agent） |

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
| `--uninstall` | 恢复备份并移除本脚本添加的配置 |

## 独立使用

安装包之后（或直接从检出目录运行）：

```bash
node dsh-acp.mjs            # 在 stdin/stdout 上提供 ACP v1 服务
node scripts/test-client.js "reply with just the word HELLO"
```

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
| `DSH_ACP_STORE_DIR` | 持久会话 JSON 索引目录 | `~/.dsh-acp` |
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

## 许可证

[MIT](LICENSE)

[acp]: https://github.com/evalstate/agent-client-protocol
[cordis]: https://github.com/cordiverse/cordis
