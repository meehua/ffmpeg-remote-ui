//go:build !windows

package server

import (
	"io/fs"
	"strings"
)

// comparablePath 在大小写敏感的文件系统上原样返回。
func comparablePath(p string) string {
	return p
}

// isHiddenEntry 在 POSIX 上，隐藏就是名字以点开头。
func isHiddenEntry(name string, _ fs.DirEntry) bool {
	return strings.HasPrefix(name, ".")
}

// filesystemRoots 返回「没有配置媒体根目录」时文件浏览器的入口：
// POSIX 上就是那个唯一的根。
func filesystemRoots() []string {
	return []string{"/"}
}
