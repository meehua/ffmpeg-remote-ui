package server

import (
	"io/fs"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/meehua/ffmpeg-remote-ui/internal/apierr"
)

// 一次扫描返回的文件数上限。
//
// 批处理的输入是人要看一遍的列表，几万个文件既没人看也没人校对；给一个上限
// 并明确告诉用户「还有更多」，比让请求跑上几分钟更有用。
const (
	scanDefaultLimit = 5000
	scanMaxLimit     = 20000
)

// ScanFile 是扫描结果里的一个文件。
type ScanFile struct {
	Path string `json:"path"`
	// Rel 相对扫描根的路径（用 / 分隔），用于在输出目录里还原目录结构。
	Rel     string    `json:"rel"`
	Size    int64     `json:"size"`
	ModTime time.Time `json:"modTime"`
	Ext     string    `json:"ext,omitempty"`
}

type scanResponse struct {
	Root  string     `json:"root"`
	Files []ScanFile `json:"files"`
	// Exts 是本次实际生效的扩展名过滤；为空表示不过滤。
	Exts []string `json:"exts"`
	// Visited 是见过的普通文件数（过滤前），Skipped 是读不了的条目数。
	Visited int `json:"visited"`
	Skipped int `json:"skipped"`
	// Truncated 表示还有文件没被收进来（已达到上限）。
	Truncated bool `json:"truncated"`
	Limit     int  `json:"limit"`
}

// scanFiles 递归列出一个目录下的媒体候选文件。
//
// 只负责「看见什么」，不判断文件能不能解码：扩展名过滤由调用方给出，
// 候选扩展名也不是内置的媒体格式表——它是用户自己填的字符串。
func (s *Server) scanFiles(w http.ResponseWriter, r *http.Request) {
	query := r.URL.Query()

	root := strings.TrimSpace(query.Get("path"))
	if root == "" {
		writeErr(w, http.StatusBadRequest,
			apierr.Newf(apierr.CodeScanPathMissing, "缺少扫描目录"))
		return
	}
	root = filepath.Clean(root)
	if !s.allowedPath(root) {
		writeErr(w, http.StatusForbidden, apierr.New(apierr.CodePathOutsideRoots,
			map[string]any{"path": root}, "路径不在允许的媒体目录中：%s", root))
		return
	}
	info, err := os.Stat(root)
	if err != nil {
		writeErr(w, http.StatusBadRequest, apierr.New(apierr.CodeScanUnavailable,
			map[string]any{"path": root, "cause": err.Error()}, "扫描目录不可用: %v", err))
		return
	}
	if !info.IsDir() {
		writeErr(w, http.StatusBadRequest,
			apierr.Newf(apierr.CodeScanNotDirectory, "扫描目录必须是一个目录"))
		return
	}

	result, err := scanDir(root, parseExts(query.Get("ext")), scanLimit(query.Get("limit")))
	if err != nil {
		writeErr(w, http.StatusBadRequest, err)
		return
	}
	write(w, result)
}

// scanDir 遍历目录。目录顺序天然是按名字排好的，因此输出顺序稳定，
// 用户两次扫描看到的是同一份列表。
func scanDir(root string, exts []string, limit int) (scanResponse, error) {
	out := scanResponse{Root: root, Files: []ScanFile{}, Exts: exts, Limit: limit}
	allowed := make(map[string]bool, len(exts))
	for _, ext := range exts {
		allowed[ext] = true
	}

	err := filepath.WalkDir(root, func(path string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			// 一个读不动的子目录不该让整次扫描失败，记一笔然后跳过。
			out.Skipped++
			if entry != nil && entry.IsDir() {
				return fs.SkipDir
			}
			return nil
		}
		if path == root {
			return nil
		}

		name := entry.Name()
		if isHiddenEntry(name, entry) {
			// 隐藏文件与隐藏目录都不是媒体，而且 .git、.cache 这类目录
			// 一旦递归进去会又慢又吵。
			if entry.IsDir() {
				return fs.SkipDir
			}
			return nil
		}
		if entry.IsDir() {
			return nil
		}
		// 只收普通文件：符号链接与设备文件不是「服务器上的媒体文件」。
		// 不跟随链接也顺带避免了目录环路。
		if !entry.Type().IsRegular() {
			return nil
		}

		out.Visited++
		info, err := entry.Info()
		if err != nil {
			out.Skipped++
			return nil
		}

		ext := strings.TrimPrefix(strings.ToLower(filepath.Ext(name)), ".")
		if len(allowed) > 0 && !allowed[ext] {
			return nil
		}
		if len(out.Files) >= limit {
			out.Truncated = true
			return fs.SkipAll
		}

		rel, err := filepath.Rel(root, path)
		if err != nil {
			rel = name
		}
		out.Files = append(out.Files, ScanFile{
			Path:    path,
			Rel:     filepath.ToSlash(rel),
			Size:    info.Size(),
			ModTime: info.ModTime(),
			Ext:     ext,
		})
		return nil
	})
	return out, err
}

// parseExts 解析扩展名过滤：逗号、分号或空白分隔，忽略大小写与前导点。
// 返回空切片表示不过滤。
func parseExts(raw string) []string {
	var out []string
	seen := map[string]bool{}
	for _, item := range strings.FieldsFunc(raw, func(r rune) bool {
		return r == ',' || r == ';' || r == ' ' || r == '\t' || r == '\n'
	}) {
		item = strings.TrimPrefix(strings.ToLower(strings.TrimSpace(item)), ".")
		if item == "" || seen[item] {
			continue
		}
		seen[item] = true
		out = append(out, item)
	}
	return out
}

func scanLimit(raw string) int {
	n, err := strconv.Atoi(strings.TrimSpace(raw))
	if err != nil || n <= 0 {
		return scanDefaultLimit
	}
	if n > scanMaxLimit {
		return scanMaxLimit
	}
	return n
}
