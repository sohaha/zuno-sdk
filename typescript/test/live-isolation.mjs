/**
 * 启动实例的隔离与路径安全检查。
 *
 * `launch()` 承诺了一个看不见用户工作的实例。这个性质是 bridge
 * 的会话记录查找决定的，不是 SDK 决定的，而它曾经坏过：
 * `peek_session` 直接读 `~/.zuno/sessions`，于是一个"被隔离"的
 * 实例返回了用户交互式使用的 zuno 的真实转录。
 *
 * 用法：node test/live-isolation.mjs [path-to-zuno-binary]
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
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

const client = await ZunoClient.launch({
  binary,
  workingDir: process.cwd(),
  startupTimeoutMs: 60_000,
});

await step("an instance cannot read the user's session transcripts", async () => {
  const dir = path.join(userZunoHome(), "sessions");
  if (!fs.existsSync(dir)) {
    console.log("     (no user sessions on this machine; skipping)");
    return;
  }
  const records = fs
    .readdirSync(dir)
    .filter((name) => name.startsWith("session_") && name.endsWith(".json"));
  if (records.length === 0) {
    console.log("     (no user sessions on this machine; skipping)");
    return;
  }
  // 选一条有真实内容的记录，这样空结果就意味着"被挡住了"，
  // 而不是"那个会话恰好是空的"。
  let victim;
  for (const name of records.slice(0, 40)) {
    const raw = JSON.parse(fs.readFileSync(path.join(dir, name), "utf8"));
    const messages = raw.messages ?? [];
    if (messages.some((m) => (m.role === "user" || m.role === "assistant") && m.content)) {
      victim = name.replace(/\.json$/, "");
      break;
    }
  }
  if (!victim) {
    console.log("     (no non-empty user sessions; skipping)");
    return;
  }
  const leaked = await client.peekSession(victim, 5);
  assert.equal(
    leaked.length,
    0,
    `an isolated instance read ${leaked.length} messages from the user's session ${victim}`,
  );
});

await step("a session id cannot escape the sessions directory", async () => {
  // 这个 id 会被插值进一个路径里，所以一个穿越必须被拒绝而不是
  // 被读出。空结果才是正确、平淡无奇的答案。
  for (const hostile of [
    "../../../etc/passwd",
    "../../.ssh/id_rsa",
    "..%2F..%2Fetc%2Fpasswd",
    "/etc/passwd",
  ]) {
    const result = await client.peekSession(hostile, 5);
    assert.equal(result.length, 0, `traversal id ${hostile} returned ${result.length} messages`);
  }
});

await step("the instance can still peek its own sessions", async () => {
  const session = await client.createSession(process.cwd());
  await client.sendMessage(session.session_id, "peek probe");
  // 给 daemon 一点时间把记录落盘。
  await new Promise((resolve) => setTimeout(resolve, 1500));
  const own = await client.peekSession(session.session_id, 5);
  assert.ok(own.length > 0, "an instance must still read its own transcripts");
});

await client.close();

// 确认实例真的消失了，而不是只信 close() 正常返回。下面的
// `process.exit()` 会截断任何仍在运行的清理，所以这一步既检查
// 性质，也给清理一点落地的时间。
await new Promise((resolve) => setTimeout(resolve, 3000));
if (fs.existsSync(client.instanceHome ?? "")) {
  failures.push(`instance home leaked: ${client.instanceHome}`);
  console.log(`FAIL instance home leaked: ${client.instanceHome}`);
}

console.log(failures.length ? `\nFAILURES:\n${failures.join("\n")}` : "\nisolation ok");
process.exit(failures.length ? 1 : 0);
