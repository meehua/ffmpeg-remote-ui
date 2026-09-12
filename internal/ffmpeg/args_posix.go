//go:build !windows

package ffmpeg

import (
	"strings"

	"github.com/meehua/ffmpeg-remote-ui/internal/apierr"
)

// SplitArgs 把用户手写的命令行拆成 argv。
//
// 支持单引号、双引号与反斜杠转义，规则贴近 POSIX shell 的常用子集，
// 这样终端里能跑的命令粘贴进来含义一致。用户常会连 ffmpeg 一起粘贴，
// 因此前导的 ffmpeg/ffprobe 会被去掉。
func SplitArgs(input string) ([]string, error) {
	var (
		args  []string
		cur   strings.Builder
		quote rune
		esc   bool
		has   bool
	)
	flush := func() {
		if has {
			args = append(args, cur.String())
			cur.Reset()
			has = false
		}
	}
	for _, r := range input {
		switch {
		case esc:
			cur.WriteRune(r)
			has = true
			esc = false
		case r == '\\' && quote != '\'':
			esc = true
		case quote != 0:
			if r == quote {
				quote = 0
			} else {
				cur.WriteRune(r)
			}
			has = true
		case r == '\'' || r == '"':
			quote = r
			has = true
		case r == ' ' || r == '\t' || r == '\n' || r == '\r':
			flush()
		default:
			cur.WriteRune(r)
			has = true
		}
	}
	if esc {
		cur.WriteRune('\\')
	}
	if quote != 0 {
		return nil, apierr.Newf(apierr.CodeFFmpegQuoteUnclosed, "引号没有闭合")
	}
	flush()
	return stripToolPrefix(args), nil
}

// quoteArg 把一个参数写成 POSIX shell 里的形式。
func quoteArg(s string) string {
	if s == "" {
		return "''"
	}
	const special = " \t\n\r\\\"'$`;&|<>()*?[]{}#!~"
	if !strings.ContainsAny(s, special) {
		return s
	}
	// 单引号内除单引号本身外无需转义，是最不容易出错的引用方式。
	return "'" + strings.ReplaceAll(s, "'", `'\''`) + "'"
}
