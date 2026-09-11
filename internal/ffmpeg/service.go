// Package ffmpeg 把运行中的 FFmpeg/FFprobe 当作能力的唯一事实来源。
//
// 本包不含任何内置能力表：编码器、解码器、滤镜、格式、协议、硬件加速
// 方法，以及各组件的参数、取值、默认值与取值范围，全部来自对 ffmpeg
// 二进制的运行时查询。结构化结果旁边始终保留原始输出（Help.Raw），
// 因此 FFmpeg 升级后新增的能力会立即出现在界面上，无需改代码。
//
// 解析只依赖 FFmpeg 已公开且稳定的输出结构（列的含义、flags 列的位置），
// 不依赖任何具体组件名。
package ffmpeg

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os/exec"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

// ---------------------------------------------------------------- 能力列表

// Item 是 FFmpeg 列表型输出（-encoders/-filters/-pix_fmts/...）中的一行。
type Item struct {
	Flags       string `json:"flags,omitempty"`
	Name        string `json:"name"`
	Description string `json:"description,omitempty"`
	// Columns 是名称之后按原顺序保留的各列，供界面按需呈现。
	Columns []string       `json:"columns,omitempty"`
	Extra   map[string]any `json:"extra,omitempty"`
}

// Snapshot 是某一时刻 FFmpeg 暴露的全部能力。
type Snapshot struct {
	GeneratedAt time.Time `json:"generatedAt"`
	FFmpegPath  string    `json:"ffmpegPath"`
	FFprobePath string    `json:"ffprobePath"`
	Version     string    `json:"version"`
	BuildConfig string    `json:"buildConfig"`
	HWAccels    []string  `json:"hwaccels"`
	// HWDeviceTypes 来自 `ffmpeg -init_hw_device list`：这套 FFmpeg 支持哪些
	// 硬件设备类型（qsv、vaapi、cuda…）。它回答「有哪些类型」，不承诺某个类型
	// 在本机真的可用——真正能不能用取决于驱动与设备权限。
	HWDeviceTypes []string `json:"hwDeviceTypes"`
	Encoders      []Item   `json:"encoders"`
	Decoders      []Item   `json:"decoders"`
	Filters       []Item   `json:"filters"`
	Formats       []Item   `json:"formats"`
	Muxers        []Item   `json:"muxers"`
	Demuxers      []Item   `json:"demuxers"`
	Bitstream     []Item   `json:"bitstreamFilters"`
	Protocols     []Item   `json:"protocols"`
	Devices       []Item   `json:"devices"`
	PixelFormats  []Item   `json:"pixelFormats"`
	SampleFormats []Item   `json:"sampleFormats"`
	Layouts       []Item   `json:"layouts"`
	Colors        []Item   `json:"colors"`
	Dispositions  []Item   `json:"dispositions"`
}

// ---------------------------------------------------------------- -h 结构

// Help 是 `ffmpeg -h <target>=<name>` 的结构化结果。
type Help struct {
	Target  string `json:"target"`
	Name    string `json:"name"`
	Kind    string `json:"kind,omitempty"`    // Encoder/Decoder/Filter/Muxer/...
	Title   string `json:"title,omitempty"`   // 原始标题行
	Summary string `json:"summary,omitempty"` // 标题后的说明

	Properties    []Property `json:"properties,omitempty"`
	Capabilities  []string   `json:"capabilities,omitempty"`
	Threading     []string   `json:"threading,omitempty"`
	PixelFormats  []string   `json:"pixelFormats,omitempty"`
	SampleFormats []string   `json:"sampleFormats,omitempty"`
	Codecs        []string   `json:"codecs,omitempty"`
	FrameRates    []string   `json:"frameRates,omitempty"`

	Inputs  []Stream `json:"inputs,omitempty"`
	Outputs []Stream `json:"outputs,omitempty"`

	// Sections 保留 FFmpeg 自己的分组（例如 scale / SWScaler / framesync），
	// Options 是它们的扁平化视图，方便一次性搜索。
	Sections []Section `json:"sections,omitempty"`
	Options  []Option  `json:"options,omitempty"`

	Raw string `json:"raw"`
}

