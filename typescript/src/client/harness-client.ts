/**
 * Harness 客户端：握手、请求/回复关联与事件流。
 */

import net from "node:net";
import { apiSocketPath, transportEndpoint } from "../transport/socket-endpoint.js";
import { launchInstance, type LaunchOptions, type LaunchedInstance } from "../runtime/instance-launch.js";
import { HarnessError } from "../utils/harness-error.js";
import { prepareTools, type SessionToolsOptions, type ToolResult } from "../session/tool-callbacks.js";
import { ClientCore, type Transport } from "./connection-core.js";
import { globalEvents, type ChildHandle, type GlobalEventsOptions } from "../session/global-event-stream.js";
import {
  assertRetryCount,
  buildStructuredCorrectionPrompt,
  buildStructuredPrompt,
  compileStructuredSchema,
  StructuredOutputError,
  validateStructuredText,
  type StructuredOutputAttempt,
  type StructuredOutputSchema,
} from "../utils/structured-output.js";
import {
  API_VERSION_MAJOR,
  type AppletAction,
  type ApiEvent,
  type HistoryMessage,
  type ImageAttachment,
  type ModelRouteInfo,
  type PermissionDecision,
  type ProviderChannelSpec,
  type RenderedImage,
  type RuntimeCommand,
  type ServerFrame,
  type SessionInfo,
  type SessionToolDefinition,
  type TextMatch,
  type TodoSnapshot,
  type TodoEffects,
  type TurnStopReason,
} from "../protocol/harness-protocol.js";

export type { Transport } from "./connection-core.js";
export type { GlobalEventsOptions } from "../session/global-event-stream.js";

export interface RuntimeInfo {
  server: string;
  protocolVersion: number;
  capabilities: string[];
  healthy: true;
  sessionId: string;
  provider?: string;
  model?: string;
  providers: string[];
  routes: ModelRouteInfo[];
}

export interface FileContent {
  path: string;
  content: string;
  size: number;
  truncated: boolean;
}

export interface FileStatus {
  path: string;
  exists: boolean;
  kind: string;
  size?: number;
  modifiedMs?: number;
}

export function unixSocketTransport(socketPath: string): Promise<Transport> {
  return new Promise((resolve, reject) => {
    // Windows 上 bridge 监听由该路径派生的命名管道，而不是路径本身。
    const socket = net.createConnection(transportEndpoint(socketPath));
    socket.setNoDelay(true);
    // 一条裸 `connect ENOENT /run/user/1000/zuno-api.sock` 只报系统调用，
    // 掩盖了真正的原因：bridge 没在运行。连接是任何人用这个 SDK 做的
    // 第一件事，所以这个错误很可能是用户对它的第一印象。要告诉他怎么办。
    const onConnectError = (cause: NodeJS.ErrnoException) =>
      reject(connectError(socketPath, cause));
    socket.once("error", onConnectError);
    socket.once("connect", () => {
      socket.removeListener("error", onConnectError);
      // 连接的整个生命周期都要挂着监听器：未处理的 socket "error"
      // （比如 harness 在写入中途消失导致的 EPIPE）在 Node 里是致命
      // 抛出，调用方应该看到一个被拒绝的请求，而不是一个死进程。
      socket.on("error", () => {});
      resolve({
        write: (data) => {
          if (socket.destroyed || socket.writableEnded) {
            throw new HarnessError("disconnected", "harness 连接已关闭");
          }
          // 对端可能在 destroyed 检查和系统调用之间消失，表现为 EPIPE，
          // 有时还是同步抛出的。把它翻译成被拒绝的请求而不是未捕获异常；
          // 其余在途请求由 close 处理器统一失败。
          try {
            socket.write(data, () => {});
          } catch (cause) {
            throw new HarnessError("disconnected", `写入失败：${String(cause)}`);
          }
        },
        onData: (listener) => socket.on("data", listener),
        onClose: (listener) => {
          socket.on("close", () => listener());
          socket.on("error", (error) => listener(error));
        },
        close: () => socket.destroy(),
      });
    });
  });
}

/** 把拨号失败变成指明可能原因和解决办法的错误。 */
function connectError(socketPath: string, cause: NodeJS.ErrnoException): HarnessError {
  const code = cause.code ?? "unknown";
  const hint =
    code === "ENOENT"
      ? `${socketPath} 上没有 harness API socket。用 ` +
        "`zuno api-bridge` 启动 bridge，或把 ZUNO_API_SOCKET 设为它的路径。"
      : code === "ECONNREFUSED"
        ? `${socketPath} 上没有监听者；这个残留的 socket 文件是已退出的 ` +
          "bridge 留下的。请重启 bridge。"
        : code === "EACCES"
          ? `${socketPath} 权限拒绝：该 socket 属于另一个用户。`
          : `无法连接到 ${socketPath}：${cause.message}`;
  return new HarnessError("connect_failed", hint, cause);
}

export interface ConnectOptions {
  /** 默认取解析出的 harness API socket 路径。 */
  socketPath?: string;
  /** 握手中发送的客户端标识，例如 "my-app/1.0"。 */
  clientName?: string;
  /** 提供自定义 transport，而不是拨 Unix socket。 */
  transport?: Transport;
  /** 请求多久没有回复就拒绝（毫秒）。0 表示关闭超时。 */
  requestTimeoutMs?: number;
}

import { filesystemPolicyWire } from "../protocol/filesystem-policy.js";

