package zuno

import (
	"encoding/json"

	"github.com/sohaha/zlsgo/zjson"
)

// Event 是服务端推送的一个事件帧。
//
// harness 可能随时在协议 v1 内新增事件，因此运行时可能收到未知类型；
// Kind 仍是原始标签，用 Decode 解进自己定义的结构即可，SDK 不会因此
// 失去其余事件的可用性。
//
// 字段访问器基于 zjson 惰性解析：text_delta 这类高频帧不会被完整
// 展开，按需取值比每帧一次 map 反序列化快一个数量级。
type Event struct {
	// Kind 是 `ev` 标签，例如 "text_delta"。未知事件原样透传。
	Kind string
	// SessionID 是事件所属会话（如果帧里带了 session_id）。
	SessionID string
	// raw 是完整帧（含 v/ev 等信封字段）。
	raw []byte
}

// res 取一个字段的 zjson 视图。
func (e Event) res(key string) *zjson.Res {
	return zjson.GetBytes(e.raw, key)
}

// Decode 把完整帧解进调用方定义的结构体。
// JSON 字段名与协议一致（snake_case），结构体上加对应的 tag 即可。
func (e Event) Decode(v any) error {
	if len(e.raw) == 0 {
		return newError("no_payload", "事件没有可解码的载荷")
	}
	return json.Unmarshal(e.raw, v)
}

// Str 取字符串字段，缺省返回 ""。
// 非字符串标量会被转换（与 zjson 语义一致）。
func (e Event) Str(key string) string {
	return e.res(key).String()
}

// OptStr 取字符串字段，存在才返回第二个 true。
func (e Event) OptStr(key string) (string, bool) {
	res := e.res(key)
	if !res.Exists() {
		return "", false
	}
	return res.String(), true
}

// Bool 取布尔字段，缺省返回 false。
func (e Event) Bool(key string) bool {
	return e.res(key).Bool()
}

// Int 取数值字段，缺省返回 0。
func (e Event) Int(key string) int {
	return e.res(key).Int()
}

// OptInt 取数值字段，存在才返回第二个 true。
func (e Event) OptInt(key string) (int, bool) {
	res := e.res(key)
	if !res.Exists() {
		return 0, false
	}
	return res.Int(), true
}

// Raw 取原始 JSON 字段。字段不存在时返回 nil。
func (e Event) Raw(key string) json.RawMessage {
	raw := e.res(key).Raw()
	if raw == "" {
		return nil
	}
	return json.RawMessage(raw)
}

// Fields 返回帧的全部字段（原始 JSON）。诊断用，走完整解析。
func (e Event) Fields() map[string]json.RawMessage {
	fields := map[string]json.RawMessage{}
	_ = json.Unmarshal(e.raw, &fields)
	return fields
}

// --- 协议数据结构（与 crates/zuno-harness-api 对应） -----------------------

// SessionEditStats 是内建文件工具的累计改动，不是工作区净 diff。
type SessionEditStats struct {
	Added       int  `json:"added"`
	Removed     int  `json:"removed"`
	Approximate bool `json:"approximate"`
}

// SessionInfo 描述一个会话。
type SessionInfo struct {
	EditStats *SessionEditStats `json:"edit_stats,omitempty"`
	SessionID string            `json:"session_id"`
	// ParentSessionID 是 swarm 属主，绝不是转录记录中普通的 fork 父级。
	ParentSessionID string `json:"parent_session_id,omitempty"`
	// AgentLabel 是稳定的任务/角色标签，独立于正式的显示标题。
	AgentLabel string `json:"agent_label,omitempty"`
	// SwarmStatus 是最近持久化的 swarm 生命周期状态，不是连接状态。
	SwarmStatus string `json:"swarm_status,omitempty"`
	WorkingDir  string `json:"working_dir,omitempty"`
	Title       string `json:"title,omitempty"`
	Status      string `json:"status"`
	// UserConnected 表示是否有用户客户端附着。旧服务端会省略，等同于 false。
	UserConnected bool `json:"user_connected,omitempty"`
	// TranscriptBytes 是已存储转录记录的近似大小（字节）。
	TranscriptBytes int64 `json:"transcript_bytes,omitempty"`
	Archived        bool  `json:"archived,omitempty"`
	ArchivedAtMs    int64 `json:"archived_at_ms,omitempty"`
}

