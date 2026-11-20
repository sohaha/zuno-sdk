/**
 * 启动私有 zuno 实例。
 *
 * `ZunoClient.connect()` 附着到机器上已在运行的 zuno——这对自动化
 * *你自己的* zuno 的工具（编辑器插件、仪表盘）是合适的，对其他场景
 * 则不然。把 zuno 嵌入为 agent 引擎的应用需要自己的实例：自己的会话、
 * 自己的状态，以及不会意外干扰用户正在进行的会话。
 *
 * `launch()` 提供一个实例。它在专用的 `ZUNO_HOME` 和运行时目录下
 * 启动私有 daemon 和 bridge，并在 `close()` 时将其关闭。
 */

import { spawn, type ChildProcess } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { HarnessError } from "../utils/harness-error.js"
import { ensureZunoBinary, platformBinaryPackage } from "./binary-installer.js"
import {
  readDaemonPidSync,
  removeInstanceHome,
  stopInstanceDaemon,
  waitForDaemonPid,
} from "./instance-runtime.js"

// 测试按名字从这里导入生命周期原语；拆分后保留 re-export。
export { removeInstanceHome, readDaemonPidSync, stopInstanceDaemon, waitForDaemonPid }

/**
 * 继承登录态时从用户的 zuno home 继承的文件。
 *
 * 有意*不*包含：`auth-refresh-state.json` 和 `auth-validation.json`，
 * 它们是历史认证失败的派生记录。复制它们会把另一个 zuno 的坏日子带进来，
 * 过期的 `rejected_refresh_fingerprint` 会让新实例即使拿着可用的凭据
 * 也拒绝尝试刷新。
 */
const CREDENTIAL_FILES = [
  "auth.json",
  "openai-auth.json",
  "antigravity_oauth.json",
  "gemini_oauth.json",
  "google_oauth.json",
  "google_credentials.json",
  "config.toml",
]

/**
 * 必须与用户的 home *共享*而非复制的凭据。
 *
 * OAuth refresh token 会轮转：兑换一次就会签发新的并使旧的失效。
 * 两个 home 各持同一 token 的副本就会互相打架，后刷新的那个会被登出。
 * 副本自己也会过期，因为它持有的 access token 几小时就失效，而实例
 * 可能运行数天。共享文件让一组凭据只保留一份轮转记录，这也正是
 * token 本身所假设的。
 */
const SHARED_FILES = new Set(CREDENTIAL_FILES.filter((name) => name !== "config.toml"))

/**
 * zuno 查找*其他*工具凭据的位置，相对于 `$HOME`。
 *
 * zuno 可以复用已有 CLI 的 OAuth 存储来登录，因此大量真实用户根本没有
 * 可用的 `~/.zuno/auth.json`：可用的凭据在 `~/.claude/` 或
 * `~/.config/github-copilot/` 下的文件里。在 `ZUNO_HOME` 下这些查找
 * 被沙箱化到 `$ZUNO_HOME/external/`，所以只继承 `auth.json` 的实例
 * 会悄无声息地没有凭据，在第一个回合就失败。链接这些可识别的凭据文件
 * 让继承名副其实，又不会整个暴露任一目录。
 */
/**
 * zuno 自己的配置目录，相对于平台配置根目录。
 *
 * `app_config_dir()` 是 provider env 文件所在处（`anthropic.env`、
 * zuno 订阅用的 `n.env`），`ZUNO_HOME` 会把它重定向到
 * `$ZUNO_HOME/config/zuno`。它很容易被漏掉，因为它根本不在 `~/.zuno`
 * 之下；而漏掉它不是小问题：在一台可用凭据是 zuno 订阅的机器上，
 * `auth.json` 里只有一个过期的 OAuth token，实例继承的恰好是那个
 * 不可用的凭据，而可用的一个都没拿到。
 */
const APP_CONFIG_DIRNAME = "zuno"

