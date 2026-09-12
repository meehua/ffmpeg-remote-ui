package ffmpeg

import "strings"

// 用户手写的命令行与 argv 之间的互转。
//
// 规则按平台分成两份实现（args_posix.go / args_windows.go），因为两边的约定
// 本来就不一样：
//
//	POSIX  —— 单引号与双引号都能引用，反斜杠在单引号外是转义前缀；
//	Windows—— 只有双引号是引用符，反斜杠是路径分隔符；它只有在双引号内紧邻
//	          引号时才参与转义，且按 CommandLineToArgvW 的 2n/2n+1 规则。
//
// 两条硬约束：生成（shellJoin）与解析（SplitArgs）必须互逆；生成的写法在目标
// 平台的终端里粘贴后含义不变。前端有一份同样的实现，改动必须两边同步。

// stripToolPrefix 去掉用户连在一起粘贴过来的 ffmpeg/ffprobe 程序名。
//
// 只看最后一个路径分隔符之后的那一段，因此 Windows 的 C:\tools\ffmpeg.exe 与
// Linux 的 /usr/bin/ffmpeg 表现一致；.exe 后缀与大小写按 Windows 的习惯宽容处理。
func stripToolPrefix(args []string) []string {
	if len(args) == 0 {
		return args
	}
	name := args[0]
	if i := strings.LastIndexAny(name, `/\`); i >= 0 {
		name = name[i+1:]
	}
	name = strings.TrimSuffix(strings.ToLower(name), ".exe")
	if name == "ffmpeg" || name == "ffprobe" {
		return args[1:]
	}
	return args
}

// shellJoin 生成可直接粘贴到终端执行的命令预览。
func shellJoin(fields []string) string {
	parts := make([]string, len(fields))
	for i, f := range fields {
		parts[i] = quoteArg(f)
	}
	return strings.Join(parts, " ")
}
