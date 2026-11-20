// Package zuno 是 zuno harness API（协议 v1）的 Go SDK。
//
// 与 crates/zuno-harness-api 一一对应，通过 harness API socket 以
// NDJSON 通信。协议层的请求/事件标签集合由 schema-parity 测试钉住，
// Rust 侧新增变体而这里没有同步镜像时测试会失败。
//
// 两种使用方式：
//
//   - Launch：启动私有 zuno 实例（自己的会话、状态与 socket），
//     把 zuno 嵌入为 agent 引擎；Close 时停止实例。
//
//   - Connect：附着到本机已在运行的 zuno（需要 `zuno api-bridge`），
//     自动化用户自己的会话。
//
//     factory := zuno.NewLauncher(zuno.LaunchOptions{WorkingDir: "."})
//     client, err := factory.Launch(context.Background())
//     session, _ := client.CreateSession(ctx, ".")
//     turn, _ := client.Run(ctx, session.SessionID, "hello")
//     fmt.Println(turn.FinalText)
//     client.Close()
package zuno

// 协议版本，与 crates/zuno-harness-api/src/lib.rs 保持同步。
const (
	APIVersionMajor = 1
	APIVersionMinor = 13
)
