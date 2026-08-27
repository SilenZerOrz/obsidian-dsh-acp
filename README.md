# obsidian-dsh-acp

`obsidian-dsh-acp` 是一个将 **DeepSeek Harness (DSH)** 接入 **Obsidian** 的
**ACP (Agent Client Protocol)** 插件/适配器：把它配置为 Obsidian
**Agent Client** 插件里的一个 *Custom Agent*（或作为 cordis 插件装进 DSH
profile），就能在 Obsidian 界面里直接通过 ACP 驱动 DSH，用 DeepSeek
Harness 完成对话与任务，而不需要切出 Obsidian。

这是一个 **ACP server**（通过 stdin/stdout 讲 ACP v1 协议），作用是桥接：

```text
Obsidian (Agent Client 插件)
      │  ① 作为 Custom Agent 通过 ACP 拉起
      ▼
obsidian-dsh-acp (ACP server)
      │  ② 每次 prompt 拉一个
      ▼
dsh --profile headless "<prompt>"   (DeepSeek Harness 一次性任务)
```

它镜像了 `claude-agent-acp` 包装 Claude Code 的方式。每轮 prompt 会：
- 拉一次 `dsh --profile headless "<prompt>"`（一次性任务）
- 把 DSH 输出流式回传为 `agent_message_chunk` 更新
- 结束时返回 `end_turn` 结果

支持会话管理：持久化的会话列表（Obsidian "Session history" 可 reload）、
`session/fork` 会话分支、以及把每轮对话写回 DSH 归档。

This repository ships two complementary pieces:

1. **`dsh-acp.mjs`** — the standalone ACP server binary (`bin: dsh-acp`).
   GUI ACP clients (Obsidian Agent Client) spawn this directly as a subprocess.
2. **`index.mjs`** — a [cordis][cordis] plugin that registers the `dsh.acp`
   service and manages the adapter process *inside* the harness, for use via
   `dsh plugin --profile <name> add obsidian-dsh-acp`.

## How it works

```text
Obsidian Agent Client ──(ACP JSON-RPC over stdin/stdout)──▶ dsh-acp ──spawn──▶ dsh --profile headless "<prompt>"
                                   ▲  session/update chunks                       │
                                   └──────────────── stdout streamed back ─────────┘
```

- ACP v1 (newline-delimited JSON-RPC) over the process's stdin/stdout.
- Streams DSH output back as `agent_message_chunk` updates, then returns a
  `result` (`stopReason: "end_turn"`).
- `cwd` is honored; a persistent session layer makes session management usable.

## Session features

Beyond the stateless per-turn model, `dsh-acp` adds a persistent session layer
(`archive-store.mjs`) that powers three things:

1. **Reload session list** — `session/list` returns durable sessions from a
   JSON index on disk (default `~/.dsh-acp/dsh-acp-sessions.json`), so Obsidian's
   "Session history" reload shows real sessions across adapter restarts. The
   adapter advertises `sessionCapabilities.list` at initialize.
2. **Fork a session** — `session/fork` deep-copies a source session's message
   history into a new session id, records the parent link, and advertises
   `sessionCapabilities.fork`, so the client's "fork" action works.
