// lib/acp-agent-preset-shim.mjs — R144 (2026-11-15)
//
// WHY THIS FILE EXISTS
// --------------------
// `@deepseek-ai/dsh-acp@0.2.2-rc.3` composes its per-session agent itself:
//
//   static async create(ctx, options) {          // lib/index.js:645
//     return new AcpSession(ctx, await ctx.agents.create({
//       ...,
//       setup: (agentCtx) => composeAgent(agentCtx, options),
//     }), options.notify);
//   }
//
//   async function composeAgent(agentCtx, options) {   // lib/index.js:617
//     installModelSelection(agentCtx);
//     await mountAcpMcpServers(agentCtx, options.mcpServers, options.cwd);
//   }
//
// That `composeAgent` never mounts an agent preset. The preset is what registers
// the tool schemas and prompt sections the model sees (`dsh-agent-preset-registry`
// README: "the preset decides the tool schemas and prompt sections the model
// sees"), so an ACP session — i.e. the Obsidian panel — came up with ONLY the
// profile-level plugin tools: no `bash` / `read` / `write` / `edit` / `glob` /
// `grep`, while Web/API sessions on the SAME host had all of them, because
// `dsh-api-session-controller` mounts the preset in its own `setup`:
//
//   async composeAgent(presetId) {               // :258
//     const presets = this.ctx.get("agentPresets");
//     const resolvedId = (await presets.resolve(presetId)).id;
//     return { agentPreset: resolvedId,
//              setup: async (agentCtx) => { installModelSelection(agentCtx);
//                                           await presets.mount(agentCtx, resolvedId); } };
//   }
//
// Upstream's `Config` schema (lib/index.js:1037) carries only
// `provider` / `model` / `sessionListPageSize`, and `composeAgent` is a private
// module function, so a host cannot ask the bridge to compose a preset. The gap
// has to be closed by whoever mounts the bridge — that is this plugin
// (`lib/acp-official-router.mjs`, `ctx.inject(injectNames, … apply(childCtx, …))`).
//
// WHAT IT DOES
// ------------
// `withAgentPresetComposition(ctx)` returns a FACADE over the ctx handed to the
// bridge whose `agents` service wraps `create` / `resume`: the caller-supplied
// `setup` is composed with the missing preset mount, run AFTER the bridge's own
// setup so model selection and MCP servers stay where upstream put them.
//
// Design constraints, in order of importance:
//
//   1. NEVER break a session. Nothing in here throws: a missing service, an
//      unreadable ctx, or a failing mount degrades to a warning and leaves the
//      session exactly as it behaved before this file existed.
//   2. NEVER double-mount. If the caller's `setup` already composed a preset
//      (`presets.composedPreset(agentCtx)` resolves) the shim is a no-op — so it
//      cannot conflict with a host that already does this, and it silently
//      becomes dead weight the moment upstream mounts the preset itself.
//   3. Scope = ACP sessions only. The facade is handed to `apply()` and to
//      nothing else; Web/API/subagent composition never sees this object.
//   4. Reversible. `DSH_ACP_AGENT_PRESET_SHIM=off` returns the ctx untouched.
//
// Verified against the running host (2026-11-15): ACP `request/header.tools`
// went 113 → 146 and the probe's shell tool really executed (see
// docs/计划文档.md §11.8).

/** Env switch: `off` disables the shim entirely (fallback = pre-R144 behaviour). */
export const AGENT_PRESET_SHIM_ENV = "DSH_ACP_AGENT_PRESET_SHIM";

/**
 * Read a host service without the cordis inject requirement.
 *
 * `ctx.get(name)` is the public reflection lookup; `ctx.reflect.get(name, false)`
 * is the store-level lookup that also tolerates an inactive providing fiber. The
 * bridge ctx only declares `["agents","llm","sessionPersistence","sessions"]`, so
 * `agentPresets` must be read through one of these paths and may legitimately be
 * absent on a host that composes no preset roster.
 *
 * @param {object} ctx - cordis context (or facade target).
 * @param {string} name - service name.
 * @returns {*} the service value, or undefined when unavailable.
 */
function readService(ctx, name) {
  try {
    if (typeof ctx?.get === "function") {
      const value = ctx.get(name);
      if (value !== undefined) return value;
    }
  } catch {
    // Injected-props-only ctx: fall through to the reflection store.
  }
  try {
    if (ctx?.reflect && typeof ctx.reflect.get === "function") return ctx.reflect.get(name, false);
  } catch {
    // No reflection layer: treat the service as absent.
  }
  return undefined;
}

