# zuno-sdk-go

zuno harness API（协议 v1）的 Go SDK，用于在 Go 应用中连接、驱动 zuno 会话并消费事件流。

## 安装

```bash
go get github.com/sohaha/zuno-sdk-go
```

## 运行要求

- Go 1.24+
- 支持 macOS、Linux、Windows；SDK 会在首次使用时按需下载并缓存对应的 zuno 运行时（`~/.zuno/sdk/`）
- 也可通过 `LaunchOptions.Binary` 指定本地可执行文件，或使用 `PATH` 中的 `zuno`

## 快速开始

### 嵌入私有实例（推荐）

```go
client, err := zuno.LaunchAndConnect(ctx, zuno.LaunchOptions{
    WorkingDir: ".",
}, zuno.ConnectOptions{ClientName: "my-app/1.0"})
if err != nil {
    // handle error
}
defer client.Close()

session, _ := client.CreateSession(ctx, zuno.CreateSessionOptions{WorkingDir: "."})
turn, _ := client.Run(ctx, session.SessionID, "src/ 目录下有哪些文件？",
    zuno.RunOptions{AutoApprove: true})
fmt.Println(turn.FinalText)
```

### 连接已运行的 zuno

需要先启动 bridge：

```bash
zuno api-bridge
```

```go
client, err := zuno.Connect(ctx, zuno.ConnectOptions{})
if err != nil {
    // handle error
}
defer client.Close()
```

可通过 `ZUNO_API_SOCKET` 覆盖 API socket 路径。

## 事件流

```go
sub := client.SubscribeSession(session.SessionID)
defer sub.Close()

for {
    event, ok := sub.Next(ctx)
    if !ok {
        break
    }
    switch event.Kind {
    case "text_delta":
        fmt.Print(event.Str("text"))
    }
}
```

## 会话工具

```go
err := client.ConfigureTools(ctx, session.SessionID, zuno.SessionToolsOptions{
    Enabled: &[]string{"read", "agentgrep"},
    Custom: []zuno.Tool{{
        Name:        "lookup_ticket",
        Description: "在应用的工单库中查询工单",
        Parameters: map[string]any{
            "type": "object",
            "properties": map[string]any{
                "id": map[string]any{"type": "string"},
            },
            "required": []string{"id"},
        },
        Execute: func(ctx zuno.ToolContext, input map[string]any) (zuno.ToolResult, error) {
            return zuno.ToolResult{Output: "工单详情"}, nil
        },
    }},
})
```

## 结构化输出

```go
schema := map[string]any{
    "type": "object",
    "properties": map[string]any{
        "summary": map[string]any{"type": "string"},
    },
    "required": []string{"summary"},
}

res, err := zuno.RunStructured[map[string]any](ctx, client, session.SessionID, "总结改动",
    zuno.RunStructuredOptions{Schema: schema})
if err != nil {
    // handle error
}
fmt.Println(res.Data)
```

## 环境变量

| 变量 | 作用 |
| --- | --- |
| `ZUNO_API_SOCKET` | 覆盖 harness API socket 路径 |
| `ZUNO_RUNTIME_DIR` | 覆盖运行时目录 |
| `ZUNO_HOME` | 用户 zuno home |
| `ZUNO_BINARY` | 指定 zuno 可执行文件 |
| `ZUNO_RELEASE_BASE` | 覆盖发布服务器基地址 |
| `ZUNO_VERSION` | 锁定下载的版本 |

## 开发

```bash
go test ./...
```
