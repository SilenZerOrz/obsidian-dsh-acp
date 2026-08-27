#!/usr/bin/env bash
# ============================================================================
# install.sh — one-click installer for obsidian-dsh-acp
# ============================================================================
# Installs the obsidian-dsh-acp plugin into a DSH profile via the official
# `dsh plugin add` path and wires an Obsidian "Agent Client" custom agent to the
# ACP server that pnpm installs inside that profile, where its dependencies
# (e.g. @agentclientprotocol/sdk) are already resolved. No file copying.
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
#   --node-bin <path>       node binary used for the JSON edit + verification
#   --profile-env           print recommended adapter env
#   --no-obsidian           skip the Obsidian wiring step
#   --dry-run               preview only; change nothing
#   --uninstall             restore backups and remove config this script added
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

PKG_NAME="obsidian-dsh-acp"
PLUGIN_ID="dsh-acp"
ADAPTER_NAME="dsh-acp.mjs"

# ---- helpers --------------------------------------------------------------
info()  { printf '\033[32m[install]\033[0m %s\n' "$*"; }
warn()  { printf '\033[33m[install:warning]\033[0m %s\n' "$*" >&2; }
fail()  { printf '\033[31m[install:error]\033[0m %s\n' "$*" >&2; exit 1; }
vlog()  { [ "$VERBOSE" = "1" ] && printf '[debug] %s\n' "$*" || true; }
say()   { [ "$DRY_RUN" = "1" ] && printf '\033[36m[dry-run]\033[0m %s\n' "$*" || info "$*"; }

# use_dry <do_cmd...>: run only if not dry-run (defined before uninstall uses it)
use_dry() {
  if [ "$DRY_RUN" = "1" ]; then say "would run: $*"; return 0; fi
  "$@"
}

