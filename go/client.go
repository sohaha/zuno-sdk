package zuno

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"sync"
	"time"

	"github.com/sohaha/zlsgo/zjson"
)

// 默认请求超时与消息确认超时，与 TypeScript SDK 一致。
const (
	DefaultRequestTimeout = 30 * time.Second
	DefaultAcceptTimeout  = 10 * time.Second
)

// ConnectOptions 描述一次 Connect 的参数。
type ConnectOptions struct {
	// SocketPath 缺省取解析出的 harness API socket 路径。
	SocketPath string
	// ClientName 是握手中发送的客户端标识，例如 "my-app/1.0"。
	ClientName string
	// Conn 提供自定义连接，而不是拨 Unix socket。
	Conn io.ReadWriteCloser
	// RequestTimeout 是请求多久没有回复就失败。0 表示关闭超时。
	RequestTimeout time.Duration
}

// Connect 连接到本机已在运行的 zuno。
//
// 用于自动化用户自己的 zuno：编辑器插件、状态仪表盘、热键工具。
// 它共享用户的活跃会话，这里的任何操作在用户的终端中都可见。
// 要把 zuno 嵌入为引擎，请用 LaunchLauncher。
func Connect(ctx context.Context, options ConnectOptions) (*Client, error) {
	conn := options.Conn
	socketPath := options.SocketPath
	if conn == nil {
		if socketPath == "" {
			socketPath = APISocketPath()
		}
		var err error
		conn, err = dialEndpoint(TransportEndpoint(socketPath))
		if err != nil {
			return nil, err
		}
	} else {
		socketPath = ""
	}
	clientName := options.ClientName
	if clientName == "" {
		clientName = "zuno-sdk-go"
	}
	timeout := options.RequestTimeout
	if timeout == 0 {
		timeout = DefaultRequestTimeout
	}
	client := newClient(conn, timeout, socketPath, clientName)
	hello := map[string]any{
		"req":         "hello",
		"min_version": APIVersionMajor,
		"max_version": APIVersionMajor,
		"client":      clientName,
	}
	frame, err := client.request(ctx, hello)
	if err != nil {
		client.Close()
		return nil, err
	}
	if frame.Kind != "hello_ok" {
		client.Close()
		return nil, newError(CodeHandshakeFailed, "意外的回复："+frame.Kind)
	}
	client.server = frame.Str("server")
	if raw := frame.Raw("capabilities"); !isNilJSON(raw) {
		_ = json.Unmarshal(raw, &client.capabilities)
	}
	return client, nil
}

// pendingReply 是请求等待者的投递载荷。
type pendingReply struct {
	event Event
	err   error
}

// Client 是已连接的 harness 客户端。
//
// 回复通过服务端回显的 reply_to id 关联；没有它的都是流事件，
// 在 Subscribe/SubscribeSession 的订阅或事件回调上分发。
type Client struct {
	conn       io.ReadWriteCloser
	socketPath string
	clientName string

	requestTimeout time.Duration
	server         string
	capabilities   []string

	pendingMu sync.Mutex
	pending   map[int]chan pendingReply
	nextID    int
	closed    bool
	closeErr  error
	closeOnce sync.Once
	done      chan struct{}

	subsMu      sync.Mutex
	subs        map[*subscription]struct{}
	toolCbs     *toolCallbacks
	configMu    sync.Mutex
	configuring map[string]bool

	instance *LaunchedInstance
}

func newClient(conn io.ReadWriteCloser, timeout time.Duration, socketPath, clientName string) *Client {
	c := &Client{
		conn:           conn,
		socketPath:     socketPath,
		clientName:     clientName,
		requestTimeout: timeout,
		pending:        map[int]chan pendingReply{},
		done:           make(chan struct{}),
		toolCbs:        newToolCallbacks(),
		subs:           map[*subscription]struct{}{},
		configuring:    map[string]bool{},
	}
	c.toolCbs.submit = func(sessionID, callID string, result ToolResult) {
		ctx, cancel := context.WithTimeout(context.Background(), DefaultRequestTimeout)
		defer cancel()
		_ = c.SubmitToolResult(ctx, sessionID, callID, result)
	}
	go c.readLoop()
	return c
}

