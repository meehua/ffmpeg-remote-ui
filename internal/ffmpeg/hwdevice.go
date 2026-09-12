package ffmpeg

import (
	"regexp"
	"strings"
)

// HWProbe 是一次「这个硬件设备类型配这个设备值，到底能不能用」的实测结果。
type HWProbe struct {
	// Type 是 -init_hw_device 的类型（qsv、vaapi、cuda…）。
	Type string `json:"type"`
	// Node 是类型后面那一段设备值；空表示不指定，交给 FFmpeg 自己挑。
	Node string `json:"node"`
	// OK 表示 FFmpeg 真的把这台设备初始化起来了。
	OK bool `json:"ok"`
	// Device 是 FFmpeg 自己说的「这个值落在了哪块设备上」，界面靠它回答
	// 「0 是哪块卡、1 是哪块卡」。
	//
	// 它取自 FFmpeg 的日志行 `Using device 8086:9a60 (Intel(R) UHD Graphics).`，
	// 只把 `Using device ` 之后那一段搬过来（行尾句号去掉），不解释也不推断：
	// 这个问题的答案只有 FFmpeg 有。有些类型根本不打印这行（cuda 就是），
	// 取不到就留空，界面那时退回展示原文。
	Device string `json:"device,omitempty"`
	// Note 是这次初始化最后落下的一句话，失败时它就是原因本身
	// （"Error creating a MFX session: -9."，组件前缀已去掉）。
	Note string `json:"note,omitempty"`
	// Output 是 FFmpeg 就这次初始化说过的话，原样截取，成功也给。
	//
	// 它是上面两个字段的来源，也是它们取不到时的退路：界面上收在「原文」里，
	// 想刨根问底的人自己展开。
	Output string `json:"output,omitempty"`
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
// 探测命令行只做设备初始化加一次空转：不指定编码器就不会编出任何东西，也不碰
// 用户的媒体文件。设备初始化是全局选项，失败时 FFmpeg 在解析参数阶段就退出，
// 不会走到后面的转码。log 级别提到 verbose，是为了让 FFmpeg 把「挑了哪个适配器」
// 这类只在 verbose 下才说的话也说全——那些话正是用户判断取值含义的依据。
func (s *Service) ProbeHWDevice(deviceType, node string) HWProbe {
	result := HWProbe{Type: deviceType, Node: node}

	value := deviceType + "=hw"
	if node != "" {
		value += ":" + node
	}

	out, err := s.run("-hide_banner", "-v", "verbose", "-init_hw_device", value,
		"-f", "lavfi", "-i", "nullsrc", "-frames:v", "1", "-f", "null", "-")

	logs := hwLogLines(out)
	result.Output = excerpt(logs, outputLimit)
	result.Device = deviceFromLogs(logs)

	if err == nil {
		result.OK = true
		return result
	}
	result.Error = errorExcerpt(out)
	// 失败时 FFmpeg 的最后一句话就是原因，它说完这句就退出了。
	if len(logs) > 0 {
		result.Note = logBody(logs[len(logs)-1])
	}
	return result
}

// hwLogLine 匹配 FFmpeg 自己的日志行，形如 `[QSV @ 000001f72adc71c0] 内容`；
// 捕获组是去掉组件前缀后的正文。
var hwLogLine = regexp.MustCompile(`^\[[^\]]+ @ [0-9a-fA-Fx]+\] (.*)$`)

// hwLogLines 取出这次初始化里 FFmpeg 自己说的话，保持它写的样子（含组件前缀）。
//
// 设备初始化发生在解析全局选项时，所以这些话都在输出的最前面，且都在打开输入
// 之前——"Input #0" 之后就是转码运行期的编排（"Parsed_nullsrc_0"、"out#0/null"
// 之类），与「这个值落在哪块设备上」无关。失败时 FFmpeg 根本走不到打开输入，
// 整段都留着。行的形状是 FFmpeg 稳定的输出结构，程序照着切开，不解释内容。
func hwLogLines(out string) []string {
	if i := strings.Index(out, "Input #"); i >= 0 {
		out = out[:i]
	}

	var lines []string
	for _, line := range strings.Split(out, "\n") {
		line = strings.TrimRight(line, "\r")
		if line == "" {
			continue
		}
		// 非日志行（"Device creation failed: …"、"Failed to set value …"）也留着：
		// 失败时它们排在原因后面，是 FFmpeg 把话说完的部分。
		lines = append(lines, line)
	}

	const keepLines = 10
	if len(lines) > keepLines {
		lines = lines[:keepLines]
	}
	return lines
}

// logBody 去掉日志行的 "[组件 @ 地址] " 前缀；不是日志行就原样返回。
func logBody(line string) string {
	if m := hwLogLine.FindStringSubmatch(line); m != nil {
		return m[1]
	}
	return line
}

// deviceFromLogs 从日志里挑出 FFmpeg 报的「用的是哪块设备」。
//
// 认的是它自己的写法 `Using device 8086:9a60 (Intel(R) UHD Graphics).`：只把
// `Using device ` 之后那一段搬给界面（行尾的句号去掉），不解释、不推断。没有这行
// 的类型（cuda 就是这样）返回空串，界面会退回展示原文。
func deviceFromLogs(lines []string) string {
	const prefix = "Using device "
	for _, line := range lines {
		body := logBody(line)
		if strings.HasPrefix(body, prefix) {
			return strings.TrimSuffix(strings.TrimSpace(strings.TrimPrefix(body, prefix)), ".")
		}
	}
	return ""
}

// excerpt 把若干行拼成一段，超长就按码点截断（免得把多字节字符切成半个）。
func excerpt(lines []string, limit int) string {
	text := strings.Join(lines, "\n")
	if runes := []rune(text); len(runes) > limit {
		return string(runes[:limit])
	}
	return text
}

// outputLimit 是「原文」那一段保留多少码点。
const outputLimit = 800

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
