package zuno

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	"github.com/sohaha/zlsgo/zfile"
)

// 启动私有 zuno 实例。
//
// Connect() 附着到机器上已在运行的 zuno——这对自动化你自己的 zuno 的
// 工具（编辑器插件、仪表盘）是合适的，对其他场景则不然。把 zuno 嵌入为
// agent 引擎的应用需要自己的实例：自己的会话、自己的状态，以及不会
// 意外干扰用户正在进行的会话。
//
// Launch 提供一个实例。它在专用的 ZUNO_HOME 和运行时目录下启动私有
// daemon 和 bridge，并在 Shutdown 时将其关闭。

// credentialFiles 是继承登录态时从用户的 zuno home 继承的文件。
//
// 有意不包含 auth-refresh-state.json 和 auth-validation.json，
// 它们是历史认证失败的派生记录。复制它们会把另一个 zuno 的坏日子带进来，
// 过期的 rejected_refresh_fingerprint 会让新实例即使拿着可用的凭据
// 也拒绝尝试刷新。
var credentialFiles = []string{
	"auth.json",
	"openai-auth.json",
	"antigravity_oauth.json",
	"gemini_oauth.json",
	"google_oauth.json",
	"google_credentials.json",
	"config.toml",
}

// sharedFiles 是必须与用户的 home 共享而非复制的凭据。
//
// OAuth refresh token 会轮转：兑换一次就会签发新的并使旧的失效。
// 两个 home 各持同一 token 的副本就会互相打架，后刷新的那个会被登出。
var sharedFiles = func() map[string]bool {
	set := map[string]bool{}
	for _, name := range credentialFiles {
		if name != "config.toml" {
			set[name] = true
		}
	}
	return set
}()

// externalCredentialFiles 是 zuno 查找其他工具凭据的位置，相对于 $HOME。
//
// zuno 可以复用已有 CLI 的 OAuth 存储来登录，因此大量真实用户根本没有
// 可用的 ~/.zuno/auth.json：可用的凭据在 ~/.claude/ 或
// ~/.config/github-copilot/ 下的文件里。
var externalCredentialFiles = []string{
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
}

// appConfigDirname 是 zuno 自己的配置目录名，相对于平台配置根目录。
const appConfigDirname = "zuno"

// WakeMode 决定由谁执行自主唤醒请求。
type WakeMode string

// 唤醒模式。
const (
	WakeModeInternal WakeMode = "internal"
	WakeModeExternal WakeMode = "external"
)

// LaunchOptions 描述启动私有实例的参数。
type LaunchOptions struct {
	// ZunoHome 是存放实例状态（会话、日志、凭据）的目录。
	//
	// 默认为新建的临时目录，Shutdown 时移除。
	// 传固定路径可跨运行保留会话。
	ZunoHome string
	// WorkingDir 是此实例中创建的会话的工作目录。
	WorkingDir string
	// InheritLogins 与实例共享用户的 provider 登录态。默认 true。
	//
	// 没有凭据的新实例无法访问任何模型，所以默认是可用的那个。
	// 但这也意味着嵌入的应用会消耗用户的 provider 配额，
	// 传 false 可空启动并自行提供凭据。
	InheritLogins *bool
	// Binary 是 zuno 二进制路径。默认为下载缓存的运行时，其次是 PATH 上的 zuno。
	Binary string
	// Env 是传给实例的额外环境变量。
	Env map[string]string
	// SwarmModel 是派生 swarm worker 的默认模型，除非每次派生时单独覆盖。
	// 用 "inherit" 表示沿用协调者的模型和鉴权路由。
	SwarmModel string
	// WakeMode 决定由谁执行自主唤醒请求。
	WakeMode WakeMode
	// StartupTimeout 是等待 socket 出现的时间。默认 30s。
	StartupTimeout time.Duration
	// InheritStderr 把实例的 stderr 转发到本进程的 stderr。默认 false。
	InheritStderr bool
	// CleanupTimeout 是 Shutdown 移除临时实例 home 的时间上限。
	//
	// 关闭前已启动的后台工作可能在 daemon 被要求停止后仍写入数秒，
	// 在删除之后又重建目录。默认 30s。
	CleanupTimeout time.Duration
}

