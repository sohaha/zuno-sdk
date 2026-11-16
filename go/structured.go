package zuno

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"

	jsons "github.com/santhosh-tekuri/jsonschema/v6"
)

// structuredInstructions 是结构化输出的初始提示词。
func structuredInstructions(schema any) string {
	return strings.Join([]string{
		"请仅以 JSON 返回答案，不要 markdown、散文、代码围栏或注释。",
		"JSON 值必须通过以下 JSON Schema 校验：",
		"```json",
		sortedSchemaJSON(schema),
		"```",
	}, "\n")
}

// structuredCorrectionPrompt 是校验失败后的纠正提示词。
func structuredCorrectionPrompt(schema any, attempt StructuredOutputAttempt) string {
	lines := []string{
		"你上一次的响应不满足要求的结构化输出约定。",
		"请仅以 JSON 返回更正后的响应，不要 markdown、散文、代码围栏或注释。",
		"它必须通过以下 JSON Schema 校验：",
		"```json",
		sortedSchemaJSON(schema),
		"```",
		"校验错误：",
	}
	for _, issue := range attempt.Errors {
		lines = append(lines, "- "+FormatIssue(issue))
	}
	lines = append(lines,
		"上一次的响应：",
		"```",
		truncateText(attempt.Text, 4000),
		"```",
	)
	return strings.Join(lines, "\n")
}

// RunOptions 描述 Run 的参数。
type RunOptions struct {
	// Images 是给消息附加的图片。
	Images []ImageAttachment
	// OnEvent 收到每个流事件时回调（在回合结束前同步调用）。
	OnEvent func(event Event)
	// AutoApprove 自动应答权限请求。
	//
	// 仅在服务端声明 permissions 能力时才有意义；
	// 否则不会发出任何权限请求，此选项为空操作。
	AutoApprove bool
}

// Run 发送一条消息并收集助手回复，直到回合结束。
//
// 脚本用的便捷路径：一次调用进，一个回合的文本和工具调用出。
// Text 包含回合内所有叙述。只要最后一条分帧助手消息用 FinalText。
// 流式消费方应改用 SubscribeSession。
func (c *Client) Run(ctx context.Context, sessionID, content string, options RunOptions) (*TurnResult, error) {
	sub := c.SubscribeSession(sessionID)
	defer sub.Close()

	waitAccept := true
	err := c.SendMessage(ctx, sessionID, content, SendMessageOptions{
		Images:        options.Images,
		WaitForAccept: &waitAccept,
	})
	if err != nil {
		return nil, err
	}

	result := &TurnResult{
		Messages:  []AssistantTextMessage{},
		Reasoning: "",
		ToolCalls: []ToolCallResult{},
	}
	var parts []*AssistantTextMessage
	messagesByID := map[string]*AssistantTextMessage{}
	completed := map[*AssistantTextMessage]bool{}
	messageFor := func(id string) *AssistantTextMessage {
		message, ok := messagesByID[id]
		if !ok {
			message = &AssistantTextMessage{MessageID: id}
			messagesByID[id] = message
			parts = append(parts, message)
		}
		return message
	}
	finish := func() *TurnResult {
		messages := []AssistantTextMessage{}
		for _, message := range parts {
			if completed[message] && message.Text != "" {
				messages = append(messages, *message)
			}
		}
		result.Messages = messages
		// 旧版 bridge 没有 text_done。不要根据推理或工具调用猜边界：
		// 保持历史上的整回合结果。
		if len(messages) > 0 {
			result.FinalText = messages[len(messages)-1].Text
		} else {
			result.FinalText = result.Text
		}
		return result
	}

	for {
		event, ok := sub.Next(ctx)
		if !ok {
			if ctx.Err() != nil {
				return nil, ctx.Err()
			}
			return finish(), nil
		}
		if options.OnEvent != nil {
			options.OnEvent(event)
		}
		switch event.Kind {
		case "text_delta":
			result.Text += event.Str("text")
			messageFor(event.Str("message_id")).Text += event.Str("text")
		case "text_replace":
			messageFor(event.Str("message_id")).Text = event.Str("text")
			var combined strings.Builder
			for _, m := range parts {
				combined.WriteString(m.Text)
			}
			result.Text = combined.String()
		case "text_done":
			key := event.Str("message_id")
			if message, ok := messagesByID[key]; ok {
				completed[message] = true
				// 无 id 的分帧仍会分隔连续的消息。带 key 的消息保留可寻址
				// 能力，供完成之后的权威更正使用。
				if key == "" {
					delete(messagesByID, key)
				}
			}
		case "reasoning_delta":
			result.Reasoning += event.Str("text")
		case "tool_done":
			result.ToolCalls = append(result.ToolCalls, ToolCallResult{
				CallID: event.Str("call_id"),
				Name:   event.Str("name"),
				Output: event.Str("output"),
				Error:  event.Str("error"),
			})
		case "token_usage":
			result.Usage = &TurnUsage{
				Input:          event.Int("input"),
				Output:         event.Int("output"),
				CacheReadInput: event.Int("cache_read_input"),
			}
		case "permission_request":
			if options.AutoApprove {
				if err := c.RespondToPermission(ctx, sessionID, event.Str("request_id"), PermissionAllow); err != nil {
					return nil, err
				}
			}
		case "turn_stopped":
			result.StopReason = event.Str("reason")
			result.StopMessage = event.Str("message")
		case "turn_done":
			return finish(), nil
		case "error":
			return nil, newError(event.Str("code"), event.Str("message"))
		}
	}
}

