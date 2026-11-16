import { Ajv, type ValidateFunction } from "ajv";
import { HarnessError } from "../utils/harness-error.js";
import type { SessionToolDefinition, ToolConfiguration } from "../protocol/harness-protocol.js";

export interface ToolExecutionContext {
  sessionId: string;
  callId: string;
  /** 在取消、断开连接或回调超时时中止。回调应配合它来停止副作用。 */
  signal: AbortSignal;
}

export interface ToolResult {
  output: string;
  error?: string;
}

/** 会话级工具，或对同名工具的显式替换。 */
export interface SdkTool extends SessionToolDefinition {
  execute(
    input: Record<string, unknown>,
    context: ToolExecutionContext,
  ): string | ToolResult | Promise<string | ToolResult>;
  /** 回调时限（毫秒）。默认 60000，最大 60000。 */
  timeoutMs?: number;
}

export interface SessionToolsOptions {
  /** 省略或传 null 表示继承配置的默认值。传 [] 表示不暴露任何内建或 MCP 工具。 */
  enabled?: string[] | null;
  /** 拒绝项优先，包括优先于自定义工具。 */
  disabled?: string[];
  /** 自定义工具会加入选择，仅在本会话内替换同名工具。 */
  custom?: SdkTool[];
}

type Handler = { tool: SdkTool; validate: ValidateFunction };
export interface PreparedTools {
  wire: ToolConfiguration;
  handlers: Map<string, Handler>;
}

/** 先校验，再改动本地回调表或远端策略。 */
export function prepareTools(options: SessionToolsOptions): PreparedTools {
  const handlers = new Map<string, Handler>();
  const ajv = new Ajv({ strict: false, allErrors: true, addUsedSchema: false });
  const custom = (options.custom ?? []).map((tool) => {
    if (handlers.has(tool.name)) {
      throw new HarnessError("invalid_option", `工具重复：${tool.name}`);
    }
    if (typeof tool.execute !== "function") {
      throw new HarnessError("invalid_option", `${tool.name} 缺少 execute 回调`);
    }
    const timeout = tool.timeoutMs ?? 60_000;
    if (!Number.isInteger(timeout) || timeout < 1 || timeout > 60_000) {
      throw new HarnessError("invalid_option", "tool timeoutMs 必须在 1..60000 之间");
    }
    const definition: SessionToolDefinition = JSON.parse(JSON.stringify({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    }));
    if (!definition.parameters || definition.parameters.type !== "object") {
      throw new HarnessError("invalid_option", `${tool.name} 的 parameters 必须是 object 类型的 JSON Schema`);
    }
    let validate: ValidateFunction;
    try {
      validate = ajv.compile(definition.parameters);
      if ("$async" in validate && validate.$async) throw new Error("不支持异步 schema");
    } catch (error) {
      throw new HarnessError("invalid_option", `${tool.name} 的 schema 无效：${String(error)}`);
    }
    handlers.set(tool.name, { tool: { ...tool, ...definition, timeoutMs: timeout }, validate });
    return definition;
  });
  return {
    wire: {
      enabled: options.enabled == null ? options.enabled : [...options.enabled],
      disabled: [...(options.disabled ?? [])],
      custom,
    },
    handlers,
  };
}

/** 连接本地的分发。观察连接上的事件永远不会执行回调。 */
export class ToolCallbacks {
  readonly sessions = new Map<string, Map<string, Handler>>();
  private readonly active = new Map<string, { sessionId: string; controller: AbortController }>();
  private readonly seen = new Set<string>();

  constructor(
    private readonly submit: (sessionId: string, callId: string, result: ToolResult) => Promise<void>,
    private readonly report: (error: unknown) => void,
  ) {}

  dispatch(sessionId: string, callId: string, name: string, input: unknown): void {
    const handlers = this.sessions.get(sessionId);
    if (!handlers) return;
    const key = JSON.stringify([sessionId, callId]);
    if (this.seen.has(key)) return;
    this.seen.add(key);
    const controller = new AbortController();
    this.active.set(key, { sessionId, controller });
    const handler = handlers.get(name);
    void this.execute(handler, input, { sessionId, callId, signal: controller.signal }, controller)
      .then((result) => {
        if (!controller.signal.aborted || controller.signal.reason === "timeout") {
          return this.submit(sessionId, callId, result);
        }
      })
      .catch(this.report)
      .finally(() => this.active.delete(key));
  }

  private async execute(
    handler: Handler | undefined,
    input: unknown,
    context: ToolExecutionContext,
    controller: AbortController,
  ): Promise<ToolResult> {
    if (!handler) return { output: "", error: "SDK 工具回调未注册" };
    if (!handler.validate(input)) {
      return { output: "", error: `工具输入无效：${JSON.stringify(handler.validate.errors)}` };
    }
    let timer: NodeJS.Timeout | undefined;
    let onAbort: (() => void) | undefined;
    try {
      const aborted = new Promise<never>((_, reject) => {
        onAbort = () => reject(new Error(
          controller.signal.reason === "timeout" ? "SDK 工具回调超时" : "SDK 工具回调已取消",
        ));
        controller.signal.addEventListener("abort", onAbort, { once: true });
        timer = setTimeout(() => controller.abort("timeout"), handler.tool.timeoutMs);
        timer.unref?.();
      });
      const result = await Promise.race([
        Promise.resolve().then(() => {
          controller.signal.throwIfAborted();
          return handler.tool.execute(input as Record<string, unknown>, context);
        }),
        aborted,
      ]);
      if (typeof result === "string") return { output: result };
      if (
        !result || typeof result.output !== "string"
        || (result.error !== undefined && typeof result.error !== "string")
      ) {
        throw new Error("SDK 工具必须返回字符串或 { output: string, error?: string }");
      }
      return { output: result.output, error: result.error };
    } catch (error) {
      return { output: "", error: error instanceof Error ? error.message : String(error) };
    } finally {
      if (timer) clearTimeout(timer);
      if (onAbort) controller.signal.removeEventListener("abort", onAbort);
    }
  }

  abort(sessionId?: string): void {
    for (const entry of this.active.values()) {
      if (sessionId === undefined || entry.sessionId === sessionId) {
        entry.controller.abort("cancelled");
      }
    }
    for (const key of this.seen) {
      if (sessionId === undefined || JSON.parse(key)[0] === sessionId) this.seen.delete(key);
    }
  }

  close(): void {
    this.abort();
    this.sessions.clear();
  }
}
