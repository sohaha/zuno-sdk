import { test } from "node:test";
import assert from "node:assert/strict";

test("显式只读策略不能被额外环境变量扩大", {skip:process.platform === "win32"}, async () => {
  const { launchInstance } = await import("../dist/runtime/instance-launch.js");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "zuno-filesystem-test-"));
  try {
    const binary = path.join(dir, "capture");
    const captured = path.join(dir, "policy.json");
    fs.writeFileSync(binary, "#!/bin/sh\nprintf '%s' \"$ZUNO_FILESYSTEM_POLICY\" > \"$CAPTURE_PATH\"\nexit 1\n", {mode:0o700});
    await assert.rejects(launchInstance({binary, zunoHome:path.join(dir,"instance"), inheritLogins:false,
      filesystem:{readRoots:[]}, startupTimeoutMs:2000,
      env:{CAPTURE_PATH:captured,ZUNO_FILESYSTEM_POLICY:'{"read_roots":["/"]}'}}));
    assert.deepEqual(JSON.parse(fs.readFileSync(captured,"utf8")), {read_roots:[]});
  } finally { fs.rmSync(dir,{recursive:true,force:true}); }
});

/**
 * 没有开发者模式/管理员权限的 Windows 无法创建符号链接。
 * 那些构造符号链接 fixture（或依赖凭据继承链接）的测试在那里
 * 没有意义；探测一次然后跳过，而不是失败。
 */
let symlinksUsable: boolean | undefined;
function symlinksAvailable(): boolean {
  if (symlinksUsable === undefined) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "zuno-sdk-symlink-probe-"));
    try {
      const target = path.join(dir, "target");
      fs.writeFileSync(target, "");
      const link = path.join(dir, "link");
      fs.symlinkSync(target, link);
      fs.unlinkSync(link);
      symlinksUsable = true;
    } catch {
      symlinksUsable = false;
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
  return symlinksUsable;
}

test("private instances disable auto-update", { skip: process.platform === "win32" }, async () => {
  const { launchInstance } = await import("../dist/runtime/instance-launch.js");
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "zuno-sdk-auto-update-test-"));
  try {
    const binary = path.join(sandbox, "capture-env");
    const captured = path.join(sandbox, "auto-update.txt");
    fs.writeFileSync(binary,
      "#!/bin/sh\nprintf '%s|%s' \"${ZUNO_NO_AUTO_UPDATE-unset}\" \"$*\" > \"$CAPTURE_PATH\"\nexit 1\n",
      { mode: 0o700 });
    await assert.rejects(() => launchInstance({ binary, zunoHome: path.join(sandbox, "instance"),
      inheritLogins: false, startupTimeoutMs: 2000, env: { CAPTURE_PATH: captured } }));
    assert.equal(fs.readFileSync(captured, "utf8"),
      `1|--no-update api-bridge --api-socket ${path.join(sandbox, "instance", "run", "zuno-api.sock")}`);
  } finally { fs.rmSync(sandbox, { recursive: true, force: true }); }
});
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { inheritCredentials, userZunoHome } from "../dist/index.js";

test("platform runtime packages map to npm platform conventions", async () => {
  const { platformBinaryPackage } = await import("../dist/index.js");
  assert.equal(platformBinaryPackage("linux", "x64"), "@sohaha/zuno-linux-x64");
  assert.equal(platformBinaryPackage("darwin", "arm64"), "@sohaha/zuno-darwin-arm64");
  assert.equal(platformBinaryPackage("win32", "x64"), "@sohaha/zuno-win32-x64");
  assert.equal(platformBinaryPackage("freebsd", "x64"), undefined);
});

/**
 * 清理绝不能跟随符号链接跳出实例 home。
 *
 * 目前的继承只链接文件，但清理也必须安全地抵御遗留的、损坏的或被
 * 攻击者注入的目录链接。跟随那种链接会在“删除一个临时目录”时把用户的
 * 登录态一起删掉，所以这个测试真的构造出敌意形态并验证目标存活。
 */
