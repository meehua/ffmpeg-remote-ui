package server

import (
	"embed"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"testing"

	"github.com/meehua/ffmpeg-remote-ui/internal/ffmpeg"
)

// buildTree 造一棵测试用的目录树：
//
//	root/
//	  a.mkv              ← 普通文件
//	  b.MP4              ← 大小写不同的扩展名
//	  note.txt           ← 不在白名单里
//	  .hidden.mkv        ← 隐藏文件
//	  sub/c.mkv          ← 子目录里的文件
//	  sub/deep/d.mkv     ← 更深一层
//	  .git/objects/x.mkv ← 隐藏目录，应当整个跳过
//	  链接 -> a.mkv      ← 符号链接，应当跳过
func buildTree(t *testing.T) string {
	t.Helper()
	root := t.TempDir()
	write := func(rel, body string) {
		path := filepath.Join(root, filepath.FromSlash(rel))
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	write("a.mkv", "a")
	write("b.MP4", "bb")
	write("note.txt", "n")
	write(".hidden.mkv", "h")
	write("sub/c.mkv", "c")
	write("sub/deep/d.mkv", "d")
	write(".git/objects/x.mkv", "x")
	if err := os.Symlink(filepath.Join(root, "a.mkv"), filepath.Join(root, "链接.mkv")); err != nil {
		t.Skipf("当前环境不支持符号链接: %v", err)
	}
	return root
}

func rels(files []ScanFile) []string {
	out := make([]string, 0, len(files))
	for _, f := range files {
		out = append(out, f.Rel)
	}
	return out
}

func TestScanDirFiltersAndSkips(t *testing.T) {
	root := buildTree(t)

	got, err := scanDir(root, []string{"mkv"}, scanDefaultLimit)
	if err != nil {
		t.Fatalf("scanDir 失败: %v", err)
	}
	want := []string{"a.mkv", "sub/c.mkv", "sub/deep/d.mkv"}
	if !reflect.DeepEqual(rels(got.Files), want) {
		t.Errorf("命中文件 = %v，期望 %v", rels(got.Files), want)
	}
	// Visited 是过滤前见过的普通文件数（不含隐藏文件、隐藏目录与链接）。
	if got.Visited != 5 {
		t.Errorf("Visited = %d，期望 5", got.Visited)
	}
	if got.Skipped != 0 {
		t.Errorf("Skipped = %d，期望 0", got.Skipped)
	}
	if got.Truncated {
		t.Error("没有超过上限时不该标记截断")
	}
	if got.Files[0].Size == 0 || got.Files[0].Path == "" || got.Files[0].ModTime.IsZero() {
		t.Errorf("扫描结果缺少元信息: %+v", got.Files[0])
	}
}

func TestScanDirWithoutFilterKeepsEverything(t *testing.T) {
	root := buildTree(t)

	got, err := scanDir(root, nil, scanDefaultLimit)
	if err != nil {
		t.Fatalf("scanDir 失败: %v", err)
	}
	want := []string{"a.mkv", "b.MP4", "note.txt", "sub/c.mkv", "sub/deep/d.mkv"}
	if !reflect.DeepEqual(rels(got.Files), want) {
		t.Errorf("命中文件 = %v，期望 %v", rels(got.Files), want)
	}
	if got.Files[1].Ext != "mp4" {
		t.Errorf("扩展名应当被归一化成小写，实际 %q", got.Files[1].Ext)
	}
}

func TestScanDirTruncatesAtLimit(t *testing.T) {
	root := buildTree(t)

	got, err := scanDir(root, []string{"mkv"}, 2)
	if err != nil {
		t.Fatalf("scanDir 失败: %v", err)
	}
	if len(got.Files) != 2 {
		t.Fatalf("应当只返回 2 个文件，实际 %v", rels(got.Files))
	}
	if !got.Truncated {
		t.Error("达到上限时应当标记截断")
	}
}

func TestParseExts(t *testing.T) {
	cases := []struct {
		raw  string
		want []string
	}{
		{"", nil},
		{"mkv", []string{"mkv"}},
		{".MKV, mp4;mov", []string{"mkv", "mp4", "mov"}},
		{"mkv mkv .mkv", []string{"mkv"}},
	}
	for _, c := range cases {
		if got := parseExts(c.raw); !reflect.DeepEqual(got, c.want) {
			t.Errorf("parseExts(%q) = %v，期望 %v", c.raw, got, c.want)
		}
	}
}

func TestScanLimit(t *testing.T) {
	cases := map[string]int{
		"":        scanDefaultLimit,
		"abc":     scanDefaultLimit,
		"0":       scanDefaultLimit,
		"-5":      scanDefaultLimit,
		"10":      10,
		"9999999": scanMaxLimit,
	}
	for raw, want := range cases {
		if got := scanLimit(raw); got != want {
			t.Errorf("scanLimit(%q) = %d，期望 %d", raw, got, want)
		}
	}
}

func testServer(roots ...string) *Server {
	return New(ffmpeg.NewService("ffmpeg", "ffprobe"), embed.FS{}, Options{MediaRoots: roots})
}

func scanViaHandler(t *testing.T, s *Server, query string) (*httptest.ResponseRecorder, scanResponse) {
	t.Helper()
	rec := httptest.NewRecorder()
	s.scanFiles(rec, httptest.NewRequest(http.MethodGet, "/api/files/scan?"+query, nil))
	var body scanResponse
	if rec.Code == http.StatusOK {
		if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
			t.Fatalf("响应不是合法 JSON: %v（%s）", err, rec.Body.String())
		}
	}
	return rec, body
}