/**
 * Compose a caller `setup` with the preset mount upstream leaves out.
 *
 * @param {Function|undefined} setup - the bridge's own setup callback.
 * @param {object} presets - `agentPresets` service.
 * @param {(error: Error) => void} [onWarn] - diagnostic sink (never rethrows).
 * @returns {Function|undefined} the composed setup, or the original when absent.
 */
function composeSetup(setup, presets, onWarn) {
  if (typeof setup !== "function") return setup;
  return async function setupWithAgentPreset(agentCtx) {
    await setup(agentCtx);
    try {
      const already = typeof presets.composedPreset === "function" ? presets.composedPreset(agentCtx) : undefined;
      if (already !== undefined) return; // the deployment composed a preset itself
      await presets.mount(agentCtx); // id omitted ⇒ the registry's defaultId
    } catch (error) {
      onWarn?.(new Error(`agent preset mount skipped: ${error?.message ?? error}`));
    }
  };
}

/**
 * Wrap `create` / `resume` so every setup gets the preset composition.
 *
 * A Proxy (rather than a hand-built object) keeps the service's prototype and
 * private fields intact for every other method the bridge may call.
 *
 * @param {object} agents - the host `agents` service instance.
 * @param {object} presets - `agentPresets` service.
 * @param {(error: Error) => void} [onWarn] - diagnostic sink.
 * @returns {object} wrapped service, or the original when nothing is wrappable.
 */
function wrapAgentsService(agents, presets, onWarn) {
  const composed = new Map();
  for (const method of ["create", "resume"]) {
    const original = agents[method];
    if (typeof original !== "function") continue;
    composed.set(method, function composedCall(options, ...rest) {
      const request =
        options && typeof options === "object"
          ? { ...options, setup: composeSetup(options.setup, presets, onWarn) }
          : options;
      return original.call(agents, request, ...rest);
    });
  }
  if (composed.size === 0) return agents;
  return new Proxy(agents, {
    get(target, property) {
      const replacement = composed.get(property);
      if (replacement !== undefined) return replacement;
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

/**
 * Facade over the bridge ctx: same ctx, except `agents` (and `get("agents")`)
 * resolve to the wrapped service.
 *
 * Reads are forwarded with `target` as the receiver so cordis's own accessor /
 * traceable wrapping still runs exactly as it would for the unwrapped ctx.
 *
 * @param {object} ctx - the ctx handed to `apply()`.
 * @param {object} wrappedAgents - wrapped `agents` service.
 * @returns {object} the facade.
 */
function facadeOverCtx(ctx, wrappedAgents) {
  const originalGet = typeof ctx.get === "function" ? ctx.get : undefined;
  return new Proxy(ctx, {
    get(target, property) {
      if (property === "agents") return wrappedAgents;
      if (property === "get" && originalGet !== undefined) {
        return (name, ...rest) => (name === "agents" ? wrappedAgents : Reflect.apply(originalGet, target, [name, ...rest]));
      }
      return Reflect.get(target, property, target);
    },
  });
}

/**
 * Hand the bridge a ctx that composes the deployment's default agent preset into
 * every ACP session it creates (R144; see the file header).
 *
 * Best-effort by contract: returns `ctx` unchanged whenever the shim cannot be
 * armed, so callers need no error handling.
 *
 * @param {object} ctx - ctx to hand to the bridge's `apply()`.
 * @param {object} [options]
 * @param {Record<string,string|undefined>} [options.env] - env source (tests).
 * @param {(error: Error) => void} [options.onWarn] - diagnostic sink.
 * @returns {object} facade ctx, or `ctx` unchanged.
 */
export function withAgentPresetComposition(ctx, options = {}) {
  const env = options.env ?? process.env;
  if (env?.[AGENT_PRESET_SHIM_ENV] === "off") return ctx;
  try {
    const presets = readService(ctx, "agentPresets");
    if (typeof presets?.mount !== "function") return ctx;
    const agents = readService(ctx, "agents");
    if (typeof agents?.create !== "function" && typeof agents?.resume !== "function") return ctx;
    return facadeOverCtx(ctx, wrapAgentsService(agents, presets, options.onWarn));
  } catch (error) {
    options.onWarn?.(new Error(`agent preset shim disabled: ${error?.message ?? error}`));
    return ctx;
  }
}