// readLoop 从连接读取行并分发。
func (c *Client) readLoop() {
	decoder := &ndjsonDecoder{}
	buf := make([]byte, 64*1024)
	var carry []byte
	for {
		n, err := c.conn.Read(buf)
		if n > 0 {
			lines, derr := decoder.push(append(carry, buf[:n]...))
			carry = nil
			if derr != nil {
				// 分帧失败不可恢复：拆掉连接，所有在途请求统一失败。
				c.handleClose(derr)
				return
			}
			for _, line := range lines {
				c.dispatch(line)
			}
		}
		if err != nil {
			if err != io.EOF {
				c.handleClose(wrapError(CodeDisconnected, "harness 连接已关闭", err))
			} else {
				c.handleClose(newError(CodeDisconnected, "harness 连接已关闭"))
			}
			return
		}
	}
}

func (c *Client) dispatch(line []byte) {
	// 信封字段走 zjson 惰性解析：text_delta 高频路径上比整帧 map
	// 反序列化快约 6 倍（见 BenchmarkEnvelopeZjson）。
	root := zjson.ParseBytes(line)
	ev := root.Get("ev").String()
	event := Event{Kind: ev, raw: line}
	if sid := root.Get("session_id"); sid.Exists() {
		event.SessionID = sid.String()
	}
	if replyTo := root.Get("reply_to").Int(); replyTo > 0 {
		c.pendingMu.Lock()
		waiter, ok := c.pending[replyTo]
		if ok {
			delete(c.pending, replyTo)
		}
		c.pendingMu.Unlock()
		if ok {
			waiter <- pendingReply{event: event}
			return
		}
	}
	// 每个连接只能附着一个会话。切换后旧会话的回调不能存活。
	if ev == "attached" || ev == "session_forked" {
		c.toolCbs.close()
	}
	if ev == "tool_call" && event.SessionID != "" && event.Str("call_id") != "" && event.Str("name") != "" {
		c.toolCbs.dispatch(event)
	} else if ev == "turn_done" && event.SessionID != "" {
		c.toolCbs.abort(event.SessionID)
	}
	c.subsMu.Lock()
	for sub := range c.subs {
		sub.enqueue(event)
	}
	c.subsMu.Unlock()
}

func (c *Client) handleClose(err error) {
	c.closeOnce.Do(func() {
		c.pendingMu.Lock()
		c.closed = true
		c.closeErr = err
		for id, waiter := range c.pending {
			delete(c.pending, id)
			waiter <- pendingReply{err: err}
		}
		c.pendingMu.Unlock()
		close(c.done)
	})
}

// requestTimeoutOrCtx 请求超时的统一入口。
func (c *Client) ctxTimeout(ctx context.Context) (context.Context, context.CancelFunc, bool) {
	if c.requestTimeout <= 0 {
		return ctx, func() {}, false
	}
	child, cancel := context.WithTimeout(ctx, c.requestTimeout)
	return child, cancel, true
}

// request 发送原始请求并等待它的回复帧。
func (c *Client) request(ctx context.Context, body map[string]any) (Event, error) {
	c.pendingMu.Lock()
	if c.closed {
		err := c.closeErr
		c.pendingMu.Unlock()
		if err == nil {
			err = newError(CodeDisconnected, "客户端已关闭")
		}
		return Event{}, err
	}
	c.nextID++
	id := c.nextID
	waiter := make(chan pendingReply, 1)
	c.pending[id] = waiter
	c.pendingMu.Unlock()

	body["v"] = APIVersionMajor
	body["id"] = id
	frame, err := encodeFrame(body)
	if err == nil {
		_, err = c.conn.Write(frame)
		if err != nil {
			err = wrapError(CodeDisconnected, "写入失败", err)
		}
	}
	if err != nil {
		c.pendingMu.Lock()
		delete(c.pending, id)
		c.pendingMu.Unlock()
		return Event{}, err
	}

	child, cancel, withTimeout := c.ctxTimeout(ctx)
	defer cancel()
	select {
	case reply := <-waiter:
		return reply.event, reply.err
	case <-child.Done():
		c.pendingMu.Lock()
		delete(c.pending, id)
		c.pendingMu.Unlock()
		if withTimeout && child.Err() == context.DeadlineExceeded {
			return Event{}, newError(CodeTimeout,
				fmt.Sprintf("%s 内没有收到 %s 的回复", c.requestTimeout, body["req"]))
		}
		return Event{}, newError(CodeTimeout, "请求已取消: "+child.Err().Error())
	case <-c.done:
		c.pendingMu.Lock()
		err := c.closeErr
		delete(c.pending, id)
		c.pendingMu.Unlock()
		if err == nil {
			err = newError(CodeDisconnected, "harness 连接已关闭")
		}
		return Event{}, err
	}
}

