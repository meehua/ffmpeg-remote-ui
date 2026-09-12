//go:build windows

package server

import (
	"os"
	"path/filepath"
	"syscall"
	"testing"
)

// Windows 的「隐藏」是文件属性而不是名字前缀：只认点号的话，这个平台上的隐藏
// 文件一个都过滤不掉，而 scan 一遍目录树时该跳过的 desktop.ini 之类反倒全进来。
func TestHiddenEntryUsesFileAttributes(t *testing.T) {
	dir := t.TempDir()
	name := "隐藏的片子.mp4"
	path := filepath.Join(dir, name)
	if err := os.WriteFile(path, []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}

	ptr, err := syscall.UTF16PtrFromString(path)
	if err != nil {
		t.Fatal(err)
	}
	if err := syscall.SetFileAttributes(ptr, syscall.FILE_ATTRIBUTE_HIDDEN); err != nil {
		t.Fatalf("打隐藏属性失败: %v", err)
	}

	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	found := false
	for _, e := range entries {
		if e.Name() != name {
			continue
		}
		found = true
		if !isHiddenEntry(e.Name(), e) {
			t.Error("带隐藏属性的文件应当被判为隐藏")
		}
	}
	if !found {
		t.Fatalf("没能列到 %s", name)
	}

	// 点号前缀在 Windows 上照样算隐藏：从 Linux 搬过来的目录结构两个平台一致。
	if !isHiddenEntry(".git", nil) {
		t.Error("点号前缀应当仍然算隐藏")
	}
}

// 路径比较必须折叠大小写：D:\Media 与 d:\media\a.mp4 在同一台机器上说的是
// 同一棵树，不折叠就会让用户看到「明明在媒体目录里却被拒绝」。
func TestComparablePathFoldsCase(t *testing.T) {
	if comparablePath(`D:\Media\A.MP4`) != comparablePath(`d:\media\a.mp4`) {
		t.Error("Windows 上的路径比较不应区分大小写")
	}
}
