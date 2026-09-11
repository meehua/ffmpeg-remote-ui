package server

import (
	"net/http"
	"os"
	"path/filepath"
	"strings"

	"github.com/meehua/ffmpeg-remote-ui/internal/apierr"
)

// maxDirBatch 限制一次请求创建的目录数：批量任务的输出目录数量级与之相当。
const maxDirBatch = 2000

// makeDirs 创建输出目录（含父目录）。
//
// 批量任务要在输出目录里还原输入的目录结构，而 ffmpeg 不会自己建目录，
// 因此这一步必须存在——否则「还原结构」只能停在预览上，一提交就失败。
//
// 它只创建请求里点名的目录，且每一个都要通过媒体根目录检查；和其余接口一样，
// 这是防误操作而不是安全边界。
func (s *Server) makeDirs(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Dirs []string `json:"dirs"`
	}
	if err := decodeBody(w, r, &req); err != nil {
		writeErr(w, http.StatusBadRequest, err)
		return
	}
	if len(req.Dirs) == 0 {
		writeErr(w, http.StatusBadRequest,
			apierr.Newf(apierr.CodeDirEmptyList, "没有需要创建的目录"))
		return
	}
	if len(req.Dirs) > maxDirBatch {
		writeErr(w, http.StatusBadRequest, apierr.New(apierr.CodeDirTooMany,
			map[string]any{"max": maxDirBatch}, "一次最多创建 %d 个目录", maxDirBatch))
		return
	}

	created, existing := 0, 0
	for _, raw := range req.Dirs {
		dir := filepath.Clean(strings.TrimSpace(raw))
		if dir == "" || !filepath.IsAbs(dir) {
			writeErr(w, http.StatusBadRequest, apierr.New(apierr.CodeDirNotAbsolute,
				map[string]any{"path": raw}, "目录必须是绝对路径：%s", raw))
			return
		}
		if !s.allowedPath(dir) {
			writeErr(w, http.StatusForbidden, apierr.New(apierr.CodeDirOutsideRoots,
				map[string]any{"path": dir}, "目录不在允许的媒体目录中：%s", dir))
			return
		}
		if info, err := os.Stat(dir); err == nil {
			if !info.IsDir() {
				writeErr(w, http.StatusBadRequest, apierr.New(apierr.CodeDirNameTaken,
					map[string]any{"path": dir}, "同名文件已存在，无法作为目录：%s", dir))
				return
			}
			existing++
			continue
		}
		if err := os.MkdirAll(dir, 0o755); err != nil {
			writeErr(w, http.StatusInternalServerError, apierr.New(apierr.CodeDirCreateFailed,
				map[string]any{"path": dir, "cause": err.Error()},
				"创建目录 %s 失败: %v", dir, err))
			return
		}
		created++
	}

	write(w, map[string]any{"created": created, "existing": existing})
}
