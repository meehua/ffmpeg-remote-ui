package server

import (
	"fmt"
	"path/filepath"
	"strings"
)

// checkArgs 在配置了媒体根目录时，扫描参数里出现的文件路径。
//
// 存在的理由：真正交给 ffmpeg 的是整个 args，里面可以是 -i /path、
// subtitles=/path、movie=/path，甚至 -attach /path。只校验 input/output
// 两个字段的话，媒体根目录就只是「看起来」有限制。
func (s *Server) checkArgs(args []string) error {
	if len(s.mediaRoots) == 0 {
		return nil
	}
	for _, arg := range args {
		for _, candidate := range pathCandidates(arg) {
			// ffmpeg 按进程的工作目录解析相对路径，所以这里也要先解析成
			// 绝对路径再判断，否则 ../../etc/passwd 这类写法能整个绕过去。
			abs, err := filepath.Abs(candidate)
			if err != nil {
				return fmt.Errorf("无法解析参数里的路径 %s: %w", candidate, err)
			}
			if !s.allowedPath(abs) {
				return fmt.Errorf("参数里的路径不在允许的媒体目录中：%s", candidate)
			}
		}
	}
	return nil
}

// pathCandidates 从一个参数里挑出可能表示文件路径的片段。
//
// ffmpeg 的写法很杂，这里用保守策略：先看整个参数，再按 = : , 切开看每一段，
// 把看起来是路径的片段挑出来——绝对路径（/x）与显式相对路径（./x、../x）都算。
// scale=iw/2 这类滤镜表达式不会被误伤，因为它既不以 / 开头，也不带 ./ 或 ../。
//
// 边界要说清楚：这一步是让 MEDIA_ROOTS 名副其实地拦住越界写入，而**不是**
// 一道安全边界。它挡不住 concat 列表文件里写的路径，也挡不住不带任何前缀的
// 相对路径（那取决于进程的工作目录）。真正的隔离要靠运行账户的文件权限。
func pathCandidates(arg string) []string {
	var out []string
	seen := map[string]bool{}
	add := func(raw string) {
		// ffmpeg 的 filtergraph 会剥掉引号与反斜杠再解析，这里也照样剥掉两侧，
		// 否则 `subtitles='../x'` 会因为引号漏过检查，或者把引号带进路径。
		s := strings.Trim(strings.TrimSpace(raw), `'"\`)
		if !looksLikePath(s) || seen[s] {
			return
		}
		seen[s] = true
		out = append(out, s)
	}

	add(arg)
	for _, part := range strings.FieldsFunc(arg, func(r rune) bool {
		return r == '=' || r == ':' || r == ','
	}) {
		add(part)
	}
	return out
}

// looksLikePath 判断一个（已剥掉引号的）片段是否可能表示文件路径。
func looksLikePath(s string) bool {
	return strings.HasPrefix(s, "/") ||
		strings.HasPrefix(s, "./") ||
		strings.HasPrefix(s, "../")
}
