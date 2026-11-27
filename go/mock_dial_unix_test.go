//go:build !windows

package zuno

import (
	"net"
	"testing"
)

// Unix 上 socket 路径就是端点本身，mock harness 直接监听它。
func listenMockEndpoint(t *testing.T, socketPath string) net.Listener {
	t.Helper()
	listener, err := net.Listen("unix", socketPath)
	if err != nil {
		t.Fatal(err)
	}
	return listener
}
