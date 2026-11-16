package zuno

import (
	"context"
	"encoding/json"
	"net"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"testing"
)

// schema-parity：SDK 的标签集合必须与 Rust API crate 一致。
//
// SDK 是手写的，现实中的失败模式是 Rust 侧新增了变体而这里没有
// 同步镜像。这个测试直接读 Rust 源码，分歧出现的瞬间就会失败。

const rustCrate = "../../crates/zuno-harness-api/src"

func snakeCase(variant string) string {
	var out strings.Builder
	for i, r := range variant {
		if r >= 'A' && r <= 'Z' {
			if i > 0 {
				out.WriteByte('_')
			}
			out.WriteRune(r + 32)
		} else {
			out.WriteRune(r)
		}
	}
	return out.String()
}

// enumVariants 从 Rust 文件里提取顶层枚举的变体名（snake_case），去掉 Unknown。
func enumVariants(t *testing.T, file, enumName string) []string {
	t.Helper()
	source, err := os.ReadFile(filepath.Join(rustCrate, file))
	if err != nil {
		t.Fatalf("读取 %s 失败: %v", file, err)
	}
	text := string(source)
	start := strings.Index(text, "pub enum "+enumName+" {")
	if start < 0 {
		t.Fatalf("在 %s 里找不到 enum %s", file, enumName)
	}
	rest := text[start:]
	if end := strings.Index(rest, "\n}"); end >= 0 {
		rest = rest[:end]
	}
	var variants []string
	// 变体在枚举体内的一级缩进上。
	lineRe := regexp.MustCompile(`^ {4}([A-Z][A-Za-z0-9]*)\s*[{(,]`)
	for _, line := range strings.Split(rest, "\n") {
		if m := lineRe.FindStringSubmatch(line); m != nil && m[1] != "Unknown" {
			variants = append(variants, snakeCase(m[1]))
		}
	}
	return variants
}

func sortedCopy(in []string) []string {
	out := append([]string(nil), in...)
	sort.Strings(out)
	return out
}

func TestRequestTagsMatchRustEnum(t *testing.T) {
	rust := enumVariants(t, "requests.rs", "ApiRequest")
	if len(rust) == 0 {
		t.Fatal("没有解析到 Rust 请求变体")
	}
	got := sortedCopy(KnownRequestKinds)
	want := sortedCopy(rust)
	if strings.Join(got, ",") != strings.Join(want, ",") {
		missing, extra := diffSets(want, got)
		t.Fatalf("请求标签漂移。Rust 有而 SDK 缺: %v；SDK 有而 Rust 无: %v", missing, extra)
	}
}

func TestEventTagsMatchRustEnum(t *testing.T) {
	rust := enumVariants(t, "events.rs", "ApiEvent")
	if len(rust) == 0 {
		t.Fatal("没有解析到 Rust 事件变体")
	}
	got := sortedCopy(KnownEventKinds)
	want := sortedCopy(rust)
	if strings.Join(got, ",") != strings.Join(want, ",") {
		missing, extra := diffSets(want, got)
		t.Fatalf("事件标签漂移。Rust 有而 SDK 缺: %v；SDK 有而 Rust 无: %v", missing, extra)
	}
}

func TestProtocolVersionMatchesRust(t *testing.T) {
	source, err := os.ReadFile(filepath.Join(rustCrate, "lib.rs"))
	if err != nil {
		t.Fatal(err)
	}
	text := string(source)
	majorRe := regexp.MustCompile(`API_VERSION_MAJOR: u32 = (\d+)`)
	minorRe := regexp.MustCompile(`API_VERSION_MINOR: u32 = (\d+)`)
	if m := majorRe.FindStringSubmatch(text); m == nil {
		t.Fatal("找不到 API_VERSION_MAJOR")
	} else if got := parseInt(m[1]); got != APIVersionMajor {
		t.Fatalf("API_VERSION_MAJOR 期望 %d，得到 %d", got, APIVersionMajor)
	}
	if m := minorRe.FindStringSubmatch(text); m == nil {
		t.Fatal("找不到 API_VERSION_MINOR")
	} else if got := parseInt(m[1]); got != APIVersionMinor {
		t.Fatalf("API_VERSION_MINOR 期望 %d，得到 %d", got, APIVersionMinor)
	}
}

func parseInt(s string) int {
	n := 0
	for _, c := range s {
		n = n*10 + int(c-'0')
	}
	return n
}

func diffSets(want, got []string) (missing, extra []string) {
	wantSet := map[string]bool{}
	for _, v := range want {
		wantSet[v] = true
	}
	gotSet := map[string]bool{}
	for _, v := range got {
		gotSet[v] = true
	}
	for _, v := range want {
		if !gotSet[v] {
			missing = append(missing, v)
		}
	}
	for _, v := range got {
		if !wantSet[v] {
			extra = append(extra, v)
		}
	}
	return missing, extra
}

// --- 结构化输出解析测试 ----------------------------------------------------

func TestParseJSONFromTextPlain(t *testing.T) {
	v, err := parseJSONFromText(`{"a": 1}`)
	if err != nil {
		t.Fatal(err)
	}
	obj := v.(map[string]any)
	if obj["a"].(float64) != 1 {
		t.Fatalf("解析错误: %v", obj)
	}
}

func TestParseJSONFromTextFenced(t *testing.T) {
	text := "以下是结果：\n```json\n{\"a\": 2}\n```"
	v, err := parseJSONFromText(text)
	if err != nil {
		t.Fatal(err)
	}
	if v.(map[string]any)["a"].(float64) != 2 {
		t.Fatalf("围栏解析错误: %v", v)
	}
}

