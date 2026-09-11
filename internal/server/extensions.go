package server

import "net/http"

// ffmpegExtensions 汇总 ffmpeg 自己声明的文件扩展名。
//
// target 决定方向：输入侧用 demuxer（能读什么），输出侧用 muxer（能写什么）。
// 界面拿它当候选列表，因此列表里不该、也不会出现本程序自己写进去的扩展名。
func (s *Server) ffmpegExtensions(w http.ResponseWriter, r *http.Request) {
	result, err := s.ff.Extensions(r.URL.Query().Get("target"))
	if err != nil {
		writeErr(w, http.StatusBadRequest, err)
		return
	}
	write(w, result)
}
