// test/fixtures/spike-bootstrap.mjs — boot a minimal dsh tree for the Spike.
//
// Plan C'': load `@deepseek-ai/dsh-base` (real agents/sessions/sessionPersistence/
// llm) in-process, then call `ctx.llm.registerAdapter(['stub'], stubAdapter)` from
// test code BEFORE `apply(ctx, { provider: 'stub', ... })`.
//
// Instead of hand-composing the cordis patch stack (which fails deep inside
// dsh-app-boot's ESM profile-resolution glue), we reuse `runProfile` — the exact
// boot entry `dsh web` / `dsh` bins use. It handles profile load, bundle patch
// composition, PluginPackages (agent/llm/session registry), and cmdline wiring.
// We only need to inject an isolated DSH_HOME + a profile whose bundle list is
// dsh-base only. We get back a settled `ctx` with `ctx.llm` / `ctx.agents`/
// `ctx.sessionPersistence` mounted, exactly like production.
//
// Why this is still safe for the Spike:
//   - No external process: runProfile runs in THIS process, same as before.
//   - DSH_HOME points at a mkdtemp dir, so nothing leaks to ~/.dsh.
//   - We never load dsh-acp-app (that's the launcher surface that needs
//     cmdlineArgs/appExit); apply() is called directly from test code.

import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";

