# zuno SDK 示例应用

一个独立的 Node 应用：启动私有 zuno 实例，流式输出回复，
报告工具调用，并在退出时清理私有实例。

## 运行

先安装 zuno，登录至少一个模型供应商，然后：

```bash
npm install
npm start -- "总结这个项目"
```

SDK 默认继承你已有的 zuno 供应商登录态。私有实例的会话和
状态都是独立的，应用退出时 `client.close()` 会把它删除。

测试某个本地构建时，可设置 `ZUNO_BINARY=/full/path/to/zuno`。
生产环境中请显式处理权限请求，不要依赖 `autoApprove: true`。
