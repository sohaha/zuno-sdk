package zuno

import (
	"context"
	"encoding/json"
	"fmt"
	"sync"
	"time"

	jsons "github.com/santhosh-tekuri/jsonschema/v6"
)

// toolDefaultTimeout / toolMaxTimeout 与 TypeScript SDK 的回调时限一致。
const (
	toolDefaultTimeout = 60 * time.Second
	toolMaxTimeout     = 60 * time.Second
)

// ToolResult 是一次工具调用的输出。
type ToolResult struct {
	// Output 是给模型的文本输出。
	Output string `json:"output"`
	// Error 非空时表示工具失败，Output 仍会投递。
	Error string `json:"error,omitempty"`
}

// ToolContext 是回调的执行环境。
type ToolContext struct {
	SessionID string
	CallID    string
	// Ctx 在取消、断开连接或回调超时时中止。
	// 回调应配合它来停止副作用。
	Ctx context.Context
}

// Tool 是会话级工具，或对同名工具的显式替换。
type Tool struct {
	Name        string
	Description string
	// Parameters 是 object 类型的 JSON Schema。
	Parameters map[string]any
	// Timeout 是回调时限。默认 60s，最大 60s。
	Timeout time.Duration
	// Execute 是回调。返回 ToolResult；返回 error 会被包装成错误结果。
	Execute func(ctx ToolContext, input map[string]any) (ToolResult, error)
}

// SessionToolsOptions 是 SDK 层的会话工具选项。
type SessionToolsOptions struct {
	// Enabled 省略（nil）表示继承配置的默认值；指向空切片表示不暴露
	// 任何内建或 MCP 工具。
	Enabled *[]string
	// Disabled 拒绝项优先，包括优先于自定义工具。
	Disabled []string
	// Custom 自定义工具会加入选择，仅在本会话内替换同名工具。
	Custom []Tool
}

// preparedTools 是校验后的工具配置：线上定义与本地回调表。
type preparedTools struct {
	wire      ToolConfiguration
	handlers  map[string]*Tool
	validator map[string]*jsons.Schema
}

// prepareTools 先校验，再改动本地回调表或远端策略。
func prepareTools(options SessionToolsOptions) (*preparedTools, error) {
	handlers := map[string]*Tool{}
	validators := map[string]*jsons.Schema{}
	var custom []SessionToolDefinition
	for i := range options.Custom {
		tool := options.Custom[i]
		if _, exists := handlers[tool.Name]; exists {
			return nil, newError(CodeInvalidOption, "工具重复："+tool.Name)
		}
		if tool.Execute == nil {
			return nil, newError(CodeInvalidOption, tool.Name+" 缺少 Execute 回调")
		}
		timeout := tool.Timeout
		if timeout == 0 {
			timeout = toolDefaultTimeout
		}
		if timeout < 1 || timeout > toolMaxTimeout {
			return nil, newError(CodeInvalidOption, "tool Timeout 必须在 1s..60s 之间")
		}
		if tool.Parameters == nil || tool.Parameters["type"] != "object" {
			return nil, newError(CodeInvalidOption, tool.Name+" 的 Parameters 必须是 object 类型的 JSON Schema")
		}
		validator, verr := compileSchema(tool.Parameters)
		if verr != nil {
			return nil, newError(CodeInvalidOption, tool.Name+" 的 schema 无效："+verr.Error())
		}
		// 快照工具定义，注册之后再修改对象不会影响回调校验。
		snapshot := deepCopyMap(tool.Parameters)
		definition := SessionToolDefinition{
			Name:        tool.Name,
			Description: tool.Description,
			Parameters:  snapshot,
		}
		custom = append(custom, definition)
		stored := tool
		stored.Parameters = snapshot
		stored.Timeout = timeout
		handlers[tool.Name] = &stored
		validators[tool.Name] = validator
	}
	wire := ToolConfiguration{Custom: custom}
	if options.Enabled != nil {
		enabled := append([]string(nil), *options.Enabled...)
		wire.Enabled = &enabled
	}
	if options.Disabled != nil {
		wire.Disabled = append([]string(nil), options.Disabled...)
	}
	return &preparedTools{wire: wire, handlers: handlers, validator: validators}, nil
}

// toolCallbacks 维护连接本地的分发。观察连接上的事件永远不会执行回调。
type toolCallbacks struct {
	mu       sync.Mutex
	sessions map[string]*preparedTools
	active   map[string]context.CancelFunc
	seen     map[string]bool
	submit   func(sessionID, callID string, result ToolResult)
}

func newToolCallbacks() *toolCallbacks {
	return &toolCallbacks{
		sessions: map[string]*preparedTools{},
		active:   map[string]context.CancelFunc{},
		seen:     map[string]bool{},
	}
}