export interface CreateSessionOptions {
  /** 只读目录策略，省略继承，空列表拒绝全部。 */
  filesystem?: import("../protocol/filesystem-policy.js").FilesystemPolicy;
  workingDir?: string;
  /**
   * 替换整个组装好的系统提示词，而不只是其中的基础文本部分。
   * 默认指令和组装得到的指令/上下文追加内容不会再附加。
   * 创建后不可变，并由运行时持久化以便恢复。
   * 省略则走正常的提示词组装；空字符串表示显式覆盖为无文本。
   */
  systemPrompt?: string;
  /** 创建期临时渠道（与 CLI `--channel-*` 同语义）：本会话绑定到这个一次性
   * 渠道而不是 daemon 默认 provider。仅新建会话生效。 */
  providerChannel?: ProviderChannelSpec;
  /** 创建期禁用编译期内置技能（`dev-mode` 等）。仅新建会话生效，
   * 用户与项目技能不受影响。 */
  disableBuiltinSkills?: boolean;
  /** 创建期禁用全局技能（`~/.zuno/skills`、`~/.agents/skills`、Claude 插件
   * 技能）。仅新建会话生效，项目与内置技能不受影响。 */
  disableGlobalSkills?: boolean;
  /** 内置角色 id（见 `zuno role list`，如 "pentest"、"ui-design"），决定
   * 会话身份提示词与捆绑技能。仅新建会话生效；未知 id 由 daemon 报错。 */
  role?: string;
  /** 在 createSession 返回前、任何模型回合开始前配置。 */
  tools?: SessionToolsOptions;
}

export interface RunOptions {
  images?: ImageAttachment[];
  onEvent?: (event: ApiEvent) => void;
  /**
   * 自动应答权限请求。
   *
   * 仅在服务端声明 `permissions` 能力时才有意义；
   * 否则不会发出任何权限请求，此选项为空操作。
   */
  autoApprove?: boolean;
}

export interface SendMessageOptions {
  /** 伴随可见用户消息的隐藏提醒，与 Rust SDK 一致。 */
  systemReminder?: string;
  /** 给持久化的用户消息附加图片。 */
  images?: ImageAttachment[];
  /** 把消息作为上下文持久化，不启动模型回合。 */
  noReply?: boolean;
  /** 启动正常模型回合时等待 message_accepted。 */
  waitForAccept?: boolean;
  /** 等待确认的最大毫秒数。 */
  acceptTimeoutMs?: number;
}

export interface RunStructuredOptions<T = unknown> extends RunOptions {
  /** 助手 JSON 响应必须满足的 JSON Schema。 */
  schema: StructuredOutputSchema<T>;
  /** 第一次响应非法后的纠正重试次数。默认 2。 */
  maxRetries?: number;
}

/**
 * 已连接的 harness 客户端。
 *
 * 回复通过服务端回显的 `reply_to` id 关联；没有它的都是流事件，
 * 会在 `event` 频道和按类型的频道上发出（`client.on("text_delta", ...)`）。
 */
export class ZunoClient extends ClientCore {
  private readonly configuringTools = new Set<string>();
  /** 当本客户端拥有一个私有实例时设置，`close()` 会将其停止。 */
  private instance?: LaunchedInstance;

  private constructor(
    transport: Transport,
    requestTimeoutMs: number,
    socketPath: string | undefined,
    clientName: string,
  ) {
    super(transport, requestTimeoutMs, clientName, socketPath);
  }

  /** 本客户端启动的实例的状态目录（如有）。 */
  get instanceHome(): string | undefined {
    return this.instance?.zunoHome;
  }

  /**
   * 启动私有 zuno 实例并连接它。
   *
   * 这是把 zuno 嵌入为 agent 引擎的入口。实例有自己的状态目录、
   * 自己的会话和自己的 socket，看不到也不会干扰用户交互运行的 zuno。
   * `close()` 会将其关闭。
   *
   * 默认继承用户的 provider 登录态，因为没有凭据的实例根本访问不了
   * 模型。传 `inheritLogins: false` 可空启动。
   */
  static async launch(options: LaunchOptions & ConnectOptions = {}): Promise<ZunoClient> {
    const instance = await launchInstance(options);
    try {
      const client = await ZunoClient.connect({
        ...options,
        socketPath: instance.socketPath,
      });
      if ((options.filesystem !== undefined || options.env?.ZUNO_FILESYSTEM_POLICY !== undefined ||
          process.env.ZUNO_FILESYSTEM_POLICY !== undefined) && !client.supports("filesystem_policy")) {
        client.close();
        throw new HarnessError("unsupported", "此运行时不支持 filesystem_policy，拒绝启动不受限实例");
      }
      client.instance = instance;
      return client;
    } catch (error) {
      // 客户端始终没连上的已启动实例是一个占着临时目录的流浪 daemon，
      // 重新抛出前先拆掉它。
      await instance.shutdown();
      throw error;
    }
  }

