/**
 * 单实例、多会话并发聊天示例。
 *
 * 关键约束：bridge 的一条连接只能附着一个会话。
 * 因此"一个客户端同时跑多个会话"在这层上是：
 *
 *   1 个 zuno 实例（1 个 daemon）
 *   └── N 条连接（每条连接各自附着一个会话）
 *
 * 直接在一个 ZunoClient 上并发调用两次 createSession 是不行的：
 * 第二次会把该连接的附着目标覆盖掉，第一个请求永远等不到回复，
 * 表现为 30s 后 `create_session` 超时。
 *
 * 用法：
 *   node examples/chat.mjs
 *   ZUNO_BINARY=/path/to/zuno node examples/chat.mjs
 */

import { ZunoClient } from "../dist/index.js"

const WORKDIR = process.cwd()
const SYSTEM_PROMPT = "你是一位简洁的对话者，回答不超过 30 字。"

/**
 * 共享的 stdout 行首状态。
 *
 * 多个会话并发写同一个终端时，行首是进程级资源，不属于某个会话：
 * 只用会话自己的标记判断，两条流就会写到同一行上。
 */
const stdout = {
  atLineStart: true,
  /** 当前行归属的会话标签；换行时清空。 */
  owner: null,
  newline() {
    if (!this.atLineStart) {
      process.stdout.write("\n")
      this.atLineStart = true
    }
    this.owner = null
  },
}

/**
 * 一个会话 + 它独占的那条连接。
 *
 * 会话之间不共享连接，所以互不影响：一个是慢回合、另一个在流式输出，
 * 不会互相阻塞，也不会把事件串到对方身上。
 */
class ChatSession {
  #client
  #sessionId
  #label
  #closed = false

  constructor(client, sessionId, label) {
    this.#client = client
    this.#sessionId = sessionId
    this.#label = label
  }

  get sessionId() {
    return this.#sessionId
  }

  get label() {
    return this.#label
  }

  #prefix() {
    stdout.newline()
    process.stdout.write(`[${this.#label}] `)
    stdout.atLineStart = false
    stdout.owner = this.#label
  }

  #log(message) {
    stdout.newline()
    console.log(`[${this.#label}] ${message}`)
  }

  #writeText(chunk) {
    for (const piece of chunk.split(/(\n)/)) {
      if (piece === "") continue
      if (piece === "\n") {
        process.stdout.write("\n")
        stdout.atLineStart = true
        stdout.owner = null
        continue
      }
      // 行首，或当前行属于其它会话：另起一行并带上自己的前缀。
      if (stdout.atLineStart || stdout.owner !== this.#label) this.#prefix()
      process.stdout.write(piece)
    }
  }

  /**
   * 发一条消息，流式打印，直到本回合结束。
   *
   * 迭代器在 sendMessage 之前建立，否则可能漏掉最早的事件。
   */
  async send(prompt) {
    const text = []
    const stream = this.#client.events(this.#sessionId)

    await this.#client.sendMessage(this.#sessionId, prompt)

    for await (const event of stream) {
      switch (event.ev) {
        case "model_info":
          this.#log(`模型 ${event.provider}/${event.model}`)
          break
        case "reasoning_delta":
          // 想要看思考过程就打开这行
          // process.stdout.write(`\x1b[2m${event.text}\x1b[0m`)
          break
        case "text_delta":
          this.#writeText(event.text)
          text.push(event.text)
          break
        case "tool_start":
          this.#log(`工具 ${event.name}`)
          break
        case "permission_request":
          this.#log(`权限 ${event.tool_name}: ${event.description} -> allow`)
          await this.#client.respondToPermission(
            this.#sessionId,
            event.request_id,
            "allow",
          )
          break
        case "background_progress":
          this.#log(`后台 ${event.summary}`)
          break
        case "token_usage":
          this.#log(`tokens in=${event.input} out=${event.output}`)
          break
        case "turn_done":
          stdout.newline()
          // for await + break 会自动注销事件监听。
          return text.join("")
        default:
          break
      }
    }

    return text.join("")
  }

  /** 持久化的对话历史，用来验证会话之间确实互不串。 */
  async history() {
    return this.#client.getHistory(this.#sessionId)
  }

  async close() {
    if (this.#closed) return
    this.#closed = true
    await this.#client.close()
  }
}

