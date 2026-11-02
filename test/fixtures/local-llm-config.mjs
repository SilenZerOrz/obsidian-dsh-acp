// test/fixtures/local-llm-config.mjs — 从本机 dsh profile 读取 LLM 配置（去写死）。
//
// 为什么：真实 LLM 用例过去把内网端点、模型 id 写死在源码里。它们属于**本机部署配置**，
// 不该进仓库。本模块在运行时从 `~/.dsh/profiles/<profile>/cordis.patch.yml` 读取，
// 仓库里只有「怎么读」，没有「读到什么」。
//
// 不引入 yaml 依赖：cordis.patch.yml 结构固定且缩进规整，用极简行扫描即可
// （见 parseLlmSections）。选它而非 `dsh --dump-config`：后者要起 dsh 进程、写 profile、
// 在本环境会 EPERM，且慢；直读文件零副作用、可离线、可在测试 before() 里快跑。
//
// **key 永不落盘**：只返回 apiKeyEnv 的**值**（环境变量名），实际 key 由调用方从 env 取。

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** 默认候选 profile 顺序（DSH_PROFILE 优先，其次 web / headless）。 */
function candidateProfiles(env) {
  const out = [];
  const explicit = env.DSH_PROFILE;
  if (explicit) out.push(explicit);
  for (const p of ["web", "headless", "desktop"]) if (!out.includes(p)) out.push(p);
  return out;
}

function dshHome(env) {
  return env.DSH_HOME || join(homedir(), ".dsh");
}

/**
 * 极简缩进扫描：从顶层 `- id: <sectionId>` 起，收集该块的后续行。
 *
 * ⚠️ 关键：**只有「顶层」`- id:` 才是段落分隔**。段内 `models:` 数组里同样有
 * `- id: DeepSeek-V4-Flash`（缩进更深），它属于本段内容，不是下一段开始。
 * 因此必须记录本段的 `- id:` 缩进（baseIndent），只在「出现同缩进或更浅的 `- id:`」
 * 时才结束本段。
 */
function sectionLines(text, sectionId) {
  const lines = text.split(/\r?\n/);
  const out = [];
  let inSection = false;
  let baseIndent = -1;
  for (const raw of lines) {
    const m = raw.match(/^(\s*)-\s*id:\s*(\S+)\s*$/);
    if (m) {
      const indent = m[1].length;
      if (inSection) {
        // 同缩进或更浅的 `- id:` ⇒ 真的进入下一段
        if (indent <= baseIndent) break;
        // 更深 ⇒ 段内数组项，保留
        out.push(raw);
        continue;
      }
      if (m[2] === sectionId) {
        inSection = true;
        baseIndent = indent;
      }
      continue;
    }
    if (!inSection) continue;
    out.push(raw);
  }
  return out;
}

/**
 * 从 llm-pi-ai 段解析出 providers 映射：
 *   { [providerId]: { baseURL, apiKeyEnv, models: string[] } }
 *
 * 结构（实测 web profile，缩进以空格数标注）：
 *   ind=2  config:
 *   ind=4    providers:
 *   ind=6      deepseeklocal:            ← provider id（providers 的下一层）
 *   ind=8        baseURL: ...
 *   ind=8        apiKeyEnv: ...
 *   ind=8        models:
 *   ind=10         - id: <model>          ← 数组项，比 provider id 更深
 *   ind=6      jl-token:                 ← 下一个 provider id（同缩进 → 换 provider）
 *
 * 判据全靠**相对 providers 的缩进差**，不靠状态机猜。
 */
