// dsh-acp — cordis plugin entry.
//
// Registers the `dsh.acp` service and manages the standalone dsh-acp ACP
// adapter process (dsh-acp.mjs) as a child of the DeepSeek Harness context.
//
// The adapter's ACP *server binary* stays standalone (`bin: dsh-acp`, see
// dsh-acp.mjs) so a GUI ACP client (Obsidian Agent Client) can spawn it
// directly. This plugin provides the complementary "harness-managed" path:
// it exposes a `dsh.acp` service to other DSH plugins and keeps the adapter
// process running (forwards env, restarts on crash, disposes on teardown).
//
// Enabled via `dsh plugin --profile <name> add dsh-acp` (see cordis.patch.yml),
// which inserts the entry defined here into the profile's plugin tree.
//
// P1b: 在 web profile 下注入 /api-session/* 路由（前端面板 lib/client.js
// 经 fetch 调后端，复用 P1a 的 session-manage.mjs / archive-store.mjs）。
// webServer 是可选 host 服务且晚挂载——apply 期 ctx.get('webServer') 仍为空，
// 必须经 ctx.inject(['webServer'], ...) 在服务可用时再注册路由；headless /
// 无 Web 的 profile（CI 冒烟、CLI-only 场景）回调永不执行，ACP adapter 与
// manage CLI 路径不受影响，插件不因缺服务抛错激活失败。
//
// P2 升级：路由同时读 / 写 dsh 原生会话（sp.list / sp.readFrom / agents.create），
// 让左侧侧栏能看见 Obsidian 导入的会话、可 dsh 接续、共享工具 + preset + 自动压缩。
// sessionPersistence / agents / workspaceRegistry / sessionProjectionCache / agentPresets
// / llm / agentDefaultModel 都是可选 host 服务——handler 闭包内通过 ctx.get(...) 延迟
// 读取；任一缺失时原生路由返回 503（旧 ~/.dsh-acp 路由仍可用），不阻塞 ACP adapter /
// manage CLI。注册入口把 ctx 一并传给 registerSessionPanelRoutes（handler 需访问 host
// 服务），与 dsh-chat-import 同样的晚挂载策略。

// 2026-09-17 S6 fix：cordis logger 在某些 profile 不接 stdout（只有内部 buffer），
// 实测 dsh-cost-meter 用 console.log 才能看见 [dsh-cost-meter] 已加载。
// 给 dsh-acp 加 console.log 双写兜底，避免排查时以为 plugin 没加载 / runtime 没生效。
import { appendFileSync } from "node:fs";
const _acpLog = (level, msg) => {
	const line = `[dsh-acp] ${msg}`;
	// eslint-disable-next-line no-console
	if (level === "error") console.error(line);
	else if (level === "warn") console.warn(line);
	else console.log(line);
	// S6 debug：写到独立文件，绕过任何 stdout 屏蔽问题
	try {
		appendFileSync("/tmp/dsh-acp-debug.log", `${new Date().toISOString()} [${level}] ${line}\n`);
	} catch {}
};
// 模块顶层自检：apply() 都不跑，至少知道 module 被 require 了
_acpLog("info", "module TOP-LEVEL loaded (file=index.mjs pid=" + process.pid + " ppid=" + process.ppid + ")");

// 2026-09-17 S6 回滚：删 EMERGENCY-1/2/3 sync spawn 块（48-103 行）。
// 选项 D 已确认 = Obsidian 端独立 spawn `node dsh-acp.mjs`，完全绕开 dsh web
// 加载 index.mjs 这一段 cordis fiber 死锁区。Obsidian Agent Client 配置 custom
// agent = `node /path/to/dsh-acp.mjs` 即可（v0.2.x 原始设计），不再依赖 dsh web
// 加载 index.mjs / DshAcpService 构造函数内的任何 ctx.on("app/ready") / setTimeout
// 兜底。S6 详细根因与方案对比见踩坑经验 obsidian-dsh-acp-S6-cordis-event-lifecycle踩坑.md。

import { Service } from "@deepseek-ai/cordis";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import z from "@deepseek-ai/schemastery";
import { registerSessionPanelRoutes } from "./web/session-panel.mjs";
import { registerHttpGateway } from "./lib/http-gateway.mjs";
import { resolveRuntimeConfig, resolvePermissionConfig } from "./lib/runtime-switch.mjs";
import { hasP2Apis } from "./lib/version-detect.mjs";

/**
 * Manages the dsh-acp ACP adapter subprocess for the harness and exposes the
 * `dsh.acp` service so other plugins can interact with it.
 */
export class DshAcpService extends Service {
	/** The spawned adapter ChildProcess (null until started). */
	process = null;

