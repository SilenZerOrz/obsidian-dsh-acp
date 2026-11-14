// lib/package-version.mjs — 本包版本号的单一真源（R145 / 卡 -75）。
//
// 背景：`agentInfo.version`（dsh-acp.mjs）与 `HTTP_GATEWAY_VERSION`
// （lib/http-gateway.mjs）曾各自硬编码，两处都与 package.json 漂移
// （"0.2.0" / "0.2.6-dev" vs package.json 的 0.4.0），而这两处都对
// ACP 客户端 / probe 消费者可见。改为都从这里读 package.json 的 version，
// 升级时只改 package.json 一个地方。
//
// 注意：package.json 恒定随包发布（package.json `files` 已含它），
// 读取失败即抛出——与 doctor.mjs::ADAPTER_VERSION 的做法一致，不吞错。

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const PKG_PATH = join(dirname(fileURLToPath(import.meta.url)), "..", "package.json");

/** 本包版本号（= package.json 的 `version`）。 */
export const PACKAGE_VERSION = JSON.parse(
  readFileSync(PKG_PATH, "utf8").replace(/^\uFEFF/, ""),
).version;
