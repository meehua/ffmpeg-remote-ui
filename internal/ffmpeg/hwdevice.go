package ffmpeg

import "strings"

// HWProbe 是一次「这个硬件设备类型配这个设备值，到底能不能用」的实测结果。
type HWProbe struct {
	// Type 是 -init_hw_device 的类型（qsv、vaapi、cuda…）。
	Type string `json:"type"`
	// Node 是类型后面那一段设备值；空表示不指定，交给 FFmpeg 自己挑。
	Node string `json:"node"`
	// OK 表示 FFmpeg 真的把这台设备初始化起来了。
	OK bool `json:"ok"`
	// Error 是失败时 FFmpeg 自己说的话（取自它的输出，已截断）。
	Error string `json:"error,omitempty"`
}

// ProbeHWDevice 实际初始化一次硬件设备，用 FFmpeg 自己的回答判断这组取值能不能用。
//
// 为什么是实测而不是推断：`-init_hw_device <type>=hw[:<device>]` 里的 <device>
// 是什么意思，由该类型背后的子设备决定——vaapi 收 DRM 节点路径，cuda 收 CUDA
// 设备序号，Windows 上的 qsv / d3d11va 收显示适配器序号。同一个数字在两套编号
// 里指的不是同一块卡（第 1 块 NVIDIA 卡在 CUDA 里是 0，在 Windows 的显示适配器
// 枚举里可能是 1），程序无从推断，只有 FFmpeg 自己知道。
//
// 探测命令行只做设备初始化加一次空转：不指定编码器就不会编出任何东西，也不碰
// 用户的媒体文件。设备初始化是全局选项，失败时 FFmpeg 在解析参数阶段就退出，
// 不会走到后面的转码。
func (s *Service) ProbeHWDevice(deviceType, node string) HWProbe {
	result := HWProbe{Type: deviceType, Node: node}

	value := deviceType + "=hw"
	if node != "" {
		value += ":" + node
	}

	out, err := s.run("-hide_banner", "-init_hw_device", value,
		"-f", "lavfi", "-i", "nullsrc", "-frames:v", "1", "-f", "null", "-")
	if err == nil {
		result.OK = true
		return result
	}
	result.Error = errorExcerpt(out)
	return result
}

// errorExcerpt 从 FFmpeg 的输出里取一段有信息量的错误文本。
//
// 设备初始化失败时原因写在最后几行（例如 "Error creating a MFX session: -9"、
// "CUDA_ERROR_INVALID_DEVICE: invalid device ordinal"），前面还混着与失败无关的
// 提示，所以取尾部。截断按码点算，免得把多字节字符切成半个。
func errorExcerpt(out string) string {
	lines := strings.Split(strings.TrimSpace(out), "\n")
	const keepLines = 6
	if len(lines) > keepLines {
		lines = lines[len(lines)-keepLines:]
	}

	text := strings.TrimSpace(strings.Join(lines, "\n"))
	const limit = 600
	if runes := []rune(text); len(runes) > limit {
		text = string(runes[len(runes)-limit:])
	}
	return text
}