	/**
	 * @param ctx - cordis context this service is mounted on.
	 * @param config - plugin config.
	 */
	constructor(ctx, config = {}) {
		super(ctx, "dsh.acp");
		this.config = config;
		this._stopped = false;
		this._backoffMs = 0;
		this._restartTimer = null;
		this._longRt = null;

		// headless profile MUST stay spawn — long mode requires cordis ctx,
		// which the cordis plugin already has, but a headless profile is meant
		// for stateless CLI usage where spawning is the only safe default.
		if (config.profile === "headless" && config.runtime?.mode === "long") {
			ctx.logger?.warn?.("[dsh-acp] runtime.mode='long' is incompatible with profile='headless'; forcing 'spawn'");
			config = { ...config, runtime: { ...(config.runtime || {}), mode: "spawn" } };
			this.config = config;
		}

		if (config.spawn !== false) {
			// Start the adapter once the harness app is ready.
			//
			// 2026-09-17 S6 fix: dsh 0.1.6-alpha.1 removed the `app/ready` cordis
			// event (the web app no longer emits it — readiness is signalled by
			// `loader.await()` resolving + connection+webServer services present,
			// see @deepseek-ai/dsh-web-app/lib/index.js:213-216). We must await
			// loader.await() ourselves instead of relying on ctx.on("app/ready").
			//
			// Implementation: 多次重试 `ctx.get("loader")`（cordis service lookup
			// 在 plugin apply 时不一定就绪），拿到后 await()。失败 fallback
			// 老路径 app/ready + 5s setTimeout 兜底，确保 0.1.5-rc.x 也 work。
			let _bootTriggered = false;
			const trigger = (reason) => {
				if (_bootTriggered) return;
				_bootTriggered = true;
				_acpLog("info", `boot trigger: ${reason} — resolving runtime mode`);
				const env = { ...process.env, DSH_IN_CORDIS: "1" };
				if (config.runtime?.mode) env.DSH_ACP_RUNTIME_MODE = config.runtime.mode;
				const rtConfig = resolveRuntimeConfig(env);
				const useLong = rtConfig.mode === "long";
				const msg = `effective runtime mode = ${rtConfig.mode} (P2 APIs available: ${hasP2Apis()}; spawnFallback: ${rtConfig.spawnFallback})`;
				_acpLog("info", msg);
				this.ctx?.logger?.info?.(`[dsh-acp] ${msg}`);
				const boot = useLong ? this.startLong() : this.start();
				boot
					.then((rt) => {
						_acpLog("info", `boot resolved: useLong=${useLong} rt=${rt ? rt.constructor.name : "null"}`);
					})
					.catch((err) => {
						const errMsg = `startLong() failed (${err && err.message ? err.message : String(err)}); falling back to spawn`;
						_acpLog("error", `boot REJECTED: ${err && err.stack ? err.stack : String(err)}`);
						if (useLong && rtConfig.spawnFallback) {
							_acpLog("warn", errMsg);
							this.ctx?.logger?.warn?.(`[dsh-acp] ${errMsg}`);
							return this.start().catch((e2) => {
								_acpLog("error", `start() spawn fallback ALSO failed: ${e2 && e2.message ? e2.message : String(e2)}`);
								throw e2;
							});
						}
						_acpLog("error", String(err));
						this.ctx?.logger?.error?.(String(err));
					});
			};

			const tryLoaderAwait = (attempt = 0) => {
				const loader = ctx.get?.("loader");
				if (loader && typeof loader.await === "function") {
					_acpLog("info", `loader service found (attempt ${attempt}); calling await()`);
					loader
						.await()
						.then(() => trigger("loader.await() resolved"))
						.catch((e) => _acpLog("error", `loader.await() rejected: ${e?.message ?? String(e)}`));
					return true;
				}
				return false;
			};

			// 优先：用 inject 等 loader service
			if (typeof ctx.inject === "function") {
				ctx.inject(["loader"], (loaderCtx) => {
					_acpLog("info", `ctx.inject([loader]) fired (loader=${loaderCtx?.loader?.constructor?.name})`);
					if (!tryLoaderAwait(0)) {
						_acpLog("warn", "loader service still missing after inject; falling back to polling + setTimeout");
						// 兜底：轮询 + 老路径
						let polls = 0;
						const poll = setInterval(() => {
							polls += 1;
							if (tryLoaderAwait(polls)) clearInterval(poll);
							else if (polls > 20) { clearInterval(poll); _acpLog("warn", "polling exhausted after 20 tries; using setTimeout fallback"); }
						}, 250);
						ctx.on("app/ready", () => trigger("legacy app/ready event"));
						setTimeout(() => trigger("setTimeout 5s hard fallback"), 5000);
					}
				});
			} else {
				// 无 inject — 老路径
				ctx.on("app/ready", () => trigger("legacy app/ready event (no inject)"));
				setTimeout(() => trigger("setTimeout 5s (no inject)"), 5000);
			}

			// S6 fix 兜底：3s setTimeout 总是触发，不依赖任何 event / service 是否 ready。
			// dsh 0.1.6-alpha.1 + cordis-plugin-loader 时序不确定（ctx.inject 回调可能
			// 永远不触发），但 dsh web 整体 boot 后 3s 内一定可以 spawn 子进程。
			// S4 测试验证：在 dsh web 起来后 3s 触发 trigger，能成功 spawn dsh-acp.mjs。
			setTimeout(() => trigger("setTimeout 3s unconditional fallback"), 3000);
		}

		// Tie adapter shutdown to the owning fiber's disposal.
		ctx.on("dispose", () => this.stop());
	}

