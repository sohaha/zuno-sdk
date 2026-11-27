package zuno

import (
	"context"
	"encoding/json"
	"net"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

func TestNdjsonDecoderSplitsAcrossChunks(t *testing.T) {
	d := &ndjsonDecoder{}
	// 一帧被任意切开也要正确重组。
	parts := [][]byte{
		[]byte(`{"ev":"te`),
		[]byte("xt_delta\",\"text\":\"hi\"}\n{\"ev\":\"ok\"}\n"),
		[]byte("\n"),
	}
	var lines [][]byte
	for _, part := range parts {
		out, err := d.push(part)
		if err != nil {
			t.Fatalf("push 失败: %v", err)
		}
		lines = append(lines, out...)
	}
	if len(lines) != 2 {
		t.Fatalf("期望 2 帧，收到 %d", len(lines))
	}
	var frame struct {
		Ev   string `json:"ev"`
		Text string `json:"text"`
	}
	if err := json.Unmarshal(lines[0], &frame); err != nil {
		t.Fatal(err)
	}
	if frame.Ev != "text_delta" || frame.Text != "hi" {
		t.Fatalf("解码错误: %+v", frame)
	}
}

func TestNdjsonDecoderSkipsEmptyLines(t *testing.T) {
	d := &ndjsonDecoder{}
	out, err := d.push([]byte("\n\n{\"ev\":\"ok\"}\n\n"))
	if err != nil {
		t.Fatal(err)
	}
	if len(out) != 1 {
		t.Fatalf("期望 1 帧，收到 %d", len(out))
	}
}

func TestNdjsonDecoderFrameTooLarge(t *testing.T) {
	d := &ndjsonDecoder{}
	_, err := d.push(make([]byte, maxFrameBytes+10))
	if err == nil {
		t.Fatal("期望 frame_too_large 错误")
	}
	if herr, ok := err.(*HarnessError); !ok || herr.Code != CodeFrameTooLarge {
		t.Fatalf("期望 frame_too_large，得到 %v", err)
	}
}

func TestTransportEndpointUnixIsPath(t *testing.T) {
	if runtime.GOOS == "windows" {
		// Windows 上没有 socket 文件：端点是从路径派生出的命名管道。
		// 这里钉住派生的三个性质：可读词干前缀、同路径稳定、异路径不等。
		got := TransportEndpoint(`C:\run\zuno-api.sock`)
		if !strings.HasPrefix(got, `\\.\pipe\zuno-api-`) {
			t.Fatalf("Windows 上端点应是派生管道，得到 %s", got)
		}
		if again := TransportEndpoint(`C:\run\zuno-api.sock`); again != got {
			t.Fatalf("同一路径应派生同一管道，得到 %s 与 %s", got, again)
		}
		if other := TransportEndpoint(`C:\run\other.sock`); other == got {
			t.Fatal("不同路径不得派生同一管道")
		}
		// Windows 路径大小写不敏感，哈希前会统一小写。
		if upper := TransportEndpoint(`c:\RUN\zuno-api.sock`); upper != got {
			t.Fatalf("派生应大小写不敏感，得到 %s 与 %s", got, upper)
		}
		return
	}
	if got := TransportEndpoint("/run/user/1000/zuno-api.sock"); got != "/run/user/1000/zuno-api.sock" {
		t.Fatalf("Unix 上端点应为路径本身，得到 %s", got)
	}
}

func TestAPISocketPathOverride(t *testing.T) {
	t.Setenv("ZUNO_API_SOCKET", "/custom/zuno-api.sock")
	if got := APISocketPath(); got != "/custom/zuno-api.sock" {
		t.Fatalf("ZUNO_API_SOCKET 应覆盖路径，得到 %s", got)
	}
	os.Unsetenv("ZUNO_API_SOCKET")
	t.Setenv("ZUNO_RUNTIME_DIR", "/custom-run")
	if got, want := APISocketPath(), filepath.Join("/custom-run", "zuno-api.sock"); got != want {
		t.Fatalf("ZUNO_RUNTIME_DIR 应生效，期望 %s，得到 %s", want, got)
	}
}

func TestRuntimeDirDiscriminator(t *testing.T) {
	os.Unsetenv("ZUNO_RUNTIME_DIR")
	os.Unsetenv("TMPDIR")
	t.Setenv("XDG_RUNTIME_DIR", "/xdg")
	if got := RuntimeDir(); got != "/xdg" {
		t.Fatalf("XDG_RUNTIME_DIR 应生效，得到 %s", got)
	}
	os.Unsetenv("XDG_RUNTIME_DIR")
	if !strings.HasPrefix(RuntimeDir(), "zuno-") && !strings.Contains(RuntimeDir(), "zuno-") {
		t.Fatalf("回退目录应含 zuno- 前缀，得到 %s", RuntimeDir())
	}
}

func TestConnectAndRun(t *testing.T) {
	h := newMockHarness(t)
	client, err := Connect(context.Background(), ConnectOptions{SocketPath: socketPathOf(h)})
	if err != nil {
		t.Fatalf("Connect 失败: %v", err)
	}
	defer client.Close()
	if client.Server() != "mock-harness/0.1" {
		t.Fatalf("server 标识错误: %s", client.Server())
	}
	if !client.Supports("session_tools") {
		t.Fatal("应声明 session_tools 能力")
	}

	turn, err := client.Run(context.Background(), "sess-1", "hello", RunOptions{})
	if err != nil {
		t.Fatalf("Run 失败: %v", err)
	}
	if turn.Text != "你好，世界" {
		t.Fatalf("文本聚合错误: %q", turn.Text)
	}
	if turn.FinalText != "你好，世界" {
		t.Fatalf("FinalText 错误: %q", turn.FinalText)
	}
	if len(turn.Messages) != 1 || turn.Messages[0].Text != "你好，世界" {
		t.Fatalf("分帧消息错误: %+v", turn.Messages)
	}
	if turn.Usage == nil || turn.Usage.Input != 10 || turn.Usage.Output != 5 {
		t.Fatalf("用量错误: %+v", turn.Usage)
	}
}

func socketPathOf(h *mockHarness) string {
	return h.socketPath
}

func TestRunWithToolCall(t *testing.T) {
	h := newMockHarness(t)
	client, err := Connect(context.Background(), ConnectOptions{SocketPath: socketPathOf(h)})
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()

	session, err := client.CreateSession(context.Background(), CreateSessionOptions{WorkingDir: "."})
	if err != nil {
		t.Fatalf("CreateSession 失败: %v", err)
	}
	if session.SessionID != "sess-1" {
		t.Fatalf("session id 错误: %s", session.SessionID)
	}

	err = client.ConfigureTools(context.Background(), session.SessionID, SessionToolsOptions{
		Custom: []Tool{{
			Name:        "mock_tool",
			Description: "测试工具",
			Parameters: map[string]any{
				"type":       "object",
				"properties": map[string]any{"n": map[string]any{"type": "number"}},
			},
			Execute: func(ctx ToolContext, input map[string]any) (ToolResult, error) {
				return ToolResult{Output: "handled"}, nil
			},
		}},
	})
	if err != nil {
		t.Fatalf("ConfigureTools 失败: %v", err)
	}

	turn, err := client.Run(context.Background(), session.SessionID, "需要工具", RunOptions{})
	if err != nil {
		t.Fatalf("Run 失败: %v", err)
	}
	// 工具回调异步提交，等待它落地。
	deadline := time.Now().Add(2 * time.Second)
	for !h.seenRequest("tool_result") && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}
	if !h.seenRequest("tool_result") {
		t.Fatal("SDK 未提交 tool_result")
	}
	if len(turn.ToolCalls) != 1 || turn.ToolCalls[0].Output != "handled" {
		t.Fatalf("工具调用记录错误: %+v", turn.ToolCalls)
	}
}

