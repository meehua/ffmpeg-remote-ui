package ffmpeg

import (
	"os/exec"
	"strings"
	"testing"
)

// sampleHelp 是 `ffmpeg -h` 的真实片段（FFmpeg 8.0.1），刻意保留原始缩进：
// "Getting help:" 下的选项缩进 4 格，而 "Per-file options:" 下的顶格。
const sampleHelp = `Universal media converter
usage: ffmpeg [options] [[infile options] -i infile]... {[outfile options] outfile}...

Getting help:
    -h      -- print basic options
    -h long -- print more options

Print help / information / capabilities:
-L                  show license
-version            show version

Global options (affect whole program instead of just one file):
-v <loglevel>       set logging level
-y                  overwrite output files

Per-file options (input and output):
-f <fmt>            force container format (auto-detected otherwise)
-ss <time_off>      start transcoding at specified time

Advanced per-file options (input-only):
-hwaccel[:<stream_spec>] <hwaccel name>  use HW accelerated decoding
-re <>              read input at native frame rate

Per-file options (output-only):
-metadata[:<spec>] <key=value>  add metadata

Per-stream options:
-c[:<stream_spec>] <codec>  select encoder/decoder ('copy' to copy stream without reencoding)
-filter[:<stream_spec>] <filter_graph>  apply specified filters to audio/video

Video options:
-vn                 disable video
-r[:<stream_spec>] <rate>  override input framerate

Audio options:
-an                 disable audio

Subtitle options:
-sn                 disable subtitle
-scodec <codec>     alias for -c:s

Data stream options:
-dcodec <codec>     alias for -c:d

Exiting with exit code 0
`

func sectionByName(t *testing.T, help CliHelp, name string) CliSection {
	t.Helper()
	for _, section := range help.Sections {
		if section.Name == name {
			return section
		}
	}
	t.Fatalf("没有解析出分节 %q；实际得到 %v", name, sectionNames(help))
	return CliSection{}
}

func sectionNames(help CliHelp) []string {
	out := make([]string, 0, len(help.Sections))
	for _, s := range help.Sections {
		out = append(out, s.Name)
	}
	return out
}

func optionByName(section CliSection, name string) (CliOption, bool) {
	for _, opt := range section.Options {
		if opt.Name == name {
			return opt, true
		}
	}
	return CliOption{}, false
}

func TestParseCliHelpSections(t *testing.T) {
	help := parseCliHelp("", sampleHelp)

	// 用法说明与结尾那句不属于任何分节。
	for _, name := range sectionNames(help) {
		if name == "Universal media converter" || strings.HasPrefix(name, "usage") {
			t.Errorf("前言被误当成分节: %q", name)
		}
	}
	want := []string{
		"Getting help",
		"Print help / information / capabilities",
		"Global options (affect whole program instead of just one file)",
		"Per-file options (input and output)",
		"Advanced per-file options (input-only)",
		"Per-file options (output-only)",
		"Per-stream options",
		"Video options",
		"Audio options",
		"Subtitle options",
		"Data stream options",
	}
	if got := sectionNames(help); len(got) != len(want) {
		t.Fatalf("分节 = %v，期望 %v", got, want)
	}
	for i, name := range want {
		if got := help.Sections[i].Name; got != name {
			t.Errorf("第 %d 个分节 = %q，期望 %q", i, got, name)
		}
	}
}

func TestParseCliHelpScopes(t *testing.T) {
	help := parseCliHelp("", sampleHelp)

	// scope 完全由 ffmpeg 写在标题里的措辞推导：界面据此决定控件落在
	// 命令行的哪一段，程序不额外定义分类。
	cases := map[string]string{
		"Global options (affect whole program instead of just one file)": "global",
		"Per-file options (input and output)":                            "both",
		"Advanced per-file options (input-only)":                         "input",
		"Per-file options (output-only)":                                 "output",
		"Per-stream options":                                             "stream",
		"Video options":                                                  "stream",
		"Getting help":                                                   "other",
	}
	for name, want := range cases {
		if got := sectionByName(t, help, name).Scope; got != want {
			t.Errorf("%s 的 scope = %q，期望 %q", name, got, want)
		}
	}
}

