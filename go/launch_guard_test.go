package zuno

import (
	"os"
	"path/filepath"
	"testing"
)

// InheritCredentials 与 removeInstanceHome 的破坏性/安全原语测试。
// 这些护栏一旦回归，后果是删掉用户的真实凭据或把 token 复制成
// 集群可读副本，所以值得钉死。

func TestInheritCredentialsSymlinksSharedFiles(t *testing.T) {
	userHome := t.TempDir()
	instanceHome := t.TempDir()
	// 隔离外部凭据来源：$HOME 只剩本测试的文件，配置目录为空。
	t.Setenv("HOME", userHome)
	t.Setenv("ZUNO_APP_CONFIG_DIR", filepath.Join(userHome, "appconfig"))

	// 共享文件应是符号链接，副本文件应是真实文件。
	if err := os.WriteFile(filepath.Join(userHome, "auth.json"), []byte("token"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(userHome, "config.toml"), []byte("[log]"), 0o600); err != nil {
		t.Fatal(err)
	}

	inherited, err := InheritCredentials(userHome, instanceHome)
	if err != nil {
		t.Fatal(err)
	}
	if len(inherited) != 2 {
		t.Fatalf("应继承 2 个文件，得到 %v", inherited)
	}

	linkInfo, err := os.Lstat(filepath.Join(instanceHome, "auth.json"))
	if err != nil {
		t.Fatal(err)
	}
	if linkInfo.Mode()&os.ModeSymlink == 0 {
		t.Fatal("auth.json 应是符号链接（共享 token 轮转记录）")
	}

	copyInfo, err := os.Lstat(filepath.Join(instanceHome, "config.toml"))
	if err != nil {
		t.Fatal(err)
	}
	if copyInfo.Mode()&os.ModeSymlink != 0 {
		t.Fatal("config.toml 应是副本，不是链接（实例要能改自己的配置）")
	}
	if perm := copyInfo.Mode().Perm(); perm != 0o600 {
		t.Fatalf("副本权限应归一化为 0600，得到 %o", perm)
	}
}

func TestInheritCredentialsRejectsSameHome(t *testing.T) {
	home := t.TempDir()
	if _, err := InheritCredentials(home, home); err == nil {
		t.Fatal("实例 home 与用户 home 相同时应拒绝")
	}
}

func TestInheritCredentialsRejectsSymlinkHome(t *testing.T) {
	real := t.TempDir()
	link := filepath.Join(t.TempDir(), "link")
	if err := os.Symlink(real, link); err != nil {
		t.Fatal(err)
	}
	if _, err := InheritCredentials(real, link); err == nil {
		t.Fatal("实例 home 是符号链接时应拒绝（清理不得沿链接进入用户目录）")
	}
}

func TestInheritCredentialsCopiesEnvFiles(t *testing.T) {
	// provider env 文件来自平台配置目录，链接为文件而非目录。
	userHome := t.TempDir()
	instanceHome := t.TempDir()

	t.Setenv("HOME", userHome)
	appConfig := filepath.Join(userHome, "appconfig")
	t.Setenv("ZUNO_APP_CONFIG_DIR", appConfig)
	envDir := appConfig
	if err := os.MkdirAll(envDir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(envDir, "anthropic.env"), []byte("KEY=x"), 0o600); err != nil {
		t.Fatal(err)
	}

	inherited, err := InheritCredentials(userHome, instanceHome)
	if err != nil {
		t.Fatal(err)
	}
	found := false
	for _, name := range inherited {
		if name == "config/zuno/anthropic.env" {
			found = true
		}
	}
	if !found {
		t.Fatalf("应继承 provider env 文件，得到 %v", inherited)
	}
	linkInfo, err := os.Lstat(filepath.Join(instanceHome, "config", "zuno", "anthropic.env"))
	if err != nil {
		t.Fatal(err)
	}
	if linkInfo.Mode()&os.ModeSymlink == 0 {
		t.Fatal("env 文件应是符号链接（缓存与用量数据不继承）")
	}
}

func TestRemoveInstanceHomeRefusesOutsideTemp(t *testing.T) {
	// 护栏：只有本模块创建的临时 home 才允许递归清理。
	outside := filepath.Join(t.TempDir(), "zuno-sdk-instance-evil")
	if err := os.MkdirAll(outside, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(outside, "secret"), []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	removeInstanceHome(outside)
	if _, err := os.Stat(outside); err != nil {
		t.Fatal("临时目录之外的路径必须原样保留")
	}
}

func TestRemoveInstanceHomeUnlinksButNeverFollowsSymlinks(t *testing.T) {
	tempRoot := os.TempDir()
	realDir := filepath.Join(t.TempDir(), "real-credentials")
	if err := os.MkdirAll(realDir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(realDir, "auth.json"), []byte("token"), 0o600); err != nil {
		t.Fatal(err)
	}

	home := filepath.Join(tempRoot, "zuno-sdk-instance-test-home")
	if err := os.MkdirAll(home, 0o700); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(home) })

	// 目录链接：必须被解除而不是被进入。
	dirLink := filepath.Join(home, "linked-dir")
	if err := os.Symlink(realDir, dirLink); err != nil {
		t.Fatal(err)
	}
	// 目录链接下的文件：walkDelete 绝不能进入，用户凭据必须幸存。
	if err := os.WriteFile(filepath.Join(realDir, "keep.json"), []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	// 文件链接：解除即可。
	fileLink := filepath.Join(home, "auth.json")
	if err := os.Symlink(filepath.Join(realDir, "keep.json"), fileLink); err != nil {
		t.Fatal(err)
	}
	// 普通文件与子目录：正常删除。
	if err := os.WriteFile(filepath.Join(home, "session.json"), []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	sub := filepath.Join(home, "sub")
	if err := os.MkdirAll(sub, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(sub, "log"), []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}

	removeInstanceHome(home)

	if _, err := os.Stat(filepath.Join(realDir, "keep.json")); err != nil {
		t.Fatal("目录链接指向的用户文件不得被删除")
	}
	if _, err := os.Lstat(dirLink); !os.IsNotExist(err) {
		t.Log("目录链接未被解除（可能已被清理），忽略")
	}
	if _, err := os.Stat(home); !os.IsNotExist(err) {
		t.Fatal("临时 home 应被清空删除")
	}
}

func TestTailBufferKeepsOnlyTail(t *testing.T) {
	tb := newTailBuffer(16)
	for i := 0; i < 100; i++ {
		_, _ = tb.Write([]byte("0123456789"))
	}
	if got := len(tb.buf); got > 16 {
		t.Fatalf("缓冲应封顶在 %d，得到 %d", 16, got)
	}
	out := tb.String()
	if out == "" || len(out) > 16 {
		t.Fatalf("尾部内容异常: %q", out)
	}
	// nil 接收方安全。
	var nilBuf *tailBuffer
	if nilBuf.String() != "" {
		t.Fatal("nil tailBuffer 应返回空串")
	}
}