// ModelUsage 是有持久化响应的已跟踪回合，独立于历史选择器记录。
type ModelUsage struct {
	Count                   int    `json:"count"`
	LastUsedUnixSecs        *int64 `json:"last_used_unix_secs"`
	TrackingStartedUnixSecs *int64 `json:"tracking_started_unix_secs"`
	SelectionCount          int    `json:"selection_count"`
	LastSelectedUnixSecs    *int64 `json:"last_selected_unix_secs"`
}

// ModelRouteInfo 描述一条模型鉴权路由。
type ModelRouteInfo struct {
	Model     string      `json:"model"`
	Provider  string      `json:"provider"`
	APIMethod string      `json:"api_method"`
	Available bool        `json:"available"`
	Detail    string      `json:"detail"`
	Usage     *ModelUsage `json:"usage,omitempty"`
}

// TextMatch 是一次文本命中的位置。
type TextMatch struct {
	Path    string `json:"path"`
	Line    int    `json:"line"`
	Column  int    `json:"column"`
	Preview string `json:"preview"`
}

// HistoryMessage 是一条历史消息。"user" | "assistant" | "tool"。
type HistoryMessage struct {
	// ResponseStats 仅在最后一条 assistant 行上。预览/旧服务端可能省略。
	ResponseStats json.RawMessage `json:"response_stats,omitempty"`
	Role          string          `json:"role"`
	Content       string          `json:"content"`
}

// RenderedImage 是历史/侧栏帧里渲染出的图片。
type RenderedImage struct {
	MediaType string          `json:"media_type"`
	Data      string          `json:"data"`
	Label     string          `json:"label,omitempty"`
	Source    json.RawMessage `json:"source"`
	Anchor    json.RawMessage `json:"anchor,omitempty"`
	// HistoryMessageIndex 插入到该 History.messages 下标之前（含隐藏行）。
	HistoryMessageIndex int `json:"history_message_index,omitempty"`
}

// ImageAttachment 是 Base64 图片附件：[mediaType, base64Data]。
type ImageAttachment [2]string

// ProviderChannelSpec 是创建会话时的一次性临时渠道
// （与 CLI --channel-* 同语义）。只在 daemon 进程内存里生效，
// 不写 config.toml；daemon 重启后临时渠道消失。
type ProviderChannelSpec struct {
	// ChannelType 是渠道类型：openai-compatible（缺省）、
	// openai-responses、anthropic-compatible、claude-code 或 openrouter。
	ChannelType string `json:"channel_type,omitempty"`
	// BaseURL 是渠道 API 基址，例如 https://llm.example.com/v1。
	BaseURL string `json:"base_url"`
	// APIKey 是渠道 API key。
	APIKey string `json:"api_key,omitempty"`
	// DefaultModel 是渠道默认模型 id。
	DefaultModel string `json:"default_model,omitempty"`
}

// SessionToolDefinition 是暴露给模型的工具定义。
type SessionToolDefinition struct {
	Name        string         `json:"name"`
	Description string         `json:"description"`
	Parameters  map[string]any `json:"parameters"`
}

// ToolConfiguration 是协议层的会话工具策略。
// 回调函数永远不会跨线传输。
type ToolConfiguration struct {
	// Enabled 省略或传 null 表示继承配置的默认值；[] 表示不暴露任何内建工具。
	Enabled  *[]string               `json:"enabled,omitempty"`
	Disabled []string                `json:"disabled,omitempty"`
	Custom   []SessionToolDefinition `json:"custom,omitempty"`
}