test("removing an instance home never follows links to real credentials",
  { skip: !symlinksAvailable() }, async () => {
  const instance = fs.mkdtempSync(path.join(os.tmpdir(), "zuno-sdk-instance-"));
  const precious = fs.mkdtempSync(path.join(os.tmpdir(), "zuno-precious-test-"));
  fs.mkdirSync(precious, { recursive: true });
  fs.writeFileSync(path.join(precious, "auth.json"), '{"token":"keep me"}');

  fs.mkdirSync(path.join(instance, "external"), { recursive: true });
  fs.symlinkSync(precious, path.join(instance, "external", "linked-home"));
  fs.symlinkSync(path.join(precious, "auth.json"), path.join(instance, "auth.json"));
  fs.writeFileSync(path.join(instance, "own-state.json"), "{}");

  // 走与 `close()` 在临时实例上相同的清理例程。
  const { removeInstanceHomeForTest } = await import("../dist/runtime/instance-launch.js");
  removeInstanceHomeForTest(instance);

  assert.ok(!fs.existsSync(instance), "the instance home should be gone");
  assert.ok(
    fs.existsSync(path.join(precious, "auth.json")),
    "the user's real credentials must survive instance cleanup",
  );
  assert.equal(
    fs.readFileSync(path.join(precious, "auth.json"), "utf8"),
    '{"token":"keep me"}',
    "the user's credentials must be untouched, not merely present",
  );

  fs.rmSync(precious, { recursive: true, force: true });
});

test("cleanup refuses arbitrary directories even when asked directly", async () => {
  const arbitrary = fs.mkdtempSync(path.join(os.tmpdir(), "not-a-zuno-instance-"));
  fs.writeFileSync(path.join(arbitrary, "keep"), "safe");

  const { removeInstanceHomeForTest } = await import("../dist/runtime/instance-launch.js");
  removeInstanceHomeForTest(arbitrary);

  assert.equal(fs.readFileSync(path.join(arbitrary, "keep"), "utf8"), "safe");
  fs.rmSync(arbitrary, { recursive: true, force: true });
});

test("daemon shutdown lookup waits for a delayed registry entry", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "zuno-daemon-race-test-"));
  const runtimeDir = path.join(home, "run");
  fs.mkdirSync(runtimeDir);
  const { waitForDaemonPidForTest } = await import("../dist/runtime/instance-launch.js");

  const lookup = waitForDaemonPidForTest(home, runtimeDir, 1000);
  setTimeout(() => {
    fs.writeFileSync(
      path.join(home, "servers.json"),
      JSON.stringify({ instance: { socket: path.join(runtimeDir, "zuno.sock"), pid: 4242 } }),
    );
  }, 100);

  assert.equal(await lookup, 4242);
  fs.rmSync(home, { recursive: true, force: true });
});

/** 继承必须是共享会轮换的凭据，而不是拷贝它们。 */
test("rotating credentials are shared so token refresh stays coherent",
  { skip: !symlinksAvailable() }, () => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "zuno-inherit-test-"));
  const from = path.join(sandbox, "user");
  const to = path.join(sandbox, "instance");
  fs.mkdirSync(from, { recursive: true });
  fs.writeFileSync(path.join(from, "auth.json"), '{"refresh":"v1"}');
  fs.writeFileSync(path.join(from, "config.toml"), "[auth]\n");
  // 派生的失败态绝不能被继承：一条陈旧的拒绝记录会让新实例
  // 拒绝刷新一个其实是可用的凭据。
  fs.writeFileSync(path.join(from, "auth-refresh-state.json"), '{"claude":{"rejected":1}}');

  const inherited = inheritCredentials(from, to);

  assert.ok(
    fs.lstatSync(path.join(to, "auth.json")).isSymbolicLink(),
    "auth.json must be shared, since refresh tokens rotate and copies diverge",
  );
  assert.ok(
    !fs.lstatSync(path.join(to, "config.toml")).isSymbolicLink(),
    "config.toml must be copied so the instance can edit its own settings",
  );
  assert.ok(
    !fs.existsSync(path.join(to, "auth-refresh-state.json")),
    "derived auth failure state must not be inherited",
  );
  assert.ok(inherited.includes("auth.json"));

  // 任一侧的轮换都必须对另一侧可见。
  fs.writeFileSync(path.join(from, "auth.json"), '{"refresh":"v2"}');
  assert.equal(fs.readFileSync(path.join(to, "auth.json"), "utf8"), '{"refresh":"v2"}');

  fs.rmSync(sandbox, { recursive: true, force: true });
});

