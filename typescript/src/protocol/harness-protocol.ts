/**
 * zuno harness API（协议 v1）的协议层类型。
 *
 * 与 `crates/zuno-harness-api` 严格对应：请求标签在 `req` 下，
 * 事件标签在 `ev` 下，每个帧都携带 `v`。本文件必须与 Rust 枚举保持同步；
 * 如果标签集合出现漂移，`test/schema-parity.test.ts` 会让构建失败。
 */

export const API_VERSION_MAJOR = 1;
export const API_VERSION_MINOR = 13;

export type RuntimeCommand = "skills" | "context" | "info" | "cache" | "memory" | "swarm" | "agents" | "subagent_model" | "autoreview" | "autojudge" | "transport" | "fast" | "overnight" | "productivity" | "premium" | "provider_test_coverage" | "refresh_model_list" | "continue" | "resume_all" | "remote" | "server_reload" | "review" | "judge" | "subagent" | "auth" | "logout";

export type PermissionDecision = "allow" | "allow_always" | "deny";

export type ErrorCode =
  | "unsupported"
  | "unsupported_version"
  | "unknown_request"
  | "unknown_session"
  | "invalid_request"
  | "internal";

/** 创建会话时的一次性临时渠道（与 CLI `--channel-*` 同语义）。 */
export interface ProviderChannelSpec {
  /** openai-compatible（缺省）、openai-responses、anthropic-compatible、
   * claude-code 或 openrouter。 */
  channel_type?: string;
  /** 渠道 API 基址，例如 https://llm.example.com/v1。 */
  base_url: string;
  /** 渠道 API key。 */
  api_key?: string;
  /** 渠道默认模型 id。 */
  default_model?: string;
}

/** 内建文件工具的累计改动，不是工作区净 diff。 */
export interface SessionEditStats {
  added: number;
  removed: number;
  approximate: boolean;
}

export interface SessionInfo {
  edit_stats?: SessionEditStats;
  session_id: string;
  /** swarm 属主，绝不是转录记录中普通的 fork 父级。 */
  parent_session_id?: string;
  /** 稳定的任务/角色标签，独立于正式的显示标题。 */
  agent_label?: string;
  /** 最近持久化的 swarm 生命周期状态，不是连接状态。 */
  swarm_status?: string;
  working_dir?: string;
  title?: string;
  status: string;
  /** 是否有用户客户端附着。旧服务端会省略，等同于 false。 */
  user_connected?: boolean;
  /** 已存储转录记录的近似大小（字节）。 */
  transcript_bytes?: number;
  archived?: boolean;
  archived_at_ms?: number;
}

/** 有持久化响应的已跟踪回合，独立于历史选择器记录。 */
export interface ModelUsage {
  count: number;
  last_used_unix_secs?: number | null;
  tracking_started_unix_secs?: number | null;
  selection_count: number;
  last_selected_unix_secs?: number | null;
}

/** 最优优先的用量排序。先按搜索相关性，最后按稳定标识。 */
export function compareModelUsage(a?: ModelUsage | null, b?: ModelUsage | null): number {
  if (!a || !b) return a ? -1 : b ? 1 : 0;
  return b.count - a.count
    || (b.last_used_unix_secs ?? -1) - (a.last_used_unix_secs ?? -1)
    || b.selection_count - a.selection_count
    || (b.last_selected_unix_secs ?? -1) - (a.last_selected_unix_secs ?? -1);
}

export interface ModelRouteInfo {
  model: string;
  provider: string;
  api_method: string;
  available: boolean;
  detail: string;
  usage?: ModelUsage;
}

export interface TextMatch {
  path: string;
  line: number;
  column: number;
  preview: string;
}

/** 供跟进策略使用的持久化 todo 状态。 */
export interface TodoSnapshot {
  todos: Array<Record<string, unknown>>;
  plan: Record<string, unknown>;
  goals: Array<Record<string, unknown>>;
  gate_observations: Array<Record<string, unknown>>;
  long_session_review_due: boolean;
  /** Session-scoped background task IDs still running. Absent on older servers. */
  running_background_tasks?: string[];
}

