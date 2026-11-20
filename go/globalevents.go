package zuno

import (
	"context"
	"errors"
	"sync"
	"time"
)

// 服务端级事件流：把所有会话的事件汇聚到一个订阅。
//
// bridge 每个连接只能附着一个会话，所以服务端级订阅必须发现持久化
// 会话、为每个会话建立子客户端，再把事件合并到单一流。
//
// 投递保证是自附着时起，不是历史回放：子连接附着完成之前、或意外
// 断开并重新附着期间发出的事件，协议 v1 无法恢复。单会话内顺序
// 保留；不保证跨会话的全局顺序。

// GlobalEventsOptions 描述全局事件流的参数。
type GlobalEventsOptions struct {
	// DiscoveryInterval 是检查新创建会话的间隔。默认 1s。
	DiscoveryInterval time.Duration
}

// GlobalEvents 通过每会话子连接汇聚所有会话的事件。
//
// 需要原生 socket 连接；自定义连接无法克隆为每会话子连接。
// 调用方用完记得 cancel 取消发现循环并关闭所有子连接。
func (c *Client) GlobalEvents(ctx context.Context, options GlobalEventsOptions) (*SubscriptionManaged, error) {
	if c.socketPath == "" {
		return nil, newError(CodeUnsupportedTransport,
			"GlobalEvents 需要原生 socket 连接；自定义连接无法克隆为每会话子连接")
	}
	if c.isClosed() {
		return nil, newError(CodeDisconnected, "harness 连接已关闭")
	}

	interval := options.DiscoveryInterval
	if interval == 0 {
		interval = time.Second
	}

	aggregate := newSubscription(c, "")
	c.subsMu.Lock()
	c.subs[aggregate] = struct{}{}
	c.subsMu.Unlock()

	// aggregate 不应直接从本连接的 dispatch 里收事件：子连接的
	// pump 才是它的数据源。从 client.subs 里摘除。
	c.subsMu.Lock()
	delete(c.subs, aggregate)
	c.subsMu.Unlock()

	managed := &globalEventsStream{
		client:   c,
		queue:    aggregate,
		interval: interval,
		children: map[string]*Client{},
		starting: map[string]bool{},
		rootCtx:  ctx,
	}
	go managed.scanLoop()
	go func() {
		select {
		case <-ctx.Done():
			managed.Stop()
		case <-c.done:
			managed.Stop()
		}
	}()
	return &SubscriptionManaged{aggregate, managed}, nil
}

// SubscriptionManaged 是可手动停止的全局事件订阅。
type SubscriptionManaged struct {
	*subscription
	stream *globalEventsStream
}

// Close 停止订阅并关闭所有子连接。
func (s *SubscriptionManaged) Close() {
	s.stream.Stop()
	s.subscription.Close()
}

// Err 返回导致全局流停止的错误，正常关闭返回 nil。
func (s *SubscriptionManaged) Err() error {
	s.stream.mu.Lock()
	defer s.stream.mu.Unlock()
	return s.stream.err
}

// globalEventsStream 管理发现循环与子连接。
type globalEventsStream struct {
	mu       sync.Mutex
	client   *Client
	queue    *subscription
	interval time.Duration
	children map[string]*Client
	starting map[string]bool
	stopped  bool
	err      error
	stopOnce sync.Once
	rootCtx  context.Context
}

// Stop 停止发现并关闭所有每会话子连接。
func (g *globalEventsStream) Stop() {
	g.stopOnce.Do(func() {
		g.mu.Lock()
		g.stopped = true
		children := make([]*Client, 0, len(g.children))
		for _, child := range g.children {
			children = append(children, child)
		}
		g.children = map[string]*Client{}
		g.mu.Unlock()
		for _, child := range children {
			_ = child.Close()
		}
		g.queue.Close()
	})
}

func (g *globalEventsStream) fail(err error) {
	g.mu.Lock()
	if !g.stopped {
		g.err = err
	}
	g.mu.Unlock()
	g.Stop()
}

func (g *globalEventsStream) isStopped() bool {
	g.mu.Lock()
	defer g.mu.Unlock()
	return g.stopped
}

// startChild 为一个会话建立子连接并把它的事件泵进聚合流。
func (g *globalEventsStream) startChild(sessionID string) {
	g.mu.Lock()
	if g.stopped || g.children[sessionID] != nil || g.starting[sessionID] {
		g.mu.Unlock()
		return
	}
	g.starting[sessionID] = true
	g.mu.Unlock()
	defer func() {
		g.mu.Lock()
		delete(g.starting, sessionID)
		g.mu.Unlock()
	}()

	ctx, cancel := context.WithCancel(g.rootCtx)
	child, err := Connect(ctx, ConnectOptions{
		SocketPath:     g.client.socketPath,
		ClientName:     g.client.clientName + "/global-events",
		RequestTimeout: g.client.requestTimeout,
	})
	if err != nil {
		cancel()
		// 会话在扫描与连接之间被删除是正常情况，不打断整条流。
		var herr *HarnessError
		if !errors.As(err, &herr) || herr.Code != "unknown_session" {
			g.fail(err)
		}
		return
	}
	g.mu.Lock()
	if g.stopped {
		g.mu.Unlock()
		_ = child.Close()
		cancel()
		return
	}
	g.children[sessionID] = child
	g.mu.Unlock()

	if _, err := child.AttachSession(ctx, sessionID); err != nil {
		g.mu.Lock()
		delete(g.children, sessionID)
		g.mu.Unlock()
		_ = child.Close()
		cancel()
		var herr *HarnessError
		if !errors.As(err, &herr) || herr.Code != "unknown_session" {
			g.fail(err)
		}
		return
	}

	go func() {
		defer func() {
			g.mu.Lock()
			if g.children[sessionID] == child {
				delete(g.children, sessionID)
			}
			g.mu.Unlock()
			_ = child.Close()
			cancel()
		}()
		sub := child.SubscribeSession(sessionID)
		for {
			event, ok := sub.Next(ctx)
			if !ok {
				return
			}
			g.queue.enqueue(event)
		}
	}()
}

// scanLoop 周期性发现会话并补建子连接。
func (g *globalEventsStream) scanLoop() {
	for {
		if g.isStopped() {
			return
		}
		sessions, err := g.client.ListSessions(g.rootCtx, true, 0)
		if err != nil {
			if g.isStopped() {
				return
			}
			g.fail(err)
			return
		}
		for _, session := range sessions {
			if g.isStopped() {
				return
			}
			g.startChild(session.SessionID)
		}
		select {
		case <-time.After(g.interval):
		case <-g.rootCtx.Done():
			return
		}
	}
}
