package zuno

// 协议层常量与标签集合。
//
// 与 crates/zuno-harness-api 严格对应：请求标签在 `req` 下，
// 事件标签在 `ev` 下，每个帧都携带 `v`。标签集合由 schema-parity
// 测试与 Rust 枚举钉住；如果标签集合出现漂移，测试会让构建失败。

// KnownEventKinds 是 SDK 已知的所有事件标签，用于漂移检查和路由。
var KnownEventKinds = []string{
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
	"subagent_status",
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
}

// KnownRequestKinds 是 SDK 可发送的所有请求标签。
var KnownRequestKinds = []string{
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
}

// IsKnownEvent 判断线上来的帧是否是 SDK 已知的事件类型。
func IsKnownEvent(kind string) bool {
	for _, k := range KnownEventKinds {
		if k == kind {
			return true
		}
	}
	return false
}

// 协议枚举值。
const (
	// PermissionDecision 决定权限请求的应答。
	PermissionAllow       = "allow"
	PermissionAllowAlways = "allow_always"
	PermissionDeny        = "deny"

	// TurnStopReason 自然完成没有停止原因。传输中断不能证明是崩溃。
	StopInterrupted       = "interrupted"
	StopFailure           = "failure"
	StopCrash             = "crash"
	StopProviderGuardrail = "provider_guardrail"
	StopLimitReached      = "limit_reached"
	StopUnknown           = "unknown"
)
