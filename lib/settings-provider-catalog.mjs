// settings-provider-catalog.mjs
//
// FE-1 (model provider switching): enumerate the model providers dsh has
// configured, from the HEADLESS SPAWN adapter process (which has no cordis
// `ctx.llm` — that is only available to the in-process long-runtime on the
// web profile).
//
// Source of truth: `~/.dsh/settings.yaml` (`llm-pi-ai.providers.<name>.models`).
// Reading that exact subtree is lighter and more faithful for the dropdown
// than `dsh --dump-config` (which prints only the composed bundle skeleton,
// not the user settings layer that holds the concrete provider models).
//
// We deliberately parse ONLY the `llm-pi-ai.providers` subtree with a tiny
// indentation-based scanner, instead of depending on a full `yaml` package.
// The adapter keeps its zero-dependency posture so it runs anywhere Obsidian
// spawns it, and the provider subtree has a fixed, regular shape.
//
// If settings.yaml is missing, unreadable, or the subtree cannot be found, we
// return an empty catalog and the caller falls back to DSH_ACP_MODELS /
// DEFAULT_MODELS — so a provider-less environment never breaks the dropdown.

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Resolve the dsh settings.yaml path, honouring DSH_HOME like dsh-acp.mjs. */
export function settingsYamlPath(env = process.env) {
  // DSH_HOME already points at the `.dsh` dir itself; when unset default to ~/.dsh.
  const home = (env.DSH_HOME && env.DSH_HOME.trim()) || join(homedir(), ".dsh");
  return join(home, "settings.yaml");
}

/** Non-blank, non-comment rows as `{ indent, content }`. */
function cleanRows(text) {
  const rows = [];
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (t === "") continue;
    if (t.startsWith("#")) continue;
    rows.push({ indent: line.length - line.trimStart().length, content: t });
  }
  return rows;
}

/**
 * One-level scan: return the direct child rows of the block that starts at
 * `start` (owner row at `ownerIndent`), i.e. every row from `start` up to the
 * first row whose indent <= `ownerIndent`. Returns the sub-array (the block's
 * first-level lines including nested content) plus the exclusive end index.
 */
function blockRange(rows, start, ownerIndent) {
  let end = start;
  while (end < rows.length && rows[end].indent > ownerIndent) end++;
  return { slice: rows.slice(start, end), end };
}

/** Within `slice` (all > ownerIndent), find a row whose content is `key:` at the block's own indent. */
function findChild(slice, ownerIndent, key) {
  for (let i = 0; i < slice.length; i++) {
    const r = slice[i];
    // A direct child sits exactly one level below the owner and reads `key:`.
    if (r.indent <= ownerIndent) break; // block ended
    const m = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(r.content);
    if (m && m[1] === key) return { row: r, index: i };
  }
  return null;
}

/** For `- id: X` / `- name: Y` map items: parse `- key: value` too. */
function parseDashItem(content) {
  // content starts with "- "
  const rest = content.slice(2);
  const m = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(rest);
  if (m) return { key: m[1], value: m[2] };
  return { key: null, value: rest };
}

/** 一个块内第一层缩进（= 最小缩进）。空块返回 -1。 */
function firstLevelIndent(slice) {
  let min = Infinity;
  for (const r of slice) if (r.indent < min) min = r.indent;
  return min === Infinity ? -1 : min;
}

/** 在 slice 里按 `key:` 找行（不限固定缩进，取首次出现）。 */
function findKeyRow(slice, key) {
  for (let i = 0; i < slice.length; i++) {
    const m = /^([A-Za-z0-9_-]+):\s*$/.exec(slice[i].content);
    if (m && m[1] === key) return { row: slice[i], index: i };
  }
  return null;
}

function tryRead(p) {
  try { return readFileSync(p, "utf8"); } catch { return null; }
}

/**
 * Parse the `llm-pi-ai.providers.<name>.models[].id/name` subtree.
 *
 * Supports BOTH loader-patch entry forms (relative indentation, not fixed):
 *   (a) nested key:  `llm-pi-ai:` + `providers:`
 *   (b) list item:   `- id: llm-pi-ai` + `config:` + `providers:`  (real profile)
 *
 * Returns `[{ provider, model, name }]`; `name` is the human label combining
 * the provider displayName (when present) and the model name.
 */
