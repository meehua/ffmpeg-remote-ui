package ffmpeg

import (
	"reflect"
	"testing"
)

// splitCase 是 SplitArgs 的一个用例。
type splitCase struct {
	in   string
	want []string
}

// sharedSplitCases 列出两个平台都应当得到同样结果的输入。
//
// 带反斜杠、带单引号的写法两边含义不同，属于平台专属用例，
// 分别放在 args_posix_test.go 与 args_windows_test.go 里。
func sharedSplitCases() []splitCase {
	return []splitCase{
		{`-i in.mp4 -c:v libx264 -crf 23`, []string{"-i", "in.mp4", "-c:v", "libx264", "-crf", "23"}},
		{`-i "my movie.mp4" out.mkv`, []string{"-i", "my movie.mp4", "out.mkv"}},
		{`-vf "scale=1280:-2,fps=30"`, []string{"-vf", "scale=1280:-2,fps=30"}},
		{`-metadata "title=it's fine"`, []string{"-metadata", "title=it's fine"}},
		{`ffmpeg -y -i a.mp4 b.mp4`, []string{"-y", "-i", "a.mp4", "b.mp4"}},
		{"/usr/bin/ffmpeg -y", []string{"-y"}},
		{"-i a.mp4\n-c:v copy", []string{"-i", "a.mp4", "-c:v", "copy"}},
	}
}

func runSplitCases(t *testing.T, cases []splitCase) {
	t.Helper()
	for _, c := range cases {
		got, err := SplitArgs(c.in)
		if err != nil {
			t.Errorf("SplitArgs(%q) 出错: %v", c.in, err)
			continue
		}
		if !reflect.DeepEqual(got, c.want) {
			t.Errorf("SplitArgs(%q) = %#v，期望 %#v", c.in, got, c.want)
		}
	}
}

func runQuoteCases(t *testing.T, cases map[string]string) {
	t.Helper()
	for in, want := range cases {
		if got := quoteArg(in); got != want {
			t.Errorf("quoteArg(%q) = %q，期望 %q", in, got, want)
		}
	}
}

// quoteArg 与 SplitArgs 必须互逆：命令预览里的写法要能被原样解析回来，
// 否则「看到的命令」与「实际执行的命令」会不一致。两个平台各有一份实现，
// 所以这条不变式要在各自的实现上分别成立。
func TestQuoteRoundTrip(t *testing.T) {
	args := []string{
		"-i", "a b.mp4",
		"-metadata", "title=it's fine",
		"-vf", "scale=1280:-2,fps=30",
		"out;rm -rf.mp4",
		"-i", `C:\Users\me\my videos\a.mp4`,
		`C:\out\`,
		`a"b`,
		"",
	}
	line := shellJoin(args)
	got, err := SplitArgs(line)
	if err != nil {
		t.Fatalf("解析 shellJoin 生成的命令失败: %v\n  %s", err, line)
	}
	if !reflect.DeepEqual(got, args) {
		t.Fatalf("往返不一致:\n  原始 %#v\n  生成 %s\n  解析 %#v", args, line, got)
	}
}

// 用户经常把整条命令连 ffmpeg 一起粘进来，所以开头那个程序名要在两个平台上
// 都能被认出并去掉——Windows 上它可能带盘符与 .exe。
func TestStripToolPrefix(t *testing.T) {
	cases := []struct {
		in   []string
		want []string
	}{
		{[]string{"ffmpeg", "-y"}, []string{"-y"}},
		{[]string{"ffprobe", "a.mp4"}, []string{"a.mp4"}},
		{[]string{"/usr/bin/ffmpeg", "-y"}, []string{"-y"}},
		{[]string{`C:\tools\ffmpeg.exe`, "-y"}, []string{"-y"}},
		{[]string{"FFMPEG.EXE", "-y"}, []string{"-y"}},
		{[]string{"-y"}, []string{"-y"}},
		{[]string{}, []string{}},
		// 名字里含 ffmpeg 但不是它本身：不能动。
		{[]string{"myffmpeg", "-y"}, []string{"myffmpeg", "-y"}},
	}
	for _, c := range cases {
		if got := stripToolPrefix(c.in); !reflect.DeepEqual(got, c.want) {
			t.Errorf("stripToolPrefix(%#v) = %#v，期望 %#v", c.in, got, c.want)
		}
	}
}
