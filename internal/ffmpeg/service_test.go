package ffmpeg

import (
	"reflect"
	"testing"
)

// 下面的样例都取自 ffmpeg 真实输出的结构，覆盖「第一列是 flags」与
// 「第一列是名称」两种列表，以及 filter 选项没有前导 '-' 的差异。

func TestParseFlagTableEncoders(t *testing.T) {
	raw := `Encoders:
 V..... = Video
 A..... = Audio
 ------
 V....D libx265 H.265 encoder
 A....D aac AAC encoder
 S..... srt SubRip subtitle`

	got := parseFlagTable(raw)
	if len(got) != 3 {
		t.Fatalf("期望 3 项，得到 %d 项: %#v", len(got), got)
	}
	for i, name := range []string{"libx265", "aac", "srt"} {
		if got[i].Name != name {
			t.Errorf("第 %d 项名称 = %q，期望 %q", i, got[i].Name, name)
		}
	}
	if got[0].Flags != "V....D" || got[0].Description != "H.265 encoder" {
		t.Errorf("flags/描述解析错误: %#v", got[0])
	}
}

func TestParseFlagTableFilters(t *testing.T) {
	raw := `Filters:
 T.. aap              AA->A  Apply affine
 .. abench            A->A   Benchmark
 TS scale             V->V   Scale video`

	got := parseFlagTable(raw)
	if len(got) != 3 {
		t.Fatalf("期望 3 项，得到 %d 项", len(got))
	}
	annotate("-filters", got)
	if got[2].Name != "scale" || got[2].Extra["io"] != "V->V" {
		t.Fatalf("滤镜解析错误: %#v", got[2])
	}
	if got[2].Description != "Scale video" {
		t.Errorf("描述应剔除 I/O 列，得到 %q", got[2].Description)
	}
}

// 真实的 -pix_fmts 数据行只有 4 列，旧实现要求 5 列导致这里永远是空的。
func TestParseFlagTablePixelFormats(t *testing.T) {
	raw := `Pixel formats:
I.... = Supported Input  format for conversion
.O... = Supported Output format for conversion
FLAGS NAME            NB_COMPONENTS BITS_PER_PIXEL
-----
IO... yuv420p                3            12`

	got := parseFlagTable(raw)
	if len(got) != 1 {
		t.Fatalf("期望 1 项，得到 %d 项: %#v", len(got), got)
	}
	annotate("-pix_fmts", got)
	if got[0].Name != "yuv420p" || got[0].Flags != "IO..." {
		t.Fatalf("名称或 flags 解析错误: %#v", got[0])
	}
	if got[0].Extra["components"] != "3" || got[0].Extra["bitsPerPixel"] != "12" {
		t.Errorf("列语义标注错误: %#v", got[0].Extra)
	}
}

// 没有 flags 列的表：第一列就是名称。这里最容易出错的是频道布局 FL/FR，
// 它们的形态与设备的 DE 完全一致，不能靠「像不像 flags」来判断。
func TestParseNameTableWithoutFlags(t *testing.T) {
	t.Run("layouts", func(t *testing.T) {
		raw := `Individual channels:
NAME           DESCRIPTION
FL             front left
FR             front right
Standard channel layouts:
NAME           DESCRIPTION
5.1            5.1 Surround`
		got := parseNameTable(raw)
		if len(got) != 3 {
			t.Fatalf("期望 3 项，得到 %d 项: %#v", len(got), got)
		}
		if got[0].Name != "FL" || got[0].Description != "front left" {
			t.Errorf("FL 解析错误: %#v", got[0])
		}
		if got[2].Name != "5.1" {
			t.Errorf("标准布局解析错误: %#v", got[2])
		}
	})

	t.Run("protocols_dedup", func(t *testing.T) {
		raw := `Supported file protocols:
Input:
  file
  http
Output:
  file
  rtmp`
		got := parseNameTable(raw)
		if len(got) != 3 {
			t.Fatalf("Input/Output 重复项应去重，得到 %d 项: %#v", len(got), got)
		}
	})

	// -bsfs 没有 flags 列，旧实现按 6 位 flags 过滤后会返回空列表。
	t.Run("bitstream_filters", func(t *testing.T) {
		raw := `Bitstream filters:
aac_adtstoasc
h264_mp4toannexb
hevc_mp4toannexb`
		got := parseNameTable(raw)
		if len(got) != 3 {
			t.Fatalf("期望 3 项，得到 %d 项: %#v", len(got), got)
		}
		if got[0].Name != "aac_adtstoasc" {
			t.Errorf("首个 bsf = %q", got[0].Name)
		}
	})

	t.Run("colors_extra", func(t *testing.T) {
		raw := `NAME            #RRGGBB
AliceBlue       0xF0F8FF
AntiqueWhite    0xFAEBD7`
		got := parseNameTable(raw)
		annotate("-colors", got)
		if len(got) != 2 {
			t.Fatalf("期望 2 项，得到 %d 项: %#v", len(got), got)
		}
		if got[0].Extra["hex"] != "0xF0F8FF" {
			t.Errorf("颜色十六进制解析错误: %#v", got[0])
		}
	})
}