// Property 是 "Common extensions: mp4." 这类未归类的元信息。
type Property struct {
	Name  string `json:"name"`
	Value string `json:"value"`
}

// Stream 描述滤镜的输入/输出端口。
type Stream struct {
	Index int    `json:"index"`
	Name  string `json:"name,omitempty"`
	Media string `json:"media,omitempty"`
	Note  string `json:"note,omitempty"`
}

// Section 是 `xxx AVOptions:` 分组。
type Section struct {
	Name    string   `json:"name"`
	Options []Option `json:"options"`
}

// Option 是单个 AVOption。
type Option struct {
	Name        string `json:"name"`
	Type        string `json:"type,omitempty"`
	Flags       string `json:"flags,omitempty"` // 原始 flags 列，例如 "E..V......P"
	Scope       string `json:"scope,omitempty"` // encoding / decoding / shared
	Media       string `json:"media,omitempty"` // video / audio / subtitle / data
	Runtime     bool   `json:"runtime,omitempty"`
	PerStream   bool   `json:"perStream,omitempty"`
	Description string `json:"description,omitempty"`
	HasDefault  bool   `json:"hasDefault,omitempty"`
	Default     string `json:"default,omitempty"`
	Range       string `json:"range,omitempty"`
	Min         string `json:"min,omitempty"`
	Max         string `json:"max,omitempty"`
	Unit        string `json:"unit,omitempty"`

	Values []OptionValue `json:"values,omitempty"`
}

// OptionValue 是枚举取值；flags 型选项的 Value 为空。
type OptionValue struct {
	Name        string `json:"name"`
	Value       string `json:"value,omitempty"`
	Description string `json:"description,omitempty"`
}

// ---------------------------------------------------------------- 媒体信息

// MediaInfo 是 ffprobe 的 JSON 结果。
type MediaInfo struct {
	Streams []map[string]any `json:"streams"`
	Format  map[string]any   `json:"format"`
}

// Duration 返回容器的总时长；无法确定时为 0。
func (m MediaInfo) Duration() time.Duration {
	return secondsValue(m.Format["duration"])
}

// ---------------------------------------------------------------- Service

// helpTargets 是 `ffmpeg -h` 承认的目标类型。这里只做结构性校验，
// 不涉及任何具体组件名。
var helpTargets = map[string]bool{
	"encoder": true, "decoder": true, "filter": true, "demuxer": true,
	"muxer": true, "bsf": true, "protocol": true, "device": true,
	"input": true, "output": true, "hwaccel": true, "full": true,
}

// commandTimeout 防止某个查询把服务卡住。
const commandTimeout = 20 * time.Second

// maxHelpCache 限制缓存条目，避免长时间运行后无界增长。
const maxHelpCache = 256

type Service struct {
	ffmpeg  string
	ffprobe string

	mu   sync.RWMutex
	snap Snapshot

	helpMu   sync.Mutex
	help     map[string]Help
	cliCache map[string]CliHelp
	extCache map[string]ExtensionsResult
}

func NewService(ffmpegPath, ffprobePath string) *Service {
	s := &Service{
		ffmpeg:   ffmpegPath,
		ffprobe:  ffprobePath,
		help:     map[string]Help{},
		cliCache: map[string]CliHelp{},
		extCache: map[string]ExtensionsResult{},
	}
	_ = s.Refresh()
	return s
}

func (s *Service) FFmpegPath() string  { return s.ffmpeg }
func (s *Service) FFprobePath() string { return s.ffprobe }

