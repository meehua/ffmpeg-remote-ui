package ffmpeg

import "testing"

// 这个文件盯着一件事：`-h <target>=<名>` 的输出形态**按 target 不同而不同**。
// 界面上的每一块参数面板都直接建立在 parseHelp 之上，所以这些差异一旦漏掉，
// 结果不是报错，而是面板静静地少一整层——用户只会觉得「这个参数没有」。
//
// 三处差异都是 FFmpeg 自己的写法，不是解析器的取舍：
//
//   - filter 的选项行没有前导 '-'（`w <string> ..FV.....T.`），
//     encoder / muxer / bsf / protocol / demuxer 的有；
//   - muxer 的分节名是一组格式名（"mov/mp4/… muxer AVOptions:"），
//     不是用户查的那个名字；
//   - protocol 没有标题行（输出直接以 "http AVOptions:" 开头），
//     而 bsf 可能一个 AVOptions 分节都没有——「没有参数」不是解析失败。
//
// 下面每一段都是 FFmpeg 8.0.1 的原文片段，只裁掉了与解析无关的尾部。

const sampleFilterHelp = `Filter scale
  Scale the input video size and/or convert the image format.
    Inputs:
       #0: default (video)
    Outputs:
       #0: default (video)
scale AVOptions:
   w                 <string>     ..FV.....T. Output video width
   h                 <string>     ..FV.....T. Output video height
   in_color_matrix   <int>        ..FV....... set input YCbCr type (from -1 to 17) (default auto)
     auto            -1           ..FV.......
     bt709           1            ..FV.......
`

const sampleBSFOptionsHelp = `Bit stream filter h264_metadata
    Supported codecs: h264
h264_metadata_bsf AVOptions:
  -aud               <int>        ...V....B.. Access Unit Delimiter NAL units (from 0 to 2) (default pass)
     pass            0            ...V....B..
     insert          1            ...V....B..
`

// bsf 也可以一个参数都没有（h264_mp4toannexb 就是）。这份输出里除了标题与
// "Supported codecs" 之外什么都没有。
const sampleBSFEmptyHelp = `Bit stream filter h264_mp4toannexb
    Supported codecs: h264

`

const sampleMuxerHelp = `Muxer mp4 [MP4 (MPEG-4 Part 14)]:
    Common extensions: mp4.
    Default video codec: h264.
mov/mp4/tgp/psp/tg2/ipod/ismv muxer AVOptions:
  -brand             <string>     E.......... Override major brand
  -frag_duration     <int>        E.......... Maximum fragment duration (from 0 to INT_MAX) (default 0)
  -movflags          <flags>      E.......... MOV muxer flags (default 0)
     cmaf                         E.......... Write CMAF compatible fragmented MP4
`

// 设备在 FFmpeg 眼里就是 demuxer/muxer，所以 V4L2 的参数走 demuxer= 这条路径。
const sampleIndevHelp = `Demuxer video4linux2,v4l2 [Video4Linux2 device grab]:
V4L2 indev AVOptions:
  -video_size        <image_size> .D......... set frame size
  -framerate         <string>     .D......... set frame rate
`

// protocol 是唯一没有标题行的目标：输出直接以分节开头。
const sampleProtocolHelp = `http AVOptions:
  -seekable          <boolean>    .D......... control seekability of connection (default auto)
  -http_proxy        <string>     ED......... set HTTP proxy to tunnel through
`

func TestParseHelpTargetShapes(t *testing.T) {
	optionNamed := func(help Help, name string) (Option, bool) {
		for _, option := range help.Options {
			if option.Name == name {
				return option, true
			}
		}
		return Option{}, false
	}

	tests := []struct {
		target string
		name   string
		raw    string
		// wantKind 是 FFmpeg 标题里读出来的组件种类；protocol 没有标题行，
		// 所以它这一项是空串。
		wantKind string
		// wantSection 是第一个 AVOptions 分节的原文名；没有分节时为空串。
		wantSection string
		// wantOption 是必然存在的一个选项名（不含前导 '-'）。
		wantOption string
	}{
		{"filter", "scale", sampleFilterHelp, "Filter", "scale", "w"},
		{"bsf", "h264_metadata", sampleBSFOptionsHelp, "Bitstream filter", "h264_metadata_bsf", "aud"},
		{"muxer", "mp4", sampleMuxerHelp, "Muxer", "mov/mp4/tgp/psp/tg2/ipod/ismv muxer", "brand"},
		{"demuxer", "v4l2", sampleIndevHelp, "Demuxer", "V4L2 indev", "video_size"},
		{"protocol", "http", sampleProtocolHelp, "", "http", "http_proxy"},
	}
	for _, tt := range tests {
		t.Run(tt.target, func(t *testing.T) {
			help := parseHelp(tt.target, tt.name, tt.raw)

			if help.Kind != tt.wantKind {
				t.Errorf("Kind = %q，期望 %q", help.Kind, tt.wantKind)
			}
			if len(help.Sections) == 0 {
				t.Fatalf("没有解析出任何 AVOptions 分节；实际分节为空")
			}
			if got := help.Sections[0].Name; got != tt.wantSection {
				t.Errorf("第一个分节名 = %q，期望 %q", got, tt.wantSection)
			}
			// 选项名一律不带前导 '-'：filter 本来就没有，带 '-' 的那些由正则去掉。
			if _, ok := optionNamed(help, "-"+tt.wantOption); ok {
				t.Errorf("选项名 %q 带上了前导 -", tt.wantOption)
			}
			if _, ok := optionNamed(help, tt.wantOption); !ok {
				t.Errorf("没有解析出选项 %q", tt.wantOption)
			}

			// filter 的标题后面跟着一句缩进说明（只有 filter 有），
			// 它和标题一样是 FFmpeg 的原文，不能丢。
			if tt.target == "filter" && help.Summary == "" {
				t.Error("filter 的标题说明没有读出来")
			}
		})
	}
}