func TestErrorFrameRejected(t *testing.T) {
	h := newMockHarness(t)
	client, err := Connect(context.Background(), ConnectOptions{SocketPath: socketPathOf(h)})
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	err = client.Clear(context.Background(), "sess-1")
	var herr *HarnessError
	if !asError(err, &herr) || herr.Code != "unknown_request" {
		t.Fatalf("期望 unknown_request 错误，得到 %v", err)
	}
}

func asError(err error, target **HarnessError) bool {
	if herr, ok := err.(*HarnessError); ok {
		*target = herr
		return true
	}
	return false
}

func TestGetHistory(t *testing.T) {
	h := newMockHarness(t)
	client, err := Connect(context.Background(), ConnectOptions{SocketPath: socketPathOf(h)})
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	messages, err := client.GetHistory(context.Background(), "sess-1")
	if err != nil {
		t.Fatal(err)
	}
	if len(messages) != 2 || messages[0].Role != "user" {
		t.Fatalf("历史错误: %+v", messages)
	}
}

func TestRuntimeCommand(t *testing.T) {
	h := newMockHarness(t)
	client, err := Connect(context.Background(), ConnectOptions{SocketPath: socketPathOf(h)})
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	result, err := client.RuntimeCommand(context.Background(), "sess-1", "info", nil)
	if err != nil {
		t.Fatal(err)
	}
	if result.Command != "info" || result.Message != "done" {
		t.Fatalf("命令回复错误: %+v", result)
	}
}

