/**
 * 非流式聊天示例：用 `client.run` 一次拿到整个回合的结果。
 *
 * 需要流式输出或多会话并发，见 examples/chat.mjs。
 *
 * 用法：
 *   node examples/chat-text.mjs "你的问题"
 *   ZUNO_BINARY=/path/to/zuno node examples/chat-text.mjs "你的问题"
 */

import { ZunoClient } from "../dist/index.js"

const client = await ZunoClient.launch({
  workingDir: process.cwd(),
  inheritLogins: true,
  ...(process.env.ZUNO_BINARY ? { binary: process.env.ZUNO_BINARY } : {}),
})

try {
  const session = await client.createSession({
    workingDir: process.cwd(),
    systemPrompt: "你是一位简洁的对话者，回答不超过 30 字。",
    tools: { enabled: [] },
  })

  const prompt = process.argv.slice(2).join(" ") || "用一句话介绍你自己。"
  const turn = await client.run(session.session_id, prompt)

  console.log(turn.finalText.trim())
  if (turn.usage) {
    console.log(`\ntokens in=${turn.usage.input} out=${turn.usage.output}`)
  }
} finally {
  await client.close()
}