  /**
   * 连接到本机已在运行的 zuno。
   *
   * 用于自动化用户自己的 zuno：编辑器插件、状态仪表盘、热键工具。
   * 它共享用户的活跃会话，这里的任何操作在用户的终端中都可见。
   * 要把 zuno 嵌入为引擎，请改用 {@link ZunoClient.launch}。
   */
  static async connect(options: ConnectOptions = {}): Promise<ZunoClient> {
    const transport = options.transport
      ?? (await unixSocketTransport(options.socketPath ?? apiSocketPath()));
    const socketPath = options.transport ? undefined : (options.socketPath ?? apiSocketPath());
    const clientName = options.clientName ?? "zuno-sdk-ts";
    const client = new ZunoClient(
      transport,
      options.requestTimeoutMs ?? 30_000,
      socketPath,
      clientName,
    );
    let frame: ServerFrame;
    try {
      frame = await client.request({
        req: "hello",
        min_version: API_VERSION_MAJOR,
        max_version: API_VERSION_MAJOR,
        client: clientName,
      });
    } catch (error) {
      await client.close();
      throw error;
    }
    if (frame.ev !== "hello_ok") {
      client.close();
      throw new HarnessError("handshake_failed", `意外的回复：${frame.ev}`);
    }
    client.server = String(frame.server ?? "");
    client.capabilities = (frame.capabilities as string[] | undefined) ?? [];
    return client;
  }

  // --- 精修的对外接口 -----------------------------------------------------

  async listSessions(options: { includeArchived?: boolean; limit?: number } = {}): Promise<SessionInfo[]> {
    const frame = await this.expectReply(
      { req: "list_sessions", include_archived: options.includeArchived, limit: options.limit },
      "sessions",
    );
    return frame.sessions ?? [];
  }

  async listSessionsLimited(limit: number): Promise<SessionInfo[]> {
    return this.listSessions({ limit });
  }

  /** 可逆地把会话从默认列表中隐藏。不删除转录记录。 */
  async archiveSession(sessionId: string): Promise<void> {
    await this.requestOk({ req: "archive_session", session_id: sessionId });
  }

  async restoreSession(sessionId: string): Promise<void> {
    await this.requestOk({ req: "restore_session", session_id: sessionId });
  }

  /**
   * 永久删除一个持久化会话及其转录记录。
   *
   * 不可逆：快照、备份和 journal 都会被删掉，会话 id 从列表中消失。
   * 目标会话不能仍附着在任何客户端上（包括本连接）：daemon 之后会把
   * 它重新写回磁盘。删除前先关闭拥有它的连接，或改用一个未附着的连接。
   * 需要 `session_delete` 能力。
   */
  async deleteSession(sessionId: string): Promise<void> {
    if (!this.supports("session_delete")) {
      throw new HarnessError(
        "unsupported",
        "此 bridge 不支持删除会话。请更新 zuno 运行时和 API bridge。",
      );
    }
    await this.requestOk({ req: "delete_session", session_id: sessionId });
  }

  /** 不活跃会话超过该天数后自动归档；省略则关闭。 */
  async setRetentionPolicy(archiveAfterDays?: number): Promise<void> {
    await this.requestOk({ req: "set_retention_policy", archive_after_days: archiveAfterDays });
  }

  async createSession(options?: string | CreateSessionOptions): Promise<SessionInfo> {
    const { workingDir, systemPrompt, providerChannel, disableBuiltinSkills, disableGlobalSkills, role, tools, filesystem } =
      typeof options === "string" ? { workingDir: options } : (options ?? {});
    if (filesystem !== undefined && !this.supports("filesystem_policy")) {
      throw new HarnessError("unsupported", "此运行时不支持 filesystem_policy，请更新 daemon 和 API bridge");
    }
    if (tools) {
      this.requireSessionTools();
      prepareTools(tools);
    }
    const frame = await this.expectReply(
      {
        req: "create_session",
        ...(filesystem !== undefined && { filesystem: filesystemPolicyWire(filesystem) }),
        working_dir: workingDir,
        system_prompt: systemPrompt,
        ...(providerChannel !== undefined && { provider_channel: providerChannel }),
        ...(disableBuiltinSkills !== undefined && disableBuiltinSkills && { disable_builtin_skills: true }),
        ...(disableGlobalSkills !== undefined && disableGlobalSkills && { disable_global_skills: true }),
        ...(role !== undefined && { role }),
      },
      "attached",
    );
    if (tools) await this.configureTools(frame.session.session_id, tools);
    return frame.session;
  }

  private requireSessionTools(): void {
    if (!this.supports("session_tools")) {
      throw new HarnessError("unsupported", "此 harness 不支持 session_tools。请更新 zuno 运行时和 API bridge。");
    }
  }

  /** 在会话空闲时替换工具策略。发下一条消息前请先等待完成。 */
  async configureTools(sessionId: string, options: SessionToolsOptions): Promise<void> {
    this.requireSessionTools();
    if (this.configuringTools.has(sessionId)) {
      throw new HarnessError("busy", "该会话已有一个工具配置请求进行中");
    }
    const prepared = prepareTools(options);
    this.configuringTools.add(sessionId);
    try {
      const frame = await this.requestFrame(
        { req: "configure_tools", session_id: sessionId, tools: prepared.wire },
        (reply) => {
          // 与 ingest 同步：同一网络块里的回调会看到新表。
          // 在这个 ack 之前，进行中的回合必须继续用旧表。
          if (reply.ev === "ok") this.toolCallbacks.sessions.set(sessionId, prepared.handlers);
        },
      );
      if (frame.ev === "error") throw new HarnessError(String(frame.code), String(frame.message));
      if (frame.ev !== "ok") throw new HarnessError("unexpected_reply", `期望 ok，收到 ${frame.ev}`);
    } catch (error) {
      // 结果不确定时，绝不能让新的远端定义配上旧的回调。
      if (error instanceof HarnessError && (error.code === "timeout" || error.code === "unexpected_reply")) {
        void this.close();
      }
      throw error;
    } finally {
      this.configuringTools.delete(sessionId);
    }
  }