3. **Back up each turn** — every completed turn (user + assistant) is appended
   to a DSH-shaped event archive at
   `<DSH_HOME>/dsh-acp-archives/<encoded-cwd>/session-<id>/session.jsonl`.
   It is kept under `dsh-acp-archives/` (not the web process's `sessions/`)
   so its plain `.jsonl` never clashes with the main process's zstd-compressed
   session logs. Set `DSH_ACP_ARCHIVE_IN_MAIN=1` to place it under `sessions/`
   instead (only if you are running the archive in the same compression mode).

`session/resume` and `session/load` reopen an existing stored session.

## Requirements

- Node.js >= 22.13
- A bootable `dsh` backend (see [Headless profile bootstrap](#headless-profile-bootstrap))

## Files

| Path | Role |
|------|------|
| `dsh-acp.mjs` | Standalone ACP server binary (`bin: dsh-acp`) |
| `archive-store.mjs` | Persistent session store + DSH-format archive writer |
| `index.mjs` | cordis plugin entry (`dsh.acp` service + adapter process manager) |
| `cordis.patch.yml` | plugin insert layer for `dsh plugin ... add obsidian-dsh-acp` |
| `scripts/dsh-acp.js` | ACP server adapter (runtime reference copy) |
| `scripts/test-client.js` | ACP client harness for standalone verification |
| `acp-feature-test.mjs` | Protocol-level feature test (list / fork / resume / archive) |
| `install.sh` | one-click installer (DSH profile + Obsidian custom agent) |
| `README.zh-CN.md` | 中文版说明文档 (Chinese) |
| `README.ru.md` | Документация на русском (Russian) |

## Quick install (one click)

The package ships `install.sh` — a parameterized installer that (a) installs the
plugin into a DSH profile via the official `dsh plugin add` path and (b) wires
an Obsidian **Agent Client** custom agent to the ACP server, with optional env
config. It is **idempotent**, **backs up** every file before touching it,
supports **any Obsidian vault**, and can be previewed with `--dry-run`.

```bash
# dry-run preview first (recommended)
./install.sh --obsidian-vault /path/to/any/vault --dry-run

# real install into the "web" profile + wire Obsidian
./install.sh --obsidian-vault /path/to/any/vault

# install into another DSH profile
./install.sh --profile headless --obsidian-vault /path/to/any/vault

# DSH-only (skip Obsidian)
./install.sh --no-obsidian
```

Run `./install.sh --help` for every option. Highlights:

| Option | Meaning |
|--------|---------|
| `--profile <name>` | DSH profile to install into (default `web`) |
| `--dsh-home <dir>` | DSH data root (default `$DSH_HOME` or `~/.dsh`) |
| `--obsidian-vault <dir>` | any Obsidian vault to wire into (supports arbitrary path) |
| `--package <src>` | plugin source: `<tgz>` / `<npm name>` / `link:<dir>` |
| `--node-bin <path>` | node binary for the custom agent |
| `--profile-env` | print recommended adapter env |
| `--no-obsidian` | skip the Obsidian wiring step |
| `--dry-run` | preview only, change nothing |
| `--uninstall` | restore backups and remove config this script added |

## Standalone usage

With the package installed (or directly from a checkout):

```bash
node dsh-acp.mjs            # serve ACP v1 on stdin/stdout
node scripts/test-client.js "reply with just the word HELLO"
```

### Configuration (Obsidian Agent Client)

There are two ways to configure the custom agent: **one-click** (run
`install.sh --obsidian-vault <vault>`, see above) or **manually** as follows.

**Manual steps in Obsidian:**

1. Install the **Agent Client** community plugin (Settings → Community plugins →
   Browse → search "Agent Client") and enable it.
2. Open the plugin's settings → **Custom Agents** → **Add**.
3. Fill in:
   - **ID**: `dsh-acp`
   - **Display name**: `DeepSeek Harness (ACP)`
   - **Command**: the absolute path to this package's `dsh-acp.mjs`
   - **Args**: *(empty)*
   - **Env** (optional): e.g.
     `DSH_ACP_LOG_DIR` → `/absolute/path/to/logs`
4. Set the plugin's **nodePath** to a real `node` binary (>= 22.13) so the
   script's shebang resolves.
5. Reload Obsidian (Cmd-R) and pick *DeepSeek Harness (ACP)* in the agent
   picker.

If you configure it by editing `data.json` directly:

```json
{
  "id": "dsh-acp",
  "displayName": "DeepSeek Harness (ACP)",
  "command": "/absolute/path/to/dsh-acp/dsh-acp.mjs",
  "args": [],
  "env": [{ "name": "DSH_ACP_LOG_DIR", "value": "/absolute/path/to/dsh-acp/logs" }]
}
```

## cordis plugin usage

Install into a DSH profile via the official plugin mechanism (this makes the
plugin installable with `dsh plugin add` thanks to the `dsh.bundle` manifest in
`package.json`):

```bash
# from the npm registry (after publish)
dsh plugin --profile web add obsidian-dsh-acp

# from a local publish artifact (tarball)
dsh plugin --profile web add ./obsidian-dsh-acp-0.1.0.tgz

# from a local checkout (symlink, dev mode)
dsh plugin --profile web add -w link:/path/to/dsh-acp
```

Verify the plugin is registered in the profile's config tree:

```bash
dsh --profile web --dump-config | grep -A1 "dsh-acp"
# -> # == obsidian-dsh-acp
#    - id: dsh-acp
#      name: obsidian-dsh-acp
```

The plugin reads `cordis.patch.yml` to insert its `dsh-acp` entry into the
profile's plugin tree, then exposes the `dsh.acp` service:

- `ctx.get("dsh.acp")` — the `DshAcpService` instance.
- `service.start()` / `service.stop()` — spawn / terminate the adapter
  subprocess.
- `service.process` — the live `ChildProcess` (null when not running).

### Adapter environment

The spawned `dsh --profile <name>` process reads these environment variables.
Set them for the adapter (custom-agent `env` in Obsidian, or the profile/managed
process) as needed:

| Variable | Meaning | Default |
|----------|---------|---------|
| `DSH_BIN` | `dsh` executable | `dsh` on PATH |
| `DSH_PROFILE` | profile to boot | `headless` |
| `DSH_ARGS` | extra args before the prompt (space-separated) | *(none)* |
| `DSH_ACP_LOG_DIR` | directory for a runtime log | *(disabled)* |
| `DSH_ACP_STORE_DIR` | directory for the durable session JSON index | `~/.dsh-acp` |
| `DSH_ACP_ARCHIVE_IN_MAIN` | place turn archives under `sessions/` instead of `dsh-acp-archives/` | `0` |

Config (loader-provided):

```yaml
# cordis.patch.yml entry example
- id: dsh-acp
  name: dsh-acp
  config:
    spawn: true        # start the adapter on app/ready
    profile: headless  # DSH profile for the adapter
    env: {}            # extra env for the adapter process
```

## Headless profile bootstrap

`dsh --profile headless` needs a default model provider the headless profile
can resolve. If your global `$DSH_HOME/settings.yaml` pins a web-only provider
(e.g. `my-web-only-provider`), give the headless profile its own settings:

- `~/.dsh/profiles/headless/settings.yaml` — an `llm-pi-ai` route +
  `agent-default-model`.
- `~/.dsh/profiles/headless/cordis.patch.yml` — mount that settings file via a
  `settings` id override and set `agent-default-model`.

## License

[MIT](LICENSE)

[acp]: https://github.com/evalstate/agent-client-protocol
[cordis]: https://github.com/cordiverse/cordis
