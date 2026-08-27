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
| `cordis.patch.yml` | plugin insert layer for `dsh plugin ... add dsh-acp` |
| `scripts/dsh-acp.js` | ACP server adapter (runtime reference copy) |
| `scripts/test-client.js` | ACP client harness for standalone verification |
| `acp-feature-test.mjs` | Protocol-level feature test (list / fork / resume / archive) |
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
| `DSH_ACP_STORE_DIR` | directory for the durable session JSON index | `~/.dsh-acp` |
| `DSH_ACP_ARCHIVE_IN_MAIN` | place turn archives under `sessions/` instead of `dsh-acp-archives/` | `0` |

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
