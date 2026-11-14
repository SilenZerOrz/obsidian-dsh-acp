// test/agent-preset-shim.test.mjs — node:test unit tests for
// lib/acp-agent-preset-shim.mjs (R144, 2026-11-15).
//
// Contract under test:
//   1. best-effort — an unreadable/missing service leaves the ctx untouched;
//   2. never double-mount — a preset the caller already composed wins;
//   3. never throw — a failing mount degrades to a warning;
//   4. scoped — the host's `agents` singleton is NOT mutated, only the facade;
//   5. reversible — DSH_ACP_AGENT_PRESET_SHIM=off disables the shim.

import test from "node:test";
import assert from "node:assert/strict";
import { withAgentPresetComposition, AGENT_PRESET_SHIM_ENV } from "../lib/acp-agent-preset-shim.mjs";

/** Minimal cordis-ish ctx: `get(name)` lookup + direct property reads. */
function fakeCtx(services) {
  return {
    ...services,
    get: (name) => services[name],
    on: () => () => {},
    logger: { warn: () => {} },
  };
}

/** Recording `agents` service; every setup runs and is logged. */
function fakeAgents(calls) {
  return {
    async create(options) {
      calls.push(["create", options.setup === undefined ? "no-setup" : "setup"]);
      if (typeof options.setup === "function") await options.setup({ id: "agentCtx" });
      return { ok: true };
    },
    async resume(options) {
      calls.push(["resume"]);
      if (typeof options.setup === "function") await options.setup({ id: "agentCtx" });
      return { ok: true };
    },
    unrelated() {
      return "unrelated";
    },
  };
}

test("returns the ctx unchanged when the host has no agentPresets service", () => {
  const calls = [];
  const ctx = fakeCtx({ agents: fakeAgents(calls) });
  assert.equal(withAgentPresetComposition(ctx, { env: {} }), ctx);
});

test("returns the ctx unchanged when the host has no agents service", () => {
  const ctx = fakeCtx({ agentPresets: { mount: async () => ({ id: "standard" }) } });
  assert.equal(withAgentPresetComposition(ctx, { env: {} }), ctx);
});

test("mounts the default preset after the bridge's own setup", async () => {
  const calls = [];
  const presets = {
    composedPreset: () => undefined,
    mount: async (agentCtx, id) => {
      calls.push(["mount", id ?? "<default>", agentCtx.id]);
      return { id: "standard" };
    },
  };
  const ctx = fakeCtx({ agents: fakeAgents(calls), agentPresets: presets });
  const facade = withAgentPresetComposition(ctx, { env: {} });

  await facade.agents.create({ sessionId: "s1", setup: async (agentCtx) => calls.push(["bridge-setup", agentCtx.id]) });

  assert.deepEqual(calls, [
    ["create", "setup"],
    ["bridge-setup", "agentCtx"],
    ["mount", "<default>", "agentCtx"],
  ]);
});

test("resume() is composed the same way as create()", async () => {
  const calls = [];
  const ctx = fakeCtx({
    agents: fakeAgents(calls),
    agentPresets: { composedPreset: () => undefined, mount: async () => calls.push(["mount"]) },
  });
  const facade = withAgentPresetComposition(ctx, { env: {} });

  await facade.agents.resume({ resumeSessionId: "s1", setup: async () => calls.push(["bridge-setup"]) });

  assert.deepEqual(calls, [["resume"], ["bridge-setup"], ["mount"]]);
});

test("never double-mounts a preset the caller composed itself", async () => {
  const calls = [];
  const ctx = fakeCtx({
    agents: fakeAgents(calls),
    agentPresets: {
      composedPreset: () => "standard",
      mount: async () => calls.push(["mount"]),
    },
  });
  const facade = withAgentPresetComposition(ctx, { env: {} });

  await facade.agents.create({ setup: async () => calls.push(["bridge-setup"]) });

  assert.deepEqual(calls, [["create", "setup"], ["bridge-setup"]]);
});

