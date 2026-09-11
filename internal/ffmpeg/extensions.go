package ffmpeg

import (
	"sort"
	"strings"
	"sync"

	"github.com/meehua/ffmpeg-remote-ui/internal/apierr"
)

// extensionTargets 是能报出扩展名的两个方向。
//
// 输入侧看 demuxer（这台 FFmpeg 能读什么），输出侧看 muxer（能写什么）——
// 两侧的扩展名并不相同，所以分开取，不混成一张表。
var extensionTargets = map[string]bool{"demuxer": true, "muxer": true}

// ExtensionsResult 是一次扩展名汇总。
type ExtensionsResult struct {
	Target     string   `json:"target"`
	Extensions []string `json:"extensions"`
	// Components 是这一方向上的组件总数，WithExtensions 是其中报了扩展名的数量。
	Components     int `json:"components"`
	WithExtensions int `json:"withExtensions"`
}

// Extensions 汇总某个方向上所有组件声明的文件扩展名。
//
// 数据源是 `ffmpeg -h <target>=<name>` 里的 "Common extensions:" 一行——也就是
// ffmpeg 自己说「这个格式通常用哪些扩展名」。程序里没有、也不该有一份媒体格式表：
// 那正是「哪些格式常见」这类判断，只能由 ffmpeg 给。
//
// 代价是每个组件一次 `-h`（实测 361 个 demuxer、并发 8，约 1.8 秒），因此结果
// 会被缓存；重复打开选择面板不会再跑一遍。
func (s *Service) Extensions(target string) (ExtensionsResult, error) {
	target = strings.ToLower(strings.TrimSpace(target))
	if !extensionTargets[target] {
		return ExtensionsResult{}, apierr.New(apierr.CodeFFmpegExtSourceUnsup,
			map[string]any{"target": target},
			"不支持的扩展名来源: %s（可用：demuxer、muxer）", target)
	}

	s.helpMu.Lock()
	if cached, ok := s.extCache[target]; ok {
		s.helpMu.Unlock()
		return cached, nil
	}
	s.helpMu.Unlock()

	names := s.componentNames(target)

	// 并发跑，但给个上限：一次开几百个进程会让机器明显卡顿。
	const workers = 8
	found := make([][]string, len(names))
	var wg sync.WaitGroup
	slots := make(chan struct{}, workers)

	for i, name := range names {
		wg.Add(1)
		go func(i int, name string) {
			defer wg.Done()
			slots <- struct{}{}
			defer func() { <-slots }()
			help, err := s.Help(target, name)
			if err != nil {
				return // 查不动的组件跳过，不影响其余
			}
			found[i] = extensionsOf(help)
		}(i, name)
	}
	wg.Wait()

	unique := map[string]bool{}
	withExtensions := 0
	for _, exts := range found {
		if len(exts) > 0 {
			withExtensions++
		}
		for _, ext := range exts {
			unique[ext] = true
		}
	}

	extensions := make([]string, 0, len(unique))
	for ext := range unique {
		extensions = append(extensions, ext)
	}
	sort.Strings(extensions)

	result := ExtensionsResult{
		Target:         target,
		Extensions:     extensions,
		Components:     len(names),
		WithExtensions: withExtensions,
	}
	s.helpMu.Lock()
	if s.extCache == nil {
		s.extCache = map[string]ExtensionsResult{}
	}
	s.extCache[target] = result
	s.helpMu.Unlock()
	return result, nil
}

// componentNames 取出某个方向上的组件名，顺序沿用能力快照里的顺序。
func (s *Service) componentNames(target string) []string {
	snap := s.Snapshot()
	items := snap.Demuxers
	if target == "muxer" {
		items = snap.Muxers
	}
	out := make([]string, 0, len(items))
	for _, item := range items {
		out = append(out, item.Name)
	}
	return out
}

// extensionsOf 从 `ffmpeg -h` 的结果里读 "Common extensions"。
//
// ffmpeg 的值形如 "mp4." 或 "mkv,mk3d,mka,mks,webm."：逗号分隔，末尾带一个句点。
func extensionsOf(help Help) []string {
	for _, prop := range help.Properties {
		if !strings.EqualFold(prop.Name, "common extensions") {
			continue
		}
		var out []string
		for _, item := range strings.Split(prop.Value, ",") {
			item = strings.ToLower(strings.Trim(strings.TrimSpace(item), ". "))
			if item != "" {
				out = append(out, item)
			}
		}
		return out
	}
	return nil
}
