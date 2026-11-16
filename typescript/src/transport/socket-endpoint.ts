/**
 * socket 路径解析，与 `zuno-harness-api::sockets` 一一对应。
 *
 * bridge 和每个客户端必须解析出同一个目录，否则无法连接，
 * 所以这里的规则严格跟随 Rust 模块。
 */

import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";

export function runtimeDir(): string {
  const explicit = process.env.ZUNO_RUNTIME_DIR;
  if (explicit) return explicit;
  const xdg = process.env.XDG_RUNTIME_DIR;
  if (xdg) return xdg;
  if (process.platform === "darwin" && process.env.TMPDIR) {
    return process.env.TMPDIR;
  }
  return path.join(os.tmpdir(), `zuno-${userDiscriminator()}`);
}

function userDiscriminator(): string {
  const raw =
    process.platform === "win32"
      ? (process.env.USERNAME ?? process.env.USER)
      : (process.env.UID ?? process.env.USER);
  return sanitize(raw ?? "user");
}

function sanitize(raw: string): string {
  const out = raw
    .split("")
    .filter((ch) => /[A-Za-z0-9\-_]/.test(ch))
    .slice(0, 64)
    .join("");
  return out === "" ? "user" : out;
}

/**
 * 给定 socket 路径时 SDK 实际拨号的端点。
 *
 * 在 Unix 上就是路径本身。Windows 上没有 socket 文件：bridge 发布一个
 * 由该路径派生出的命名管道，直接按路径拨号什么都找不到。这里的派生规则
 * 与 `zuno-transport` 完全一致，两侧的测试把它们钉在一起。
 */
export function transportEndpoint(socketPath: string): string {
  if (process.platform !== "win32") return socketPath;

  // 规则与 Rust 侧相同：保留可读的词干便于诊断，再加一段归一化路径的
  // 哈希，保证两个不同的路径永远不会撞名。
  const stem =
    (path.parse(socketPath).name.match(/[A-Za-z0-9\-_]/g) ?? []).join("").slice(0, 32) || "zuno";
  const normalized = socketPath.replace(/\\/g, "/").toLowerCase();
  const hash = createHash("sha256").update(normalized).digest("hex").slice(0, 16);
  return `\\\\.\\pipe\\${stem}-${hash}`;
}

/** 带版本的 harness API socket 路径。`ZUNO_API_SOCKET` 可覆盖。 */
export function apiSocketPath(): string {
  return process.env.ZUNO_API_SOCKET ?? path.join(runtimeDir(), "zuno-api.sock");
}

/** 内部 daemon socket 路径。`ZUNO_SOCKET` 可覆盖。 */
export function legacySocketPath(): string {
  return process.env.ZUNO_SOCKET ?? path.join(runtimeDir(), "zuno.sock");
}