// TodoSnapshot 是供跟进策略使用的持久化 todo 状态。
type TodoSnapshot struct {
	Todos                []map[string]any `json:"todos"`
	Plan                 map[string]any   `json:"plan"`
	Goals                []map[string]any `json:"goals"`
	GateObservations     []map[string]any `json:"gate_observations"`
	LongSessionReviewDue bool             `json:"long_session_review_due"`
	// RunningBackgroundTasks 是本会话仍在运行的后台任务 ID。旧服务端没有。
	RunningBackgroundTasks []string `json:"running_background_tasks,omitempty"`
}

// TodoEffects 是应用跟进决策的持久化效果。
type TodoEffects struct {
	ClearGateObservations          bool `json:"clear_gate_observations,omitempty"`
	MarkLongSessionReviewDelivered bool `json:"mark_long_session_review_delivered,omitempty"`
}

// RuntimeInfo 是运行时标识、路由目录、协议元数据与实时健康检查。
type RuntimeInfo struct {
	Server          string           `json:"server"`
	ProtocolVersion int              `json:"protocolVersion"`
	Capabilities    []string         `json:"capabilities"`
	Healthy         bool             `json:"healthy"`
	SessionID       string           `json:"sessionId"`
	Provider        string           `json:"provider,omitempty"`
	Model           string           `json:"model,omitempty"`
	Providers       []string         `json:"providers"`
	Routes          []ModelRouteInfo `json:"routes"`
}

// FileContent 是一次读文件的回复。
type FileContent struct {
	Path      string `json:"path"`
	Content   string `json:"content"`
	Size      int64  `json:"size"`
	Truncated bool   `json:"truncated"`
}

// FileStatus 是一次文件状态查询的回复。
type FileStatus struct {
	Path       string `json:"path"`
	Exists     bool   `json:"exists"`
	Kind       string `json:"kind"`
	Size       int64  `json:"size,omitempty"`
	ModifiedMs int64  `json:"modified_ms,omitempty"`
}

// TurnUsage 是一个回合的 token 用量。
type TurnUsage struct {
	Input          int `json:"input"`
	Output         int `json:"output"`
	CacheReadInput int `json:"cacheReadInput,omitempty"`
}

// ToolCallResult 是一次已完成工具调用的记录。
type ToolCallResult struct {
	CallID string `json:"callId"`
	Name   string `json:"name"`
	Output string `json:"output"`
	Error  string `json:"error,omitempty"`
}

// AssistantTextMessage 是回合内的一条助手文本消息。
type AssistantTextMessage struct {
	// MessageID 是流内关联 id，不是持久化的历史消息 id。
	MessageID string `json:"messageId,omitempty"`
	Text      string `json:"text"`
}

// TurnResult 是 Run 收集到的单回合结果。
type TurnResult struct {
	// StopReason 自然完成时为空。失败仍会在事件回调之后以 error 返回。
	StopReason  string `json:"stopReason,omitempty"`
	StopMessage string `json:"stopMessage,omitempty"`
	// Text 是回合内全部助手文本 delta，包括过程叙述。
	Text string `json:"text"`
	// FinalText 是最后一条已完成的助手消息；旧版 bridge 上为整回合文本。
	FinalText string `json:"finalText"`
	// Messages 是已完成的文本消息。bridge 不支持分帧时为空。
	Messages  []AssistantTextMessage `json:"messages"`
	Reasoning string                 `json:"reasoning"`
	ToolCalls []ToolCallResult       `json:"toolCalls"`
	Usage     *TurnUsage             `json:"usage,omitempty"`
}

// StructuredOutputAttempt 是 RunStructured 发起的一次模型尝试。
type StructuredOutputAttempt struct {
	// Attempt 是从 1 开始的尝试序号。
	Attempt int    `json:"attempt"`
	Text    string `json:"text"`
	// Errors 成功的那次为空。
	Errors []ValidationIssue `json:"errors"`
}

// ValidationIssue 是归一化后的解析或 JSON Schema 校验问题。
type ValidationIssue struct {
	// Path 指向非法值的 JSON Pointer 路径。空字符串表示根节点。
	Path string `json:"path"`
	// Keyword 是 schema 关键字；文本不是合法 JSON 时为 parse。
	Keyword string `json:"keyword"`
	// Message 是可读的校验消息。
	Message string `json:"message"`
}
