# dsh-acp

An [ACP (Agent Client Protocol)][acp] adapter that exposes **DeepSeek Harness
(DSH)** as an ACP server over stdin/stdout, so ACP clients — Obsidian's
**Agent Client** plugin, Claude Code clients, editors — can drive DSH through
the local `dsh` CLI.

Every prompt turn spawns a fresh

```text
dsh --profile headless "<prompt>"
```

(a one-shot, stateless task), mirroring how `claude-agent-acp` wraps Claude
Code. Output is streamed back to the client as `agent_message_chunk` updates,
then a terminal `end_turn` result is returned.

This repository ships two complementary pieces:

1. **`dsh-acp.mjs`** — the standalone ACP server binary (`bin: dsh-acp`).
   GUI ACP clients spawn this directly as a subprocess.
2. **`index.mjs`** — a [cordis][cordis] plugin that registers the `dsh.acp`
   service and manages the adapter process *inside* the harness, for use via
   `dsh plugin --profile <name> add dsh-acp`.

## How it works

```text
Obsidian Agent Client ──(ACP JSON-RPC over stdin/stdout)──▶ dsh-acp ──spawn──▶ dsh --profile headless "<prompt>"
                                   ▲  session/update chunks                       │
                                   └──────────────── stdout streamed back ─────────┘
```

- ACP v1 (newline-delimited JSON-RPC) over the process's stdin/stdout.
- Streams DSH output back as `agent_message_chunk` updates, then returns a
  `result` (`stopReason: "end_turn"`).
- Sessions are stateless (each turn is independent); `cwd` is honored.

## Requirements

- Node.js >= 22.13
- A bootable `dsh` backend (see [Headless profile bootstrap](#headless-profile-bootstrap))

## Files

| Path | Role |
|------|------|
| `dsh-acp.mjs` | Standalone ACP server binary (`bin: dsh-acp`) |
| `index.mjs` | cordis plugin entry (`dsh.acp` service + adapter process manager) |
| `cordis.patch.yml` | plugin insert layer for `dsh plugin ... add dsh-acp` |
| `scripts/dsh-acp.js` | ACP server adapter (runtime reference copy) |
| `scripts/test-client.js` | ACP client harness for standalone verification |
| `README.zh-CN.md` | 中文版说明文档 (Chinese) |
| `README.ru.md` | Документация на русском (Russian) |

## Standalone usage

With the package installed (or directly from a checkout):

```bash
node dsh-acp.mjs            # serve ACP v1 on stdin/stdout
node scripts/test-client.js "reply with just the word HELLO"
```

### Configuration (Obsidian Agent Client)

Edit `<vault>/.obsidian/plugins/agent-client/data.json` (or use the plugin's
settings UI) → add a Custom Agent:

```json
{
  "id": "dsh-acp",
  "displayName": "DeepSeek Harness (ACP)",
  "command": "/absolute/path/to/dsh-acp/dsh-acp.mjs",
  "args": [],
  "env": [{ "name": "DSH_ACP_LOG_DIR", "value": "/absolute/path/to/dsh-acp/logs" }]
}
```

Make sure the plugin's **nodePath** points at a real `node` binary so the
shebang resolves, then reload Obsidian and select *DeepSeek Harness (ACP)* in
the agent picker.

### Environment

| Variable | Meaning | Default |
|----------|---------|---------|
| `DSH_BIN` | `dsh` executable | `dsh` on PATH |
| `DSH_PROFILE` | profile to boot | `headless` |
| `DSH_ARGS` | extra args before the prompt (space-separated) | *(none)* |
| `DSH_ACP_LOG_DIR` | directory for a runtime log | *(disabled)* |

## cordis plugin usage

Install into a DSH profile and enable the entry:

```bash
dsh plugin --profile web add dsh-acp
```

The plugin reads `cordis.patch.yml` to insert its `dsh-acp` entry into the
profile's plugin tree, then exposes the `dsh.acp` service:

- `ctx.get("dsh.acp")` — the `DshAcpService` instance.
- `service.start()` / `service.stop()` — spawn / terminate the adapter
  subprocess.
- `service.process` — the live `ChildProcess` (null when not running).

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