/**
 * 一个实例 + 会话池。
 *
 * 应用层看到的是一个对象，底层按需为每条会话开一条连接。
 */
class ChatHub {
  #base
  /** 已打开的会话，close() 时统一关闭。 */
  #sessions = new Set()

  constructor(base) {
    this.#base = base
  }

  #track(session) {
    this.#sessions.add(session)
    return session
  }

  static async launch(options = {}) {
    const base = await ZunoClient.launch({
      workingDir: WORKDIR,
      ...options,
    })
    return new ChatHub(base)
  }

  /** 新建一个会话，并交给它一条专属连接。 */
  async newSession({ label = "session", systemPrompt = SYSTEM_PROMPT, tools } = {}) {
    const client = await ZunoClient.connect({
      socketPath: this.#base.socketPath,
      clientName: `zuno-chat/${label}`,
    })
    try {
      const session = await client.createSession({
        workingDir: WORKDIR,
        systemPrompt,
        ...(tools === undefined ? {} : { tools }),
      })
      return this.#track(new ChatSession(client, session.session_id, label))
    } catch (error) {
      // 建会话失败时不要留下一条孤儿连接。
      await client.close()
      throw error
    }
  }

  /** 接管一个已存在的会话（重启后接着聊）。 */
  async attachSession(sessionId, { label = sessionId } = {}) {
    const client = await ZunoClient.connect({
      socketPath: this.#base.socketPath,
      clientName: `zuno-chat/${label}`,
    })
    try {
      const session = await client.attachSession(sessionId)
      return this.#track(new ChatSession(client, session.session_id, label))
    } catch (error) {
      await client.close()
      throw error
    }
  }

  /** 实例里所有持久化会话（含本次运行新建的）。 */
  async listSessions() {
    return this.#base.listSessions()
  }

  /**
   * 永久删除一个会话。
   *
   * 该会话不能仍被任何连接附着：daemon 之后会把它重新写回磁盘。
   * 先 `session.close()`，再用这里删。
   */
  async deleteSession(sessionId) {
    await this.#base.deleteSession(sessionId)
  }

  /** 关闭所有会话连接，再关闭实例。实例是这条连接的实例所有者，必须最后关。 */
  async close() {
    await Promise.all([...this.#sessions].map((session) => session.close()))
    this.#sessions.clear()
    await this.#base.close()
  }
}

// ---------------------------------------------------------------------------
// 演示：两个会话同时运行，然后各自回想自己刚才说了什么
// ---------------------------------------------------------------------------

const hub = await ChatHub.launch({
  inheritLogins: true,
  ...(process.env.ZUNO_BINARY ? { binary: process.env.ZUNO_BINARY } : {}),
})

const alice = await hub.newSession({ label: "小明", tools: { enabled: [] } })
const bob = await hub.newSession({ label: "小红", tools: { enabled: [] } })

console.log(`小明会话: ${alice.sessionId}`)
console.log(`小红会话: ${bob.sessionId}\n`)

// 并发跑两个回合
await Promise.all([
  alice.send("我叫小明，请记住我的名字。"),
  bob.send("我叫小红，请记住我的名字。"),
])

console.log("\n--- 第二轮：各自回忆 ---\n")

const [aliceAnswer, bobAnswer] = await Promise.all([
  alice.send("我叫什么名字？只回答名字。"),
  bob.send("我叫什么名字？只回答名字。"),
])

console.log(`\n小明会话回答: ${aliceAnswer.trim()}`)
console.log(`小红会话回答: ${bobAnswer.trim()}`)

const [aliceHistory, bobHistory] = await Promise.all([
  alice.history(),
  bob.history(),
])
console.log(
  `\n历史条数：小明=${aliceHistory.length} 小红=${bobHistory.length}（互不串）`,
)

// 删除会话：先放开连接，否则 daemon 会把它重新写回磁盘。
await alice.close()
await hub.deleteSession(alice.sessionId)
console.log(`\n已删除会话: ${alice.sessionId}`)

await hub.close()
process.exit(0)
