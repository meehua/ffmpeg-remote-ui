package ffmpeg

import (
	"os/exec"
	"reflect"
	"strings"
	"testing"
)

// sampleFullHelp 是 `ffmpeg -h full`（FFmpeg 8.0.1）的真实片段，逐行抄自
// 本机输出，缩进原样保留：
//
//   - 公共上下文分节顶格，节内选项缩进 2 格、枚举取值缩进 5 格；
//   - "bluray AVOptions" 是具体组件的私有分节，同样顶格，但不在本次范围内；
//   - -side_data_prefer_packet 的占位符是 `[<int>     ]`，且紧贴 flags。
const sampleFullHelp = `Universal media converter
usage: ffmpeg [options] [[infile options] -i infile]... {[outfile options] outfile}...

Global options (affect whole program instead of just one file):
-y                  overwrite output files

AVCodecContext AVOptions:
  -b                 <int64>      E..VA...... set bitrate (in bits/s) (from 0 to I64_MAX) (default 200000)
  -flags             <flags>      ED.VAS..... (default 0)
  -g                 <int>        E..V....... set the group of picture (GOP) size (from INT_MIN to INT_MAX) (default 12)
  -bf                <int>        E..V....... set maximum number of B-frames between non-B-frames (from -1 to INT_MAX) (default 0)
  -maxrate           <int64>      E..VA...... maximum bitrate (in bits/s). Used for VBV together with bufsize. (from 0 to INT_MAX) (default 0)
  -global_quality    <int>        E..VA...... (from INT_MIN to INT_MAX) (default 0)
  -profile           <int>        E..VA...... (from INT_MIN to INT_MAX) (default unknown)
  -level             <int>        E..VA...... (from INT_MIN to INT_MAX) (default unknown)
  -side_data_prefer_packet [<int>     ].D.VAS..... Comma-separated list of side data types for which user-supplied data is preferred
  -threads           <int>        ED.VA...... set the number of threads (from 0 to INT_MAX) (default 1)

AVFormatContext AVOptions:
  -probesize         <int64>      .D......... set probing size (from 32 to I64_MAX) (default 5000000)
  -fflags            <flags>      ED......... (default autobsf)
     flush_packets                E.......... reduce the latency by flushing out packets immediately

bluray AVOptions:
  -playlist          <int>        .D.........  (from -1 to 99999) (default -1)
`

// TestParseOptionGroupsKeepsOnlyContexts 锁住分节的取舍：只有公共上下文
// 分节进得来，具体组件的私有分节（bluray AVOptions）不进——那些该由
// `-h <target>=<名>` 回答。
func TestParseOptionGroupsKeepsOnlyContexts(t *testing.T) {
	groups := parseOptionGroups(sampleFullHelp)

	want := []struct{ name, component string }{
		{"AVCodecContext", "codec"},
		{"AVFormatContext", "format"},
	}
	if len(groups) != len(want) {
		t.Fatalf("分节 = %#v，期望 %d 个", groups, len(want))
	}
	for i, w := range want {
		if groups[i].Name != w.name || groups[i].Component != w.component {
			t.Errorf("第 %d 节 = %q/%q，期望 %q/%q",
				i, groups[i].Name, groups[i].Component, w.name, w.component)
		}
	}
	for _, g := range groups {
		if g.Name == "bluray" {
			t.Error("具体组件的私有分节不该被当成公共上下文收进来")
		}
	}
}

