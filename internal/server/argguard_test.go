package server

import (
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

func TestCheckArgsRespectsMediaRoots(t *testing.T) {
	s := &Server{mediaRoots: []string{"/media"}}

	allowed := [][]string{
		{"-hide_banner", "-i", "/media/in.mkv", "-c:v", "copy", "/media/out.mp4"},
		{"-vf", "scale=1280:-2", "/media/out.mp4"},
	}
	for _, args := range allowed {
		if err := s.checkArgs(args); err != nil {
			t.Errorf("应当放行的参数被拒绝: %v（%v）", args, err)
		}
	}

	// 这几条都是真实可以绕过媒体根目录的写法：
	// 绝对路径、显式相对路径、以及藏在 filter 取值里的路径。
	rejected := [][]string{
		{"-i", "/etc/shadow"},
		{"-i", "../../etc/passwd"},
		{"-vf", "subtitles=/etc/passwd"},
		{"-attach", "/root/.ssh/id_rsa"},
		{"/media/in.mkv", "/etc/out.mp4"},
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