export function parseProviderCatalog(text) {
  const rows = cleanRows(text);
  if (rows.length === 0) return [];

  // ---- 1. llm-pi-ai owner (nested key OR list item) ----
  let ownerIdx = -1;
  let ownerIndent = -1;
  for (let i = 0; i < rows.length; i++) {
    if (/^llm-pi-ai:\s*$/.test(rows[i].content) || /^-\s*id:\s*llm-pi-ai\s*$/.test(rows[i].content)) {
      ownerIdx = i;
      ownerIndent = rows[i].indent;
      break;
    }
  }
  if (ownerIdx < 0) return [];

  const piBlock = blockRange(rows, ownerIdx + 1, ownerIndent);

  // ---- 2. `providers:` anywhere inside the llm-pi-ai block ----
  const provNode = findKeyRow(piBlock.slice, "providers");
  if (!provNode) return [];
  const providersIndent = provNode.row.indent;
  const provBlock = blockRange(piBlock.slice, provNode.index + 1, providersIndent);

  // ---- 3. each `<provider>:` at the block's first level ----
  const providerIndent = firstLevelIndent(provBlock.slice);
  if (providerIndent < 0) return [];

  const catalog = [];
  let i = 0;
  while (i < provBlock.slice.length) {
    const r = provBlock.slice[i];
    if (r.indent !== providerIndent) { i++; continue; }
    const pm = /^([A-Za-z0-9_-]+):\s*$/.exec(r.content);
    if (!pm) { i++; continue; }
    const provider = pm[1];
    const pBlock = blockRange(provBlock.slice, i + 1, providerIndent);
    i = pBlock.end;

    const childIndent = firstLevelIndent(pBlock.slice);
    if (childIndent < 0) continue;

    let displayName = provider;
    const disp = pBlock.slice.find((x) => x.indent === childIndent && /^displayName:\s*/.test(x.content));
    if (disp) displayName = disp.content.slice("displayName:".length).trim() || provider;

    const modelsRow = pBlock.slice.find((x) => x.indent === childIndent && /^models:\s*$/.test(x.content));
    if (!modelsRow) continue;
    const modelsIdx = pBlock.slice.indexOf(modelsRow);
    const modelsBlock = blockRange(pBlock.slice, modelsIdx + 1, childIndent);

    for (let j = 0; j < modelsBlock.slice.length; j++) {
      const mr = modelsBlock.slice[j];
      if (!mr.content.startsWith("- ")) continue;
      const item = parseDashItem(mr.content);
      if (item.key !== "id") continue;
      const model = item.value.trim();
      if (!model) continue;
      // look one row ahead for the item's `name:` (with or without leading `- `)
      let name = model;
      const next = modelsBlock.slice[j + 1];
      if (next) {
        const nm = /^(?:-\s*)?name:\s*(.*)$/.exec(next.content);
        if (nm) name = nm[1].trim() || model;
      }
      catalog.push({ provider, model, name: `${displayName} · ${name}` });
    }
  }
  return catalog;
}

/**
 * Read the on-disk provider catalog with a multi-level fallback:
 *   1. <profileDir>/cordis.patch.yml  (primary — same source as dsh web UI)
 *   2. <profileDir>/settings.yaml     (legacy compatibility)
 *   3. <dshHome>/settings.yaml        (global legacy)
 *   4. [] → caller falls back to FALLBACK_MODELS
 *
 * profileDir = <DSH_HOME|~/.dsh>/profiles/<DSH_PROFILE|web>.
 * Rationale: dsh consumes/renames a stray `~/.dsh/settings.yaml` at boot
 * (`@deepseek-ai/dsh-settings` → `.imported`), so it is NOT a durable source.
 * `cordis.patch.yml` is what dsh web actually loads.
 */
export function loadProviderCatalog(env = process.env) {
  const dshHome = (env.DSH_HOME && env.DSH_HOME.trim()) || join(homedir(), ".dsh");
  const profileName = (env.DSH_PROFILE && env.DSH_PROFILE.trim()) || "web";
  const profileDir = join(dshHome, "profiles", profileName);

  for (const p of [
    join(profileDir, "cordis.patch.yml"),
    join(profileDir, "settings.yaml"),
    join(dshHome, "settings.yaml"),
  ]) {
    const text = tryRead(p);
    if (!text) continue;
    const catalog = parseProviderCatalog(text);
    if (catalog.length > 0) return catalog;
  }
  return [];
}