func TestParseHelpEncoder(t *testing.T) {
	raw := `Encoder libx264 [libx264 H.264 / AVC / MPEG-4 AVC]:
    General capabilities: dr1 delay threads
    Threading capabilities: other
    Supported pixel formats: yuv420p yuv444p
libx264 AVOptions:
  -preset            <string>     E..V....... Set the encoding preset (default "medium")
  -bf                <int>        E..V....... (from -1 to INT_MAX) (default -1)
     veryfast         7            E..V.......
     medium           4            E..V.......`

	h := parseHelp("encoder", "libx264", raw)

	if h.Kind != "Encoder" {
		t.Errorf("Kind = %q", h.Kind)
	}
	if !reflect.DeepEqual(h.Capabilities, []string{"dr1", "delay", "threads"}) {
		t.Errorf("capabilities = %#v", h.Capabilities)
	}
	if !reflect.DeepEqual(h.PixelFormats, []string{"yuv420p", "yuv444p"}) {
		t.Errorf("pixelFormats = %#v", h.PixelFormats)
	}
	if len(h.Sections) != 1 || h.Sections[0].Name != "libx264" {
		t.Fatalf("分组错误: %#v", h.Sections)
	}
	if len(h.Options) != 2 {
		t.Fatalf("期望 2 个选项，得到 %d 个: %#v", len(h.Options), h.Options)
	}

	preset := h.Options[0]
	if preset.Name != "preset" || preset.Type != "string" {
		t.Errorf("preset 基本字段错误: %#v", preset)
	}
	if !preset.HasDefault || preset.Default != "medium" {
		t.Errorf("默认值应去掉引号: %#v", preset)
	}
	if preset.Scope != "encoding" || preset.Media != "video" {
		t.Errorf("flags 语义解析错误: %#v", preset)
	}
	if preset.Description != "Set the encoding preset" {
		t.Errorf("描述应剔除默认值: %q", preset.Description)
	}

	bf := h.Options[1]
	if bf.Min != "-1" || bf.Max != "INT_MAX" {
		t.Errorf("取值范围解析错误: %#v", bf)
	}
	if len(bf.Values) != 2 || bf.Values[1].Name != "medium" {
		t.Errorf("枚举值解析错误: %#v", bf.Values)
	}
}

func TestParseHelpFilter(t *testing.T) {
	// filter 的选项行没有前导 '-'，端口说明另起一行，枚举行带空值的形态也存在。
	raw := `Filter scale
  Scale the input video size and/or convert the image format.
    Inputs:
       #0: default (video)
        dynamic (depending on the options)
    Outputs:
       #0: default (video)
scale AVOptions:
   w                 <string>     ..FV.....T. Output video width
   in_color_matrix   <int>        ..FV....... set input YCbCr type (from -1 to 17) (default auto)
     auto            -1           ..FV.......
     bt709           1            ..FV.......`

	h := parseHelp("filter", "scale", raw)

	if h.Kind != "Filter" {
		t.Errorf("Kind = %q", h.Kind)
	}
	if h.Summary != "Scale the input video size and/or convert the image format." {
		t.Errorf("Summary = %q", h.Summary)
	}
	if len(h.Inputs) != 1 || h.Inputs[0].Name != "default" || h.Inputs[0].Media != "video" {
		t.Fatalf("输入端口解析错误: %#v", h.Inputs)
	}
	if h.Inputs[0].Note != "dynamic (depending on the options)" {
		t.Errorf("端口补充说明丢失: %#v", h.Inputs[0])
	}
	if len(h.Outputs) != 1 {
		t.Fatalf("输出端口解析错误: %#v", h.Outputs)
	}
	if len(h.Options) != 2 {
		t.Fatalf("期望 2 个选项，得到 %d 个: %#v", len(h.Options), h.Options)
	}
	if h.Options[0].Name != "w" || !h.Options[0].Runtime {
		t.Errorf("filter 选项解析错误: %#v", h.Options[0])
	}

	cm := h.Options[1]
	if cm.Min != "-1" || cm.Max != "17" || cm.Default != "auto" {
		t.Errorf("范围/默认值解析错误: %#v", cm)
	}
	if len(cm.Values) != 2 || cm.Values[1].Value != "1" {
		t.Errorf("枚举值解析错误: %#v", cm.Values)
	}
	if cm.Description != "set input YCbCr type" {
		t.Errorf("描述 = %q", cm.Description)
	}
}

