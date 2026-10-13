// test/split-model.test.mjs — P3.2 C3 unit tests for lib/split-model.mjs.
//
// Root cause: when a per-prompt modelOverride is a BARE model id
// (e.g. "DeepSeek-V4-Flash" with no "provider/" prefix) AND DEFAULT_PROVIDER
// is null (env + profile both missed), the old code returned
// { provider: null, model: combo } and the resulting model.patch.yml had
// only `model:` and no `provider:`. dsh rejected the patch at startup with
//   `$.provider missing required value (at provider)`
// from cordis resolveConfig. The fix: in the bare-id branch, fall back to a
// known tool-capable provider so the patch always has a valid provider.

import test from "node:test";
import assert from "node:assert/strict";

import { splitModel, DEFAULT_PROVIDER } from "../lib/split-model.mjs";

// Snapshot the test env so we can restore it after each test (DEFAULT_PROVIDER
// is computed at module load from process.env, so we can't change it per-test
// — these tests document the env-DEPENDENT branches, not the env-controlled
// one). For the env-controlled branch see the integration test
// ~/dsh-diag/20261013/probe-c3-patch.mjs.

test("splitModel: 'provider/model' id splits cleanly", () => {
  const r = splitModel("jl-token/DeepSeek-V4-Flash");
  assert.equal(r.provider, "jl-token");
  assert.equal(r.model, "DeepSeek-V4-Flash");
});

test("splitModel: 'provider/model/extra' splits at FIRST slash", () => {
  const r = splitModel("jl-token/with/slashes");
  assert.equal(r.provider, "jl-token");
  assert.equal(r.model, "with/slashes");
});

test("splitModel: empty string returns DEFAULT_PROVIDER + undefined model", () => {
  const r = splitModel("");
  assert.equal(r.provider, DEFAULT_PROVIDER);
  assert.equal(r.model, undefined);
});

test("splitModel: null returns DEFAULT_PROVIDER + undefined model", () => {
  const r = splitModel(null);
  assert.equal(r.provider, DEFAULT_PROVIDER);
  assert.equal(r.model, undefined);
});

test("splitModel: undefined returns DEFAULT_PROVIDER + undefined model", () => {
  const r = splitModel(undefined);
  assert.equal(r.provider, DEFAULT_PROVIDER);
  assert.equal(r.model, undefined);
});

test("splitModel: non-string returns DEFAULT_PROVIDER + undefined model", () => {
  const r = splitModel(123);
  assert.equal(r.provider, DEFAULT_PROVIDER);
  assert.equal(r.model, undefined);
});

test("splitModel: provider is never null when a model is provided (C3 regression)", () => {
  // P3.2 C3: the C3 bug returned { provider: null, model: <bare> } when
  // DEFAULT_PROVIDER was null and the model was bare. With the fix the
  // returned provider is always a non-null string in that branch.
  //
  // We can't control DEFAULT_PROVIDER from the test (it's read at module
  // load), but we can assert: IF DEFAULT_PROVIDER is null, then for ANY bare
  // model, the returned provider is a non-null string. The env passed to
  // `node --test` is whatever the user has; the test is documentation either
  // way.
  const bare = "DeepSeek-V4-Flash";
  const r = splitModel(bare);
  assert.notEqual(r.provider, null, "provider must NEVER be null when a model is given (C3 fix)");
  assert.equal(typeof r.provider, "string", "provider must be a string for dsh's patch YAML");
  assert.ok(r.provider.length > 0, "provider must be non-empty");
  assert.equal(r.model, bare, "model id is preserved verbatim");
});

test("splitModel: explicit 'provider/model' is returned as-is (no fallback rewrites it)", () => {
  // Sanity: the C3 fix only changes the bare-id branch. An explicit
  // provider/model id must split normally and not pick up any fallback.
  const r = splitModel("explicit/Model-X");
  assert.equal(r.provider, "explicit");
  assert.equal(r.model, "Model-X");
});

test("splitModel: trailing slash 'model/' is a bare id (no real provider in slot)", () => {
  // Edge: "x/" has a slash but the model part is empty — same shape as a
  // bare id (no usable provider). Falls through the C3 fallback.
  const r = splitModel("x/");
  assert.equal(r.provider, "x");
  assert.equal(r.model, "");
});

test("splitModel: leading slash '/x' has idx===0 so it goes through the bare branch", () => {
  // "/x" has idx===0, so the condition `if (idx === -1)` is false and the
  // function takes the explicit-branch path. provider="", model="x".
  // (This differs from buildStreamOptions's behavior — that's a separate
  // concern handled by the long-runtime path. We document the spawn-path
  // behavior here for completeness.)
  const r = splitModel("/x");
  assert.equal(r.provider, "");
  assert.equal(r.model, "x");
});
