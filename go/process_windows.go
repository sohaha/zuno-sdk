//go:build windows

package zuno

import (
	"fmt"
	"os"
	"os/exec"
)

// killProcess 终止进程树。Windows 没有 Unix 信号，也没有 daemon 的
// 进程组概念；taskkill /T 会连子进程一起带走。
func killProcess(pid int, kill bool) {
	args := []string{"/PID", fmt.Sprint(pid), "/T"}
	if kill {
		args = append(args, "/F")
	}
	_ = exec.Command("taskkill", args...).Run()
}

// processAlive 探测进程是否存在。Windows 上 FindProcess 会打开进程
// 句柄，进程不存在时返回错误。
func processAlive(pid int) bool {
	_, err := os.FindProcess(pid)
	return err == nil
}
