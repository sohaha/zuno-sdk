package zuno

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"time"
)

// 会话与运行时的类型化 RPC 方法。请求体用 map 构造（与 Rust 枚举的
// 标签一一对应），回复帧用 expectReply 断言事件类型。

// ListSessions 列出持久化会话。
func (c *Client) ListSessions(ctx context.Context, includeArchived bool, limit int) ([]SessionInfo, error) {
	body := map[string]any{"req": "list_sessions"}
	if includeArchived {
		body["include_archived"] = true
	}
	if limit > 0 {
		body["limit"] = limit
	}
	frame, err := c.expectReply(ctx, body, "sessions")
	if err != nil {
		return nil, err
	}
	var reply struct {
		Sessions []SessionInfo `json:"sessions"`
	}
	if err := json.Unmarshal(frame.Raw("sessions"), &reply.Sessions); err != nil && !isNilJSON(frame.Raw("sessions")) {
		return nil, wrapError("decode_failed", "解析 sessions 失败", err)
	}
	return reply.Sessions, nil
}

// ListSessionsLimited 列出最近 limit 个持久化会话。
func (c *Client) ListSessionsLimited(ctx context.Context, limit int) ([]SessionInfo, error) {
	return c.ListSessions(ctx, false, limit)
}

// ArchiveSession 可逆地把会话从默认列表中隐藏。不删除转录记录。
func (c *Client) ArchiveSession(ctx context.Context, sessionID string) error {
	_, err := c.requestOk(ctx, map[string]any{"req": "archive_session", "session_id": sessionID})
	return err
}

// RestoreSession 恢复归档会话。
func (c *Client) RestoreSession(ctx context.Context, sessionID string) error {
	_, err := c.requestOk(ctx, map[string]any{"req": "restore_session", "session_id": sessionID})
	return err
}

// DeleteSession 永久删除一个持久化会话及其转录记录。
//
// 不可逆：快照、备份和 journal 都会被删掉，会话 id 从列表中消失。
// 目标会话不能仍附着在任何客户端上（包括本连接）：daemon 之后会把
// 它重新写回磁盘。删除前先关闭拥有它的连接，或改用一个未附着的连接。
// 需要 session_delete 能力。
func (c *Client) DeleteSession(ctx context.Context, sessionID string) error {
	if !c.Supports("session_delete") {
		return newError(CodeUnsupported, "此 bridge 不支持删除会话。请更新 zuno 运行时和 API bridge。")
	}
	_, err := c.requestOk(ctx, map[string]any{"req": "delete_session", "session_id": sessionID})
	return err
}

// SetRetentionPolicy 设置不活跃会话超过 archiveAfterDays 天后自动归档；
// 省略则关闭。
func (c *Client) SetRetentionPolicy(ctx context.Context, archiveAfterDays int) error {
	body := map[string]any{"req": "set_retention_policy"}
	if archiveAfterDays > 0 {
		body["archive_after_days"] = archiveAfterDays
	}
	_, err := c.requestOk(ctx, body)
	return err
}

// CreateSessionOptions 描述创建会话的参数。
type CreateSessionOptions struct {
	// Filesystem 只读目录策略，nil 继承，空列表拒绝全部。
	Filesystem *FilesystemPolicy
	WorkingDir string
	// SystemPrompt 替换整个组装好的系统提示词，而不只是其中的基础文本部分。
	// 默认指令和组装得到的指令/上下文追加内容不会再附加。
	// 创建后不可变，并由运行时持久化以便恢复。
	// 省略则走正常的提示词组装；空字符串表示显式覆盖为无文本。
	SystemPrompt *string
	// ProviderChannel 是创建期临时渠道（与 CLI --channel-* 同语义）：
	// 本会话绑定到这个一次性渠道而不是 daemon 默认 provider。
	// 仅新建会话生效。
	ProviderChannel *ProviderChannelSpec
	// DisableBuiltinSkills 创建期禁用编译期内置技能（dev-mode 等）。
	// 仅新建会话生效，用户与项目技能不受影响。
	DisableBuiltinSkills bool
	// Role 是内置角色 id（见 zuno role list，如 "pentest"、"ui-design"），
	// 决定会话身份提示词与捆绑技能。仅新建会话生效；未知 id 由 daemon
	// 报错。
	Role string
	// 在 CreateSession 返回前、任何模型回合开始前配置。
	Tools *SessionToolsOptions
}