func TestParseCliHelpMediaAndSpec(t *testing.T) {
	help := parseCliHelp("", sampleHelp)

	cases := []struct {
		section string
		media   string
		spec    string
	}{
		{"Video options", "video", "v"},
		{"Audio options", "audio", "a"},
		{"Subtitle options", "subtitle", "s"},
		{"Data stream options", "data", "d"},
		// 通用分节没有媒体类型，因此也没有流定位符。
		{"Per-stream options", "", ""},
	}
	for _, c := range cases {
		section := sectionByName(t, help, c.section)
		if section.Media != c.media || section.Spec != c.spec {
			t.Errorf("%s: media=%q spec=%q，期望 %q/%q",
				c.section, section.Media, section.Spec, c.media, c.spec)
		}
	}
}

func TestParseCliHelpOptions(t *testing.T) {
	help := parseCliHelp("", sampleHelp)

	// 开关型选项：ffmpeg 没有给占位符。
	if opt, ok := optionByName(sectionByName(t, help, "Global options (affect whole program instead of just one file)"), "y"); !ok {
		t.Error("没有解析出 -y")
	} else if opt.TakesValue {
		t.Error("-y 不该需要取值")
	} else if opt.Description != "overwrite output files" {
		t.Errorf("-y 的说明 = %q", opt.Description)
	}

	// 取值型选项：占位符原样保留。
	if opt, ok := optionByName(sectionByName(t, help, "Per-file options (input and output)"), "ss"); !ok {
		t.Error("没有解析出 -ss")
	} else if !opt.TakesValue || opt.Placeholder != "<time_off>" {
		t.Errorf("-ss 的占位符 = %q", opt.Placeholder)
	}

	// 可带流定位符的选项：ffmpeg 原文写着 [:<>]，界面据此决定要不要补 :v/:a。
	if opt, ok := optionByName(sectionByName(t, help, "Per-stream options"), "c"); !ok {
		t.Error("没有解析出 -c")
	} else if !opt.StreamSpec {
		t.Error("-c 应标记为可带流定位符")
	} else if !strings.Contains(opt.Description, "copy") {
		t.Errorf("-c 的说明应当包含 ffmpeg 对 copy 的解释，实际 %q", opt.Description)
	}

	// 参数占位符为空的那种（-re <>）也要算作需要取值。
	if opt, ok := optionByName(sectionByName(t, help, "Advanced per-file options (input-only)"), "re"); !ok {
		t.Error("没有解析出 -re")
	} else if !opt.TakesValue {
		t.Error("-re 需要取值")
	}

	// 缩进 4 格的那种同样要解析出来。
	if _, ok := optionByName(sectionByName(t, help, "Getting help"), "h"); !ok {
		t.Error("没有解析出缩进 4 格的 -h")
	}

	// 输入专有选项必须落在 input 分节里：这正是 -hwaccel 唯一合法的位置。
	section := sectionByName(t, help, "Advanced per-file options (input-only)")
	if _, ok := optionByName(section, "hwaccel"); !ok {
		t.Error("-hwaccel 没有出现在 input-only 分节里")
	}
}

func TestCliHelpRejectsUnknownLevel(t *testing.T) {
	// 级别校验发生在调用 ffmpeg 之前，所以这里不需要真的装 ffmpeg。
	service := &Service{}
	if _, err := service.CliHelp("everything"); err == nil {
		t.Error("未知级别应当报错")
	}
}

