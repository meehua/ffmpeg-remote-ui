package server

import (
	"path/filepath"
	"reflect"
	"testing"
)

func TestPathCandidates(t *testing.T) {
	cases := []struct {
		arg  string
		want []string
	}{
		// 绝对路径与显式相对路径都是候选。
		{"/media/in.mkv", []string{"/media/in.mkv"}},
		{"../etc/passwd", []string{"../etc/passwd"}},
		{"./out.mkv", []string{"./out.mkv"}},
		{"subtitles=/a/b.srt", []string{"/a/b.srt"}},
		{"-attach", nil},
		// 滤镜表达式不该被误判成路径。
		{"scale=iw/2", nil},
		{"fps=30", nil},
		{"drawtext=text=hi", nil},
		// 逗号分隔的滤镜链里夹带的路径要能挑出来。
		{"scale=iw/2,subtitles=/a/b.srt", []string{"/a/b.srt"}},
		// ffmpeg 的 filtergraph 会剥掉引号，所以带引号的相对路径同样是路径。
		{`subtitles='../x'`, []string{"../x"}},
		{`subtitles="../../x"`, []string{"../../x"}},

		// Windows 的写法：盘符、UNC、根相对路径，以及它们藏在 = 后面的样子。
		// 盘符那条尤其要紧——C:\… 以字母开头，是唯一需要额外判断的形态。
		{`C:\media\a.mp4`, []string{`C:\media\a.mp4`}},
		{`c:/media/a.mp4`, []string{`c:/media/a.mp4`}},
		{`\\server\share\a.mp4`, []string{`\\server\share\a.mp4`}},
		{`\media\a.mp4`, []string{`\media\a.mp4`}},
		{`..\..\windows\system32\config`, []string{`..\..\windows\system32\config`}},
		{`subtitles=C:\media\subs.srt`, []string{`C:\media\subs.srt`}},
		{`subtitles="C:\media\subs.srt"`, []string{`C:\media\subs.srt`}},
		// 盘符里的冒号不是分隔符，整条路径要作为一个候选留下来。
		{`movie=C:\media\a.mp4:force_style=1`, []string{`C:\media\a.mp4`}},
		// 选项里的冒号仍然照切不误。
		{"-c:v", nil},
	}

	for _, c := range cases {
		got := pathCandidates(c.arg)
		if len(got) == 0 && len(c.want) == 0 {
			continue
		}
		if !reflect.DeepEqual(got, c.want) {
			t.Errorf("pathCandidates(%q) = %#v，期望 %#v", c.arg, got, c.want)
		}
	}
}

// 路径用例全部用 t.TempDir() 现造：写死 /media 这类 POSIX 路径的话，
// 它在 Windows 上指的是当前盘的 \media，与 mediaRoots 里的那一份对不上。
func TestCheckArgsRespectsMediaRoots(t *testing.T) {
	root := t.TempDir()
	outside := t.TempDir()
	s := &Server{mediaRoots: []string{root}}

	in := filepath.Join(root, "in.mkv")
	out := filepath.Join(root, "out.mp4")

	allowed := [][]string{
		{"-hide_banner", "-i", in, "-c:v", "copy", out},
		{"-vf", "scale=1280:-2", out},
	}
	for _, args := range allowed {
		if err := s.checkArgs(args); err != nil {
			t.Errorf("应当放行的参数被拒绝: %v（%v）", args, err)
		}
	}

	// 这几条都是真实可以绕过媒体根目录的写法：
	// 绝对路径、显式相对路径、以及藏在 filter 取值里的路径。
	rejected := [][]string{
		{"-i", filepath.Join(outside, "shadow")},
		{"-i", filepath.Join("..", "..", "etc", "passwd")},
		{"-vf", "subtitles=" + filepath.Join(outside, "passwd")},
		{"-attach", filepath.Join(outside, "id_rsa")},
		{in, filepath.Join(outside, "out.mp4")},
	}
	for _, args := range rejected {
		if err := s.checkArgs(args); err == nil {
			t.Errorf("越界参数未被拒绝: %v", args)
		}
	}
}

func TestCheckArgsUnrestrictedWithoutRoots(t *testing.T) {
	s := &Server{}
	if err := s.checkArgs([]string{"-i", "/etc/shadow"}); err != nil {
		t.Errorf("未配置媒体目录时不应限制路径，得到: %v", err)
	}
}
