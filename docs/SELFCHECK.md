# Self-check & Self-repair

`obsidian-dsh-acp` ships a self-check / self-repair kernel so a fresh
install — or any environment drift — can be diagnosed (and most issues
fixed) without manually editing config files. This document is the
canonical reference for what it detects, what it can fix, and what it
deliberately does not touch.

The single entry point for all three call sites (adapter startup
preflight, `doctor` CLI, installer) is
[`lib/env-fix.mjs`](../lib/env-fix.mjs). Do **not** import any
`lib/selfcheck/*.mjs` from outside the facade.

## 1. Architecture

```
┌─────────────────────────────────────────────────────────────┐
│ 3 entry points (all go through env-fix.mjs)                │
│   ① Adapter startup preflight (dsh-acp.mjs)                │
│   ② doctor CLI  (auditAll / --fix / --auto)                │
│   ③ install.ps1 / install.sh                                │
└──────────────────┬──────────────────────────────────────────┘
                   ↓
   lib/env-fix.mjs   ← single authoritative facade
                   ↓
   lib/selfcheck/    ← kernel
       index.mjs     orchestration: runChecks / auditAll / preflight / probeRuntimeMode
       audit.mjs     16 fixed checks + EXTRA_CHECKS registry
       repair.mjs    16 repair handlers + backup pipeline
       degrade.mjs   4 output formats (JSON / text / startup diag / summary)
       paths.mjs     single source: resolveRoots / vault / settings.yaml / agent-default-model
       platform.mjs  probes: dsh binary, version, spawn spec, HTTP gateway
       registry.mjs  package manager: npm/pnpm resolution + registry selection
       cross-config-sync.mjs  4 cross-config checks + 1 repair handler
```

## 2. The 16 fixed checks

`CHECK_META` in `lib/selfcheck/audit.mjs` defines the canonical set. The
order in `CHECK_ORDER` is **frozen** — external code must not reorder
or insert.

| ID | severity | fixable | Title |
|---|---|---|---|
| `OBSIDIAN_DATA_JSON_MISSING` | high | ✗ | Obsidian Agent Client not installed (no data.json) |
| `OBSIDIAN_CUSTOM_AGENT_MISSING` | high | ✓ | `customAgents` lacks the `dsh-acp` entry |
| `OBSIDIAN_CUSTOM_AGENT_MALFORMED` | high | ✓ | `dsh-acp` entry has wrong shape |
| `OBSIDIAN_VAULT_AMBIGUOUS` | medium | ✗ | Multiple Obsidian vaults; `--vault` required |
| `ZOD_MISSING` | high | ✓ | Peer dep missing (zod / ACP SDK) |
| `DSH_CLI_MISSING` | high | ✓ | No `dsh` CLI reachable for spawn |
| `DSH_SHIM_UNRESOLVABLE` | high | ✓ | `dsh` shim not resolvable to a spawnable form |
| `HEADLESS_PROFILE_MISSING` | high | ✓ | `headless` profile absent |
| `HEADLESS_PROFILE_INCOMPLETE` | high | ✓ | `headless` profile missing required files |
| `HEADLESS_MODEL_PROVIDER_UNAVAILABLE` | high | ✓ | `agent-default-model.provider` not in available list |
| `HEADLESS_VERSION_PIN_STALE` | medium | ✓ | Pinned `dsh-*` versions in profile disagree with runtime |
| `NPM_REGISTRY_UNREACHABLE` | medium | ✓ | All configured npm registries unreachable |
| `SELFCHECK_INTERNAL_ERROR` | medium | ✗ | Self-check itself errored |
| `GC_REPORT_ONLY_IGNORED` | high | ✓ | `DSH_ACP_GC_REPORT_ONLY` did not actually block deletion |
| `GC_DESTRUCTIVE_PATH_ACTIVE` | high | ✓ | Self-check / list path still performs deletion |
| `GC_REFERENCE_SET_UNAVAILABLE` | medium | ✗ | GC reference set unavailable (must skip cleanup) |

`ZOD_MISSING` is the only check in `BLOCKING_CODES` — without zod the
adapter process cannot run. Every other failure is downgraded to a
diagnostic and does **not** block the ACP handshake.

## 3. Pluggable extra checks (`cross-config-sync`)

`lib/selfcheck/cross-config-sync.mjs` registers four additional checks
via the `registerChecks(EXTRA_CHECKS)` mechanism. They are picked up
automatically by `auditAll` (the default behaviour is to run all
registered extras; pass `extraChecks: []` to disable).

