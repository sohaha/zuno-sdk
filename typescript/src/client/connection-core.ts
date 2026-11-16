/**
 * 客户端的内部机制：transport、解码、pending 表、请求-回复关联。
 *
 * `ZunoClient` 在 `harness-client.ts` 里扩展这个基类，集中放对外 RPC 接口。
 * 拆开的动机是把"接线"和"业务"分层，审计协议行为时只需要读基类。
 */

import { EventEmitter } from "node:events";
import { NdjsonDecoder, encodeFrame } from "../transport/ndjson-framing.js";
import { HarnessError } from "../utils/harness-error.js";
import { ToolCallbacks, type ToolResult } from "../session/tool-callbacks.js";
import {
  API_VERSION_MAJOR,
  type ApiEvent,
  type ApiRequest,
  type ServerFrame,
} from "../protocol/harness-protocol.js";

interface Pending {
  resolve: (frame: ServerFrame) => void;
  reject: (error: Error) => void;
  timer?: NodeJS.Timeout;
  onReply?: (frame: ServerFrame) => void;
}

/** 最小双工传输接口，便于测试和未来的 WebSocket 接入。 */
export interface Transport {
  write(data: string): void;
  onData(listener: (chunk: Buffer | string) => void): void;
  onClose(listener: (error?: Error) => void): void;
  close(): void;
}

/**
 * 客户端连接的内部机制。
 *
 * 子类负责定义握手和对外 RPC；本类只负责把字节流转成帧、把请求关联
 * 到回复、把事件分发到监听器。
 */
export abstract class ClientCore extends EventEmitter {
  protected readonly transport: Transport;
  protected readonly decoder = new NdjsonDecoder();
  private readonly pending = new Map<number, Pending>();
  readonly requestTimeoutMs: number;
  readonly clientName: string;
  /** 原生 socket 路径；`undefined` 表示自定义 transport。 */
  readonly socketPath?: string;
  private nextId = 1;
  closed = false;
  closeError?: Error;
  protected readonly toolCallbacks = new ToolCallbacks(
    (sessionId, callId, result) => this.submitToolResult(sessionId, callId, result),
    (error) => this.emitSafe("error", error),
  );

  /** 握手得到的服务端标识，例如 "zuno-harness-api-bridge/0.1.0"。 */
  server = "";
  /** 服务端声明的能力字符串。 */
  capabilities: string[] = [];

  /** 服务端是否声明了某项能力。 */
  supports(capability: string): boolean {
    return this.capabilities.includes(capability);
  }

  constructor(
    transport: Transport,
    requestTimeoutMs: number,
    clientName: string,
    socketPath?: string,
  ) {
    super();
    this.setMaxListeners(0);
    this.transport = transport;
    this.requestTimeoutMs = requestTimeoutMs;
    this.clientName = clientName;
    this.socketPath = socketPath;
    transport.onData((chunk) => this.ingest(chunk));
    transport.onClose((error) => this.handleClose(error));
  }

  protected ingest(chunk: Buffer | string): void {
    let frames: unknown[];
    try {
      frames = this.decoder.push(chunk);
    } catch (error) {
      this.emitSafe("error", error);
      return;
    }
    for (const raw of frames) {
      const frame = raw as ServerFrame;
      const replyTo = frame.reply_to;
      if (typeof replyTo === "number" && this.pending.has(replyTo)) {
        const waiter = this.pending.get(replyTo)!;
        this.pending.delete(replyTo);
        if (waiter.timer) clearTimeout(waiter.timer);
        if (frame.ev === "attached" || frame.ev === "session_forked") {
          this.toolCallbacks.close();
        }
        waiter.onReply?.(frame);
        waiter.resolve(frame);
        continue;
      }
      if (
        frame.ev === "tool_call" && typeof frame.session_id === "string"
        && typeof frame.call_id === "string" && typeof frame.name === "string"
      ) {
        this.toolCallbacks.dispatch(frame.session_id, frame.call_id, frame.name, frame.input);
      } else if (frame.ev === "turn_done" && typeof frame.session_id === "string") {
        this.toolCallbacks.abort(frame.session_id);
      }
      this.emit("event", frame);
      this.emitSafe(frame.ev === "error" ? "harness_error" : frame.ev, frame);
    }
  }

  protected emitSafe(event: string, payload: unknown): void {
    if (event === "error" && this.listenerCount("error") === 0) return;
    this.emit(event, payload);
  }

  protected handleClose(error?: Error): void {
    this.closed = true;
    this.toolCallbacks.close();
    this.closeError = error ?? new Error("harness 连接已关闭");
    for (const [, waiter] of this.pending) {
      if (waiter.timer) clearTimeout(waiter.timer);
      waiter.reject(this.closeError);
    }
    this.pending.clear();
    this.emit("close", error);
  }

  request(request: ApiRequest): Promise<ServerFrame> {
    return this.requestFrame(request);
  }

  protected requestFrame(
    request: ApiRequest,
    onReply?: (frame: ServerFrame) => void,
  ): Promise<ServerFrame> {
    if (this.closed) return Promise.reject(this.closeError ?? new Error("客户端已关闭"));
    const id = this.nextId++;
    return new Promise<ServerFrame>((resolve, reject) => {
      const entry: Pending = { resolve, reject, onReply };
      if (this.requestTimeoutMs > 0) {
        entry.timer = setTimeout(() => {
          this.pending.delete(id);
          reject(new HarnessError("timeout", `${this.requestTimeoutMs}ms 内没有收到 ${request.req} 的回复`));
        }, this.requestTimeoutMs);
        entry.timer.unref?.();
      }
      this.pending.set(id, entry);
      try {
        this.transport.write(encodeFrame({ v: API_VERSION_MAJOR, id, ...request }));
      } catch (error) {
        this.pending.delete(id);
        if (entry.timer) clearTimeout(entry.timer);
        reject(error as Error);
      }
    });
  }

  protected async requestOk(request: ApiRequest): Promise<ServerFrame> {
    const frame = await this.request(request);
    if (frame.ev === "error") {
      throw new HarnessError(String(frame.code), String(frame.message));
    }
    return frame;
  }

  protected async expectReply<K extends ApiEvent["ev"]>(
    request: ApiRequest,
    kind: K,
  ): Promise<Extract<ApiEvent, { ev: K }>> {
    const frame = await this.requestOk(request);
    if (frame.ev !== kind) {
      throw new HarnessError("unexpected_reply", `期望 ${kind}，收到 ${frame.ev}`);
    }
    return frame as unknown as Extract<ApiEvent, { ev: K }>;
  }

  notify(request: ApiRequest): void {
    if (this.closed) throw this.closeError ?? new Error("客户端已关闭");
    const id = this.nextId++;
    this.transport.write(encodeFrame({ v: API_VERSION_MAJOR, id, ...request }));
  }

  protected waitForEvent(
    predicate: (frame: ServerFrame) => boolean,
    timeoutMs: number,
  ): Promise<void> {
    return new Promise<void>((resolve) => {
      const finish = () => {
        clearTimeout(timer);
        this.off("event", onEvent);
        this.off("close", finish);
        resolve();
      };
      const onEvent = (frame: ServerFrame) => {
        if (predicate(frame)) finish();
      };
      const timer = setTimeout(finish, timeoutMs);
      timer.unref?.();
      this.on("event", onEvent);
      this.once("close", finish);
    });
  }

  abstract submitToolResult(sessionId: string, callId: string, result: string | ToolResult): Promise<void>;
}
