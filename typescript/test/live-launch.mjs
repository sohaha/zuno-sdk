/**
 * `ZunoClient.launch()` 的端到端检查：私有实例。
 *
 * 隔离承诺就是 `launch()` 的全部意义，而它恰好是那种说起来容易
 * 做起来难的承诺。所以这里驱动一个真实实例，校验关键性质：
 * 能起来、看不见用户的会话、继承的凭据足以连上模型、不留任何
 * 残留。
 *
 * 用法：node test/live-launch.mjs [path-to-zuno-binary]
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { ZunoClient, userZunoHome } from "../dist/index.js";

const binary = process.argv[2] ?? "zuno";
const failures = [];
async function step(name, fn) {
  try {
    await fn();
    console.log(`ok   ${name}`);
  } catch (error) {
    failures.push(`${name}: ${error.message}`);
    console.log(`FAIL ${name}: ${error.message}`);
  }
}

console.log(`launching a private instance with ${binary}`);
const started = Date.now();
const client = await ZunoClient.launch({
  binary,
  workingDir: process.cwd(),
  startupTimeoutMs: 60_000,
});
const home = client.instanceHome;
console.log(`launched in ${Date.now() - started}ms, home ${home}`);

await step("a fresh instance starts with no sessions", async () => {
  const sessions = await client.listSessions();
  assert.equal(sessions.length, 0, `expected an empty instance, saw ${sessions.length}`);
});

await step("the instance home is separate from the user's", () => {
  assert.notEqual(home, userZunoHome());
  assert.ok(fs.existsSync(home), "instance home should exist while running");
});

await step("inherited credentials are owner-only", () => {
  const auth = path.join(home, "auth.json");
  if (!fs.existsSync(auth)) {
    console.log("     (no user credentials to inherit; skipping)");
    return;
  }
  const mode = fs.statSync(auth).mode & 0o777;
  assert.equal(mode, 0o600, `credentials must be 0600, saw 0${mode.toString(8)}`);
});

await step("the instance can reach a model", async () => {
  const session = await client.createSession(process.cwd());
  // CI 和开发机常常同时留着一个过期的默认 provider 和另一个可用
  // 的登录。让校验逻辑选一条已知可用的路由，这样这个步骤测的是
  // "继承到了凭据"，而不是无关的历史选择。
  if (process.env.ZUNO_SDK_TEST_MODEL) {
    await client.setModel(session.session_id, process.env.ZUNO_SDK_TEST_MODEL);
  }
  const turn = await client.run(session.session_id, "Reply with exactly: ISOLATED", {
    autoApprove: true,
  });
  assert.match(turn.text, /ISOLATED/, `unexpected reply: ${JSON.stringify(turn.text)}`);
});

await step("its sessions stay inside the instance", async () => {
  const sessions = await client.listSessions();
  assert.equal(sessions.length, 1, "the instance should see only its own session");
});

await step("close() stops the instance and removes its home", async () => {
  await client.close();
  assert.ok(!fs.existsSync(home), "an ephemeral instance home must be cleaned up");

  // 一次没看到不等于真的走了。关闭之前启动的后台工作（比如要写
  // 一个几 MB 文件的会话搜索索引器）可能几秒后才落盘，把目录在
  // 一次已经成功的删除之后又建回来。这个泄漏当初就是这么进来的，
  // 所以要等一会再复查，而不是信 close() 刚返回的那一刻。
  await new Promise((resolve) => setTimeout(resolve, 5000));
  assert.ok(
    !fs.existsSync(home),
    `the instance home came back after cleanup: ${
      fs.existsSync(home) ? fs.readdirSync(home).join(", ") : ""
    }`,
  );
});

// 启动出来的实例绝不能在用户自己的 zuno 那边可见。从另一侧
// 检查：连上共享 socket（如果存在），确认实例的会话不在那里。
await step("the user's zuno never saw the instance", async () => {
  let shared;
  try {
    shared = await ZunoClient.connect({ clientName: "launch-isolation-check/1.0" });
  } catch {
    console.log("     (no user zuno running; skipping)");
    return;
  }
  const sessions = await shared.listSessions();
  await shared.close();
  assert.ok(
    !sessions.some((session) => session.working_dir === home),
    "a launched instance's sessions leaked into the user's zuno",
  );
});

// 一个进程崩溃时没调 close() 的消费方绝不能把实例 daemon 留在
// 那里跑。daemon 调了 setsid()，所以任何瞄着启动它的进程的信号
// 都打不到它：一个嵌入 zuno 的服务器每重启一次就会多累积一个
// daemon，每个都占着一个临时目录和一条模型连接，永远不放。
await step("an exit without close() does not leak the daemon", async () => {
  const { execFileSync, execSync } = await import("node:child_process");
  const countDaemons = () =>
    Number(execSync("pgrep -cf 'zuno --provider auto serve' || true", { encoding: "utf8" }).trim());

  const before = countDaemons();
  const script = `
    import { ZunoClient } from ${JSON.stringify(new URL("../dist/index.js", import.meta.url).href)};
    const client = await ZunoClient.launch({
      binary: ${JSON.stringify(binary)},
      workingDir: process.cwd(),
      startupTimeoutMs: 60000,
    });
    console.log(client.instanceHome);
    process.exit(0);  // 不调 close()，模拟一次崩溃
  `;
  const abandonedHome = execFileSync(
    process.execPath,
    ["--input-type=module", "-e", script],
    { encoding: "utf8", timeout: 120_000 },
  ).trim();

  await new Promise((resolve) => setTimeout(resolve, 7000));
  const after = countDaemons();
  assert.equal(after, before, `a crashed consumer leaked ${after - before} daemon(s)`);

  // 把 daemon 收割掉只是问题的一半：每崩一次就泄漏一个临时目录，
  // 只是换了一种资源在做同样的无界增长。
  assert.ok(
    !fs.existsSync(abandonedHome),
    `a crashed consumer leaked its instance home: ${abandonedHome}`,
  );
});

console.log(failures.length ? `\nFAILURES:\n${failures.join("\n")}` : "\nlaunch ok");
process.exit(failures.length ? 1 : 0);
