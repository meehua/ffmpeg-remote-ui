// Package server 把 ffmpeg 能力、任务队列与前端资源暴露成 HTTP 接口。
//
// 浏览器在这里只是控制端：所有 ffprobe/ffmpeg 调用、文件系统访问和
// 计算都发生在服务器上。
package server

import (
	"bytes"
	"context"
	"embed"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/meehua/ffmpeg-remote-ui/internal/apierr"
	"github.com/meehua/ffmpeg-remote-ui/internal/config"
	"github.com/meehua/ffmpeg-remote-ui/internal/ffmpeg"
	"github.com/meehua/ffmpeg-remote-ui/internal/hardware"
	"github.com/meehua/ffmpeg-remote-ui/internal/preset"
	"github.com/meehua/ffmpeg-remote-ui/internal/queue"
)

// maxBodyBytes 限制请求体大小；一次添加任务的参数远小于这个数字。
const maxBodyBytes = 1 << 20

// Options 是服务端可调项：路径与并发来自运行时设置（环境变量 + 配置文件），
// Config 与 Presets 只影响接口的展示与预设读写。
type Options struct {
	MediaRoots    []string // 已归一化的绝对路径；为空表示不限制
	MaxConcurrent int      // 同时运行的 ffmpeg 进程数
	Config        config.Info
	Presets       *preset.Store // 为 nil 表示预设目录不可用
}

type Server struct {
	ff         *ffmpeg.Service
	queue      *queue.Queue
	mediaRoots []string
	config     config.Info
	presets    *preset.Store
	web        embed.FS
	mux        *http.ServeMux

	ctx    context.Context
	cancel context.CancelFunc
}

// New 构造 HTTP 处理器。返回的 *Server 本身实现 http.Handler。
func New(ff *ffmpeg.Service, web embed.FS, opts Options) *Server {
	ctx, cancel := context.WithCancel(context.Background())
	s := &Server{
		ff:         ff,
		mediaRoots: opts.MediaRoots,
		config:     opts.Config,
		presets:    opts.Presets,
		web:        web,
		ctx:        ctx,
		cancel:     cancel,
	}
	s.queue = queue.New(s.runJob, opts.MaxConcurrent)
	s.mux = s.routes()
	return s
}

func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	s.mux.ServeHTTP(w, r)
}

// Close 停止接收新任务、取消正在运行的 ffmpeg 并结束事件流。
func (s *Server) Close() {
	s.cancel()
	s.queue.Close()
}

// Queue 暴露队列，便于测试与诊断。
func (s *Server) Queue() *queue.Queue { return s.queue }

// MediaRoots 返回生效的媒体根目录；为空表示不限制路径。
func (s *Server) MediaRoots() []string { return s.mediaRoots }

func (s *Server) routes() *http.ServeMux {
	mux := http.NewServeMux()

	mux.HandleFunc("GET /api/health", s.health)
	mux.HandleFunc("GET /api/ffmpeg", s.ffmpegInfo)
	mux.HandleFunc("GET /api/ffmpeg/help", s.ffmpegHelp)
	mux.HandleFunc("GET /api/ffmpeg/cli", s.ffmpegCli)
	mux.HandleFunc("GET /api/ffmpeg/option-groups", s.ffmpegOptionGroups)
	mux.HandleFunc("GET /api/ffmpeg/extensions", s.ffmpegExtensions)
	mux.HandleFunc("POST /api/ffmpeg/refresh", s.ffmpegRefresh)
	mux.HandleFunc("GET /api/probe", s.probe)
	mux.HandleFunc("GET /api/files", s.files)
	mux.HandleFunc("GET /api/files/scan", s.scanFiles)
	mux.HandleFunc("POST /api/dirs", s.makeDirs)
	mux.HandleFunc("GET /api/hardware", s.hardware)
	mux.HandleFunc("POST /api/hardware/probe", s.hardwareProbe)
	mux.HandleFunc("POST /api/command", s.command)

	mux.HandleFunc("GET /api/config", s.configInfo)
	mux.HandleFunc("GET /api/presets", s.presetsList)
	mux.HandleFunc("GET /api/presets/{name}", s.presetGet)
	mux.HandleFunc("PUT /api/presets/{name}", s.presetSave)
	mux.HandleFunc("DELETE /api/presets/{name}", s.presetDelete)

	mux.HandleFunc("GET /api/jobs", s.jobsList)
	mux.HandleFunc("POST /api/jobs", s.jobsCreate)
	mux.HandleFunc("POST /api/jobs/clear", s.jobsClear)
	mux.HandleFunc("GET /api/jobs/{id}", s.jobGet)
	mux.HandleFunc("GET /api/jobs/{id}/log", s.jobLog)
	mux.HandleFunc("POST /api/jobs/{id}/cancel", s.jobCancel)
	mux.HandleFunc("POST /api/jobs/{id}/retry", s.jobRetry)
	mux.HandleFunc("DELETE /api/jobs/{id}", s.jobDelete)

	mux.HandleFunc("GET /api/events", s.events)

	mux.Handle("/", s.staticHandler())
	return mux
}

