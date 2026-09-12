package server

import (
	"errors"
	"strings"
	"testing"

	"github.com/meehua/ffmpeg-remote-ui/internal/apierr"
)

// 类型与设备值最终会成为 FFmpeg 的 argv，所以这里逐个确认白名单挡得住夹带的写法。
//
// 校验只针对写法，不针对含义：同一个值在不同类型里含义不同（qsv 收的是 MFX 实现
// 选择符，d3d11va 收的是 DXGI 适配器序号），所以「这个值对不对」不会在这里拦，
// 而是交给实测。
func TestCheckHWProbe(t *testing.T) {
	types := []string{"qsv", "vaapi", "cuda", "d3d11va"}

	cases := []struct {
		name  string
		probe hwProbeRequest
		ok    bool
		code  apierr.Code
	}{
		{"不指定节点也是合法组合", hwProbeRequest{Type: "qsv", Nodes: []string{""}}, true, ""},
		{"Linux 的节点路径放行", hwProbeRequest{Type: "vaapi", Nodes: []string{"/dev/dri/renderD128"}}, true, ""},
		{"适配器序号放行", hwProbeRequest{Type: "d3d11va", Nodes: []string{"0", "1"}}, true, ""},
		{"类型自己的关键字放行", hwProbeRequest{Type: "qsv", Nodes: []string{"auto", "hw2"}}, true, ""},
		{"X11 显示名放行", hwProbeRequest{Type: "vaapi", Nodes: []string{":0"}}, true, ""},
		{"类型为空", hwProbeRequest{Type: "", Nodes: []string{""}}, false, apierr.CodeHWTypeUnknown},
		{"类型不在 FFmpeg 报告里", hwProbeRequest{Type: "nope", Nodes: []string{""}}, false, apierr.CodeHWTypeUnknown},
		{"类型夹带参数", hwProbeRequest{Type: "qsv=hw:0 -y", Nodes: []string{""}}, false, apierr.CodeHWTypeUnknown},
		{"设备值夹带逗号选项", hwProbeRequest{Type: "qsv", Nodes: []string{"hw,child_device=1"}}, false, apierr.CodeHWNodeInvalid},
		{"设备值带空格", hwProbeRequest{Type: "qsv", Nodes: []string{"0 -y"}}, false, apierr.CodeHWNodeInvalid},
		{"设备值含白名单外的字符", hwProbeRequest{Type: "cuda", Nodes: []string{"0;rm -rf"}}, false, apierr.CodeHWNodeInvalid},
		{"设备值含引号", hwProbeRequest{Type: "cuda", Nodes: []string{`"0"`}}, false, apierr.CodeHWNodeInvalid},
		{"设备值过长", hwProbeRequest{Type: "cuda", Nodes: []string{strings.Repeat("0", 129)}}, false, apierr.CodeHWNodeInvalid},
		{"候选过多", hwProbeRequest{Type: "qsv", Nodes: make([]string, maxHWProbes+1)}, false, apierr.CodeHWTooManyProbes},
	}

	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			err := checkHWProbe(types, c.probe)
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