// flags 型选项的取值列是空的，例如 -movflags 的 cmaf/dash。
func TestParseHelpFlagsOption(t *testing.T) {
	raw := `Muxer mp4 [MP4 (MPEG-4 Part 14)]:
    Common extensions: mp4.
mov/mp4 muxer AVOptions:
  -movflags          <flags>      E.......... MOV muxer flags (default 0)
     cmaf                         E.......... Write CMAF compatible fragmented MP4
     faststart                    E.......... Run a second pass to put the index at the beginning`

	h := parseHelp("muxer", "mp4", raw)
	if len(h.Properties) != 1 || h.Properties[0].Name != "Common extensions" {
		t.Fatalf("元信息解析错误: %#v", h.Properties)
	}
	if len(h.Options) != 1 {
		t.Fatalf("期望 1 个选项，得到 %d 个", len(h.Options))
	}
	opt := h.Options[0]
	if opt.Type != "flags" || opt.PerStream {
		t.Errorf("flags 选项解析错误: %#v", opt)
	}
	if len(opt.Values) != 2 || opt.Values[0].Name != "cmaf" || opt.Values[0].Value != "" {
		t.Errorf("空取值列解析错误: %#v", opt.Values)
	}
}

func TestSplitArgs(t *testing.T) {
	cases := []struct {
		in   string
		want []string
	}{
		{`-i in.mp4 -c:v libx264 -crf 23`, []string{"-i", "in.mp4", "-c:v", "libx264", "-crf", "23"}},
		{`-i "my movie.mp4" out.mkv`, []string{"-i", "my movie.mp4", "out.mkv"}},
		{`-vf "scale=1280:-2,fps=30"`, []string{"-vf", "scale=1280:-2,fps=30"}},
		{`-metadata "title=it's fine"`, []string{"-metadata", "title=it's fine"}},
		{`ffmpeg -y -i a.mp4 b.mp4`, []string{"-y", "-i", "a.mp4", "b.mp4"}},
		{`/usr/bin/ffmpeg -y`, []string{"-y"}},
		{"-i a.mp4\n-c:v copy", []string{"-i", "a.mp4", "-c:v", "copy"}},
	}
	for _, c := range cases {
		got, err := SplitArgs(c.in)
		if err != nil {
			t.Errorf("SplitArgs(%q) 出错: %v", c.in, err)
			continue
		}
		if !reflect.DeepEqual(got, c.want) {
			t.Errorf("SplitArgs(%q) = %#v，期望 %#v", c.in, got, c.want)
		}
	}

	if _, err := SplitArgs(`-i "未闭合`); err == nil {
		t.Error("未闭合的引号应当报错")
	}
}

// shellQuote 与 SplitArgs 必须互逆：命令预览里的写法要能被原样解析回来，
// 否则「看到的命令」与「实际执行的命令」会不一致。
func TestQuoteRoundTrip(t *testing.T) {
	args := []string{
		"-i", "a b.mp4",
		"-metadata", "title=it's fine",
		"-vf", "scale=1280:-2,fps=30",
		"out;rm -rf.mp4",
	}
	line := shellJoin(args)
	got, err := SplitArgs(line)
	if err != nil {
		t.Fatalf("解析 shellJoin 生成的命令失败: %v\n  %s", err, line)
	}
	if !reflect.DeepEqual(got, args) {
		t.Fatalf("往返不一致:\n  原始 %#v\n  生成 %s\n  解析 %#v", args, line, got)
	}
}

func TestShellQuote(t *testing.T) {
	cases := map[string]string{
		"plain":       "plain",
		"":            "''",
		"a b":         "'a b'",
		"it's":        `'it'\''s'`,
		"scale=128:2": "scale=128:2",
		"-vf":         "-vf",
		"a;rm -rf /":  "'a;rm -rf /'",
	}
	for in, want := range cases {
		if got := shellQuote(in); got != want {
			t.Errorf("shellQuote(%q) = %q，期望 %q", in, got, want)
		}
	}
}

func TestCommandPreview(t *testing.T) {
	s := &Service{ffmpeg: "ffmpeg"}
	got := s.Command([]string{"-i", "a file.mp4", "-c:v", "copy", "out.mp4"})
	want := `ffmpeg -i 'a file.mp4' -c:v copy out.mp4`
	if got != want {
		t.Errorf("Command() = %q，期望 %q", got, want)
	}
}

func TestMediaInfoDuration(t *testing.T) {
	info := MediaInfo{Format: map[string]any{"duration": "12.5"}}
	if got := info.Duration().Milliseconds(); got != 12500 {
		t.Errorf("Duration() = %d ms，期望 12500", got)
	}
	if got := (MediaInfo{Format: map[string]any{}}).Duration(); got != 0 {
		t.Errorf("缺少 duration 时应返回 0，得到 %v", got)
	}
}