// Refresh 重新查询 FFmpeg 的全部能力。
//
// 各条查询互相独立，因此并发执行，让启动耗时取决于最慢的一条
// 而不是它们的总和。
func (s *Service) Refresh() error {
	versionOut, err := s.run("-version")
	if err != nil {
		return fmt.Errorf("执行 %s -version 失败: %w", s.ffmpeg, err)
	}

	snap := Snapshot{
		GeneratedAt: time.Now(),
		FFmpegPath:  s.ffmpeg,
		FFprobePath: s.ffprobe,
		Version:     extractVersion(versionOut),
		BuildConfig: versionOut,
	}

	// withFlags 表示该列表的第一列是能力 flags；否则第一列就是名称。
	// set 接收指针：Snapshot 是值类型，传值会让赋值全部落到副本上。
	type query struct {
		arg       string
		withFlags bool
		set       func(*Snapshot, []Item)
	}
	queries := []query{
		{"-encoders", true, func(sn *Snapshot, v []Item) { sn.Encoders = v }},
		{"-decoders", true, func(sn *Snapshot, v []Item) { sn.Decoders = v }},
		{"-filters", true, func(sn *Snapshot, v []Item) { sn.Filters = v }},
		{"-formats", true, func(sn *Snapshot, v []Item) { sn.Formats = v }},
		{"-muxers", true, func(sn *Snapshot, v []Item) { sn.Muxers = v }},
		{"-demuxers", true, func(sn *Snapshot, v []Item) { sn.Demuxers = v }},
		{"-devices", true, func(sn *Snapshot, v []Item) { sn.Devices = v }},
		{"-pix_fmts", true, func(sn *Snapshot, v []Item) { sn.PixelFormats = v }},
		{"-bsfs", false, func(sn *Snapshot, v []Item) { sn.Bitstream = v }},
		{"-protocols", false, func(sn *Snapshot, v []Item) { sn.Protocols = v }},
		{"-sample_fmts", false, func(sn *Snapshot, v []Item) { sn.SampleFormats = v }},
		{"-layouts", false, func(sn *Snapshot, v []Item) { sn.Layouts = v }},
		{"-colors", false, func(sn *Snapshot, v []Item) { sn.Colors = v }},
		{"-dispositions", false, func(sn *Snapshot, v []Item) { sn.Dispositions = v }},
	}

	results := make([][]Item, len(queries))
	var wg sync.WaitGroup
	for i, q := range queries {
		wg.Add(1)
		go func(i int, q query) {
			defer wg.Done()
			// 必须隐藏 banner：它会把版本、编译配置和 libav* 版本混进列表里，
			// 这些行会被当成真实条目解析出来。
			raw := mustRun(s, "-hide_banner", q.arg)
			if q.withFlags {
				results[i] = parseFlagTable(raw)
			} else {
				results[i] = parseNameTable(raw)
			}
		}(i, q)
	}
	wg.Wait()

	for i, q := range queries {
		items := results[i]
		annotate(q.arg, items)
		q.set(&snap, items)
	}

	snap.HWAccels = parseHWAccels(mustRun(s, "-hide_banner", "-hwaccels"))
	sort.Strings(snap.HWAccels)

	snap.HWDeviceTypes = parseHWDeviceTypes(mustRun(s, "-hide_banner", "-init_hw_device", "list"))
	sort.Strings(snap.HWDeviceTypes)

	s.mu.Lock()
	s.snap = snap
	s.mu.Unlock()

	// 换过 FFmpeg 之后，先前按旧二进制缓存下来的东西全部作废：
	// 组件的 -h、命令行拓扑、扩展名汇总都会随版本变。
	// 少了这一步，用户点了「重新查询能力」，命令行选项面板却还是旧的。
	s.helpMu.Lock()
	s.help = map[string]Help{}
	s.cliCache = map[string]CliHelp{}
	s.extCache = map[string]ExtensionsResult{}
	s.helpMu.Unlock()
	return nil
}

func (s *Service) Snapshot() Snapshot {
	s.mu.RLock()
	snap := s.snap
	s.mu.RUnlock()
	snap.normalize()
	return snap
}

