// Package config 把运行时设置从「只能靠环境变量」扩展成「环境变量 + JSON 配置文件」。
//
// 两者的分工很明确：
//
//	环境变量 —— 这一次运行的意图，优先级最高，适合临时试一个端口或换一份媒体目录；
//	配置文件 —— 这台机器上的常态，放在用户配置目录里，重启之后依然生效；
//	内置默认值 —— 以上都没有时使用，保证程序零配置也能跑起来。
//
// 首次运行（配置文件还不存在）时，程序会把本次真正生效的值写进配置文件，
// 并在 Info 里说明写过什么，这样用户不必靠记忆维护环境变量，也知道去哪个
// 文件里改常态配置。文件存在却读不动时绝不覆盖：那多半是用户正在编辑的内容。
package config

import (
	"encoding/json"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/meehua/ffmpeg-remote-ui/internal/apierr"
)

// appDirName 是用户配置目录下的子文件夹名。
const appDirName = "ffmpeg-remote-ui"

// FileName 是配置文件名。
const FileName = "config.json"

// PresetsDirName 是预设目录名，位于配置目录内。
const PresetsDirName = "presets"

// 环境变量名。全部带同一个前缀，避免和主机上的其他服务撞名。
const (
	EnvConfigDir   = "FFMPEG_REMOTE_UI_CONFIG_DIR"
	EnvHTTPAddr    = "FFMPEG_REMOTE_UI_HTTP_ADDR"
	EnvMediaRoots  = "FFMPEG_REMOTE_UI_MEDIA_ROOTS"
	EnvFFmpegPath  = "FFMPEG_REMOTE_UI_FFMPEG_PATH"
	EnvFFprobePath = "FFMPEG_REMOTE_UI_FFPROBE_PATH"
	EnvMaxJobs     = "FFMPEG_REMOTE_UI_MAX_CONCURRENT_JOBS"
)

// 每个字段的来源。界面与日志据此告诉用户「这个值到底是谁定的」。
const (
	SourceDefault = "default"
	SourceFile    = "file"
	SourceEnv     = "env"
)

// 字段名，同时用作 Config 的 JSON key 与 Info.Sources 的键。
const (
	FieldHTTPAddr    = "httpAddr"
	FieldMediaRoots  = "mediaRoots"
	FieldFFmpegPath  = "ffmpegPath"
	FieldFFprobePath = "ffprobePath"
	FieldMaxJobs     = "maxConcurrentJobs"
)

// Fields 按展示顺序列出全部字段。
var Fields = []string{FieldHTTPAddr, FieldMediaRoots, FieldFFmpegPath, FieldFFprobePath, FieldMaxJobs}

// Config 是一次运行的生效设置。
type Config struct {
	// HTTPAddr 是监听地址；":0" 表示由系统分配端口。
	HTTPAddr string `json:"httpAddr"`
	// MediaRoots 是允许访问的媒体根目录；为空表示不限制。
	MediaRoots []string `json:"mediaRoots"`
	// FFmpegPath / FFprobePath 默认经 PATH 查找，这里可以写绝对路径。
	FFmpegPath  string `json:"ffmpegPath"`
	FFprobePath string `json:"ffprobePath"`
	// MaxConcurrentJobs 是同时运行的 ffmpeg 进程数。
	MaxConcurrentJobs int `json:"maxConcurrentJobs"`
}

// Default 是零配置时的设置。
func Default() Config {
	return Config{
		HTTPAddr: "127.0.0.1:0",
		// 用空切片而不是 nil：nil 会被序列化成 null，而前端拿到 null 之后
		// 一句 .length 就会抛异常，把整棵 React 树带下去（表现为整页空白）。
		MediaRoots:        []string{},
		FFmpegPath:        "ffmpeg",
		FFprobePath:       "ffprobe",
		MaxConcurrentJobs: 1,
	}
}

// Info 是加载过程本身的结果，供界面与日志展示。
type Info struct {
	// Path 是配置文件路径（无论它此刻是否存在）。
	Path string `json:"path"`
	// PresetsDir 是预设目录，放在这里是为了让用户一眼看到配置文件与预设在一起。
	PresetsDir string `json:"presetsDir"`
	// Created 表示本次运行新建了配置文件。
	Created bool `json:"created"`
	// Values 是加载后的生效设置。
	Values Config `json:"values"`
	// Sources 记录每个字段最终由谁决定：default / file / env。
	Sources map[string]string `json:"sources"`
	// Warnings 是需要让用户知道但又不致命的问题（配置写不进去、JSON 语法错误等）。
	// 带码而不是成句文本：配置问题一样会显示在界面上，界面语言是什么由用户定。
	Warnings []*apierr.Warning `json:"warnings,omitempty"`
}

