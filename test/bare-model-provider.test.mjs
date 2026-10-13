// test/bare-model-provider.test.mjs — provider resolution for bare model ids.
//
// Root cause (2026-10-10, Obsidian agent-client): the client sends a BARE model
// id (e.g. "DeepSeek-V4-Flash", no "provider/" prefix). buildStreamOptions used
// to hand the literal provider "default" to ctx.llm.stream(), which answered
//   no adapter registered for provider "default"  (NO_ADAPTER)
// The proxy path therefore failed every turn; the spawn path worked only
// because dsh CLI falls back to its own agent-default-model.
//
// New contract (fix/bare-model-id):
//   provider = explicit sessionConfig.provider
//           ?? provider part of the effective model id ("provider/model")
//           ?? provider part of defaultModel
//           ?? THROW (readable error naming the original model id)
// The literal "default" is never invented as a fallback.
//
// NOTE: an EXPLICIT "default/<model>" id (or explicit provider:"default") is
// still honoured — that is the caller's deliberate input, not a fallback.

import test from "node:test";
import assert from "node:assert/strict";
import { buildStreamOptions } from "../lib/long-runtime.mjs";

/** Minimal valid input; override per case. */
function opts(over = {}) {
  return buildStreamOptions({
    promptText: "hi",
    sessionConfig: {},
    defaultModel: null,
    history: [],
    cwd: "/tmp",
    ...over,
  });
}

// --- 1. flattened "provider/model" id --------------------------------------

test("bare-model: 'provider/model' id splits into provider + bare model", () => {
  const o = opts({ sessionConfig: { model: "jl-token/DeepSeek-V4-Flash" } });
  assert.equal(o.provider, "jl-token");
  assert.equal(o.model, "DeepSeek-V4-Flash");
});

// --- 2. bare id + defaultModel carrying a provider -------------------------

test("bare-model: bare id borrows the provider from defaultModel", () => {
  const o = opts({
    sessionConfig: { model: "DeepSeek-V4-Flash" },
    defaultModel: "jl-token/DeepSeek-V4.1-Flash",
  });
  assert.equal(o.provider, "jl-token", "bare id must take defaultModel's provider");
  assert.equal(o.model, "DeepSeek-V4-Flash", "model id itself stays bare");
});

// --- 3. bare id + unresolvable defaultModel → throw ------------------------

test("bare-model: bare id with no resolvable defaultModel throws (names the model)", () => {
  assert.throws(
    () => opts({ sessionConfig: { model: "Totally-Fake-Model" }, defaultModel: null }),
    (err) => {
      assert.ok(err instanceof Error);
      assert.match(err.message, /Totally-Fake-Model/, "error must name the offending model id");
      assert.match(err.message, /provider/i, "error must mention provider");
      return true;
    },
  );
});

test("bare-model: bare defaultModel (no provider part) also throws", () => {
  assert.throws(
    () => opts({ sessionConfig: { model: "DeepSeek-V4-Flash" }, defaultModel: "Bare-Default" }),
    /DeepSeek-V4-Flash/,
  );
});

// --- 4. explicit provider wins over everything -----------------------------

test("bare-model: explicit sessionConfig.provider wins over bare id", () => {
  const o = opts({
    sessionConfig: { model: "DeepSeek-V4-Flash", provider: "jl-token" },
    defaultModel: null,
  });
  assert.equal(o.provider, "jl-token");
  assert.equal(o.model, "DeepSeek-V4-Flash");
});

test("bare-model: explicit provider wins over a conflicting 'provider/model' id", () => {
  const o = opts({
    sessionConfig: { model: "other/Kimi-K2.6", provider: "jl-token" },
    defaultModel: null,
  });
  assert.equal(o.provider, "jl-token", "explicit provider has top priority");
});

// --- 5. empty / null / whitespace model → fully use defaultModel -----------

for (const empty of ["", null, undefined, "   ", "\t\n"]) {
  test(`bare-model: model=${JSON.stringify(empty)} falls back to defaultModel entirely`, () => {
    const o = opts({
      sessionConfig: { model: empty },
      defaultModel: "jl-token/DeepSeek-V4.1-Flash",
    });
    assert.equal(o.provider, "jl-token");
    assert.equal(o.model, "DeepSeek-V4.1-Flash");
  });
}

// --- 6. "a/b/c" → first "/" splits, rest is the model ----------------------

test("bare-model: 'a/b/c' splits at the FIRST slash", () => {
  const o = opts({ sessionConfig: { model: "a/b/c" } });
  assert.equal(o.provider, "a");
  assert.equal(o.model, "b/c");
});

// --- 7. malformed leading/trailing slash → treated as bare id --------------

test("bare-model: '/x' is treated as a bare id (borrows defaultModel's provider)", () => {
  const o = opts({
    sessionConfig: { model: "/x" },
    defaultModel: "jl-token/M",
  });
  assert.equal(o.provider, "jl-token");
  assert.equal(o.model, "/x");
});

test("bare-model: 'x/' is treated as a bare id (borrows defaultModel's provider)", () => {
  const o = opts({
    sessionConfig: { model: "x/" },
    defaultModel: "jl-token/M",
  });
  assert.equal(o.provider, "jl-token");
  assert.equal(o.model, "x/", "malformed id is NOT split into provider 'x' + empty model");
});

test("bare-model: malformed '/x' with no defaultModel throws", () => {
  assert.throws(() => opts({ sessionConfig: { model: "/x" }, defaultModel: null }), /\/x/);
});

// --- 8. guard: the literal "default" is never invented ---------------------

test("bare-model: provider is never the invented literal 'default'", () => {
  const cases = [
    { sessionConfig: { model: "jl-token/DeepSeek-V4-Flash" }, defaultModel: null },
    { sessionConfig: { model: "DeepSeek-V4-Flash" }, defaultModel: "jl-token/DeepSeek-V4.1-Flash" },
    { sessionConfig: { model: "DeepSeek-V4-Flash", provider: "jl-token" }, defaultModel: null },
    { sessionConfig: { model: "" }, defaultModel: "jl-token/DeepSeek-V4.1-Flash" },
    { sessionConfig: { model: "a/b/c" }, defaultModel: null },
    { sessionConfig: { model: "/x" }, defaultModel: "jl-token/M" },
    { sessionConfig: { model: "x/" }, defaultModel: "jl-token/M" },
  ];
  for (const c of cases) {
    const o = opts(c);
    assert.notEqual(
      o.provider,
      "default",
      `provider must never be the invented literal 'default' (input: ${JSON.stringify(c)})`,
    );
  }
});

test("bare-model: the unresolvable case throws rather than emitting 'default'", () => {
  // Complements the guard above: the previous behaviour returned "default" here.
  assert.throws(
    () => opts({ sessionConfig: { model: "DeepSeek-V4-Flash" }, defaultModel: null }),
    (err) => {
      assert.doesNotMatch(err.message, /provider "default"/i);
      return true;
    },
  );
});