test("credential inheritance refuses to use the user's home as the instance home", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "zuno-same-home-test-"));
  const auth = path.join(home, "auth.json");
  fs.writeFileSync(auth, '{"token":"must survive"}');

  assert.throws(
    () => inheritCredentials(home, home),
    (error: { code?: string }) => error.code === "invalid_instance_home",
  );
  assert.equal(fs.readFileSync(auth, "utf8"), '{"token":"must survive"}');
  fs.rmSync(home, { recursive: true, force: true });
});

test("login inheritance creates file links, never credential directory links",
  { skip: !symlinksAvailable() }, (t) => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "zuno-inherit-shape-test-"));
  const oldHome = process.env.HOME;
  const oldXdg = process.env.XDG_CONFIG_HOME;
  const oldAppData = process.env.APPDATA;
  const home = path.join(sandbox, "home");
  // macOS 忽略 XDG_CONFIG_HOME。把每个平台的配置与外部凭据查询都
  // 收进 fixture 里，而不是真的去读用户 home。
  t.mock.method(os, "homedir", () => home);
  const config = process.platform === "darwin"
    ? path.join(home, "Library", "Application Support")
    : path.join(sandbox, "config");
  const from = path.join(home, ".zuno");
  const to = path.join(sandbox, "instance");
  fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
  fs.mkdirSync(path.join(config, "zuno"), { recursive: true });
  fs.mkdirSync(from, { recursive: true });
  fs.writeFileSync(path.join(home, ".claude", ".credentials.json"), "{}");
  fs.writeFileSync(path.join(config, "zuno", "n.env"), "TOKEN=test");
  fs.writeFileSync(path.join(config, "zuno", "usage.json"), "{}");
  const legacyTarget = path.join(sandbox, "legacy-linked-config");
  fs.mkdirSync(legacyTarget);
  fs.writeFileSync(path.join(legacyTarget, "precious"), "untouched");
  fs.mkdirSync(to);
  fs.symlinkSync(legacyTarget, path.join(to, "config"));

  try {
    process.env.HOME = home;
    process.env.XDG_CONFIG_HOME = config;
    process.env.APPDATA = config;
    const inherited = inheritCredentials(from, to);

    assert.ok(inherited.includes("config/zuno/n.env"));
    assert.ok(inherited.includes("external/.claude/.credentials.json"));
    assert.ok(fs.lstatSync(path.join(to, "config", "zuno", "n.env")).isSymbolicLink());
    assert.ok(
      fs.lstatSync(path.join(to, "external", ".claude", ".credentials.json")).isSymbolicLink(),
    );
    assert.ok(!fs.lstatSync(path.join(to, "config", "zuno")).isSymbolicLink());
    assert.ok(!fs.lstatSync(path.join(to, "external", ".claude")).isSymbolicLink());
    assert.ok(!fs.existsSync(path.join(to, "config", "zuno", "usage.json")));
    assert.equal(
      fs.readFileSync(path.join(legacyTarget, "precious"), "utf8"),
      "untouched",
      "migrating an old directory link must not modify its target",
    );
  } finally {
    if (oldHome === undefined) delete process.env.HOME;
    else process.env.HOME = oldHome;
    if (oldXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = oldXdg;
    if (oldAppData === undefined) delete process.env.APPDATA;
    else process.env.APPDATA = oldAppData;
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
});

test("zpi agent auth is inherited as a file link from a fixture home",
  { skip: !symlinksAvailable() }, (t) => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "zuno-inherit-zpi-test-"));
  const oldHome = process.env.HOME;
  const oldXdg = process.env.XDG_CONFIG_HOME;
  const oldAppData = process.env.APPDATA;
  const home = path.join(sandbox, "home");
  t.mock.method(os, "homedir", () => home);
  const from = path.join(home, ".zuno");
  const to = path.join(sandbox, "instance");
  fs.mkdirSync(path.join(home, ".zpi", "agent"), { recursive: true });
  fs.mkdirSync(from, { recursive: true });
  fs.writeFileSync(path.join(home, ".zpi", "agent", "auth.json"), '{"fixture":true}');

  try {
    process.env.HOME = home;
    process.env.XDG_CONFIG_HOME = path.join(sandbox, "config");
    process.env.APPDATA = path.join(sandbox, "config");
    const inherited = inheritCredentials(from, to);
    const relative = "external/.zpi/agent/auth.json";
    assert.ok(inherited.includes(relative));
    const linked = path.join(to, "external", ".zpi", "agent", "auth.json");
    assert.ok(fs.lstatSync(linked).isSymbolicLink());
    assert.ok(!fs.lstatSync(path.join(to, "external", ".zpi")).isSymbolicLink());
    assert.equal(fs.readFileSync(linked, "utf8"), '{"fixture":true}');
  } finally {
    if (oldHome === undefined) delete process.env.HOME;
    else process.env.HOME = oldHome;
    if (oldXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = oldXdg;
    if (oldAppData === undefined) delete process.env.APPDATA;
    else process.env.APPDATA = oldAppData;
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
});