export interface TodoEffects {
  clear_gate_observations?: boolean;
  mark_long_session_review_delivered?: boolean;
}

/** 一个用户回合内所有助手轮次的 provider 原始计数之和，可持久化。
 * 缺失的指标表示未知，而不是零。各 provider 的缓存口径不同。
 * 恢复出的时长目前不可用。 */
export interface ResponseStats {
  duration_secs?: number;
  input_tokens?: number;
  output_tokens?: number;
  cache_read_tokens?: number;
  cache_creation_tokens?: number;
}

export interface HistoryMessage {
  /** 仅在最后一条 assistant 行上。预览/旧服务端的历史可能省略它。 */
  response_stats?: ResponseStats;
  /** "user" | "assistant" | "tool" */
  role: string;
  content: string;
}

export type RenderedImageSource =
  | { kind: "user_input" }
  | { kind: "tool_result"; tool_name: string }
  | { kind: "other"; role: string };

export type RenderedImageAnchor =
  | { kind: "tool_call"; id: string }
  | { kind: "user_prompt"; ordinal: number };

export interface RenderedImage {
  media_type: string;
  data: string;
  label?: string;
  source: RenderedImageSource;
  anchor?: RenderedImageAnchor;
  /** 插入到该 History.messages 下标之前（含隐藏行）。等于长度表示追加。 */
  history_message_index?: number;
}

/** Base64 图片附件：[mediaType, base64Data]。 */
export type ImageAttachment = [string, string];

/** 暴露给模型的工具定义。 */
export interface SessionToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

/** 协议层的会话工具策略。回调函数永远不会跨线传输。 */
export interface ToolConfiguration {
  enabled?: string[] | null;
  disabled?: string[];
  custom?: SessionToolDefinition[];
}

export type ApiRequest =
  | {
      req: "hello";
      min_version: number;
      max_version: number;
      client: string;
      /** 客户端把 `user_response` 工具调用渲染为内联 Markdown。 */
      supports_user_response?: boolean;
    }
  | { req: "list_sessions"; include_archived?: boolean; limit?: number }
  | { req: "archive_session"; session_id: string }
  | { req: "restore_session"; session_id: string }
  | { req: "delete_session"; session_id: string }
  | { req: "set_retention_policy"; archive_after_days?: number }
  | {
      req: "create_session";
      filesystem?: { read_roots: string[] };
      working_dir?: string;
      system_prompt?: string;
      provider_channel?: ProviderChannelSpec;
      disable_builtin_skills?: boolean;
      disable_global_skills?: boolean;
      role?: string;
    }
  | { req: "attach_session"; session_id: string }
  | { req: "fork_session"; session_id: string }
  | { req: "transfer_session"; session_id: string }
  | { req: "detach_session"; session_id: string }
  | { req: "configure_tools"; session_id: string; tools: ToolConfiguration }
  | { req: "list_tools"; session_id: string }
  | { req: "tool_result"; session_id: string; call_id: string; output: string; error?: string }
  | {
      req: "send_message";
      session_id: string;
      content: string;
      images?: ImageAttachment[];
      no_reply?: boolean;
      system_reminder?: string;
    }
  | { req: "cancel"; session_id: string }
  | {
      req: "soft_interrupt";
      session_id: string;
      content: string;
      images?: ImageAttachment[];
      urgent?: boolean;
      /** 不透明 id，会在 `soft_interrupt_injected` 中回显，可按 id 过滤取消。 */
      client_id?: string;
    }
  | { req: "get_history"; session_id: string }
  | { req: "peek_session"; session_id: string; limit?: number }
  | { req: "clear"; session_id: string }
  | { req: "rewind"; session_id: string; message_index: number }
  | {
      req: "permission_response";
      session_id: string;
      request_id: string;
      decision: PermissionDecision;
    }
  | { req: "list_models"; session_id: string }
  | { req: "get_runtime_info"; session_id: string }
  | { req: "runtime_command"; session_id: string; command: RuntimeCommand; args?: string[] }
  | { req: "set_api_key"; provider: string; api_key: string }
  | { req: "notify_auth_changed"; provider: string }
  | { req: "invalidate_usage"; provider: string; account_label?: string }
  | { req: "clear_api_key"; provider: string }
  | { req: "read_file"; session_id: string; path: string; max_bytes?: number }
  | { req: "find_files"; session_id: string; query: string; limit?: number }
  | { req: "search_text"; session_id: string; query: string; path?: string; limit?: number }
  | { req: "file_status"; session_id: string; path: string }
  | { req: "set_model"; session_id: string; model: string }
  | { req: "set_reasoning_effort"; session_id: string; effort: string }
  | { req: "compact"; session_id: string }
  | { req: "rename_session"; session_id: string; title?: string }
  | { req: "set_session_saved"; session_id: string; saved: boolean; label?: string }
  | {
      req: "applet_action";
      session_id: string;
      instance: string;
      action: AppletAction;
      state?: Record<string, unknown>;
      source_key?: string;
    }
  | { req: "close_applet"; session_id: string; instance: string }
  | { req: "rewind_undo"; session_id: string }
  /** 不带 `client_ids` 时清空队列（回复 `ok`）；带时回复 `soft_interrupts_cancelled`。 */
  | { req: "cancel_soft_interrupts"; session_id: string; client_ids?: string[] }
  /** 服务端声明 `background_tool_result` 能力时回复 `background_tool_result`，否则回复 `ok`。 */
  | { req: "background_tool"; session_id: string }
  | { req: "get_todo_state"; session_id: string }
  | { req: "ack_todo_follow_up"; session_id: string; effects: TodoEffects }
  | { req: "ping" };

