package server

import (
	"io"
	"net/http"
)

// sendSnapshot 先发一个 reset 标记，再发全量任务。
//
// reset 让客户端明确地丢弃旧状态，而不是把快照合并进一个可能已经过期的列表。
// 首次连接与「因丢事件而重同步」走同一条路径，客户端因此只需处理一种语义。
func (s *Server) sendSnapshot(w io.Writer, flusher http.Flusher) bool {
	if writeEvent(w, "reset", map[string]any{}) != nil {
		return false
	}
	for _, job := range s.queue.List() {
		if writeEvent(w, "job", job) != nil {
			return false
		}
	}
	flusher.Flush()
	return true
}
