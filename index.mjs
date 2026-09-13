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

import { Service } from "@deepseek-ai/cordis";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import z from "@deepseek-ai/schemastery";
import { registerSessionPanelRoutes } from "./web/session-panel.mjs";

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

		if (config.spawn !== false) {
			// Start the adapter once the harness app is ready.
			ctx.on("app/ready", () => {
				this.start().catch((err) => this.ctx?.logger?.error?.(String(err)));
			});
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
export const inject = [];

/** Config: `{ spawn?, adapterPath?, profile?, env? }`.
 * 用 @deepseek-ai/schemastery 的 z.object，cordis 才能识别 `~standard`，
 * 否则手写 plain object 会让 resolveConfig 访问 Config["~standard"]（undefined）
 * 触发 "Cannot read properties of undefined (reading 'validate')"。
 */
export const Config = z.object({
	spawn: z.boolean().default(true),
	adapterPath: z.string().default(""),
	profile: z.string().default("headless"),
	env: z.dict(z.any()).default({}),
	// P1b 面板：是否向 dsh web 注册 /api-session/* 路由。
	// v0.2.1 起 **默认关闭**（npm 发布版不展示 dsh web UI 面板；前端 client.js 不在
	// files 列表）。后端路由文件（web/session-panel.mjs 等）保留，仍可通过
	// `dsh.client.web` 显式传入 `enableWebPanel: true` 启用（仅作开发/测试用，
	// 不会进入 npm 包的 UI 表面）。headless / CI 无 webServer 时默认行为不变。
	enableWebPanel: z.boolean().default(false),
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