// activate 让新配置在 ack 之后生效；ack 之前 dispatch 看不到新表，
// 进行中的回合继续用旧表。
func (t *toolCallbacks) activate(sessionID string, prepared *preparedTools) {
	t.mu.Lock()
	t.sessions[sessionID] = prepared
	t.mu.Unlock()
}

func (t *toolCallbacks) removeSession(sessionID string) {
	t.mu.Lock()
	delete(t.sessions, sessionID)
	t.mu.Unlock()
}

func (t *toolCallbacks) dispatch(event Event) {
	sessionID := event.SessionID
	callID := event.Str("call_id")
	name := event.Str("name")
	t.mu.Lock()
	prepared := t.sessions[sessionID]
	if prepared == nil {
		// configure_tools 的 ack 之前，进行中的回合继续用旧表；
		// 没有旧表就交给底层客户端自行处理 tool_call。
		t.mu.Unlock()
		return
	}
	key := sessionID + "\x00" + callID
	if t.seen[key] {
		t.mu.Unlock()
		return
	}
	t.seen[key] = true
	handler := prepared.handlers[name]
	validator := prepared.validator[name]
	ctx, cancel := context.WithCancel(context.Background())
	t.active[key] = cancel
	t.mu.Unlock()

	go t.execute(handler, validator, event, ToolContext{SessionID: sessionID, CallID: callID, Ctx: ctx}, key, cancel)
}

func (t *toolCallbacks) execute(handler *Tool, validator *jsons.Schema, event Event, ctx ToolContext, key string, cancel context.CancelFunc) {
	defer func() {
		t.mu.Lock()
		delete(t.active, key)
		t.mu.Unlock()
		cancel()
	}()

	result := func() ToolResult {
		if handler == nil {
			return ToolResult{Error: "SDK 工具回调未注册"}
		}
		var input map[string]any
		if raw := event.Raw("input"); len(raw) > 0 {
			if err := json.Unmarshal(raw, &input); err != nil {
				return ToolResult{Error: "工具输入无效：" + err.Error()}
			}
		}
		if validator != nil {
			if issues := validateValue(validator, input); len(issues) > 0 {
				return ToolResult{Error: "工具输入无效：" + FormatIssue(issues[0])}
			}
		}
		timeout := handler.Timeout
		if timeout == 0 {
			timeout = toolDefaultTimeout
		}
		runCtx, cancelTimeout := context.WithTimeout(ctx.Ctx, timeout)
		defer cancelTimeout()
		done := make(chan ToolResult, 1)
		go func() {
			defer func() {
				if r := recover(); r != nil {
					done <- ToolResult{Error: fmt.Sprintf("SDK 工具回调 panic：%v", r)}
				}
			}()
			res, err := handler.Execute(ToolContext{SessionID: ctx.SessionID, CallID: ctx.CallID, Ctx: runCtx}, input)
			if err != nil {
				if res.Output == "" && res.Error == "" {
					res = ToolResult{Error: err.Error()}
				} else if res.Error == "" {
					res.Error = err.Error()
				}
			}
			done <- res
		}()
		select {
		case res := <-done:
			return res
		case <-runCtx.Done():
			if ctx.Ctx.Err() != nil {
				return ToolResult{Error: "SDK 工具回调已取消"}
			}
			return ToolResult{Error: "SDK 工具回调超时"}
		}
	}()

	// 取消/断开后不得把过期的结果发送给后续回合。
	ctxValue := contextCanceled(ctx.Ctx)
	if !ctxValue {
		t.submitResult(ctx.SessionID, ctx.CallID, result)
	}
}

func (t *toolCallbacks) submitResult(sessionID, callID string, result ToolResult) {
	t.submit(sessionID, callID, result)
}

func (t *toolCallbacks) abort(sessionID string) {
	t.mu.Lock()
	for key, cancel := range t.active {
		if sessionID == "" || splitKeySession(key) == sessionID {
			cancel()
			delete(t.active, key)
		}
	}
	// Call ID 在单个回合内唯一。去重内存也按该回合界定。
	for key := range t.seen {
		if sessionID == "" || splitKeySession(key) == sessionID {
			delete(t.seen, key)
		}
	}
	t.mu.Unlock()
}

func (t *toolCallbacks) close() {
	t.abort("")
	t.mu.Lock()
	t.sessions = map[string]*preparedTools{}
	t.mu.Unlock()
}

func splitKeySession(key string) string {
	for i := 0; i < len(key); i++ {
		if key[i] == 0 {
			return key[:i]
		}
	}
	return key
}

func contextCanceled(ctx context.Context) bool {
	return ctx != nil && ctx.Err() != nil
}

// deepCopyMap 通过 JSON 往返快照 map。
func deepCopyMap(src map[string]any) map[string]any {
	if src == nil {
		return nil
	}
	data, err := json.Marshal(src)
	if err != nil {
		return src
	}
	var out map[string]any
	if json.Unmarshal(data, &out) != nil {
		return src
	}
	return out
}
