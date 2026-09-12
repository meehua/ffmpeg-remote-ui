//go:build !windows

package ffmpeg

import "testing"

func TestSplitArgs(t *testing.T) {
	cases := append(sharedSplitCases(),
		// 反斜杠在单引号外是转义前缀，所以 \ 加空格只是「带空格的参数」的另一种写法。
		// 单引号本身也是引用符，'x' 与 "x" 等价。
		splitCase{`-i a\ b.mp4`, []string{"-i", "a b.mp4"}},
		splitCase{`-vf 'subtitles=x.srt'`, []string{"-vf", "subtitles=x.srt"}},
		splitCase{`-i a\\b.mp4`, []string{"-i", `a\b.mp4`}},
	)
	runSplitCases(t, cases)

	if _, err := SplitArgs(`-i "未闭合`); err == nil {
		t.Error("未闭合的引号应当报错")
	}
}

func TestShellQuote(t *testing.T) {
	runQuoteCases(t, map[string]string{
		"plain":       "plain",
		"":            "''",
		"a b":         "'a b'",
		"it's":        `'it'\''s'`,
		"scale=128:2": "scale=128:2",
		"-vf":         "-vf",
		"a;rm -rf /":  "'a;rm -rf /'",
	})
}

func TestCommandPreview(t *testing.T) {
	s := &Service{ffmpeg: "ffmpeg"}
	got := s.Command([]string{"-i", "a file.mp4", "-c:v", "copy", "out.mp4"})
	want := `ffmpeg -i 'a file.mp4' -c:v copy out.mp4`
	if got != want {
		t.Errorf("Command() = %q，期望 %q", got, want)
	}
}