// RunStructuredOptions 描述 RunStructured 的参数。
type RunStructuredOptions struct {
	RunOptions
	// Schema 是助手 JSON 响应必须满足的 JSON Schema（可 JSON 序列化）。
	Schema any
	// MaxRetries 是第一次响应非法后的纠正重试次数。默认 2。
	// 用指针显式区分"未设置"与 0。
	MaxRetries *int
}

// RunStructured 发送一条消息，把助手的回答按 schema 校验解析为 JSON。
//
// 这是 SDK 层的约定：不需要特殊的 bridge 或模型特性。初始提示词
// 要求只输出 JSON；如果响应不是 JSON 或未通过 schema 校验，客户端
// 会发送有上限次数的纠正提示，其中带上归一化的校验错误和此前的文本。
//
// 强类型结果用泛型参数：
//
//	type Answer struct{ Summary string `json:"summary"` }
//	res, err := zuno.RunStructured[Answer](ctx, client, sid, "总结一下",
//	    zuno.RunStructuredOptions{Schema: map[string]any{...}})
//	fmt.Println(res.Data.Summary)
//
// 不需要强类型时用 RunStructured[any]，Data 里就是解码后的值；
// json.RawMessage 也是合法选择，Data 原样保留字节。
func RunStructured[T any](ctx context.Context, c *Client, sessionID, content string, options RunStructuredOptions) (*StructuredTurnResult[T], error) {
	maxRetries := 2
	if options.MaxRetries != nil {
		maxRetries = *options.MaxRetries
	}
	if maxRetries < 0 {
		return nil, newError("invalid_request", "maxRetries 必须是非负的安全整数")
	}
	validator, err := compileSchema(options.Schema)
	if err != nil {
		return nil, err
	}
	var attempts []StructuredOutputAttempt
	prompt := content + "\n\n" + structuredInstructions(options.Schema)

	for attemptNumber := 1; attemptNumber <= maxRetries+1; attemptNumber++ {
		turn, err := c.Run(ctx, sessionID, prompt, options.RunOptions)
		if err != nil {
			return nil, err
		}
		validation := validateStructuredText(turn.FinalText, validator)
		attempt := StructuredOutputAttempt{
			Attempt: attemptNumber,
			Text:    turn.FinalText,
			Errors:  validation.issues,
		}
		attempts = append(attempts, attempt)
		if validation.ok {
			var typed T
			if decodeErr := json.Unmarshal(validation.data, &typed); decodeErr != nil {
				return nil, wrapError("decode_failed", "结构化数据解码失败", decodeErr)
			}
			return &StructuredTurnResult[T]{
				TurnResult: *turn,
				Data:       typed,
				RawData:    validation.data,
				Attempts:   attempts,
			}, nil
		}
		prompt = structuredCorrectionPrompt(options.Schema, attempt)
	}

	return nil, newStructuredOutputError(attempts)
}

// newStructuredOutputError 构造失败错误。
func newStructuredOutputError(attempts []StructuredOutputAttempt) *StructuredOutputError {
	var last *StructuredOutputAttempt
	if len(attempts) > 0 {
		last = &attempts[len(attempts)-1]
	}
	summary := "没有执行任何结构化输出尝试"
	if last != nil && len(last.Errors) > 0 {
		parts := make([]string, 0, len(last.Errors))
		for _, issue := range last.Errors {
			parts = append(parts, FormatIssue(issue))
		}
		summary = strings.Join(parts, "; ")
	}
	return &StructuredOutputError{
		HarnessError: newError("structured_output_invalid",
			fmt.Sprintf("模型在 %d 次尝试后仍未产出合法的结构化输出：%s", len(attempts), summary)),
		Attempts:         attempts,
		ValidationErrors: last.Errors,
		LastText:         last.Text,
	}
}

// StructuredOutputError 在所有有上限的结构化输出尝试都未通过校验时返回。
type StructuredOutputError struct {
	*HarnessError
	Attempts         []StructuredOutputAttempt
	ValidationErrors []ValidationIssue
	LastText         string
}

// StructuredTurnResult 在 TurnResult 之上带上了按 schema 校验出的数据。
type StructuredTurnResult[T any] struct {
	TurnResult
	// Data 是按调用方 schema 校验并解码出的 JSON 值。
	Data T
	// RawData 是校验通过后的原始 JSON 字节。
	RawData json.RawMessage
	// Attempts 是全部尝试，包括校验失败的重试和最终成功的响应。
	Attempts []StructuredOutputAttempt
}

// structuredValidation 是一次结构化校验的中间结果。
type structuredValidation struct {
	ok     bool
	data   json.RawMessage
	issues []ValidationIssue
}

// validateStructuredText 从助手文本里提取并校验 JSON。
func validateStructuredText(text string, validator *jsons.Schema) structuredValidation {
	value, err := parseJSONFromText(text)
	if err != nil {
		return structuredValidation{issues: []ValidationIssue{{
			Path:    "/",
			Keyword: "parse",
			Message: "JSON 无效：" + err.Error(),
		}}}
	}
	data, marshalErr := json.Marshal(value)
	if marshalErr != nil {
		return structuredValidation{issues: []ValidationIssue{{
			Path:    "/",
			Keyword: "encode",
			Message: "JSON 重新编码失败：" + marshalErr.Error(),
		}}}
	}
	if issues := validateValue(validator, value); len(issues) > 0 {
		return structuredValidation{issues: issues}
	}
	return structuredValidation{ok: true, data: data}
}

func truncateText(value string, maxChars int) string {
	if len(value) <= maxChars {
		return value
	}
	return value[:maxChars] + "\n……已截断"
}
