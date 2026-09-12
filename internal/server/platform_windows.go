//go:build windows

package server

import (
	"io/fs"
	"strings"
	"syscall"
)

// comparablePath 把路径归一成可以直接比较的形式。
//
// Windows 的文件名与路径比较不区分大小写：D:\Media 与 d:\media\a.mp4 说的是
// 同一棵树。不折叠大小写的话，用户会遇到「明明就在媒体目录里却被拒绝」。
func comparablePath(p string) string {
	return strings.ToLower(p)
}

// isHiddenEntry 判断一个目录项是不是「隐藏」。
//
// Windows 的隐藏是文件属性而不是名字前缀，这是它与 POSIX 最直观的一处差异：
// 只认点号前缀的话，「隐藏」这一栏在 Windows 上就永远为空，而扫一遍目录树
// 时真正该跳过的 desktop.ini、System Volume Information 反倒全都收进来了。
//
// 系统属性一并算隐藏：它们同样是浏览媒体目录时该绕开的噪音。点号前缀仍然
// 照认，这样从 Linux 搬过来的 .git、.cache 在两个平台上表现一致。
func isHiddenEntry(name string, entry fs.DirEntry) bool {
	if strings.HasPrefix(name, ".") {
		return true
	}
	info, err := entry.Info()
	if err != nil {
		// 拿不到属性时按「不隐藏」处理：扫描本来就允许读不动的条目，
		// 让它去后面的 os.Stat 报错，比在这里猜一个结果更诚实。
		return false
	}
	data, ok := info.Sys().(*syscall.Win32FileAttributeData)
	if !ok {
		return false
	}
	const hiddenOrSystem = syscall.FILE_ATTRIBUTE_HIDDEN | syscall.FILE_ATTRIBUTE_SYSTEM
	return data.FileAttributes&hiddenOrSystem != 0
}

// filesystemRoots 返回「没有配置媒体根目录」时文件浏览器的入口。
//
// Windows 没有唯一的文件系统根，所以入口是所有已挂载的盘符——资源管理器也是
// 这么给的。这里返回 `C:\` 而不是裸的 `C:`：后者在 Windows 上表示「该盘的当前
// 目录」，filepath.IsAbs 也判为假，点进去会被路径检查直接拒掉。
//
// 拿不到盘符列表时返回 nil，让接口给一个空列表；猜一个盘符出来只会更让人困惑。
func filesystemRoots() []string {
	kernel32 := syscall.NewLazyDLL("kernel32.dll")
	getLogicalDrives := kernel32.NewProc("GetLogicalDrives")
	mask, _, _ := getLogicalDrives.Call()
	if mask == 0 {
		return nil
	}

	roots := make([]string, 0, 4)
	for i := 0; i < 26; i++ {
		if mask&(uintptr(1)<<uint(i)) == 0 {
			continue
		}
		roots = append(roots, string(rune('A'+i))+`:\`)
	}
	return roots
}