func TestScanHandlerRespectsMediaRoots(t *testing.T) {
	root := buildTree(t)
	outside := t.TempDir()
	s := testServer(root)

	rec, body := scanViaHandler(t, s, "path="+root+"&ext=mkv")
	if rec.Code != http.StatusOK {
		t.Fatalf("状态码 = %d，期望 200（%s）", rec.Code, rec.Body.String())
	}
	if body.Root != root || len(body.Files) != 3 {
		t.Errorf("扫描结果 = %+v", body)
	}
	if !reflect.DeepEqual(body.Exts, []string{"mkv"}) {
		t.Errorf("生效的扩展名过滤 = %v", body.Exts)
	}

	// 媒体目录之外的路径必须被拦住：扫描是「列目录」，同样受路径限制约束。
	rec, _ = scanViaHandler(t, s, "path="+outside)
	if rec.Code != http.StatusForbidden {
		t.Errorf("越界扫描状态码 = %d，期望 403", rec.Code)
	}
}

func TestScanHandlerRejectsBadInput(t *testing.T) {
	root := buildTree(t)
	s := testServer(root)

	rec, _ := scanViaHandler(t, s, "")
	if rec.Code != http.StatusBadRequest {
		t.Errorf("缺少 path 时状态码 = %d，期望 400", rec.Code)
	}

	rec, _ = scanViaHandler(t, s, "path="+filepath.Join(root, "a.mkv"))
	if rec.Code != http.StatusBadRequest {
		t.Errorf("目标不是目录时状态码 = %d，期望 400", rec.Code)
	}

	rec, _ = scanViaHandler(t, s, "path="+filepath.Join(root, "不存在"))
	if rec.Code != http.StatusBadRequest {
		t.Errorf("目录不存在时状态码 = %d，期望 400", rec.Code)
	}
}

func TestScanHandlerWithoutMediaRoots(t *testing.T) {
	root := buildTree(t)
	// 没配置媒体目录时不限制路径，扫描依然可用。
	rec, body := scanViaHandler(t, testServer(), "path="+root)
	if rec.Code != http.StatusOK {
		t.Fatalf("状态码 = %d，期望 200", rec.Code)
	}
	if len(body.Files) != 5 {
		t.Errorf("命中文件 = %v", rels(body.Files))
	}
}