// CreateSession 创建一个会话并附着它。
func (c *Client) CreateSession(ctx context.Context, opts CreateSessionOptions) (SessionInfo, error) {
	if opts.Filesystem != nil && !c.Supports("filesystem_policy") {
		return SessionInfo{}, newError(CodeUnsupported, "此运行时不支持 filesystem_policy，请更新 daemon 和 API bridge")
	}
	if opts.Tools != nil {
		if !c.Supports("session_tools") {
			return SessionInfo{}, newError(CodeUnsupported, "此 harness 不支持 session_tools。请更新 zuno 运行时和 API bridge。")
		}
	}
	body := map[string]any{"req": "create_session"}
	if opts.Filesystem != nil {
		body["filesystem"] = opts.Filesystem
	}
	if opts.WorkingDir != "" {
		body["working_dir"] = opts.WorkingDir
	}
	if opts.SystemPrompt != nil {
		body["system_prompt"] = *opts.SystemPrompt
	}
	if opts.ProviderChannel != nil {
		body["provider_channel"] = opts.ProviderChannel
	}
	if opts.DisableBuiltinSkills {
		body["disable_builtin_skills"] = true
	}
	if opts.Role != "" {
		body["role"] = opts.Role
	}
	frame, err := c.expectReply(ctx, body, "attached")
	if err != nil {
		return SessionInfo{}, err
	}
	var reply struct {
		Session SessionInfo `json:"session"`
	}
	if err := frame.Decode(&reply); err != nil {
		return SessionInfo{}, wrapError("decode_failed", "解析 attached 失败", err)
	}
	info := reply.Session
	if opts.Tools != nil {
		if err := c.ConfigureTools(ctx, info.SessionID, *opts.Tools); err != nil {
			return SessionInfo{}, err
		}
	}
	return info, nil
}

// AttachSession 附着一个已有会话。
func (c *Client) AttachSession(ctx context.Context, sessionID string) (SessionInfo, error) {
	frame, err := c.expectReply(ctx, map[string]any{"req": "attach_session", "session_id": sessionID}, "attached")
	if err != nil {
		return SessionInfo{}, err
	}
	var reply struct {
		Session SessionInfo `json:"session"`
	}
	if err := frame.Decode(&reply); err != nil {
		return SessionInfo{}, wrapError("decode_failed", "解析 attached 失败", err)
	}
	info := reply.Session
	return info, nil
}

// ForkSession 把会话完整的持久化上下文克隆到一个新的空闲会话。
func (c *Client) ForkSession(ctx context.Context, sessionID string) (SessionInfo, error) {
	frame, err := c.expectReply(ctx, map[string]any{"req": "fork_session", "session_id": sessionID}, "session_forked")
	if err != nil {
		return SessionInfo{}, err
	}
	var reply struct {
		Session SessionInfo `json:"session"`
	}
	if err := frame.Decode(&reply); err != nil {
		return SessionInfo{}, wrapError("decode_failed", "解析 session_forked 失败", err)
	}
	info := reply.Session
	return info, nil
}

// TransferSession 通过运行时压缩交接创建新会话，保留父会话。
func (c *Client) TransferSession(ctx context.Context, sessionID string) (SessionInfo, error) {
	frame, err := c.expectReply(ctx, map[string]any{"req": "transfer_session", "session_id": sessionID}, "session_forked")
	if err != nil {
		return SessionInfo{}, err
	}
	var reply struct {
		Session SessionInfo `json:"session"`
	}
	if err := frame.Decode(&reply); err != nil {
		return SessionInfo{}, wrapError("decode_failed", "解析 session_forked 失败", err)
	}
	info := reply.Session
	return info, nil
}

// DetachSession 分离会话。
func (c *Client) DetachSession(ctx context.Context, sessionID string) error {
	_, err := c.requestOk(ctx, map[string]any{"req": "detach_session", "session_id": sessionID})
	if err != nil {
		return err
	}
	c.toolCbs.abort(sessionID)
	c.toolCbs.removeSession(sessionID)
	return nil
}

