/**
 * Schema 对齐：SDK 的 tag 集合必须与 Rust API crate 一致。
 *
 * SDK 是手写的，最现实的失败模式是 Rust 一侧新增了变体而
 * TypeScript 不知道。这个测试直接读 Rust 源码，一旦两侧漂移
 * 就立刻失败，这是唯一能抓住"忘了同步"式新增的检查。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  API_VERSION_MAJOR,
  API_VERSION_MINOR,
  KNOWN_EVENT_KINDS,
  KNOWN_REQUEST_KINDS,
} from "../dist/index.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const rustCrate = path.resolve(here, "../../../crates/zuno-harness-api/src");

function snakeCase(variant: string): string {
  return variant.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
}

/** 一个 Rust 文件中顶层枚举的变体名，去掉 `Unknown`。 */
function enumVariants(file: string, enumName: string): string[] {
  const source = fs.readFileSync(path.join(rustCrate, file), "utf8");
  const start = source.indexOf(`pub enum ${enumName} {`);
  assert.notEqual(start, -1, `enum ${enumName} not found in ${file}`);
  // 在枚举的收尾右花括号（列 0）处停下，让同文件后面的枚举
  // （比如 ErrorCode）不会混进这次比较。
  const rest = source.slice(start);
  const end = rest.indexOf("\n}");
  const body = end === -1 ? rest : rest.slice(0, end);
  const variants: string[] = [];
  // 变体在枚举 body 里恰好缩进一级。
  for (const line of body.split("\n")) {
    const match = /^ {4}([A-Z][A-Za-z0-9]*)\s*[{(,]/.exec(line);
    if (match && match[1] !== "Unknown") variants.push(snakeCase(match[1]));
  }
  return variants;
}

test("request tags match the Rust ApiRequest enum", () => {
  const rust = enumVariants("requests.rs", "ApiRequest").sort();
  assert.deepEqual([...KNOWN_REQUEST_KINDS].sort(), rust);
});

test("event tags match the Rust ApiEvent enum", () => {
  const rust = enumVariants("events.rs", "ApiEvent").sort();
  assert.deepEqual([...KNOWN_EVENT_KINDS].sort(), rust);
});

test("send_message no_reply field matches the Rust schema", () => {
  const rust = fs.readFileSync(path.join(rustCrate, "requests.rs"), "utf8");
  const typescript = fs.readFileSync(path.resolve(here, "../src/protocol/harness-protocol.ts"), "utf8");
  assert.match(rust, /SendMessage\s*{[\s\S]*?no_reply:\s*bool/);
  assert.match(typescript, /req:\s*"send_message"[\s\S]*?no_reply\?:\s*boolean/);
});

test("protocol major version matches the Rust constant", () => {
  const source = fs.readFileSync(path.join(rustCrate, "lib.rs"), "utf8");
  const match = /API_VERSION_MAJOR: u32 = (\d+)/.exec(source);
  assert.ok(match, "API_VERSION_MAJOR not found");
  assert.equal(API_VERSION_MAJOR, Number(match![1]));
});

test("protocol minor version matches the Rust constant", () => {
  const source = fs.readFileSync(path.join(rustCrate, "lib.rs"), "utf8");
  const match = /API_VERSION_MINOR: u32 = (\d+)/.exec(source);
  assert.ok(match, "API_VERSION_MINOR not found");
  assert.equal(API_VERSION_MINOR, Number(match![1]));
});

test("socket path rules match the Rust resolver", async () => {
  const source = fs.readFileSync(path.join(rustCrate, "sockets.rs"), "utf8");
  for (const key of ["ZUNO_RUNTIME_DIR", "XDG_RUNTIME_DIR", "ZUNO_API_SOCKET", "ZUNO_SOCKET"]) {
    assert.ok(source.includes(key), `${key} missing from Rust resolver`);
  }
  const socketSource = fs.readFileSync(
    path.resolve(here, "../src/transport/socket-endpoint.ts"),
    "utf8",
  );
  for (const key of ["ZUNO_RUNTIME_DIR", "XDG_RUNTIME_DIR", "ZUNO_API_SOCKET", "ZUNO_SOCKET"]) {
    assert.ok(socketSource.includes(key), `${key} missing from SDK resolver`);
  }
  assert.ok(
    source.includes("zuno-api.sock") && socketSource.includes("zuno-api.sock"),
  );
});
