package ffmpeg

import (
	"fmt"
	"regexp"
	"strings"
)

// 这个文件解析 `ffmpeg -h full` 里的「公共上下文 AVOptions」分节。
//
// 它回答的问题和 parseHelp 不是一回事：
//
//   - `ffmpeg -h encoder=<名>`（parseHelp）回答「这个编码器自己注册了哪些
//     AVOptions」：QSV 的 low_power、x264 的 crf、解码器的 skip_loop_filter
//     都在这里。
//   - 公共上下文分节回答「所有编解码器共享哪些 AVOptions」。global_quality、
//     b、maxrate、bufsize、g、bf、profile、level 这批由 libavcodec 的
//     avcodec_options 表定义、挂在 AVCodecContext 上，任何编码器都能用，
//     但它们**不在** `-h encoder=<名>` 的输出里。
//
// 少了这一层，界面上的「编码器参数」实际只是「编码器私有参数」，
// `-c:v hevc_qsv -global_quality 21` 这种完全合法的命令就永远拼不出来。
//
// 来源只有 `-h full`：实测 FFmpeg 8.0.1 的 `-h` 与 `-h long` 都不含这些分节。
// FFmpeg 也没有 AVOption 的机器可读导出（`-print_graphs_format` 说的是执行图，
// 与参数无关），所以这里仍然解析 help 文本——但判据全部来自 FFmpeg 自己的
// 输出结构（顶格分节、<X>Context 命名、选项行与取值行的缩进差），
// 程序不维护任何参数清单。

// OptionGroup 是 `ffmpeg -h full` 里的一个公共上下文 AVOptions 分节。
type OptionGroup struct {
	// Name 是 FFmpeg 的原文分节名，例如 "AVCodecContext AVOptions"。
	Name string `json:"name"`
	// Component 是从分节名里读出的组件层：codec / format / io / url …
	// 取自 FFmpeg 的命名 `AV<X>Context`，不是本程序定义的分区。
	Component string   `json:"component"`
	Options   []Option `json:"options"`
}

// OptionGroups 是一次查询得到的全部公共上下文分节。
type OptionGroups struct {
	Level  string        `json:"level"`
	Groups []OptionGroup `json:"groups"`
}

// Group 按组件层取一组；没有该层时返回 nil。
//
// 界面按组件层要数据，所以这个查找放在模型上，免得每个调用点各写一遍。
// 同一个组件层目前只有一个分节（FFmpeg 的命名就是这么定的）；真出现两个时
// 这里只返回第一个——那时应当改成遍历 Groups。
func (g OptionGroups) Group(component string) *OptionGroup {
	for i := range g.Groups {
		if g.Groups[i].Component == component {
			return &g.Groups[i]
		}
	}
	return nil
}

var (
	// 顶格的分节标题。`-h full` 用缩进区分「组件分节」与「分节内的选项」：
	// 分节标题顶格，选项至少缩进一格。CLI 自己的分节（"Global options:"…）
	// 与具体组件的私有分节（"libx264 AVOptions"…）同样顶格，所以下面还要
	// 再按名字形态筛一层。
	fullSectionRE = regexp.MustCompile(`^([A-Za-z][A-Za-z0-9 /()._-]*) AVOptions:\s*$`)

	// 公共上下文的名字形态：AVCodecContext / AVFormatContext / AVIOContext /
	// URLContext。判据是 FFmpeg 自己的命名习惯——libav* 把「一组组件共享的
	// 选项」放在 <X>Context 上，把「某个具体组件私有的选项」放在组件名下。
	// 因此这条规则能自动跟上 FFmpeg 新增的上下文层。
	contextSectionRE = regexp.MustCompile(`^(?:AV)?([A-Za-z0-9]+)Context$`)

	// FFmpeg 偶尔把占位符写成 `[<int>     ]`（-side_data_prefer_packet、
	// -view_ids 等）：方括号表示这个参数可选，对解析来说它就是 `<int>`。
	bracketedPlaceholderRE = regexp.MustCompile(`\[(<[^<>]*>)\s*\]`)
)

// normalizeOptionLine 把 `[<int>     ]` 洗成 `<int>`。
//
// 归一化之后再交给共用的 optionRE，等于让所有 help 解析（含 parseHelp）
// 都能吃下这种畸形行；不洗的话它会静默丢掉，而且丢得没有痕迹。
func normalizeOptionLine(line string) string {
	if !strings.Contains(line, "[<") {
		return line
	}
	return bracketedPlaceholderRE.ReplaceAllString(line, "$1")
}

