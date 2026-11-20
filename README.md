# zuno-sdk

## 只读目录权限

创建会话可传 `filesystem` 与 daemon 上限求交，进一步收紧权限，显式空目录列表拒绝全部读取。启动私有实例可设置 daemon 上限。配置策略后只有只读访问，不支持 `write_roots` 或其他未知字段。所有根目录必须为绝对路径。
SDK 在带策略创建前检查 `filesystem_policy` 能力，旧运行时不支持则报错，不会静默忽略。bridge 仅在 daemon 明确支持后宣告该能力。
私有实例将策略写为 `ZUNO_FILESYSTEM_POLICY={"read_roots":[]}`，显式选项优先于额外环境变量。父子 fork/transfer 的有效策略由 daemon 保留，不能扩大 daemon 上限。
受限会话暂不支持 bridge 的 `read_file`、`find_files`、`search_text`、`file_status` 直连文件接口，会返回 `unsupported`。请改用 daemon 的受限文件工具。

面向 zuno harness API（协议 v1）的 SDK 集合，用于在应用中连接、驱动 zuno 会话并消费事件流。

本目录包含两个独立语言包：

| 语言 | 目录 | 包/模块 |
| --- | --- | --- |
| TypeScript / Node.js | [`typescript/`](./typescript/) | `@sohaha/zuno-sdk` |
| Go | [`go/`](./go/) | `github.com/sohaha/zuno-sdk-go` |

## 接入方式

- **嵌入私有实例（推荐）**：启动独立的 zuno 实例，拥有独立状态、会话与连接生命周期，适合集成到应用中。
  - TypeScript：`ZunoClient.launch(...)`
  - Go：`zuno.LaunchAndConnect(...)`
- **连接已运行的 zuno**：附着到本机已有 bridge，共享其活跃会话，适合插件或状态面板等场景。使用前先启动：

```bash
zuno api-bridge
```

## 快速开始

### TypeScript

```bash
npm install @sohaha/zuno-sdk
```

```ts
import { ZunoClient } from "@sohaha/zuno-sdk";

const client = await ZunoClient.launch({ workingDir: process.cwd() });
const session = await client.createSession(process.cwd());
const turn = await client.run(session.session_id, "src/ 目录下有哪些文件？", {
  autoApprove: true,
});

console.log(turn.text);
await client.close();
```

详见 [`typescript/README.md`](./typescript/README.md)。

### Go

```bash
go get github.com/sohaha/zuno-sdk-go
```

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

详见 [`go/README.md`](./go/README.md)。

## 说明

- SDK 可按需下载并缓存对应平台的 zuno 运行时，也支持指定本地可执行文件或使用 `PATH` 中的 `zuno`。
- 私有实例默认可继承用户的 provider 登录态；如需隔离，请按各语言 SDK 的选项关闭继承并自行提供凭据。
- 各语言包的详细 API、事件与示例请分别参考对应子目录 README。