| ID | severity | fixable | Title |
|---|---|---|---|
| `DSH_ACP_SETTINGS_YAML_MISSING` | high | ✓ | `~/.dsh/settings.yaml` missing (dropdown falls back to 4 hardcoded models) |
| `DSH_ACP_SETTINGS_CORDIS_DESYNC` | medium | ✓ | `settings.yaml` drifted from `cordis.patch.yml` |
| `DSH_ACP_PROVIDER_NAME_HYPHEN` | high | ✗ | `dsh-acp.mjs` still contains the literal `"jl-token"` |
| `DSH_DESKTOP_DEFAULT_MODEL_VALID` | medium | ✓ | `agent-default-model.provider` not in the `settings.yaml` provider list |

### 3.1 Why these four exist

`dsh-acp` reads from three independent configuration layers that do
**not** reference each other. Drifting any one of them produces a
visible symptom (missing models, NO_ADAPTER errors, dropdown
disagreements) that is hard to diagnose without checking all three.

| Layer | File | Reader |
|---|---|---|
| ① cordis | `profiles/<name>/cordis.patch.yml` | dsh Desktop UI / dsh web |
| ② settings.yaml | `~/.dsh/settings.yaml` | dsh-acp dropdown |
| ③ literals | `dsh-acp.mjs:198/444` | adapter startup fallback |

The four checks map directly onto the failure modes that bit us in
practice:

- **MISSING** — ② doesn't exist → dropdown silently reverts to the
  4-model `FALLBACK_MODELS` hardcoded list. The fix is to render ②
  from ① (`write-yaml-from-cordis`, idempotent).
- **DESYNC** — ① and ② disagree on which providers/models exist.
  Same fix as MISSING (re-render from ①).
- **HYPHEN** — ③ still has the old `"jl-token"` (with hyphen) literal
  even though the registered provider is `"jltoken"`. This produces
  `dsh: NO_ADAPTER for "jl-token"`. Marked `fixable: false` because
  the literal is spread across the `src/` and `installed/` copies of
  the adapter and must be patched in code.
- **VALID** — ①'s `agent-default-model.provider` is not in the set of
  providers that ② knows about. The fix is to align ①'s default to
  the first provider in ② (`align-default-model`).

## 4. Repair handlers

`registerRepairer(code, fn)` maps a check ID to a function that
returns a repair `Action` (or `planOnly` for advisory entries).
Repairs go through `lib/selfcheck/repair.mjs`'s standard pipeline:
**dry-run / fixture-escape detection / backup / idempotency**.

| Code | Action | Side effect | Backup |
|---|---|---|---|
| `OBSIDIAN_CUSTOM_AGENT_MISSING/MALFORMED` | write `data.json` `customAgents.dsh-acp` | Obsidian config | ✓ |
| `OBSIDIAN_DATA_JSON_MISSING` | plan-only (ask user to install Obsidian) | — | — |
| `OBSIDIAN_VAULT_AMBIGUOUS` | plan-only (require `--vault`) | — | — |
| `ZOD_MISSING` | `npm i zod` with `--registry`, only via `node+npm-cli` shapes | adapter `node_modules` | ✓ |
| `DSH_CLI_MISSING` | install dsh CLI (version resolved at runtime, never pinned) | global PATH | ✓ |
| `DSH_SHIM_UNRESOLVABLE` | resolve `.cmd` / `.ps1` shim to `{cmd,prefixArgs}` | remembered spawn spec only | — |
| `HEADLESS_PROFILE_MISSING` | `<dsh> plugin --profile headless add @deepseek-ai/dsh-headless` | dsh-runtimes | ✓ |
| `HEADLESS_PROFILE_INCOMPLETE` | fill in profile's required files | profile dir | ✓ |
| `HEADLESS_MODEL_PROVIDER_UNAVAILABLE` | align `agent-default-model.provider` to available list | `cordis.patch.yml` | ✓ |
| `HEADLESS_VERSION_PIN_STALE` | plan-only | — | — |
| `NPM_REGISTRY_UNREACHABLE` | fall back to mirror (`registry.npmmirror.com`) | detection result | — |
| `GC_*_IGNORED/ACTIVE` | plan-only (GC requires explicit `--gc --yes`) | — | — |
| `GC_REFERENCE_SET_UNAVAILABLE` | plan-only (must skip cleanup) | — | — |
| `SELFCHECK_INTERNAL_ERROR` | plan-only | — | — |
| `DSH_ACP_SETTINGS_YAML_MISSING/DESYNC` | render `settings.yaml` from `cordis.patch.yml` (idempotent) | `~/.dsh/settings.yaml` | ✓ |
| `DSH_DESKTOP_DEFAULT_MODEL_VALID` | align `agent-default-model.provider` to first known provider | `cordis.patch.yml` | ✓ |

## 5. Startup preflight (`preflightForStartup`)

```
preflightForStartup() → { ok, blocking, checks, findings, actions, backups, autoFixed, runtime }
```