// LaunchedInstance 是一个运行中的私有 zuno 实例。
type LaunchedInstance struct {
	// SocketPath 是要连接的 API socket 路径。
	SocketPath string
	// ZunoHome 是实例的 ZUNO_HOME。
	ZunoHome string
	// RuntimeDir 是实例的运行时目录。
	RuntimeDir string
	// cmd 是 bridge 进程。
	cmd *exec.Cmd
	// options 是启动参数的副本。
	options LaunchOptions
	// ephemeral 表示 home 是临时的，关闭时删除。
	ephemeral bool
	// exited 标记 bridge 进程是否已退出。
	exited chan struct{}
	// stderrTail 保留 bridge stderr 的尾部，启动失败时附进错误。
	stderrTail *tailBuffer
}

// DefaultLauncherOptions 返回 InheritLogins 默认值。
func (o LaunchOptions) inheritLogins() bool {
	return o.InheritLogins == nil || *o.InheritLogins
}

// Launch 启动私有 zuno 实例，待其 API socket 开始接受连接后返回。
func Launch(ctx context.Context, options LaunchOptions) (*LaunchedInstance, error) {
	binary := options.Binary
	if binary == "" {
		var err error
		binary, err = EnsureZunoBinary(ctx)
		if err != nil {
			return nil, err
		}
	}
	ephemeral := options.ZunoHome == ""
	zunoHome := options.ZunoHome
	if zunoHome == "" {
		dir, err := os.MkdirTemp("", "zuno-sdk-instance-")
		if err != nil {
			return nil, wrapError("instance_home_failed", "无法创建临时实例 home", err)
		}
		zunoHome = dir
	}
	if err := os.MkdirAll(zunoHome, 0o700); err != nil {
		return nil, wrapError("instance_home_failed", "无法创建实例 home", err)
	}

	// 运行时目录放 socket。把它放在实例 home 内部正是实例"私有"的原因：
	// daemon 把 socket 绑在这里而不是共享的 $XDG_RUNTIME_DIR，启动的实例
	// 和用户自己的 zuno 就不可能冲突或互相发现。
	runtimeDir := filepath.Join(zunoHome, "run")
	if err := os.MkdirAll(runtimeDir, 0o700); err != nil {
		return nil, wrapError("instance_home_failed", "无法创建运行时目录", err)
	}
	socketPath := filepath.Join(runtimeDir, "zuno-api.sock")

	// 复用的 zunoHome 里可能还留着上一次运行的 socket 文件。启动循环
	// 等的是 API socket 出现，残留的 socket 会让 Launch 对着一个
	// 没人监听的路径立即返回，然后第一个请求就以连接失败告终。
	for _, stale := range []string{"zuno-api.sock", "zuno.sock", "zuno-debug.sock", "zuno.sock.hash"} {
		_ = os.Remove(filepath.Join(runtimeDir, stale))
	}

	if options.inheritLogins() {
		if _, err := InheritCredentials(UserZunoHome(), zunoHome); err != nil {
			if ephemeral {
				removeInstanceHome(zunoHome)
			}
			return nil, err
		}
	}

	var stderrTail *tailBuffer
	env := os.Environ()
	setEnv := func(key, value string) {
		env = append(env, key+"="+value)
	}
	setEnv("ZUNO_HOME", zunoHome)
	setEnv("ZUNO_RUNTIME_DIR", runtimeDir)
	setEnv("ZUNO_API_SOCKET", socketPath)
	setEnv("ZUNO_SOCKET", filepath.Join(runtimeDir, "zuno.sock"))
	// 私有子进程必须保持在启动它的二进制版本上。
	setEnv("ZUNO_NO_AUTO_UPDATE", "1")
	if options.SwarmModel != "" {
		setEnv("ZUNO_SWARM_MODEL", options.SwarmModel)
	}
	if options.WakeMode != "" {
		setEnv("ZUNO_WAKE_MODE", string(options.WakeMode))
	}
	for k, v := range options.Env {
		setEnv(k, v)
	}

	cmd := exec.Command(binary, "--no-update", "api-bridge", "--api-socket", socketPath)
	cmd.Dir = options.WorkingDir
	cmd.Env = env
	if options.InheritStderr {
		cmd.Stderr = os.Stderr
	} else {
		// 保留 stderr 的尾部：启动失败时原因就在里面，只有一句"超时"
		// 会把调用方引向错误的方向。
		stderrTail = newTailBuffer(8 * 1024)
		cmd.Stderr = stderrTail
	}
	if err := cmd.Start(); err != nil {
		if ephemeral {
			removeInstanceHome(zunoHome)
		}
		if isNotFound(err) {
			return nil, newError("zuno_not_found",
				fmt.Sprintf("无法运行 `%s`：zuno 未安装。SDK 会在首次使用时自动下载，"+
					"你也可以用 LaunchOptions.Binary 传入完整路径。", binary))
		}
		return nil, wrapError("startup_failed", "无法启动 zuno bridge", err)
	}

	instance := &LaunchedInstance{
		SocketPath: socketPath,
		ZunoHome:   zunoHome,
		RuntimeDir: runtimeDir,
		cmd:        cmd,
		options:    options,
		ephemeral:  ephemeral,
		exited:     make(chan struct{}),
		stderrTail: stderrTail,
	}
	go func() {
		_ = cmd.Wait()
		close(instance.exited)
	}()

	startupTimeout := options.StartupTimeout
	if startupTimeout == 0 {
		startupTimeout = 30 * time.Second
	}
	deadline := time.Now().Add(startupTimeout)
	for {
		select {
		case <-instance.exited:
			instance.shutdownProcess()
			return nil, newError("startup_failed",
				fmt.Sprintf("zuno 在启动过程中退出（pid %d）:\n%s",
					cmd.Process.Pid, instance.stderrTail.String()))
		case <-time.After(50 * time.Millisecond):
		}
		if zfile.FileExist(socketPath) {
			return instance, nil
		}
		if time.Now().After(deadline) {
			instance.Shutdown(context.Background())
			return nil, newError("startup_timeout",
				fmt.Sprintf("zuno 在启动超时时间内没有在 %s 创建 API socket:\n%s",
					socketPath, instance.stderrTail.String()))
		}
	}
}

