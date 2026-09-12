// Package apierr 把「说什么」从「用哪种语言说」里摘出来。
//
// 这个程序原本把面向用户的错误直接写成中文，界面照搬显示——于是界面切成
// 英文之后，服务器报的错仍旧是中文，一半中文一半英文正是要避免的状态。
// 这里给每条错误配一个稳定的 Code 与一组插值参数，界面按当前语言渲染；
// Message 保留成句的中文原文，作为尚未翻译的 code 与旧客户端的兜底。
//
// 只覆盖**用户看得见**的错误。程序内部的错误（解析失败、不变量被破坏）
// 照旧用 fmt.Errorf，它们进的是日志，不是界面。
package apierr

import "fmt"

// Code 是对外契约的一部分：它出现在 HTTP 响应体里，改名等同于破坏兼容。
// 因此用点分小写、按域分组，且只在语义真的变了的时候才改。
type Code string

const (
	// ---- 路径与媒体目录 ----
	CodePathOutsideRoots    Code = "path.outside_roots"     // 路径不在允许的媒体目录中
	CodePathUnresolved      Code = "path.unresolved"        // 无法解析参数里的路径
	CodeArgPathOutsideRoots Code = "arg.path_outside_roots" // 参数里的路径不在允许的媒体目录中

	// ---- 目录创建 ----
	CodeDirEmptyList    Code = "dir.empty_list"
	CodeDirTooMany      Code = "dir.too_many"
	CodeDirNotAbsolute  Code = "dir.not_absolute"
	CodeDirOutsideRoots Code = "dir.outside_roots"
	CodeDirNameTaken    Code = "dir.name_taken"
	CodeDirCreateFailed Code = "dir.create_failed"

	// ---- 目录扫描 ----
	CodeScanPathMissing  Code = "scan.path_missing"
	CodeScanUnavailable  Code = "scan.unavailable"
	CodeScanNotDirectory Code = "scan.not_a_directory"

	// ---- 任务 ----
	CodeJobNotFound           Code = "job.not_found"
	CodeJobInputMissing       Code = "job.input_missing"
	CodeJobOutputMissing      Code = "job.output_missing"
	CodeJobInputOutsideRoots  Code = "job.input_outside_roots"
	CodeJobOutputOutsideRoots Code = "job.output_outside_roots"
	CodeJobTooManyArgs        Code = "job.too_many_args"
	CodeJobArgTooLong         Code = "job.arg_too_long"
	CodeJobArgInvalidChars    Code = "job.arg_invalid_chars"
	CodeJobInputUnreadable    Code = "job.input_unreadable"
	CodeJobInputIsDir         Code = "job.input_is_dir"
	CodeJobOutputDirUnusable  Code = "job.output_dir_unusable"
	CodeJobFFmpegFailed       Code = "job.ffmpeg_failed"
	CodeJobStreamUnsupported  Code = "job.stream_unsupported"
	CodeJobQueueClosed        Code = "job.queue_closed"
	CodeJobIDDuplicate        Code = "job.id_duplicate"
	CodeJobFinished           Code = "job.finished"
	CodeJobNotFinished        Code = "job.not_finished"
	CodeJobStillQueued        Code = "job.still_queued"
	CodeJobInternal           Code = "job.internal"
	CodeJobCancelled          Code = "job.cancelled"

	// ---- 硬件设备实测 ----
	CodeHWTypeUnknown   Code = "hw.type_unknown"    // 设备类型不在 FFmpeg 报告的列表里
	CodeHWNodeInvalid   Code = "hw.node_invalid"    // 设备值不是可以填进 -init_hw_device 的写法
	CodeHWTooManyProbes Code = "hw.too_many_probes" // 一次实测的候选过多

	// ---- 请求体 ----
	CodeBodyInvalidJSON Code = "body.invalid_json"

	// ---- 预设 ----
	CodePresetDirUnavailable  Code = "preset.dir_unavailable"
	CodePresetNotFound        Code = "preset.not_found"
	CodePresetNameEmpty       Code = "preset.name_empty"
	CodePresetNameNotUTF8     Code = "preset.name_not_utf8"
	CodePresetNameTooLong     Code = "preset.name_too_long"
	CodePresetNameLeadingDot  Code = "preset.name_leading_dot"
	CodePresetNameControlChar Code = "preset.name_control_char"
	CodePresetNameForbidden   Code = "preset.name_forbidden"
	CodePresetNameTrailingGap Code = "preset.name_trailing_space"
	CodePresetRecipeInvalid   Code = "preset.recipe_invalid"
	CodePresetRecipeEmpty     Code = "preset.recipe_empty"
	CodePresetRecipeTooLarge  Code = "preset.recipe_too_large"
	CodePresetFileInvalidJSON Code = "preset.file_invalid_json"
	CodePresetReadFailed      Code = "preset.read_failed"
	CodePresetWriteFailed     Code = "preset.write_failed"
	CodePresetRemoveFailed    Code = "preset.remove_failed"
	CodePresetDirCreateFailed Code = "preset.dir_create_failed"
	CodePresetDirReadFailed   Code = "preset.dir_read_failed"
	CodePresetItemUnreadable  Code = "preset.item_unreadable"
	CodePresetItemNotUsable   Code = "preset.item_not_usable"

	// ---- ffmpeg 查询 ----
	CodeFFmpegVersionFailed     Code = "ffmpeg.version_failed"
	CodeFFmpegTargetMissing     Code = "ffmpeg.target_missing"
	CodeFFmpegTargetUnsupported Code = "ffmpeg.target_unsupported"
	CodeFFmpegNameMissing       Code = "ffmpeg.name_missing"
	CodeFFmpegNameTooLong       Code = "ffmpeg.name_too_long"
	CodeFFmpegProbeParseFailed  Code = "ffmpeg.probe_parse_failed"
	CodeFFmpegTimeout           Code = "ffmpeg.timeout"
	CodeFFmpegQuoteUnclosed     Code = "ffmpeg.quote_unclosed"
	CodeFFmpegLevelUnsupported  Code = "ffmpeg.level_unsupported"
	CodeFFmpegExtSourceUnsup    Code = "ffmpeg.ext_source_unsupported"

	// ---- 运行时设置 ----
	CodeConfigInvalidJSON   Code = "config.invalid_json"
	CodeConfigReadFailed    Code = "config.read_failed"
	CodeConfigWriteFailed   Code = "config.write_failed"
	CodeConfigUnavailable   Code = "config.unavailable"
	CodeConfigEnvNotInteger Code = "config.env_not_integer"
	CodeConfigEnvNotPath    Code = "config.env_not_path"
	CodeConfigDirUnknown    Code = "config.dir_unknown"
)

