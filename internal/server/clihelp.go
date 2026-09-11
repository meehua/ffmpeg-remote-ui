package server

import (
	"net/http"

	"github.com/meehua/ffmpeg-remote-ui/internal/apierr"
	"github.com/meehua/ffmpeg-remote-ui/internal/ffmpeg"
)

// ffmpegCli 返回 ffmpeg 自己的命令行拓扑。
//
// 界面的控件结构直接由它决定：有哪些分节、每个选项要不要取值、落在哪一段
// 命令行，全部来自 ffmpeg 的 `-h` 输出，程序不维护自己的分类表。
// level 传空、long 或 full，对应 ffmpeg 的三档详略。
func (s *Server) ffmpegCli(w http.ResponseWriter, r *http.Request) {
	level := r.URL.Query().Get("level")
	// 先在这里挡掉写错的档位：那是请求写错了（400），不是 ffmpeg 出问题（502）。
	if !ffmpeg.ValidLevel(level) {
		writeErr(w, http.StatusBadRequest, apierr.New(apierr.CodeFFmpegLevelUnsupported,
			map[string]any{"level": level}, "不支持的详略级别 %q（可用：空、long、full）", level))
		return
	}

	help, err := s.ff.CliHelp(level)
	if err != nil {
		// 走到这里说明档位没问题，是 ffmpeg 没能给出结果。
		writeErr(w, http.StatusBadGateway, err)
		return
	}
	write(w, help)
}
