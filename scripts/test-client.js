#!/usr/bin/env node
// ACP client test harness for dsh-acp.
//
// Mimics what Obsidian's "Agent Client" plugin does: spawn the dsh-acp adapter
// as a subprocess, connect a ClientApp over its stdio, initialize a session,
// and send a prompt. Prints each session/update and the final PromptResponse.
//
// Usage:
//   node test-client.js "<prompt>"
//
// Set DSH_BIN in the environment to substitute the backend (e.g. "echo") when
// you want to verify the ACP protocol layer in isolation.

import { client, methods, ndJsonStream } from "@agentclientprotocol/sdk";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const prompt = process.argv[2] ?? "say hello";

function nodeToWebWritable(nodeStream) {
  return new WritableStream({
    write(chunk) {
      return new Promise((resolve, reject) => {
        nodeStream.write(Buffer.from(chunk), (err) => (err ? reject(err) : resolve()));
      });
    },
  });
}
function nodeToWebReadable(nodeStream) {
  return new ReadableStream({
    start(controller) {
      nodeStream.on("data", (chunk) => controller.enqueue(new Uint8Array(chunk)));
      nodeStream.on("end", () => controller.close());
      nodeStream.on("error", (err) => controller.error(err));
    },
  });
}

// Spawn the dsh-acp adapter DIRECTLY as the executable (no `node` prefix),
// exactly like Obsidian's Agent Client does via the custom-agent `command`.
// Defaults to the sibling `dsh-acp.js` in this repo; override with DSH_ACP_BIN.
const adapterBin =
  process.env.DSH_ACP_BIN ?? fileURLToPath(new URL("./dsh-acp.js", import.meta.url));
const child = spawn(adapterBin, [], {
  cwd: process.cwd(),
  env: { ...process.env },
  stdio: ["pipe", "pipe", "pipe"],
});
child.stderr.on("data", (d) => process.stderr.write("[adapter-stderr] " + d));

const stream = ndJsonStream(nodeToWebWritable(child.stdin), nodeToWebReadable(child.stdout));

const app = client({ name: "dsh-acp-test" })
  .onNotification(methods.client.session.update, (ctx) => {
    const u = ctx.params.update;
    if (u.sessionUpdate === "agent_message_chunk") {
      process.stdout.write(u.content.text);
    } else {
      process.stdout.write(`\n[update:${u.sessionUpdate}]\n`);
    }
  });

const deadline = setTimeout(() => {
  process.stderr.write("\n[test] TIMEOUT\n");
  child.kill("SIGKILL");
  process.exit(1);
}, 120000);

await app.connectWith(stream, async (ctx) => {
  process.stdout.write(`== initialize: agent=${ctx.agent ? "connected" : "?"}\n`);

  // Create a session in the current cwd and send a prompt.
  const session = await ctx.buildSession(process.cwd()).start();
  process.stdout.write(`\n== session created: ${session.sessionId}\n`);
  process.stdout.write(`== >> ${prompt}\n`);

  const resp = await session.prompt(prompt);
  process.stdout.write(`\n== stopReason=${resp.stopReason}\n`);
});

clearTimeout(deadline);
process.stdout.write("\n== OK: protocol round-trip completed\n");
child.kill();
process.exit(0);
