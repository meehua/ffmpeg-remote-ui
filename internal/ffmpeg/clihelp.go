package ffmpeg

import (
	"fmt"
	"regexp"
	"strings"

	"github.com/meehua/ffmpeg-remote-ui/internal/apierr"
)

// 这个文件解析的是 `ffmpeg -h` / `-h long` / `-h full`。
//
// 它和 parseHelp 描述的不是一回事：parseHelp 回答「某个组件有哪些参数」，
// 这里回答「ffmpeg 的命令行由哪几段组成、每段有哪些选项」。后者决定了界面
// 上控件该怎么摆，所以这份输出是能力查询里最"元"的一层——界面结构直接
// 跟着它走，程序自己不发明分类。
//
// 只做结构解析：分节标题、选项名、占位符、说明。哪个选项有用、该不该出现，
// 一律不判断，那是 ffmpeg 在标题里已经写清楚的事。

// cliLevels 是 `ffmpeg -h` 承认的详略级别；空串是 ffmpeg 的默认档。
var cliLevels = map[string]bool{"": true, "long": true, "full": true}

// ValidLevel 报告 level 是否是 `ffmpeg -h` 承认的详略档位。
//
// 供接口层在调用之前先挡掉写错的参数：那是请求写错了（400），不是 ffmpeg
// 出问题（502），两者的排查方向完全不同。
func ValidLevel(level string) bool {
	return cliLevels[strings.ToLower(strings.TrimSpace(level))]
}

// CliHelp 是 `ffmpeg -h [level]` 的结构化结果：ffmpeg 命令行本身的拓扑。
type CliHelp struct {
	Level    string       `json:"level"`
	Sections []CliSection `json:"sections"`
	Raw      string       `json:"raw"`
}

// CliSection 是 ffmpeg 帮助里的一个分节。
type CliSection struct {
	// Name 是 ffmpeg 的原文标题，例如 "Advanced per-file options (input-only)"。
	// 界面直接显示这句话，因此措辞永远跟着 ffmpeg 走。
	Name string `json:"name"`
	// Scope 是从标题里读出的作用范围，决定这组控件落在命令行的哪一段：
	// global / input / output / both / stream / other。
	Scope string `json:"scope"`
	// Media 是从标题里读出的媒体类型（video/audio/subtitle/data）；
	// 通用分节为空。空串同样表示「标题里没说」。
	Media string `json:"media,omitempty"`
	// Spec 是媒体类型对应的流定位符（v/a/s/d）。它是命令行语法，不是能力判断。
	Spec    string      `json:"spec,omitempty"`
	Options []CliOption `json:"options"`
}

// CliOption 是命令行上的一个选项。
type CliOption struct {
	// Name 不含前导 "-"，与 ffmpeg 输出一致。
	Name string `json:"name"`
	// StreamSpec 表示 ffmpeg 允许它带 :<stream_spec> 后缀（原文 "-c[:<stream_spec>]"）。
	StreamSpec bool `json:"streamSpec,omitempty"`
	// TakesValue 表示它需要取值；ffmpeg 用 <...> 占位符表示这一点，
	// 因此开关型选项就是没有占位符的那些。
	TakesValue  bool   `json:"takesValue,omitempty"`
	Placeholder string `json:"placeholder,omitempty"`
	Description string `json:"description,omitempty"`
}

var (
	// 分节标题：顶格、以冒号结尾。缩进的行是选项，所以这个限制足够区分。
	cliSectionRE = regexp.MustCompile(`^([A-Za-z][A-Za-z0-9 /()\-,.]*):\s*$`)
	// 选项行："-名字" + 可选 "[:<spec>]" + 可选 "<占位符>"，之后至少有 2 个
	// 空格才进入说明——那正是 ffmpeg 用来对齐的一列。
	//
	// 缩进必须放宽到 0：同一份输出里各分节的缩进并不一致（"Getting help:"
	// 下的选项缩进 4 格，而 "Per-file options:" 下的顶格）。
	cliOptionRE = regexp.MustCompile(`^\s{0,6}-([^\s<\[-][^\s<\[]*)(\[:[^\]]*\])?(\s+<[^>]*>)?\s{2,}(.*)$`)
	// 少数选项没有说明（例如 "-re <>"），单独收一次。
	cliBareRE = regexp.MustCompile(`^\s{0,6}-([^\s<\[-][^\s<\[]*)(\[:[^\]]*\])?(\s+<[^>]*>)?\s*$`)
)

