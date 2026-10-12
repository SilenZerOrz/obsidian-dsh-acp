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

/**
 * Parse the `llm-pi-ai.providers.<name>.models[].id/name` subtree.
 *
 * Layout we scan (indent levels, 2-space):
 *   0 llm-pi-ai:
 *   2   providers:
 *   4     <provider>:
 *   6       displayName: ...
 *   6       models:
 *   8         - id: ModelA
 *   8           name: ModelA
 *
 * Returns `[{ provider, model, name }]`; `name` is the human label combining
 * the provider displayName (when present) and the model name.
 */
export function parseProviderCatalog(text) {
  const rows = cleanRows(text);
  if (rows.length === 0) return [];

  // ---- 1. `llm-pi-ai:` at top level (indent 0) ----
  let pi = findChild(rows, -1, "llm-pi-ai");
  if (!pi) return [];
  const piBlock = blockRange(rows, pi.index + 1, 0); // owner indent 0

  // ---- 2. `providers:` as a direct child of llm-pi-ai (indent 2) ----
  const providersNode = findChild(piBlock.slice, 0, "providers");
  if (!providersNode) return [];
  // provider list block starts after the `providers:` row.
  const provBlock = blockRange(piBlock.slice, providersNode.index + 1, 2); // owner indent 2

  // ---- 3. each `<provider>:` entry (indent 4) ----
  const catalog = [];
  // Walk `provBlock` splitting at each row whose indent == 4 (a provider).
  let i = 0;
  while (i < provBlock.slice.length) {
    const r = provBlock.slice[i];
    const pm = /^([A-Za-z0-9_-]+):\s*$/.exec(r.content);
    if (!pm || r.indent !== 4) {
      i++;
      continue;
    }
    const provider = pm[1];
    const pBlock = blockRange(provBlock.slice, i + 1, 4); // owner indent 4
    i = pBlock.end; // skip consumed

    if (pBlock.slice.length === 0) continue;
    const disp = findChild(pBlock.slice, 4, "displayName");
    const displayName =
      disp && disp.row.indent === 6 ? disp.row.content.slice("displayName:".length).trim() : provider;

    const modelsNode = findChild(pBlock.slice, 4, "models");
    if (!modelsNode || modelsNode.row.indent !== 6) continue;
    const modelsBlock = blockRange(pBlock.slice, modelsNode.index + 1, 6); // owner indent 6

    // modelsBlock rows are `- id:` / `- name:` pairs at indent 8.
    for (let j = 0; j < modelsBlock.slice.length; j++) {
      const mr = modelsBlock.slice[j];
      if (!mr.content.startsWith("- ")) continue;
      const item = parseDashItem(mr.content);
      if (item.key === null) continue;
      if (item.key !== "id") continue;
      const model = item.value.trim();
      if (!model) continue;
      // look one row ahead for the `name:` of the same item
      let name = model;
      const next = modelsBlock.slice[j + 1];
      if (next && next.content.startsWith("- name: ")) {
        name = next.content.slice("- name:".length).trim();
      }
      catalog.push({
        provider,
        model,
        // Always prefix with the provider so same-named models across providers
        // stay distinguishable in the dropdown (e.g. jl-token vs jltokenslb both
        // expose DeepSeek-V4-Flash).
        name: `${displayName} · ${name}`,
      });
    }
  }
  return catalog;
}

/** Read the on-disk catalog (empty array when unavailable). */
export function loadProviderCatalog(env = process.env) {
  try {
    const text = readFileSync(settingsYamlPath(env), "utf8");
    return parseProviderCatalog(text);
  } catch {
    return [];
  }
}