// requestOk 发送请求；服务端回复 error 帧时返回错误。
func (c *Client) requestOk(ctx context.Context, body map[string]any) (Event, error) {
	frame, err := c.request(ctx, body)
	if err != nil {
		return Event{}, err
	}
	if frame.Kind == "error" {
		return Event{}, newError(frame.Str("code"), frame.Str("message"))
	}
	return frame, nil
}

// expectReply 发送请求并断言回复的事件类型。
func (c *Client) expectReply(ctx context.Context, body map[string]any, kind string) (Event, error) {
	frame, err := c.requestOk(ctx, body)
	if err != nil {
		return Event{}, err
	}
	if frame.Kind != kind {
		return Event{}, newError(CodeUnexpectedReply, "期望 "+kind+"，收到 "+frame.Kind)
	}
	return frame, nil
}

// notify 写出请求，不期待请求级回复。
func (c *Client) notify(body map[string]any) error {
	c.pendingMu.Lock()
	if c.closed {
		err := c.closeErr
		c.pendingMu.Unlock()
		if err == nil {
			err = newError(CodeDisconnected, "客户端已关闭")
		}
		return err
	}
	c.nextID++
	body["v"] = APIVersionMajor
	body["id"] = c.nextID
	c.pendingMu.Unlock()
	frame, err := encodeFrame(body)
	if err != nil {
		return err
	}
	if _, err := c.conn.Write(frame); err != nil {
		return wrapError(CodeDisconnected, "写入失败", err)
	}
	return nil
}

// Server 是握手得到的服务端标识，例如 "zuno-harness-api-bridge/0.1.0"。
func (c *Client) Server() string { return c.server }

// Capabilities 是服务端声明的能力字符串。
func (c *Client) Capabilities() []string { return append([]string(nil), c.capabilities...) }

// Supports 判断服务端是否声明了某项能力。
//
// 客户端依赖某个能力之前，先靠它了解当前服务端会什么。
// 例如 permissions 在当前的 bridge 上就没有：它永远不会发出权限
// 请求，等它的客户端会永远等下去。先检查，别假设。
func (c *Client) Supports(capability string) bool {
	for _, cap := range c.capabilities {
		if cap == capability {
			return true
		}
	}
	return false
}

// SocketPath 是连接的 socket 路径；空表示自定义连接。
func (c *Client) SocketPath() string { return c.socketPath }

// ClientName 是握手时发送的客户端标识。
func (c *Client) ClientName() string { return c.clientName }

// SubmitToolResult 是底层应答接口，供自行处理 tool_call 事件的应用使用。
func (c *Client) SubmitToolResult(ctx context.Context, sessionID, callID string, result ToolResult) error {
	_, err := c.expectReply(ctx, map[string]any{
		"req":        "tool_result",
		"session_id": sessionID,
		"call_id":    callID,
		"output":     result.Output,
		"error":      result.Error,
	}, "ok")
	return err
}

// Subscribe 订阅所有流事件。
//
// 会缓冲两次接收之间到达的帧，所以在循环体里做慢操作的消费方
// 不会静默丢 delta。事件类型是原始帧，用 Event.Decode 解进已知
// 结构；运行时仍可能到达未知类型，请总是保留 default 分支。
func (c *Client) Subscribe() *Subscription {
	return c.subscribeFor("")
}