test("a failing mount warns instead of failing the session", async () => {
  const calls = [];
  const warnings = [];
  const ctx = fakeCtx({
    agents: fakeAgents(calls),
    agentPresets: {
      composedPreset: () => undefined,
      mount: async () => {
        throw new Error("agent-preset: mounting requires a scope");
      },
    },
  });
  const facade = withAgentPresetComposition(ctx, { env: {}, onWarn: (error) => warnings.push(error.message) });

  const created = await facade.agents.create({ setup: async () => calls.push(["bridge-setup"]) });

  assert.deepEqual(created, { ok: true });
  assert.deepEqual(calls, [["create", "setup"], ["bridge-setup"]]);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /agent preset mount skipped: agent-preset: mounting requires a scope/);
});

test("a throwing composedPreset probe also degrades to a warning", async () => {
  const calls = [];
  const warnings = [];
  const ctx = fakeCtx({
    agents: fakeAgents(calls),
    agentPresets: {
      composedPreset: () => {
        throw new Error("no scope");
      },
      mount: async () => calls.push(["mount"]),
    },
  });
  const facade = withAgentPresetComposition(ctx, { env: {}, onWarn: (error) => warnings.push(error.message) });

  await facade.agents.create({ setup: async () => calls.push(["bridge-setup"]) });

  assert.deepEqual(calls, [["create", "setup"], ["bridge-setup"]]);
  assert.equal(warnings.length, 1);
});

test("leaves an assets-only setup (no function) alone", async () => {
  const calls = [];
  const ctx = fakeCtx({
    agents: fakeAgents(calls),
    agentPresets: { composedPreset: () => undefined, mount: async () => calls.push(["mount"]) },
  });
  const facade = withAgentPresetComposition(ctx, { env: {} });

  await facade.agents.create({ sessionId: "s1" });

  assert.deepEqual(calls, [["create", "no-setup"]]);
});

test("does not mutate the host's agents singleton", async () => {
  const calls = [];
  const agents = fakeAgents(calls);
  const originalCreate = agents.create;
  const ctx = fakeCtx({
    agents,
    agentPresets: { composedPreset: () => undefined, mount: async () => calls.push(["mount"]) },
  });
  const facade = withAgentPresetComposition(ctx, { env: {} });

  assert.notEqual(facade.agents, agents);
  assert.equal(agents.create, originalCreate);
  await agents.create({ setup: async () => calls.push(["bridge-setup"]) });
  assert.deepEqual(calls, [["create", "setup"], ["bridge-setup"]]);
});

test("forwards every other service read, including get(name)", () => {
  const calls = [];
  const llm = { name: "llm" };
  const ctx = fakeCtx({
    agents: fakeAgents(calls),
    agentPresets: { composedPreset: () => undefined, mount: async () => calls.push(["mount"]) },
    llm,
  });
  const facade = withAgentPresetComposition(ctx, { env: {} });

  assert.equal(facade.llm, llm);
  assert.equal(facade.get("llm"), llm);
  assert.equal(typeof facade.on, "function");
  assert.notEqual(facade.get("agents"), ctx.agents);
  assert.equal(facade.unrelated, undefined);
  assert.equal(facade.agents.unrelated(), "unrelated");
});

test("DSH_ACP_AGENT_PRESET_SHIM=off disables the shim", () => {
  const calls = [];
  const ctx = fakeCtx({
    agents: fakeAgents(calls),
    agentPresets: { composedPreset: () => undefined, mount: async () => calls.push(["mount"]) },
  });
  assert.equal(withAgentPresetComposition(ctx, { env: { [AGENT_PRESET_SHIM_ENV]: "off" } }), ctx);
});

test("falls back to the reflection store when get() refuses non-injected names", () => {
  const calls = [];
  const agents = fakeAgents(calls);
  const presets = { composedPreset: () => undefined, mount: async () => calls.push(["mount"]) };
  const store = { agents, agentPresets: presets };
  const ctx = {
    agents,
    get() {
      throw new Error('cannot get property "agentPresets" without inject');
    },
    reflect: { get: (name) => store[name] },
  };

  const facade = withAgentPresetComposition(ctx, { env: {} });

  assert.notEqual(facade, ctx);
  assert.notEqual(facade.agents, agents);
});
