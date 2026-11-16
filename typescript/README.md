# @sohaha/zuno-sdk

zuno harness API（协议 v1）的 TypeScript SDK，用于在 Node.js 应用中连接、驱动 zuno 会话并消费事件流。

## 安装

```bash
npm install @sohaha/zuno-sdk
```

预览版用 `preview` 标签安装：`npm install @sohaha/zuno-sdk@preview`。

## 运行要求

- Node.js 20+
- 支持 macOS、Linux、Windows；SDK 会在首次使用时按需下载并缓存对应的 zuno 运行时（`~/.zuno/sdk/`）
- 也可通过 `binary` 指定本地可执行文件，或使用 `PATH` 中的 `zuno`

## 快速开始

### 嵌入私有实例（推荐）

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

### 连接已运行的 zuno

需要先启动 bridge：

```bash
zuno api-bridge
```

```ts
import { ZunoClient } from "@sohaha/zuno-sdk";

const client = await ZunoClient.connect();
const session = await client.createSession(process.cwd());
const turn = await client.run(session.session_id, "hello");
console.log(turn.text);
client.close();
```

## 事件流

```ts
await client.sendMessage(session.session_id, "hello");

for await (const event of client.events(session.session_id)) {
  if (event.ev === "text_delta") process.stdout.write(event.text);
  if (event.ev === "permission_request") {
    await client.respondToPermission(session.session_id, event.request_id, "allow");
  }
  if (event.ev === "turn_done") break;
}
```

## 常用能力

- **会话**：`createSession` / `listSessions` / `attachSession` / `deleteSession` / `renameSession`
- **消息与回合**：`sendMessage` / `run` / `runStructured` / `cancel` / `softInterrupt`
- **模型与运行时**：`listModels` / `setModel` / `getRuntimeInfo` / `setReasoningEffort`
- **工具控制**：`configureTools` / `listTools`，支持按会话启用内建工具与注册自定义工具回调
- **文件与历史**：`readFile` / `findFiles` / `searchText` / `getHistory` / `peekSession` / `rewind`

## 结构化输出

```ts
const result = await client.runStructured<{ summary: string }>(
  session.session_id,
  "总结当前改动",
  {
    schema: {
      type: "object",
      additionalProperties: false,
      required: ["summary"],
      properties: { summary: { type: "string" } },
    },
  },
);

console.log(result.data.summary);
```

## 错误码

所有失败都抛 `HarnessError`，`error.code` 是稳定的字符串常量。SDK 侧产生的码：

| 码 | 含义 |
| --- | --- |
| `busy` | 同一会话已有同类型请求在进行中（例如重复配置工具） |
| `connect_failed` | 无法建立到 harness 的连接（socket 不存在或被拒绝） |
| `disconnected` | 连接已关闭，或写入失败 |
| `handshake_failed` | 握手回复不符合协议 |
| `invalid_instance_home` | `zunoHome` 指向不安全或不可用的路径 |
| `invalid_request` | 调用参数不合法（例如 `maxRetries` 为负数） |
| `startup_failed` | 私有实例启动失败或提前退出 |
| `startup_timeout` | 等待私有实例就绪超时 |
| `structured_output_invalid` | 结构化输出不是合法 JSON |
| `structured_schema_invalid` | 结构化输出不符合给定 JSON Schema |
| `unexpected_reply` | 收到的帧与期望类型不符 |
| `unknown_request` | 运行时不认识该请求（通常是协议或运行时版本过旧） |
| `unsupported` | 当前运行时或平台不支持该能力 |
| `zuno_not_found` | 找不到可用的 zuno 可执行文件 |

harness 服务端返回的码（`crates/zuno-harness-api` 的 `ErrorCode`）：

| 码 | 含义 |
| --- | --- |
| `invalid_request` | 请求载荷不合法 |
| `internal` | 服务端内部错误 |
| `unknown_session` | 会话 ID 不存在或已归档 |
| `unknown_request` | 服务端不认识该请求 |
| `unsupported_version` | 协议版本不受支持 |
| `dependency_unreachable` | 依赖的 daemon 未在监听（启动或重装） |
| `dependency_timeout` | 依赖 daemon 接受连接但未完成握手（重试或重启） |
| `unknown` | 前向兼容兜底，客户端应静默跳过 |

## 说明

- `launch()` 启动私有实例，`close()` 会停止该实例；`connect()` 连接本机已有 bridge。
- 私有实例默认继承用户的 provider 登录态；可通过 `inheritLogins: false` 关闭。跨运行保留会话可指定 `zunoHome`。
- 会话级工具配置为内存态：在重连、重启、恢复或 fork 后，发起新回合前需重新配置。
