package server

import (
	"net/http"
	"regexp"
	"slices"

	"github.com/meehua/ffmpeg-remote-ui/internal/apierr"
	"github.com/meehua/ffmpeg-remote-ui/internal/ffmpeg"
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

// hwNodePattern 限定设备值里能出现哪些字符。
//
// 这个值会拼进 `-init_hw_device <type>=hw:<value>`，也就是 FFmpeg 的 argv，所以
// 不能放开。挡掉的是能改变参数含义的那些写法：逗号是 FFmpeg 自己的选项分隔符
// （`hw,child_device=1` 这类写法就靠它），等号、空白、引号与控制字符同理。留下的
// 字符够覆盖实际会填的东西：DRM 节点路径（/dev/dri/renderD128）、适配器序号（1）、
// X11 显示名（:0）、类型自己的关键字（auto、hw2）。
//
// 注意这里校验的是**写法**不是**含义**：含义由 FFmpeg 解释，且同一个值在不同类型
// 里解释不同（qsv 收到的是 MFX 实现选择符，d3d11va 收到的是 DXGI 适配器序号），
// 程序没有一张表可以拿来对照，只能把写法收窄，把答案留给实测。
var hwNodePattern = regexp.MustCompile(`^[A-Za-z0-9_./:-]{1,128}$`)

// checkHWProbe 校验一组「类型 + 设备值」可以拿去实测。
//
// 必须白名单，不能把请求里的字符串直接拼进命令行：类型与设备值最终都会成为
// FFmpeg 的 argv，放开就等于开了一个任意参数注入的口子。
func checkHWProbe(types []string, probe hwProbeRequest) error {
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
			continue // 空表示不指定，交给 FFmpeg 自己挑。
		}
		if !hwNodePattern.MatchString(node) {
			return apierr.New(apierr.CodeHWNodeInvalid, map[string]any{"node": node},
				"设备值 %s 不是能填进 -init_hw_device 的写法", node)
		}
	}
	return nil
}

// hardwareProbe 逐个实测「这个类型配这个设备值」能不能用。
//
// 判断依据不是程序里的任何推断，而是 FFmpeg 自己初始化设备的结果。同一个数字在
// CUDA 设备序号、DXGI 适配器序号、MFX 实现选择符里各指各的（本机上 qsv 收下 `1`
// 会当成「软件实现」而报 -9，与哪块卡无关），哪一组成立只有 FFmpeg 知道；每个候选
// 的回答连同它自己的原文一起交回界面。
func (s *Server) hardwareProbe(w http.ResponseWriter, r *http.Request) {
	var req hwProbeRequest
	if err := decodeBody(w, r, &req); err != nil {
		writeErr(w, http.StatusBadRequest, err)
		return
	}

	if err := checkHWProbe(s.ff.Snapshot().HWDeviceTypes, req); err != nil {
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
