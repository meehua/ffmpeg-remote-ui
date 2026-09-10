// 命令 ffmpeg-remote-ui 是单文件 Linux 服务端程序：
// 运行时只需要它自己，以及服务器上的 FFmpeg/FFprobe。
package main

import (
	"context"
	"embed"
	"errors"
	"log"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/meehua/ffmpeg-remote-ui/internal/ffmpeg"
	"github.com/meehua/ffmpeg-remote-ui/internal/server"
)

// 前端构建产物在构建时嵌入，因此运行时不需要任何静态文件目录。
// 构建前请先在 frontend 执行 npm run build（见 build.sh）。
//
//go:embed web
var webFS embed.FS

func main() {
	if err := run(); err != nil {
		log.Fatal(err)
	}
}

func run() error {
	// 默认让系统分配随机端口，首次启动不需要任何配置。
	addr := env("FFMPEG_REMOTE_UI_HTTP_ADDR", "127.0.0.1:0")

	// FFmpeg/FFprobe 默认通过 PATH 自动发现，环境变量只作为覆盖。
	service := ffmpeg.NewService(
		env("FFMPEG_REMOTE_UI_FFMPEG_PATH", "ffmpeg"),
		env("FFMPEG_REMOTE_UI_FFPROBE_PATH", "ffprobe"),
	)

	handler := server.New(service, webFS, server.Options{
		MediaRoots:    strings.TrimSpace(os.Getenv("FFMPEG_REMOTE_UI_MEDIA_ROOTS")),
		MaxConcurrent: envInt("FFMPEG_REMOTE_UI_MAX_CONCURRENT_JOBS", 1),
	})

	listener, actualAddr, err := server.Listen(addr)
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
	log.Printf("FFmpeg : %s", service.FFmpegPath())
	log.Printf("FFprobe: %s", service.FFprobePath())
	log.Printf("并发上限: %d 个任务", handler.Queue().Limit())
	// 路径限制不是安全边界，把它的真实范围说清楚，免得被当成隔离手段。
	if roots := handler.MediaRoots(); len(roots) > 0 {
		log.Printf("媒体目录: %s（接口只接受这些目录内的路径）", strings.Join(roots, ", "))
	} else {
		log.Printf("媒体目录: 未限制（FFMPEG_REMOTE_UI_MEDIA_ROOTS 为空，接口可访问文件系统任意路径）")
	}
	if snap.Version != "" {
		log.Printf("版本   : %s", snap.Version)
	}
	if len(snap.Encoders) == 0 {
		log.Printf("提示   : 未能读取到编码器列表，请确认 FFMPEG_REMOTE_UI_FFMPEG_PATH 指向可执行的 ffmpeg")
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

func env(key, fallback string) string {
	if v := strings.TrimSpace(os.Getenv(key)); v != "" {
		return v
	}
	return fallback
}

func envInt(key string, fallback int) int {
	v := strings.TrimSpace(os.Getenv(key))
	if v == "" {
		return fallback
	}
	n, err := strconv.Atoi(v)
	if err != nil || n < 1 {
		log.Printf("环境变量 %s=%q 不是正整数，改用 %d", key, v, fallback)
		return fallback
	}
	return n
}
