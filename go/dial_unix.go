//go:build !windows

package zuno

import (
	"errors"
	"net"
	"syscall"
)

// dialEndpoint 拨号到给定端点。Unix 上是 Unix domain socket。
func dialEndpoint(endpoint string) (net.Conn, error) {
	// 一条裸 `connect ENOENT /run/user/1000/zuno-api.sock` 只报系统调用，
	// 掩盖了真正的原因：bridge 没在运行。把拨号失败变成指明可能原因
	// 和解决办法的错误。
	conn, err := net.Dial("unix", endpoint)
	if err != nil {
		return nil, wrapError(CodeConnectFailed, connectHint(endpoint, err), err)
	}
	return conn, nil
}

func connectHint(socketPath string, cause error) string {
	var errno syscall.Errno
	if errors.As(cause, &errno) {
		switch errno {
		case syscall.ENOENT:
			return socketPath + " 上没有 harness API socket。用 `zuno api-bridge` 启动 bridge，" +
				"或把 ZUNO_API_SOCKET 设为它的路径。"
		case syscall.ECONNREFUSED:
			return socketPath + " 上没有监听者；这个残留的 socket 文件是已退出的 bridge 留下的。请重启 bridge。"
		case syscall.EACCES:
			return socketPath + " 权限拒绝：该 socket 属于另一个用户。"
		}
	}
	return "无法连接到 " + socketPath + "：" + cause.Error()
}