// ConfigureTools 在会话空闲时替换工具策略。发下一条消息前请先等待完成。
func (c *Client) ConfigureTools(ctx context.Context, sessionID string, options SessionToolsOptions) error {
	if !c.Supports("session_tools") {
		return newError(CodeUnsupported, "此 harness 不支持 session_tools。请更新 zuno 运行时和 API bridge。")
	}
	c.configMu.Lock()
	if c.configuring[sessionID] {
		c.configMu.Unlock()
		return newError(CodeBusy, "该会话已有一个工具配置请求进行中")
	}
	c.configuring[sessionID] = true
	c.configMu.Unlock()
	defer func() {
		c.configMu.Lock()
		delete(c.configuring, sessionID)
		c.configMu.Unlock()
	}()
	prepared, err := prepareTools(options)
	if err != nil {
		return err
	}
	_, err = c.expectReply(ctx, map[string]any{
		"req":        "configure_tools",
		"session_id": sessionID,
		"tools":      prepared.wire,
	}, "ok")
	if err != nil {
		// 结果不确定时，绝不能让新的远端定义配上旧的回调。
		var herr *HarnessError
		if errors.As(err, &herr) && (herr.Code == CodeTimeout || herr.Code == CodeUnexpectedReply) {
			_ = c.Close()
		}
		return err
	}
	c.toolCbs.activate(sessionID, prepared)
	return nil
}

// ListTools 查看当前对模型生效的工具定义。
func (c *Client) ListTools(ctx context.Context, sessionID string) ([]SessionToolDefinition, error) {
	if !c.Supports("session_tools") {
		return nil, newError(CodeUnsupported, "此 harness 不支持 session_tools。请更新 zuno 运行时和 API bridge。")
	}
	frame, err := c.expectReply(ctx, map[string]any{"req": "list_tools", "session_id": sessionID}, "tools")
	if err != nil {
		return nil, err
	}
	var tools []SessionToolDefinition
	if raw := frame.Raw("tools"); !isNilJSON(raw) {
		if err := json.Unmarshal(raw, &tools); err != nil {
			return nil, wrapError("decode_failed", "解析 tools 失败", err)
		}
	}
	return tools, nil
}

// SendMessageOptions 描述发送消息的参数。
type SendMessageOptions struct {
	// SystemReminder 是伴随可见用户消息的隐藏提醒，与 Rust SDK 一致。
	SystemReminder string
	// Images 是给持久化的用户消息附加的图片。
	Images []ImageAttachment
	// NoReply 把消息作为上下文持久化，不启动模型回合。
	NoReply bool
	// WaitForAccept 在启动正常模型回合时等待 message_accepted。
	// 默认 true。
	WaitForAccept *bool
	// AcceptTimeout 是等待确认的最大毫秒数。
	AcceptTimeout time.Duration
}

// SendMessage 发送一条用户消息。
//
// harness 不会在请求层回复 send_message：它在 agent 收到消息后
// 发出 message_accepted 作为确认。在这里等回复必然超时，所以
// 帧直接写出，默认改为等待确认事件。要纯 fire-and-forget 请把
// WaitForAccept 设为 false。
func (c *Client) SendMessage(ctx context.Context, sessionID, content string, options SendMessageOptions) error {
	images := options.Images
	if images == nil {
		images = []ImageAttachment{}
	}
	body := map[string]any{
		"req":        "send_message",
		"session_id": sessionID,
		"content":    content,
		"images":     images,
	}
	if options.NoReply {
		body["no_reply"] = true
		_, err := c.requestOk(ctx, body)
		return err
	}
	if options.SystemReminder != "" && strings.TrimSpace(options.SystemReminder) != "" {
		body["system_reminder"] = options.SystemReminder
	}
	accepted := options.WaitForAccept == nil || *options.WaitForAccept
	if !accepted {
		return c.notify(body)
	}
	acceptTimeout := options.AcceptTimeout
	if acceptTimeout == 0 {
		acceptTimeout = DefaultAcceptTimeout
	}
	sub := c.Subscribe()
	defer sub.Close()
	if err := c.notify(body); err != nil {
		return err
	}
	deadline := time.Now().Add(acceptTimeout)
	child, cancel := context.WithDeadline(ctx, deadline)
	defer cancel()
	for {
		event, ok := sub.Next(child)
		if !ok {
			if ctx.Err() != nil {
				return wrapError(CodeTimeout, "等待 message_accepted 被取消", ctx.Err())
			}
			return newError(CodeTimeout, "等待 message_accepted 超时")
		}
		if event.Kind == "message_accepted" && event.SessionID == sessionID {
			return nil
		}
	}
}