  /** 查看当前对模型生效的工具定义。 */
  async listTools(sessionId: string): Promise<SessionToolDefinition[]> {
    this.requireSessionTools();
    return (await this.expectReply({ req: "list_tools", session_id: sessionId }, "tools")).tools;
  }

  /** 底层应答接口，供自行处理 tool_call 事件的应用使用。 */
  async submitToolResult(sessionId: string, callId: string, result: string | ToolResult): Promise<void> {
    const value = typeof result === "string" ? { output: result } : result;
    await this.expectReply({ req: "tool_result", session_id: sessionId, call_id: callId,
      output: value.output, error: value.error }, "ok");
  }

  async attachSession(sessionId: string): Promise<SessionInfo> {
    const frame = await this.expectReply(
      { req: "attach_session", session_id: sessionId },
      "attached",
    );
    return frame.session;
  }

  /** 把会话完整的持久化上下文克隆到一个新的空闲会话。 */
  async forkSession(sessionId: string): Promise<SessionInfo> {
    const frame = await this.expectReply(
      { req: "fork_session", session_id: sessionId },
      "session_forked",
    );
    return frame.session;
  }

  async detachSession(sessionId: string): Promise<void> {
    await this.requestOk({ req: "detach_session", session_id: sessionId });
    this.toolCallbacks.abort(sessionId);
    this.toolCallbacks.sessions.delete(sessionId);
  }

  /**
   * 发送一条用户消息。
   *
   * harness 不会在请求层回复 `send_message`：它在 agent 收到消息后
   * 发出 `message_accepted` 作为确认。在这里等回复必然超时，所以
   * 帧直接写出，默认改为等待确认事件。要纯 fire-and-forget 请传
   * `waitForAccept: false`。
   */
  async sendMessage(
    sessionId: string,
    content: string,
    options?: SendMessageOptions,
  ): Promise<void>;
  async sendMessage(
    sessionId: string,
    content: string,
    images?: ImageAttachment[],
    options?: Omit<SendMessageOptions, "images">,
  ): Promise<void>;
  async sendMessage(
    sessionId: string,
    content: string,
    imagesOrOptions: ImageAttachment[] | SendMessageOptions = [],
    legacyOptions: Omit<SendMessageOptions, "images"> = {},
  ): Promise<void> {
    const options: SendMessageOptions = Array.isArray(imagesOrOptions)
      ? { ...legacyOptions, images: imagesOrOptions }
      : imagesOrOptions;
    const images = options.images ?? [];
    if (options.noReply) {
      await this.requestOk({
        req: "send_message",
        session_id: sessionId,
        content,
        images,
        no_reply: true,
      });
      return;
    }
    const waitForAccept = options.waitForAccept ?? true;
    const accepted = waitForAccept
      ? this.waitForEvent(
          (frame) => frame.ev === "message_accepted" && frame.session_id === sessionId,
          options.acceptTimeoutMs ?? 10_000,
        )
      : undefined;
    const systemReminder = options.systemReminder?.trim() || undefined;
    this.notify({ req: "send_message", session_id: sessionId, content, images, system_reminder: systemReminder });
    await accepted;
  }

  /** 提交隐藏的恢复续行消息，不等待消息确认。 */
  async sendSystemReminder(sessionId: string, reminder: string): Promise<void> {
    this.notify({ req: "send_message", session_id: sessionId, content: "", system_reminder: reminder });
  }

  /**
   * 发送一条用户消息，附带只对本回合生效的隐藏系统提醒
   * （例如某个 collection 的指令）。提醒会引导模型，
   * 但不会出现在可见的转录记录里。
   */
  async sendMessageWithReminder(
    sessionId: string,
    content: string,
    images: ImageAttachment[] = [],
    systemReminder?: string,
    options: Pick<SendMessageOptions, "waitForAccept" | "acceptTimeoutMs"> = {},
  ): Promise<void> {
    await this.sendMessage(sessionId, content, {
      images,
      systemReminder,
      waitForAccept: options.waitForAccept,
      acceptTimeoutMs: options.acceptTimeoutMs,
    });
  }

  async cancel(sessionId: string): Promise<void> {
    await this.requestOk({ req: "cancel", session_id: sessionId });
    this.toolCallbacks.abort(sessionId);
  }

  async softInterrupt(sessionId: string, content: string, urgent = false): Promise<void> {
    await this.softInterruptWithImages(sessionId, content, [], urgent);
  }

  async softInterruptWithImages(
    sessionId: string,
    content: string,
    images: ImageAttachment[],
    urgent = false,
  ): Promise<void> {
    await this.softInterruptWithId(sessionId, content, { images, urgent });
  }

  /**
   * 给进行中的回合排入一条消息，并打上不透明的 `clientId`。
   *
   * 模型收到该消息后，id 会通过 `soft_interrupt_injected` 事件回传，
   * 此前可以用 {@link cancelSoftInterrupt} 撤回。需要
   * `soft_interrupt_ids` 能力；旧服务端会接受消息但丢弃 id。
   */
  async softInterruptWithId(
    sessionId: string,
    content: string,
    options: { clientId?: string; images?: ImageAttachment[]; urgent?: boolean } = {},
  ): Promise<void> {
    const images = options.images ?? [];
    await this.requestOk({
      req: "soft_interrupt",
      session_id: sessionId,
      content,
      images: images.length > 0 ? images : undefined,
      urgent: options.urgent ?? false,
      client_id: options.clientId,
    });
  }