// TestParseOptionGroupsOptions 检查选项本身：名字、类型、组件层回填，
// 以及 `[<int>     ].D.VAS.....` 这种畸形占位符行也必须解析出来。
func TestParseOptionGroupsOptions(t *testing.T) {
	codec := (&OptionGroups{Groups: parseOptionGroups(sampleFullHelp)}).Group("codec")
	if codec == nil {
		t.Fatal("没有解析出 codec 组")
	}

	byName := map[string]Option{}
	for _, o := range codec.Options {
		byName[o.Name] = o
		if o.Component != "codec" {
			t.Errorf("%s 的 component = %q，期望 codec", o.Name, o.Component)
		}
	}

	gq, ok := byName["global_quality"]
	if !ok {
		t.Fatalf("没有解析出 global_quality；实际得到 %d 个选项", len(codec.Options))
	}
	if gq.Type != "int" || gq.Scope != "encoding" {
		t.Errorf("global_quality 的类型/作用域错误: %#v", gq)
	}
	// "E..VA......" 同时勾了视频与音频两位，必须都收进来。
	if !reflect.DeepEqual(gq.Media, []string{"video", "audio"}) {
		t.Errorf("global_quality 的媒体 = %#v，期望 video+audio", gq.Media)
	}
	if !gq.HasDefault || gq.Default != "0" || gq.Min != "INT_MIN" || gq.Max != "INT_MAX" {
		t.Errorf("global_quality 的默认值/范围错误: %#v", gq)
	}

	// 只看视频的那些不能被当成音频也能用。
	if bf, ok := byName["bf"]; !ok {
		t.Error("没有解析出 bf")
	} else if !reflect.DeepEqual(bf.Media, []string{"video"}) {
		t.Errorf("bf 的媒体 = %#v，期望只有 video", bf.Media)
	}

	// 编解码两侧都能设的选项不是「编码专用」。
	if fl, ok := byName["flags"]; !ok {
		t.Error("没有解析出 flags")
	} else if fl.Scope != "shared" {
		t.Errorf("flags 的 scope = %q，期望 shared", fl.Scope)
	}
	if th, ok := byName["threads"]; !ok {
		t.Error("没有解析出 threads")
	} else if th.Scope != "shared" {
		t.Errorf("threads 的 scope = %q，期望 shared", th.Scope)
	}

	// 占位符写成 `[<int>     ]` 且紧贴 flags 的那一行。
	sd, ok := byName["side_data_prefer_packet"]
	if !ok {
		t.Fatal("畸形占位符行被丢掉了")
	}
	if sd.Type != "int" || sd.Scope != "decoding" {
		t.Errorf("side_data_prefer_packet 解析错误: %#v", sd)
	}
}

// TestParseOptionGroupsEnumValues 检查取值行归到所属选项，而不是自己变成选项。
func TestParseOptionGroupsEnumValues(t *testing.T) {
	format := (&OptionGroups{Groups: parseOptionGroups(sampleFullHelp)}).Group("format")
	if format == nil {
		t.Fatal("没有解析出 format 组")
	}
	for _, o := range format.Options {
		if o.Name != "fflags" {
			continue
		}
		if len(o.Values) != 1 || o.Values[0].Name != "flush_packets" {
			t.Fatalf("fflags 的枚举值解析错误: %#v", o.Values)
		}
		return
	}
	t.Fatal("没有解析出 fflags")
}

// TestParseOptionGroupsCRLF 锁住一个只在 Windows 上发作的坑：ffmpeg 的输出带
// CRLF 时，行尾的 \r 会让「顶格 ⇒ 分节标题」的判定永远不成立，整份解析一声
// 不响地空掉——界面于是少了一整层参数，而没有任何报错。
func TestParseOptionGroupsCRLF(t *testing.T) {
	crlf := strings.ReplaceAll(sampleFullHelp, "\n", "\r\n")

	groups := parseOptionGroups(crlf)
	if len(groups) == 0 {
		t.Fatal("CRLF 输入下没有解析出任何分节")
	}
	codec := (&OptionGroups{Groups: groups}).Group("codec")
	if codec == nil {
		t.Fatal("CRLF 输入下没有 codec 组")
	}
	for _, o := range codec.Options {
		if o.Name == "global_quality" {
			return
		}
	}
	t.Errorf("CRLF 输入下没有解析出 global_quality（实际 %d 项）", len(codec.Options))
}

// TestParseOptionGroupsIgnoresNonOptions 是上一条的负例：说明行与枚举取值行
// 都不能被当成选项。optionRE 把「占位符」与「flags」之间的空白从 \s+ 放宽成了
// \s*（为了吃下 `[<int>     ]` 那种畸形行），这里钉住它没有顺手吃下别的。
func TestParseOptionGroupsIgnoresNonOptions(t *testing.T) {
	raw := `AVCodecContext AVOptions:
  -b                 <int64>      E..VA...... set bitrate (in bits/s) (default 200000)
  A continuation line mentioning something like E..VA...... but not an option
     veryfast         7            E..V.......
  -g                 <int>        E..V....... set the group of picture size (from INT_MIN to INT_MAX) (default 12)
`
	codec := (&OptionGroups{Groups: parseOptionGroups(raw)}).Group("codec")
	if codec == nil {
		t.Fatal("没有解析出 codec 组")
	}
	if len(codec.Options) != 2 {
		t.Fatalf("期望 2 个选项（b 与 g），得到 %d 个: %#v", len(codec.Options), codec.Options)
	}
	if codec.Options[0].Name != "b" || codec.Options[1].Name != "g" {
		t.Errorf("选项名解析错误: %#v", codec.Options)
	}
	// 取值行属于上面那个选项，不该另外冒出一个叫 veryfast 的选项。
	for _, o := range codec.Options {
		if o.Name == "veryfast" || o.Name == "A" {
			t.Errorf("非选项行被当成了选项: %#v", o)
		}
	}
}