// normalize 把快照里的各个列表统一成非 nil。
//
// 这条约定值得单独写一段，因为它背后的连锁反应很不好查：Go 的 nil 切片会
// 序列化成 JSON 的 null，前端对 null 读一次 .length 就抛异常，而 React 在渲染
// 期抛异常会把**整棵树**卸掉——用户看到的不是「这一块坏了」，而是连 logo 都
// 没了的空白页。所以出口处一律给空切片（hardware 包早就这么做了）。
func (snap *Snapshot) normalize() {
	for _, list := range []*[]Item{
		&snap.Encoders, &snap.Decoders, &snap.Filters, &snap.Formats,
		&snap.Muxers, &snap.Demuxers, &snap.Bitstream, &snap.Protocols,
		&snap.Devices, &snap.PixelFormats, &snap.SampleFormats, &snap.Layouts,
		&snap.Colors, &snap.Dispositions,
	} {
		if *list == nil {
			*list = []Item{}
		}
	}
	for _, list := range []*[]string{&snap.HWAccels, &snap.HWDeviceTypes} {
		if *list == nil {
			*list = []string{}
		}
	}
}

// Help 返回组件的结构化帮助，结果按目标缓存。
func (s *Service) Help(target, name string) (Help, error) {
	target = strings.TrimSpace(target)
	name = strings.TrimSpace(name)
	if target == "" {
		return Help{}, errors.New("缺少 target")
	}
	if !helpTargets[target] {
		return Help{}, fmt.Errorf("不支持的 target: %s", target)
	}
	if target != "full" && name == "" {
		return Help{}, errors.New("缺少 name")
	}
	if len(name) > 256 {
		return Help{}, errors.New("name 过长")
	}

	key := target + "/" + name
	s.helpMu.Lock()
	if h, ok := s.help[key]; ok {
		s.helpMu.Unlock()
		return h, nil
	}
	s.helpMu.Unlock()

	arg := target
	if name != "" {
		arg = target + "=" + name
	}
	raw, err := s.run("-hide_banner", "-h", arg)
	if err != nil {
		// 目标不存在时把 ffmpeg 的原始错误一并交回，方便用户自行诊断。
		return Help{Target: target, Name: name, Raw: raw}, fmt.Errorf("%s -h %s: %w", s.ffmpeg, arg, err)
	}

	h := parseHelp(target, name, raw)
	s.helpMu.Lock()
	if len(s.help) >= maxHelpCache {
		s.help = map[string]Help{}
	}
	s.help[key] = h
	s.helpMu.Unlock()
	return h, nil
}

// Probe 通过服务器上的 ffprobe 读取媒体信息。
func (s *Service) Probe(path string) (MediaInfo, error) {
	ctx, cancel := context.WithTimeout(context.Background(), commandTimeout)
	defer cancel()

	cmd := exec.CommandContext(ctx, s.ffprobe,
		"-hide_banner", "-v", "error",
		"-show_streams", "-show_format",
		"-of", "json", path)
	raw, err := cmd.CombinedOutput()
	if err != nil {
		return MediaInfo{}, fmt.Errorf("ffprobe: %w: %s", err, strings.TrimSpace(string(raw)))
	}
	var info MediaInfo
	if err := json.Unmarshal(raw, &info); err != nil {
		return MediaInfo{}, fmt.Errorf("解析 ffprobe 输出失败: %w", err)
	}
	if info.Streams == nil {
		info.Streams = []map[string]any{}
	}
	if info.Format == nil {
		info.Format = map[string]any{}
	}
	return info, nil
}

// Command 生成可直接粘贴到终端执行的命令预览。
func (s *Service) Command(args []string) string {
	fields := make([]string, 0, len(args)+1)
	fields = append(fields, s.ffmpeg)
	fields = append(fields, args...)
	return shellJoin(fields)
}

func (s *Service) run(args ...string) (string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), commandTimeout)
	defer cancel()

	out, err := exec.CommandContext(ctx, s.ffmpeg, args...).CombinedOutput()
	if ctx.Err() != nil {
		return string(out), fmt.Errorf("查询超时（%s）", commandTimeout)
	}
	if err != nil {
		return string(out), err
	}
	return string(out), nil
}

func mustRun(s *Service, args ...string) string {
	out, _ := s.run(args...)
	return out
}

// ---------------------------------------------------------------- 列表解析