// LaunchAndConnect 启动私有实例并连接它。
//
// 这是把 zuno 嵌入为 agent 引擎的入口。实例有自己的状态目录、
// 自己的会话和自己的 socket，看不到也不会干扰用户交互运行的 zuno。
// Close() 会将其关闭。
func LaunchAndConnect(ctx context.Context, options LaunchOptions, connect ConnectOptions) (*Client, error) {
	instance, err := Launch(ctx, options)
	if err != nil {
		return nil, err
	}
	connect.SocketPath = instance.SocketPath
	client, err := Connect(ctx, connect)
	if err != nil {
		// 客户端始终没连上的已启动实例是一个占着临时目录的流浪 daemon，
		// 重新抛出前先拆掉它。
		_ = instance.Shutdown(context.Background())
		return nil, err
	}
	client.instance = instance
	return client, nil
}

// Shutdown 停止实例并清理它创建的一切。
func (l *LaunchedInstance) Shutdown(ctx context.Context) error {
	// 先停 daemon，再停 bridge，顺序不能反。
	//
	// 实例的 daemon 是 bridge 拉起的独立进程，杀掉 bridge 并不能停掉它：
	// 它会继续运行、继续往实例 home 写会话和缓存，活得比 Shutdown 还久。
	stopInstanceDaemon(l.ZunoHome, l.RuntimeDir)

	l.shutdownProcess()

	if l.ephemeral {
		cleanupTimeout := l.options.CleanupTimeout
		if cleanupTimeout == 0 {
			cleanupTimeout = 30 * time.Second
		}
		deadline := time.Now().Add(cleanupTimeout)
		for time.Now().Before(deadline) {
			removeInstanceHome(l.ZunoHome)
			time.Sleep(250 * time.Millisecond)
			if zfile.DirExist(l.ZunoHome) {
				continue
			}
			time.Sleep(750 * time.Millisecond)
			if !zfile.DirExist(l.ZunoHome) {
				return nil
			}
		}
		if zfile.DirExist(l.ZunoHome) {
			// 泄漏一个临时目录远比 Shutdown 永不返回问题小，但不应该悄无声息。
			fmt.Fprintf(os.Stderr, "zuno 实例 home 仍有写入，无法移除：%s\n", l.ZunoHome)
		}
	}
	return nil
}

func (l *LaunchedInstance) shutdownProcess() {
	select {
	case <-l.exited:
		return // bridge 已退出
	default:
	}
	_ = l.cmd.Process.Kill()
	select {
	case <-l.exited:
	case <-time.After(3 * time.Second):
		_ = l.cmd.Process.Kill()
	}
}

func isNotFound(err error) bool {
	if _, ok := err.(*exec.Error); ok {
		return true
	}
	return err != nil && strings.Contains(err.Error(), "executable file not found")
}