function parseProviders(sec) {
  const providers = {};
  /** `providers:` 这一行的缩进；-1 = 尚未进入。 */
  let providersIndent = -1;
  /** 当前 provider id 的缩进；-1 = 当前不在任何 provider 内。 */
  let providerIndent = -1;
  let cur = null;
  /** 是否处于某 provider 的 `models:` 数组内。 */
  let inModels = false;
  let modelsIndent = -1;

  for (const raw of sec) {
    if (!raw.trim() || /^\s*#/.test(raw)) continue;
    const indent = raw.match(/^(\s*)/)[1].length;

    if (providersIndent === -1) {
      if (/^\s*providers:\s*$/.test(raw)) providersIndent = indent;
      continue;
    }
    if (indent <= providersIndent) {
      // 退出 providers 段（回到 config 层或更浅）
      providersIndent = -1;
      cur = null;
      providerIndent = -1;
      inModels = false;
      continue;
    }

    // ---- models 数组内 ----
    if (inModels) {
      const modelM = raw.match(/^\s*-\s*id:\s*(.+?)\s*$/);
      if (modelM) { providers[cur].models.push(modelM[1]); continue; }
      // 缩进 <= models 行 ⇒ 退出数组（可能是同 provider 的下一个 key，或下一个 provider）
      if (indent <= modelsIndent) inModels = false;
      else continue; // 数组项的其它字段（如 name:）跳过
    }

    const keyM = raw.match(/^(\s*)([A-Za-z0-9_.-]+):\s*(.*)$/);
    if (!keyM) continue;
    const [, ws, k, v] = keyM;
    const ind = ws.length;

    // 新 provider：缩进比当前 provider 更浅或相等，且是个「裸 key:」
    if (providerIndent === -1 || ind <= providerIndent) {
      if (v === "" && !["providers", "config", "models"].includes(k)) {
        // 但必须先确认它确实是 providers 的直接子层（避免把 config: 当成 provider）
        if (providerIndent === -1 ? ind === providersIndent + 2 : ind === providerIndent) {
          cur = k;
          providers[cur] = { models: [] };
          providerIndent = ind;
          inModels = false;
          continue;
        }
      }
    }

    if (!cur || ind <= providerIndent) continue;

    if (k === "models" && v === "") { inModels = true; modelsIndent = ind; continue; }
    if (k === "baseURL") providers[cur].baseURL = v;
    else if (k === "apiKeyEnv") providers[cur].apiKeyEnv = v;
  }
  return providers;
}

/** 从 agent-default-model 段取出 { provider, model }。 */
function parseDefaultModel(sec) {
  let provider = null;
  let model = null;
  for (const raw of sec) {
    const m = raw.match(/^\s*(provider|model):\s*(.+?)\s*$/);
    if (!m) continue;
    if (m[1] === "provider") provider = m[2];
    else model = m[2];
  }
  return { provider, model };
}

/**
 * 读取本机 dsh profile 的 LLM 配置。
 *
 * @param {{ env?: NodeJS.ProcessEnv }} [opts]
 * @returns {null | {
 *   profile: string, configPath: string,
 *   provider: string, model: string,
 *   base: string, apiKeyEnv: string, models: string[],
 * }}
 *   null = 本机没有可用配置（调用方应 skip）。
 */
export function readLocalLlmConfig(opts = {}) {
  const env = opts.env ?? process.env;
  const home = dshHome(env);

  for (const profile of candidateProfiles(env)) {
    const configPath = join(home, "profiles", profile, "cordis.patch.yml");
    if (!existsSync(configPath)) continue;

    let text;
    try { text = readFileSync(configPath, "utf8"); } catch { continue; }

    const providers = parseProviders(sectionLines(text, "llm-pi-ai"));
    const providerIds = Object.keys(providers);
    if (providerIds.length === 0) continue;

    const def = parseDefaultModel(sectionLines(text, "agent-default-model"));

    // 优先用 agent-default-model 指定的 provider；否则取第一个有 baseURL 的。
    let provider = def.provider && providers[def.provider] ? def.provider : null;
    if (!provider) provider = providerIds.find((id) => providers[id].baseURL) ?? providerIds[0];

    const p = providers[provider] ?? {};
    const model = (def.model && def.provider === provider && def.model)
      || (p.models && p.models[0])
      || null;

    if (!p.baseURL || !model) continue;

    return {
      profile,
      configPath,
      provider,
      model,
      base: p.baseURL,
      apiKeyEnv: p.apiKeyEnv ?? null,
      models: p.models ?? [],
    };
  }
  return null;
}

/**
 * 便捷：取「本机配置 + env 里的 key」。
 * key 只在返回值里（来自 env），**不写盘、不打印**。
 *
 * @param {{ env?: NodeJS.ProcessEnv }} [opts]
 * @returns {null | { profile, configPath, provider, model, base, key }}
 */
export function readLocalLlmCredential(opts = {}) {
  const env = opts.env ?? process.env;
  const cfg = readLocalLlmConfig({ env });
  if (!cfg) return null;
  const key = cfg.apiKeyEnv ? env[cfg.apiKeyEnv] : undefined;
  return { ...cfg, key };
}