var (
	// 列表块里的能力图例，形如 " V..... = Video"，行首一定是 flags。
	legendRE = regexp.MustCompile(`^[A-Z.]{1,8}\s+=\s`)
	// flags 列：只由大写字母与点组成，例如 "DE"、"IO..."、"V....D"。
	flagsColRE = regexp.MustCompile(`^[A-Z.]{1,8}$`)
)

func newScanner(raw string) *bufio.Scanner {
	sc := bufio.NewScanner(strings.NewReader(raw))
	// 某些行的描述可能很长（例如 -filters 的说明）。
	sc.Buffer(make([]byte, 0, 64*1024), 4*1024*1024)
	return sc
}

// skipTableLine 判断该行是否为列表里的「非数据行」。
func skipTableLine(trimmed string) bool {
	switch {
	case trimmed == "":
		return true
	case strings.HasPrefix(trimmed, "--"):
		return true // 说明块与数据块的隔离线
	case strings.HasSuffix(trimmed, ":"):
		return true // 段落标题，例如 "Encoders:"、"Supported file protocols:"
	case legendRE.MatchString(trimmed):
		return true // 能力图例
	}
	return false
}

// parseFlagTable 解析第一列是 flags 的列表，例如 -encoders、-formats、-pix_fmts。
func parseFlagTable(raw string) []Item {
	var items []Item
	seen := map[string]bool{}
	sc := newScanner(raw)
	for sc.Scan() {
		line := sc.Text()
		trimmed := strings.TrimSpace(line)
		if skipTableLine(trimmed) {
			continue
		}
		f := strings.Fields(line)
		if len(f) < 2 || !flagsColRE.MatchString(f[0]) {
			continue
		}
		it := Item{Flags: f[0], Name: f[1]}
		if strings.EqualFold(it.Name, "name") || strings.Trim(it.Name, "-") == "" {
			continue // 列标题行与分隔线
		}
		it.Columns = f[2:]
		it.Description = strings.TrimSpace(strings.Join(it.Columns, " "))
		if seen[it.Name] {
			continue
		}
		seen[it.Name] = true
		items = append(items, it)
	}
	return items
}

// parseNameTable 解析第一列就是名称的列表，例如 -bsfs、-protocols、-layouts。
//
// 这类输出没有 flags 列，因此不能靠「第一列像不像 flags」来判断——
// 频道布局的 "FL" 与设备的 "DE" 形态完全相同，只能按各自稳定的输出结构区分。
func parseNameTable(raw string) []Item {
	var items []Item
	seen := map[string]bool{}
	sc := newScanner(raw)
	for sc.Scan() {
		line := sc.Text()
		trimmed := strings.TrimSpace(line)
		if skipTableLine(trimmed) {
			continue
		}
		f := strings.Fields(line)
		if len(f) == 0 {
			continue
		}
		if strings.EqualFold(f[0], "name") || strings.Trim(f[0], "-") == "" {
			continue // 列标题行与分隔线
		}
		if seen[f[0]] {
			continue // -protocols 会分 Input/Output 两段重复出现
		}
		seen[f[0]] = true
		it := Item{Name: f[0]}
		if len(f) > 1 {
			it.Columns = f[1:]
			it.Description = strings.Join(f[1:], " ")
		}
		items = append(items, it)
	}
	return items
}

// parseHWAccels 读取 `-hwaccels`，它只有名称一列。
func parseHWAccels(raw string) []string {
	var out []string
	for _, it := range parseNameTable(raw) {
		out = append(out, it.Name)
	}
	return out
}

// parseHWDeviceTypes 读取 `ffmpeg -init_hw_device list`。
//
// 输出先是若干行说明文字，随后每行一个设备类型；这里只取类型名，与 -hwaccels
// 一样属于「FFmpeg 自己报告的事实」，代码不据此推断任何型号或能力。
func parseHWDeviceTypes(raw string) []string {
	var out []string
	for _, line := range strings.Split(raw, "\n") {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasSuffix(line, ":") {
			continue
		}
		out = append(out, line)
	}
	return out
}