// contextSection 判断一个顶格标题是不是公共上下文分节，并取出组件层。
func contextSection(title string) (name, component string, ok bool) {
	m := fullSectionRE.FindStringSubmatch(title)
	if m == nil {
		return "", "", false
	}
	name = strings.TrimSpace(m[1])
	c := contextSectionRE.FindStringSubmatch(name)
	if c == nil {
		return "", "", false
	}
	return name, strings.ToLower(c[1]), true
}

// parseOptionGroups 从 `ffmpeg -h full` 的输出里抽出公共上下文分节。
//
// 具体组件的私有分节不会被收进来：它们本来就由 `-h <target>=<名>` 更精确地
// 回答，而且 `-h full` 里那些分节的标题是编解码器名（"H.264 encoder"），
// 不是编码器名（libx264），没法可靠地反查回具体编码器。
func parseOptionGroups(raw string) []OptionGroup {
	groups := []OptionGroup{}

	var (
		section *OptionGroup
		last    *Option
	)

	for _, line := range strings.Split(raw, "\n") {
		// Windows 上 ffmpeg 的输出是 CRLF。先剥掉行尾的 \r，否则下面那句
		// 「顶格 ⇒ 分节标题」永远不成立，整份解析会一声不响地空掉
		// （clihelp.go 出于同一个理由也这么做）。
		line = strings.TrimRight(line, "\r")
		trimmed := strings.TrimSpace(line)
		if trimmed == "" {
			last = nil
			continue
		}

		if line == trimmed {
			// 顶格即分节标题。是公共上下文就开新节；否则本节之后的内容
			// 与本次无关（CLI 分节、具体组件的私有分节都在这一支）。
			section, last = nil, nil
			if name, component, ok := contextSection(line); ok {
				groups = append(groups, OptionGroup{
					Name:      name,
					Component: component,
					Options:   []Option{},
				})
				section = &groups[len(groups)-1]
			}
			continue
		}
		if section == nil {
			continue
		}

		if m := optionRE.FindStringSubmatch(normalizeOptionLine(line)); m != nil {
			opt := Option{
				Name:        m[1],
				Type:        m[2],
				Flags:       m[3],
				Description: strings.TrimSpace(m[4]),
				Component:   section.Component,
			}
			finishOption(&opt)
			section.Options = append(section.Options, opt)
			last = &section.Options[len(section.Options)-1]
			continue
		}

		// 枚举取值行：缩进比选项行深一级。
		if last != nil {
			if m := valueRE.FindStringSubmatch(line); m != nil {
				last.Values = append(last.Values, OptionValue{
					Name:        m[1],
					Value:       m[2],
					Description: strings.TrimSpace(m[4]),
				})
			}
		}
	}

	return groups
}

// OptionGroups 返回 FFmpeg 的公共上下文 AVOptions 分节。
//
// 结果按 ffmpeg 二进制缓存（`-h full` 的输出很大，实测 8.0.1 约 1.6 万行），
// Refresh 会把它清掉——换了二进制，这些分节的内容也跟着变。
func (s *Service) OptionGroups() (OptionGroups, error) {
	const level = "full"

	s.helpMu.Lock()
	if g, ok := s.groupCache[level]; ok {
		s.helpMu.Unlock()
		return g, nil
	}
	s.helpMu.Unlock()

	raw, err := s.run("-hide_banner", "-h", level)
	if err != nil {
		return OptionGroups{Level: level, Groups: []OptionGroup{}}, fmt.Errorf("%s -h %s: %w", s.ffmpeg, level, err)
	}

	// 空切片而不是 nil：nil 会序列化成 JSON 的 null，前端读 .length 会抛异常
	// （理由同 Snapshot.normalize）。
	g := OptionGroups{Level: level, Groups: parseOptionGroups(raw)}
	if g.Groups == nil {
		g.Groups = []OptionGroup{}
	}

	s.helpMu.Lock()
	if s.groupCache == nil {
		s.groupCache = map[string]OptionGroups{}
	}
	s.groupCache[level] = g
	s.helpMu.Unlock()
	return g, nil
}
