//go:build !windows

package main

// setupConsole 在别的平台上不必做事：终端本来就按 UTF-8 读懂那些字节。
func setupConsole() {}