usage() {
  sed -n '1,44p' "$0" | sed 's/^# \{0,1\}//' | sed -n '/Usage:/,$p'
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

# ============================================================================
# STEP 0 — environment detection & sanity
# ============================================================================
echo "──────────────────────────────────────────────────────────────"
info "${PKG_NAME} installer"
echo "  profile        : ${PROFILE}"
echo "  dsh-home       : ${DSH_HOME}"
echo "  obsidian vault : ${OBSIDIAN_VAULT:-<not set>}"
echo "  package src    : ${PACKAGE_SRC:-<auto>}"
[ "$DRY_RUN" = "1" ] && echo "  MODE           : DRY-RUN (no changes)"

# ---- uninstall ------------------------------------------------------------
if [ "$UNINSTALL" = "1" ]; then
  echo ""
  info "UNINSTALL mode"
  newest="$(ls -1d "${SCRIPT_DIR}/.install-backups"/*/ 2>/dev/null | sort | tail -1)"
  [ -n "$newest" ] || fail "no backup snapshot to restore"
  info "restoring snapshot: $newest"
  for djson in "$newest"/*obsidian-data.json; do
    [ -f "$djson" ] || continue
    target="${djson%.obsidian-data.json}.json"
    say "restore $target from backup"
    use_dry cp "$djson" "$target"
  done
  echo ""
  echo "──────────────────────────────────────────────────────────────"
  exit 0
fi

# ---- node -----------------------------------------------------------------
NODE_BIN="${NODE_BIN:-$(command -v node || true)}"
if [ -z "${NODE_BIN}" ] || [ ! -x "${NODE_BIN}" ]; then
  fail "node not found. Install Node.js >= 22.13 or pass --node-bin <path>."
fi
vlog "node: ${NODE_BIN} ($("${NODE_BIN}" -v 2>/dev/null))"

# ---- dsh ------------------------------------------------------------------
DSH_BIN="${DSH_BIN:-$(command -v dsh || true)}"
if [ -z "${DSH_BIN}" ] && [ -x "${DSH_HOME}/bin/dsh" ]; then DSH_BIN="${DSH_HOME}/bin/dsh"; fi
[ -n "${DSH_BIN}" ] || warn "dsh not found on PATH; DSH plugin step will be skipped (Obsidian wiring still attempted)."

# ============================================================================
# STEP 1 — install the plugin into the DSH profile (official path)
# ============================================================================
ADAPTER=""   # absolute path to the installed dsh-acp.mjs (after STEP 1+2)
if [ -n "${DSH_BIN}" ]; then
  echo ""
  echo "──────────────────────────────────────────────────────────────"
  info "STEP 1/3 — install plugin into DSH profile '${PROFILE}'"

  PKG_ARG="$PACKAGE_SRC"
  if [ -z "$PKG_ARG" ]; then
    if [ -f "${SCRIPT_DIR}/${PKG_NAME}-"*.tgz ]; then
      PKG_ARG="$(ls "${SCRIPT_DIR}"/"${PKG_NAME}"-*.tgz | head -1)"
    elif [ -f "${SCRIPT_DIR}/package.json" ]; then
      PKG_ARG="link:${SCRIPT_DIR}"
    else
      PKG_ARG="$PKG_NAME"
    fi
    vlog "auto package source: ${PKG_ARG}"
  fi

  say "dsh plugin --profile '${PROFILE}' add '${PKG_ARG}'"
  if [ "$DRY_RUN" != "1" ] && [ -n "$PKG_ARG" ]; then
    if ! "${DSH_BIN}" plugin --profile "${PROFILE}" add "${PKG_ARG}" 2>&1; then
      warn "dsh plugin add reported non-zero exit; continuing (see error above)."
    fi
  fi
fi

# ============================================================================
# STEP 2 — locate the installed adapter (dependencies are already resolved)
# ============================================================================
echo ""
echo "──────────────────────────────────────────────────────────────"
info "STEP 2/3 — locate installed adapter"
PROFILE_PKG_DIR="${DSH_HOME}/profiles/${PROFILE}/node_modules/${PKG_NAME}"
CAND="${PROFILE_PKG_DIR}/${ADAPTER_NAME}"

[ -f "$CAND" ] && ADAPTER="$CAND"

if [ -z "$ADAPTER" ]; then
  if [ "$DRY_RUN" = "1" ]; then
    say "  (would locate ${CAND})"
    ADAPTER="$CAND"
  else
    warn "adapter not found at ${CAND}. Was STEP 1 run? (no 'dsh' found, or package didn't install there)"
  fi
fi

if [ -n "$ADAPTER" ] && [ -f "$ADAPTER" ]; then
  if [ ! -x "$ADAPTER" ]; then
    warn "adapter is not executable: ${ADAPTER}"
    if [ "$DRY_RUN" != "1" ]; then
      chmod +x "$ADAPTER" 2>/dev/null && info "  fixed: chmod +x"
      warn "  Obsidian spawns the command directly (no 'node' prefix), so it must be executable."
    fi
  fi
  info "OK: adapter at ${ADAPTER} ($(ls -l "$ADAPTER" | awk '{print $1}'))"
fi

# ============================================================================
# STEP 3 — wire Obsidian Agent Client custom agent (points at installed adapter)
# ============================================================================
if [ "$NO_OBSIDIAN" != "1" ] && [ -n "${OBSIDIAN_VAULT}" ]; then
  echo ""
  echo "──────────────────────────────────────────────────────────────"
  info "STEP 3/3 — wire Obsidian custom agent"

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

  NODE_CMD='const fs=require("fs");const p=process.argv[1];const adapter=process.argv[2];
let d=JSON.parse(fs.readFileSync(p,"utf8"));d.customAgents=d.customAgents||[];
const i=d.customAgents.findIndex(a=>a&&a.id==="dsh-acp");
const e={id:"dsh-acp",displayName:"DeepSeek Harness (ACP)",command:adapter,args:[],env:[],enabled:true};
if(i>=0){d.customAgents[i]=e}else{d.customAgents.push(e)}
fs.writeFileSync(p,JSON.stringify(d,null,2));console.log("written")'

  say "adding/updating customAgents[].{id:'dsh-acp'} command=${ADAPTER}"
  if [ "$DRY_RUN" = "1" ]; then
    say "  (would update data.json)"
  else
    if [ -z "$ADAPTER" ]; then
      warn "no adapter path resolved; not writing Obsidian config (run STEP 1 first)."
    else
      if ! "${NODE_BIN}" -e "$NODE_CMD" "$target" "$ADAPTER"; then
        warn "failed to update ${target}; it was backed up — review manually"
      else
        info "OK: custom agent 'dsh-acp' -> ${ADAPTER}"
      fi
    fi
  fi
else
  echo ""
  echo "──────────────────────────────────────────────────────────────"
  info "STEP 3/3 — Obsidian wiring skipped"
  [ "$NO_OBSIDIAN" = "1" ] && info "  (--no-obsidian)" || warn "  (no --obsidian-vault given; pass it to enable)"
fi

# ============================================================================
# Summary
# ============================================================================
echo ""
echo "──────────────────────────────────────────────────────────────"
info "done"
if [ "$DRY_RUN" = "1" ]; then
  info "This was a DRY-RUN. Nothing was changed."
else
  [ -d "$BACKUP_DIR" ] && info "backups: ${BACKUP_DIR}"
fi
if [ "${WRITE_PROFILE_ENV}" = "1" ]; then
  echo "  Recommended env: DSH_BIN / DSH_PROFILE=${PROFILE} / DSH_ACP_LOG_DIR / DSH_ACP_STORE_DIR"
fi
cat <<NEXT
  Next steps in Obsidian:
    1. Reload the vault (Cmd-R or restart Obsidian).
    2. Open Agent Client and pick "DeepSeek Harness (ACP)".
  DSH:
    - If the plugin wasn't active, restart \`dsh web\` once.
  Re-run ./install.sh any time; it is idempotent.
NEXT
echo "──────────────────────────────────────────────────────────────"
