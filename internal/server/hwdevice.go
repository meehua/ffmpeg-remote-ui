package server

import (
	"net/http"
	"slices"

	"github.com/meehua/ffmpeg-remote-ui/internal/apierr"
	"github.com/meehua/ffmpeg-remote-ui/internal/ffmpeg"
	"github.com/meehua/ffmpeg-remote-ui/internal/hardware"
)

// maxHWProbes 限制一次实测能试多少个候选。
//
// 每个候选背后是一个真实的 FFmpeg 进程，而设备初始化本身有开销（Linux 上要开
// DRM 节点、Windows 上要起 D3D11 与 MFX），所以一次请求不许无限试下去。
const maxHWProbes = 8

// hwProbeRequest 是 POST /api/hardware/probe 的请求体。
type hwProbeRequest struct {
	// Type 是 -init_hw_device 的类型，必须来自 `ffmpeg -init_hw_device list`。
	Type string `json:"type"`
	// Nodes 是要逐个试的设备值；空串表示不指定节点，交给 FFmpeg 自己挑。
	Nodes []string `json:"nodes"`
}

// checkHWProbe 校验一组「类型 + 设备值」确实是服务器报告过的取值。
//
// 必须白名单，不能把请求里的字符串直接拼进命令行：类型与节点最终会成为 FFmpeg
// 的 argv，放开就等于开了一个任意参数注入的口子。候选只有两个来源——快照里的
// HWDeviceTypes，以及 /api/hardware 报出来的那些设备的 HwNode。
func checkHWProbe(types []string, devices []hardware.Device, probe hwProbeRequest) error {
	if probe.Type == "" {
		return apierr.Newf(apierr.CodeHWTypeUnknown, "没有指定硬件设备类型")
	}
	if !slices.Contains(types, probe.Type) {
		return apierr.New(apierr.CodeHWTypeUnknown, map[string]any{"type": probe.Type},
			"未知的硬件设备类型: %s", probe.Type)
	}
	if len(probe.Nodes) > maxHWProbes {
		return apierr.New(apierr.CodeHWTooManyProbes, map[string]any{"max": maxHWProbes},
			"一次最多实测 %d 个设备", maxHWProbes)
	}
	for _, node := range probe.Nodes {
		if node == "" {
			continue // 空表示不指定节点，不需要在设备清单里找得到。
		}
		if !hwNodeKnown(devices, node) {
			return apierr.New(apierr.CodeHWNodeUnknown, map[string]any{"node": node},
				"这台服务器没有报告过设备节点 %s", node)
		}
	}
	return nil
}

// hwNodeKnown 判断某个设备值是不是设备清单里报告过的。
func hwNodeKnown(devices []hardware.Device, node string) bool {
	for _, device := range devices {
		if device.HwNode == node {
			return true
		}
	}
	return false
}

// hardwareProbe 逐个实测「这个类型配这个设备值」能不能用。
//
// 判断依据不是程序里的任何推断，而是 FFmpeg 自己初始化设备的结果：同一个数字在
// CUDA 设备序号与 Windows 显示适配器序号里指的不是同一块卡，哪一组成立只有它知道。
func (s *Server) hardwareProbe(w http.ResponseWriter, r *http.Request) {
	var req hwProbeRequest
	if err := decodeBody(w, r, &req); err != nil {
		writeErr(w, http.StatusBadRequest, err)
		return
	}

	devices := hardware.DiscoverRenderNodes()
	if err := checkHWProbe(s.ff.Snapshot().HWDeviceTypes, devices, req); err != nil {
		writeErr(w, http.StatusBadRequest, err)
		return
	}

	// 串行实测：同时初始化多台硬件设备容易互相干扰（驱动侧的会话数本来有限），
	// 而候选数量已经由 maxHWProbes 压住了。
	results := make([]ffmpeg.HWProbe, 0, len(req.Nodes))
	for _, node := range req.Nodes {
		results = append(results, s.ff.ProbeHWDevice(req.Type, node))
	}
	write(w, map[string]any{"type": req.Type, "results": results})
}