// InheritCredentials 把用户的 provider 登录态交给启动的实例。
//
// 凭据文件用符号链接共享，token 轮转才能保持一致；
// 其他文件复制，让实例可以修改自己的配置而不动用户的。副本仅属主可访问。
//
// 返回实际继承到的名字列表，让调用方能区分"什么都没继承"和"继承到了东西"。
func InheritCredentials(fromHome, toHome string) ([]string, error) {
	if err := os.MkdirAll(toHome, 0o700); err != nil {
		return nil, wrapError("invalid_instance_home", "无法创建实例 home", err)
	}
	if info, err := os.Lstat(toHome); err != nil {
		return nil, wrapError("invalid_instance_home", "无法读取实例 home", err)
	} else if info.Mode()&os.ModeSymlink != 0 || !info.IsDir() {
		return nil, newError("invalid_instance_home", "实例 home 必须是真实目录，不能是链接或文件："+toHome)
	}
	if samePath(fromHome, toHome) {
		return nil, newError("invalid_instance_home", "实例 home 必须与用户的 zuno home 不同")
	}

	var inherited []string
	for _, name := range credentialFiles {
		source := filepath.Join(fromHome, name)
		if !zfile.FileExist(source) {
			continue
		}
		destination := filepath.Join(toHome, name)
		if sharedFiles[name] {
			// 复用的 zunoHome 里已有这些链接，而 symlink 遇到 EEXIST
			// 会抛错而不是替换。重新链接还能修正上一次运行留下的过期链接。
			_ = os.Remove(destination)
			if err := os.Symlink(source, destination); err != nil {
				continue
			}
		} else {
			if err := copyFileMode(source, destination, 0o600); err != nil {
				continue
			}
		}
		inherited = append(inherited, name)
	}

	// zuno 的 provider env 文件在它的平台配置目录里，ZUNO_HOME 会把它
	// 移到 $ZUNO_HOME/config/zuno。只链接 env 文件：缓存和用量数据
	// 不是凭据，必须保持实例私有。最重要的是永远不要链接目录本身。
	userConfig := UserAppConfigDir()
	if entries, err := os.ReadDir(userConfig); err == nil {
		for _, entry := range entries {
			name := entry.Name()
			if !strings.HasSuffix(name, ".env") {
				continue
			}
			if entry.IsDir() {
				continue
			}
			relative := filepath.Join("config", appConfigDirname, name)
			if linkCredentialFile(filepath.Join(userConfig, name), toHome, relative) {
				inherited = append(inherited, relative)
			}
		}
	}

	// 其他 CLI 的凭据存储，zuno 直接读取它们，ZUNO_HOME 会把它们
	// 重定向到 $ZUNO_HOME/external/。只共享确切的凭据文件。
	home, _ := os.UserHomeDir()
	for _, relative := range externalCredentialFiles {
		source := filepath.Join(home, fromSlash(relative))
		instanceRelative := filepath.Join("external", fromSlash(relative))
		if linkCredentialFile(source, toHome, instanceRelative) {
			inherited = append(inherited, "external/"+relative)
		}
	}

	// OpenClaw 当前的存储是按 agent 划分的。枚举一层 agent ID，
	// 然后只链接它的加载器认得的两个凭据文件名。
	openclawAgents := filepath.Join(home, ".openclaw", "agents")
	if entries, err := os.ReadDir(openclawAgents); err == nil {
		for _, agent := range entries {
			if !agent.IsDir() {
				continue
			}
			for _, name := range []string{"auth-profiles.json", "auth.json"} {
				relative := filepath.Join(".openclaw", "agents", agent.Name(), "agent", name)
				if linkCredentialFile(filepath.Join(home, fromSlash(relative)), toHome, filepath.Join("external", relative)) {
					inherited = append(inherited, "external/"+relative)
				}
			}
		}
	}
	return inherited, nil
}

// tailBuffer 是只保留尾部字节的写入器，防止长跑实例的 stderr 无界增长。
type tailBuffer struct {
	buf []byte
	max int
}

func newTailBuffer(max int) *tailBuffer {
	return &tailBuffer{max: max}
}

func (t *tailBuffer) Write(p []byte) (int, error) {
	t.buf = append(t.buf, p...)
	if len(t.buf) > t.max {
		t.buf = append([]byte(nil), t.buf[len(t.buf)-t.max:]...)
	}
	return len(p), nil
}

// String 返回保留的尾部（去除尾部空白）。
func (t *tailBuffer) String() string {
	if t == nil || len(t.buf) == 0 {
		return ""
	}
	return strings.TrimSpace(string(t.buf))
}