const EXTERNAL_CREDENTIAL_FILES = [
  ".claude/.credentials.json",
  ".codex/auth.json",
  ".gemini/oauth_creds.json",
  ".cursor/auth.json",
  ".config/cursor/auth.json",
  "AppData/Roaming/Cursor/auth.json",
  ".config/Cursor/User/globalStorage/state.vscdb",
  ".config/cursor/User/globalStorage/state.vscdb",
  "Library/Application Support/Cursor/User/globalStorage/state.vscdb",
  "Library/Application Support/cursor/User/globalStorage/state.vscdb",
  "AppData/Roaming/Cursor/User/globalStorage/state.vscdb",
  "AppData/Roaming/cursor/User/globalStorage/state.vscdb",
  ".config/github-copilot/hosts.json",
  ".config/github-copilot/apps.json",
  ".copilot/config.json",
  ".hermes/auth.json",
  ".pi/agent/auth.json",
  ".zpi/agent/auth.json",
  ".openclaw/agent/auth.json",
  ".openclaw/credentials/oauth.json",
  ".local/share/opencode/auth.json",
]

/** 确保实例根目录下的某个目录不含符号链接层级。 */
function ensureInstanceDirectory(root: string, relative: string): string {
  if (path.isAbsolute(relative) || relative.split(/[\\/]+/u).includes("..")) {
    throw new HarnessError("invalid_instance_home", `实例路径不安全：${relative}`)
  }

  let current = root
  for (const part of relative.split(/[\\/]+/u).filter(Boolean)) {
    current = path.join(current, part)
    try {
      const stats = fs.lstatSync(current)
      if (stats.isSymbolicLink()) {
        // 迁移旧版 SDK 链接了整个凭据目录的 home。unlinkSync 只移除链接
        // 本身，绝不会动到它的目标。
        fs.unlinkSync(current)
        fs.mkdirSync(current, { mode: 0o700 })
      } else if (!stats.isDirectory()) {
        throw new HarnessError(
          "invalid_instance_home",
          `实例凭据路径不是目录：${current}`,
        )
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
      fs.mkdirSync(current, { mode: 0o700 })
    }
  }
  return current
}

/** 把实例内的一个相对路径替换为指向单个凭据文件的链接。 */
function linkCredentialFile(source: string, root: string, relative: string): boolean {
  let sourceStats
  try {
    sourceStats = fs.statSync(source)
  } catch {
    return false
  }
  if (!sourceStats.isFile()) return false

  const parent = ensureInstanceDirectory(root, path.dirname(relative))
  const destination = path.join(parent, path.basename(relative))
  try {
    fs.unlinkSync(destination)
  } catch {
    // 不存在，这是常见情况。
  }
  fs.symlinkSync(source, destination)
  return true
}

export type WakeMode = "internal" | "external"

import { filesystemPolicyWire } from "../protocol/filesystem-policy.js"

export interface LaunchOptions {
  /** daemon 只读目录上限，优先于 env 中的策略，空列表拒绝全部。 */
  filesystem?: import("../protocol/filesystem-policy.js").FilesystemPolicy
  /**
   * 存放实例状态（会话、日志、凭据）的目录。
   *
   * 默认为新建的临时目录，`close()` 时移除。
   * 传固定路径可跨运行保留会话。
   */
  zunoHome?: string
  /** 此实例中创建的会话的工作目录。 */
  workingDir?: string
  /**
   * 与实例共享用户的 provider 登录态。默认 `true`。
   *
   * 没有凭据的新实例无法访问任何模型，所以默认是可用的那个。
   * 但这也意味着嵌入的应用会消耗用户的 provider 配额，
   * 传 `false` 可空启动并自行提供凭据。
   */
  inheritLogins?: boolean
  /** zuno 二进制路径。默认为 npm 自带的运行时，其次是 `PATH` 上的 `zuno`。 */
  binary?: string
  /** 传给实例的额外环境变量。 */
  env?: Record<string, string>
  /**
   * 派生 swarm worker 的默认模型，除非每次派生时单独覆盖。
   * 用 `inherit` 表示沿用协调者的模型和鉴权路由。此设置优先于
   * `env.ZUNO_SWARM_MODEL`。
   */
  swarmModel?: string
  /**
   * 由谁执行自主唤醒请求。此运维级设置优先于 `env.ZUNO_WAKE_MODE`。
   */
  wakeMode?: WakeMode
  /** 等待 socket 出现的毫秒数。默认 30000。 */
  startupTimeoutMs?: number
  /** 把实例的 stderr 转发到本进程。默认 false。 */
  inheritStderr?: boolean
  /**
   * `close()` 移除临时实例 home 的毫秒数。
   *
   * 关闭前已启动的后台工作可能在 daemon 被要求停止后仍写入数秒，
   * 在删除之后又重建目录。默认 30000；调用方宁可泄漏也不想等可以调低。
   */
  cleanupTimeoutMs?: number
}

/** 一个运行中的私有 zuno 实例。 */
export interface LaunchedInstance {
  /** 要连接的 API socket 路径。 */
  socketPath: string
  /** 实例的 `ZUNO_HOME`。 */
  zunoHome: string
  /** bridge 进程。 */
  process: ChildProcess
  /** 停止实例并清理它创建的一切。 */
  shutdown(): Promise<void>
}

/** 解析用户真实的 zuno home，忽略实例级覆盖。 */
export function userZunoHome(): string {
  return process.env.ZUNO_HOME ?? path.join(os.homedir(), ".zuno")
}

/** 用户的 zuno 配置目录，与 `storage::app_config_dir` 对应。 */
export function userAppConfigDir(): string {
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", APP_CONFIG_DIRNAME)
  }
  if (process.platform === "win32") {
    const appData = process.env.APPDATA ?? path.join(os.homedir(), "AppData", "Roaming")
    return path.join(appData, APP_CONFIG_DIRNAME)
  }
  const xdg = process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config")
  return path.join(xdg, APP_CONFIG_DIRNAME)
}

