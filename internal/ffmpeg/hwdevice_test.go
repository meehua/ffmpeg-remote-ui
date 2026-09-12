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

// 纯函数，不需要 ffmpeg：成功时也要把 FFmpeg 自己说的话带回来——用户靠它认出
// 「这个值指的是哪块设备」，正是界面没有能力回答的那个问题。
func TestHWLogLinesStopAtInput(t *testing.T) {
	out := strings.Join([]string{
		"[D3D11VA @ 000001f7b1aca700] Selecting d3d11va adapter 1",
		"[D3D11VA @ 000001f7b1aca700] Using device 8086:9a60 (Intel(R) UHD Graphics).",
		"[QSV @ 000001f7b1aca980] Error creating a MFX session: -9.",
		"Input #0, lavfi, from 'nullsrc':",
		"  Duration: N/A, start: 0.000000, bitrate: N/A",
		"[Parsed_nullsrc_0 @ 000001f4ff11a140] size:320x240 rate:25/1 duration:-1.000000 sar:1/1",
		"Stream mapping:",
	}, "\n")

	lines := hwLogLines(out)
	text := strings.Join(lines, "\n")
	for _, want := range []string{"Selecting d3d11va adapter 1", "Using device 8086:9a60", "MFX session: -9"} {
		if !strings.Contains(text, want) {
			t.Errorf("应当保留 %q，实际 %q", want, text)
		}
	}
	// "Input #0" 之后是转码运行期的编排，与该值落在哪块设备上无关；
	// 失败时 FFmpeg 走不到打开输入，那一段本来就整段留着。
	for _, unwanted := range []string{"Input #0", "Stream mapping", "Duration: N/A", "Parsed_nullsrc_0"} {
		if strings.Contains(text, unwanted) {
			t.Errorf("应当丢掉普通输出 %q，实际 %q", unwanted, text)
		}
	}

	// 界面要显示的就是这一段：哪块卡，以及失败时最后那句话。
	if got := deviceFromLogs(lines); got != "8086:9a60 (Intel(R) UHD Graphics)" {
		t.Errorf("deviceFromLogs = %q，期望把 `Using device ` 之后那段搬过来", got)
	}
	if got := logBody("[QSV @ 000001f7b1aca980] Error creating a MFX session: -9."); got != "Error creating a MFX session: -9." {
		t.Errorf("logBody = %q，期望去掉组件前缀", got)
	}
}

func TestDeviceFromLogsWithoutDeviceLine(t *testing.T) {
	// cuda 不打印 "Using device"，取不到就留空——界面那时退回展示原文，
	// 而不是显示一个程序编出来的设备名。
	lines := []string{
		"[CUDA @ 00000247f0100dc0] cu->cuDeviceGet(&hwctx->internal->cuda_device, device_idx) failed -> CUDA_ERROR_INVALID_DEVICE: invalid device ordinal",
	}
	if got := deviceFromLogs(lines); got != "" {
		t.Errorf("应当留空，实际 %q", got)
	}
}

func TestHWLogLinesHandlesEmpty(t *testing.T) {
	if got := hwLogLines(""); len(got) != 0 {
		t.Errorf("空输出应得到空切片，实际 %q", got)
	}
	if got := excerpt(nil, outputLimit); got != "" {
		t.Errorf("空行应拼成空串，实际 %q", got)
	}
}