// SendSystemReminder 提交隐藏的恢复续行消息，不等待消息确认。
func (c *Client) SendSystemReminder(ctx context.Context, sessionID, reminder string) error {
	return c.notify(map[string]any{
		"req":             "send_message",
		"session_id":      sessionID,
		"content":         "",
		"system_reminder": reminder,
	})
}

// Cancel 取消进行中的回合。
func (c *Client) Cancel(ctx context.Context, sessionID string) error {
	_, err := c.requestOk(ctx, map[string]any{"req": "cancel", "session_id": sessionID})
	if err != nil {
		return err
	}
	c.toolCbs.abort(sessionID)
	return nil
}

// SoftInterrupt 给进行中的回合排入一条消息。
func (c *Client) SoftInterrupt(ctx context.Context, sessionID, content string, urgent bool) error {
	return c.SoftInterruptWithOptions(ctx, sessionID, content, SoftInterruptOptions{Urgent: urgent})
}

// SoftInterruptOptions 描述软中断参数。
type SoftInterruptOptions struct {
	ClientID string
	Images   []ImageAttachment
	Urgent   bool
}

// SoftInterruptWithOptions 给进行中的回合排入一条消息，可带不透明的
// ClientID。模型收到该消息后，id 会通过 soft_interrupt_injected 事件
// 回传，此前可以用 CancelSoftInterrupt 撤回。需要 soft_interrupt_ids
// 能力；旧服务端会接受消息但丢弃 id。
func (c *Client) SoftInterruptWithOptions(ctx context.Context, sessionID, content string, options SoftInterruptOptions) error {
	body := map[string]any{
		"req":        "soft_interrupt",
		"session_id": sessionID,
		"content":    content,
		"urgent":     options.Urgent,
	}
	if len(options.Images) > 0 {
		body["images"] = options.Images
	}
	if options.ClientID != "" {
		body["client_id"] = options.ClientID
	}
	_, err := c.requestOk(ctx, body)
	return err
}

// GetHistory 获取会话历史。
func (c *Client) GetHistory(ctx context.Context, sessionID string) ([]HistoryMessage, error) {
	history, _, err := c.GetHistoryWithImages(ctx, sessionID)
	return history, err
}

// GetHistoryWithImages 获取会话历史与渲染出的图片。
func (c *Client) GetHistoryWithImages(ctx context.Context, sessionID string) ([]HistoryMessage, []RenderedImage, error) {
	frame, err := c.expectReply(ctx, map[string]any{"req": "get_history", "session_id": sessionID}, "history")
	if err != nil {
		return nil, nil, err
	}
	var messages []HistoryMessage
	if raw := frame.Raw("messages"); !isNilJSON(raw) {
		if err := json.Unmarshal(raw, &messages); err != nil {
			return nil, nil, wrapError("decode_failed", "解析 history 失败", err)
		}
	}
	var images []RenderedImage
	if raw := frame.Raw("images"); !isNilJSON(raw) {
		if err := json.Unmarshal(raw, &images); err != nil {
			return nil, nil, wrapError("decode_failed", "解析 images 失败", err)
		}
	}
	return messages, images, nil
}

// PeekSession 查看会话最近 limit 条历史。
func (c *Client) PeekSession(ctx context.Context, sessionID string, limit int) ([]HistoryMessage, error) {
	body := map[string]any{"req": "peek_session", "session_id": sessionID}
	if limit > 0 {
		body["limit"] = limit
	}
	frame, err := c.expectReply(ctx, body, "history")
	if err != nil {
		return nil, err
	}
	var messages []HistoryMessage
	if raw := frame.Raw("messages"); !isNilJSON(raw) {
		if err := json.Unmarshal(raw, &messages); err != nil {
			return nil, wrapError("decode_failed", "解析 history 失败", err)
		}
	}
	return messages, nil
}