/** Markdown/PDF 面板状态，与原生运行时共享。 */
export type SidePanelPageFormat = "markdown" | "pdf";
export type SidePanelPageSource = "managed" | "linked_file" | "ephemeral";
export interface SidePanelPage {
  id: string;
  title: string;
  file_path: string;
  format: SidePanelPageFormat;
  source: SidePanelPageSource;
  content: string;
  /** Base64 编码的 PDF 字节，独立于供人阅读的 Markdown 回退内容。 */
  pdf_data?: string;
  updated_at_ms: number;
}
/** 来自 applet 节点的用户意图（`zuno.applet/1`）。 */
export interface AppletAction {
  action: string;
  args?: unknown;
}

/** 一个已挂载的 applet 实例。`document` 遵循 `zuno.applet/1` schema。 */
export interface AppletInstance {
  id: string;
  applet: string;
  placement: { kind: string; [key: string]: unknown };
  scope?: { kind: string; [key: string]: unknown };
  lifetime?: "ephemeral" | "session" | "persistent";
  document: {
    revision: number;
    title: string;
    view: { type: string; [key: string]: unknown };
    state?: Record<string, unknown>;
    assets?: unknown[];
  };
}

/** 一个会话中所有由 agent 挂载的 applet 实例，按挂载顺序。 */
export interface AgentApplets {
  instances: AppletInstance[];
}

export interface SidePanelSnapshot {
  /** 单调递增的显式聚焦意图。旧服务端没有此字段。 */
  focus_revision?: number;
  focused_page_id: string | null;
  /** 为空时运行时会省略。 */
  pages?: SidePanelPage[];
}