  async getHistory(sessionId: string): Promise<HistoryMessage[]> {
    const { messages } = await this.getHistoryWithImages(sessionId);
    return messages;
  }

  async getHistoryWithImages(
    sessionId: string,
  ): Promise<{ messages: HistoryMessage[]; images: RenderedImage[] }> {
    const frame = await this.expectReply(
      { req: "get_history", session_id: sessionId },
      "history",
    );
    return { messages: frame.messages ?? [], images: frame.images ?? [] };
  }

  async peekSession(sessionId: string, limit?: number): Promise<HistoryMessage[]> {
    const frame = await this.expectReply(
      { req: "peek_session", session_id: sessionId, limit },
      "history",
    );
    return frame.messages ?? [];
  }

  async clear(sessionId: string): Promise<void> {
    await this.requestOk({ req: "clear", session_id: sessionId });
  }

  async rewind(sessionId: string, messageIndex: number): Promise<void> {
    await this.requestOk({ req: "rewind", session_id: sessionId, message_index: messageIndex });
  }

  async respondToPermission(
    sessionId: string,
    requestId: string,
    decision: PermissionDecision,
  ): Promise<void> {
    await this.requestOk({
      req: "permission_response",
      session_id: sessionId,
      request_id: requestId,
      decision,
    });
  }

  /**
   * 本会话可切换的模型，以及当前在用的模型。
   *
   * 数据来自 daemon 在附着时推送的目录，所以打开模型选择器
   * 不需要额外往返。
   */
  async listModels(sessionId: string): Promise<{ models: string[]; current?: string }> {
    const frame = await this.expectReply({ req: "list_models", session_id: sessionId }, "models");
    return { models: frame.models ?? [], current: frame.current };
  }

  /** 执行结构化原生命令，不将命令发送为模型提示词。 */
  async runtimeCommand(sessionId: string, command: RuntimeCommand, args: string[] = []): Promise<{
    session_id: string; command: RuntimeCommand; data: unknown; message: string;
  }> {
    if (!this.capabilities.includes("runtime_commands")) {
      throw new HarnessError("unknown_request", "此运行时不支持结构化命令，请更新并重启守护进程和桥接服务。");
    }
    const frame = await this.expectReply(
      { req: "runtime_command", session_id: sessionId, command, args }, "runtime_command_result",
    );
    return { session_id: frame.session_id, command: frame.command, data: frame.data, message: frame.message };
  }

  /** 通过运行时压缩交接创建新会话，保留父会话。 */
  async transferSession(sessionId: string): Promise<SessionInfo> {
    const frame = await this.expectReply({ req: "transfer_session", session_id: sessionId }, "session_forked");
    return frame.session;
  }

  /** 运行时标识、路由目录、协议元数据与实时健康检查。 */
  async getRuntimeInfo(sessionId: string): Promise<RuntimeInfo> {
    await this.ping();
    const frame = await this.expectReply(
      { req: "get_runtime_info", session_id: sessionId },
      "runtime_info",
    );
    const routes = frame.routes ?? [];
    return {
      server: this.server,
      protocolVersion: API_VERSION_MAJOR,
      capabilities: [...this.capabilities],
      healthy: true,
      sessionId: frame.session_id,
      provider: frame.provider,
      model: frame.model,
      providers: [
        ...new Set(
          [frame.provider, ...routes.map((route) => route.provider)].filter(
            (provider): provider is string => provider !== undefined,
          ),
        ),
      ],
      routes,
    };
  }

  /** 把 API key 持久化到 zuno 仅属主可访问的 provider 存储并热加载。 */
  async setApiKey(provider: string, apiKey: string): Promise<void> {
    await this.expectReply({ req: "set_api_key", provider, api_key: apiKey }, "credential_updated");
  }

  async clearApiKey(provider: string): Promise<void> {
    await this.expectReply({ req: "clear_api_key", provider }, "credential_updated");
  }

  /** 重载带外 OAuth 登录保存的凭据。不含任何密钥或聊天消息。 */
  async notifyAuthChanged(provider: string): Promise<void> {
    await this.expectReply({ req: "notify_auth_changed", provider }, "ok");
  }

  /**
   * 告知 daemon 某个订阅登录（`claude` 或 `openai`）已兑换了一次
   * 存储的用量重置，让它重新拉取配额。不携带凭据。
   */
  async invalidateUsage(provider: string, accountLabel?: string): Promise<void> {
    await this.expectReply(
      accountLabel === undefined
        ? { req: "invalidate_usage", provider }
        : { req: "invalidate_usage", provider, account_label: accountLabel },
      "ok",
    );
  }

  async readFile(sessionId: string, path: string, maxBytes?: number): Promise<FileContent> {
    const frame = await this.expectReply(
      { req: "read_file", session_id: sessionId, path, max_bytes: maxBytes },
      "file_content",
    );
    return { path: frame.path, content: frame.content, size: frame.size, truncated: frame.truncated };
  }

  async findFiles(sessionId: string, query: string, limit?: number): Promise<string[]> {
    const frame = await this.expectReply(
      { req: "find_files", session_id: sessionId, query, limit },
      "files",
    );
    return frame.paths;
  }

