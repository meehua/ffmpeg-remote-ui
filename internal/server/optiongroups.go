package server

import "net/http"

// ffmpegOptionGroups 返回 FFmpeg 自己的「公共上下文」AVOptions 分节。
//
// 这是界面需要的第二层参数来源：`ffmpeg -h encoder=<名>` 只回答「这个编码器
// 私有注册了哪些参数」，而 libavcodec/libavformat 共享的那批（global_quality、
// b、maxrate、bufsize、g、bf、profile、level…）挂在 AVCodecContext 之类的
// 上下文上，只出现在 `ffmpeg -h full` 里。
//
// 分组、组件层与选项，全部来自 FFmpeg 的输出（见 internal/ffmpeg/optiongroups.go），
// 服务器不维护任何参数清单。
func (s *Server) ffmpegOptionGroups(w http.ResponseWriter, _ *http.Request) {
	groups, err := s.ff.OptionGroups()
	if err != nil {
		// 与其它 ffmpeg 查询一致：ffmpeg 没能给出结果（502），不是请求写错了。
		writeErr(w, http.StatusBadGateway, err)
		return
	}
	write(w, groups)
}