/**
 * 把用户的 provider 登录态交给启动的实例。
 *
 * 凭据文件用符号链接共享，token 轮转才能保持一致（见 {@link SHARED_FILES}）；
 * 其他文件复制，让实例可以修改自己的配置而不动用户的。副本仅属主可访问。
 *
 * 返回实际继承到的名字列表，让调用方能区分"什么都没继承"和"继承到了东西"。
 */
export function inheritCredentials(fromHome: string, toHome: string): string[] {
  fs.mkdirSync(toHome, { recursive: true, mode: 0o700 })
  const toStats = fs.lstatSync(toHome)
  if (toStats.isSymbolicLink() || !toStats.isDirectory()) {
    throw new HarnessError(
      "invalid_instance_home",
      `实例 home 必须是真实目录，不能是链接或文件：${toHome}`,
    )
  }
  if (
    fs.existsSync(fromHome) &&
    fs.realpathSync(fromHome) === fs.realpathSync(toHome)
  ) {
    throw new HarnessError(
      "invalid_instance_home",
      "实例 home 必须与用户的 zuno home 不同",
    )
  }

  const inherited: string[] = []
  for (const name of CREDENTIAL_FILES) {
    const source = path.join(fromHome, name)
    if (!fs.existsSync(source)) continue
    const destination = path.join(toHome, name)
    if (SHARED_FILES.has(name)) {
      // 复用的 `zunoHome` 里已有这些链接，而 symlinkSync 遇到 EEXIST
      // 会抛错而不是替换。重新链接还能修正上一次运行留下的过期链接，
      // 所以选择替换而不是跳过。
      linkCredentialFile(source, toHome, name)
    } else {
      fs.copyFileSync(source, destination)
      fs.chmodSync(destination, 0o600)
    }
    inherited.push(name)
  }

  // zuno 的 provider env 文件在它的平台配置目录里，`ZUNO_HOME` 会把它
  // 移到 `$ZUNO_HOME/config/zuno`。只链接 env 文件：缓存和用量数据
  // 不是凭据，必须保持实例私有。最重要的是永远不要链接目录本身——
  // 有缺陷的递归清理可能顺着目录链接删掉用户的文件；文件链接最多
  // 只能删掉实例侧的那一个路径。
  const userConfig = userAppConfigDir()
  try {
    for (const entry of fs.readdirSync(userConfig, { withFileTypes: true })) {
      if ((!entry.isFile() && !entry.isSymbolicLink()) || !entry.name.endsWith(".env")) continue
      const relative = `config/${APP_CONFIG_DIRNAME}/${entry.name}`
      if (linkCredentialFile(path.join(userConfig, entry.name), toHome, relative)) {
        inherited.push(relative)
      }
    }
  } catch {
    // 没有应用配置目录是全新安装的正常状态。
  }

  // 其他 CLI 的凭据存储，zuno 直接读取它们，`ZUNO_HOME` 会把它们
  // 重定向到 `$ZUNO_HOME/external/`。只共享确切的凭据文件。链接整个
  // 目录会同时暴露转录记录、配置和这些工具未来新增的任何内容。
  for (const relative of EXTERNAL_CREDENTIAL_FILES) {
    const source = path.join(os.homedir(), relative)
    const instanceRelative = path.join("external", relative)
    if (linkCredentialFile(source, toHome, instanceRelative)) {
      inherited.push(`external/${relative}`)
    }
  }

  // OpenClaw 当前的存储是按 agent 划分的。枚举一层 agent ID，
  // 然后只链接它的加载器认得的两个凭据文件名。
  const openclawAgents = path.join(os.homedir(), ".openclaw", "agents")
  try {
    for (const agent of fs.readdirSync(openclawAgents, { withFileTypes: true })) {
      if (!agent.isDirectory()) continue
      for (const name of ["auth-profiles.json", "auth.json"]) {
        const relative = path.join(".openclaw", "agents", agent.name, "agent", name)
        if (
          linkCredentialFile(
            path.join(os.homedir(), relative),
            toHome,
            path.join("external", relative),
          )
        ) {
          inherited.push(`external/${relative}`)
        }
      }
    }
  } catch {
    // OpenClaw 是可选的。
  }
  return inherited
}

