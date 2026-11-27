package zuno

import (
	"bufio"
	"encoding/json"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

// mockHarness 是一个最小可用的协议 v1 服务端，用于单测。
type mockHarness struct {
	t        *testing.T
	listener net.Listener
	// socketPath 是测试要用的 socket 路径（不是监听器地址）：Windows 上监听器
	// 实际是一条派生出来的命名管道，只有原始路径才能交给 Connect 再派生回去。
	socketPath string
	mu         sync.Mutex
	conns      []net.Conn
	requests   []map[string]any
	// onFrame 允许测试自定义回复行为；返回 false 表示用默认处理。
	onFrame func(h *mockHarness, conn net.Conn, frame map[string]any) bool
}

func newMockHarness(t *testing.T) *mockHarness {
	t.Helper()
	dir, err := os.MkdirTemp("", "zuno-mock-sock-*")
	if err != nil {
		t.Fatal(err)
	}
	socketPath := filepath.Join(dir, "zuno-api.sock")
	listener := listenMockEndpoint(t, socketPath)
	t.Cleanup(func() {
		listener.Close()
		os.RemoveAll(dir)
	})
	h := &mockHarness{t: t, listener: listener, socketPath: socketPath}
	go h.acceptLoop()
	return h
}

func (h *mockHarness) acceptLoop() {
	for {
		conn, err := h.listener.Accept()
		if err != nil {
			return
		}
		h.mu.Lock()
		h.conns = append(h.conns, conn)
		h.mu.Unlock()
		go h.serve(conn)
	}
}

func (h *mockHarness) serve(conn net.Conn) {
	scanner := bufio.NewScanner(conn)
	scanner.Buffer(make([]byte, 1024*1024), 8*1024*1024)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" {
			continue
		}
		var frame map[string]any
		if json.Unmarshal([]byte(line), &frame) != nil {
			continue
		}
		h.mu.Lock()
		h.requests = append(h.requests, frame)
		handler := h.onFrame
		h.mu.Unlock()
		if handler != nil && handler(h, conn, frame) {
			continue
		}
		h.defaultHandle(conn, frame)
	}
}

func (h *mockHarness) defaultHandle(conn net.Conn, frame map[string]any) {
	req, _ := frame["req"].(string)
	id := int(toFloat(frame["id"]))
	switch req {
	case "hello":
		h.reply(conn, id, map[string]any{
			"ev":           "hello_ok",
			"version":      1,
			"server":       "mock-harness/0.1",
			"capabilities": []string{"session_tools", "runtime_commands", "session_delete", "permissions", "todo_state"},
		})
	case "ping":
		h.reply(conn, id, map[string]any{"ev": "ok"})
	case "create_session":
		h.reply(conn, id, map[string]any{
			"ev": "attached",
			"session": map[string]any{
				"session_id":  "sess-1",
				"status":      "idle",
				"working_dir": "/tmp",
			},
		})
	case "list_sessions":
		h.reply(conn, id, map[string]any{
			"ev":       "sessions",
			"sessions": []any{},
		})
	case "send_message":
		// 异步：先 message_accepted，再回合事件。
		sid, _ := frame["session_id"].(string)
		content, _ := frame["content"].(string)
		needTool := strings.Contains(content, "需要工具")
		go func() {
			h.push(conn, map[string]any{"ev": "message_accepted", "session_id": sid})
			if needTool {
				h.push(conn, map[string]any{
					"ev": "tool_call", "session_id": sid, "call_id": "call-1",
					"name": "mock_tool", "input": map[string]any{"n": 3},
				})
				// 真实 harness 会等 tool_result 再继续回合；mock 对齐这个
				// 行为，否则 turn_done 会提前取消进行中的回调。
				deadline := time.Now().Add(5 * time.Second)
				for !h.seenRequest("tool_result") && time.Now().Before(deadline) {
					time.Sleep(10 * time.Millisecond)
				}
				h.push(conn, map[string]any{
					"ev": "tool_done", "session_id": sid, "call_id": "call-1",
					"name": "mock_tool", "output": "handled",
				})
			}
			h.push(conn, map[string]any{
				"ev": "text_delta", "session_id": sid, "text": "你好，",
				"message_id": "m1",
			})
			h.push(conn, map[string]any{
				"ev": "text_delta", "session_id": sid, "text": "世界",
				"message_id": "m1",
			})
			h.push(conn, map[string]any{"ev": "text_done", "session_id": sid, "message_id": "m1"})
			h.push(conn, map[string]any{
				"ev": "token_usage", "session_id": sid, "input": 10, "output": 5,
			})
			h.push(conn, map[string]any{"ev": "turn_done", "session_id": sid})
		}()
	case "tool_result":
		h.reply(conn, id, map[string]any{"ev": "ok"})
	case "get_history":
		sid, _ := frame["session_id"].(string)
		h.reply(conn, id, map[string]any{
			"ev": "history", "session_id": sid,
			"messages": []any{
				map[string]any{"role": "user", "content": "hi"},
				map[string]any{"role": "assistant", "content": "hello"},
			},
		})
	case "configure_tools":
		h.reply(conn, id, map[string]any{"ev": "ok"})
	case "runtime_command":
		sid, _ := frame["session_id"].(string)
		cmd, _ := frame["command"].(string)
		h.reply(conn, id, map[string]any{
			"ev": "runtime_command_result", "session_id": sid, "command": cmd,
			"data": map[string]any{"ok": true}, "message": "done",
		})
	default:
		h.reply(conn, id, map[string]any{"ev": "error", "code": "unknown_request", "message": "mock 未实现 " + req})
	}
}

func toFloat(v any) float64 {
	if f, ok := v.(float64); ok {
		return f
	}
	return 0
}

func (h *mockHarness) reply(conn net.Conn, replyTo int, body map[string]any) {
	body["v"] = 1
	body["reply_to"] = replyTo
	data, _ := json.Marshal(body)
	fmt.Fprintf(conn, "%s\n", data)
}

func (h *mockHarness) push(conn net.Conn, body map[string]any) {
	body["v"] = 1
	data, _ := json.Marshal(body)
	fmt.Fprintf(conn, "%s\n", data)
}

func (h *mockHarness) seenRequest(req string) bool {
	h.mu.Lock()
	defer h.mu.Unlock()
	for _, frame := range h.requests {
		if frame["req"] == req {
			return true
		}
	}
	return false
}
