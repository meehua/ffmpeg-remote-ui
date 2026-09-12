package server

import (
	"path/filepath"
	"strings"

	"github.com/meehua/ffmpeg-remote-ui/internal/apierr"
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
				return apierr.New(apierr.CodePathUnresolved,
					map[string]any{"path": candidate, "cause": err.Error()},
					"无法解析参数里的路径 %s: %v", candidate, err)
			}
			if !s.allowedPath(abs) {
				return apierr.New(apierr.CodeArgPathOutsideRoots,
					map[string]any{"path": candidate},
					"参数里的路径不在允许的媒体目录中：%s", candidate)
			}
		}
	}
	return nil
}

// pathCandidates 从一个参数里挑出可能表示文件路径的片段。
//
// ffmpeg 的写法很杂，这里用保守策略：先看整个参数，再按 = , : 切开看每一段，
// 把看起来是路径的片段挑出来。scale=iw/2 这类滤镜表达式不会被误伤，
// 因为它既不以分隔符开头，也不带 ./ 或 ../。
//
// 边界要说清楚：这一步是让 MEDIA_ROOTS 名副其实地拦住越界写入，而**不是**
// 一道安全边界。它挡不住 concat 列表文件里写的路径，也挡不住不带任何前缀的
// 相对路径（那取决于进程的工作目录）。真正的隔离要靠运行账户的文件权限。
func pathCandidates(arg string) []string {
	var out []string
	seen := map[string]bool{}
	add := func(raw string) {
		// ffmpeg 的 filtergraph 会剥掉引号再解析，这里也照样剥掉两侧，
		// 否则 `subtitles='../x'` 会因为引号漏过检查，或者把引号带进路径。
		// 反斜杠不能这样顺手剥掉：它在 Windows 上是路径的一部分，
		// C:\media\ 末尾那个反斜杠去掉之后路径的含义就变了。
		s := strings.Trim(strings.TrimSpace(raw), `'"`)
		if !looksLikePath(s) || seen[s] {
			return
		}
		seen[s] = true
		out = append(out, s)
	}

	add(arg)
	for _, part := range splitArgSegments(arg) {
		add(part)
	}
	return out
}

// splitArgSegments 按 ffmpeg 常用的分隔符把参数切成几段：= , :
//
// 冒号要特殊对待：它既是 ffmpeg 的常见分隔符（subtitles=x.srt:force_style=…），
// 又是 Windows 盘符的一部分（C:\…）。盘符里的那个冒号不能当分隔符，否则
// C:\media\a.mp4 会被切成 C 与 \media\a.mp4 两段——后者在 Windows 上会解析到
// 当前盘的根目录，媒体目录检查就形同虚设了。
func splitArgSegments(arg string) []string {
	var (
		out []string
		buf []rune
	)
	flush := func() {
		out = append(out, string(buf))
		buf = buf[:0]
	}

	runes := []rune(arg)
	for i, r := range runes {
		switch r {
		case '=', ',':
			flush()
			continue
		case ':':
			if !isDriveColon(buf, runes, i) {
				flush()
				continue
			}
		case '\'', '"':
			// 引号不写进分段：它只是 ffmpeg 用来包住取值的壳，等会儿 add() 会剥掉。
			// 留着反而会让盘符判断认不出 C——subtitles="C:\x.srt" 里的那个 C
			// 前面多了一个引号，就不再是「分段的第一个字符」了。
			continue
		}
		buf = append(buf, r)
	}
	flush()
	return out
}

// isDriveColon 判断这个冒号是不是 Windows 盘符的一部分（C:\ 或 c:/）。
//
// 三个条件缺一不可：它紧跟在当前分段唯一的一个字母之后、该字母是分段的第一
// 个字符、后面紧跟路径分隔符。subtitles=x.srt:force_style=… 里的冒号前面虽然
// 也是字母，但它不是分段开头，所以照样切开。
func isDriveColon(buf, runes []rune, i int) bool {
	if len(buf) != 1 || !isASCIILetter(buf[0]) {
		return false
	}
	if i+1 >= len(runes) {
		return false
	}
	return runes[i+1] == '\\' || runes[i+1] == '/'
}

// looksLikePath 判断一个（已剥掉引号的）片段是否可能表示文件路径。
//
// POSIX 的 /x、显式相对路径 ./x 与 ../x，以及 Windows 的几种写法都算：盘符
// （C:\x）、UNC（\\server\share）、以反斜杠开头的根相对路径（\x）。
//
// 盘符那一条不能漏。C:\media\a.mp4 以字母开头，上面几个前缀一条都不匹配，
// 而它偏偏是 Windows 上最常见的写法——漏掉它，媒体目录检查在 Windows 上
// 等于没有。
func looksLikePath(s string) bool {
	if strings.HasPrefix(s, "/") || strings.HasPrefix(s, `\`) ||
		strings.HasPrefix(s, "./") || strings.HasPrefix(s, "../") ||
		strings.HasPrefix(s, `.\`) || strings.HasPrefix(s, `..\`) {
		return true
	}
	return len(s) >= 3 && isASCIILetter(rune(s[0])) && s[1] == ':' &&
		(s[2] == '\\' || s[2] == '/')
}

func isASCIILetter(r rune) bool {
	return (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z')
}
