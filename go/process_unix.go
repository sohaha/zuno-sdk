//go:build !windows

package zuno

import (
	"syscall"
)

// killProcess 向进程发信号。kill 为 false 时是优雅的 SIGTERM，
// 为 true 时是 SIGKILL。
//
// 负 pid：daemon 在 setsid() 之后是自己的进程组组长，它的辅助
// 子进程也得一起带走，否则它们还会往 home 里写。
func killProcess(pid int, kill bool) {
	sig := syscall.SIGTERM
	if kill {
		sig = syscall.SIGKILL
	}
	if err := syscall.Kill(-pid, sig); err != nil {
		_ = syscall.Kill(pid, sig)
	}
}

// processAlive 用信号 0 探测进程是否存在，不影响进程本身。
func processAlive(pid int) bool {
	return syscall.Kill(pid, 0) == nil
}
