// lib/split-model.mjs — P3.2 C3 extraction of splitModel + DEFAULT_PROVIDER
// from dsh-acp.mjs, for unit testing.
//
// P3.2 C3 fix (2026-10-13): when the per-prompt model override is a bare
// model id (e.g. "DeepSeek-V4-Flash" with no "provider/" prefix) AND the
// provider can't be resolved from DSH_ACP_DEFAULT_PROVIDER env or
// DSH_ACP_DEFAULT_MODEL env, the previous code returned
// { provider: null, model: "DeepSeek-V4-Flash" } and the resulting
// model.patch.yml had only `model:` and no `provider:`. dsh rejected the
// patch at startup with
//   `$.provider missing required value (at provider)` (cordis resolveConfig).
// Fix: fall back to the same hardcoded tool-capable provider that
// resolveDshAcpDefaultModelId() uses (the "jl-token/" chain), so the patch
// always carries a valid provider when a bare model is requested.

// t38: env 缺失时为 null，交由调用方兜底。原始位置在 dsh-acp.mjs。
export const DEFAULT_PROVIDER =
  process.env.DSH_ACP_DEFAULT_PROVIDER ||
  process.env.DSH_ACP_DEFAULT_MODEL?.split("/")[0] ||
  null;

/**
 * Split a `provider/model` combination into its parts. A bare model id
 * (legacy sessions) resolves to a default provider — same hardcoded fallback
 * as resolveDshAcpDefaultModelId, so the patch never carries a null provider.
 *
 * @param {string|undefined|null} combo
 * @returns {{ provider: string|null, model: string|undefined }}
 */
export function splitModel(combo) {
  if (!combo || typeof combo !== "string") {
    return { provider: DEFAULT_PROVIDER, model: undefined };
  }
  const idx = combo.indexOf("/");
  if (idx === -1) {
    // Bare model id. C3 fix: if DEFAULT_PROVIDER is null, fall back to a
    // known tool-capable provider so the patch is always valid.
    if (!DEFAULT_PROVIDER) {
      const fallbackProvider = resolveBareModelFallbackProvider();
      return { provider: fallbackProvider, model: combo };
    }
    return { provider: DEFAULT_PROVIDER, model: combo };
  }
  return { provider: combo.slice(0, idx), model: combo.slice(idx + 1) };
}

/**
 * Resolve the provider to pair with a bare model id. Mirrors the chain used
 * by resolveDshAcpDefaultModelId() in dsh-acp.mjs but only returns the
 * provider part (so the patch's `provider:` line is always populated).
 *
 * Order: DSH_ACP_DEFAULT_PROVIDER env → DSH_ACP_DEFAULT_MODEL env's
 * provider part → hardcoded "jl-token" (tool-capable fallback).
 */
function resolveBareModelFallbackProvider() {
  if (process.env.DSH_ACP_DEFAULT_PROVIDER) {
    return process.env.DSH_ACP_DEFAULT_PROVIDER;
  }
  if (process.env.DSH_ACP_DEFAULT_MODEL) {
    const idx = process.env.DSH_ACP_DEFAULT_MODEL.indexOf("/");
    if (idx > 0) return process.env.DSH_ACP_DEFAULT_MODEL.slice(0, idx);
  }
  return "jl-token";
}
