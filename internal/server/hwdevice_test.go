package server

import (
	"errors"
	"testing"

	"github.com/meehua/ffmpeg-remote-ui/internal/apierr"
	"github.com/meehua/ffmpeg-remote-ui/internal/hardware"
)

// 类型与节点最终会成为 FFmpeg 的 argv，所以这里逐个确认白名单挡得住夹带的写法。
func TestCheckHWProbe(t *testing.T) {
	types := []string{"qsv", "vaapi", "cuda"}
	devices := []hardware.Device{
		{ID: "drm:renderD128", HwNode: "/dev/dri/renderD128"},
		{ID: "display:0000", HwNode: "0"},
	}

	cases := []struct {
		name  string
		probe hwProbeRequest
		ok    bool
		code  apierr.Code
	}{
		{"不指定节点也是合法组合", hwProbeRequest{Type: "qsv", Nodes: []string{""}}, true, ""},
		{"Linux 的节点路径放行", hwProbeRequest{Type: "vaapi", Nodes: []string{"/dev/dri/renderD128"}}, true, ""},
		{"Windows 的适配器序号同样放行", hwProbeRequest{Type: "qsv", Nodes: []string{"0"}}, true, ""},
		{"类型为空", hwProbeRequest{Type: "", Nodes: []string{""}}, false, apierr.CodeHWTypeUnknown},
		{"类型不在 FFmpeg 报告里", hwProbeRequest{Type: "nope", Nodes: []string{""}}, false, apierr.CodeHWTypeUnknown},
		{"类型夹带参数", hwProbeRequest{Type: "qsv=hw:0 -y", Nodes: []string{""}}, false, apierr.CodeHWTypeUnknown},
		{"节点不在服务器清单里", hwProbeRequest{Type: "qsv", Nodes: []string{"--evil"}}, false, apierr.CodeHWNodeUnknown},
		{"候选过多", hwProbeRequest{Type: "qsv", Nodes: make([]string, maxHWProbes+1)}, false, apierr.CodeHWTooManyProbes},
	}

	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			err := checkHWProbe(types, devices, c.probe)
			if c.ok {
				if err != nil {
					t.Fatalf("应当放行，实际报错: %v", err)
				}
				return
			}

			var apiErr *apierr.Error
			if !errors.As(err, &apiErr) {
				t.Fatalf("应当报带码的错误，实际: %v", err)
			}
			if apiErr.Code != c.code {
				t.Errorf("错误码 = %q，期望 %q", apiErr.Code, c.code)
			}
		})
	}
}