// SubscribeSession 订阅单个会话的流事件。
func (c *Client) SubscribeSession(sessionID string) *Subscription {
	return c.subscribeFor(sessionID)
}

func (c *Client) subscribeFor(sessionID string) *Subscription {
	c.subsMu.Lock()
	defer c.subsMu.Unlock()
	sub := newSubscription(c, sessionID)
	c.subs[sub] = struct{}{}
	return sub
}

// Subscription 是一条事件订阅；用 Close 释放。
type Subscription = subscription

// subscription 是订阅的内部实现。
type subscription struct {
	mu     sync.Mutex
	queue  []Event
	notify chan struct{}
	closed bool
	filter string
	client *Client
}

func newSubscription(c *Client, filter string) *subscription {
	return &subscription{notify: make(chan struct{}, 1), filter: filter, client: c}
}

func (s *subscription) enqueue(e Event) {
	s.mu.Lock()
	if s.closed {
		s.mu.Unlock()
		return
	}
	if s.filter != "" && e.SessionID != s.filter {
		s.mu.Unlock()
		return
	}
	s.queue = append(s.queue, e)
	s.mu.Unlock()
	select {
	case s.notify <- struct{}{}:
	default:
	}
}

// Next 阻塞直到下一个事件或订阅/客户端关闭。
// 关闭时第二个返回值为 false。
func (s *subscription) Next(ctx context.Context) (Event, bool) {
	for {
		s.mu.Lock()
		if len(s.queue) > 0 {
			e := s.queue[0]
			s.queue = s.queue[1:]
			// queue[1:] 只前进不回收：长跑的订阅会把历史峰值的底层数组
			// 常驻。大容量且已清空时释放，小容量继续复用避免频繁分配。
			if len(s.queue) == 0 && cap(s.queue) > 4096 {
				s.queue = nil
			}
			s.mu.Unlock()
			return e, true
		}
		if s.closed || s.client.isClosed() {
			s.mu.Unlock()
			return Event{}, false
		}
		s.mu.Unlock()

		select {
		case <-s.notify:
		case <-ctx.Done():
			return Event{}, false
		case <-s.client.done:
			return Event{}, false
		}
	}
}

// Close 停止订阅并丢弃缓冲的事件。
func (s *subscription) Close() {
	s.mu.Lock()
	s.closed = true
	s.queue = nil
	s.mu.Unlock()
	s.client.subsMu.Lock()
	delete(s.client.subs, s)
	s.client.subsMu.Unlock()
	select {
	case s.notify <- struct{}{}:
	default:
	}
}

// Len 返回当前缓冲的事件数（诊断用）。
func (s *subscription) Len() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.queue)
}

func (c *Client) isClosed() bool {
	c.pendingMu.Lock()
	defer c.pendingMu.Unlock()
	return c.closed
}

// Close 断开连接；如果本客户端启动过实例，同时停止它。
//
// 返回 error 以便等待已启动实例完全停止；对普通的 Connect
// 客户端它会立即完成。
func (c *Client) Close() error {
	var instanceErr error
	if c.instance != nil {
		instanceErr = c.instance.Shutdown(context.Background())
		c.instance = nil
	}
	c.closeOnce.Do(func() {
		c.pendingMu.Lock()
		c.closed = true
		c.closeErr = newError(CodeDisconnected, "客户端已关闭")
		c.pendingMu.Unlock()
		close(c.done)
	})
	c.toolCbs.close()
	_ = c.conn.Close()
	// 先快照再解锁：subscription.Close 会注销自身，持有 subsMu
	// 直接调它会与注销时的加锁互锁，把 Close 永久挂死。
	c.subsMu.Lock()
	subs := make([]*subscription, 0, len(c.subs))
	for sub := range c.subs {
		subs = append(subs, sub)
	}
	c.subsMu.Unlock()
	for _, sub := range subs {
		sub.Close()
	}
	return instanceErr
}