// TestContextSection 锁住「哪些分节算公共上下文」这条判据。
func TestContextSection(t *testing.T) {
	cases := []struct {
		title     string
		name      string
		component string
		ok        bool
	}{
		{"AVCodecContext AVOptions:", "AVCodecContext", "codec", true},
		{"AVFormatContext AVOptions:", "AVFormatContext", "format", true},
		{"AVIOContext AVOptions:", "AVIOContext", "io", true},
		{"URLContext AVOptions:", "URLContext", "url", true},
		// 具体组件的私有分节：不是公共上下文。
		{"libx264 AVOptions:", "", "", false},
		{"H.264 encoder AVOptions:", "", "", false},
		{"bluray AVOptions:", "", "", false},
		{"Global options (affect whole program instead of just one file):", "", "", false},
	}
	for _, c := range cases {
		name, component, ok := contextSection(c.title)
		if ok != c.ok || name != c.name || component != c.component {
			t.Errorf("contextSection(%q) = %q/%q/%v，期望 %q/%q/%v",
				c.title, name, component, ok, c.name, c.component, c.ok)
		}
	}
}

// TestOptionGroupsAgainstRealFFmpeg 用真实 ffmpeg 验证这次修复要解决的
// 那件事：`-h encoder=<名>` 看不到的通用编码选项，必须能从公共上下文层拿到。
func TestOptionGroupsAgainstRealFFmpeg(t *testing.T) {
	path, err := exec.LookPath("ffmpeg")
	if err != nil {
		t.Skip("本机没有 ffmpeg")
	}
	service := NewService(path, "ffprobe")

	groups, err := service.OptionGroups()
	if err != nil {
		t.Fatalf("OptionGroups 失败: %v", err)
	}
	codec := groups.Group("codec")
	if codec == nil {
		t.Fatalf("没有 codec 公共上下文层；实际分节 %#v", groups.Groups)
	}

	// global_quality、b、maxrate、bufsize 这批对所有编码器可用，
	// 但一个都不在 `-h encoder=<名>` 的输出里——它们只能从这里来。
	names := map[string]Option{}
	for _, o := range codec.Options {
		names[o.Name] = o
	}
	for _, want := range []string{"global_quality", "b", "maxrate", "bufsize", "g", "bf", "profile", "level"} {
		if _, ok := names[want]; !ok {
			t.Errorf("codec 公共上下文层里缺少 %s", want)
		}
	}
	// 取值控制参数必须带着 FFmpeg 给的范围与默认值，界面才有东西可填。
	if gq := names["global_quality"]; gq.Scope != "encoding" {
		t.Errorf("global_quality 不是编码选项: %#v", gq)
	} else if len(gq.Media) == 0 {
		t.Errorf("global_quality 没有解析出媒体类型: %#v", gq)
	}

	// 私有层与公共层是两个来源，界面必须同时拿到：hevc_qsv 自己注册的
	// 参数在 `-h encoder=hevc_qsv` 里，而 global_quality 只在上面的层里。
	h, err := service.Help("encoder", "hevc_qsv")
	if err != nil {
		t.Fatalf("Help(encoder, hevc_qsv) 失败: %v", err)
	}
	if len(h.Options) == 0 {
		t.Error("hevc_qsv 的私有参数解析为空")
	}
	private := map[string]bool{}
	for _, o := range h.Options {
		private[o.Name] = true
	}
	if private["global_quality"] {
		t.Error("global_quality 不该出现在编码器私有参数里（来源是公共上下文层）")
	}
	if !private["low_power"] && !private["async_depth"] {
		t.Errorf("hevc_qsv 的私有参数看起来没解析出来: %d 项", len(h.Options))
	}
}

// TestRefreshDropsOptionGroups 锁住缓存失效：Refresh 之后公共上下文层
// 必须重新查询，否则换了 ffmpeg 还会拿旧版本的分节。
func TestRefreshDropsOptionGroups(t *testing.T) {
	path, err := exec.LookPath("ffmpeg")
	if err != nil {
		t.Skip("本机没有 ffmpeg")
	}
	service := NewService(path, "ffprobe")
	if _, err := service.OptionGroups(); err != nil {
		t.Fatalf("OptionGroups 失败: %v", err)
	}

	service.helpMu.Lock()
	cached := len(service.groupCache)
	service.helpMu.Unlock()
	if cached == 0 {
		t.Fatal("查过之后缓存不该是空的")
	}

	if err := service.Refresh(); err != nil {
		t.Fatalf("Refresh 失败: %v", err)
	}
	service.helpMu.Lock()
	left := len(service.groupCache)
	service.helpMu.Unlock()
	if left != 0 {
		t.Errorf("Refresh 之后缓存应当清空，实际还剩 %d 条", left)
	}
}