  async searchText(
    sessionId: string,
    query: string,
    options: { path?: string; limit?: number } = {},
  ): Promise<TextMatch[]> {
    const frame = await this.expectReply(
      { req: "search_text", session_id: sessionId, query, ...options },
      "text_matches",
    );
    return frame.matches;
  }

  async fileStatus(sessionId: string, path: string): Promise<FileStatus> {
    const frame = await this.expectReply(
      { req: "file_status", session_id: sessionId, path },
      "file_status",
    );
    return {
      path: frame.path,
      exists: frame.exists,
      kind: frame.kind,
      size: frame.size,
      modifiedMs: frame.modified_ms,
    };
  }

  /**
   * 把会话切换到另一个模型。
   *
   * `model` 是 `listModels` 返回的 id。模型未知或 provider 拒绝时以
   * `invalid_request` 拒绝，而不是让会话静默停留在旧模型上。
   */
  async setModel(sessionId: string, model: string): Promise<void> {
    await this.requestOk({ req: "set_model", session_id: sessionId, model });
  }

  /**
   * 设置模型回答前的思考强度。
   *
   * 通常是 "minimal" | "low" | "medium" | "high" | "xhigh" | "max"，
   * 但可接受的集合因 provider 而异，所以这里收字符串并如实上报
   * provider 的答复，而不是猜测一个迟早过时的联合类型。
   */
  async setReasoningEffort(sessionId: string, effort: string): Promise<void> {
    await this.requestOk({ req: "set_reasoning_effort", session_id: sessionId, effort });
  }

  /**
   * 调度对已有转录记录的压缩，释放上下文。
   *
   * 不是同步的：daemon 在下一个安全点做总结，而不是打断当前回合，
   * 所以此 promise 完成意味着请求被接受。之后读历史记录看结果。
   * 被拒绝（没有可压缩的内容、回合进行中）会以 `invalid_request`
   * 和原因一起拒绝。
   */
  async compact(sessionId: string): Promise<string> {
    const frame = await this.expectReply({ req: "compact", session_id: sessionId }, "compacted");
    return frame.message;
  }

  /** 设置会话标题。省略 `title` 则恢复生成的标题。 */
  async renameSession(sessionId: string, title?: string): Promise<void> {
    await this.requestOk({ req: "rename_session", session_id: sessionId, title });
  }

  /** 收藏或取消收藏会话。带 label 时同时成为标题。 */
  async setSessionSaved(sessionId: string, saved: boolean, label?: string): Promise<void> {
    await this.requestOk({ req: "set_session_saved", session_id: sessionId, saved, label });
  }

  /** 上报 agent applet 实例中的用户操作。 */
  async appletAction(
    sessionId: string,
    instance: string,
    action: AppletAction,
    state: Record<string, unknown> = {},
    sourceKey?: string,
  ): Promise<void> {
    await this.requestOk({
      req: "applet_action",
      session_id: sessionId,
      instance,
      action,
      state,
      source_key: sourceKey,
    });
  }

  /** 关闭一个 agent applet 实例。不会唤醒 agent。 */
  async closeApplet(sessionId: string, instance: string): Promise<void> {
    await this.requestOk({ req: "close_applet", session_id: sessionId, instance });
  }

  /** 恢复上一次 `rewind` 移除的历史。 */
  async rewindUndo(sessionId: string): Promise<void> {
    await this.requestOk({ req: "rewind_undo", session_id: sessionId });
  }

  /** 丢弃已排队但尚未投递的软中断。 */
  async cancelSoftInterrupts(sessionId: string): Promise<void> {
    await this.requestOk({ req: "cancel_soft_interrupts", session_id: sessionId });
  }

  /**
   * 按 `client_id` 撤回指定的已排队软中断。
   *
   * 与投递原子判定：`cancelled` 里的 id 从未到达模型，
   * `notQueued` 里的已经到达（或从未排队）。需要
   * `soft_interrupt_ids` 能力。
   */
  async cancelSoftInterruptsById(
    sessionId: string,
    clientIds: string[],
  ): Promise<{ cancelled: string[]; notQueued: string[] }> {
    const frame = await this.expectReply(
      { req: "cancel_soft_interrupts", session_id: sessionId, client_ids: clientIds },
      "soft_interrupts_cancelled",
    );
    return { cancelled: frame.cancelled ?? [], notQueued: frame.not_queued ?? [] };
  }

  /**
   * 撤回一条已排队的软中断。模型看到之前移除返回 `true`，
   * 已投递返回 `false`。
   */
  async cancelSoftInterrupt(sessionId: string, clientId: string): Promise<boolean> {
    const { cancelled } = await this.cancelSoftInterruptsById(sessionId, [clientId]);
    return cancelled.includes(clientId);
  }

  /** 把正在运行的工具调用转入后台（即 TUI 的 Alt+B）。 */
  async backgroundTool(sessionId: string): Promise<void> {
    await this.backgroundToolResult(sessionId);
  }

  /**
   * 把正在运行的工具调用转入后台，并报告转出的内容。
   * 没有 `background_tool_result` 能力的服务端只回 `ok`，
   * 此时报告为 `{ moved: false }`，即使确实有工具被转后台。
   */
  async backgroundToolResult(
    sessionId: string,
  ): Promise<{ moved: boolean; toolCallId?: string; toolName?: string }> {
    const frame = await this.requestOk({ req: "background_tool", session_id: sessionId });
    if (frame.ev !== "background_tool_result") return { moved: false };
    const result: { moved: boolean; toolCallId?: string; toolName?: string } = {
      moved: frame.moved === true,
    };
    if (typeof frame.tool_call_id === "string") result.toolCallId = frame.tool_call_id;
    if (typeof frame.tool_name === "string") result.toolName = frame.tool_name;
    return result;
  }