func TestSubscriptionFiltersSession(t *testing.T) {
	h := newMockHarness(t)
	client, err := Connect(context.Background(), ConnectOptions{SocketPath: socketPathOf(h)})
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()

	sub := client.SubscribeSession("sess-1")
	defer sub.Close()
	go func() {
		// 模拟另一会话的事件不应进入过滤后的订阅。
		h.push(h.firstConn(), map[string]any{"ev": "text_delta", "session_id": "other", "text": "x"})
		h.push(h.firstConn(), map[string]any{"ev": "text_delta", "session_id": "sess-1", "text": "y"})
	}()
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	event, ok := sub.Next(ctx)
	if !ok {
		t.Fatal("没有收到事件")
	}
	if event.SessionID != "sess-1" {
		t.Fatalf("过滤失败: %s", event.SessionID)
	}
}

func (h *mockHarness) firstConn() net.Conn {
	h.mu.Lock()
	defer h.mu.Unlock()
	if len(h.conns) == 0 {
		return nil
	}
	return h.conns[0]
}

func TestCreateSessionProviderChannel(t *testing.T) {
	h := newMockHarness(t)
	client, err := Connect(context.Background(), ConnectOptions{SocketPath: socketPathOf(h)})
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()

	_, err = client.CreateSession(context.Background(), CreateSessionOptions{
		WorkingDir: ".",
		ProviderChannel: &ProviderChannelSpec{
			ChannelType:  "openai-compatible",
			BaseURL:      "https://llm.example.com/v1",
			APIKey:       "sk-test",
			DefaultModel: "test-model",
		},
		DisableBuiltinSkills: true,
	})
	if err != nil {
		t.Fatalf("CreateSession 失败: %v", err)
	}

	// 断言 create_session 帧带上了两个新字段。
	h.mu.Lock()
	defer h.mu.Unlock()
	for _, frame := range h.requests {
		if frame["req"] != "create_session" {
			continue
		}
		channel, ok := frame["provider_channel"].(map[string]any)
		if !ok {
			t.Fatal("create_session 缺少 provider_channel")
		}
		if channel["base_url"] != "https://llm.example.com/v1" || channel["api_key"] != "sk-test" {
			t.Fatalf("provider_channel 内容错误: %+v", channel)
		}
		if frame["disable_builtin_skills"] != true {
			t.Fatal("create_session 缺少 disable_builtin_skills=true")
		}
		return
	}
	t.Fatal("没有捕获到 create_session 请求")
}
