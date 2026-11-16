// 命令行示例：连接已运行的 zuno bridge 并跑一个回合。
//
//	go run ./examples/chat.go
//
// 需要先启动 bridge：`zuno api-bridge`。
package main

import (
	"context"
	"fmt"
	"os"

	zuno "github.com/sohaha/zuno-sdk/go"
)

func main() {
	ctx := context.Background()
	client, err := zuno.Connect(ctx, zuno.ConnectOptions{ClientName: "zuno-go-example/1.0"})
	if err != nil {
		fmt.Fprintln(os.Stderr, "连接失败（先运行 `zuno api-bridge`）:", err)
		os.Exit(1)
	}
	defer client.Close()

	session, err := client.CreateSession(ctx, zuno.CreateSessionOptions{WorkingDir: "."})
	if err != nil {
		fmt.Fprintln(os.Stderr, "创建会话失败:", err)
		os.Exit(1)
	}

	turn, err := client.Run(ctx, session.SessionID, "用一句话介绍你自己", zuno.RunOptions{
		OnEvent: func(event zuno.Event) {
			if event.Kind == "text_delta" {
				fmt.Print(event.Str("text"))
			}
		},
	})
	if err != nil {
		fmt.Fprintln(os.Stderr, "\n回合失败:", err)
		os.Exit(1)
	}

	fmt.Printf("\n\ntool calls: %d", len(turn.ToolCalls))
	if turn.Usage != nil {
		fmt.Printf(", tokens: in=%d out=%d", turn.Usage.Input, turn.Usage.Output)
	}
	fmt.Println()
}