// fileConfig 用指针区分「文件里没写这个字段」与「写了零值」。
type fileConfig struct {
	HTTPAddr          *string   `json:"httpAddr"`
	MediaRoots        *[]string `json:"mediaRoots"`
	FFmpegPath        *string   `json:"ffmpegPath"`
	FFprobePath       *string   `json:"ffprobePath"`
	MaxConcurrentJobs *int      `json:"maxConcurrentJobs"`
}

// Load 依次应用默认值、配置文件、环境变量，并在配置文件缺失时生成一份。
//
// 它从不失败：配置有问题不该阻止程序启动，所有问题都记在 Info.Warnings 里。
// 只有连用户配置目录都无法确定时（例如容器里没有 HOME），才跳过文件这一层。
func Load() (Config, Info) {
	dir, err := Dir()
	if err != nil {
		return fallback(err)
	}

	info := Info{
		Path:       filepath.Join(dir, FileName),
		PresetsDir: filepath.Join(dir, PresetsDirName),
		Sources:    map[string]string{},
	}

	cfg := Default()
	for _, field := range Fields {
		info.Sources[field] = SourceDefault
	}

	exists := false
	switch raw, readErr := os.ReadFile(info.Path); {
	case readErr == nil:
		exists = true
		var file fileConfig
		if err := json.Unmarshal(raw, &file); err != nil {
			info.Warnings = append(info.Warnings, apierr.New(apierr.CodeConfigInvalidJSON,
				map[string]any{"path": info.Path, "cause": err.Error()},
				"配置文件 %s 不是合法 JSON（%v）：本次忽略该文件，环境变量与默认值照常生效，文件未被改动",
				info.Path, err))
			break
		}
		applyFile(&cfg, info.Sources, file)
	case errors.Is(readErr, fs.ErrNotExist):
		// 首次运行，稍后写入。
	default:
		info.Warnings = append(info.Warnings, apierr.New(apierr.CodeConfigReadFailed,
			map[string]any{"path": info.Path, "cause": readErr.Error()},
			"读取配置文件 %s 失败：%v", info.Path, readErr))
	}

	applyEnv(&cfg, info.Sources, &info)

	normalize(&cfg)
	info.Values = cfg

	if !exists {
		if err := write(info.Path, cfg); err != nil {
			info.Warnings = append(info.Warnings, apierr.New(apierr.CodeConfigWriteFailed,
				map[string]any{"path": info.Path, "cause": err.Error()},
				"无法写入配置文件 %s：%v", info.Path, err))
		} else {
			info.Created = true
		}
	}
	return cfg, info
}

// fallback 在连配置目录都拿不到时给出「只有环境变量与默认值」的结果。
func fallback(cause error) (Config, Info) {
	cfg := Default()
	info := Info{Sources: map[string]string{}}
	for _, field := range Fields {
		info.Sources[field] = SourceDefault
	}
	info.Warnings = append(info.Warnings, apierr.New(apierr.CodeConfigUnavailable,
		map[string]any{"cause": cause.Error()},
		"%v：本次只用环境变量与默认值，配置文件与预设都不可用", cause))
	applyEnv(&cfg, info.Sources, &info)
	normalize(&cfg)
	info.Values = cfg
	return cfg, info
}

func applyFile(cfg *Config, sources map[string]string, file fileConfig) {
	if file.HTTPAddr != nil {
		cfg.HTTPAddr = *file.HTTPAddr
		sources[FieldHTTPAddr] = SourceFile
	}
	if file.MediaRoots != nil {
		cfg.MediaRoots = *file.MediaRoots
		sources[FieldMediaRoots] = SourceFile
	}
	if file.FFmpegPath != nil {
		cfg.FFmpegPath = *file.FFmpegPath
		sources[FieldFFmpegPath] = SourceFile
	}
	if file.FFprobePath != nil {
		cfg.FFprobePath = *file.FFprobePath
		sources[FieldFFprobePath] = SourceFile
	}
	if file.MaxConcurrentJobs != nil {
		cfg.MaxConcurrentJobs = *file.MaxConcurrentJobs
		sources[FieldMaxJobs] = SourceFile
	}
}

