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

import { Service } from "@deepseek-ai/cordis";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import z from "@deepseek-ai/schemastery";

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
			if (aborted) return; // intentional shutdown / restart
			this.ctx?.logger?.warn?.(`dsh-acp adapter exited (code=${code} signal=${signal})`);
		});

		this.process = child;
		this.ctx?.logger?.info?.(`dsh-acp adapter started (pid=${child.pid})`);
		return child;
	}

	/** Stop the adapter if it is running. */
	async stop() {
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
});

/**
 * Loader entry: mount the service on the plugin's context.
 * @param ctx - context the loader handed this plugin.
 * @param config - loader-provided config.
 */
export function apply(ctx, config) {
	// Register the service (constructor calls super(ctx, 'dsh.acp')).
	const service = new DshAcpService(ctx, config);
	// Clean up state if the plugin is disabled at runtime.
	ctx.on("dispose", () => {
		service.process = null;
	});
	return service;
}

export default {
	name,
	inject,
	Config,
	apply,
};
