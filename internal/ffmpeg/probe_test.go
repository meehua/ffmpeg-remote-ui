package ffmpeg

import (
	"os/exec"
	"sort"
	"testing"
)

// 这个文件对真实 FFmpeg 做一次「探查」：把两处来源摆在一起看它们的并集，
// 因为界面上的「编码器参数」正是这个并集——
//
//	`-h encoder=<名>`           编码器自己注册的参数（x264 的 crf、qsv 的 low_power）
//	`-h full` 的公共上下文分节   libavcodec 共享的参数（global_quality、b、profile…）
//
// 少了第二层，FFmpeg 明明支持的参数就会从界面上消失；`-c:v hevc_qsv
// -global_quality 21` 正是这种情况。单元级的断言在 optiongroups_test.go 里，
// 这里记的是「两层各自有什么」这个事实本身。

// encoderParamSources 收集一个编码器在两处来源里各自的参数名。
func encoderParamSources(t *testing.T, s *Service, name string) (private, common []string) {
	t.Helper()

	h, err := s.Help("encoder", name)
	if err != nil {
		t.Fatalf("Help(encoder, %s) 失败: %v", name, err)
	}
	for _, o := range h.Options {
		private = append(private, o.Name)
	}

	groups, err := s.OptionGroups()
	if err != nil {
		t.Fatalf("OptionGroups 失败: %v", err)
	}
	codec := groups.Group("codec")
	if codec == nil {
		t.Fatal("公共上下文层里没有 codec 组")
	}
	for _, o := range codec.Options {
		if o.Scope == "encoding" || o.Scope == "shared" {
			common = append(common, o.Name)
		}
	}
	sort.Strings(private)
	sort.Strings(common)
	return private, common
}

// TestEncoderAndCodecContextLayers 覆盖用户报告里点名的几组：软件 H.264/HEVC、
// Intel QSV、音频编码器。每一组的第二列参数都**只**来自公共上下文层——
// 这正是「FFmpeg 支持、旧界面却看不到」的那批。
func TestEncoderAndCodecContextLayers(t *testing.T) {
	path, err := exec.LookPath("ffmpeg")
	if err != nil {
		t.Skip("本机没有 ffmpeg")
	}
	service := NewService(path, "ffprobe")

	// private 是必须来自编码器私有层的参数，shared 是必须来自公共上下文层的。
	cases := []struct {
		encoder string
		private []string
		shared  []string
	}{
		{"libx264", []string{"crf", "preset", "tune"}, []string{"global_quality", "b", "maxrate", "bufsize"}},
		{"libx265", []string{"crf", "preset"}, []string{"global_quality", "b"}},
		{"hevc_qsv", []string{"low_power", "async_depth", "preset"}, []string{"global_quality", "b", "maxrate", "bufsize", "profile", "level"}},
		{"h264_qsv", []string{"low_power", "async_depth"}, []string{"global_quality", "b", "maxrate"}},
		{"aac", nil, []string{"b", "profile"}},
		{"libopus", nil, []string{"b"}},
	}

	for _, c := range cases {
		private, common := encoderParamSources(t, service, c.encoder)
		inPrivate := map[string]bool{}
		for _, n := range private {
			inPrivate[n] = true
		}
		inCommon := map[string]bool{}
		for _, n := range common {
			inCommon[n] = true
		}

		for _, want := range c.private {
			if !inPrivate[want] {
				t.Errorf("%s：编码器私有层里没有 %s", c.encoder, want)
			}
		}
		for _, want := range c.shared {
			if !inCommon[want] {
				t.Errorf("%s：公共上下文层里没有 %s", c.encoder, want)
			}
		}
		t.Logf("%s：私有层 %d 项，公共上下文层 %d 项", c.encoder, len(private), len(common))
	}
}

// TestEncoderAndCodecContextUnionIsUsable 确认并集不是空的：界面把两层拼起来
// 之后，属于这个媒体类型的参数确实有东西可填。
func TestEncoderAndCodecContextUnionIsUsable(t *testing.T) {
	path, err := exec.LookPath("ffmpeg")
	if err != nil {
		t.Skip("本机没有 ffmpeg")
	}
	service := NewService(path, "ffprobe")
	private, common := encoderParamSources(t, service, "hevc_qsv")
	if len(private) == 0 || len(common) == 0 {
		t.Fatalf("两层里有一层是空的：private=%d common=%d", len(private), len(common))
	}
}
