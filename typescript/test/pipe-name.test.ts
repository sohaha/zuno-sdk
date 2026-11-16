import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { createHash } from "node:crypto";

/**
 * SDK 独立于 `zuno-transport` 派生 Windows 管道名——一个是 Rust
 * 一个是 TypeScript。它们之间的漂移在 Unix 上不可见，但在 Windows
 * 上是致命的：客户端拨了一个没人监听的管道，什么都连不上。
 *
 * `zuno-transport` 的 `pipe_name_matches_the_typescript_sdk` 测试
 * 从另一侧断言了同样的字面量。
 */

/** 被测的派生逻辑，平台路径解析器通过参数注入。 */
function derivePipeName(socketPath: string, parser: path.PlatformPath): string {
  const stem =
    (parser.parse(socketPath).name.match(/[A-Za-z0-9\-_]/g) ?? []).join("").slice(0, 32) || "zuno";
  const normalized = socketPath.replace(/\\/g, "/").toLowerCase();
  const hash = createHash("sha256").update(normalized).digest("hex").slice(0, 16);
  return `\\\\.\\pipe\\${stem}-${hash}`;
}

test("the Windows pipe name matches zuno-transport exactly", () => {
  // 不论宿主是什么平台都按 win32 语义解析，所以这个检查能在 Linux
  // 的 CI 上跑，而不是只能在 Windows runner 上。
  for (const [socketPath, expected] of [
    [
      "C:\\Users\\jeremy\\AppData\\Local\\zuno\\run\\zuno-api.sock",
      "\\\\.\\pipe\\zuno-api-e5d8d0868052eb63",
    ],
    ["C:\\a\\b\\zuno.sock", "\\\\.\\pipe\\zuno-5dad4a843ed98554"],
  ] as const) {
    assert.equal(
      derivePipeName(socketPath, path.win32),
      expected,
      `pipe name for ${socketPath} drifted from zuno-transport`,
    );
  }
});

test("case and separators normalize the same way", () => {
  assert.equal(
    derivePipeName("C:\\Temp\\Zuno\\server.sock", path.win32),
    derivePipeName("c:/temp/zuno/server.sock", path.win32),
    "the pipe name must not depend on case or separator style",
  );
});

test("a path with no usable characters still yields a name", () => {
  const derived = derivePipeName("/tmp/!!!.sock", path.posix);
  assert.match(derived, /^\\\\\.\\pipe\\zuno-[0-9a-f]{16}$/);
});
