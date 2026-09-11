package config

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

// isolate 把配置目录指向临时目录，并清空会干扰结论的环境变量。
func isolate(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	t.Setenv(EnvConfigDir, dir)
	for _, key := range []string{EnvHTTPAddr, EnvMediaRoots, EnvFFmpegPath, EnvFFprobePath, EnvMaxJobs} {
		t.Setenv(key, "")
	}
	return dir
}

func TestLoadCreatesConfigOnFirstRun(t *testing.T) {
	dir := isolate(t)

	cfg, info := Load()
	if !info.Created {
		t.Fatal("首次运行应当写入配置文件")
	}
	if info.Path != filepath.Join(dir, FileName) {
		t.Errorf("配置路径 = %q，期望 %q", info.Path, filepath.Join(dir, FileName))
	}

	// 文件内容必须与生效设置一致，否则「程序自己生成的配置」会误导用户。
	raw, err := os.ReadFile(info.Path)
	if err != nil {
		t.Fatalf("读取生成的配置失败: %v", err)
	}
	var written Config
	if err := json.Unmarshal(raw, &written); err != nil {
		t.Fatalf("生成的配置不是合法 JSON: %v", err)
	}
	if !reflect.DeepEqual(written, cfg) {
		t.Errorf("文件内容 %+v 与生效设置 %+v 不一致", written, cfg)
	}
	if cfg.HTTPAddr != "127.0.0.1:0" || cfg.MaxConcurrentJobs != 1 || cfg.FFmpegPath != "ffmpeg" {
		t.Errorf("默认值不对: %+v", cfg)
	}
	for _, field := range Fields {
		if info.Sources[field] != SourceDefault {
			t.Errorf("%s 的来源 = %q，期望 %q", field, info.Sources[field], SourceDefault)
		}
	}

	// 第二次运行不该再写文件，否则用户的编辑会被反复覆盖。
	_, again := Load()
	if again.Created {
		t.Error("配置文件已存在时不应再次创建")
	}
}

func TestLoadReadsFileAndLetsEnvWin(t *testing.T) {
	dir := isolate(t)
	path := filepath.Join(dir, FileName)
	body := `{"httpAddr": ":8090", "mediaRoots": ["/data/media"], "maxConcurrentJobs": 4}`
	if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}

	cfg, info := Load()
	if cfg.HTTPAddr != ":8090" || cfg.MaxConcurrentJobs != 4 {
		t.Errorf("配置文件的值没有生效: %+v", cfg)
	}
	if len(cfg.MediaRoots) != 1 || cfg.MediaRoots[0] != "/data/media" {
		t.Errorf("媒体目录 = %v", cfg.MediaRoots)
	}
	// 文件没写的字段仍应报告为「来自默认值」。
	if info.Sources[FieldFFmpegPath] != SourceDefault {
		t.Errorf("ffmpegPath 的来源 = %q，期望 default", info.Sources[FieldFFmpegPath])
	}
	if info.Sources[FieldHTTPAddr] != SourceFile {
		t.Errorf("httpAddr 的来源 = %q，期望 file", info.Sources[FieldHTTPAddr])
	}
	if info.Created {
		t.Error("配置文件已存在时不应创建")
	}

	// 环境变量优先级最高：它描述的是这一次运行的意图。
	t.Setenv(EnvHTTPAddr, ":9999")
	t.Setenv(EnvMaxJobs, "2")
	cfg, info = Load()
	if cfg.HTTPAddr != ":9999" {
		t.Errorf("环境变量没有覆盖配置文件: %q", cfg.HTTPAddr)
	}
	if cfg.MaxConcurrentJobs != 2 {
		t.Errorf("并发上限 = %d，期望 2", cfg.MaxConcurrentJobs)
	}
	if info.Sources[FieldHTTPAddr] != SourceEnv {
		t.Errorf("httpAddr 的来源 = %q，期望 env", info.Sources[FieldHTTPAddr])
	}
	// 没被环境变量碰过的字段仍然是文件的。
	if info.Sources[FieldMediaRoots] != SourceFile {
		t.Errorf("mediaRoots 的来源 = %q，期望 file", info.Sources[FieldMediaRoots])
	}
}

func TestEnvMediaRootsUsesPathListSeparator(t *testing.T) {
	isolate(t)
	t.Setenv(EnvMediaRoots, "/a"+string(os.PathListSeparator)+" /b ")

	cfg, info := Load()
	if len(cfg.MediaRoots) != 2 || cfg.MediaRoots[0] != "/a" || cfg.MediaRoots[1] != "/b" {
		t.Errorf("媒体目录 = %v", cfg.MediaRoots)
	}
	if info.Sources[FieldMediaRoots] != SourceEnv {
		t.Errorf("mediaRoots 的来源 = %q，期望 env", info.Sources[FieldMediaRoots])
	}
}

func TestLoadKeepsBrokenFileIntact(t *testing.T) {
	dir := isolate(t)
	path := filepath.Join(dir, FileName)
	broken := "{ 这不是 JSON"
	if err := os.WriteFile(path, []byte(broken), 0o600); err != nil {
		t.Fatal(err)
	}

	cfg, info := Load()
	if cfg.HTTPAddr != "127.0.0.1:0" {
		t.Errorf("应当回退到默认值，实际 %q", cfg.HTTPAddr)
	}
	if len(info.Warnings) == 0 {
		t.Error("应当给出警告")
	}
	if info.Created {
		t.Error("文件存在（只是写坏了）时不应重写")
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if string(raw) != broken {
		t.Error("用户正在编辑的文件被覆盖了")
	}
}

func TestLoadRejectsBadMaxJobsEnv(t *testing.T) {
	isolate(t)
	t.Setenv(EnvMaxJobs, "三个")

	cfg, info := Load()
	if cfg.MaxConcurrentJobs != 1 {
		t.Errorf("并发上限 = %d，期望回退到 1", cfg.MaxConcurrentJobs)
	}
	if len(info.Warnings) != 1 {
		t.Errorf("应当给出一条警告，实际 %v", info.Warnings)
	}
	if info.Sources[FieldMaxJobs] != SourceDefault {
		t.Errorf("无效的环境变量不应改变来源: %q", info.Sources[FieldMaxJobs])
	}
}

func TestLoadNormalizesZeroValues(t *testing.T) {
	dir := isolate(t)
	// 全空的配置项等价于「没写」：程序要有能跑起来的值。
	body := `{"httpAddr": "  ", "ffmpegPath": "", "maxConcurrentJobs": 0}`
	if err := os.WriteFile(filepath.Join(dir, FileName), []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}

	cfg, _ := Load()
	if cfg.HTTPAddr != "127.0.0.1:0" || cfg.FFmpegPath != "ffmpeg" || cfg.MaxConcurrentJobs != 1 {
		t.Errorf("空值没有被补成默认值: %+v", cfg)
	}
}

// TestLoadJSONUsesEmptyArrays 守住一条会被前端放大成「整页空白」的约定。
//
// Go 的 nil 切片会序列化成 null，而前端拿到 null 之后一句 `values.mediaRoots
// .length` 就会抛异常；React 一旦在渲染期抛异常就会把整棵树卸掉——用户看到的
// 不是「这块坏了」，而是连 logo 都没了的白页。所以对外 JSON 里的列表一律是 []。
func TestLoadJSONUsesEmptyArrays(t *testing.T) {
	isolate(t)

	_, info := Load()
	raw, err := json.Marshal(info)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(raw), "null") {
		t.Errorf("接口返回的 JSON 里不该出现 null，实际：%s", raw)
	}
}