// filter 是唯一不带前导 '-' 的形态，枚举取值行也必须照样收进来：
// scale 的 in_color_matrix 在 ffmpeg 里是一张具名取值表，界面靠它出下拉。
func TestParseHelpFilterValuesAndFlags(t *testing.T) {
	help := parseHelp("filter", "scale", sampleFilterHelp)

	var target *Option
	for i := range help.Options {
		if help.Options[i].Name == "in_color_matrix" {
			target = &help.Options[i]
		}
	}
	if target == nil {
		t.Fatal("没有解析出 in_color_matrix")
	}
	if len(target.Values) != 2 {
		t.Fatalf("in_color_matrix 的取值数 = %d，期望 2", len(target.Values))
	}
	if target.HasDefault != true || target.Default != "auto" {
		t.Errorf("默认值 = %q（hasDefault=%v），期望 auto", target.Default, target.HasDefault)
	}
	// "..FV......." 里的 V 是视频位：枚举取值那一行同样要带上媒体类型。
	if len(target.Media) != 1 || target.Media[0] != "video" {
		t.Errorf("media = %v，期望 [video]", target.Media)
	}

	// T 位（可运行时修改）在 scale 的 w/h 上，不在枚举项上——两者都要读对。
	var width *Option
	for i := range help.Options {
		if help.Options[i].Name == "w" {
			width = &help.Options[i]
		}
	}
	if width == nil {
		t.Fatal("没有解析出 w")
	}
	if width.Flags != "..FV.....T." {
		t.Errorf("w 的 flags = %q，期望 ..FV.....T.", width.Flags)
	}
	if !width.Runtime {
		t.Error("T 位没有读成 runtime")
	}
	if width.Type != "string" {
		t.Errorf("w 的类型 = %q，期望 string", width.Type)
	}
}

// protocol 是唯一没有标题行的目标：它的 Kind 只能为空——这不是解析失败，
// 而是 FFmpeg 就这么写的（输出直接从分节名开始）。
func TestParseHelpProtocolHasNoTitleLine(t *testing.T) {
	help := parseHelp("protocol", "http", sampleProtocolHelp)

	if help.Title != "" {
		t.Errorf("Title = %q，期望为空（ffmpeg 没有标题行）", help.Title)
	}
	if len(help.Options) != 2 {
		t.Fatalf("选项数 = %d，期望 2", len(help.Options))
	}
	if help.Options[0].Name != "seekable" || help.Options[0].Type != "boolean" {
		t.Errorf("第一个选项 = %+v", help.Options[0])
	}
}

// 「这个 bsf 没有参数」与「解析失败」必须分得清：前者是 FFmpeg 的答案，
// 界面照实说「它没有可调参数」，而不是报错。
func TestParseHelpWithoutOptionsIsNotAnError(t *testing.T) {
	help := parseHelp("bsf", "h264_mp4toannexb", sampleBSFEmptyHelp)

	if help.Kind != "Bitstream filter" {
		t.Errorf("Kind = %q，期望 Bitstream filter", help.Kind)
	}
	if len(help.Sections) != 0 || len(help.Options) != 0 {
		t.Errorf("分节 = %v、选项 = %v，期望都是空的", help.Sections, help.Options)
	}
	// 同一份输出里的 "Supported codecs" 不能被漏掉：它是 FFmpeg 报的能力。
	if len(help.Codecs) != 1 || help.Codecs[0] != "h264" {
		t.Errorf("codecs = %v，期望 [h264]", help.Codecs)
	}
}

// muxer 的 flags 型选项（-movflags）取值行没有数值列，说明文字照收。
func TestParseHelpMuxerFlagsValues(t *testing.T) {
	help := parseHelp("muxer", "mp4", sampleMuxerHelp)

	var target *Option
	for i := range help.Options {
		if help.Options[i].Name == "movflags" {
			target = &help.Options[i]
		}
	}
	if target == nil {
		t.Fatal("没有解析出 movflags")
	}
	if len(target.Values) != 1 || target.Values[0].Name != "cmaf" {
		t.Fatalf("movflags 的取值 = %v，期望只有 cmaf", target.Values)
	}
	if target.Values[0].Description == "" {
		t.Error("flags 取值的说明文字丢了")
	}
	if target.Scope != "encoding" {
		t.Errorf("scope = %q，期望 encoding（flags 以 E 开头）", target.Scope)
	}
}

// helpTargets 必须与 ffmpeg 用法行里那句 "type=name -- print all options
// for the named decoder/encoder/demuxer/muxer/filter/bsf/protocol" 一致。
// 多收一个（例如 device）不会报错，只会让调用点永远拿 502 而不是 400。
func TestHelpTargetsMatchFFmpegUsageLine(t *testing.T) {
	for _, target := range []string{
		"decoder", "encoder", "demuxer", "muxer", "filter", "bsf", "protocol",
	} {
		if !helpTargets[target] {
			t.Errorf("缺少 ffmpeg 承认的 target %q", target)
		}
	}
	for _, target := range []string{"device", "input", "output", "hwaccel"} {
		if helpTargets[target] {
			t.Errorf("收进了 ffmpeg 不承认的 target %q（实测回 Unknown help option）", target)
		}
	}
	if !helpTargets["full"] {
		t.Error("缺少 full")
	}
}