test("the user's zuno home is resolved independently of an instance", () => {
  assert.ok(userZunoHome().length > 0);
  assert.ok(path.isAbsolute(userZunoHome()));
});

/**
 * 找不到 zuno 是最常见的首次运行失败，所以它必须是一个普通的可捕获错误。
 *
 * Node 把没有监听者的子进程 "error" 事件当作从 child_process 内部抛出的致命
 * 错误，所以如果没有监听者，它会用一个 try/catch 抓不到的 `spawn ENOENT` 原始
 * 堆栈杀掉调用方进程。失败路径也必须自我清理：实例 home 在 spawn 之前就已
 * 经被创建，提前返回的错误路径会把它泄漏掉。
 */
test("a missing zuno binary is catchable, and leaks nothing", async () => {
  const { ZunoClient, HarnessError } = await import("../dist/index.js");
  const root = os.tmpdir();
  const before = fs
    .readdirSync(root)
    .filter((name) => name.startsWith("zuno-sdk-instance-")).length;

  await assert.rejects(
    () =>
      ZunoClient.launch({
        binary: "zuno-definitely-not-installed",
        startupTimeoutMs: 5000,
        // 凭据继承要链文件，需要 Windows 通常没有的符号链接权限；本
        // 测试走的是二进制缺失路径，所以关掉继承以保持该平台的确定性。
        inheritLogins: false,
      }),
    (error: InstanceType<typeof HarnessError>) => {
      assert.equal(error.name, "HarnessError");
      assert.equal(error.code, "zuno_not_found");
      assert.match(error.message, /未安装/);
      return true;
    },
  );

  const after = fs
    .readdirSync(root)
    .filter((name) => name.startsWith("zuno-sdk-instance-")).length;
  assert.equal(after, before, "a failed launch must not leave an instance home behind");
});

test(
  "swarmModel reaches the launched runtime and overrides the generic environment",
  { skip: process.platform === "win32" },
  async () => {
    const { launchInstance } = await import("../dist/runtime/instance-launch.js");
    const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "zuno-sdk-swarm-model-test-"));
    const binary = path.join(sandbox, "capture-env");
    const captured = path.join(sandbox, "swarm-model.txt");
    fs.writeFileSync(
      binary,
      "#!/bin/sh\nprintf '%s' \"$ZUNO_SWARM_MODEL\" > \"$CAPTURE_PATH\"\nexit 1\n",
      { mode: 0o700 },
    );

    await assert.rejects(() =>
      launchInstance({
        binary,
        zunoHome: path.join(sandbox, "instance"),
        inheritLogins: false,
        startupTimeoutMs: 2000,
        env: { CAPTURE_PATH: captured, ZUNO_SWARM_MODEL: "unwanted-model" },
        swarmModel: "inherit",
      }),
    );

    assert.equal(fs.readFileSync(captured, "utf8"), "inherit");
    fs.rmSync(sandbox, { recursive: true, force: true });
  },
);

test(
  "wakeMode reaches the launched runtime and overrides the generic environment",
  { skip: process.platform === "win32" },
  async () => {
    const { launchInstance } = await import("../dist/runtime/instance-launch.js");
    const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "zuno-sdk-wake-mode-test-"));
    const binary = path.join(sandbox, "capture-env");
    const captured = path.join(sandbox, "wake-mode.txt");
    fs.writeFileSync(binary, "#!/bin/sh\nprintf '%s' \"$ZUNO_WAKE_MODE\" > \"$CAPTURE_PATH\"\nexit 1\n", { mode: 0o700 });
    await assert.rejects(() => launchInstance({
      binary,
      zunoHome: path.join(sandbox, "instance"),
      inheritLogins: false,
      startupTimeoutMs: 2000,
      env: { CAPTURE_PATH: captured, ZUNO_WAKE_MODE: "internal" },
      wakeMode: "external",
    }));
    assert.equal(fs.readFileSync(captured, "utf8"), "external");
    fs.rmSync(sandbox, { recursive: true, force: true });
  },
);
