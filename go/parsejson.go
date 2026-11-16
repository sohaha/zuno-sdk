package zuno

import (
	"encoding/json"
	"strings"
)

// parseJSONFromText 从助手文本里提取第一个 JSON 值。
//
// 候选顺序与 TypeScript SDK 一致：整段文本、```json 围栏、
// 第一个配平的 {...} 或 [...]。
func parseJSONFromText(text string) (any, error) {
	trimmed := strings.TrimSpace(text)
	if trimmed == "" {
		return nil, newError("parse", "JSON 无效：输入为空")
	}
	var lastErr error = newError("parse", "JSON 无效：没有可解析的内容")
	var parsed any
	try := func(candidate string) bool {
		var value any
		if err := json.Unmarshal([]byte(candidate), &value); err != nil {
			lastErr = err
			return false
		}
		// json.Unmarshal 会把顶层标量也算成功，与 TS 的 JSON.parse 行为一致。
		lastErr = nil
		parsed = normalizeJSONNumbers(value)
		return true
	}
	candidates := []string{trimmed}
	if fenced := fenceContent(trimmed); fenced != "" {
		candidates = append(candidates, strings.TrimSpace(fenced))
	}
	if container := firstJSONContainer(trimmed); container != "" {
		dup := false
		for _, c := range candidates {
			if c == container {
				dup = true
			}
		}
		if !dup {
			candidates = append(candidates, container)
		}
	}
	for _, candidate := range candidates {
		if try(candidate) {
			return parsed, nil
		}
	}
	return nil, lastErr
}

func fenceContent(text string) string {
	const marker = "```"
	if !strings.HasPrefix(text, marker) {
		return ""
	}
	body := strings.TrimPrefix(text, marker)
	body = strings.TrimPrefix(body, "json")
	body = strings.TrimPrefix(body, "JSON")
	body = strings.TrimPrefix(body, "Json")
	body = strings.TrimSpace(body)
	if !strings.HasSuffix(body, marker) {
		return ""
	}
	return strings.TrimSuffix(body, marker)
}

// firstJSONContainer 返回文本中第一个配平的 JSON 容器。
func firstJSONContainer(text string) string {
	start := strings.IndexAny(text, "[{")
	if start < 0 {
		return ""
	}
	var stack []byte
	inString := false
	escaped := false
	for i := start; i < len(text); i++ {
		char := text[i]
		if inString {
			if escaped {
				escaped = false
			} else if char == '\\' {
				escaped = true
			} else if char == '"' {
				inString = false
			}
			continue
		}
		switch char {
		case '"':
			inString = true
		case '{':
			stack = append(stack, '}')
		case '[':
			stack = append(stack, ']')
		case '}', ']':
			if len(stack) == 0 || stack[len(stack)-1] != char {
				return ""
			}
			stack = stack[:len(stack)-1]
			if len(stack) == 0 {
				return text[start : i+1]
			}
		}
	}
	return ""
}

// normalizeJSONNumbers 保留 json.Unmarshal 的 float64 语义。
// 当前无需转换，占位以便未来做 big-number 处理。
func normalizeJSONNumbers(value any) any { return value }