	/** Absolute path to the standalone ACP adapter (dsh-acp.mjs). */
	adapterPath() {
		if (this.config.adapterPath) return this.config.adapterPath;
		return fileURLToPath(new URL("dsh-acp.mjs", import.meta.url));
	}

	/**
	 * Spawn the dsh-acp adapter as a child of this harness process.
	 * Returns the ChildProcess, or the existing one if already running.
	 *
	 * P2 long-mode: when `runtime.mode === "long"` the cordis plugin hosts the
	 * long-runtime IN-PROCESS (no child spawn) so it can access dsh's cordis
	 * ctx directly. For long mode, the caller should use `startLong()` instead.
	 */
	async start() {
		if (this.process) return this.process;
		// A scheduled restart that hasn't fired yet is superseded by a manual start.
		this.clearRestartTimer();
		this.abortController?.abort();
		this.abortController = new AbortController();

		const dshBin =
			process.env.DSH_BIN ??
			process.env.DSH_ACP_DSH ??
			(process.env.DSH_HOME ? `${process.env.DSH_HOME}/bin/dsh` : undefined) ??
			"dsh";

		const child = spawn(process.execPath, [this.adapterPath()], {
			stdio: ["pipe", "pipe", "pipe"],
			env: {
				...process.env,
				DSH_BIN: dshBin,
				DSH_PROFILE: this.config.profile ?? process.env.DSH_PROFILE ?? "headless",
				// Tell the child which runtime mode to use (it reads
				// DSH_ACP_RUNTIME_MODE via lib/runtime-switch.mjs).
				DSH_ACP_RUNTIME_MODE: this.config.runtime?.mode === "long" ? "spawn" : "spawn",
				DSH_ACP_SPAWN_FALLBACK: this.config.runtime?.spawnFallback === false ? "false" : "true",
				DSH_ACP_PERMISSION_MODE: this.config.permission?.mode ?? "default",
				// Phase B: timeoutMs is deprecated — only forward when the
				// operator has explicitly set one (mostly for backward
				// diagnostic visibility). The new PermissionGate ignores it.
				...(this.config.permission?.timeoutMs !== undefined
					? { DSH_ACP_PERMISSION_TIMEOUT_MS: String(this.config.permission.timeoutMs) }
					: {}),
				DSH_ACP_PERMISSION_EDIT_TOOLS: (this.config.permission?.editTools ?? ["Edit", "Write", "MultiEdit", "NotebookEdit"]).join(","),
				DSH_ACP_PERMISSION_ENABLE_ROOT_BYPASS: this.config.permission?.enableRootBypass === true ? "true" : "false",
				...this.config.env,
			},
			signal: this.abortController.signal,
		});

		child.stdout?.on("data", (d) => this.ctx?.logger?.info?.(d.toString().trimEnd()));
		child.stderr?.on("data", (d) => this.ctx?.logger?.warn?.(d.toString().trimEnd()));

		child.on("exit", (code, signal) => {
			const aborted = this.abortController?.signal.aborted ?? false;
			this.process = null;
			this.abortController = null;
			if (aborted || this._stopped) return; // intentional shutdown
			this.ctx?.logger?.warn?.(`dsh-acp adapter exited unexpectedly (code=${code} signal=${signal}); restarting`);
			this.scheduleRestart();
		});

		this.process = child;
		// It got back up: give the next crash a fresh, low backoff delay.
		this._backoffMs = BACKOFF_MIN;
		this.ctx?.logger?.info?.(`dsh-acp adapter started (pid=${child.pid})`);
		return child;
	}

