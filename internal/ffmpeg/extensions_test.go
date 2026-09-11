package ffmpeg

import (
	"os/exec"
	"testing"
)

func TestExtensionsOf(t *testing.T) {
	cases := []struct {
		name  string
		props []Property
		want  []string
	}{
		{
			// ffmpeg 的真实写法：逗号分隔，末尾带句点。
			"常见扩展名",
			[]Property{{Name: "Common extensions", Value: "mkv,mk3d,mka,mks,webm."}},
			[]string{"mkv", "mk3d", "mka", "mks", "webm"},
		},
		{
			"单个",
			[]Property{{Name: "Common extensions", Value: "mp4."}},
			[]string{"mp4"},
		},
		{
			// 大小写与多余空格都要归一化，否则选择面板里会出现两份同样的扩展名。
			"归一化",
			[]Property{{Name: "Common extensions", Value: " MKV , Mp4 ."}},
			[]string{"mkv", "mp4"},
		},
		{
			// 同一份输出里还有别的属性行，不能被误当成扩展名。
			"不被其它属性干扰",
			[]Property{
				{Name: "Mime type", Value: "video/mp4."},
				{Name: "Common extensions", Value: "mp4."},
				{Name: "Default video codec", Value: "h264."},
			},
			[]string{"mp4"},
		},
		{"没有这一行", []Property{{Name: "Mime type", Value: "video/mp4."}}, nil},
	}
	for _, c := range cases {
		got := extensionsOf(Help{Properties: c.props})
		if len(got) != len(c.want) {
			t.Errorf("%s: %v，期望 %v", c.name, got, c.want)
			continue
		}
		for i := range got {
			if got[i] != c.want[i] {
				t.Errorf("%s: %v，期望 %v", c.name, got, c.want)
				break
			}
		}
	}
}

func TestExtensionsRejectsUnknownTarget(t *testing.T) {
	service := &Service{}
	if _, err := service.Extensions("codec"); err == nil {
		t.Error("未知方向应当报错")
	}
}

// TestExtensionsAgainstRealFFmpeg 确认整条链路：拿组件列表、逐个 -h、
// 汇总去重。只有本机装了 ffmpeg 时才跑。
func TestExtensionsAgainstRealFFmpeg(t *testing.T) {
	path, err := exec.LookPath("ffmpeg")
	if err != nil {
		t.Skip("本机没有 ffmpeg")
	}
	service := NewService(path, "ffprobe")

	result, err := service.Extensions("demuxer")
	if err != nil {
		t.Fatalf("Extensions 失败: %v", err)
	}
	if result.Components == 0 || len(result.Extensions) == 0 {
		t.Fatalf("没有汇总出任何扩展名: %+v", result)
	}
	sample := result.Extensions
	if len(sample) > 5 {
		sample = sample[:5]
	}
	t.Logf("demuxer: %d 个组件里有 %d 个报了扩展名，汇总出 %d 个（例：%v）",
		result.Components, result.WithExtensions, len(result.Extensions), sample)

	// 这几个是很常见的容器扩展名，ffmpeg 自己也这么说；如果连它们都没有，
	// 说明解析或汇总出了问题。
	has := map[string]bool{}
	for _, ext := range result.Extensions {
		has[ext] = true
	}
	for _, want := range []string{"mkv", "mp4", "mov", "avi"} {
		if !has[want] {
			t.Errorf("汇总结果里缺少 %q", want)
		}
	}

	// 第二次调用应当命中缓存：这里只确认它仍然返回同样的结果。
	again, err := service.Extensions("demuxer")
	if err != nil || len(again.Extensions) != len(result.Extensions) {
		t.Errorf("缓存后的结果不一致: %v / %v", err, len(again.Extensions))
	}
}
