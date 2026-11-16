/**
 * SDK 测试用的进程内 mock harness server。
 *
 * 说与 bridge 一样的 NDJSON 帧，让客户端测试跑真实的分帧与应答
 * 关联，而不是打桩的方法。
 */

import net from "node:net";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { NdjsonDecoder, transportEndpoint } from "../dist/index.js";

export interface MockOptions {
  capabilities?: string[];
  /** 每个客户端请求都会回调；返回的帧会被发回去。 */
  onRequest?: (request: any, send: (frame: any) => void) => void;
}

export interface MockServer {
  socketPath: string;
  close(): Promise<void>;
  /** 当前活跃的客户端连接数。 */
  clientCount(): number;
  /** 向所有已连接客户端推一条主动事件。 */
  broadcast(event: any): void;
}

export async function startMockHarness(options: MockOptions = {}): Promise<MockServer> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "zuno-sdk-test-"));
  const socketPath = path.join(dir, "api.sock");
  const clients = new Set<net.Socket>();

  const server = net.createServer((socket) => {
    clients.add(socket);
    socket.on("close", () => clients.delete(socket));
    socket.on("error", () => clients.delete(socket));
    const decoder = new NdjsonDecoder();
    socket.on("data", (chunk) => {
      for (const raw of decoder.push(chunk)) {
        const request = raw as any;
        const send = (frame: any) => socket.write(`${JSON.stringify(frame)}\n`);
        if (request.req === "hello") {
          send({
            v: 1,
            reply_to: request.id,
            ev: "hello_ok",
            version: 1,
            server: "mock/0.1",
            capabilities: options.capabilities ?? ["sessions", "streaming"],
          });
          continue;
        }
        options.onRequest?.(request, send);
      }
    });
  });

  // 客户端通过 `transportEndpoint(socketPath)` 连接，在 Windows 上
  // 会从该路径派生一个命名管道（bridge 在那里从不绑定原始 Unix
  // socket）。让 mock 监听同一个端点，两个平台都能连上。
  await new Promise<void>((resolve) => server.listen(transportEndpoint(socketPath), resolve));

  return {
    socketPath,
    clientCount() {
      return clients.size;
    },
    broadcast(event: any) {
      for (const socket of clients) socket.write(`${JSON.stringify(event)}\n`);
    },
    close() {
      for (const socket of clients) socket.destroy();
      return new Promise<void>((resolve) => {
        server.close(() => {
          fs.rmSync(dir, { recursive: true, force: true });
          resolve();
        });
      });
    },
  };
}
