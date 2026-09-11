package server

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func postDirs(t *testing.T, s *Server, body string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(http.MethodPost, "/api/dirs", strings.NewReader(body))
	req.Header.Set("content-type", "application/json")
	rec := httptest.NewRecorder()
	s.makeDirs(rec, req)
	return rec
}

func TestMakeDirsCreatesNestedTree(t *testing.T) {
	root := t.TempDir()
	if err := os.MkdirAll(filepath.Join(root, "已有"), 0o755); err != nil {
		t.Fatal(err)
	}
	s := testServer(root)

	body := `{"dirs": ["` + filepath.Join(root, "a", "b") + `", "` + filepath.Join(root, "已有") + `"]}`
	rec := postDirs(t, s, body)
	if rec.Code != http.StatusOK {
		t.Fatalf("状态码 = %d，期望 200（%s）", rec.Code, rec.Body.String())
	}
	// 一次请求里，新建的与已存在的要分开报数，用户才知道到底动了什么。
	if !strings.Contains(rec.Body.String(), `"created":1`) ||
		!strings.Contains(rec.Body.String(), `"existing":1`) {
		t.Errorf("响应 = %s", rec.Body.String())
	}
	if info, err := os.Stat(filepath.Join(root, "a", "b")); err != nil || !info.IsDir() {
		t.Errorf("目录没有被创建: %v", err)
	}
}

func TestMakeDirsRejectsBadRequests(t *testing.T) {
	root := t.TempDir()
	outside := t.TempDir()
	s := testServer(root)

	cases := []struct {
		name string
		body string
		code int
	}{
		{"空列表", `{"dirs": []}`, http.StatusBadRequest},
		{"相对路径", `{"dirs": ["相对目录"]}`, http.StatusBadRequest},
		{"越界路径", `{"dirs": ["` + filepath.Join(outside, "x") + `"]}`, http.StatusForbidden},
		{"不是 JSON", `{`, http.StatusBadRequest},
	}
	for _, c := range cases {
		if rec := postDirs(t, s, c.body); rec.Code != c.code {
			t.Errorf("%s：状态码 = %d，期望 %d（%s）", c.name, rec.Code, c.code, rec.Body.String())
		}
	}

	// 同名文件挡路时要明确报错，而不是让后续任务在 ffmpeg 里失败。
	blocker := filepath.Join(root, "挡路")
	if err := os.WriteFile(blocker, []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	if rec := postDirs(t, s, `{"dirs": ["`+blocker+`"]}`); rec.Code != http.StatusBadRequest {
		t.Errorf("同名文件：状态码 = %d，期望 400", rec.Code)
	}
}