export async function waitForDaemonPidForTest(
  zunoHome: string,
  runtimeDir: string,
  timeoutMs?: number,
): Promise<number | undefined> {
  return waitForDaemonPid(zunoHome, runtimeDir, timeoutMs)
}

export function removeInstanceHomeForTest(home: string): void {
  removeInstanceHome(home)
}

/**
 * 启动私有 zuno 实例，待其 API socket 开始接受连接后返回。
 */
export async function launchInstance(options: LaunchOptions = {}): Promise<LaunchedInstance> {
  const binary = options.binary ?? (await ensureZunoBinary())
  const ephemeral = options.zunoHome === undefined
  const zunoHome =
    options.zunoHome ??
    fs.mkdtempSync(path.join(os.tmpdir(), "zuno-sdk-instance-"))
  fs.mkdirSync(zunoHome, { recursive: true, mode: 0o700 })

  // 运行时目录放 socket。把它放在实例 home 内部正是实例"私有"的原因：
  // daemon 把 socket 绑在这里而不是共享的 $XDG_RUNTIME_DIR，启动的实例
  // 和用户自己的 zuno 就不可能冲突或互相发现。
  const runtimeDir = path.join(zunoHome, "run")
  fs.mkdirSync(runtimeDir, { recursive: true, mode: 0o700 })
  const socketPath = path.join(runtimeDir, "zuno-api.sock")

  // 复用的 `zunoHome` 里可能还留着上一次运行的 socket 文件。启动循环
  // 等的是 API socket *出现*，残留的 socket 会让 launch() 对着一个
  // 没人监听的路径立即返回，然后第一个请求就以 ECONNREFUSED 失败。
  // 清掉它们是安全的：这个 home 上若还有活实例，就意味着两个 daemon
  // 共享一个状态目录，这本来就不被支持。
  for (const stale of ["zuno-api.sock", "zuno.sock", "zuno-debug.sock", "zuno.sock.hash"]) {
    try {
      fs.unlinkSync(path.join(runtimeDir, stale))
    } catch {
      // 不存在，这是新 home 的正常情况。
    }
  }

  if (options.inheritLogins ?? true) {
    inheritCredentials(userZunoHome(), zunoHome)
  }

  const child = spawn(
    binary,
    ["--no-update", "api-bridge", "--api-socket", socketPath],
    {
      cwd: options.workingDir ?? process.cwd(),
      env: {
        ...process.env,
        ZUNO_HOME: zunoHome,
        ZUNO_RUNTIME_DIR: runtimeDir,
        ZUNO_API_SOCKET: socketPath,
        ZUNO_SOCKET: path.join(runtimeDir, "zuno.sock"),
        // 私有子进程必须保持在启动它的二进制版本上。
        ZUNO_NO_AUTO_UPDATE: "1",
        ...options.env,
        ...(options.filesystem === undefined ? {} : {
          ZUNO_FILESYSTEM_POLICY: JSON.stringify(filesystemPolicyWire(options.filesystem)),
        }),
        ...(options.swarmModel === undefined
          ? {}
          : { ZUNO_SWARM_MODEL: options.swarmModel }),
        ...(options.wakeMode === undefined ? {} : { ZUNO_WAKE_MODE: options.wakeMode }),
      },
      stdio: ["ignore", "ignore", options.inheritStderr ? "inherit" : "pipe"],
      detached: false,
    },
  )

  // 保留 stderr 的末尾：启动失败时原因就在里面，只有一句"超时"会把
  // 调用方引向错误的方向。
  let stderr = ""
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr = (stderr + chunk.toString()).slice(-4000)
  })

  let exited: { code: number | null; signal: string | null } | undefined
  child.once("exit", (code, signal) => {
    exited = { code, signal }
  })

  // spawn 失败（zuno 未安装，这是最常见的首次运行问题）会在子进程上
  // 发出 "error"。Node 把没有监听者的 "error" 当作 child_process 深处
  // 抛出的致命异常，没有这段代码调用方根本捕获不到：进程带着一条
  // 裸 ENOENT 栈死掉，而不是被告知去安装 zuno。
  let spawnError: NodeJS.ErrnoException | undefined
  child.once("error", (error: NodeJS.ErrnoException) => {
    spawnError = error
    exited = { code: null, signal: null }
  })


  const shutdown = async (): Promise<void> => {
    // 从未启动成功的 spawn 没有 daemon 可停、也没什么可等。在这里跑
    // 完整的 shutdown 会把整个时间预算花在和一个不存在的 daemon 通信上，
    // 而本该负责清理的错误路径反而把实例 home 留了下来。
    if (spawnError) {
      if (ephemeral) removeInstanceHome(zunoHome)
      return
    }

    // 先停 daemon，*再*停 bridge，顺序不能反。
    //
    // 实例的 daemon 是 bridge 拉起的独立进程，杀掉 bridge 并不能停掉它：
    // 它会继续运行、继续往实例 home 写会话和缓存，活得比 close() 还久。
    // 要通过它自己的 socket 请它停止，而 daemon 一旦开始关闭，那个
    // socket 就消失了，所以如果在 bridge 死掉之后才做这件事，就会撞上
    // `server stop` 报"no running server found"的窗口，daemon 就此泄漏。
    await stopInstanceDaemon(zunoHome, runtimeDir)

    if (exited === undefined) {
      child.kill("SIGTERM")
      // 给它一点时间自行收场，再上强手段。
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          child.kill("SIGKILL")
          resolve()
        }, 3000)
        timer.unref?.()
        child.once("exit", () => {
          clearTimeout(timer)
          resolve()
        })
      })
    }

    if (ephemeral) {
      // 即使 daemon 已被要求停止，它先前启动的工作也可能在第一次删除
      // 之后才落盘：会话搜索索引器要写一个几 MB 的文件，那个写入几秒后
      // 才完成，会在一次成功的删除之后重建目录。所以删一次、看到为空
      // 什么都证明不了。要求 home 在一个安定窗口内保持不存在，并且
      // 重试足够久以耗过一次缓慢的刷写。
      const deadline = Date.now() + (options.cleanupTimeoutMs ?? 30_000)
      while (Date.now() < deadline) {
        removeInstanceHome(zunoHome)
        await new Promise((resolve) => setTimeout(resolve, 250))
        if (fs.existsSync(zunoHome)) continue
        await new Promise((resolve) => setTimeout(resolve, 750))
        if (!fs.existsSync(zunoHome)) return
      }
      // 超时了。泄漏一个临时目录远比 close() 永不返回问题小，
      // 但不应该悄无声息。
      if (fs.existsSync(zunoHome)) {
        process.emitWarning(
          `zuno 实例 home 仍有写入，无法移除：${zunoHome}`,
        )
      }
    }
  }

  // 消费方崩溃、或者干脆忘了 close()，否则 daemon 会永远跑下去：
  // 嵌入 zuno 的服务每重启一次就累积一个实例，每个都占着一个临时
  // 目录和一条模型连接。Node 在正常退出和未捕获异常后都会运行 "exit"
  // 处理器，除 SIGKILL 之外都能覆盖。
  const reapOnExit = () => {
    try {
      if (exited === undefined) child.kill("SIGTERM")
    } catch {
      // 已经退出了。
    }
    // daemon 调了 setsid()，自己是会话组长，任何瞄着 bridge 的信号都
    // 到不了它。只杀 bridge 正是这个处理器要防的泄漏。
    const pid = readDaemonPidSync(zunoHome, runtimeDir)
    if (pid !== undefined) {
      // 用 SIGKILL 而不是 SIGTERM：exit 处理器不能 await，没机会等
      // 优雅关闭；被 SIGTERM 的 daemon 在本进程消失时可能还在刷写，
      // 把下面正要删除的目录又建回来。
      try {
        // 负 pid：daemon 是进程组组长，辅助子进程一起带走。
        process.kill(-pid, "SIGKILL")
      } catch {
        try {
          process.kill(pid, "SIGKILL")
        } catch {
          // 已经退出了。
        }
      }
    }

    // 把 home 也删掉。只回收 daemon 的话每次崩溃还是会留下一个临时
    // 目录，对会重启的服务来说只是换了一种资源的无界增长。
    if (ephemeral) {
      try {
        removeInstanceHome(zunoHome)
      } catch {
        // 尽力而为：exit 处理器绝不能抛异常。
      }
    }
  }
  process.once("exit", reapOnExit)

  const deadline = Date.now() + (options.startupTimeoutMs ?? 30_000)
  while (Date.now() < deadline) {
    if (spawnError) {
      process.removeListener("exit", reapOnExit)
      await shutdown()
      const binaryName = binary
      throw new HarnessError(
        "zuno_not_found",
        spawnError.code === "ENOENT"
          ? `无法运行 \`${binaryName}\`：zuno 未安装。` +
          "SDK 会在首次使用时自动下载，你也可以从 " +
          "https://cnb.cool/zls_nmtx/sohaha/zuno 安装，或用 `binary` 传入完整路径。"
          : `无法运行 \`${binaryName}\`：${spawnError.message}`,
      )
    }
    if (exited) {
      process.removeListener("exit", reapOnExit)
      await shutdown()
      throw new HarnessError(
        "startup_failed",
        `zuno 在启动过程中退出（code ${exited.code}，signal ${exited.signal}）` +
        (stderr ? `:\n${stderr.trim()}` : ""),
      )
    }
    if (fs.existsSync(socketPath)) {
      return {
        socketPath,
        zunoHome,
        process: child,
        shutdown: async () => {
          process.removeListener("exit", reapOnExit)
          await shutdown()
        },
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 50))
  }

  process.removeListener("exit", reapOnExit)
  await shutdown()
  throw new HarnessError(
    "startup_timeout",
    `zuno 在启动超时时间内没有在 ${socketPath} 创建 API socket` +
    (stderr ? `:\n${stderr.trim()}` : ""),
  )
}
