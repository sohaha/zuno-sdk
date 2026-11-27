//go:build windows

package zuno

import (
	"net"
	"testing"

	winio "github.com/Microsoft/go-winio"
)

// Windows 没有 unix socket 文件：客户端会把 socket 路径经 TransportEndpoint
// 派生出一条命名管道再去拨号。所以 mock harness 必须监听同一条管道，而不是
// 原始路径，否则每个走 Connect 的测试都会去拨一条不存在的管道。
//
// 这里直接复用产品代码的派生规则，测试因此顺带覆盖了「路径 → 管道」这一步；
// 临时目录名带随机后缀，派生出的管道名天然唯一，同进程多实例也不会撞名。
func listenMockEndpoint(t *testing.T, socketPath string) net.Listener {
	t.Helper()
	listener, err := winio.ListenPipe(TransportEndpoint(socketPath), nil)
	if err != nil {
		t.Fatal(err)
	}
	return listener
}
