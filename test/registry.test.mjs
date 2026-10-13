// test/registry.test.mjs — registry.mjs 单元测试
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  buildPackageCommand, resolvePackageManager, selectRegistry, fallbackRegistry,
} from "../lib/selfcheck/registry.mjs";

test("registry: selectRegistry honours NPM_CONFIG_REGISTRY", () => {
  assert.equal(selectRegistry({}), "https://registry.npmjs.org/");
  assert.equal(selectRegistry({ NPM_CONFIG_REGISTRY: "https://r.example/" }), "https://r.example/");
  assert.equal(selectRegistry({ npm_config_registry: "https://r2.example/" }), "https://r2.example/");
});

test("registry: fallbackRegistry is the CN mirror", () => {
  const u = fallbackRegistry();
  assert.match(u, /^https?:\/\//);
  assert.ok(u.length > 10);
});

test("registry: buildPackageCommand returns node+cli-script shape, never bare npm", () => {
  const c = buildPackageCommand("npm", ["i", "zod"], { registry: "https://r.example/" });
  assert.equal(c.cmd, "node");
  assert.equal(c.args[0], "./node_modules/npm/bin/npm-cli.js");
  assert.ok(c.args.includes("i"));
  assert.ok(c.args.includes("zod"));
  assert.ok(c.args.includes("--registry=https://r.example/"));
  assert.equal(c.registry, "https://r.example/");
});

test("registry: buildPackageCommand for pnpm uses pnpm.cjs", () => {
  const c = buildPackageCommand("pnpm", ["add", "zod"], { registry: "https://r.example/" });
  assert.equal(c.cmd, "node");
  assert.equal(c.args[0], "./node_modules/pnpm/bin/pnpm.cjs");
  assert.ok(c.args.includes("add"));
  assert.ok(c.args.includes("zod"));
  assert.ok(c.args.includes("--registry=https://r.example/"));
});

test("registry: buildPackageCommand omits --registry when none provided", () => {
  const c = buildPackageCommand("npm", ["i", "zod"]);
  assert.equal(c.args.includes("--registry=https://registry.npmjs.org/"), false);
});

test("registry: buildPackageCommand defaults to npm when pm unknown", () => {
  const c = buildPackageCommand("yarn", ["add", "x"]);
  // yarn isn't in our table; falls back to npm cli path
  assert.equal(c.args[0], "./node_modules/npm/bin/npm-cli.js");
});

test("registry: resolvePackageManager detects pnpm-lock.yaml", async () => {
  const root = mkdtempSync(join(tmpdir(), "pm-"));
  writeFileSync(join(root, "pnpm-lock.yaml"), "lockfileVersion: 5.4\n");
  const r = await resolvePackageManager({ adapter: root });
  assert.equal(r.name, "pnpm");
  assert.equal(r.source, "pnpm-lock.yaml");
});

test("registry: resolvePackageManager detects package-lock.json", async () => {
  const root = mkdtempSync(join(tmpdir(), "pm-"));
  writeFileSync(join(root, "package-lock.json"), "{}");
  const r = await resolvePackageManager({ adapter: root });
  assert.equal(r.name, "npm");
  assert.equal(r.source, "package-lock.json");
});

test("registry: resolvePackageManager honours packageManager field", async () => {
  const root = mkdtempSync(join(tmpdir(), "pm-"));
  writeFileSync(join(root, "package.json"), JSON.stringify({ packageManager: "pnpm@9.0.0" }));
  const r = await resolvePackageManager({ adapter: root });
  assert.equal(r.name, "pnpm");
  assert.equal(r.source, "packageManager");
});

test("registry: resolvePackageManager falls back to npm when no signals", async () => {
  const root = mkdtempSync(join(tmpdir(), "pm-"));
  const r = await resolvePackageManager({ adapter: root });
  assert.equal(r.name, "npm");
  assert.equal(r.source, "default");
});