	/**
	 * P2 long mode: host long-runtime IN-PROCESS so it can directly access
	 * the harness's cordis ctx (ctx.llm / ctx.agents / ctx.sessionPersistence).
	 * No child spawn, no IPC. P1.0: throws a placeholder error from the
	 * long-runtime's init(); P1.5 will wire ctx.llm.stream and agent events.
	 *
	 * Returns the singleton LongRuntime instance on success.
	 */
	async startLong() {
		if (this._longRt) return this._longRt;
		const { getLongRuntime } = await import("./lib/long-runtime.mjs");
		const rt = getLongRuntime();
		await rt.init({
			cordisCtx: this.ctx,
			acpClient: null, // wired in P2.5+ when long path serves ACP traffic
			permissionConfig: resolvePermissionConfig(),
			cwd: process.cwd(),
		});
		this._longRt = rt;
		return rt;
	}

	/** Schedule a restart with exponential backoff to avoid a crash loop (REQ-05). */
	scheduleRestart() {
		if (this._stopped) return;
		// First crash: wait BACKOFF_MIN; double each retry up to BACKOFF_MAX.
		const delay = this._backoffMs || BACKOFF_MIN;
		this._backoffMs = Math.min(delay * 2, BACKOFF_MAX);
		this.ctx?.logger?.info?.(`dsh-acp adapter restart in ${delay}ms`);
		this._restartTimer = setTimeout(() => {
			this._restartTimer = null;
			if (this._stopped) return;
			this.start().catch((err) => this.ctx?.logger?.error?.(String(err)));
		}, delay);
	}

	clearRestartTimer() {
		if (this._restartTimer) {
			clearTimeout(this._restartTimer);
			this._restartTimer = null;
		}
	}

	/** Stop the adapter if it is running. */
	async stop() {
		this._stopped = true;
		this.clearRestartTimer();
		this.abortController?.abort();
		if (this.process) {
			this.process.kill("SIGTERM");
			this.process = null;
		}
		if (this._longRt) {
			try { await this._longRt.dispose(); } catch { /* ignore */ }
			this._longRt = null;
		}
	}

	/** Dispose: stop the adapter before the owning fiber is torn down. */
	async dispose() {
		await this.stop();
	}
}

// Backoff window for crash-restart (REQ-05).
const BACKOFF_MIN = 250;
const BACKOFF_MAX = 30000;

/** Plugin identity and integrated config schema. */
export const name = "dsh-acp";
// 2026-09-17 S6: dsh-cost-meter 等参考实现都用空 inject + apply() 里 ctx.inject()。
// 真正的 "我依赖 loader service" 声明在 apply() 里通过 ctx.inject(["loader"], ...) 做。
export const inject = [];

/** Config: `{ spawn?, adapterPath?, profile?, env?, runtime?, permission?, enableWebPanel? }`.
 * 用 @deepseek-ai/schemastery 的 z.object，cordis 才能识别 `~standard`，
 * 否则手写 plain object 会让 resolveConfig 访问 Config["~standard"]（undefined）
 * 触发 "Cannot read properties of undefined (reading 'validate')"。
 *
 * P2 additions:
 *   - `runtime.mode` — "long" (in-process) or "spawn" (child dsh-acp.mjs). Default "spawn"
 *     to keep the current behavior; long mode is opt-in via Config or env.
 *   - `runtime.spawnFallback` — if true (default), long init failure falls back to spawn.
 *   - `permission.{mode,editTools,enableRootBypass}` — 4-mode permission gate; consumed by
 *     both the cordis plugin (long) and the spawned adapter (env-mirrored). The legacy
 *     `permission.timeoutMs` is now optional and ignored (see the Phase B
 *     permission-linkage notes in the project's local dev docs).
 */
