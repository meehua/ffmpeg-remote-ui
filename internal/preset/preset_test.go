package preset

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"testing"
)

func newStore(t *testing.T) *Store {
	t.Helper()
	s, err := NewStore(t.TempDir())
	if err != nil {
		t.Fatalf("NewStore 失败: %v", err)
	}
	return s
}

func TestSaveGetListRemove(t *testing.T) {
	s := newStore(t)
	recipe := json.RawMessage(`{"version":1,"settings":{"videoCodec":"libx265"}}`)

	saved, err := s.Save("hevc 慢速", recipe)
	if err != nil {
		t.Fatalf("Save 失败: %v", err)
	}
	if saved.UpdatedAt == "" {
		t.Error("应当记录更新时间")
	}

	got, err := s.Get("hevc 慢速")
	if err != nil {
		t.Fatalf("Get 失败: %v", err)
	}
	if got.Name != "hevc 慢速" {
		t.Errorf("名字 = %q", got.Name)
	}
	var decoded map[string]any
	if err := json.Unmarshal(got.Recipe, &decoded); err != nil {
		t.Fatalf("配方读不回来: %v", err)
	}
	if decoded["version"] != float64(1) {
		t.Errorf("配方内容 = %v", decoded)
	}

	if _, err := s.Save("另一个", json.RawMessage(`{"version":1}`)); err != nil {
		t.Fatal(err)
	}
	metas, warnings, err := s.List()
	if err != nil {
		t.Fatalf("List 失败: %v", err)
	}
	if len(warnings) != 0 {
		t.Errorf("不该有警告: %v", warnings)
	}
	if len(metas) != 2 || metas[0].Name != "hevc 慢速" {
		t.Fatalf("列表 = %+v（应当按名字排序）", metas)
	}
	if metas[0].Size == 0 {
		t.Error("列表应当带上文件大小")
	}

	if err := s.Remove("另一个"); err != nil {
		t.Fatalf("Remove 失败: %v", err)
	}
	if err := s.Remove("另一个"); !errors.Is(err, ErrNotFound) {
		t.Errorf("删除不存在的预设应返回 ErrNotFound，实际 %v", err)
	}
	if _, err := s.Get("另一个"); !errors.Is(err, ErrNotFound) {
		t.Errorf("Get 不存在的预设应返回 ErrNotFound，实际 %v", err)
	}
}

func TestSaveOverwritesAndRefreshesTimestamp(t *testing.T) {
	s := newStore(t)
	if _, err := s.Save("a", json.RawMessage(`{"n":1}`)); err != nil {
		t.Fatal(err)
	}
	first, _ := s.Get("a")
	if _, err := s.Save("a", json.RawMessage(`{"n":2}`)); err != nil {
		t.Fatal(err)
	}
	second, _ := s.Get("a")
	// 写盘时会重新缩进（RawMessage 逃不过 encode），所以比较值而不是文本。
	var overwritten map[string]int
	if err := json.Unmarshal(second.Recipe, &overwritten); err != nil {
		t.Fatalf("配方读不回来: %v", err)
	}
	if overwritten["n"] != 2 {
		t.Errorf("同名保存没有覆盖: %s", second.Recipe)
	}
	if second.UpdatedAt < first.UpdatedAt {
		t.Errorf("更新时间倒退了: %q < %q", second.UpdatedAt, first.UpdatedAt)
	}
	// 文件名固定成 <名字>.json，用户能直接找到它。
	entries, err := os.ReadDir(s.Dir())
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 1 || entries[0].Name() != "a.json" {
		t.Fatalf("预设目录内容 = %v", entries)
	}
}

func TestValidateName(t *testing.T) {
	bad := []string{
		"",
		".",
		"..",
		"../外面",
		"a/b",
		`a\b`,
		"带:冒号",
		"结尾空格 ",
		"控制\x01字符",
		string(make([]rune, MaxNameRunes+1)),
	}
	for _, name := range bad {
		if err := ValidateName(name); err == nil {
			t.Errorf("ValidateName(%q) 应当失败", name)
		}
	}
	good := []string{"a", "x265 慢速", "hevc_crf-21", "2026-09-11 预设", "日本語"}
	for _, name := range good {
		if err := ValidateName(name); err != nil {
			t.Errorf("ValidateName(%q) 失败: %v", name, err)
		}
	}

	// 名字直接变成文件名，所以路径分隔符必须在校验层就被拦下，
	// 而不是指望调用方先清理。
	if err := ValidateName("../../etc/passwd"); err == nil {
		t.Error("路径穿越的名字必须被拒绝")
	}
}

func TestSaveRejectsBadRecipe(t *testing.T) {
	s := newStore(t)
	for _, recipe := range []string{``, `   `, `[]`, `"字符串"`, `{不是 JSON}`, `null`} {
		if _, err := s.Save("x", json.RawMessage(recipe)); err == nil {
			t.Errorf("配方 %q 应当被拒绝", recipe)
		}
	}
	long := make([]byte, MaxRecipeBytes+1)
	long[0] = '{'
	long[len(long)-1] = '}'
	if _, err := s.Save("x", json.RawMessage(long)); err == nil {
		t.Error("过大的配方应当被拒绝")
	}
}

func TestListSkipsBrokenFiles(t *testing.T) {
	s := newStore(t)
	if _, err := s.Save("好的", json.RawMessage(`{"version":1}`)); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(s.Dir(), "坏的.json"), []byte("{ 半截"), 0o600); err != nil {
		t.Fatal(err)
	}
	// 非 JSON 文件与被隐藏的文件都不该出现在列表里。
	if err := os.WriteFile(filepath.Join(s.Dir(), "笔记.txt"), []byte("hello"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(s.Dir(), ".隐藏.json"), []byte(`{"version":1}`), 0o600); err != nil {
		t.Fatal(err)
	}

	metas, warnings, err := s.List()
	if err != nil {
		t.Fatalf("List 失败: %v", err)
	}
	if len(metas) != 1 || metas[0].Name != "好的" {
		t.Fatalf("列表 = %+v", metas)
	}
	if len(warnings) != 1 {
		t.Errorf("应当只对坏文件给出警告，实际 %v", warnings)
	}
}

func TestGetMissingDir(t *testing.T) {
	s := &Store{dir: filepath.Join(t.TempDir(), "还不存在")}
	metas, _, err := s.List()
	if err != nil {
		t.Fatalf("目录不存在时 List 不该报错: %v", err)
	}
	if len(metas) != 0 {
		t.Errorf("列表 = %+v", metas)
	}
}
