# obsidian-dsh-acp

`obsidian-dsh-acp` is an **ACP (Agent Client Protocol)** plugin/adapter that
bridges **DeepSeek Harness (DSH)** into **Obsidian**. Configure it as a
*Custom Agent* in Obsidian's **Agent Client** plugin (or install it as a
cordis plugin in a DSH profile) and you can drive DSH from inside Obsidian —
running DeepSeek Harness conversations and tasks without ever leaving the app.

It is an **ACP server** (speaks ACP v1 over stdin/stdout), standing between
Obsidian and DSH:

```text
Obsidian (Agent Client plugin)
      │  ① launched as a Custom Agent over ACP
      ▼
obsidian-dsh-acp (ACP server)
      │  ② one prompt per turn
      ▼
dsh --profile headless "<prompt>"   (one-shot DeepSeek Harness task)
```

It mirrors how `claude-agent-acp` wraps Claude Code. Each prompt turn:
- spawns a fresh `dsh --profile headless "<prompt>"` (one-shot task)
- streams DSH output back as `agent_message_chunk` updates
- returns an `end_turn` result when done

It also supports session management: a persistent session list (so Obsidian's
"Session history" can reload real sessions), `session/fork` session branching,
and mirroring each turn into a DSH archive.

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

4. **Delete a session permanently (v0.1.4)** — `session/delete` removes the
   session record **and** the on-disk archive directory under both
   `<DSH_HOME>/dsh-acp-archives/` and `<DSH_HOME>/sessions/` (the archive dir is
   named after the record's `session-<uuid>` key), so a deleted session does not
   "come back" on the next list. The adapter advertises
   `sessionCapabilities.delete`.

`session/resume` and `session/load` reopen an existing stored session.

> **Durability & concurrency (v0.1.4)**: the in-memory session index is
> persisted on a short debounce (`DSH_ACP_PERSIST_DEBOUNCE_MS`) and flushed
> before exit, so bursts of messages coalesce into few disk writes. Concurrent
> adapter processes sharing one store merge their writes before persisting and
> never resurrect a deleted record. See `docs/计划/开发现状.md` for the full
> REQ changelog.

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
| `--uninstall` | restore backups, remove the DSH plugin (`dsh plugin remove`) and Obsidian config this script added |

## Standalone usage

With the package installed (or directly from a checkout):

```bash
node dsh-acp.mjs            # serve ACP v1 on stdin/stdout
node scripts/test-client.js "reply with just the word HELLO"
node dsh-acp.mjs doctor     # health-check + one-click repair hints (v0.1.x experimental)
```

### Health check / repair (`doctor`, experimental)

When DSH or Obsidian reports a connection problem ("ACP connection closed",
"dsh exited 1", `MISSING_CREDENTIAL` …), the adapter auto-injects a **diagnostic
block with copy-pasteable repair commands** into the ACP reply. You can also run
a standalone health check:

```bash
node dsh-acp.mjs doctor            # diagnose + print one-click fix commands
node dsh-acp.mjs doctor --auto     # attempt auto-fix (each step asks for confirmation first)
```

`doctor` is **version-agnostic** — it works with both `0.1.1-rc.2` and
`0.1.2-alpha` of dsh, and only does generic checks (dsh binary, dsh version,
missing API-key credentials, npm update hint). It never depends on any
dsh-version-specific internal API.

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
| `DSH_ACP_LOG_MAX_BYTES` | size cap (bytes) before the log rotates | `5242880` (5 MB) |
| `DSH_ACP_LOG_KEEP` | number of rotated `.1`/`.2`… log files to keep | `2` |
| `DSH_ACP_STORE_DIR` | directory for the durable session JSON index | `~/.dsh-acp` |
| `DSH_ACP_PERSIST_DEBOUNCE_MS` | debounce window (ms) for coalescing index writes | `100` |
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