// Clear 清空会话上下文。
func (c *Client) Clear(ctx context.Context, sessionID string) error {
	_, err := c.requestOk(ctx, map[string]any{"req": "clear", "session_id": sessionID})
	return err
}

// Rewind 回退到指定历史下标。
func (c *Client) Rewind(ctx context.Context, sessionID string, messageIndex int) error {
	_, err := c.requestOk(ctx, map[string]any{
		"req": "rewind", "session_id": sessionID, "message_index": messageIndex,
	})
	return err
}

// RewindUndo 恢复上一次 Rewind 移除的历史。
func (c *Client) RewindUndo(ctx context.Context, sessionID string) error {
	_, err := c.requestOk(ctx, map[string]any{"req": "rewind_undo", "session_id": sessionID})
	return err
}

// RespondToPermission 应答权限请求。
func (c *Client) RespondToPermission(ctx context.Context, sessionID, requestID, decision string) error {
	_, err := c.requestOk(ctx, map[string]any{
		"req": "permission_response", "session_id": sessionID, "request_id": requestID, "decision": decision,
	})
	return err
}

// ListModels 返回本会话可切换的模型，以及当前在用的模型。
func (c *Client) ListModels(ctx context.Context, sessionID string) (models []string, current string, err error) {
	frame, err := c.expectReply(ctx, map[string]any{"req": "list_models", "session_id": sessionID}, "models")
	if err != nil {
		return nil, "", err
	}
	if raw := frame.Raw("models"); !isNilJSON(raw) {
		if err := json.Unmarshal(raw, &models); err != nil {
			return nil, "", wrapError("decode_failed", "解析 models 失败", err)
		}
	}
	current, _ = frame.OptStr("current")
	return models, current, nil
}

// RuntimeCommandResult 是结构化命令的回复。
type RuntimeCommandResult struct {
	SessionID string
	Command   string
	Data      json.RawMessage
	Message   string
}

// RuntimeCommand 执行结构化原生命令，不将命令发送为模型提示词。
func (c *Client) RuntimeCommand(ctx context.Context, sessionID, command string, args []string) (RuntimeCommandResult, error) {
	if !c.Supports("runtime_commands") {
		return RuntimeCommandResult{}, newError("unknown_request", "此运行时不支持结构化命令，请更新并重启守护进程和桥接服务。")
	}
	if args == nil {
		args = []string{}
	}
	frame, err := c.expectReply(ctx, map[string]any{
		"req": "runtime_command", "session_id": sessionID, "command": command, "args": args,
	}, "runtime_command_result")
	if err != nil {
		return RuntimeCommandResult{}, err
	}
	return RuntimeCommandResult{
		SessionID: frame.SessionID,
		Command:   frame.Str("command"),
		Data:      frame.Raw("data"),
		Message:   frame.Str("message"),
	}, nil
}

// GetRuntimeInfo 返回运行时标识、路由目录、协议元数据与实时健康检查。
func (c *Client) GetRuntimeInfo(ctx context.Context, sessionID string) (RuntimeInfo, error) {
	if err := c.Ping(ctx); err != nil {
		return RuntimeInfo{}, err
	}
	frame, err := c.expectReply(ctx, map[string]any{"req": "get_runtime_info", "session_id": sessionID}, "runtime_info")
	if err != nil {
		return RuntimeInfo{}, err
	}
	var routes []ModelRouteInfo
	if raw := frame.Raw("routes"); !isNilJSON(raw) {
		if err := json.Unmarshal(raw, &routes); err != nil {
			return RuntimeInfo{}, wrapError("decode_failed", "解析 routes 失败", err)
		}
	}
	info := RuntimeInfo{
		Server:          c.server,
		ProtocolVersion: APIVersionMajor,
		Capabilities:    c.Capabilities(),
		Healthy:         true,
		SessionID:       frame.SessionID,
		Provider:        frame.Str("provider"),
		Model:           frame.Str("model"),
		Routes:          routes,
	}
	seen := map[string]bool{}
	if info.Provider != "" {
		info.Providers = append(info.Providers, info.Provider)
		seen[info.Provider] = true
	}
	for _, route := range routes {
		if route.Provider != "" && !seen[route.Provider] {
			seen[route.Provider] = true
			info.Providers = append(info.Providers, route.Provider)
		}
	}
	return info, nil
}

