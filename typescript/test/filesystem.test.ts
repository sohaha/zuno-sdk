import { test } from "node:test";
import assert from "node:assert/strict";
import { ZunoClient } from "../dist/index.js";
import { startMockHarness } from "./mock-harness.ts";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

for (const viaEnv of [false, true]) {
  test(`启动旧运行时拒绝只读策略并清理连接（env=${viaEnv}）`, {skip:process.platform === "win32"}, async () => {
    const server = await startMockHarness();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "zuno-old-fs-"));
    const binary = path.join(dir, "runtime");
    fs.writeFileSync(binary, '#!/bin/sh\nln -s "$MOCK_SOCKET" "$ZUNO_API_SOCKET"\nexec sleep 30\n', {mode:0o700});
    try {
      await assert.rejects(ZunoClient.launch({binary, zunoHome:path.join(dir,"home"), inheritLogins:false,
        startupTimeoutMs:2000,
        ...(viaEnv ? {} : {filesystem:{readRoots:[]}}),
        env:{MOCK_SOCKET:server.socketPath, ...(viaEnv ? {ZUNO_FILESYSTEM_POLICY:'{"read_roots":[]}'} : {})},
      }), (error:any) => error.code === "unsupported");
      for (let i=0; i<100 && server.clientCount() !== 0; i++) await new Promise(resolve=>setTimeout(resolve,10));
      assert.equal(server.clientCount(), 0, "失败的客户端连接应关闭");
    } finally { await server.close(); fs.rmSync(dir,{recursive:true,force:true}); }
  });
}

for (const readRoots of [[], ["/workspace/readonly"]]) {
  test(`只读目录策略正确发送 ${JSON.stringify(readRoots)}`, async () => {
    let captured: unknown;
    const server = await startMockHarness({ capabilities: ["filesystem_policy"], onRequest(request, send) {
      captured = request.filesystem;
      send({v:1, reply_to:request.id, ev:"attached", session:{session_id:"s1", status:"idle"}});
    }});
    const client = await ZunoClient.connect({socketPath:server.socketPath});
    try {
      await client.createSession({filesystem:{readRoots}});
      assert.deepEqual(captured, {read_roots:readRoots});
    } finally { client.close(); await server.close(); }
  });
}

test("旧运行时拒绝策略且不发送创建请求", async () => {
  let requests = 0;
  const server = await startMockHarness({onRequest(){ requests++; }});
  const client = await ZunoClient.connect({socketPath:server.socketPath});
  try {
    await assert.rejects(client.createSession({filesystem:{readRoots:[]}}), /filesystem_policy/);
    assert.equal(requests, 0);
  } finally { client.close(); await server.close(); }
});

test("不静默忽略写目录字段", async () => {
  const server = await startMockHarness({capabilities:["filesystem_policy"]});
  const client = await ZunoClient.connect({socketPath:server.socketPath});
  try {
    await assert.rejects(client.createSession({filesystem:{readRoots:[], writeRoots:["/"]} as any}), /不支持写目录/);
  } finally { client.close(); await server.close(); }
});