  /**
   * 会话的持久化 todo 状态，供自动提醒和质量门禁策略使用。
   * 需要 `todo_state` 能力。
   */
  async todoState(sessionId: string): Promise<TodoSnapshot> {
    const frame = await this.expectReply(
      { req: "get_todo_state", session_id: sessionId },
      "todo_state",
    );
    return frame.state;
  }

  /**
   * 应用跟进决策的持久化效果。`effects` 为空时是空操作。
   */
  async ackTodoFollowUp(sessionId: string, effects: TodoEffects): Promise<void> {
    // 显式 false/undefined/null 不算效果；任何 truthy 字段都视为有动作。
    const hasEffect =
      effects != null &&
      typeof effects === "object" &&
      Object.values(effects).some((value) => value !== undefined && value !== false && value !== null);
    if (!hasEffect) return;
    await this.requestOk({
      req: "ack_todo_follow_up",
      session_id: sessionId,
      effects,
    });
  }

  async ping(): Promise<void> {
    await this.requestOk({ req: "ping" });
  }

  /**
   * 流事件的异步迭代器，可选过滤到单个会话。
   *
   * 会缓冲两次 `next()` 调用之间到达的帧，所以在循环体里 await
   * 慢操作的消费方不会静默丢 delta。
   *
   * 类型是已知事件的联合，因此 `switch (event.ev)` 能收窄每个 case。
   *
   * 运行时仍可能到达未知类型（harness 可能在协议 v1 内新增事件），
   * 请始终保留 `default` 分支。需要严格区分时用 `isKnownEvent`。
   */
  events(sessionId?: string): AsyncIterableIterator<ApiEvent> {
    const queue: ApiEvent[] = [];
    let resolveNext: ((result: IteratorResult<ApiEvent>) => void) | undefined;
    let done = false;

    const onEvent = (frame: ServerFrame) => {
      if (sessionId && "session_id" in frame && frame.session_id !== sessionId) return;
      if (resolveNext) {
        const resolve = resolveNext;
        resolveNext = undefined;
        resolve({ value: frame as ApiEvent, done: false });
      } else {
        queue.push(frame as ApiEvent);
      }
    };
    const onClose = () => {
      void stop();
    };

    const stop = (): Promise<IteratorResult<ApiEvent>> => {
      done = true;
      queue.length = 0;
      this.off("event", onEvent);
      this.off("close", onClose);
      if (resolveNext) {
        const resolve = resolveNext;
        resolveNext = undefined;
        resolve({ value: undefined as never, done: true });
      }
      return Promise.resolve({ value: undefined as never, done: true });
    };

    this.on("event", onEvent);
    this.once("close", onClose);

    return {
      [Symbol.asyncIterator]() {
        return this;
      },
      next: () => {
        if (queue.length > 0) {
          return Promise.resolve({ value: queue.shift()!, done: false });
        }
        if (done) return stop();
        return new Promise<IteratorResult<ApiEvent>>((resolve) => {
          resolveNext = resolve;
        });
      },
      return: stop,
      throw: stop,
    };
  }

  /**
   * 通过每会话子连接汇聚所有会话的事件。
   *
   * bridge 每个连接只能附着一个会话，所以服务端级的事件流是这样
   * 实现的：发现所有持久化会话，给每个会话附着子客户端，再把它们
   * 的事件汇聚到这个迭代器。发现会重复执行，以纳入订阅之后创建的会话。
   *
   * 投递保证是自附着时起，不是历史回放：子连接附着完成之前、或意外
   * 断开并重新附着期间发出的事件，协议 v1 无法恢复。单会话内顺序
   * 保留；不保证跨会话的全局顺序。
   *
   * 调用 `return()`、中止 `signal` 或关闭本客户端会关闭所有子连接。
   * 自定义 transport 会被拒绝，因为 SDK 无法把任意 transport 安全地
   * 克隆成独立的会话连接。
   */
  globalEvents(options: GlobalEventsOptions = {}): AsyncIterableIterator<ApiEvent> {
    const connect: (sessionId: string) => Promise<ChildHandle> = async (sessionId) => {
      const client = await ZunoClient.connect({
        socketPath: this.socketPath,
        clientName: `${this.clientName}/global-events`,
        requestTimeoutMs: this.requestTimeoutMs,
      });
      return client;
    };
    return globalEvents(this, connect, options) as AsyncIterableIterator<ApiEvent>;
  }