// SetApiKey 把 API key 持久化到 zuno 仅属主可访问的 provider 存储并热加载。
func (c *Client) SetApiKey(ctx context.Context, provider, apiKey string) error {
	_, err := c.expectReply(ctx, map[string]any{"req": "set_api_key", "provider": provider, "api_key": apiKey}, "credential_updated")
	return err
}

// ClearApiKey 清除 provider 的 API key。
func (c *Client) ClearApiKey(ctx context.Context, provider string) error {
	_, err := c.expectReply(ctx, map[string]any{"req": "clear_api_key", "provider": provider}, "credential_updated")
	return err
}

// NotifyAuthChanged 重载带外 OAuth 登录保存的凭据。不含任何密钥或聊天消息。
func (c *Client) NotifyAuthChanged(ctx context.Context, provider string) error {
	_, err := c.expectReply(ctx, map[string]any{"req": "notify_auth_changed", "provider": provider}, "ok")
	return err
}

// InvalidateUsage 告知 daemon 某个订阅登录（claude 或 openai）已兑换了一次
// 存储的用量重置，让它重新拉取配额。不携带凭据。
func (c *Client) InvalidateUsage(ctx context.Context, provider, accountLabel string) error {
	body := map[string]any{"req": "invalidate_usage", "provider": provider}
	if accountLabel != "" {
		body["account_label"] = accountLabel
	}
	_, err := c.expectReply(ctx, body, "ok")
	return err
}

// ReadFile 通过会话读取工作区文件。
func (c *Client) ReadFile(ctx context.Context, sessionID, path string, maxBytes int64) (FileContent, error) {
	body := map[string]any{"req": "read_file", "session_id": sessionID, "path": path}
	if maxBytes > 0 {
		body["max_bytes"] = maxBytes
	}
	frame, err := c.expectReply(ctx, body, "file_content")
	if err != nil {
		return FileContent{}, err
	}
	var content FileContent
	if err := frame.Decode(&content); err != nil {
		return FileContent{}, wrapError("decode_failed", "解析 file_content 失败", err)
	}
	return content, nil
}

// FindFiles 按查询查找会话工作区的文件路径。
func (c *Client) FindFiles(ctx context.Context, sessionID, query string, limit int) ([]string, error) {
	body := map[string]any{"req": "find_files", "session_id": sessionID, "query": query}
	if limit > 0 {
		body["limit"] = limit
	}
	frame, err := c.expectReply(ctx, body, "files")
	if err != nil {
		return nil, err
	}
	var paths []string
	if raw := frame.Raw("paths"); !isNilJSON(raw) {
		if err := json.Unmarshal(raw, &paths); err != nil {
			return nil, wrapError("decode_failed", "解析 paths 失败", err)
		}
	}
	return paths, nil
}

// SearchTextOptions 描述文本搜索参数。
type SearchTextOptions struct {
	Path  string
	Limit int
}

// SearchText 在会话工作区内搜索文本。
func (c *Client) SearchText(ctx context.Context, sessionID, query string, options SearchTextOptions) ([]TextMatch, error) {
	body := map[string]any{"req": "search_text", "session_id": sessionID, "query": query}
	if options.Path != "" {
		body["path"] = options.Path
	}
	if options.Limit > 0 {
		body["limit"] = options.Limit
	}
	frame, err := c.expectReply(ctx, body, "text_matches")
	if err != nil {
		return nil, err
	}
	var matches []TextMatch
	if raw := frame.Raw("matches"); !isNilJSON(raw) {
		if err := json.Unmarshal(raw, &matches); err != nil {
			return nil, wrapError("decode_failed", "解析 matches 失败", err)
		}
	}
	return matches, nil
}

