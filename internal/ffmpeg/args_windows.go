//go:build windows

package ffmpeg

import (
	"strings"

	"github.com/meehua/ffmpeg-remote-ui/internal/apierr"
)

// SplitArgs 把用户手写的命令行拆成 argv（cmd.exe 的常见子集）。
//
// 与 POSIX 那版的两点不同，都是为了让 Windows 路径别再被吃掉反斜杠：
//
//  1. 只有双引号是引用符。cmd 里单引号是普通字符，而 ffmpeg 的 filtergraph
//     恰恰爱用它（subtitles='x.srt'），所以 `'` 必须原样保留。
//  2. 引号外的反斜杠是字面字符，不再当转义前缀，C:\Users\me\a.mp4 因此完整保留。
//
// 引号内的反斜杠按 CommandLineToArgvW 的规则处理：2n 个反斜杠加一个引号是
// n 个反斜杠加一个引号定界符，2n+1 个则是 n 个反斜杠加一个字面引号。这条规则
// 决定了 quoteArg 生成的东西能被 Windows 自己的解析器读懂，而不只是被我们自己读懂。
//
// 用户常会连 ffmpeg 一起粘贴，因此前导的 ffmpeg/ffprobe 会被去掉。
func SplitArgs(input string) ([]string, error) {
	var (
		args   []string
		cur    strings.Builder
		quoted bool
		has    bool
	)
	flush := func() {
		if has {
			args = append(args, cur.String())
			cur.Reset()
			has = false
		}
	}

	runes := []rune(input)
	for i := 0; i < len(runes); i++ {
		r := runes[i]

		// 引号内连续反斜杠要成组处理：单个反斜杠的含义取决于它后面是不是引号，
		// 所以不能像 POSIX 那样遇到一个就转义一个。
		if quoted && r == '\\' {
			n := 0
			for i+n < len(runes) && runes[i+n] == '\\' {
				n++
			}
			if i+n < len(runes) && runes[i+n] == '"' {
				cur.WriteString(strings.Repeat(`\`, n/2))
				has = true
				if n%2 == 1 {
					// 奇数个：这个引号是字面字符，引用区继续。
					cur.WriteRune('"')
				} else {
					// 偶数个：这个引号是引用区的结束定界符。
					quoted = false
				}
				i += n // 循环自增再吃掉那个引号
				continue
			}
			// 后面不是引号：反斜杠只是普通字符，一个都不能少。
			cur.WriteString(strings.Repeat(`\`, n))
			has = true
			i += n - 1
			continue
		}

		switch {
		case r == '"':
			quoted = !quoted
			has = true
		case !quoted && (r == ' ' || r == '\t' || r == '\n' || r == '\r'):
			flush()
		default:
			cur.WriteRune(r)
			has = true
		}
	}
	if quoted {
		return nil, apierr.Newf(apierr.CodeFFmpegQuoteUnclosed, "引号没有闭合")
	}
	flush()
	return stripToolPrefix(args), nil
}

// quoteArg 把一个参数写成 Windows 命令行的形式。
//
// 规则与 CommandLineToArgvW（也就是 cmd 转发给子进程后对方看到的那一套）一致：
// 只在含空白或引号时才加双引号；一旦加了引号，末尾的反斜杠必须翻倍，否则它会
// 把收尾引号本身转义掉——这正是 Windows 上「路径以反斜杠结尾」出错的由来。
func quoteArg(s string) string {
	if s == "" {
		return `""`
	}
	// 没有空白与引号时无需引用，原样写出来最短也最好读。
	if !strings.ContainsAny(s, " \t\n\r\v\"") {
		return s
	}

	var b strings.Builder
	b.WriteByte('"')
	slashes := 0
	for _, r := range s {
		switch r {
		case '\\':
			// 反斜杠的含义要看下一个字符，先攒着。
			slashes++
		case '"':
			b.WriteString(strings.Repeat(`\`, slashes*2+1))
			b.WriteRune(r)
			slashes = 0
		default:
			b.WriteString(strings.Repeat(`\`, slashes))
			b.WriteRune(r)
			slashes = 0
		}
	}
	b.WriteString(strings.Repeat(`\`, slashes*2))
	b.WriteByte('"')
	return b.String()
}