// CliHelp 返回 ffmpeg 的命令行拓扑；level 为空时用 ffmpeg 的默认档。
func (s *Service) CliHelp(level string) (CliHelp, error) {
	level = strings.ToLower(strings.TrimSpace(level))
	if !cliLevels[level] {
		return CliHelp{}, apierr.New(apierr.CodeFFmpegLevelUnsupported,
			map[string]any{"level": level}, "不支持的详略级别: %s（可用：空、long、full）", level)
	}

	s.helpMu.Lock()
	if h, ok := s.cliCache[level]; ok {
		s.helpMu.Unlock()
		return h, nil
	}
	s.helpMu.Unlock()

	args := []string{"-hide_banner", "-h"}
	if level != "" {
		args = append(args, level)
	}
	raw, err := s.run(args...)
	if err != nil {
		// 正文是 ffmpeg 自己的报错，照原样交回，不翻译。
		return CliHelp{Level: level, Raw: raw}, fmt.Errorf("%s -h %s: %w", s.ffmpeg, level, err)
	}

	h := parseCliHelp(level, raw)
	s.helpMu.Lock()
	if s.cliCache == nil {
		s.cliCache = map[string]CliHelp{}
	}
	s.cliCache[level] = h
	s.helpMu.Unlock()
	return h, nil
}

func parseCliHelp(level, raw string) CliHelp {
	// 空切片而不是 nil：nil 会序列化成 JSON 的 null，前端对 null 读 .length
	// 会抛异常，把整棵 React 树带下去（详细理由见 Snapshot.normalize）。
	help := CliHelp{Level: level, Raw: raw, Sections: []CliSection{}}

	var section *CliSection
	var last *CliOption

	for _, line := range strings.Split(raw, "\n") {
		line = strings.TrimRight(line, "\r")
		if strings.TrimSpace(line) == "" {
			last = nil
			continue
		}

		if m := cliSectionRE.FindStringSubmatch(line); m != nil {
			help.Sections = append(help.Sections, newCliSection(m[1]))
			section = &help.Sections[len(help.Sections)-1]
			last = nil
			continue
		}
		if section == nil {
			continue // 第一个分节之前的用法说明
		}

		if m := cliOptionRE.FindStringSubmatch(line); m != nil {
			section.Options = append(section.Options, newCliOption(m...))
			last = &section.Options[len(section.Options)-1]
			continue
		}
		if m := cliBareRE.FindStringSubmatch(line); m != nil {
			section.Options = append(section.Options, newCliOption(m...))
			last = &section.Options[len(section.Options)-1]
			continue
		}
		// 续行：说明太长折到下一行时，接回上一项，而不是丢掉。
		if last != nil {
			last.Description = strings.TrimSpace(last.Description + " " + strings.TrimSpace(line))
		}
	}
	return help
}

func newCliSection(title string) CliSection {
	s := CliSection{Name: title, Scope: cliScope(title), Options: []CliOption{}}
	s.Media, s.Spec = cliMedia(title)
	return s
}

// newCliOption 从正则的分组里拼出一个选项。分组依次是名字、[:<spec>]、<占位符>、说明。
func newCliOption(groups ...string) CliOption {
	opt := CliOption{Name: groups[1]}
	if groups[2] != "" {
		opt.StreamSpec = true
	}
	if placeholder := strings.TrimSpace(groups[3]); placeholder != "" {
		opt.TakesValue = true
		opt.Placeholder = placeholder
	}
	if len(groups) > 4 {
		opt.Description = strings.TrimSpace(groups[4])
	}
	return opt
}

// cliScope 从分节标题里读出作用范围。
//
// 判断依据全部是 ffmpeg 自己写在标题里的措辞（"input-only"、"output-only"、
// "input and output"、"Global" …），程序不额外定义分类。从具体到宽松地判断，
// 因为 "(input and output)" 也包含 "input" 这个词。
func cliScope(title string) string {
	lower := strings.ToLower(title)
	switch {
	case strings.Contains(lower, "input and output"):
		return "both"
	case strings.Contains(lower, "input-only"):
		return "input"
	case strings.Contains(lower, "output-only"):
		return "output"
	case strings.Contains(lower, "global"):
		return "global"
	case strings.Contains(lower, "per-stream"):
		return "stream"
	case mediaOf(lower) != "":
		return "stream"
	default:
		return "other"
	}
}

// cliMedia 读出分节对应的媒体类型与流定位符。
func cliMedia(title string) (media, spec string) {
	media = mediaOf(strings.ToLower(title))
	return media, mediaSpec[media]
}

func mediaOf(lower string) string {
	for _, media := range mediaOrder {
		if strings.Contains(lower, media) {
			return media
		}
	}
	return ""
}

// mediaOrder 决定 mediaOf 的匹配顺序：先长后短，避免子串互相抢先。
var mediaOrder = []string{"subtitle", "video", "audio", "data"}

// mediaSpec 是媒体类型的流定位符单字母写法。
//
// 它是 ffmpeg 命令行语法的一部分（`ffmpeg -h` 的说明里写着
// "v/a/s for video/audio/subtitle"），不是能力判断依据：任何"这台机器能不能
// 编 HEVC"之类的问题，答案依然只来自 FFmpeg 的运行时报告。
var mediaSpec = map[string]string{
	"video":    "v",
	"audio":    "a",
	"subtitle": "s",
	"data":     "d",
}
