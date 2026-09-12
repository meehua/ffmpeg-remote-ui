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
// 为什么是实测而不是推断：`-init_hw_device <type>=hw[:<value>]` 里的 <value>
// 是什么意思，由该类型背后的实现自己解释，同一串字符在两种类型里指的不是一回事。
// 已知的三套编号：Windows 上 d3d11va 数的是 DXGI 的物理适配器、cuda 数的是 CUDA
// 设备、Linux 上 vaapi 收的是 DRM 节点路径；而 qsv 收到的根本不是编号，是 MFX 的
// 实现选择符——`qsv=hw:0` 能用、`qsv=hw:1` 报 "Error creating a MFX session: -9"，
// 差别不在哪块卡，而在 0/1 被当成 MFX_IMPL_AUTO / MFX_IMPL_SOFTWARE。
// 这些规则会随 FFmpeg 与驱动变化，程序抄一份下来只会抄错，所以这里只问不猜。
//
// 它只回答「成不成」，不去认这个值落在了哪块卡上：FFmpeg 报不报这件事、怎么报，
// 按类型各不相同（d3d11va 会打印 `Using device 10de:2560 (NVIDIA GeForce RTX 3060
// Laptop GPU)`，cuda 在 verbose、debug、trace 三级日志下都只说它加载了
// cuDeviceGetName 这类符号，从不提设备名），从它的输出里抠设备名只会抠出一层脆壳，
// 而且 qsv 报的还是它自己挑中的子设备，与用户填的那个值不是一回事。设备列表因此由
// 服务器自己的检测给出，实测只负责说哪个值能起来。
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
// 提示，所以取尾部。
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
