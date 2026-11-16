/**
 * SDK 的错误类型。
 *
 * 单独放在一个模块里，是因为多个模块都会抛出它，
 * 避免从主客户端模块导入造成循环依赖。
 */

/** 带稳定 `code` 的失败，调用方按原因分支，而不是按消息文本。 */
export class HarnessError extends Error {
  readonly code: string;
  /** 底层系统错误（如有）。 */
  cause?: unknown;
  constructor(code: string, message: string, cause?: unknown) {
    super(`${code}: ${message}`);
    this.code = code;
    this.name = "HarnessError";
    if (cause !== undefined) this.cause = cause;
  }
}