  /**
   * 发送一条消息并收集助手回复，直到回合结束。
   *
   * 脚本用的便捷路径：一次调用进，一个回合的文本和工具调用出。
   * `text` 包含回合内所有叙述。只要最后一条分帧助手消息用
   * `finalText`。流式消费方应改用 `events()`。
   */
  async run(
    sessionId: string,
    content: string,
    options: RunOptions = {},
  ): Promise<TurnResult> {
    const stream = this.events(sessionId);
    await this.sendMessage(sessionId, content, options.images ?? []);
    const result: TurnResult = {
      text: "", finalText: "", messages: [], reasoning: "", toolCalls: [], usage: undefined,
    };
    const parts: AssistantTextMessage[] = [];
    const messagesById = new Map<string, AssistantTextMessage>();
    const completed = new Set<AssistantTextMessage>();
    const messageFor = (id?: string): AssistantTextMessage => {
      const key = id ?? "";
      let message = messagesById.get(key);
      if (!message) {
        message = { text: "", ...(id === undefined ? {} : { messageId: id }) };
        messagesById.set(key, message);
        parts.push(message);
      }
      return message;
    };
    const finish = (): TurnResult => {
      result.messages = parts.filter((message) => completed.has(message) && message.text.length > 0);
      // 旧版 bridge 没有 text_done。不要根据推理或工具调用猜边界：
      // 保持历史上的整回合结果。
      result.finalText = result.messages.at(-1)?.text ?? result.text;
      return result;
    };
    for await (const event of stream) {
      options.onEvent?.(event);
      switch (event.ev) {
        // 这里没有任何强转：事件联合按 `ev` 收窄。这正是把未知类型的
        // 兜底成员挡在 `ApiEvent` 之外的目的，也是让被改名的协议字段
        // 无法通过编译的原因。
        case "text_delta":
          result.text += event.text;
          messageFor(event.message_id).text += event.text;
          break;
        case "text_replace":
          messageFor(event.message_id).text = event.text;
          result.text = parts.map((message) => message.text).join("");
          break;
        case "text_done": {
          const key = event.message_id ?? "";
          const message = messagesById.get(key);
          if (message) completed.add(message);
          // 无 id 的分帧仍会分隔连续的消息。带 key 的消息保留可寻址
          // 能力，供完成之后的权威更正使用。
          if (event.message_id === undefined) messagesById.delete(key);
          break;
        }
        case "reasoning_delta":
          result.reasoning += event.text;
          break;
        case "tool_done":
          result.toolCalls.push({
            callId: event.call_id,
            name: event.name,
            output: event.output,
            error: event.error,
          });
          break;
        case "token_usage":
          result.usage = {
            input: event.input,
            output: event.output,
            cacheReadInput: event.cache_read_input,
          };
          break;
        case "permission_request":
          if (options.autoApprove) {
            await this.respondToPermission(sessionId, event.request_id, "allow");
          }
          break;
        case "turn_stopped":
          result.stopReason = event.reason;
          result.stopMessage = event.message;
          break;
        case "turn_done":
          await stream.return?.(undefined as never);
          return finish();
        case "error":
          await stream.return?.(undefined as never);
          throw new HarnessError(event.code ?? "internal", event.message ?? "harness 错误");
      }
    }
    return finish();
  }

  /**
   * 发送一条消息，把助手的回答按 schema 校验解析为 JSON。
   *
   * 这是 SDK 层的约定：不需要特殊的 bridge 或模型特性。初始提示词
   * 要求只输出 JSON；如果响应不是 JSON 或未通过 Ajv 校验，客户端
   * 会发送有上限次数的纠正提示，其中带上归一化的校验错误和此前的文本。
   */
  async runStructured<T = unknown>(
    sessionId: string,
    content: string,
    options: RunStructuredOptions<T>,
  ): Promise<StructuredTurnResult<T>> {
    const { schema, maxRetries = 2, ...runOptions } = options;
    assertRetryCount(maxRetries);
    const validate = compileStructuredSchema(schema);
    const attempts: StructuredOutputAttempt[] = [];
    let prompt = buildStructuredPrompt(content, schema);

    for (let attemptNumber = 1; attemptNumber <= maxRetries + 1; attemptNumber += 1) {
      const turn = await this.run(sessionId, prompt, runOptions);
      const validation = validateStructuredText(turn.finalText, validate);
      const attempt: StructuredOutputAttempt = {
        attempt: attemptNumber,
        text: turn.finalText,
        errors: validation.errors,
      };
      attempts.push(attempt);
      if (validation.ok) return { ...turn, data: validation.data, attempts };
      prompt = buildStructuredCorrectionPrompt(schema, attempt);
    }

    throw new StructuredOutputError(attempts);
  }

  /**
   * 断开连接；如果本客户端启动过实例，同时停止它。
   *
   * 返回 promise 以便等待已启动实例完全停止；对普通的 `connect()`
   * 客户端它会立即完成，可以忽略。
   */
  close(): Promise<void> {
    this.toolCallbacks.close();
    this.transport.close();
    const instance = this.instance;
    this.instance = undefined;
    return instance ? instance.shutdown() : Promise.resolve();
  }
}

export interface TurnResult {
  /** 自然完成时不存在。失败仍会在 onEvent 之后抛出。 */
  stopReason?: TurnStopReason;
  stopMessage?: string;
  /** 回合内全部助手文本 delta，包括过程叙述。 */
  text: string;
  /** 最后一条已完成的助手消息；旧版 bridge 上为整回合文本。 */
  finalText: string;
  /** 已完成的文本消息。bridge 不支持分帧时为空。 */
  messages: AssistantTextMessage[];
  reasoning: string;
  toolCalls: Array<{ callId: string; name: string; output: string; error?: string }>;
  usage?: { input: number; output: number; cacheReadInput?: number };
}

export interface AssistantTextMessage {
  /** 流内关联 id，不是持久化的历史消息 id。 */
  messageId?: string;
  text: string;
}

export interface StructuredTurnResult<T> extends TurnResult {
  /** 按调用方 schema 校验并解析出的 JSON 值。 */
  data: T;
  /** 全部尝试，包括校验失败的重试和最终成功的响应。 */
  attempts: StructuredOutputAttempt[];
}