export type ApiEvent =
  | { ev: "hello_ok"; version: number; server: string; capabilities?: string[] }
  | { ev: "ok" }
  | { ev: "runtime_command_result"; session_id: string; command: RuntimeCommand; data: unknown; message: string }
  | { ev: "error"; code: ErrorCode; message: string }
  | { ev: "sessions"; sessions: SessionInfo[] }
  | { ev: "attached"; session: SessionInfo }
  | { ev: "session_forked"; session: SessionInfo }
  | { ev: "history"; session_id: string; messages: HistoryMessage[]; images?: RenderedImage[] }
  | { ev: "pong" }
  | { ev: "text_delta"; session_id: string; text: string; message_id?: string }
  | { ev: "text_done"; session_id: string; message_id?: string }
  | { ev: "text_replace"; session_id: string; message_id?: string; text: string }
  | { ev: "reasoning_delta"; session_id: string; text: string }
  | { ev: "reasoning_done"; session_id: string; duration_secs?: number }
  | { ev: "tool_start"; session_id: string; call_id: string; name: string }
  | { ev: "tool_input_delta"; session_id: string; call_id: string; delta: string }
  | { ev: "tool_exec"; session_id: string; call_id: string; name: string }
  | { ev: "tools"; session_id: string; tools: SessionToolDefinition[] }
  | { ev: "tool_call"; session_id: string; call_id: string; name: string; input: unknown }
  | {
      ev: "tool_done";
      session_id: string;
      call_id: string;
      name: string;
      output: string;
      error?: string;
    }
  | { ev: "side_panel_state"; session_id: string; snapshot: SidePanelSnapshot }
  | { ev: "applet_state"; session_id: string; snapshot: AgentApplets }
  | { ev: "side_pane_images"; session_id: string; images: RenderedImage[] }
  | {
      ev: "token_usage";
      session_id: string;
      input: number;
      output: number;
      cache_read_input?: number;
      cache_creation_input?: number;
    }
  | {
      ev: "kv_cache_miss";
      session_id: string;
      reason: string;
      harness_caused: boolean;
      missed_tokens: number;
      expected_tokens: number;
      read_tokens: number;
      documented_cause?: string;
      message: string;
    }
  | { ev: "turn_stopped"; session_id: string; reason: TurnStopReason; message: string; provider_stop_reason?: string }
  /** `pending_soft_interrupts`：本回合未曾看到的排队消息（仅非零时出现）。 */
  | { ev: "turn_done"; session_id: string; pending_soft_interrupts?: number }
  /**
   * 排队的软中断已送达模型。此事件之后的输出都是在看到这些消息后产生的。
   * 多条排队消息会作为一条用户消息投递，因此 `client_ids` 按队列顺序
   * 列出所有已投递的 id。`point` 取 B、C、D 或 `turn_start`
   * （空闲时发送，因此开启了一个回合）。
   */
  | {
      ev: "soft_interrupt_injected";
      session_id: string;
      client_ids: string[];
      point: string;
      tools_skipped?: number;
      display_role?: string;
    }
  /** 对按 id 过滤的 `cancel_soft_interrupts` 的回复。与投递原子判定。 */
  | { ev: "soft_interrupts_cancelled"; cancelled: string[]; not_queued: string[] }
  /** 对 `background_tool` 的回复。 */
  | { ev: "background_tool_result"; moved: boolean; tool_call_id?: string; tool_name?: string }
  | {
      ev: "wake_requested";
      session_id: string;
      reason: string;
      notification: string;
    }
  | {
      ev: "background_progress";
      session_id: string;
      task_id: string;
      label: string;
      percent?: number;
      summary: string;
      done?: boolean;
    }
  | { ev: "message_accepted"; session_id: string }
  | {
      ev: "permission_request";
      session_id: string;
      request_id: string;
      tool_name: string;
      description: string;
    }
  /** 持久化的 todo 快照。对 `get_todo_state` 的回复。需要 `todo_state` 能力。 */
  | { ev: "todo_state"; session_id: string; state: TodoSnapshot }
  /** 附着恢复意图。可能先于 attached 到达。bridge 从不自动发送。 */
  | { ev: "session_recovery"; session_id: string; continuation_message: string; reconnect_notice?: string }
  | { ev: "session_status"; session_id: string; status: string; pending_soft_interrupts?: number }
  | { ev: "connection_phase"; session_id: string; phase: string }
  | {
      ev: "model_info";
      session_id: string;
      provider?: string;
      model?: string;
      reasoning_effort?: string;
      auth_method?: string;
    }
  | { ev: "models"; session_id: string; models: string[]; current?: string }
  | {
      ev: "runtime_info";
      session_id: string;
      provider?: string;
      model?: string;
      reasoning_effort?: string;
      auth_method?: string;
      routes: ModelRouteInfo[];
    }
  | { ev: "credential_updated"; provider: string; configured: boolean }
  | {
      ev: "file_content";
      session_id: string;
      path: string;
      content: string;
      size: number;
      truncated: boolean;
    }
  | { ev: "files"; session_id: string; paths: string[] }
  | { ev: "text_matches"; session_id: string; matches: TextMatch[] }
  | {
      ev: "file_status";
      session_id: string;
      path: string;
      exists: boolean;
      kind: string;
      size?: number;
      modified_ms?: number;
    }
  | { ev: "compacted"; session_id: string; message: string }
  | {
      ev: "session_renamed";
      session_id: string;
      title?: string;
      display_title: string;
    };

