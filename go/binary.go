package zuno

import (
	"archive/zip"
	"context"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"

	"github.com/sohaha/zlsgo/zfile"
	"github.com/sohaha/zlsgo/zhttp"
	"github.com/sohaha/zlsgo/zutil"
)

// 二进制下载与 scripts/install.sh 同源：取 `$BASE_URL/latest.json`，
// 按 Rust target triple 下载 `zuno-v<version>-<target>.zip`，
// 解压出 zuno 缓存到 `~/.zuno/sdk/<platform>-<arch>/`。
// ZUNO_RELEASE_BASE 可覆盖基地址，ZUNO_VERSION 可锁定版本。

// targetTriple 是发布资产命名用的 Rust target triple。
var targetTriple = map[string]string{
	"linux-x64":     "x86_64-unknown-linux-gnu",
	"linux-arm64":   "aarch64-unknown-linux-gnu",
	"darwin-x64":    "x86_64-apple-darwin",
	"darwin-arm64":  "aarch64-apple-darwin",
	"windows-x64":   "x86_64-pc-windows-msvc",
	"windows-arm64": "aarch64-pc-windows-msvc",
}

// ReleaseTarget 返回本机对应的 Rust target triple。
func ReleaseTarget() string {
	return targetTriple[platformKey(runtime.GOOS, runtime.GOARCH)]
}

func platformKey(goos, arch string) string {
	switch arch {
	case "amd64":
		arch = "x64"
	case "arm64":
		arch = "arm64"
	default:
		return goos + "-" + arch
	}
	return goos + "-" + arch
}

func binaryName() string {
	if runtime.GOOS == "windows" {
		return "zuno.exe"
	}
	return "zuno"
}

func cachedBinaryPath() string {
	home := UserZunoHome()
	return filepath.Join(home, "sdk", platformKey(runtime.GOOS, runtime.GOARCH), binaryName())
}

// CachedZunoBinary 返回已下载缓存的 zuno 路径（可执行才返回）。
func CachedZunoBinary() string {
	p := cachedBinaryPath()
	info, err := os.Stat(p)
	if err != nil || info.IsDir() || info.Mode()&0o111 == 0 {
		return ""
	}
	return p
}

// EnsureZunoBinary 确保 zuno 可用，必要时下载。
// 顺序：ZUNO_BINARY → 下载缓存 → PATH → 发布服务器。
func EnsureZunoBinary(ctx context.Context) (string, error) {
	if v := zutil.Getenv("ZUNO_BINARY"); v != "" {
		return v, nil
	}
	if cached := CachedZunoBinary(); cached != "" {
		return cached, nil
	}
	if path, err := exec.LookPath("zuno"); err == nil {
		return path, nil
	}
	return downloadBinary(ctx)
}

// 发布源基地址，按优先级排序：GitHub Releases 优先，releases.73zls.com
// 为静默回退（访问不了 github.com 的机器仍能更新）。
const (
	githubReleasesBase = "https://github.com/seekwe/automatic/releases/download/zuno-releases"
	r2ReleasesBase     = "https://releases.73zls.com/zuno"
)

// releasesBases 返回发布源基地址列表。ZUNO_RELEASE_BASE 设置时独占
// （测试与自定义镜像），否则 GitHub 优先、R2 回退。
func releasesBases() []string {
	if base := strings.TrimRight(zutil.Getenv("ZUNO_RELEASE_BASE"), "/"); base != "" {
		return []string{base}
	}
	return []string{githubReleasesBase, r2ReleasesBase}
}

type releaseManifest struct {
	Version string `json:"version"`
	Assets  []struct {
		Target string `json:"target"`
		Name   string `json:"name"`
		URL    string `json:"url"`
	} `json:"assets"`
}

func fetchManifest(ctx context.Context, url string) (*releaseManifest, error) {
	res, err := zhttp.Get(url)
	if err != nil {
		return nil, wrapError("download_failed", "无法获取发布清单 "+url, err)
	}
	if code := res.StatusCode(); code != 200 {
		return nil, newError("download_failed",
			fmt.Sprintf("无法获取发布清单 %s：HTTP %d", url, code))
	}
	var manifest releaseManifest
	if err := res.ToJSON(&manifest); err != nil {
		return nil, wrapError("download_failed", "发布清单解析失败", err)
	}
	return &manifest, nil
}