- **Escape hatch**: `DSH_ACP_SELFCHECK=off` short-circuits to `ok: true`.
- **Fast mode**: `fast: true` (no network, no spawn probe).
- **Blocking gate**: only `ZOD_MISSING` is blocking.
- **Autofix**: `DSH_ACP_AUTOFIX=1` runs repair with `execute: true`.
  `DSH_ACP_AUTOFIX_INSTALL=1` (or any blocking failure) also enables
  external command execution. Timeout: `DSH_ACP_AUTOFIX_TIMEOUT_MS`
  (default 180000).
- **Re-verify after fix**: if any action was `applied`, `ctx.bust()` is
  called and `runChecks` re-runs against fresh state.

## 6. GC safety gate (zero side effects by default)

```
runGcIfExplicitlyEnabled({ clean, reportOnly, env, log, ctx })
gcGateSummary(env) → { gcDisabled, reportOnly, cleanEnvSwitch }
gcStatus(ctx)        → read-only probe (never deletes)
```

Three conditions must all be met before cleanup runs:

1. Explicit user opt-in: `--gc --yes` **or** `DSH_ACP_GC_CLEAN=1`.
2. Reference set available (Obsidian sessions dir contains live ids).
3. `DSH_ACP_GC !== "off"`.

If any condition fails, cleanup is **skipped** and the report shows
`{ referenceSetAvailable: false, orphanCandidates: [...] }` for triage.

## 7. Runtime mode probe

```
probeRuntimeMode(ctx) → { mode: "proxy" | "spawn", reason, baseUrl? }
```

- Source of truth is `lib/proxy-mode.mjs` (`shouldAttemptProxy` /
  `getProxyBaseUrl`).
- The HTTP probe uses `probeGateway` (unref'd timer + response body
  drain) to avoid libuv `0xC0000409` on Windows.
- **Spawn is a normal fallback, never an error** (R-16).
- Registered as pending work; `awaitPending()` drains before CLI exit.

## 8. CLI verbs

`registerVerb(name, { run, consumesModel, checks, description })`
registers a non-default verb. The default contract: `consumesModel:
false` — the self-check path must never burn model quota.

- **Built-in**: `install-deps` (only `node+npm-cli` / `npm.cmd` /
  `node+pnpm.mjs` shapes, always with `--registry`, requires `--yes`).
- **Convention**: `verify-*` / `e2e-*` (t11) live here.

## 9. Output formats

```
formatJson(report)              // JSON mode
formatText(report, opts)        // human-readable text
formatStartupDiagnosis(report)  // blocking diagnostic (adapter startup)
formatStartupSummary(report)    // compact summary (adapter startup)
formatReport(report, o)         // single exit; routes by o.json
```

Report fields: `root / runtime / checks / findings / actions / plan /
backups / gc / nextSteps / durationMs / error`.

## 10. Exit codes

```
exitCodeFor(report) → 0 | 1 | 2
  0  no fail/warn
  1  has fail/warn
  2  argument / self-error / FIXTURE_ESCAPE
```

## 11. Safety properties

- **Zero side effects by default**: `report` mode is read-only.
- **Fixture root escape detection**: writes outside the `--root`
  inject boundary → `FIXTURE_ESCAPE` → zero actions in the batch.
- **Backups first**: every write auto-backs-up to `<file>.bak.<ts>`;
  recorded in `report.backups`.
- **No bare `npm` / `pnpm`**: Windows execution policy blocks
  `npm.ps1`, so installers are forced through `node <script>` shapes.
- **DROP-IN compat layer**: `env-fix.mjs` re-exports 9 legacy APIs so
  older `doctor.mjs` consumers continue to work without touching the
  `selfcheck/` internals directly.
- **Single-facade invariant**: the three entry points must not call
  each other or implement their own probes (01 §4.4).

## 12. Extending: adding a new check

```js
// In your new module (e.g. lib/selfcheck/my-check.mjs):
import { registerChecks, registerRepairer } from "./audit.mjs";

const MY_CHECKS = [{
  id: "MY_NEW_CHECK",
  severity: "high",     // "high" | "medium" | "low"
  fixable: true,
  title: "Short human-readable title",
  run: async (ctx) => { /* return { status, detail, evidence?, action? } */ },
}];

registerChecks(MY_CHECKS);
registerRepairer("MY_NEW_CHECK", async (check, ctx) => {
  // return a plan / apply Action
});
```

Import your module once for the side effect, from `env-fix.mjs` so the
single-facade invariant holds:

```js
// lib/env-fix.mjs
import "./selfcheck/my-check.mjs";
```

The next time `auditAll` runs (in any of the three entry points), your
check will be picked up automatically.