/**
 * 本 SDK 不认识的事件类型。
 *
 * harness 可能随时在协议 v1 内新增事件，因此运行时可能收到这种帧。
 * 它被有意排除在 `ApiEvent` 之外：一个 `ev: string` 的成员会放宽判别
 * 字段，TypeScript 随之无法把 `event.ev === "text_delta"` 收窄到
 * text-delta 成员，所有字段都会变成 `unknown`。前向兼容是运行时属性，
 * 用百分之九十九场景的类型安全去换它并不划算。
 *
 * 用 `default` 分支处理，或用 `isKnownEvent` 过滤。
 */
export interface UnknownApiEvent {
  ev: string;
  [key: string]: unknown;
}

/** 线上来的任意帧，无论是否已知。用 `isKnownEvent` 收窄。 */
export type AnyApiEvent = ApiEvent | UnknownApiEvent;

export type ApiEventKind = ApiEvent["ev"];

export interface ClientFrame {
  v: number;
  id: number;
  [key: string]: unknown;
}

export type ServerFrame = { v: number; reply_to?: number } & UnknownApiEvent;

/** SDK 已知的所有事件标签，用于漂移检查和路由。 */
export const KNOWN_EVENT_KINDS = [
  "applet_state",
  "attached",
  "background_progress",
  "background_tool_result",
  "compacted",
  "connection_phase",
  "credential_updated",
  "error",
  "file_content",
  "file_status",
  "files",
  "hello_ok",
  "history",
  "kv_cache_miss",
  "message_accepted",
  "model_info",
  "models",
  "ok",
  "permission_request",
  "pong",
  "reasoning_delta",
  "reasoning_done",
  "runtime_command_result",
  "runtime_info",
  "session_forked",
  "session_recovery",
  "session_renamed",
  "session_status",
  "sessions",
  "side_pane_images",
  "side_panel_state",
  "soft_interrupt_injected",
  "soft_interrupts_cancelled",
  "text_matches",
  "text_delta",
  "text_done",
  "text_replace",
  "todo_state",
  "token_usage",
  "tool_call",
  "tool_done",
  "tool_exec",
  "tool_input_delta",
  "tool_start",
  "tools",
  "turn_done",
  "turn_stopped",
  "wake_requested",
] as const;

/** SDK 可发送的所有请求标签。 */
export const KNOWN_REQUEST_KINDS = [
  "ack_todo_follow_up",
  "applet_action",
  "archive_session",
  "attach_session",
  "background_tool",
  "cancel",
  "cancel_soft_interrupts",
  "clear",
  "clear_api_key",
  "close_applet",
  "compact",
  "configure_tools",
  "create_session",
  "delete_session",
  "detach_session",
  "file_status",
  "find_files",
  "fork_session",
  "get_history",
  "get_runtime_info",
  "get_todo_state",
  "hello",
  "invalidate_usage",
  "list_models",
  "list_sessions",
  "list_tools",
  "notify_auth_changed",
  "peek_session",
  "permission_response",
  "ping",
  "read_file",
  "rename_session",
  "restore_session",
  "rewind",
  "rewind_undo",
  "runtime_command",
  "search_text",
  "send_message",
  "set_api_key",
  "set_model",
  "set_reasoning_effort",
  "set_retention_policy",
  "set_session_saved",
  "soft_interrupt",
  "tool_result",
  "transfer_session",
] as const;

export function isKnownEvent(frame: AnyApiEvent): frame is ApiEvent {
  return (KNOWN_EVENT_KINDS as readonly string[]).includes(frame.ev);
}

/** 自然完成没有停止原因。传输中断不能证明是崩溃。 */
export type TurnStopReason = "interrupted" | "failure" | "crash" | "provider_guardrail" | "limit_reached" | "unknown";