// ---------------------------------------------------------------- 通用

func (s *Server) health(w http.ResponseWriter, _ *http.Request) {
	write(w, map[string]any{
		"ok":          true,
		"go":          runtime.Version(),
		"os":          runtime.GOOS,
		"arch":        runtime.GOARCH,
		"time":        time.Now(),
		"maxParallel": s.queue.Limit(),
	})
}

func (s *Server) ffmpegInfo(w http.ResponseWriter, _ *http.Request) {
	write(w, s.ff.Snapshot())
}

// ffmpegRefresh 重新查询 FFmpeg 能力，用于服务器上换过 FFmpeg 版本之后。
func (s *Server) ffmpegRefresh(w http.ResponseWriter, _ *http.Request) {
	if err := s.ff.Refresh(); err != nil {
		writeErr(w, http.StatusInternalServerError, err)
		return
	}
	write(w, s.ff.Snapshot())
}

func (s *Server) ffmpegHelp(w http.ResponseWriter, r *http.Request) {
	h, err := s.ff.Help(r.URL.Query().Get("target"), r.URL.Query().Get("name"))
	if err != nil {
		// FFmpeg 的原始错误对排查很关键，所以连同结果一起返回。
		body := errorFields(err)
		body["help"] = h
		write(w, body)
		return
	}
	// 成功时也包一层：客户端只需判断有没有 error，不必猜这次返回的是哪种形状。
	write(w, map[string]any{"help": h})
}

func (s *Server) probe(w http.ResponseWriter, r *http.Request) {
	path := r.URL.Query().Get("path")
	if !s.allowedPath(path) {
		writeErr(w, http.StatusForbidden,
			apierr.Newf(apierr.CodePathOutsideRoots, "路径不在允许的媒体目录中"))
		return
	}
	info, err := s.ff.Probe(path)
	if err != nil {
		writeErr(w, http.StatusBadGateway, err)
		return
	}
	write(w, info)
}

func (s *Server) hardware(w http.ResponseWriter, _ *http.Request) {
	devices := hardware.DiscoverRenderNodes()
	write(w, map[string]any{
		"os":      runtime.GOOS,
		"arch":    runtime.GOARCH,
		"devices": devices,
	})
}

func (s *Server) command(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Args []string `json:"args"`
		Text string   `json:"text"`
	}
	if err := decodeBody(w, r, &req); err != nil {
		writeErr(w, http.StatusBadRequest, err)
		return
	}
	args := req.Args
	if req.Text != "" {
		parsed, err := ffmpeg.SplitArgs(req.Text)
		if err != nil {
			writeErr(w, http.StatusBadRequest, err)
			return
		}
		args = parsed
	}
	write(w, map[string]any{"args": args, "command": s.ff.Command(args)})
}

// ---------------------------------------------------------------- 文件浏览

// FileEntry 是媒体目录里的一项。
type FileEntry struct {
	Name    string    `json:"name"`
	Path    string    `json:"path"`
	Dir     bool      `json:"dir"`
	Size    int64     `json:"size"`
	ModTime time.Time `json:"modTime"`
	Ext     string    `json:"ext,omitempty"`
}

type filesResponse struct {
	Path    string      `json:"path"`
	Parent  string      `json:"parent,omitempty"`
	Roots   []string    `json:"roots"`
	Entries []FileEntry `json:"entries"`
}