// TestCliHelpAgainstRealFFmpeg 只在本机有 ffmpeg 时运行，用来确认解析器
// 能吃下真实输出，而不只是人造样本。
func TestCliHelpAgainstRealFFmpeg(t *testing.T) {
	path, err := exec.LookPath("ffmpeg")
	if err != nil {
		t.Skip("本机没有 ffmpeg")
	}
	service := NewService(path, "ffprobe")
	help, err := service.CliHelp("long")
	if err != nil {
		t.Fatalf("CliHelp 失败: %v", err)
	}
	if len(help.Sections) == 0 {
		t.Fatal("没有解析出任何分节")
	}

	// 把推导结果整份打出来：scope 是否合理，看一眼就知道，
	// 不必为了加一个选项再去翻 ffmpeg 的原始输出。
	scopes := map[string]string{}
	sectionOf := map[string]string{}
	total := 0
	for _, section := range help.Sections {
		scopes[section.Name] = section.Scope
		total += len(section.Options)
		t.Logf("[%-6s] %s (%d 项)", section.Scope, section.Name, len(section.Options))
		for _, opt := range section.Options {
			if _, ok := sectionOf[opt.Name]; !ok {
				sectionOf[opt.Name] = section.Name
			}
		}
	}
	t.Logf("共 %d 个分节、%d 个选项", len(help.Sections), total)

	// 这些选项是这次改造的核心：它们以前根本进不了程序，必须都能找到。
	for _, name := range []string{"ss", "t", "f", "metadata", "c", "filter", "vn", "an", "sn"} {
		if _, ok := sectionOf[name]; !ok {
			t.Errorf("选项 -%s 没有出现在任何一节里", name)
		}
	}

	// 命令行分段的依据必须成立：至少要有这四类作用范围。
	for _, want := range []string{"global", "input", "output", "both"} {
		found := false
		for _, scope := range scopes {
			if scope == want {
				found = true
				break
			}
		}
		if !found {
			t.Errorf("没有推导出 scope=%q 的分节", want)
		}
	}

	// -hwaccel 值得单独记一笔：ffmpeg 帮助里的分类和实际的位置约束对不上。
	// 它被列在 "Advanced Video options" 下，可放进输出侧时 ffmpeg 会直接报错
	// "you are trying to apply an input option to an output file"。
	// 这里只记录事实，不替 ffmpeg 修正——界面因此必须允许用户调整插入位置。
	if section, ok := sectionOf["hwaccel"]; ok {
		t.Logf("-hwaccel 被归在 %q（scope=%s），实测却只能放在 -i 之前",
			section, scopes[section])
	}

	// 可带流定位符的选项必须被标出来：`-filter` 不带 `:a` 会落到视频流上，
	// `-filter:a` 才只处理音频。界面正是靠这个标记决定要不要让用户选流，
	// 漏标就会生成一条语义不对的命令。
	for _, name := range []string{"c", "filter"} {
		option, ok := CliOption{}, false
		for _, section := range help.Sections {
			if option, ok = optionByName(section, name); ok {
				break
			}
		}
		if !ok {
			t.Errorf("没有解析出 -%s", name)
			continue
		}
		if !option.StreamSpec {
			t.Errorf("-%s 应当标记为可带流定位符", name)
		}
	}
}

// TestRefreshDropsCaches 锁住一个容易漏掉的行为：换过 FFmpeg 之后，
// 按旧二进制缓存下来的东西必须一起作废。
func TestRefreshDropsCaches(t *testing.T) {
	path, err := exec.LookPath("ffmpeg")
	if err != nil {
		t.Skip("本机没有 ffmpeg")
	}
	service := NewService(path, "ffprobe")

	if _, err := service.CliHelp("long"); err != nil {
		t.Fatalf("CliHelp 失败: %v", err)
	}
	if _, err := service.Help("muxer", "mp4"); err != nil {
		t.Fatalf("Help 失败: %v", err)
	}
	if _, err := service.Extensions("demuxer"); err != nil {
		t.Fatalf("Extensions 失败: %v", err)
	}

	cached := func() int {
		service.helpMu.Lock()
		defer service.helpMu.Unlock()
		return len(service.help) + len(service.cliCache) + len(service.extCache)
	}
	if cached() == 0 {
		t.Fatal("查了三种东西之后缓存不该是空的")
	}

	// 用户点「重新查询能力」就是在说「服务器上的 ffmpeg 换了」。少了清缓存这步，
	// 命令行选项面板与扩展名列表会继续用旧版本的说法。
	if err := service.Refresh(); err != nil {
		t.Fatalf("Refresh 失败: %v", err)
	}
	if left := cached(); left != 0 {
		t.Errorf("Refresh 之后缓存应当清空，实际还剩 %d 条", left)
	}
}
