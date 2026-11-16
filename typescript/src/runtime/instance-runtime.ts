/**
 * 私有实例的进程生命周期与 home 目录清理。
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function readDaemonPidSync(zunoHome: string, runtimeDir: string): number | undefined {
  let raw: string;
  try {
    raw = fs.readFileSync(path.join(zunoHome, "servers.json"), "utf8");
  } catch {
    return undefined;
  }
  let registry: Record<string, { socket?: string; pid?: number }>;
  try {
    registry = JSON.parse(raw) as Record<string, { socket?: string; pid?: number }>;
  } catch {
    return undefined;
  }
  const socket = path.join(runtimeDir, "zuno.sock");
  for (const entry of Object.values(registry)) {
    if (entry?.socket === socket && typeof entry.pid === "number" && entry.pid > 1) {
      return entry.pid;
    }
  }
  return undefined;
}

export async function waitForDaemonPid(
  zunoHome: string,
  runtimeDir: string,
  timeoutMs = 2000,
): Promise<number | undefined> {
  const deadline = Date.now() + timeoutMs;
  do {
    const pid = readDaemonPidSync(zunoHome, runtimeDir);
    if (pid !== undefined) return pid;
    await new Promise((resolve) => setTimeout(resolve, 50));
  } while (Date.now() < deadline);
  return undefined;
}

export async function stopInstanceDaemon(
  zunoHome: string,
  runtimeDir: string,
): Promise<void> {
  const pid = await waitForDaemonPid(zunoHome, runtimeDir);
  if (pid === undefined) return;

  const signal = (sig: NodeJS.Signals) => {
    try {
      process.kill(-pid, sig);
    } catch {
      try {
        process.kill(pid, sig);
      } catch {
        // 已经退出了。
      }
    }
  };

  signal("SIGTERM");

  const gracePeriod = Date.now() + 2000;
  while (Date.now() < gracePeriod) {
    if (!processExists(pid)) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  signal("SIGKILL");

  const hardDeadline = Date.now() + 5000;
  while (Date.now() < hardDeadline) {
    if (!processExists(pid)) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

export function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function removeInstanceHome(home: string): void {
  const resolvedHome = path.resolve(home);
  const tempRoot = path.resolve(os.tmpdir());
  if (
    path.dirname(resolvedHome) !== tempRoot ||
    !path.basename(resolvedHome).startsWith("zuno-sdk-instance-")
  ) {
    return;
  }

  const walk = (target: string): void => {
    let stats;
    try {
      stats = fs.lstatSync(target);
    } catch {
      return;
    }

    if (stats.isSymbolicLink()) {
      fs.unlinkSync(target);
      return;
    }

    if (stats.isDirectory()) {
      for (const entry of fs.readdirSync(target)) {
        walk(path.join(target, entry));
      }
      fs.rmdirSync(target);
      return;
    }
    fs.unlinkSync(target);
  };
  try {
    walk(home);
  } catch {
    // 残留文件只是一个泄漏的临时目录；宁可泄漏。
  }
}
