// 命令 ffmpeg-remote-ui 是单文件 Linux 服务端程序：
// 运行时只需要它自己，以及服务器上的 FFmpeg/FFprobe。
package main

import (
	"context"
	"embed"
	"errors"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/meehua/ffmpeg-remote-ui/internal/config"
	"github.com/meehua/ffmpeg-remote-ui/internal/ffmpeg"
	"github.com/meehua/ffmpeg-remote-ui/internal/preset"
	"github.com/meehua/ffmpeg-remote-ui/internal/server"
)

// 前端构建产物在构建时嵌入，因此运行时不需要任何静态文件目录。
// 构建前请先在 frontend 执行 npm run build（见 build.sh）。
//
//go:embed web
var webFS embed.FS

// 构建信息在链接期由 -ldflags -X 注入（见 build.sh 与 .github/workflows/release.yml）：
// -X main.version=<tag>、-X main.commit=<short sha>、-X main.buildDate=<RFC3339>。
// 不带这些选项直接 go build / go run 时保留下面的默认值，程序照常工作。
var (
	version   = "dev"
	commit    = "unknown"
	buildDate = "unknown"
)

func main() {
	// --version 给部署脚本用：只输出一行，不启动服务。
	if isVersionRequest(os.Args[1:]) {
		fmt.Println(buildInfo())
		return
	}

	if err := run(); err != nil {
		log.Fatal(err)
	}
}

// isVersionRequest 判断这次调用是不是只想问版本号。
func isVersionRequest(args []string) bool {
	if len(args) == 0 {
		return false
	}
	return args[0] == "-version" || args[0] == "--version"
}

// buildInfo 把三项构建信息拼成一行；没注入的项直接省略，不留下空占位。
func buildInfo() string {
	extra := make([]string, 0, 2)
	if commit != "" && commit != "unknown" {
		extra = append(extra, "commit "+commit)
	}
	if buildDate != "" && buildDate != "unknown" {
		extra = append(extra, "构建于 "+buildDate)
	}
	if len(extra) == 0 {
		return version
	}
	return version + "（" + strings.Join(extra, "，") + "）"
}

func run() error {
	// 运行时设置按「环境变量 > 配置文件 > 内置默认值」解析；
	// 配置文件不存在时会被就地生成，因此首次启动依然零配置。
	cfg, info := config.Load()

	// FFmpeg/FFprobe 默认通过 PATH 自动发现，配置只作为覆盖。
	service := ffmpeg.NewService(cfg.FFmpegPath, cfg.FFprobePath)

	presets, err := openPresets(info)
	if err != nil {
		log.Printf("警告   : %v，预设功能本次不可用", err)
	}

	handler := server.New(service, webFS, server.Options{
		MediaRoots:    cfg.MediaRoots,
		MaxConcurrent: cfg.MaxConcurrentJobs,
		Config:        info,
		Presets:       presets,
	})

	listener, actualAddr, err := server.Listen(cfg.HTTPAddr)
	if err != nil {
		return err
	}

	httpSrv := &http.Server{
		Handler:           handler,
		ReadHeaderTimeout: 15 * time.Second,
		// 事件流是长连接，写超时会把推送切断，所以保持 0。
		WriteTimeout: 0,
		IdleTimeout:  120 * time.Second,
	}

	snap := service.Snapshot()
	log.Printf("FFmpeg Remote UI 已启动: http://%s", actualAddr)
	// 出问题时第一件事往往是确认「跑的是哪个构建」，所以启动就说清楚。
	log.Printf("构建   : %s", buildInfo())
	log.Printf("FFmpeg : %s（%s）", service.FFmpegPath(), sourceLabel(info, config.FieldFFmpegPath))
	log.Printf("FFprobe: %s（%s）", service.FFprobePath(), sourceLabel(info, config.FieldFFprobePath))
	log.Printf("并发上限: %d 个任务（%s）", handler.Queue().Limit(), sourceLabel(info, config.FieldMaxJobs))
	// 路径限制不是安全边界，把它的真实范围说清楚，免得被当成隔离手段。
	if roots := handler.MediaRoots(); len(roots) > 0 {
		log.Printf("媒体目录: %s（%s；接口只接受这些目录内的路径）",
			strings.Join(roots, ", "), sourceLabel(info, config.FieldMediaRoots))
	} else {
		log.Printf("媒体目录: 未限制（%s，接口可访问文件系统任意路径）",
			sourceLabel(info, config.FieldMediaRoots))
	}
	if info.Path != "" {
		log.Printf("配置   : %s", info.Path)
	}
	for _, warning := range info.Warnings {
		log.Printf("警告   : %s", warning)
	}
	// 首次运行会把生效设置写成初始配置：这一步必须让用户知道，
	// 否则「配置从哪来」和「该去哪改」都会变成谜。
	if info.Created {
		log.Print("提示   : 首次运行，已按本次生效的设置生成上面的配置文件；")
		log.Print("         以后直接改这个文件即可，需要临时覆盖时再用环境变量（环境变量优先级更高）")
	}
	if snap.Version != "" {
		log.Printf("版本   : %s", snap.Version)
	}
	if len(snap.Encoders) == 0 {
		log.Printf("提示   : 未能读取到编码器列表，请确认 FFmpeg 路径指向可执行的 ffmpeg（当前 %s）",
			service.FFmpegPath())
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	serveErr := make(chan error, 1)
	go func() {
		if err := httpSrv.Serve(listener); err != nil && !errors.Is(err, http.ErrServerClosed) {
			serveErr <- err
			return
		}
		serveErr <- nil
	}()

	select {
	case err := <-serveErr:
		handler.Close()
		return err
	case <-ctx.Done():
		log.Print("收到退出信号，正在停止…")
	}

	// 先让队列取消正在运行的 ffmpeg 并关闭事件流，再等待连接排空。
	handler.Close()

	shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := httpSrv.Shutdown(shutdownCtx); err != nil {
		return err
	}
	return nil
}

// openPresets 准备预设目录。拿不到目录时返回错误，预设功能被标记为不可用，
// 其余功能照常工作。
func openPresets(info config.Info) (*preset.Store, error) {
	if info.PresetsDir == "" {
		return nil, errors.New("未能确定用户配置目录")
	}
	store, err := preset.NewStore(info.PresetsDir)
	if err != nil {
		return nil, err
	}
	return store, nil
}

// sourceLabel 把「这个值来自哪里」翻译成启动日志里的一句话。
func sourceLabel(info config.Info, field string) string {
	switch info.Sources[field] {
	case config.SourceEnv:
		return "来自环境变量"
	case config.SourceFile:
		return "来自配置文件"
	case config.SourceDefault:
		return "默认值"
	default:
		return "来源未知"
	}
}