// annotate 给已知形状的表格补充语意化的列名。
//
// 这里标注的是「这一列表示什么」，而不是「某个组件具备什么能力」，
// 因此依然没有把任何 FFmpeg 能力写进代码。
func annotate(table string, items []Item) {
	for i := range items {
		c := items[i].Columns
		extra := map[string]any{}
		switch table {
		case "-filters":
			// 第一列是 I/O 约定，例如 "V->V"。
			if len(c) >= 1 {
				extra["io"] = c[0]
			}
			items[i].Description = strings.Join(c[1:], " ")
		case "-pix_fmts":
			if len(c) >= 2 {
				extra["components"] = c[0]
				extra["bitsPerPixel"] = c[1]
			}
			if len(c) > 2 {
				extra["depths"] = strings.Join(c[2:], " ")
			}
		case "-sample_fmts":
			if len(c) >= 1 {
				extra["depth"] = c[0]
			}
		case "-colors":
			if len(c) >= 1 {
				extra["hex"] = c[0]
			}
		}
		if len(extra) > 0 {
			items[i].Extra = extra
		}
	}
}

// ---------------------------------------------------------------- help 解析

var (
	titleRE   = regexp.MustCompile(`^(Encoder|Decoder|Filter|Muxer|Demuxer|Bit stream filter|Bitstream filter|Device|Protocol|Input|Output|Hardware acceleration)\s+(.+?):?\s*$`)
	sectionRE = regexp.MustCompile(`^(\S.*?)\s+AVOptions:\s*$`)
	// flags 列用 [A-Z.] 宽松匹配：滤镜还会带 F（AV_OPT_FLAG_FILTERING_PARAM），
	// 例如 "..FV.....T."；把字母表写死会漏掉整类参数。
	optionRE = regexp.MustCompile(`^\s{1,3}-?([A-Za-z][A-Za-z0-9_.-]*)\s+<([^<>]*)>\s+([A-Z.]{4,})\s*(.*)$`)
	valueRE  = regexp.MustCompile(`^\s{4,}(\S+)\s+(\S*)\s+([A-Z.]{4,})\s*(.*)$`)
	propRE   = regexp.MustCompile(`^\s{2,}([A-Z][A-Za-z0-9 /-]*[A-Za-z0-9]):\s*(.*)$`)
	streamRE = regexp.MustCompile(`^#(\d+):\s*(.*)$`)
	detailRE = regexp.MustCompile(`^([^(]+?)\s*\(([^)]*)\)\s*$`)

	defaultRE = regexp.MustCompile(`\(default\s+([^)]*)\)`)
	fromToRE  = regexp.MustCompile(`\(from\s+(\S+)\s+to\s+(\S+)\)`)
	unitRE    = regexp.MustCompile(`\((?:in|per)\s+([^)]+)\)`)
)

