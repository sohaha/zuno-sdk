package zuno

import (
	"crypto/sha256"
	"encoding/hex"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"

	"github.com/sohaha/zlsgo/zutil"
)

// socket 路径解析，与 zuno-harness-api::sockets 一一对应。
//
// bridge 和每个客户端必须解析出同一个目录，否则无法连接，
// 所以这里的规则严格跟随 Rust 模块。

var sanitizePattern = regexp.MustCompile(`[^A-Za-z0-9\-_]`)

// RuntimeDir 返回存放 daemon 与 API socket 的运行时目录。
func RuntimeDir() string {
	if v := os.Getenv("ZUNO_RUNTIME_DIR"); v != "" {
		return v
	}
	if v := os.Getenv("XDG_RUNTIME_DIR"); v != "" {
		return v
	}
	if runtime.GOOS == "darwin" {
		if v := os.Getenv("TMPDIR"); v != "" {
			return v
		}
	}
	return filepath.Join(os.TempDir(), "zuno-"+userDiscriminator())
}

func userDiscriminator() string {
	var raw string
	if runtime.GOOS == "windows" {
		raw = firstNonEmpty(os.Getenv("USERNAME"), os.Getenv("USER"))
	} else {
		raw = firstNonEmpty(os.Getenv("UID"), os.Getenv("USER"))
	}
	return sanitize(raw)
}

func sanitize(raw string) string {
	out := sanitizePattern.ReplaceAllString(raw, "")
	if len(out) > 64 {
		out = out[:64]
	}
	if out == "" {
		return "user"
	}
	return out
}

// TransportEndpoint 给定 socket 路径时 SDK 实际拨号的端点。
//
// 在 Unix 上就是路径本身。Windows 上没有 socket 文件：bridge 发布一个
// 由该路径派生出的命名管道，直接按路径拨号什么都找不到。这里的派生规则
// 与 zuno-transport 完全一致，两侧的测试把它们钉在一起。
func TransportEndpoint(socketPath string) string {
	if runtime.GOOS != "windows" {
		return socketPath
	}
	// 规则与 Rust 侧相同：保留可读的词干便于诊断，再加一段归一化路径的
	// 哈希，保证两个不同的路径永远不会撞名。
	// sanitize 的保留集合与 TS 的 /[A-Za-z0-9\-_]/g 提取一致；
	// TS 用的是 path.parse().name（去掉扩展名），这里对齐。
	base := filepath.Base(socketPath)
	name := strings.TrimSuffix(base, filepath.Ext(base))
	if name == "" {
		name = base
	}
	stem := sanitize(name)
	if len(stem) > 32 {
		stem = stem[:32]
	}
	if stem == "" {
		stem = "zuno"
	}
	normalized := filepath.ToSlash(socketPath)
	// 与 TS/Rust 一致：统一小写再哈希。
	lowered := make([]byte, 0, len(normalized))
	for i := 0; i < len(normalized); i++ {
		c := normalized[i]
		if c >= 'A' && c <= 'Z' {
			c += 32
		}
		lowered = append(lowered, c)
	}
	sum := sha256.Sum256(lowered)
	return `\\.\pipe\` + stem + "-" + hex.EncodeToString(sum[:])[:16]
}

// APISocketPath 返回带版本的 harness API socket 路径。
// ZUNO_API_SOCKET 可覆盖。
func APISocketPath() string {
	if v := os.Getenv("ZUNO_API_SOCKET"); v != "" {
		return v
	}
	return filepath.Join(RuntimeDir(), "zuno-api.sock")
}

// LegacySocketPath 返回内部 daemon socket 路径。ZUNO_SOCKET 可覆盖。
func LegacySocketPath() string {
	if v := os.Getenv("ZUNO_SOCKET"); v != "" {
		return v
	}
	return filepath.Join(RuntimeDir(), "zuno.sock")
}

// UserZunoHome 返回用户真实的 zuno home，忽略实例级覆盖。
func UserZunoHome() string {
	if v := os.Getenv("ZUNO_HOME"); v != "" {
		return v
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return filepath.Join("/tmp", ".zuno")
	}
	return filepath.Join(home, ".zuno")
}

// UserAppConfigDir 返回用户的 zuno 配置目录，与 storage::app_config_dir 对应。
// ZUNO_APP_CONFIG_DIR 可覆盖（测试隔离与重定向用）。
func UserAppConfigDir() string {
	if v := os.Getenv("ZUNO_APP_CONFIG_DIR"); v != "" {
		return v
	}
	const dirname = "zuno"
	switch runtime.GOOS {
	case "darwin":
		home, _ := os.UserHomeDir()
		return filepath.Join(home, "Library", "Application Support", dirname)
	case "windows":
		appData := zutil.Getenv("APPDATA")
		if appData == "" {
			home, _ := os.UserHomeDir()
			appData = filepath.Join(home, "AppData", "Roaming")
		}
		return filepath.Join(appData, dirname)
	default:
		if v := os.Getenv("XDG_CONFIG_HOME"); v != "" {
			return filepath.Join(v, dirname)
		}
		home, _ := os.UserHomeDir()
		return filepath.Join(home, ".config", dirname)
	}
}

func firstNonEmpty(values ...string) string {
	for _, v := range values {
		if v != "" {
			return v
		}
	}
	return ""
}
