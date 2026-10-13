// test/paths.test.mjs — paths.mjs 单元测试
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  isDir, isFile, readTextFile, profileDir, resolveRoots,
  discoverObsidianSessionsDirs, rootsToEnv, vaultPaths, adapterPath,
} from "../lib/selfcheck/paths.mjs";

test("paths: isDir / isFile / readTextFile on a fixture root", () => {
  const root = mkdtempSync(join(tmpdir(), "paths-"));
  const sub = join(root, "sub");
  mkdirSync(sub);
  writeFileSync(join(sub, "x.txt"), "hello");
  assert.equal(isDir(root), true);
  assert.equal(isDir(sub), true);
  assert.equal(isDir(join(root, "nope")), false);
  assert.equal(isFile(join(sub, "x.txt")), true);
  assert.equal(isFile(root), false);
  assert.equal(readTextFile(join(sub, "x.txt")), "hello");
  assert.equal(readTextFile(join(root, "nope")), null);
  assert.equal(readTextFile(null), null);
});

test("paths: profileDir returns <dshHome>/profiles/<name>", () => {
  const roots = { dshHome: "/x/y" };
  assert.equal(profileDir("headless", roots), "/x/y/profiles/headless");
  assert.equal(profileDir(undefined, roots), "/x/y");
  // When dshHome is missing, falls back to ~/.dsh
  const home = process.env.HOME || "/tmp";
  assert.equal(profileDir("headless", null), join(home, ".dsh", "profiles", "headless"));
});

test("paths: resolveRoots uses DSH_HOME and DSH_ACP_VAULT from env", () => {
  const env = { DSH_HOME: "/var/dsh", DSH_ACP_VAULT: "/work/v", DSH_ACP_ADAPTER_PATH: "/work/v/dsh-acp" };
  const r = resolveRoots({ env });
  assert.equal(r.dshHome, "/var/dsh");
  assert.equal(r.vault, "/work/v");
  assert.equal(r.adapter, "/work/v/dsh-acp");
  assert.equal(r.injected, false);
  assert.equal(r.path, "/var/dsh");
});

test("paths: resolveRoots with injected root overrides path/dshHome", () => {
  const env = { DSH_HOME: "/var/dsh" };
  const r = resolveRoots({ env, injected: "/tmp/fixture" });
  assert.equal(r.injected, true);
  assert.equal(r.path, "/tmp/fixture");
  assert.equal(r.dshHome, "/tmp/fixture");
});

test("paths: discoverObsidianSessionsDirs returns only existing dirs", () => {
  // The function builds candidates as `<home>/Library/Application Support/obsidian`
  // (mac) / `<home>/.config/obsidian` (linux/win). Create the matching fixture.
  const home = mkdtempSync(join(tmpdir(), "obshome-"));
  let obs;
  if (process.platform === "darwin") {
    obs = join(home, "Library", "Application Support", "obsidian");
  } else if (process.platform === "win32") {
    obs = join(home, "AppData", "Roaming", "obsidian");
  } else {
    obs = join(home, ".config", "obsidian");
  }
  mkdirSync(obs, { recursive: true });
  const r = { home, dshHome: home, obsidianDir: obs };
  const out = discoverObsidianSessionsDirs(r);
  assert.ok(out.length >= 1, `at least one obs dir should be discovered (got ${out.length})`);
  assert.ok(out.every((d) => d.startsWith(home)), "all returned dirs live under fixture");
});

test("paths: rootsToEnv maps DSH_HOME / DSH_ACP_VAULT", () => {
  const e = rootsToEnv({ dshHome: "/d", vault: "/v", obsidianDir: "/o", npmPrefix: "/n" });
  assert.equal(e.DSH_HOME, "/d");
  assert.equal(e.DSH_ACP_VAULT, "/v");
  assert.equal(e.DSH_ACP_OBSIDIAN_DIR, "/o");
  assert.equal(e.NPM_CONFIG_PREFIX, "/n");
});

test("paths: vaultPaths returns nulls when vault missing", () => {
  const v = vaultPaths({ vault: null });
  assert.equal(v.vault, null);
  assert.equal(v.vaultConfig, null);
  assert.equal(v.vaultAgents, null);
});

test("paths: adapterPath falls back to env or cwd/dsh-acp.mjs", () => {
  const orig = process.env.DSH_ACP_ADAPTER_PATH;
  try {
    process.env.DSH_ACP_ADAPTER_PATH = "/nonexistent";
    const p = adapterPath();
    assert.ok(typeof p === "string" && p.length > 0);
  } finally {
    if (orig === undefined) delete process.env.DSH_ACP_ADAPTER_PATH;
    else process.env.DSH_ACP_ADAPTER_PATH = orig;
  }
});
