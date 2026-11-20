package zuno

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"testing"
	"time"
)

func TestLaunchFilesystemRejectsOldRuntime(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("Unix socket 链接夹具")
	}
	for _, viaEnv := range []bool{false, true} {
		t.Run(fmt.Sprintf("env=%v", viaEnv), func(t *testing.T) {
			h := newMockHarness(t)
			dir := t.TempDir()
			binary := filepath.Join(dir, "runtime")
			if err := os.WriteFile(binary, []byte("#!/bin/sh\nln -s \"$MOCK_SOCKET\" \"$ZUNO_API_SOCKET\"\nexec sleep 30\n"), 0700); err != nil {
				t.Fatal(err)
			}
			no := false
			options := LaunchOptions{Binary: binary, ZunoHome: filepath.Join(dir, "home"), InheritLogins: &no, StartupTimeout: 2 * time.Second,
				Env: map[string]string{"MOCK_SOCKET": socketPathOf(h)}}
			if viaEnv {
				options.Env["ZUNO_FILESYSTEM_POLICY"] = `{"read_roots":[]}`
			} else {
				options.Filesystem = &FilesystemPolicy{}
			}
			client, err := LaunchAndConnect(context.Background(), options, ConnectOptions{})
			if client != nil {
				defer client.Close()
				t.Fatal("旧运行时不应返回客户端")
			}
			var sdkErr *HarnessError
			if !errors.As(err, &sdkErr) || sdkErr.Code != CodeUnsupported {
				t.Fatalf("预期unsupported，得到%v", err)
			}
		})
	}
}

func TestFilesystemPolicyWire(t *testing.T) {
	for _, p := range []FilesystemPolicy{{}, {ReadRoots: []string{}}, {ReadRoots: []string{"/readonly"}}} {
		raw, err := json.Marshal(p)
		if err != nil {
			t.Fatal(err)
		}
		if string(raw) == `{"read_roots":null}` {
			t.Fatal("空策略必须发送空数组")
		}
	}
}

func TestCreateSessionFilesystemCapabilityAndWire(t *testing.T) {
	h := newMockHarness(t)
	client, err := Connect(context.Background(), ConnectOptions{SocketPath: socketPathOf(h)})
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	if _, err := client.CreateSession(context.Background(), CreateSessionOptions{Filesystem: &FilesystemPolicy{}}); err == nil {
		t.Fatal("旧运行时必须拒绝策略")
	}
	h.mu.Lock()
	for _, request := range h.requests {
		if request["req"] == "create_session" {
			t.Fatal("门禁前不得发送创建请求")
		}
	}
	h.mu.Unlock()
	client.capabilities = append(client.capabilities, "filesystem_policy")
	if _, err := client.CreateSession(context.Background(), CreateSessionOptions{Filesystem: &FilesystemPolicy{}}); err != nil {
		t.Fatal(err)
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	for _, request := range h.requests {
		if request["req"] == "create_session" {
			raw, _ := json.Marshal(request["filesystem"])
			if string(raw) != `{"read_roots":[]}` {
				t.Fatalf("策略未正确发送：%s", raw)
			}
			return
		}
	}
	t.Fatal("未收到创建请求")
}

func TestLaunchFilesystemOverridesEnv(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("shell 夹具仅用于 Unix")
	}
	dir := t.TempDir()
	binary := filepath.Join(dir, "capture")
	captured := filepath.Join(dir, "policy.json")
	if err := os.WriteFile(binary, []byte("#!/bin/sh\nprintf '%s' \"$ZUNO_FILESYSTEM_POLICY\" > \"$CAPTURE_PATH\"\nexit 1\n"), 0700); err != nil {
		t.Fatal(err)
	}
	no := false
	t.Setenv("ZUNO_FILESYSTEM_POLICY", `{"read_roots":["/"]}`)
	_, err := Launch(context.Background(), LaunchOptions{Binary: binary, ZunoHome: filepath.Join(dir, "instance"), InheritLogins: &no,
		Filesystem: &FilesystemPolicy{}, StartupTimeout: 2 * time.Second,
		Env: map[string]string{"CAPTURE_PATH": captured, "ZUNO_FILESYSTEM_POLICY": `{"read_roots":["/"]}`}})
	if err == nil {
		t.Fatal("夹具应退出")
	}
	raw, err := os.ReadFile(captured)
	if err != nil {
		t.Fatal(err)
	}
	if string(raw) != `{"read_roots":[]}` {
		t.Fatalf("环境变量扩大策略：%s", raw)
	}
}
