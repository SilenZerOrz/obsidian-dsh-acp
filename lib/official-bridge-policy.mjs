// lib/official-bridge-policy.mjs — 官方桥启用策略（U3，2026-11-03）
//
// 动因：插件在 cordis 里跑时默认 runtime = legacy long，而 legacy long **没有工具
// 执行器**（0.3.6 的 A3 结论）⇒ 不设 env 的用户默认拿不到工具调用，正是 P1 缺陷。
// 因此把「是否走官方桥」从「只看 env」改为「默认由探针自动判定」：
//
//   DSH_ACP_USE_OFFICIAL_BRIDGE=0 | false | no | off   → 强制关闭（显式回滚口，最高优先）
//   DSH_ACP_USE_OFFICIAL_BRIDGE=1 | true | yes | on    → 强制开启（保留原语义，运维/测试用）
//   未设（或其它值）                                     → auto：探针 importable && servicesReady 即开启
//
// 降级纪律（「响亮降级」）：auto 判定不可用时**绝不静默** —— 调用方必须打印一行可
// grep 的 stderr 说明，且 `/acp/proxy/probe` 里能看到 policy 与 reason。
//
// 兼容性：`officialBridgePolicy` 不认识的值一律按 auto 处理（不抛错），保持旧部署
// 写入任意 env 值时插件照常启动。

export const OFFICIAL_BRIDGE_ENV = "DSH_ACP_USE_OFFICIAL_BRIDGE";

const ON_VALUES = new Set(["1", "true", "yes", "on"]);
const OFF_VALUES = new Set(["0", "false", "no", "off"]);

/**
 * Parse the env into a policy mode.
 * @param {NodeJS.ProcessEnv} [env=process.env]
 * @returns {"on"|"off"|"auto"}
 */
export function officialBridgePolicy(env = process.env) {
  const raw = typeof env?.[OFFICIAL_BRIDGE_ENV] === "string"
    ? env[OFFICIAL_BRIDGE_ENV].trim().toLowerCase()
    : "";
  if (ON_VALUES.has(raw)) return "on";
  if (OFF_VALUES.has(raw)) return "off";
  return "auto";
}

/**
 * Is a probe result enough to host the official bridge?
 * @param {{importable?:boolean, servicesReady?:boolean}|null|undefined} probe
 * @returns {boolean}
 */
export function officialBridgeFromProbe(probe) {
  return probe?.importable === true && probe?.servicesReady === true;
}

/**
 * Resolve the effective decision.
 *
 * @param {{mode?:"on"|"off"|"auto", probe?:object|null}} [args]
 * @returns {{mode:"on"|"off"|"auto", requested:boolean, active:boolean, reason:string}}
 *          `requested` = 是否请求挂载官方桥（= active；保留字段便于日志区分「显式」与「自动」）
 */
export function resolveOfficialBridge({ mode = "auto", probe = null } = {}) {
  if (mode === "off") {
    return { mode, requested: false, active: false, reason: "env 显式关闭（=0）→ 走 legacy" };
  }
  if (mode === "on") {
    return { mode, requested: true, active: true, reason: "env 显式开启（=1）" };
  }
  const usable = officialBridgeFromProbe(probe);
  return {
    mode,
    requested: usable,
    active: usable,
    reason: usable
      ? "auto：探针可用（importable && servicesReady）"
      : `auto：探针不可用（importable=${probe?.importable ?? "n/a"}, servicesReady=${probe?.servicesReady ?? "n/a"}）→ 降级 legacy`,
  };
}

/**
 * Combine the policy mode with the observed mount outcome into the effective
 * "official path active?" boolean that the runtime switcher consumes (U3).
 *
 *   on   → true   （显式开启，不等探针）
 *   off  → false  （显式关闭）
 *   auto → 只有真正挂上（mountOutcome.mounted === true）才算 active
 *
 * 这是 trigger() 与挂载门之间唯一的判定口径，抽成纯函数以便单测覆盖
 * （尤其 "off" 与「auto 超时未挂上」两条容易写反的分支）。
 *
 * @param {"on"|"off"|"auto"} policy
 * @param {{mounted?:boolean}|null|undefined} mountOutcome
 * @returns {boolean}
 */
export function resolveOfficialActive(policy, mountOutcome) {
  if (policy === "on") return true;
  if (policy === "off") return false;
  return mountOutcome?.mounted === true;
}

/**
 * One-line, greppable stderr/logger text. Callers print this on every boot so an
 * operator can always tell WHY a path was taken (「响亮降级」).
 * @param {{mode:string, active:boolean, reason:string}} decision
 * @returns {string}
 */
export function officialBridgeLogLine(decision) {
  const d = decision ?? { mode: "auto", active: false, reason: "unknown" };
  return `[dsh-acp] official bridge policy=${d.mode} active=${d.active} — ${d.reason}`;
}
