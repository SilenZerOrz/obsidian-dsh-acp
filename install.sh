#!/usr/bin/env bash
# ============================================================================
# install.sh — one-click installer for @silenzororz/obsidian-dsh-acp
# ============================================================================
# Installs the obsidian-dsh-acp plugin into a DSH profile (official
# `dsh plugin add` path) and wires an Obsidian "Agent Client" custom agent to
# the shipped ACP server, optionally with tuned environment config.
#
# Safe by default:
#   - idempotent (rerunning is a no-op when already configured)
#   - every write is backed up before it happens
#   - --dry-run previews every step without touching anything
#   - --uninstall removes what this script added and restores backups
#
# Usage:
#   ./install.sh [options]
#
# Options:
#   --profile <name>        DSH profile to install into      (default: web)
#   --dsh-home <dir>        DSH data root                    (default: $DSH_HOME or ~/.dsh)
#   --obsidian-vault <dir>  any Obsidian vault to wire into  (required for Obsidian step)
#   --package <src>         plugin source: <tgz path> | <npm name> | link:<dir>
#   --node-bin <path>       node binary to reference in the custom agent
#   --profile-env           also write recommended env into the DSH profile config
#   --no-obsidian           skip the Obsidian wiring step
#   --dry-run               preview only; change nothing
#   --uninstall             remove what install.sh added and restore backups
#   --verbose               print extra detail
#   -h, --help              show this help
# ============================================================================
set -uo pipefail

# ---- config defaults ------------------------------------------------------
PROFILE="${DSH_ACP_PROFILE:-web}"
DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
OBSIDIAN_VAULT=""
PACKAGE_SRC=""
NODE_BIN=""
WRITE_PROFILE_ENV=0
NO_OBSIDIAN=0
DRY_RUN=0
UNINSTALL=0
VERBOSE=0

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TIMESTAMP="$(date +%Y%m%d-%H%M%S)"
BACKUP_DIR="${DSH_ACP_BACKUP_DIR:-${SCRIPT_DIR}/.install-backups/${TIMESTAMP}}"

# ---- helpers --------------------------------------------------------------
info()  { printf '\033[32m[install]\033[0m %s\n' "$*"; }
warn()  { printf '\033[33m[install:warning]\033[0m %s\n' "$*" >&2; }
fail()  { printf '\033[31m[install:error]\033[0m %s\n' "$*" >&2; exit 1; }
vlog()  { [ "$VERBOSE" = "1" ] && printf '[debug] %s\n' "$*" || true; }
say()   { [ "$DRY_RUN" = "1" ] && printf '\033[36m[dry-run]\033[0m %s\n' "$*" || info "$*"; }

# use_dry <do_cmd...>: run only if not dry-run
use_dry() {
  if [ "$DRY_RUN" = "1" ]; then
    say "would run: $*"
    return 0
  fi
  "$@"
}

usage() {
  sed -n '2,45p' "$0" | sed 's/^# \{0,1\}//'
  exit 0
}

# ---- parse args -----------------------------------------------------------
while [ "$#" -gt 0 ]; do
  case "$1" in
    --profile)      PROFILE="${2:?}"; shift 2;;
    --dsh-home)     DSH_HOME="${2:?}"; shift 2;;
    --obsidian-vault) OBSIDIAN_VAULT="${2:?}"; shift 2;;
    --package)      PACKAGE_SRC="${2:?}"; shift 2;;
    --node-bin)     NODE_BIN="${2:?}"; shift 2;;
    --profile-env)  WRITE_PROFILE_ENV=1; shift;;
    --no-obsidian)  NO_OBSIDIAN=1; shift;;
    --dry-run)      DRY_RUN=1; shift;;
    --uninstall)    UNINSTALL=1; shift;;
    --verbose)      VERBOSE=1; shift;;
    -h|--help)      usage;;
    *) fail "unknown option: $1 (see --help)";;
  esac
done

(: "${DSH_HOME:?}")
AUTHORS_NAME="obsidian-dsh-acp"
PLUGIN_ID="dsh-acp"

# ============================================================================
# STEP 0 — environment detection & sanity
# ============================================================================
echo "──────────────────────────────────────────────────────────────"
info "obsidian-dsh-acp installer"
echo "  profile      : ${PROFILE}"
echo "  dsh-home     : ${DSH_HOME}"
echo "  obsidian vault: ${OBSIDIAN_VAULT:-<not set>}"
echo "  package src  : ${PACKAGE_SRC:-<auto>}"
[ "$DRY_RUN" = "1" ] && echo "  MODE         : DRY-RUN (no changes)"

