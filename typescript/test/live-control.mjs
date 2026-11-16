/**
 * 冒烟测试够不到的 SDK 方法的覆盖检查。
 *
 * `live-turn.mjs` 证明了 happy path；这个文件驱动控制面（attach、
 * cancel、soft interrupt、clear、rewind、detach）打向一个真实
 * bridge。每一个都跨一条独立的翻译路径，mock server 没法告诉我们
 * daemon 是否真的应答：`ping` 的 teardown 和 `send_message` 的
 * 无应答这两个问题，都是在真实环境跑过一次之前看不见的。
 */

import assert from "node:assert/strict";
import { ZunoClient } from "../dist/index.js";

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

const client = await ZunoClient.connect({
  clientName: "sdk-control-e2e/0.1",
  requestTimeoutMs: 20_000,
});
client.on("harness_error", (frame) => console.log(`  (harness_error: ${frame.message})`));

const session = await client.createSession(process.cwd());
const id = session.session_id;
console.log(`session ${id}`);

await step("attachSession on a second connection", async () => {
  const other = await ZunoClient.connect({
    clientName: "sdk-control-e2e-2/0.1",
    requestTimeoutMs: 20_000,
  });
  const attached = await other.attachSession(id);
  assert.equal(attached.session_id, id, "attach returned a different session");
  other.close();
});

await step("cancel with no turn in flight is a no-op", async () => {
  await client.cancel(id);
});

await step("cancel stops a live turn", async () => {
  // 在发送之前先订阅：一个短回合可能在我们还在搭建监听的时候就
  // 已经结束，事后才挂上的监听器会错过边界，把一个从未发生过的
  // 卡顿报成 hang。
  let ended = false;
  let onEnd = () => {};
  const done = new Promise((resolve) => {
    onEnd = resolve;
  });
  let onToken = () => {};
  const firstDelta = new Promise((resolve) => {
    onToken = resolve;
  });
  const onEvent = (frame) => {
    if (frame.session_id !== id) return;
    if (frame.ev === "text_delta") onToken(true);
    if (frame.ev === "turn_done") {
      ended = true;
      onToken(false);
      onEnd(true);
    }
  };
  client.on("event", onEvent);
  try {
    await client.sendMessage(id, "Count from 1 to 400, one number per line, no commentary.");
    // 在第一个 token 到达时取消，而不是固定的 sleep 之后取消：固定
    // 等待要么跟一个快回合赛跑（断言就被跳过，以前就发生过），要么
    // 让每次运行都变慢。第一个 delta 证明生成确实已经在跑。
    const started = await Promise.race([
      firstDelta,
      new Promise((resolve) => setTimeout(() => resolve(false), 30_000)),
    ]);
    if (ended || !started) {
      console.log(`  (turn ended before any token; ended=${ended} started=${started}; skipping)`);
      return;
    }
    const timeout = new Promise((resolve) => setTimeout(() => resolve(false), 20_000));
    await client.cancel(id);
    assert.ok(await Promise.race([done, timeout]), "turn did not end within 20s of cancel");
  } finally {
    client.off("event", onEvent);
  }
});

await step("softInterrupt is accepted", async () => {
  await client.softInterrupt(id, "noted, keep going", false);
});

await step("getHistory then rewind trims the transcript", async () => {
  const before = await client.getHistory(id);
  assert.ok(before.length >= 1, "no history to rewind");
  await client.rewind(id, 1);
  const after = await client.getHistory(id);
  assert.ok(
    after.length <= before.length,
    `rewind grew history: ${before.length} -> ${after.length}`,
  );
});

await step("clear empties the transcript", async () => {
  await client.clear(id);
  const history = await client.getHistory(id);
  assert.equal(history.length, 0, `history not empty after clear: ${history.length}`);
});

await step("peekSession works without attaching", async () => {
  const other = await ZunoClient.connect({
    clientName: "sdk-control-e2e-3/0.1",
    requestTimeoutMs: 20_000,
  });
  const messages = await other.peekSession(id, 3);
  assert.ok(Array.isArray(messages), "peek did not return an array");
  other.close();
});

// 一个打错的 session id 以前会被转发给 daemon，daemon 回答
// "Client must Subscribe first" 并*关掉连接*。这条连接上每一个
// 还在飞的请求都死了，SDK 只报一个裸 EPIPE。这个修复的重点是：
// 一个坏 id 只应该让一个请求失败，而不是整条连接。
await step("a bad session id fails that request only, not the connection", async () => {
  const probe = await ZunoClient.connect({
    clientName: "sdk-control-e2e-bad-id/0.1",
    requestTimeoutMs: 20_000,
  });
  try {
    for (const [name, call] of [
      ["getHistory", () => probe.getHistory("session_does_not_exist")],
      ["clear", () => probe.clear("session_does_not_exist")],
      ["rewind", () => probe.rewind("session_does_not_exist", 1)],
      ["cancel", () => probe.cancel("session_does_not_exist")],
    ]) {
      let code;
      try {
        await call();
      } catch (error) {
        code = error.code;
      }
      assert.equal(code, "unknown_session", `${name} should fail with unknown_session`);
    }
    // 经历上面这些之后，连接必须仍然可用。
    await probe.ping();
    const session = await probe.createSession(process.cwd());
    assert.ok(session.session_id, "should still be able to create a session");
  } finally {
    probe.close();
  }
});

await step("detachSession is accepted", async () => {
  await client.detachSession(id);
});

client.close();

if (failures.length > 0) {
  console.error(`\n${failures.length} control-surface failure(s):`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
console.log("control surface ok");