func (s *Server) files(w http.ResponseWriter, r *http.Request) {
	dir := r.URL.Query().Get("path")

	if dir == "" {
		// 未指定目录时给出入口列表。
		entries := make([]FileEntry, 0, len(s.mediaRoots))
		for _, root := range s.mediaRoots {
			entries = append(entries, FileEntry{Name: root, Path: root, Dir: true})
		}
		if len(entries) == 0 {
			// 没有配置媒体根目录时，从文件系统根开始，方便在内网主机上直接使用。
			// Windows 没有唯一的根，那里给的是盘符列表（见 filesystemRoots）。
			for _, root := range filesystemRoots() {
				entries = append(entries, FileEntry{Name: root, Path: root, Dir: true})
			}
		}
		write(w, filesResponse{Roots: s.mediaRoots, Entries: entries})
		return
	}

	if !s.allowedPath(dir) {
		writeErr(w, http.StatusForbidden,
			apierr.Newf(apierr.CodePathOutsideRoots, "路径不在允许的媒体目录中"))
		return
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		writeErr(w, http.StatusBadRequest, err)
		return
	}

	out := make([]FileEntry, 0, len(entries))
	for _, e := range entries {
		name := e.Name()
		if isHiddenEntry(name, e) {
			continue // 隐藏文件基本不是媒体，默认不展示
		}
		full := filepath.Join(dir, name)
		item := FileEntry{Name: name, Path: full, Dir: e.IsDir()}
		if info, err := e.Info(); err == nil && !e.IsDir() {
			item.Size = info.Size()
			item.ModTime = info.ModTime()
			item.Ext = strings.TrimPrefix(strings.ToLower(filepath.Ext(name)), ".")
		}
		out = append(out, item)
	}

	// 目录在前，同类按名称排序，符合文件管理器的直觉。
	sort.SliceStable(out, func(i, j int) bool {
		if out[i].Dir != out[j].Dir {
			return out[i].Dir
		}
		return strings.ToLower(out[i].Name) < strings.ToLower(out[j].Name)
	})

	parent := filepath.Dir(filepath.Clean(dir))
	if parent == filepath.Clean(dir) || !s.allowedPath(parent) {
		parent = ""
	}
	write(w, filesResponse{Path: filepath.Clean(dir), Parent: parent, Roots: s.mediaRoots, Entries: out})
}

// ---------------------------------------------------------------- 任务

func (s *Server) jobsList(w http.ResponseWriter, _ *http.Request) {
	write(w, s.queue.List())
}

func (s *Server) jobsCreate(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Input  string   `json:"input"`
		Output string   `json:"output"`
		Args   []string `json:"args"`
		Label  string   `json:"label"`
	}
	if err := decodeBody(w, r, &req); err != nil {
		writeErr(w, http.StatusBadRequest, err)
		return
	}
	req.Input = strings.TrimSpace(req.Input)
	req.Output = strings.TrimSpace(req.Output)

	if err := s.validateJob(req.Input, req.Output, req.Args); err != nil {
		writeErr(w, http.StatusBadRequest, err)
		return
	}

	job, err := s.queue.Submit(queue.Job{
		Label:   strings.TrimSpace(req.Label),
		Input:   req.Input,
		Output:  req.Output,
		Args:    req.Args,
		Command: s.ff.Command(req.Args),
	})
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err)
		return
	}
	write(w, job)
}

func (s *Server) jobGet(w http.ResponseWriter, r *http.Request) {
	job, ok := s.queue.Get(r.PathValue("id"))
	if !ok {
		writeErr(w, http.StatusNotFound, apierr.Newf(apierr.CodeJobNotFound, "任务不存在"))
		return
	}
	write(w, job)
}

func (s *Server) jobLog(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if _, ok := s.queue.Get(id); !ok {
		writeErr(w, http.StatusNotFound, apierr.Newf(apierr.CodeJobNotFound, "任务不存在"))
		return
	}
	write(w, map[string]any{"id": id, "lines": s.queue.Logs(id)})
}

func (s *Server) jobCancel(w http.ResponseWriter, r *http.Request) {
	if err := s.queue.Cancel(r.PathValue("id")); err != nil {
		writeErr(w, http.StatusConflict, err)
		return
	}
	write(w, map[string]any{"ok": true})
}

func (s *Server) jobRetry(w http.ResponseWriter, r *http.Request) {
	job, err := s.queue.Retry(r.PathValue("id"))
	if err != nil {
		writeErr(w, http.StatusConflict, err)
		return
	}
	write(w, job)
}

func (s *Server) jobDelete(w http.ResponseWriter, r *http.Request) {
	if err := s.queue.Remove(r.PathValue("id")); err != nil {
		writeErr(w, http.StatusConflict, err)
		return
	}
	write(w, map[string]any{"ok": true})
}