// parseHelp 把 `ffmpeg -h` 的文本拆成结构。
//
// 需要照顾的几处差异：filter 的选项行没有前导 '-'，encoder/muxer 的有；
// 枚举值行的缩进比选项行深一级，且 flags 型选项的取值列可能为空；
// flags 列除 E/D/V/A/S/T/P 之外还会出现 F（滤镜专用）。
func parseHelp(target, name, raw string) Help {
	h := Help{Target: target, Name: name, Raw: raw}

	var (
		section      *Section
		current      *Option
		streamFor    string
		lastWasTitle bool
	)

	for _, line := range strings.Split(raw, "\n") {
		trimmed := strings.TrimSpace(line)
		if trimmed == "" {
			continue
		}

		if h.Title == "" {
			if m := titleRE.FindStringSubmatch(trimmed); m != nil {
				// FFmpeg 对同一个东西会写成 "Bit stream filter" 或 "Bitstream filter"，
				// 统一成一种写法，界面上的分类才稳定。
				h.Kind = strings.ReplaceAll(m[1], "Bit stream filter", "Bitstream filter")
				h.Title = trimmed
				lastWasTitle = true
				continue
			}
		}
		// 标题之后紧跟的缩进说明行（只有 filter 有）。
		if lastWasTitle {
			lastWasTitle = false
			if !strings.Contains(trimmed, ":") && len(line)-len(strings.TrimLeft(line, " ")) >= 2 {
				h.Summary = trimmed
				continue
			}
		}

		if m := sectionRE.FindStringSubmatch(line); m != nil {
			h.Sections = append(h.Sections, Section{Name: strings.TrimSpace(m[1])})
			section = &h.Sections[len(h.Sections)-1]
			current = nil
			streamFor = ""
			continue
		}

		switch trimmed {
		case "Inputs:":
			streamFor = "in"
			continue
		case "Outputs:":
			streamFor = "out"
			continue
		}

		if streamFor != "" {
			if m := streamRE.FindStringSubmatch(trimmed); m != nil {
				s := Stream{Index: atoi(m[1])}
				if d := detailRE.FindStringSubmatch(strings.TrimSpace(m[2])); d != nil {
					s.Name = strings.TrimSpace(d[1])
					s.Media = strings.TrimSpace(d[2])
				} else {
					s.Name = strings.TrimSpace(m[2])
				}
				if streamFor == "in" {
					h.Inputs = append(h.Inputs, s)
				} else {
					h.Outputs = append(h.Outputs, s)
				}
				continue
			}
			// 端口的补充说明，例如 "dynamic (depending on the options)"。
			ports := &h.Outputs
			if streamFor == "in" {
				ports = &h.Inputs
			}
			if n := len(*ports); n > 0 {
				(*ports)[n-1].Note = trimmed
				continue
			}
			streamFor = ""
		}

		if m := propRE.FindStringSubmatch(line); m != nil {
			key, val := strings.TrimSpace(m[1]), strings.TrimSpace(m[2])
			switch key {
			case "General capabilities":
				h.Capabilities = append(h.Capabilities, strings.Fields(val)...)
			case "Threading capabilities":
				h.Threading = append(h.Threading, strings.Fields(val)...)
			case "Supported pixel formats":
				h.PixelFormats = append(h.PixelFormats, strings.Fields(val)...)
			case "Supported sample formats":
				h.SampleFormats = append(h.SampleFormats, strings.Fields(val)...)
			case "Supported codecs":
				h.Codecs = append(h.Codecs, strings.Fields(val)...)
			case "Supported frame rates":
				h.FrameRates = append(h.FrameRates, strings.Fields(val)...)
			default:
				h.Properties = append(h.Properties, Property{Name: key, Value: val})
			}
			continue
		}

		if m := optionRE.FindStringSubmatch(line); m != nil {
			opt := Option{Name: m[1], Type: m[2], Flags: m[3], Description: strings.TrimSpace(m[4])}
			finishOption(&opt)
			if section == nil {
				h.Sections = append(h.Sections, Section{Name: "AVOptions"})
				section = &h.Sections[len(h.Sections)-1]
			}
			section.Options = append(section.Options, opt)
			current = &section.Options[len(section.Options)-1]
			h.Options = append(h.Options, opt)
			continue
		}

		if current != nil {
			if m := valueRE.FindStringSubmatch(line); m != nil {
				v := OptionValue{Name: m[1], Value: m[2], Description: strings.TrimSpace(m[4])}
				current.Values = append(current.Values, v)
				// 扁平视图是独立副本，需要同步。
				if n := len(h.Options); n > 0 {
					h.Options[n-1].Values = append(h.Options[n-1].Values, v)
				}
			}
		}
	}
	return h
}

