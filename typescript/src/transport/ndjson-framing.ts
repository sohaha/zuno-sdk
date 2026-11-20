/** 字节流上的 NDJSON 行分帧。 */

import { HarnessError } from "../utils/harness-error.js";
import { StringDecoder } from "node:string_decoder";

/**
 * 残余缓冲的上限。一行协议帧不应超过这个量级；
 * 没有上限的话，永不换行的对端会让内存无界增长。
 */
const MAX_FRAME_BYTES = 8 * 1024 * 1024;

/**
 * 增量式换行分隔 JSON 解码器。
 *
 * socket 可能在任意位置切开帧，所以按 chunk 解码是错的；这里维护一个
 * 残余缓冲，只在行完整时才产出。空行会被跳过，与 Rust 端读取器一致。
 */
export class NdjsonDecoder {
  private buffer = "";
  private readonly utf8 = new StringDecoder("utf8");

  push(chunk: Buffer | string): unknown[] {
    // socket 可以在一个 Unicode 字符的字节中间断开，不能逐块 toString。
    this.buffer += typeof chunk === "string" ? chunk : this.utf8.write(chunk);
    if (this.buffer.length > MAX_FRAME_BYTES && !this.buffer.includes("\n")) {
      this.buffer = "";
      throw new HarnessError("frame_too_large", `单帧超过 ${MAX_FRAME_BYTES} 字节上限`);
    }
    const out: unknown[] = [];
    let index = this.buffer.indexOf("\n");
    while (index !== -1) {
      const line = this.buffer.slice(0, index).trim();
      this.buffer = this.buffer.slice(index + 1);
      if (line !== "") out.push(JSON.parse(line));
      index = this.buffer.indexOf("\n");
    }
    return out;
  }
}

export function encodeFrame(frame: unknown): string {
  return `${JSON.stringify(frame)}\n`;
}