// FileStatus 查询文件状态。
func (c *Client) FileStatus(ctx context.Context, sessionID, path string) (FileStatus, error) {
	frame, err := c.expectReply(ctx, map[string]any{"req": "file_status", "session_id": sessionID, "path": path}, "file_status")
	if err != nil {
		return FileStatus{}, err
	}
	var status FileStatus
	if err := frame.Decode(&status); err != nil {
		return FileStatus{}, wrapError("decode_failed", "解析 file_status 失败", err)
	}
	return status, nil
}

// SetModel 把会话切换到另一个模型。
//
// model 是 ListModels 返回的 id。模型未知或 provider 拒绝时以
// invalid_request 拒绝，而不是让会话静默停留在旧模型上。
func (c *Client) SetModel(ctx context.Context, sessionID, model string) error {
	_, err := c.requestOk(ctx, map[string]any{"req": "set_model", "session_id": sessionID, "model": model})
	return err
}

// SetReasoningEffort 设置模型回答前的思考强度。
//
// 通常是 "minimal" | "low" | "medium" | "high" | "xhigh" | "max"，
// 但可接受的集合因 provider 而异，所以这里收字符串并如实上报
// provider 的答复，而不是猜测一个迟早过时的联合类型。
func (c *Client) SetReasoningEffort(ctx context.Context, sessionID, effort string) error {
	_, err := c.requestOk(ctx, map[string]any{"req": "set_reasoning_effort", "session_id": sessionID, "effort": effort})
	return err
}

// Compact 调度对已有转录记录的压缩，释放上下文。
//
// 不是同步的：daemon 在下一个安全点做总结，而不是打断当前回合，
// 所以此调用完成意味着请求被接受。之后读历史记录看结果。
// 被拒绝（没有可压缩的内容、回合进行中）会以 invalid_request
// 和原因一起拒绝。
func (c *Client) Compact(ctx context.Context, sessionID string) (string, error) {
	frame, err := c.expectReply(ctx, map[string]any{"req": "compact", "session_id": sessionID}, "compacted")
	if err != nil {
		return "", err
	}
	return frame.Str("message"), nil
}

// RenameSession 设置会话标题。空 title 则恢复生成的标题。
func (c *Client) RenameSession(ctx context.Context, sessionID, title string) error {
	body := map[string]any{"req": "rename_session", "session_id": sessionID}
	if title != "" {
		body["title"] = title
	}
	_, err := c.requestOk(ctx, body)
	return err
}

// SetSessionSaved 收藏或取消收藏会话。带 label 时同时成为标题。
func (c *Client) SetSessionSaved(ctx context.Context, sessionID string, saved bool, label string) error {
	body := map[string]any{"req": "set_session_saved", "session_id": sessionID, "saved": saved}
	if label != "" {
		body["label"] = label
	}
	_, err := c.requestOk(ctx, body)
	return err
}

// AppletAction 上报 agent applet 实例中的用户操作。
func (c *Client) AppletAction(ctx context.Context, sessionID, instance string, action any, state map[string]any, sourceKey string) error {
	if state == nil {
		state = map[string]any{}
	}
	body := map[string]any{
		"req": "applet_action", "session_id": sessionID, "instance": instance, "action": action, "state": state,
	}
	if sourceKey != "" {
		body["source_key"] = sourceKey
	}
	_, err := c.requestOk(ctx, body)
	return err
}

// CloseApplet 关闭一个 agent applet 实例。不会唤醒 agent。
func (c *Client) CloseApplet(ctx context.Context, sessionID, instance string) error {
	_, err := c.requestOk(ctx, map[string]any{"req": "close_applet", "session_id": sessionID, "instance": instance})
	return err
}

// CancelSoftInterrupts 丢弃已排队但尚未投递的软中断。
func (c *Client) CancelSoftInterrupts(ctx context.Context, sessionID string) error {
	_, err := c.requestOk(ctx, map[string]any{"req": "cancel_soft_interrupts", "session_id": sessionID})
	return err
}

// SoftInterruptsCancelled 是按 id 撤回的判定结果。
type SoftInterruptsCancelled struct {
	// Cancelled 里的 id 从未到达模型。
	Cancelled []string
	// NotQueued 里的已经到达（或从未排队）。
	NotQueued []string
}