func downloadBinary(ctx context.Context) (string, error) {
	target := ReleaseTarget()
	if target == "" {
		return "", newError("download_failed", "不支持的平台："+runtime.GOOS+"-"+runtime.GOARCH)
	}
	version := zutil.Getenv("ZUNO_VERSION")
	bases := releasesBases()

	var manifest *releaseManifest
	manifestBase := bases[0]
	var lastErr error
	for _, base := range bases {
		manifest, lastErr = fetchManifest(ctx, base+"/latest.json")
		if lastErr == nil {
			manifestBase = base
			break
		}
	}
	if manifest == nil {
		return "", lastErr
	}
	if version != "" {
		manifest.Version = version
	}
	url := ""
	assetName := ""
	for _, asset := range manifest.Assets {
		if asset.Target == target {
			url = asset.URL
			assetName = asset.Name
			break
		}
	}
	if assetName == "" {
		assetName = "zuno-v" + manifest.Version + "-" + target + ".zip"
	}
	if url == "" {
		url = manifestBase + "/" + assetName
	}

	// 下载到临时目录，解压出二进制，再放到仅当前用户可读的缓存目录。
	tmpDir, err := os.MkdirTemp("", "zuno-sdk-download-")
	if err != nil {
		return "", wrapError("download_failed", "无法创建临时目录", err)
	}
	defer os.RemoveAll(tmpDir)
	zipPath := filepath.Join(tmpDir, "zuno.zip")

	res, err := zhttp.Get(url)
	if err != nil || res.StatusCode() != 200 {
		// 静默回退：同一份资产在另一个发布源上重试一次。
		for _, base := range bases {
			fallback := base + "/" + assetName
			if fallback == url {
				continue
			}
			res, err = zhttp.Get(fallback)
			if err == nil && res.StatusCode() == 200 {
				url = fallback
				break
			}
		}
	}
	if err != nil {
		return "", wrapError("download_failed", "无法下载 "+url, err)
	}
	if code := res.StatusCode(); code != 200 {
		return "", newError("download_failed",
			fmt.Sprintf("无法下载 %s：HTTP %d", url, code))
	}
	if err := res.ToFile(zipPath); err != nil {
		return "", wrapError("download_failed", "无法保存下载内容", err)
	}

	extractDir := filepath.Join(tmpDir, "extract")
	if err := extractZunoBinary(zipPath, extractDir, binaryName()); err != nil {
		return "", err
	}

	destDir := filepath.Dir(cachedBinaryPath())
	if err := os.MkdirAll(destDir, 0o755); err != nil {
		return "", wrapError("download_failed", "无法创建缓存目录", err)
	}
	dest := cachedBinaryPath()
	if err := copyExecutable(filepath.Join(extractDir, binaryName()), dest); err != nil {
		return "", wrapError("download_failed", "无法安装二进制", err)
	}
	return dest, nil
}

// extractZunoBinary 从 zip 里解出单个二进制文件。
func extractZunoBinary(zipPath, destDir, want string) error {
	reader, err := zip.OpenReader(zipPath)
	if err != nil {
		return wrapError("download_failed", "下载的发布包不是有效的 zip", err)
	}
	defer reader.Close()
	for _, file := range reader.File {
		name := filepath.Base(file.Name)
		if file.FileInfo().IsDir() || name != want {
			continue
		}
		if err := os.MkdirAll(destDir, 0o755); err != nil {
			return wrapError("download_failed", "无法创建解压目录", err)
		}
		src, err := file.Open()
		if err != nil {
			return wrapError("download_failed", "无法读取 zip 条目", err)
		}
		dst, err := os.OpenFile(filepath.Join(destDir, name), os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0o755)
		if err != nil {
			src.Close()
			return wrapError("download_failed", "无法写出二进制", err)
		}
		_, copyErr := io.Copy(dst, src)
		closeErr := dst.Close()
		src.Close()
		if copyErr != nil {
			return wrapError("download_failed", "解压失败", copyErr)
		}
		if closeErr != nil {
			return wrapError("download_failed", "关闭二进制失败", closeErr)
		}
		return nil
	}
	return newError("download_failed", "发布包里没有 "+want)
}

func copyExecutable(source, destination string) error {
	if !zfile.FileExist(source) {
		return newError("download_failed", "解压结果缺少 "+source)
	}
	data, err := os.ReadFile(source)
	if err != nil {
		return err
	}
	_ = os.Remove(destination)
	return os.WriteFile(destination, data, 0o755)
}