export const Config = z.object({
	spawn: z.boolean().default(true),
	adapterPath: z.string().default(""),
	profile: z.string().default("headless"),
	env: z.dict(z.any()).default({}),
	// P1b 面板：是否向 dsh web 注册 /api-session/* 路由。
	// v0.2.3 起 **默认开启**（恢复 npm 发布版含 dsh web UI 面板：lib/client.js + 后端
	// 路由 /api-session/*）。v0.2.1 曾拆分隐藏 UI 表面（后端保留），仅作测试版分支；
	// v0.2.3 整合 #28 归档删除 + #30 subTab 合并 + #22 FE-1 模型供应商切换——UI 必含。
	// 仍可通过 `enableWebPanel: false` 显式关闭。headless / CI 无 webServer 时默认
	// 行为不变（ctx.inject 回调不触发，路由不挂）。
	enableWebPanel: z.boolean().default(true),
	// P2 long-runtime config. NOTE: schemastery 用 `z.const(value)` 表达字面量
	// （没有 z.enum / z.literal），`z.union([z.const(...), ...])` 表达枚举。
	// 错误用例会抛 "z.enum is not a function" / "z.literal is not a function"。
	runtime: z.object({
		mode: z.union([z.const("long"), z.const("spawn")]).default("spawn"),
		spawnFallback: z.boolean().default(true),
	}).default({}),
	// P2 permission gate config. 同上 schemastery 用 z.union([z.const(...), ...])。
	permission: z.object({
		mode: z.union([
			z.const("default"),
			z.const("acceptEdits"),
			z.const("dontAsk"),
			z.const("bypassPermissions"),
		]).default("default"),
		// Phase B: timeoutMs is deprecated — kept as optional for backward
		// compat with existing config files but no longer consumed by
		// PermissionGate. The gate now races against an AbortSignal.
		// NOTE: schemastery marks optional via `.required(false)` (not zod's
		// `.optional()`). See memory `dsh-schemastery-not-zod`.
		timeoutMs: z.number().required(false),
		editTools: z.array(z.string()).default(["Edit", "Write", "MultiEdit", "NotebookEdit"]),
		// Phase B: when true, bypassPermissions is honored even when
		// process.geteuid() === 0 (mirrors official IS_SANDBOX=1). Defaults
		// to false to match the official "non-root only" default.
		enableRootBypass: z.boolean().default(false),
	}).default({}),
});

/**
 * Loader entry: mount the service on the plugin's context.
 * @param ctx - context the loader handed this plugin.
 * @param config - loader-provided config.
 */
export function apply(ctx, config) {
	// Register the service (constructor calls super(ctx, 'dsh.acp')).
	// Lifecycle cleanup lives entirely in the constructor's
	// `ctx.on("dispose", () => this.stop())` — no separate listener here, so
	// dispose ordering can never null t. process before stop() can SIGTERM it
	// (REQ-06).
	_acpLog("info", `plugin loaded (config=${JSON.stringify({ profile: config.profile, enableWebPanel: config.enableWebPanel, runtime: config.runtime, permission: config.permission })})`);

	// 2026-09-17 S6 回滚：恢复 `new DshAcpService(ctx, config)` 正常路径。
	// 选项 D 已确认 = Obsidian 端独立 spawn dsh-acp.mjs（见上注释 + 踩坑 doc），
	// 不再需要 apply() 兜底同步 spawn。下游 web 面板路由 (ctx.inject(["webServer"]))
	// 仍依赖 ctx，所以 svc 必须真是 DshAcpService 实例（不能是 stub），让 dispose
	// 与 web 路由 hook 正常工作。
	const svc = new DshAcpService(ctx, config);

	// P1b web 面板路由：仅当 enableWebPanel=true 时挂载 /api-session/*（默认开）。
	// webServer 是可选 host 服务且晚挂载——apply 时 ctx.get('webServer') 仍为空，
	// 用 ctx.inject(['webServer'], ...) 在服务可用时再注册路由：headless / CI 冒烟
	//（无 webServer）时回调永不执行，ACP adapter 与 manage CLI 照常可用，apply
	// 不因缺服务失败（与 dsh-chat-import 同样的晚挂载策略）。P2：把 ctx 一并传给
	// registerSessionPanelRoutes，让原生路由（dsh-list / dsh-read / obsidian-import）
	// 通过 ctx.get('sessionPersistence' | 'agents' | ...) 访问 host 服务。
	if (config.enableWebPanel !== false && typeof ctx.inject === "function") {
		ctx.inject(["webServer"], (webCtx) => {
			if (webCtx && webCtx.webServer && typeof webCtx.webServer.register === "function") {
				registerSessionPanelRoutes(ctx, webCtx.webServer);
				ctx?.logger?.info?.("[dsh-acp] web 面板路由已注册: /api-session/{list,export,archive,move,dsh-list,dsh-read,obsidian-list,obsidian-import}");
				// P3.0 commit 2: 暴露 dsh-acp proxy 端点(probe + prompt SSE),让独立
				// dsh-acp.mjs 进程能经 HTTP/SSE 调 long-runtime,无需 cordis ctx。
				// 路由已挂载,long-runtime 仍 lazy init(在第一次 prompt 触发)。
				registerHttpGateway(ctx, webCtx.webServer);
				ctx?.logger?.info?.("[dsh-acp] HTTP gateway 已注册: /acp/proxy/{probe,session/prompt}");
			}
		});
	}

	return svc;
}

export default {
	name,
	inject,
	Config,
	apply,
};