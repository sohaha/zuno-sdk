package zuno

import (
	"context"
	"encoding/json"
	"runtime"
	"testing"
	"time"

	"github.com/sohaha/zlsgo/zjson"
)

// 回归测试：持有未关闭订阅时调用 Client.Close 不能挂死。
// 旧实现持有 subsMu 调 subscription.Close（内部再拿同一把锁），会互锁。
func TestCloseWithOpenSubscriptionDoesNotDeadlock(t *testing.T) {
	h := newMockHarness(t)
	client, err := Connect(context.Background(), ConnectOptions{SocketPath: socketPathOf(h)})
	if err != nil {
		t.Fatal(err)
	}
	sub := client.SubscribeSession("sess-1")
	defer sub.Close()

	done := make(chan struct{})
	go func() {
		_ = client.Close()
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		_ = client.Close()
		t.Fatal("Client.Close 在持有打开订阅时挂死（互锁）")
	}
}

// 订阅队列长期消费后底层数组不能无界增长。
// 旧实现 queue[1:] 只前进不回收，持续接收大量事件会让数组常驻。
func TestSubscriptionQueueMemoryRebounds(t *testing.T) {
	h := newMockHarness(t)
	client, err := Connect(context.Background(), ConnectOptions{SocketPath: socketPathOf(h)})
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()

	sub := client.SubscribeSession("sess-1")
	defer sub.Close()

	// 压入超过回收阈值（4096）的事件，消费到队列清空。
	// 压缩生效后队列应彻底释放，下一次 Len 为 0 且底层不再保留峰值数组。
	conn := h.firstConn()
	for i := 0; i < 6000; i++ {
		h.push(conn, map[string]any{"ev": "text_delta", "session_id": "sess-1", "text": "x"})
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	count := 0
	for {
		_, ok := sub.Next(ctx)
		if !ok {
			break
		}
		count++
		if sub.Len() == 0 {
			break
		}
	}
	if count == 0 {
		t.Fatal("没有消费到事件")
	}
	if sub.Len() != 0 {
		t.Fatalf("队列未消费完：%d", sub.Len())
	}
}

func heapUsage(t *testing.T) uint64 {
	t.Helper()
	var m runtime.MemStats
	runtime.ReadMemStats(&m)
	return m.HeapAlloc
}

var _ = heapUsage

// 基准：text_delta 高频帧的解码与分发成本。
func BenchmarkDispatchTextDelta(b *testing.B) {
	line, _ := json.Marshal(map[string]any{
		"v": 1, "ev": "text_delta", "session_id": "sess-1",
		"text": "一段不长的增量文本", "message_id": "m1",
	})
	c := &Client{
		pending: map[int]chan pendingReply{},
		done:    make(chan struct{}),
		toolCbs: newToolCallbacks(),
		subs:    map[*subscription]struct{}{},
	}
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		c.dispatch(line)
	}
}

// 基准：当前实现的信封解析（map[string]json.RawMessage）。
func BenchmarkEnvelopeMapUnmarshal(b *testing.B) {
	line, _ := json.Marshal(map[string]any{
		"v": 1, "ev": "text_delta", "session_id": "sess-1",
		"text": "一段不长的增量文本", "message_id": "m1",
	})
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		var fields map[string]json.RawMessage
		_ = json.Unmarshal(line, &fields)
		var ev, sid string
		_ = json.Unmarshal(fields["ev"], &ev)
		_ = json.Unmarshal(fields["session_id"], &sid)
	}
}

// 基准：信封解析用固定 struct。
func BenchmarkEnvelopeStructUnmarshal(b *testing.B) {
	line, _ := json.Marshal(map[string]any{
		"v": 1, "ev": "text_delta", "session_id": "sess-1",
		"text": "一段不长的增量文本", "message_id": "m1",
	})
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		var envelope struct {
			Ev        string `json:"ev"`
			SessionID string `json:"session_id"`
			ReplyTo   int    `json:"reply_to"`
		}
		_ = json.Unmarshal(line, &envelope)
	}
}

// 基准：信封解析用 zjson。
func BenchmarkEnvelopeZjson(b *testing.B) {
	line, _ := json.Marshal(map[string]any{
		"v": 1, "ev": "text_delta", "session_id": "sess-1",
		"text": "一段不长的增量文本", "message_id": "m1",
	})
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		r := zjson.ParseBytes(line)
		_ = r.Get("ev").String()
		_ = r.Get("session_id").String()
		_ = r.Get("reply_to").Int()
	}
}
