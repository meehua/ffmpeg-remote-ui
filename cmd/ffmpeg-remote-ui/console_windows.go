//go:build windows

package main

import (
	"os"
	"syscall"
	"unsafe"
)

// utf8CodePage 是 UTF-8 的代码页编号。
const utf8CodePage = 65001

// setupConsole 把控制台输出代码页切成 UTF-8。
//
// 日志正文是中文，而 Windows 控制台默认用系统 ANSI 代码页（简体中文环境下是
// GBK）。Go 写出去的是 UTF-8 字节，两边对不上就是满屏乱码——启动日志本来是用
// 来回答「跑的是哪个构建、媒体目录在哪」的，乱码等于白打。
//
// 只在 stderr 真的连着控制台时才切。被重定向到文件或管道时那些字节本来就该是
// UTF-8，而此时改代码页只会连累同一个控制台里的其它程序。
func setupConsole() {
	kernel32 := syscall.NewLazyDLL("kernel32.dll")
	getConsoleMode := kernel32.NewProc("GetConsoleMode")
	setConsoleOutputCP := kernel32.NewProc("SetConsoleOutputCP")

	// 日志走 stderr，所以用它的句柄判定有没有控制台。
	handle := syscall.Handle(os.Stderr.Fd())
	var mode uint32
	if ret, _, _ := getConsoleMode.Call(uintptr(handle), uintptr(unsafe.Pointer(&mode))); ret == 0 {
		return
	}
	setConsoleOutputCP.Call(utf8CodePage)
}
