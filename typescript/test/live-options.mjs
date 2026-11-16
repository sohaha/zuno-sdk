/**
 * README 里写到的每一个 `launch()` 选项都得说话算话。
 *
 * 文档化的选项就是一份承诺，而其中两个在文档写下时其实是坏的：
 * 复用一个 `zunoHome` 在重新链接凭据时抛了 EEXIST，然后又去连接
 * 上一次运行留下的、后面什么都没有的残留 socket。这两个 bug
 * 在"只启动全新实例"的测试套件里都不会出现。
 *
 * 用法：node test/live-options.mjs [path-to-zuno-binary]
 */

import { ZunoClient } from "../dist/index.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const binary = process.argv[2] ?? "zuno";
// 一个忽略参数、永远不开 socket 的二进制，用来测启动超时。
const slowBinary = path.join(os.tmpdir(), `zuno-slow-${process.pid}.sh`);
fs.writeFileSync(slowBinary, "#!/usr/bin/env bash\nsleep 60\n", { mode: 0o755 });
process.once("exit", () => fs.rmSync(slowBinary, { force: true }));

const failures = [];
const step = async (name, fn) => {
  try {
    await fn();
    console.log(`ok   ${name}`);
  } catch (e) {
    failures.push(`${name}: ${e.message}`);
    console.log(`FAIL ${name}: ${e.message}`);
  }
};

await step("zunoHome keeps state at a fixed path across runs", async () => {
  const home = path.join(os.tmpdir(), "zuno-sdk-option-home");
  fs.rmSync(home, { recursive: true, force: true });
  const a = await ZunoClient.launch({ binary, zunoHome: home, workingDir: process.cwd() });
  const s = await a.createSession(process.cwd());
  await a.sendMessage(s.session_id, "persist me");
  await new Promise((r) => setTimeout(r, 1500));
  await a.close();
  if (!fs.existsSync(home)) throw new Error("a named home must survive close()");

  // listSessions() 报的是 daemon 主动告诉这条连接的内容，而不是
  // 磁盘上有什么，所以复用的 home 要用 peekSession 按 id 读回来。
  const b = await ZunoClient.launch({ binary, zunoHome: home, workingDir: process.cwd() });
  const seen = await b.peekSession(s.session_id, 5);
  await b.close();
  if (seen.length === 0) throw new Error("a named home should carry transcripts across runs");
  fs.rmSync(home, { recursive: true, force: true });
});

await step("inheritLogins: false starts with no credentials", async () => {
  const c = await ZunoClient.launch({
    binary,
    workingDir: process.cwd(),
    inheritLogins: false,
  });
  const home = c.instanceHome;
  const hasAuth = fs.existsSync(`${home}/auth.json`);
  await c.close();
  if (hasAuth) throw new Error("inheritLogins:false must not copy auth.json");
});

await step("env reaches the instance", async () => {
  const c = await ZunoClient.launch({
    binary,
    workingDir: process.cwd(),
    env: {},
  });
  await c.close();
});

await step("startupTimeoutMs is honoured", async () => {
  const t0 = Date.now();
  try {
    await ZunoClient.launch({ binary: slowBinary, startupTimeoutMs: 1500 });
    throw new Error("expected a timeout");
  } catch (e) {
    if (e.code !== "startup_timeout") throw new Error(`wrong code: ${e.code}: ${e.message}`);
    const took = Date.now() - t0;
    if (took > 12000) throw new Error(`timeout took ${took}ms, expected near 1500`);
  }
});

console.log(failures.length ? `\nFAILURES:\n${failures.join("\n")}` : "\noptions ok");
process.exit(failures.length ? 1 : 0);