// fromSlash 把 / 分隔的相对路径转换为平台路径。
func fromSlash(p string) string {
	if runtime.GOOS == "windows" {
		return strings.ReplaceAll(p, "/", string(filepath.Separator))
	}
	return p
}

// copyFileMode 复制文件并强制指定权限。凭据副本仅属主可访问，
// 与 TypeScript SDK 的 copyFileSync + chmod(0o600) 行为一致。
// 主体复制复用 zfile.CopyFile（流式复制），再归一化权限。
func copyFileMode(source, destination string, mode os.FileMode) error {
	if err := zfile.CopyFile(source, destination); err != nil {
		return err
	}
	return os.Chmod(destination, mode)
}

// linkCredentialFile 把实例内的一个相对路径替换为指向单个凭据文件的链接。
func linkCredentialFile(source, root, relative string) bool {
	if !zfile.FileExist(source) {
		return false
	}
	parent := filepath.Dir(filepath.Join(root, relative))
	if err := os.MkdirAll(parent, 0o700); err != nil {
		return false
	}
	destination := filepath.Join(root, relative)
	_ = os.Remove(destination)
	if err := os.Symlink(source, destination); err != nil {
		return false
	}
	return true
}

// serversRegistry 是实例 $ZUNO_HOME/servers.json 的形状。
type serversRegistry map[string]struct {
	Socket string `json:"socket"`
	PID    int    `json:"pid"`
}

// readDaemonPid 从实例自己的 server 注册表读取服务该实例的 daemon pid。
//
// zuno 把每个 server 记录在 $ZUNO_HOME/servers.json，以 socket 路径为键，
// 而实例的注册表只列该实例自己的 daemon，所以这里永远不可能解析到
// 用户自己运行的 server。
func readDaemonPid(zunoHome, runtimeDir string) (int, bool) {
	data, err := os.ReadFile(filepath.Join(zunoHome, "servers.json"))
	if err != nil {
		return 0, false
	}
	var registry serversRegistry
	if json.Unmarshal(data, &registry) != nil {
		return 0, false
	}
	socket := filepath.Join(runtimeDir, "zuno.sock")
	for _, entry := range registry {
		if entry.Socket == socket && entry.PID > 1 {
			return entry.PID, true
		}
	}
	return 0, false
}

// stopInstanceDaemon 停止实例的 daemon 并等它真正退出。
//
// pid 来自实例自己的 servers.json，而不是 `zuno server stop`：为了从
// JSON 文件里读个 pid 再起一个 zuno 进程要花五秒的启动开销。
// 注册表按本实例的 socket 路径限定范围，所以这里永远不可能向用户
// 正在运行的 server 发信号。
func stopInstanceDaemon(zunoHome, runtimeDir string) {
	// API socket 可能恰好在 daemon 写入 servers.json 条目之前就能连上。
	// Shutdown 因而可能落在这段很小的启动窗口里，所以不能在读一次
	// 注册表没有结果后就静默放弃。
	var pid int
	deadline := time.Now().Add(2 * time.Second)
	for {
		if p, ok := readDaemonPid(zunoHome, runtimeDir); ok {
			pid = p
			break
		}
		if time.Now().After(deadline) {
			return
		}
		time.Sleep(50 * time.Millisecond)
	}

	signal := func(kill bool) {
		killProcess(pid, kill)
	}

	signal(false)

	// 等它干净退出，但不等太久。daemon 自己的关闭流程会做后台工作
	// （比如刷写一个几 MB 的搜索索引），可能花十五秒。那里面没有什么
	// 值得保留的：实例是临时的、马上要被删除，所以给一个短暂的优雅
	// 窗口然后强杀，既快又可预期。
	grace := time.Now().Add(2 * time.Second)
	for time.Now().Before(grace) {
		if !processExists(pid) {
			return
		}
		time.Sleep(50 * time.Millisecond)
	}

	signal(true)

	// 强杀不是瞬时的：内核仍要拆除进程，在进程消失之前就返回会和
	// 随后的删除形成竞态。
	hard := time.Now().Add(5 * time.Second)
	for time.Now().Before(hard) {
		if !processExists(pid) {
			return
		}
		time.Sleep(50 * time.Millisecond)
	}
}

// processExists 判断 pid 仍是存活进程。
func processExists(pid int) bool {
	return processAlive(pid)
}
