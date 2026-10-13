// lib/selfcheck/registry.mjs — 包管理器 + registry 选择
//
// 2026-10-13 重建。SELFCHECK.md §11：Windows execution policy 拦截 bare
// `npm` / `pnpm` / `npm.ps1`，所以 buildPackageCommand 始终输出
// `node <script>` 形态，不让 shell 拼路径。

import { isFile, readTextFile, resolveRoots } from "./paths.mjs";

/** npm / pnpm 候选（按优先级）。恒走 node + cli-script 形态。 */
const PKG_MANAGERS = Object.freeze({
  npm: {
    name: "npm",
    /** 相对 adapter 根的 npm cli 路径（pnpm/npm 通用） */
    cliPath: "./node_modules/npm/bin/npm-cli.js",
    /** 强制 -y + --registry。 */
    buildArgs(args = [], registry) {
      const out = [...args];
      if (registry) out.push(`--registry=${registry}`);
      return out;
    },
  },
  pnpm: {
    name: "pnpm",
    cliPath: "./node_modules/pnpm/bin/pnpm.cjs",
    buildArgs(args = [], registry) {
      const out = [...args];
      if (registry) out.push(`--registry=${registry}`);
      return out;
    },
  },
});

/** 默认 registry（带尾部斜杠） */
const DEFAULT_REGISTRY = "https://registry.npmjs.org/";
/** Fallback 镜像（CN） */
const FALLBACK_REGISTRY = "https://registry.npmmirror.com/";

/**
 * 选择 registry URL。env 优先，否则默认。
 * @param {object} [env] 默认 process.env
 * @returns {string}
 */
export function selectRegistry(env = process.env) {
  return env.NPM_CONFIG_REGISTRY
    || env.npm_config_registry
    || DEFAULT_REGISTRY;
}

/** Fallback mirror。 */
export function fallbackRegistry() {
  return FALLBACK_REGISTRY;
}

/**
 * 探测当前 adapter 根使用的包管理器。
 * 优先级：packageManager 字段（pnpm@x）→ lockfile (pnpm-lock.yaml / package-lock.json) → npm。
 * @param {object} [roots] 默认 resolveRoots()
 * @returns {Promise<{name: "npm"|"pnpm", cliPath: string, source: string}>}
 */
export async function resolvePackageManager(roots = resolveRoots()) {
  const pkgJson = readTextFile(`${roots.adapter}/package.json`);
  if (pkgJson) {
    try {
      const j = JSON.parse(pkgJson);
      if (j.packageManager) {
        const m = /^([a-z]+)@/.exec(j.packageManager);
        if (m && PKG_MANAGERS[m[1]]) {
          return { name: m[1], cliPath: PKG_MANAGERS[m[1]].cliPath, source: "packageManager" };
        }
      }
    } catch { /* ignore */ }
  }
  if (isFile(`${roots.adapter}/pnpm-lock.yaml`)) {
    return { name: "pnpm", cliPath: PKG_MANAGERS.pnpm.cliPath, source: "pnpm-lock.yaml" };
  }
  if (isFile(`${roots.adapter}/package-lock.json`)) {
    return { name: "npm", cliPath: PKG_MANAGERS.npm.cliPath, source: "package-lock.json" };
  }
  return { name: "npm", cliPath: PKG_MANAGERS.npm.cliPath, source: "default" };
}

/**
 * 构造 `node + cli-script + args` 形态的执行规范。
 * 关键：绝不返回 bare `npm` / `pnpm` —— SELFCHECK.md §11 的硬要求。
 * @param {"npm"|"pnpm"} pm
 * @param {string[]} args     用户传入的 args（不含 --registry）
 * @param {object} [opts]
 * @param {string} [opts.registry] 注入 --registry
 * @param {string} [opts.cliPath]  覆盖 cli 路径
 * @param {string} [opts.cwd]      override cwd
 * @returns {{cmd:string, args:string[], cwd:string, registry:string|null}}
 */
export function buildPackageCommand(pm, args = [], opts = {}) {
  const m = PKG_MANAGERS[pm] ?? PKG_MANAGERS.npm;
  const cliPath = opts.cliPath ?? m.cliPath;
  const registry = opts.registry ?? null;
  const built = m.buildArgs([...args], registry);
  return {
    cmd: "node",
    args: [cliPath, ...built],
    cwd: opts.cwd ?? process.cwd(),
    registry,
  };
}