func (s *Server) jobsClear(w http.ResponseWriter, _ *http.Request) {
	write(w, map[string]any{"removed": s.queue.ClearFinished()})
}

func (s *Server) validateJob(input, output string, args []string) error {
	if input == "" {
		return apierr.Newf(apierr.CodeJobInputMissing, "缺少输入路径")
	}
	if output == "" {
		return apierr.Newf(apierr.CodeJobOutputMissing, "缺少输出路径")
	}
	if !s.allowedPath(input) {
		return apierr.Newf(apierr.CodeJobInputOutsideRoots, "输入路径不在允许的媒体目录中")
	}
	if !s.allowedPath(output) {
		return apierr.Newf(apierr.CodeJobOutputOutsideRoots, "输出路径不在允许的媒体目录中")
	}
	if len(args) > 1024 {
		return apierr.Newf(apierr.CodeJobTooManyArgs, "参数过多")
	}
	for _, a := range args {
		if len(a) > 1<<16 {
			return apierr.Newf(apierr.CodeJobArgTooLong, "单个参数过长")
		}
		if strings.ContainsRune(a, 0) {
			return apierr.Newf(apierr.CodeJobArgInvalidChars, "参数包含非法字符")
		}
	}
	if err := s.checkArgs(args); err != nil {
		return err
	}
	if info, err := os.Stat(input); err != nil {
		return apierr.New(apierr.CodeJobInputUnreadable,
			map[string]any{"path": input, "cause": err.Error()},
			"输入不可访问: %v", err)
	} else if info.IsDir() {
		return apierr.Newf(apierr.CodeJobInputIsDir, "输入是目录")
	}
	if dir := filepath.Dir(filepath.Clean(output)); dir != "" {
		if info, err := os.Stat(dir); err != nil {
			return apierr.New(apierr.CodeJobOutputDirUnusable,
				map[string]any{"dir": dir, "cause": err.Error()},
				"输出目录不可用: %v", err)
		} else if !info.IsDir() {
			// 路径存在但不是目录：这里没有底层 err 可引用，给一句等价的描述，
			// 免得界面按同一个码渲染时缺参数。
			return apierr.New(apierr.CodeJobOutputDirUnusable,
				map[string]any{"dir": dir, "cause": "not a directory"},
				"输出目录不可用: %s 不是目录", dir)
		}
	}
	return nil
}

// ---------------------------------------------------------------- 执行

// runJob 被队列调用；它是这个包唯一执行 ffmpeg 的地方。
func (s *Server) runJob(ctx context.Context, job *queue.Job, sink *queue.Sink) error {
	sink.Phase(queue.PhaseProbe)
	if info, err := s.ff.Probe(job.Input); err == nil {
		sink.SetDuration(info.Duration())
	}

	args := make([]string, 0, len(job.Args)+4)
	if !containsArg(job.Args, "-hide_banner") {
		args = append(args, "-hide_banner")
	}
	args = append(args, job.Args...)
	// FFmpeg 的 -progress 协议是稳定的机器可读输出，比解析普通日志可靠。
	args = append(args, "-progress", "pipe:1", "-nostats")

	cmd := exec.CommandContext(ctx, s.ff.FFmpegPath(), args...)

	progress := &progressParser{}
	cmd.Stdout = lineWriter(func(line string) { progress.feed(line, sink) })
	cmd.Stderr = lineWriter(func(line string) { sink.Log(line) })

	sink.Phase(queue.PhaseTranscode)
	err := cmd.Run()

	switch {
	case ctx.Err() != nil:
		// 取消导致的退出不算失败，状态由队列落定为 cancelled。
		return nil
	case err != nil:
		return apierr.New(apierr.CodeJobFFmpegFailed,
			map[string]any{"cause": err.Error()}, "ffmpeg 退出：%v", err)
	}
	return nil
}

// progressParser 把 -progress 的 key=value 行累积成一次上报。
type progressParser struct {
	p queue.Progress
}