// Error 是一条用户可见的错误。
//
// 字段都带 JSON tag：除了走 writeErr 的错误响应，它还用作「警告」这类不阻断
// 主流程的条目（见 Warning），两者由界面同一张表渲染。
type Error struct {
	Code    Code           `json:"code"`
	Params  map[string]any `json:"params,omitempty"`
	Message string         `json:"message"`

	// cause 让 errors.Is / errors.As 能穿过这条错误回到它包装的哨兵值
	// （例如 preset.ErrNotFound）。它只在本进程内有意义，不进 JSON。
	cause error `json:"-"`
}

func (e *Error) Error() string { return e.Message }

func (e *Error) Unwrap() error { return e.cause }

// Wrap 返回一条包着 cause 的同码错误。
//
// 返回新值而不是原地写 cause：包级共享的错误值（例如「预设不存在」）因此
// 在任何调用顺序下都是安全的。
func (e *Error) Wrap(cause error) *Error {
	return &Error{Code: e.Code, Params: e.Params, Message: e.Message, cause: cause}
}

// New 构造一条错误：params 供界面按当前语言插值，format/args 决定兜底文案。
//
// 同一份信息在两处各写一遍看着啰嗦，但这是有意的——界面语言与服务器日志
// 语言未必要一致，两边各自成句比让服务端拼串、客户端再拆串可靠得多。
func New(code Code, params map[string]any, format string, args ...any) *Error {
	return &Error{Code: code, Params: params, Message: fmt.Sprintf(format, args...)}
}

// Newf 是 New 的简写，用于没有插值参数的错误。
func Newf(code Code, format string, args ...any) *Error {
	return &Error{Code: code, Message: fmt.Sprintf(format, args...)}
}

// Warning 是一条不阻断主流程的提示（坏掉的预设文件、被忽略的配置项）。
// 它与 Error 同构，界面按同一张表渲染两者。
type Warning = Error
