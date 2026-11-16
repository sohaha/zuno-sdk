package zuno

import (
	"os"
	"path/filepath"
	"strings"
)

// samePath 判断两个路径解析后是否指向同一目录。
func samePath(a, b string) bool {
	realA, errA := filepath.EvalSymlinks(a)
	if errA != nil {
		return false
	}
	realB, errB := filepath.EvalSymlinks(b)
	if errB != nil {
		return false
	}
	absA, errA := filepath.Abs(realA)
	if errA != nil {
		return false
	}
	absB, errB := filepath.Abs(realB)
	if errB != nil {
		return false
	}
	return absA == absB
}

// removeInstanceHome 删除临时实例 home，拒绝跟随符号链接走到外面。
//
// home 里含有指向用户真实凭据文件的符号链接。生产环境的继承从不链接
// 目录，但清理仍然把注入的或旧版遗留的目录链接当作敌意输入处理：
// 链接只被解除、绝不进入，意外的东西原地保留而不是强删。
func removeInstanceHome(home string) {
	// 只有本模块创建的 home 才允许递归清理。调用方提供的持久 home 永远
	// 不会传到这里，但把这道护栏留在破坏性原语内部，未来的调用点才不会
	// 把一个生命周期 bug 变成对任意目录的删除。
	resolvedHome, err := filepath.Abs(home)
	if err != nil {
		return
	}
	tempRoot, err := filepath.Abs(os.TempDir())
	if err != nil {
		return
	}
	if filepath.Dir(resolvedHome) != tempRoot ||
		!strings.HasPrefix(filepath.Base(resolvedHome), "zuno-sdk-instance-") {
		return
	}
	walkDelete(resolvedHome)
}

// walkDelete 用 lstat 语义递归删除：符号链接必须被识别为链接从而解除，
// 而不是被进入。
func walkDelete(target string) {
	info, err := os.Lstat(target)
	if err != nil {
		return
	}
	if info.Mode()&os.ModeSymlink != 0 {
		_ = os.Remove(target)
		return
	}
	if info.IsDir() {
		entries, err := os.ReadDir(target)
		if err != nil {
			return
		}
		for _, entry := range entries {
			walkDelete(filepath.Join(target, entry.Name()))
		}
		_ = os.Remove(target)
		return
	}
	_ = os.Remove(target)
}