func (pp *progressParser) feed(line string, sink *queue.Sink) {
	key, value, ok := strings.Cut(line, "=")
	if !ok {
		return
	}
	value = strings.TrimSpace(value)
	switch key {
	case "out_time_us", "out_time_ms":
		// 注意：这两个键在 FFmpeg 里都是微秒。
		if v, err := strconv.ParseInt(value, 10, 64); err == nil && v >= 0 {
			pp.p.OutTimeMS = v / 1000
		}
	case "frame":
		if v, err := strconv.ParseInt(value, 10, 64); err == nil {
			pp.p.Frame = v
		}
	case "fps":
		if v, err := strconv.ParseFloat(value, 64); err == nil {
			pp.p.FPS = v
		}
	case "total_size":
		if v, err := strconv.ParseInt(value, 10, 64); err == nil {
			pp.p.TotalSize = v
		}
	case "speed":
		pp.p.Speed = value
	case "bitrate":
		pp.p.Bitrate = value
	case "progress":
		// 一个 progress 块结束时才上报，避免半截数据抖动界面。
		sink.Progress(pp.p)
	}
}

// lineWriter 把写入的字节流按行切分后逐行回调，用于消费 ffmpeg 的输出。
func lineWriter(fn func(string)) io.Writer {
	return &lineSplitter{fn: fn}
}

type lineSplitter struct {
	buf bytes.Buffer
	fn  func(string)
}

func (l *lineSplitter) Write(p []byte) (int, error) {
	l.buf.Write(p)
	for {
		line, err := l.buf.ReadString('\n')
		if err != nil {
			// 没有整行可读时把剩余内容放回去等下一次写入。
			l.buf.Reset()
			l.buf.WriteString(line)
			break
		}
		l.fn(strings.TrimRight(line, "\r\n"))
	}
	// 单行异常长说明输出不是按行结构化的：只保留尾部。
	// 既不会无限增长，也不会把紧随其后的进度行一起丢掉。
	if l.buf.Len() > 1<<20 {
		rest := l.buf.Bytes()
		keep := rest[len(rest)-4096:]
		l.buf.Reset()
		l.buf.Write(keep)
	}
	return len(p), nil
}

// ---------------------------------------------------------------- 事件流

// events 用 Server-Sent Events 推送任务状态与日志。
//
// 选 SSE 而不是 WebSocket：这里的流量是单向的，SSE 用标准库即可实现，
// 断线也能由浏览器自动重连，不引入任何第三方依赖。
func (s *Server) events(w http.ResponseWriter, r *http.Request) {
	flusher, ok := w.(http.Flusher)
	if !ok {
		writeErr(w, http.StatusInternalServerError,
			apierr.Newf(apierr.CodeJobStreamUnsupported, "当前连接不支持流式输出"))
		return
	}

	h := w.Header()
	h.Set("Content-Type", "text/event-stream; charset=utf-8")
	h.Set("Cache-Control", "no-store")
	h.Set("X-Accel-Buffering", "no") // 让反向代理不要缓冲
	w.WriteHeader(http.StatusOK)

	id, ch := s.queue.Subscribe(256)
	defer s.queue.Unsubscribe(id)

	// 先补一份全量快照，客户端接上就能立刻对齐状态。
	if !s.sendSnapshot(w, flusher) {
		return
	}
	// 再丢掉快照之前积压的事件：它们的时序早于快照，重放只会把刚下发的
	// 新状态覆盖成旧的。重同步恰好发生在 channel 满的时候，这一步不能省。
	//
	// 代价：drain 是无差别的，会连「快照生成之后、drain 之前」到达的新事件
	// 一起丢掉。那一次更新要等下一个事件到达才补上（心跳也会兜底），最坏是
	// 慢一拍，而不是永久停在旧状态——比留一个必然覆盖快照的窗口划算。
drain:
	for {
		select {
		case <-ch:
		default:
			break drain
		}
	}

	// 心跳让中间设备保持连接，也能让客户端及时发现断线。
	// 顺便记住本连接「已经见过多少次丢弃」：每个连接各自维护这个计数，
	// 多个客户端（含探针）之间不会互相把标记取走。
	heartbeat := time.NewTicker(20 * time.Second)
	defer heartbeat.Stop()
	seenDrops := s.queue.Dropped()

	for {
		select {
		case <-r.Context().Done():
			return
		case <-s.ctx.Done():
			return
		case <-heartbeat.C:
			// 有事件因本连接跟不上而被丢弃，就补一次全量快照；
			// 没有这一步，一次丢弃就会让界面永久停在过期状态上。
			if dropped := s.queue.Dropped(); dropped != seenDrops {
				seenDrops = dropped
				if !s.sendSnapshot(w, flusher) {
					return
				}
			}
			if _, err := io.WriteString(w, ": keep-alive\n\n"); err != nil {
				return
			}
			flusher.Flush()
		case ev, ok := <-ch:
			if !ok {
				return
			}
			var err error
			switch ev.Kind {
			case queue.EventJob:
				err = writeEvent(w, "job", ev.Job)
			case queue.EventLog:
				err = writeEvent(w, "log", ev.Log)
			}
			if err != nil {
				return
			}
			flusher.Flush()
		}
	}
}

