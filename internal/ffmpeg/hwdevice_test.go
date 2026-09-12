package ffmpeg

import (
	"os/exec"
	"strings"
	"testing"
)

// 未知类型一定初始化不起来，所以这个用例不需要机器上有 GPU，只需要有 ffmpeg：
// 它验证的是「探测真的在问 FFmpeg」以及失败时把原文带回来。
func TestProbeHWDeviceRejectsUnknownType(t *testing.T) {
	path, err := exec.LookPath("ffmpeg")
	if err != nil {
		t.Skip("本机没有 ffmpeg")
	}
	service := NewService(path, "ffprobe")

	probe := service.ProbeHWDevice("no_such_hw_device_type", "")
	if probe.OK {
		t.Fatal("不存在的设备类型不该报成功")
	}
	if probe.Error == "" {
		t.Error("失败时应带上 FFmpeg 的原文")
	}
	if probe.Type != "no_such_hw_device_type" {
		t.Errorf("Type = %q，期望原样带回", probe.Type)
	}
}

func TestErrorExcerptKeepsTail(t *testing.T) {
	// 纯函数，不需要 ffmpeg：失败原因在尾部，头部那些无关提示该被丢掉。
	out := "line1\nline2\nline3\nline4\nline5\nline6\nline7\nlast error"
	got := errorExcerpt(out)
	if !strings.Contains(got, "last error") {
		t.Errorf("应当保留尾部，实际 %q", got)
	}
	if strings.Contains(got, "line1") {
		t.Errorf("应当丢掉头部，实际 %q", got)
	}
}

func TestErrorExcerptHandlesEmpty(t *testing.T) {
	if got := errorExcerpt(""); got != "" {
		t.Errorf("空输出应得到空串，实际 %q", got)
	}
}
