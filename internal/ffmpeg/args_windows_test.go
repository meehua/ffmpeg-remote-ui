//go:build windows

package ffmpeg

import "testing"

func TestSplitArgs(t *testing.T) {
	cases := append(sharedSplitCases(),
		// 反斜杠是路径分隔符，不再是转义前缀：这正是 Windows 上最要紧的一条。
		splitCase{`-i C:\Users\me\a.mp4`, []string{"-i", `C:\Users\me\a.mp4`}},
		splitCase{`-i "C:\my videos\a.mp4"`, []string{"-i", `C:\my videos\a.mp4`}},
		// filtergraph 里的单引号是 ffmpeg 自己的语法，不是 cmd 的引用符，必须留着。
		splitCase{
			`-vf "subtitles='C:\subs\a.srt'"`,
			[]string{"-vf", `subtitles='C:\subs\a.srt'`},
		},
		// 引号内偶数个反斜杠：引号是结束定界符，反斜杠折半保留。
		splitCase{`-i "C:\dir\\" out.mp4`, []string{"-i", `C:\dir\`, "out.mp4"}},
		// 引号内奇数个反斜杠：引号是字面字符，引用区继续。
		splitCase{`-metadata "title=a\"b"`, []string{"-metadata", `title=a"b`}},
		// 连 ffmpeg 一起粘过来时，盘符与 .exe 都要认得。
		splitCase{`ffmpeg.exe -y`, []string{"-y"}},
		splitCase{`C:\tools\ffmpeg.exe -y`, []string{"-y"}},
	)
	runSplitCases(t, cases)

	if _, err := SplitArgs(`-i "未闭合`); err == nil {
		t.Error("未闭合的引号应当报错")
	}
	if _, err := SplitArgs(`-i "C:\dir\"`); err == nil {
		t.Error("以反斜杠转义掉收尾引号时，引号没有闭合，应当报错")
	}
}

func TestShellQuote(t *testing.T) {
	runQuoteCases(t, map[string]string{
		"plain": "plain",
		"":      `""`,
		"a b":   `"a b"`,
		// 单引号在 cmd 里不是引用符，也就没有包裹它的理由。
		"it's":               "it's",
		"scale=128:2":        "scale=128:2",
		"-vf":                "-vf",
		"a;rm -rf /":         `"a;rm -rf /"`,
		`C:\my videos\a.mp4`: `"C:\my videos\a.mp4"`,
		// 不含空白的路径无需引用，原样输出最好读。
		`C:\dir\`: `C:\dir\`,
		// 末尾的反斜杠必须翻倍，否则会把收尾引号本身转义掉。
		`C:\my dir\`: `"C:\my dir\\"`,
	})
}

func TestCommandPreview(t *testing.T) {
	s := &Service{ffmpeg: "ffmpeg"}
	got := s.Command([]string{"-i", "a file.mp4", "-c:v", "copy", "out.mp4"})
	want := `ffmpeg -i "a file.mp4" -c:v copy out.mp4`
	if got != want {
		t.Errorf("Command() = %q，期望 %q", got, want)
	}
}