// finishOption 把描述里的结构化信息抽出来，并从描述中移除，
// 使界面既能显示干净的说明，又能单独呈现默认值与取值范围。
func finishOption(o *Option) {
	f := strings.TrimSpace(o.Flags)
	if len(f) > 0 {
		switch f[0] {
		case 'E':
			o.Scope = "encoding"
		case 'D':
			o.Scope = "decoding"
		default:
			o.Scope = "shared"
		}
	}
	if len(f) > 3 {
		switch f[3] {
		case 'V':
			o.Media = "video"
		case 'A':
			o.Media = "audio"
		case 'S':
			o.Media = "subtitle"
		case 'D':
			o.Media = "data"
		}
	}
	o.Runtime = strings.Contains(f, "T")
	o.PerStream = strings.HasSuffix(f, "P")

	desc := o.Description
	if m := defaultRE.FindStringSubmatch(desc); m != nil {
		o.HasDefault = true
		o.Default = strings.Trim(strings.TrimSpace(m[1]), `"`)
		desc = strings.Replace(desc, m[0], "", 1)
	}
	if m := fromToRE.FindStringSubmatch(desc); m != nil {
		o.Min, o.Max = m[1], m[2]
		o.Range = fmt.Sprintf("%s .. %s", m[1], m[2])
		desc = strings.Replace(desc, m[0], "", 1)
	}
	if m := unitRE.FindStringSubmatch(desc); m != nil {
		o.Unit = strings.TrimSpace(m[1])
		desc = strings.Replace(desc, m[0], "", 1)
	}
	o.Description = strings.Join(strings.Fields(desc), " ")
}

// ---------------------------------------------------------------- 工具

func extractVersion(s string) string {
	for _, line := range strings.Split(s, "\n") {
		line = strings.TrimSpace(line)
		if line != "" {
			return line
		}
	}
	return ""
}

func atoi(s string) int {
	n, _ := strconv.Atoi(strings.TrimSpace(s))
	return n
}

func secondsValue(v any) time.Duration {
	switch t := v.(type) {
	case string:
		f, err := strconv.ParseFloat(t, 64)
		if err != nil || f <= 0 {
			return 0
		}
		return time.Duration(f * float64(time.Second))
	case float64:
		if t <= 0 {
			return 0
		}
		return time.Duration(t * float64(time.Second))
	case json.Number:
		f, err := t.Float64()
		if err != nil || f <= 0 {
			return 0
		}
		return time.Duration(f * float64(time.Second))
	}
	return 0
}

// SplitArgs 把用户手写的命令行拆成 argv。
//
// 支持单引号、双引号与反斜杠转义，规则贴近 POSIX shell 的常用子集，
// 这样终端里能跑的命令粘贴进来含义一致。用户常会连 ffmpeg 一起粘贴，
// 因此前导的 ffmpeg/ffprobe 会被去掉。
func SplitArgs(input string) ([]string, error) {
	var (
		args  []string
		cur   strings.Builder
		quote rune
		esc   bool
		has   bool
	)
	flush := func() {
		if has {
			args = append(args, cur.String())
			cur.Reset()
			has = false
		}
	}
	for _, r := range input {
		switch {
		case esc:
			cur.WriteRune(r)
			has = true
			esc = false
		case r == '\\' && quote != '\'':
			esc = true
		case quote != 0:
			if r == quote {
				quote = 0
			} else {
				cur.WriteRune(r)
			}
			has = true
		case r == '\'' || r == '"':
			quote = r
			has = true
		case r == ' ' || r == '\t' || r == '\n' || r == '\r':
			flush()
		default:
			cur.WriteRune(r)
			has = true
		}
	}
	if esc {
		cur.WriteRune('\\')
	}
	if quote != 0 {
		return nil, errors.New("引号没有闭合")
	}
	flush()

	if len(args) > 0 {
		switch {
		case args[0] == "ffmpeg", args[0] == "ffprobe":
			args = args[1:]
		case strings.HasSuffix(args[0], "/ffmpeg"), strings.HasSuffix(args[0], "/ffprobe"):
			args = args[1:]
		}
	}
	return args, nil
}

// shellJoin 生成可安全粘贴的 shell 命令。
func shellJoin(fields []string) string {
	parts := make([]string, len(fields))
	for i, f := range fields {
		parts[i] = shellQuote(f)
	}
	return strings.Join(parts, " ")
}

func shellQuote(s string) string {
	if s == "" {
		return "''"
	}
	const special = " \t\n\r\\\"'$`;&|<>()*?[]{}#!~"
	if !strings.ContainsAny(s, special) {
		return s
	}
	// 单引号内除单引号本身外无需转义，是最不容易出错的引用方式。
	return "'" + strings.ReplaceAll(s, "'", `'\''`) + "'"
}
