//go:build windows

package zuno

import (
	"net"

	winio "github.com/Microsoft/go-winio"
)

// dialEndpoint 拨号到给定端点。Windows 上是命名管道。
// bridge 监听由 socket 路径派生出的命名管道，派生规则见 TransportEndpoint。
func dialEndpoint(endpoint string) (net.Conn, error) {
	conn, err := winio.DialPipe(endpoint, nil)
	if err != nil {
		return nil, wrapError(CodeConnectFailed,
			"无法连接到 "+endpoint+"："+err.Error()+"。用 `zuno api-bridge` 启动 bridge。", err)
	}
	return conn, nil
}