// applyEnv 用环境变量覆盖，空串表示「没设」，因为空串在 shell 里太多来源。
func applyEnv(cfg *Config, sources map[string]string, info *Info) {
	if v := strings.TrimSpace(os.Getenv(EnvHTTPAddr)); v != "" {
		cfg.HTTPAddr = v
		sources[FieldHTTPAddr] = SourceEnv
	}
	if v := strings.TrimSpace(os.Getenv(EnvMediaRoots)); v != "" {
		cfg.MediaRoots = splitList(v)
		sources[FieldMediaRoots] = SourceEnv
	}
	if v := strings.TrimSpace(os.Getenv(EnvFFmpegPath)); v != "" {
		cfg.FFmpegPath = v
		sources[FieldFFmpegPath] = SourceEnv
	}
	if v := strings.TrimSpace(os.Getenv(EnvFFprobePath)); v != "" {
		cfg.FFprobePath = v
		sources[FieldFFprobePath] = SourceEnv
	}
	if v := strings.TrimSpace(os.Getenv(EnvMaxJobs)); v != "" {
		n, err := strconv.Atoi(v)
		switch {
		case err != nil || n < 1:
			info.Warnings = append(info.Warnings, apierr.New(apierr.CodeConfigEnvNotInteger,
				map[string]any{"name": EnvMaxJobs, "value": v, "fallback": cfg.MaxConcurrentJobs},
				"环境变量 %s=%q 不是正整数，沿用 %d", EnvMaxJobs, v, cfg.MaxConcurrentJobs))
		default:
			cfg.MaxConcurrentJobs = n
			sources[FieldMaxJobs] = SourceEnv
		}
	}
}

// normalize 把来自文件的值收拾成程序可以直接使用的形状。
func normalize(cfg *Config) {
	cfg.HTTPAddr = strings.TrimSpace(cfg.HTTPAddr)
	if cfg.HTTPAddr == "" {
		cfg.HTTPAddr = Default().HTTPAddr
	}
	cfg.FFmpegPath = strings.TrimSpace(cfg.FFmpegPath)
	if cfg.FFmpegPath == "" {
		cfg.FFmpegPath = Default().FFmpegPath
	}
	cfg.FFprobePath = strings.TrimSpace(cfg.FFprobePath)
	if cfg.FFprobePath == "" {
		cfg.FFprobePath = Default().FFprobePath
	}
	cfg.MediaRoots = normalizeRoots(cfg.MediaRoots)
	if cfg.MaxConcurrentJobs < 1 {
		cfg.MaxConcurrentJobs = Default().MaxConcurrentJobs
	}
}

// ---------------------------------------------------------------- 目录与文件

// Dir 返回配置目录：优先 FFMPEG_REMOTE_UI_CONFIG_DIR，否则用系统约定的
// 用户配置目录（Linux 上是 $XDG_CONFIG_HOME 或 ~/.config）。
func Dir() (string, error) {
	if v := strings.TrimSpace(os.Getenv(EnvConfigDir)); v != "" {
		abs, err := filepath.Abs(v)
		if err != nil {
			return "", apierr.New(apierr.CodeConfigEnvNotPath,
				map[string]any{"name": EnvConfigDir, "value": v, "cause": err.Error()},
				"环境变量 %s=%q 不是可用路径: %v", EnvConfigDir, v, err)
		}
		return filepath.Clean(abs), nil
	}
	base, err := os.UserConfigDir()
	if err != nil {
		return "", apierr.New(apierr.CodeConfigDirUnknown,
			map[string]any{"cause": err.Error()}, "无法确定用户配置目录: %v", err)
	}
	return filepath.Join(base, appDirName), nil
}

// write 原子地写入配置：先写同目录下的临时文件再改名，
// 因此中途被打断也不会留下半截 JSON。
func write(path string, cfg Config) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	data, err := json.MarshalIndent(cfg, "", "  ")
	if err != nil {
		return err
	}
	data = append(data, '\n')
	return writeFileAtomic(path, data)
}

func writeFileAtomic(path string, data []byte) error {
	tmp, err := os.CreateTemp(filepath.Dir(path), filepath.Base(path)+".tmp*")
	if err != nil {
		return err
	}
	tmpName := tmp.Name()
	defer os.Remove(tmpName) // 成功改名后这里什么也删不掉，失败时负责收尾

	if _, err := tmp.Write(data); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	if err := os.Chmod(tmpName, 0o600); err != nil {
		return err
	}
	return os.Rename(tmpName, path)
}

// splitList 按路径分隔符拆分并清理每一项。
func splitList(v string) []string {
	var out []string
	for _, item := range strings.Split(v, string(os.PathListSeparator)) {
		if item = strings.TrimSpace(item); item != "" {
			out = append(out, item)
		}
	}
	return out
}

// normalizeRoots 把媒体根目录统一成绝对路径；空列表保持为空，表示不限制。
//
// 空列表返回 `[]string{}` 而不是 nil，理由同 Default：nil 会变成 JSON 的 null。
func normalizeRoots(roots []string) []string {
	out := []string{}
	for _, root := range roots {
		root = strings.TrimSpace(root)
		if root == "" {
			continue
		}
		if abs, err := filepath.Abs(root); err == nil {
			root = abs
		}
		out = append(out, filepath.Clean(root))
	}
	return out
}