// CancelSoftInterruptsByID 按 client_id 撤回指定的已排队软中断。
// 与投递原子判定。需要 soft_interrupt_ids 能力。
func (c *Client) CancelSoftInterruptsByID(ctx context.Context, sessionID string, clientIDs []string) (SoftInterruptsCancelled, error) {
	if clientIDs == nil {
		clientIDs = []string{}
	}
	frame, err := c.expectReply(ctx, map[string]any{
		"req": "cancel_soft_interrupts", "session_id": sessionID, "client_ids": clientIDs,
	}, "soft_interrupts_cancelled")
	if err != nil {
		return SoftInterruptsCancelled{}, err
	}
	out := SoftInterruptsCancelled{}
	if raw := frame.Raw("cancelled"); !isNilJSON(raw) {
		_ = json.Unmarshal(raw, &out.Cancelled)
	}
	if raw := frame.Raw("not_queued"); !isNilJSON(raw) {
		_ = json.Unmarshal(raw, &out.NotQueued)
	}
	return out, nil
}

// CancelSoftInterrupt 撤回一条已排队的软中断。模型看到之前移除返回
// true，已投递返回 false。
func (c *Client) CancelSoftInterrupt(ctx context.Context, sessionID, clientID string) (bool, error) {
	out, err := c.CancelSoftInterruptsByID(ctx, sessionID, []string{clientID})
	if err != nil {
		return false, err
	}
	for _, id := range out.Cancelled {
		if id == clientID {
			return true, nil
		}
	}
	return false, nil
}

// BackgroundToolResult 把正在运行的工具调用转入后台，并报告转出的内容。
// 没有 background_tool_result 能力的服务端只回 ok，此时报告为
// moved=false，即使确实有工具被转后台。
func (c *Client) BackgroundToolResult(ctx context.Context, sessionID string) (moved bool, toolCallID, toolName string, err error) {
	frame, err := c.requestOk(ctx, map[string]any{"req": "background_tool", "session_id": sessionID})
	if err != nil {
		return false, "", "", err
	}
	if frame.Kind != "background_tool_result" {
		return false, "", "", nil
	}
	return frame.Bool("moved"), frame.Str("tool_call_id"), frame.Str("tool_name"), nil
}

// BackgroundTool 把正在运行的工具调用转入后台（即 TUI 的 Alt+B）。
func (c *Client) BackgroundTool(ctx context.Context, sessionID string) error {
	_, _, _, err := c.BackgroundToolResult(ctx, sessionID)
	return err
}

// TodoState 返回会话的持久化 todo 状态，供自动提醒和质量门禁策略使用。
// 需要 todo_state 能力。
func (c *Client) TodoState(ctx context.Context, sessionID string) (TodoSnapshot, error) {
	frame, err := c.expectReply(ctx, map[string]any{"req": "get_todo_state", "session_id": sessionID}, "todo_state")
	if err != nil {
		return TodoSnapshot{}, err
	}
	var state TodoSnapshot
	if raw := frame.Raw("state"); !isNilJSON(raw) {
		if err := json.Unmarshal(raw, &state); err != nil {
			return TodoSnapshot{}, wrapError("decode_failed", "解析 todo state 失败", err)
		}
	}
	return state, nil
}

// AckTodoFollowUp 应用跟进决策的持久化效果。effects 为空时是空操作。
func (c *Client) AckTodoFollowUp(ctx context.Context, sessionID string, effects TodoEffects) error {
	if !effects.ClearGateObservations && !effects.MarkLongSessionReviewDelivered {
		return nil
	}
	_, err := c.requestOk(ctx, map[string]any{
		"req": "ack_todo_follow_up", "session_id": sessionID, "effects": effects,
	})
	return err
}

// Ping 健康检查。
func (c *Client) Ping(ctx context.Context) error {
	_, err := c.requestOk(ctx, map[string]any{"req": "ping"})
	return err
}

// --- 小工具 ---------------------------------------------------------------

func isNilJSON(raw json.RawMessage) bool {
	return len(raw) == 0 || string(raw) == "null"
}
