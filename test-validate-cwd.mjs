#!/usr/bin/env node
// Focused test for #63 cwd validation (Bug B+C fix)
// Extracts validateCwdParam from dsh-acp.mjs and exercises its error paths
// against RequestError shapes the ACP client receives.

import { readFileSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import { RequestError } from "@agentclientprotocol/sdk";

const src = readFileSync("./dsh-acp.mjs", "utf8");
const m = src.match(/function validateCwdParam\(cwd, opName\)\s*\{[\s\S]*?\n\}/);
if (!m) {
  console.error("could not extract validateCwdParam");
  process.exit(2);
}
// The function references `isAbsolute` (imported at module top) and
// `RequestError` (also imported). Make both available by inlining them
// inside a data: URL that re-imports what it needs.
const fnSrc = `
import { RequestError } from "@agentclientprotocol/sdk";
import { isAbsolute } from "node:path";
import { statSync } from "node:fs";
${m[0]}
export default validateCwdParam;
`;
const mod = await import(`data:text/javascript;base64,${Buffer.from(fnSrc).toString("base64")}`);
const validateCwdParam = mod.default;

let pass = 0, fail = 0;
const ok = (name) => { console.log("  ✓", name); pass++; };
const ko = (name, msg) => { console.log("  ✗", name, "-", msg); fail++; };

console.log("=== #63 cwd validation tests ===\n");

// 1. undefined / null / empty → returns undefined (fallback allowed)
for (const v of [undefined, null, ""]) {
  try {
    const r = validateCwdParam(v, "session/new");
    if (r === undefined) ok(`undefined-ish (${JSON.stringify(v)}) → undefined`);
    else ko(`undefined-ish (${JSON.stringify(v)})`, `got ${r}`);
  } catch (e) {
    ko(`undefined-ish (${JSON.stringify(v)})`, `should not throw: ${e.message}`);
  }
}

// 2. relative path → throws InvalidParams with clear message
try {
  validateCwdParam("projects", "session/new");
  ko("relative cwd", "should have thrown");
} catch (e) {
  if (e instanceof RequestError && /must be an absolute path/.test(e.message)) {
    ok("relative cwd → 'must be an absolute path'");
  } else {
    ko("relative cwd", `${e.constructor.name}: ${e.message}`);
  }
}

// 3. non-existent absolute path → throws "does not exist"
try {
  validateCwdParam("/Users/admin/Documents/Obsidian Vault", "session/new");
  ko("non-existent cwd", "should have thrown");
} catch (e) {
  if (e instanceof RequestError && /cwd does not exist/.test(e.message)) {
    ok("non-existent cwd → 'cwd does not exist: /Users/admin/...'");
  } else {
    ko("non-existent cwd", `${e.constructor.name}: ${e.message}`);
  }
}

// 4. path exists but is a file → throws "not a directory"
try {
  validateCwdParam("/home/user/.npm-global/bin/dsh", "session/new");
  ko("cwd is a file", "should have thrown");
} catch (e) {
  if (e instanceof RequestError && /cwd is not a directory/.test(e.message)) {
    ok("cwd is a file → 'cwd is not a directory: ...'");
  } else {
    ko("cwd is a file", `${e.constructor.name}: ${e.message}`);
  }
}

// 5. valid existing directory → returns cwd unchanged
const goodCwd = "/home/user/projects";
try {
  const r = validateCwdParam(goodCwd, "session/new");
  if (r === goodCwd) ok("valid cwd → returns cwd unchanged");
  else ko("valid cwd", `got ${r}`);
} catch (e) {
  ko("valid cwd", `should not throw: ${e.message}`);
}

console.log(`\npass=${pass} fail=${fail}`);
process.exit(fail > 0 ? 1 : 0);