func writeEvent(w io.Writer, name string, payload any) error {
	data, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	if _, err := fmt.Fprintf(w, "event: %s\ndata: %s\n\n", name, data); err != nil {
		return err
	}
	return nil
}

// ---------------------------------------------------------------- 静态资源

// staticHandler 提供嵌入的前端资源。构建产物文件名带内容哈希，
// 因此可以长期缓存；入口 HTML 必须每次校验。
func (s *Server) staticHandler() http.Handler {
	sub, err := fs.Sub(s.web, "web")
	if err != nil {
		return http.NotFoundHandler()
	}
	files := http.FileServer(http.FS(sub))
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Content-Type-Options", "nosniff")

		path := strings.TrimPrefix(r.URL.Path, "/")
		if path == "" {
			path = "index.html"
		}
		if info, err := fs.Stat(sub, path); err == nil && !info.IsDir() {
			if strings.HasPrefix(path, "assets/") {
				w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
			}
			files.ServeHTTP(w, r)
			return
		}
		// 其余路径一律交给入口页面，便于以后加入前端路由。
		r.URL.Path = "/"
		w.Header().Set("Cache-Control", "no-store")
		files.ServeHTTP(w, r)
	})
}

// ---------------------------------------------------------------- 工具

// allowedPath 判断路径是否位于允许的媒体目录内。
//
// 除了清理路径，还会解析符号链接，避免通过链接跳出媒体根目录；
// 比较时按平台的规矩归一（Windows 上大小写不敏感）。
func (s *Server) allowedPath(p string) bool {
	if p == "" {
		return false
	}
	clean := filepath.Clean(p)
	if !filepath.IsAbs(clean) {
		return false
	}
	if len(s.mediaRoots) == 0 {
		return true
	}
	resolved := comparablePath(resolvePath(clean))
	for _, root := range s.mediaRoots {
		r := comparablePath(resolvePath(filepath.Clean(root)))
		if resolved == r || strings.HasPrefix(resolved, r+string(os.PathSeparator)) {
			return true
		}
	}
	return false
}

// resolvePath 解析符号链接；路径尚不存在时，解析其最近的存在祖先。
func resolvePath(p string) string {
	if real, err := filepath.EvalSymlinks(p); err == nil {
		return real
	}
	dir, base := filepath.Split(p)
	dir = filepath.Clean(dir)
	if dir == "" || dir == p || dir == string(os.PathSeparator) {
		return p
	}
	return filepath.Join(resolvePath(dir), base)
}

func containsArg(args []string, want string) bool {
	for _, a := range args {
		if a == want {
			return true
		}
	}
	return false
}

func decodeBody(w http.ResponseWriter, r *http.Request, dst any) error {
	dec := json.NewDecoder(http.MaxBytesReader(w, r.Body, maxBodyBytes))
	if err := dec.Decode(dst); err != nil {
		return apierr.New(apierr.CodeBodyInvalidJSON,
			map[string]any{"cause": err.Error()}, "请求体不是合法 JSON: %v", err)
	}
	return nil
}

func write(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	_ = json.NewEncoder(w).Encode(v)
}

// writeErr 输出一条错误。
//
// 响应体始终带 error（成句的中文原文），能取到码时再加上 code 与 params，
// 界面据此用当前语言重述同一条错误；取不到码时只剩兜底文案，界面照原样显示。
func writeErr(w http.ResponseWriter, code int, err error) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(errorFields(err))
}

// errorFields 把一条错误摊平成响应体字段。200 但带错误的接口也复用它，
// 这样两种响应形状对客户端是一致的。
func errorFields(err error) map[string]any {
	body := map[string]any{"error": err.Error()}
	var apiErr *apierr.Error
	if errors.As(err, &apiErr) {
		body["code"] = string(apiErr.Code)
		if len(apiErr.Params) > 0 {
			body["params"] = apiErr.Params
		}
	}
	return body
}

// Listen 绑定监听地址；addr 使用 ":0" 时由系统分配端口。
func Listen(addr string) (net.Listener, string, error) {
	l, err := net.Listen("tcp", addr)
	if err != nil {
		return nil, "", err
	}
	return l, l.Addr().String(), nil
}
