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

## 环境要求

- Node.js >= 22.13
- 可正常启动的 `dsh` 后端（参见 [Headless profile 引导](#headless-profile-引导)）

## 文件

| 路径 | 作用 |
|------|------|
| `dsh-acp.mjs` | 独立的 ACP 服务器二进制（`bin: dsh-acp`） |
| `index.mjs` | cordis 插件入口（`dsh.acp` 服务 + 适配器进程管理器） |
| `cordis.patch.yml` | 供 `dsh plugin ... add dsh-acp` 使用的插件插入层 |
| `scripts/dsh-acp.js` | ACP 服务器适配器（运行时参考副本） |
| `scripts/test-client.js` | 用于独立验证的 ACP 客户端测试工具 |

## 独立使用

安装包之后（或直接从检出目录运行）：

```bash
node dsh-acp.mjs            # 在 stdin/stdout 上提供 ACP v1 服务
node scripts/test-client.js "reply with just the word HELLO"
```

### 配置（Obsidian Agent Client）

编辑 `<vault>/.obsidian/plugins/agent-client/data.json`（或使用插件的设置界面）→
添加一个自定义代理（Custom Agent）：

```json
{
  "id": "dsh-acp",
  "displayName": "DeepSeek Harness (ACP)",
  "command": "/absolute/path/to/dsh-acp/dsh-acp.mjs",
  "args": [],
  "env": [{ "name": "DSH_ACP_LOG_DIR", "value": "/absolute/path/to/dsh-acp/logs" }]
}
```

确保插件的 **nodePath** 指向真实的 `node` 二进制，以便 shebang 能够解析，然后重载
Obsidian，并在代理选择器中选中 *DeepSeek Harness (ACP)*。

### 环境变量

| 变量 | 含义 | 默认值 |
|----------|---------|---------|
| `DSH_BIN` | `dsh` 可执行文件 | PATH 上的 `dsh` |
| `DSH_PROFILE` | 启动使用的 profile | `headless` |
| `DSH_ARGS` | 提示词之前附加的参数（空格分隔） | *（无）* |
| `DSH_ACP_LOG_DIR` | 运行时日志目录 | *（禁用）* |

## cordis 插件用法

安装进某个 DSH profile 并启用条目：

```bash
dsh plugin --profile web add dsh-acp
```

插件读取 `cordis.patch.yml`，将 `dsh-acp` 条目插入到该 profile 的插件树中，然后暴露
`dsh.acp` 服务：

- `ctx.get("dsh.acp")` —— `DshAcpService` 实例。
- `service.start()` / `service.stop()` —— 启动 / 终止适配器子进程。
- `service.process` —— 存活的 `ChildProcess`（未运行时为 null）。

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