// Resolve the dsh install via `package.json#exports["./profile-boot"]`,
// which points at the unversioned `lib/profile-boot.js`. That file is a
// stable wrapper that re-exports the mangled `runProfile` named symbol from
// the hashed bundle (`profile-boot-<HASH>.js`).
//
// Why NOT hardcode the hashed file path: the hash suffix changes on every
// dsh release (verified: 0.1.7-rc.1 ships `profile-boot-CO0MPY31.js`;
// 0.1.6-alpha.x shipped `profile-boot-DB8eVKBx.js`). The previous bootstrap
// broke across every upgrade — see Phase 3 #3 (2026-09-25). The unversioned
// wrapper IS stable across upgrades (it's the official exports entry).
//
// T7-2 (0.4.1): the dsh INSTALL ROOT used to be hardcoded to one machine's
// npm prefix. It is now resolved in three steps (highest priority first):
//   ① DSH_ACP_DSH_ROOT env override (a path to the `@deepseek-ai/dsh` package dir)
//   ② Node resolution: createRequire(...).resolve("@deepseek-ai/dsh/package.json")
//   ③ global npm prefix: `npm root -g` + /@deepseek-ai/dsh
// If all three fail we throw a readable error listing every attempted path.
// There is deliberately NO silent fallback to a hardcoded prefix.
const attemptedDshRoots = [];
function isDshRoot(p) {
  if (!p) return false;
  try {
    return existsSync(join(p, "lib", "profile-boot.js"))
      && existsSync(join(p, "node_modules", "@deepseek-ai", "dsh-app-boot", "lib", "index.js"));
  } catch { return false; }
}
function resolveDshRoot() {
  // ① explicit env override
  const envRoot = process.env.DSH_ACP_DSH_ROOT;
  if (envRoot) {
    attemptedDshRoots.push(`env DSH_ACP_DSH_ROOT=${envRoot}`);
    if (isDshRoot(envRoot)) return envRoot;
  } else {
    attemptedDshRoots.push("env DSH_ACP_DSH_ROOT=<unset>");
  }

  // ② Node module resolution (works when dsh is a real dependency/peer here)
  try {
    const req = createRequire(import.meta.url);
    const pkgJson = req.resolve("@deepseek-ai/dsh/package.json");
    const root = dirname(pkgJson);
    attemptedDshRoots.push(`require.resolve("@deepseek-ai/dsh/package.json") → ${root}`);
    if (isDshRoot(root)) return root;
  } catch (e) {
    attemptedDshRoots.push(`require.resolve("@deepseek-ai/dsh/package.json") → ${e?.code ?? e?.message ?? "failed"}`);
  }

  // ③ global npm prefix (subprocess; never throws)
  try {
    const out = execFileSync("npm", ["root", "-g"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    const prefix = String(out).trim();
    const root = join(prefix, "@deepseek-ai", "dsh");
    attemptedDshRoots.push(`npm root -g (${prefix || "<empty>"}) → ${root}`);
    if (root && isDshRoot(root)) return root;
  } catch (e) {
    attemptedDshRoots.push(`npm root -g → ${e?.code ?? e?.message ?? "failed"}`);
  }

  throw new Error(
    "spike-bootstrap: cannot locate the @deepseek-ai/dsh install root.\n" +
    "Set DSH_ACP_DSH_ROOT to the directory that contains lib/profile-boot.js, or install dsh.\n" +
    "Attempted:\n" + attemptedDshRoots.map((s, i) => `  ${i + 1}. ${s}`).join("\n"),
  );
}

const DSH_GLOBAL_PATH = resolveDshRoot();
const DSH_APP_BOOT_PATH = `${DSH_GLOBAL_PATH}/node_modules/@deepseek-ai/dsh-app-boot/lib/index.js`;
const DSH_PROFILE_BOOT_PATH = `${DSH_GLOBAL_PATH}/lib/profile-boot.js`;

const { loadLayeredEnv } = await import(DSH_APP_BOOT_PATH);
const { runProfile } = await import(DSH_PROFILE_BOOT_PATH);

const PROFILE_NAME = "spike-bare";

/**
 * Bring up a fully booted dsh-base cordis context via the official runProfile.
 *
 * @returns {Promise<{
 *   ctx: import("@deepseek-ai/cordis").Context,
 *   homeDir: string,
 *   profileDir: string,
 *   shutdown: { shutdown: (code?: number) => Promise<void> },
 *   dispose: () => Promise<void>,
 * }>}
 */
export async function bootSpikeContext() {
  // 1. Isolated DSH_HOME — every boot artifact stays under this dir.
  const homeDir = mkdtempSync(join(tmpdir(), "spike-dsh-"));
  const profileDir = join(homeDir, "profiles", PROFILE_NAME);
  mkdirSync(profileDir, { recursive: true });

  // 2. Profile manifest (bundles) — dsh-base only.
  const manifest = {
    name: `dsh-profile-${PROFILE_NAME}`,
    private: true,
    dependencies: {},
    dsh: { profile: { bundles: ["@deepseek-ai/dsh-base"], patchReload: "startup" } },
  };
  writeFileSync(join(profileDir, "package.json"), JSON.stringify(manifest, null, 2) + "\n");

  // 3. cordis.yml: empty root include (all real entries come from bundle patches).
  //    NOTE: if this file is missing, loadProfile creates it from a template;
  //    writing it explicitly is fine and matches dsh's own PROFILE_ROOT_CONFIG.
  writeFileSync(join(profileDir, "cordis.yml"), "# dsh-base only spike profile\n[]\n");

  // 4. pnpm-workspace.yaml: healProfilesModuleFallback needs the constructs.
  writeFileSync(
    join(profileDir, "pnpm-workspace.yaml"),
    "packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n"
  );

  // 5. Set DSH_HOME for this boot process. runProfile → composeProfile →
  //    loadProfile resolves the profile dir under resolveDshHome() ($DSH_HOME).
  const prevDshHome = process.env.DSH_HOME;
  process.env.DSH_HOME = homeDir;

  // Remember whether DSH_HOME was already set so we restore exactly.
  const hadDshHome = Object.prototype.hasOwnProperty.call(process.env, "DSH_HOME");

  let handle;
  try {
    const result = await runProfile({
      // loadLayeredEnv builds the launch-environment snapshot dsh's own bin
      // passes (a Map-like with .get() returning {value}). Called after DSH_HOME
      // is set above so the isolated home is captured.
      environment: loadLayeredEnv("dsh"),
      profile: PROFILE_NAME,
      patchFiles: [],
      // args is iterated by provideCmdline to expose ctx.cmdlineArgs; an empty
      // list is fine for the Spike (we never read argv).
      args: [],
      // resolutionMode "link" is the default for a non-packaged run and is
      // what `dsh web` uses in this install.
    });
    handle = result;
  } catch (err) {
    if (!hadDshHome) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = prevDshHome;
    try { rmSync(homeDir, { recursive: true, force: true }); } catch {}
    throw err;
  }

  const ctx = handle.ctx;

  return {
    ctx,
    homeDir,
    profileDir,
    shutdown: handle.shutdown,
    async dispose() {
      try {
        // runProfile's shutdown disposes the tree (and restores the proxy).
        if (handle.shutdown) await handle.shutdown.shutdown(0);
        else if (!ctx.fiber?.disposed) await ctx.fiber.dispose();
      } catch {}
      if (!hadDshHome) delete process.env.DSH_HOME;
      else process.env.DSH_HOME = prevDshHome;
      try { rmSync(homeDir, { recursive: true, force: true }); } catch {}
    },
  };
}
