// test/session-config.test.mjs — node:test unit tests for session config
// option parsing/validation in dsh-acp.mjs (P2.5).
//
// These tests focus on the pure parsing logic that lives in long-runtime.mjs
// (buildStreamOptions) plus the option-id validation logic that lives
// alongside temperatureConfigOption/reasoningEffortConfigOption in
// dsh-acp.mjs. The latter is mirrored here as a pure function so it can be
// unit-tested without spawning the adapter.

import test from "node:test";
import assert from "node:assert/strict";
import { buildStreamOptions } from "../lib/long-runtime.mjs";

// --- buildStreamOptions: temperature / reasoningEffort (P2.5) -----------

test("buildStreamOptions: passes temperature when provided", () => {
  const opts = buildStreamOptions({
    promptText: "hi",
    sessionConfig: { model: "default/m", temperature: 0.3 },
    defaultModel: null,
    history: [],
    cwd: "/tmp",
  });
  assert.equal(opts.temperature, 0.3);
});

test("buildStreamOptions: passes reasoningEffort when provided", () => {
  const opts = buildStreamOptions({
    promptText: "hi",
    sessionConfig: { model: "default/m", reasoningEffort: "high" },
    defaultModel: null,
    history: [],
    cwd: "/tmp",
  });
  assert.equal(opts.reasoningEffort, "high");
});

test("buildStreamOptions: passes both temperature and reasoningEffort", () => {
  const opts = buildStreamOptions({
    promptText: "hi",
    sessionConfig: { model: "default/m", temperature: 1.2, reasoningEffort: "low" },
    defaultModel: null,
    history: [],
    cwd: "/tmp",
  });
  assert.equal(opts.temperature, 1.2);
  assert.equal(opts.reasoningEffort, "low");
});

test("buildStreamOptions: omits temperature when not set", () => {
  const opts = buildStreamOptions({
    promptText: "hi",
    sessionConfig: { model: "default/m", reasoningEffort: "medium" },
    defaultModel: null,
    history: [],
    cwd: "/tmp",
  });
  assert.equal("temperature" in opts, false);
  assert.equal(opts.reasoningEffort, "medium");
});

test("buildStreamOptions: omits reasoningEffort when not set", () => {
  const opts = buildStreamOptions({
    promptText: "hi",
    sessionConfig: { model: "default/m", temperature: 0.7 },
    defaultModel: null,
    history: [],
    cwd: "/tmp",
  });
  assert.equal(opts.temperature, 0.7);
  assert.equal("reasoningEffort" in opts, false);
});

// --- ACP option-shape validation (mirrors setSessionConfigOption) --------
//
// dsh-acp.mjs's setSessionConfigOption validates values before persisting.
// We mirror the rules here so the contract is documented + testable.

const VALID_TEMPERATURE_RANGE = [0, 2];
const VALID_REASONING_EFFORTS = ["none", "low", "medium", "high"];

function validateTemperature(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return false;
  return n >= VALID_TEMPERATURE_RANGE[0] && n <= VALID_TEMPERATURE_RANGE[1];
}

function validateReasoningEffort(value) {
  return typeof value === "string" && VALID_REASONING_EFFORTS.includes(value);
}

test("temperature: accepts 0", () => {
  assert.equal(validateTemperature(0), true);
});

test("temperature: accepts 2", () => {
  assert.equal(validateTemperature(2), true);
});

test("temperature: accepts 0.7 (typical default)", () => {
  assert.equal(validateTemperature(0.7), true);
});

test("temperature: rejects -0.1", () => {
  assert.equal(validateTemperature(-0.1), false);
});

test("temperature: rejects 2.1", () => {
  assert.equal(validateTemperature(2.1), false);
});

test("temperature: rejects non-numeric strings", () => {
  assert.equal(validateTemperature("hot"), false);
});

test("temperature: rejects NaN", () => {
  assert.equal(validateTemperature(NaN), false);
});

test("temperature: rejects Infinity", () => {
  assert.equal(validateTemperature(Infinity), false);
});

test("reasoningEffort: accepts all 4 valid values", () => {
  for (const v of ["none", "low", "medium", "high"]) {
    assert.equal(validateReasoningEffort(v), true, `${v} should be valid`);
  }
});

test("reasoningEffort: rejects unknown values", () => {
  assert.equal(validateReasoningEffort("max"), false);
  assert.equal(validateReasoningEffort(""), false);
  assert.equal(validateReasoningEffort(123), false);
  assert.equal(validateReasoningEffort(null), false);
  assert.equal(validateReasoningEffort(undefined), false);
});

// --- session config option shapes (P2.5 surfaces) --------------------------
//
// These mirror temperatureConfigOption/reasoningEffortConfigOption in
// dsh-acp.mjs. Kept here as pure helpers so the shape contract is testable.

function temperatureOptionShape(current) {
  return {
    id: "temperature",
    name: "Temperature",
    description: "Sampling temperature (0 = deterministic, 2 = chaotic)",
    category: "model",
    type: "number",
    currentValue: typeof current === "number" ? current : 0.7,
    min: 0,
    max: 2,
  };
}

function reasoningEffortOptionShape(current) {
  const valid = ["none", "low", "medium", "high"];
  const safe = valid.includes(current) ? current : "medium";
  return {
    id: "reasoningEffort",
    name: "Reasoning Effort",
    description: "How much the model should 'think' before answering",
    category: "model",
    type: "select",
    currentValue: safe,
    options: valid.map((v) => ({ value: v, name: v.charAt(0).toUpperCase() + v.slice(1) })),
  };
}

test("temperature option: shape is correct when current is a number", () => {
  const opt = temperatureOptionShape(0.3);
  assert.equal(opt.type, "number");
  assert.equal(opt.currentValue, 0.3);
  assert.equal(opt.min, 0);
  assert.equal(opt.max, 2);
  assert.equal(opt.id, "temperature");
  assert.equal(opt.category, "model");
});

test("temperature option: defaults to 0.7 when current is not a number", () => {
  const opt = temperatureOptionShape(undefined);
  assert.equal(opt.currentValue, 0.7);
  const opt2 = temperatureOptionShape(null);
  assert.equal(opt2.currentValue, 0.7);
});

test("reasoningEffort option: shape exposes all 4 values", () => {
  const opt = reasoningEffortOptionShape("high");
  assert.equal(opt.type, "select");
  assert.equal(opt.currentValue, "high");
  assert.equal(opt.options.length, 4);
  assert.deepEqual(
    opt.options.map((o) => o.value),
    ["none", "low", "medium", "high"],
  );
});

test("reasoningEffort option: defaults to 'medium' on invalid current", () => {
  assert.equal(reasoningEffortOptionShape(undefined).currentValue, "medium");
  assert.equal(reasoningEffortOptionShape("ultra").currentValue, "medium");
});

test("configOption order: model first, then temperature, then reasoningEffort", () => {
  const session = { model: "default/m" };
  const opts = [
    { id: "model" },
    temperatureOptionShape(session.temperature),
    reasoningEffortOptionShape(session.reasoningEffort),
  ];
  assert.deepEqual(opts.map((o) => o.id), ["model", "temperature", "reasoningEffort"]);
});
