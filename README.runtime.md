# dsh-acp

ACP (Agent Client Protocol) adapter that exposes **DeepSeek Harness** as an ACP
server over stdin/stdout, so ACP clients — Obsidian's **Agent Client** plugin,
Claude Code clients, editors — can drive DSH through the local `dsh` CLI.

Each prompt turn spawns a fresh `dsh --profile headless "<prompt>"` (a one-shot,
stateless DSH task). This mirrors how `claude-agent-acp` wraps Claude Code.

## How it works

```
Obsidian Agent Client ──(ACP JSON-RPC over stdin/stdout)──▶ dsh-acp ──spawn──▶ dsh --profile headless "<prompt>"
                                   ▲  session/update chunks                       │
                                   └──────────────── stdout streamed back ─────────┘
```

- ACP v1 (newline-delimited JSON-RPC) over the process's stdin/stdout.
- Streams DSH output back as `agent_message_chunk` updates, then returns a
  `result` (`stopReason: "end_turn"`).
- Sessions are stateless (each turn is independent), cwd is honored.

## Requirements / Files

| Path | Role |
|------|------|
| `scripts/dsh-acp.js` | ACP server adapter (executable, `#!/usr/bin/env node`) |
| `scripts/test-client.js` | ACP client harness for standalone verification |
| `package.json` | npm package; dep `@agentclientprotocol/sdk` |
| `logs/` | runtime logs (when `DSH_ACP_LOG_DIR` is set) |

Requires Node.js >= 22.13 and a bootable `dsh --profile headless` backend.

## Configuration (Obsidian Agent Client)

Edit `<vault>/.obsidian/plugins/agent-client/data.json` (or use the plugin's
settings UI) → add a Custom Agent:

```json
{
  "id": "dsh-acp",
  "displayName": "DeepSeek Harness (ACP)",
  "command": "/absolute/path/to/dsh-acp/scripts/dsh-acp.js",
  "args": [],
  "env": [{ "name": "DSH_ACP_LOG_DIR", "value": "/absolute/path/to/dsh-acp/logs" }]
}
```

Make sure the plugin's **nodePath** points at a real `node` binary so the
shebang resolves:

```json
{ "nodePath": "/Users/<you>/.local/bin/node" }
```

Then **reload Obsidian** (or disable/re-enable Agent Client) so it picks up the
new custom agent, and select *DeepSeek Harness (ACP)* in the agent picker.

## Environment

- `DSH_BIN` — dsh executable (default `dsh` on PATH).
- `DSH_PROFILE` — profile to run (default `headless`).
- `DSH_ARGS` — extra args to pass before the prompt (space-separated).
- `DSH_ACP_LOG_DIR` — directory for a runtime log (optional).

## Headless profile bootstrap

`dsh --profile headless` needs a default model provider the headless profile can
resolve. If your global `$DSH_HOME/settings.yaml` pins a web-only provider (e.g.
`my-web-only-provider`), give the headless profile its own settings:

- `~/.dsh/profiles/headless/settings.yaml` — an `llm-pi-ai` route + `agent-default-model`.
- `~/.dsh/profiles/headless/cordis.patch.yml` — mount that settings file via a
  `settings` id override and set `agent-default-model`.

## Verify standalone

```bash
node scripts/test-client.js "reply with just the word HELLO"
```