if [ "$UNINSTALL" = "1" ]; then
  echo ""
  info "UNINSTALL mode"
  [ -d "$SCRIPT_DIR/.install-backups" ] || fail "no backups found at $SCRIPT_DIR/.install-backups"
  newest="$(ls -1d "$SCRIPT_DIR/.install-backups"/*/ 2>/dev/null | sort | tail -1)"
  [ -n "$newest" ] || fail "no backup snapshots to restore from"
  info "restoring snapshot: $newest"
  # restore obsidian data.json
  for djson in "$newest"/*obsidian-data.json; do
    [ -f "$djson" ] || continue
    target="${djson%.obsidian-data.json}.json"
    say "restore "$target" from backup"
    use_dry cp "$djson" "$target"
  done
  info "uninstall: remove dsh-acp plugin from profile? Re-run without --uninstall if you meant to keep it."
  echo ""
  info "backups/artifacts remain at $newest (delete manually to fully remove)."
  echo "──────────────────────────────────────────────────────────────"
  exit 0
fi

# node
NODE_BIN="${NODE_BIN:-$(command -v node || true)}"
if [ -z "${NODE_BIN}" ] || [ ! -x "${NODE_BIN}" ]; then
  fail "node not found. Pass --node-bin <path> or install Node.js >= 22.13"
fi
vlog "node: ${NODE_BIN} ($("${NODE_BIN}" -v 2>/dev/null))"

# dsh
DSH_BIN="${DSH_BIN:-$(command -v dsh || true)}"
if [ -z "${DSH_BIN}" ] && [ -x "${DSH_HOME}/bin/dsh" ]; then
  DSH_BIN="${DSH_HOME}/bin/dsh"
fi
[ -n "${DSH_BIN}" ] || warn "dsh not found on PATH; will still prepare Obsidian wiring but DSH plugin step is skipped."

# obsidian vault switch
if [ "$NO_OBSIDIAN" = "1" ]; then
  OBSIDIAN_VAULT=""
elif [ -n "${OBSIDIAN_VAULT}" ]; then
  [ -d "${OBSIDIAN_VAULT}/.obsidian/plugins/agent-client" ] \
    || warn "vault at '${OBSIDIAN_VAULT}' has no agent-client plugin dir — Configure the Agent Client plugin first."
fi

# ============================================================================
# STEP 1 — install plugin into DSH profile (official path)
# ============================================================================
if [ -n "${DSH_BIN}" ]; then
  echo ""
  echo "──────────────────────────────────────────────────────────────"
  info "STEP 1/4 — install plugin into DSH profile '${PROFILE}'"

  # resolve package source
  PKG_ARG="$PACKAGE_SRC"
  if [ -z "$PKG_ARG" ]; then
    # auto: prefer a local tarball next to this script, else the local dir, else npm name
    if [ -f "${SCRIPT_DIR}/${AUTHORS_NAME}-"*.tgz ]; then
      PKG_ARG="$(ls "${SCRIPT_DIR}"/"${AUTHORS_NAME}"-*.tgz | head -1)"
      vlog "auto package source: ${PKG_ARG}"
    elif [ -f "${SCRIPT_DIR}/package.json" ]; then
      PKG_ARG="link:${SCRIPT_DIR}"
      vlog "auto package source: ${PKG_ARG} (local checkout)"
    else
      PKG_ARG="$AUTHORS_NAME"
      vlog "auto package source: ${PKG_ARG} (npm registry)"
    fi
  fi

  say "dsh plugin --profile '${PROFILE}' add '${PKG_ARG}'"
  if [ "$DRY_RUN" != "1" ] && [ -n "$PKG_ARG" ]; then
    if ! "${DSH_BIN}" plugin --profile "${PROFILE}" add "${PKG_ARG}" 2>&1; then
      warn "dsh plugin add reported a non-zero exit; continuing to inspect config tree (see ^ error)."
    fi
  fi

  # verify registration via dump-config
  echo ""
  info "verify plugin registration (dump-config)"
  if [ "$DRY_RUN" = "1" ]; then
    say "would verify '${PLUGIN_ID}' present in: dsh --profile '${PROFILE}' --dump-config"
  else
    if "${DSH_BIN}" --profile "${PROFILE}" --dump-config 2>/dev/null | grep -q "${PLUGIN_ID}"; then
      info "OK: plugin entry '${PLUGIN_ID}' found in profile config tree"
    else
      warn "plugin entry '${PLUGIN_ID}' not found in dump-config yet. If you just added it, a profile reload may be needed."
    fi
  fi
fi

# ============================================================================
# STEP 2 — recommended environment config (optional, --profile-env)
# ============================================================================
if [ "$WRITE_PROFILE_ENV" = "1" ] && [ -n "${DSH_BIN}" ]; then
  echo ""
  echo "──────────────────────────────────────────────────────────────"
  info "STEP 2/4 — recommended env for the adapter"
  cat <<ENVEOF
  Set these for the spawned `dsh --profile ${PROFILE}` process as needed:
    DSH_BIN               path to the dsh executable  (default: dsh on PATH)
    DSH_PROFILE           ${PROFILE}
    DSH_ACP_LOG_DIR       directory for a runtime log (optional)
    DSH_ACP_STORE_DIR     directory for the session JSON index (default ~/.dsh-acp)
    DSH_ACP_ARCHIVE_IN_MAIN=1  (optional) place turn archives under sessions/
ENVEOF
fi

# ============================================================================
# STEP 3 — wire Obsidian Agent Client custom agent
# ============================================================================
if [ "$NO_OBSIDIAN" != "1" ] && [ -n "${OBSIDIAN_VAULT}" ]; then
  echo ""
  echo "──────────────────────────────────────────────────────────────"
  info "STEP 3/4 — wire Obsidian custom agent"

  ADAPTER="${SCRIPT_DIR}/dsh-acp.mjs"
  if [ ! -f "$ADAPTER" ]; then
    # maybe installed into node_modules earlier
    ADAPTER="${SCRIPT_DIR}/archive-store.mjs" && ADAPTER="${SCRIPT_DIR%/*}/dsh-acp.mjs"
  fi
  [ -f "$ADAPTER" ] || ADAPTER="${PACKAGE_SRC}"

  target="${OBSIDIAN_VAULT}/.obsidian/plugins/agent-client/data.json"
  [ -f "$target" ] || { warn "data.json not found at $target; Agent Client not installed in this vault yet."; exit 0; }

  say "backing up ${target}"
  if [ "$DRY_RUN" = "1" ]; then
    say "  (would copy to ${BACKUP_DIR}/<name>.obsidian-data.json)"
  else
    mkdir -p "${BACKUP_DIR}"
    cp "$target" "${BACKUP_DIR}/$(basename "$target").obsidian-data.json"
    vlog "backup -> ${BACKUP_DIR}/$(basename "$target").obsidian-data.json"
  fi

  # Build a small node snippet that updates the customAgents entry.
  NODE_CMD='const fs=require("fs");const p=process.argv[1];const adapter=process.argv[2];const node=process.argv[3];
let d=JSON.parse(fs.readFileSync(p,"utf8"));d.customAgents=d.customAgents||[];
const old=(d.customAgents||[]).findIndex(a=>a.id==="dsh-acp");
const entry={id:"dsh-acp",displayName:"DeepSeek Harness (ACP)",command:adapter,args:[],env:[],enabled:true};
if(old>=0){d.customAgents[old]=entry}else{d.customAgents.push(entry)}
fs.writeFileSync(p,JSON.stringify(d,null,2));console.log("written",p)'
  say "adding/updating customAgents[].{id:'dsh-acp'} command=${ADAPTER}"
  if [ "$DRY_RUN" = "1" ]; then
    say "  (would update data.json with the custom agent)"
  else
    if ! "${NODE_BIN}" -e "$NODE_CMD" "$target" "$ADAPTER" "$NODE_BIN"; then
      warn "failed to update ${target}; it was backed up — review manually"
    else
      info "OK: custom agent 'dsh-acp' configured -> ${ADAPTER}"
    fi
  fi
else
  echo ""
  echo "──────────────────────────────────────────────────────────────"
  info "STEP 3/4 — Obsidian wiring skipped"
  [ "$NO_OBSIDIAN" = "1" ] && info "  (--no-obsidian)" || warn "  (no --obsidian-vault given; pass it to enable)"
fi

# ============================================================================
# STEP 4 — summary & next steps
# ============================================================================
echo ""
echo "──────────────────────────────────────────────────────────────"
info "STEP 4/4 — done"
if [ "$DRY_RUN" = "1" ]; then
  info "This was a DRY-RUN. Nothing was changed."
else
  [ -d "$BACKUP_DIR" ] && info "backups: ${BACKUP_DIR}"
fi
cat <<NEXT
  Next steps in Obsidian:
    1. Reload the vault (Cmd-R or restart Obsidian).
    2. Open the Agent Client plugin and pick the custom agent
       "DeepSeek Harness (ACP)".
  DSH:
    - If the plugin wasn't active yet, restart \`dsh web\` once.
  Re-run ./install.sh any time; it is idempotent.
NEXT
echo "──────────────────────────────────────────────────────────────"