func TestParseJSONFromTextEmbedded(t *testing.T) {
	text := `答案 {"list": [1, 2, {"n": "x}"}], "ok": true} 完毕`
	v, err := parseJSONFromText(text)
	if err != nil {
		t.Fatal(err)
	}
	obj := v.(map[string]any)
	if obj["ok"].(bool) != true {
		t.Fatalf("嵌入解析错误: %v", obj)
	}
}

func TestParseJSONFromTextInvalid(t *testing.T) {
	if _, err := parseJSONFromText("没有 JSON"); err == nil {
		t.Fatal("期望解析失败")
	}
}

func TestRunStructuredSuccess(t *testing.T) {
	h := newMockHarness(t)
	client, err := Connect(context.Background(), ConnectOptions{SocketPath: socketPathOf(h)})
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()

	// mock 的 send_message 回 "你好，世界"，不是合法 JSON；改用
	// onFrame 返回固定 JSON 响应。
	h.mu.Lock()
	h.onFrame = func(h *mockHarness, conn net.Conn, frame map[string]any) bool {
		if frame["req"] != "send_message" {
			return false
		}
		sid := frame["session_id"].(string)
		go func() {
			h.push(conn, map[string]any{"ev": "message_accepted", "session_id": sid})
			h.push(conn, map[string]any{
				"ev": "text_delta", "session_id": sid, "text": `{"summary":"ok"}`,
			})
			h.push(conn, map[string]any{"ev": "text_done", "session_id": sid})
			h.push(conn, map[string]any{"ev": "turn_done", "session_id": sid})
		}()
		return true
	}
	h.mu.Unlock()

	schema := map[string]any{
		"type": "object",
		"properties": map[string]any{
			"summary": map[string]any{"type": "string"},
		},
		"required": []string{"summary"},
	}
	res, err := RunStructured[json.RawMessage](context.Background(), client, "sess-1", "总结", RunStructuredOptions{Schema: schema})
	if err != nil {
		t.Fatalf("RunStructured 失败: %v", err)
	}
	if !strings.Contains(string(res.Data), "ok") {
		t.Fatalf("数据错误: %s", res.Data)
	}
	if len(res.Attempts) != 1 {
		t.Fatalf("应一次成功: %+v", res.Attempts)
	}
}

func TestRunStructuredRetries(t *testing.T) {
	h := newMockHarness(t)
	client, err := Connect(context.Background(), ConnectOptions{SocketPath: socketPathOf(h)})
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()

	attempts := 0
	h.mu.Lock()
	h.onFrame = func(h *mockHarness, conn net.Conn, frame map[string]any) bool {
		if frame["req"] != "send_message" {
			return false
		}
		sid := frame["session_id"].(string)
		content, _ := frame["content"].(string)
		go func() {
			h.push(conn, map[string]any{"ev": "message_accepted", "session_id": sid})
			text := "不是 JSON"
			if strings.Contains(content, "校验错误") {
				text = `{"summary":"fixed"}`
			}
			h.push(conn, map[string]any{"ev": "text_delta", "session_id": sid, "text": text})
			h.push(conn, map[string]any{"ev": "text_done", "session_id": sid})
			h.push(conn, map[string]any{"ev": "turn_done", "session_id": sid})
		}()
		attempts++
		return true
	}
	h.mu.Unlock()

	schema := map[string]any{
		"type": "object",
		"properties": map[string]any{
			"summary": map[string]any{"type": "string"},
		},
		"required": []string{"summary"},
	}
	res, err := RunStructured[json.RawMessage](context.Background(), client, "sess-1", "总结", RunStructuredOptions{Schema: schema})
	if err != nil {
		t.Fatalf("重试后应成功: %v", err)
	}
	if len(res.Attempts) != 2 {
		t.Fatalf("期望两次尝试，得到 %d", len(res.Attempts))
	}
}

func TestRunStructuredExhausted(t *testing.T) {
	h := newMockHarness(t)
	client, err := Connect(context.Background(), ConnectOptions{SocketPath: socketPathOf(h)})
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()

	h.mu.Lock()
	h.onFrame = func(h *mockHarness, conn net.Conn, frame map[string]any) bool {
		if frame["req"] != "send_message" {
			return false
		}
		sid := frame["session_id"].(string)
		go func() {
			h.push(conn, map[string]any{"ev": "message_accepted", "session_id": sid})
			h.push(conn, map[string]any{"ev": "text_delta", "session_id": sid, "text": "永远不是 JSON"})
			h.push(conn, map[string]any{"ev": "text_done", "session_id": sid})
			h.push(conn, map[string]any{"ev": "turn_done", "session_id": sid})
		}()
		return true
	}
	h.mu.Unlock()

	schema := map[string]any{"type": "object"}
	retries := 1
	_, err = RunStructured[json.RawMessage](context.Background(), client, "sess-1", "总结", RunStructuredOptions{Schema: schema, MaxRetries: &retries})
	var soe *StructuredOutputError
	if !asStructuredError(err, &soe) {
		t.Fatalf("期望 StructuredOutputError，得到 %v", err)
	}
	if len(soe.Attempts) != 2 {
		t.Fatalf("期望两次尝试，得到 %d", len(soe.Attempts))
	}
}

func asStructuredError(err error, target **StructuredOutputError) bool {
	if soe, ok := err.(*StructuredOutputError); ok {
		*target = soe
		return true
	}
	return false
}
