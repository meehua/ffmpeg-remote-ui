package server

import (
	"encoding/json"
	"errors"
	"net/http"

	"github.com/meehua/ffmpeg-remote-ui/internal/preset"
)

// ---------------------------------------------------------------- 运行时设置

// configInfo 返回本次运行的生效设置。
//
// 它同时给出每一项的来源（环境变量 / 配置文件 / 默认值）与加载过程中的警告，
// 界面因此能直接回答用户最常问的那句「我这个值到底是从哪儿来的」。
func (s *Server) configInfo(w http.ResponseWriter, _ *http.Request) {
	info := s.config
	if info.Sources == nil {
		info.Sources = map[string]string{}
	}
	write(w, info)
}

// ---------------------------------------------------------------- 预设

func (s *Server) presetStore(w http.ResponseWriter) *preset.Store {
	if s.presets == nil {
		writeErr(w, http.StatusServiceUnavailable, errors.New("预设目录不可用：未能确定用户配置目录"))
		return nil
	}
	return s.presets
}

// presetsList 返回预设目录与全部预设。坏文件只作为警告返回，不影响其余预设。
func (s *Server) presetsList(w http.ResponseWriter, _ *http.Request) {
	store := s.presetStore(w)
	if store == nil {
		return
	}
	items, warnings, err := store.List()
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err)
		return
	}
	if items == nil {
		items = []preset.Meta{}
	}
	write(w, map[string]any{"dir": store.Dir(), "items": items, "warnings": warnings})
}

func (s *Server) presetGet(w http.ResponseWriter, r *http.Request) {
	store := s.presetStore(w)
	if store == nil {
		return
	}
	p, err := store.Get(r.PathValue("name"))
	if err != nil {
		writePresetErr(w, err)
		return
	}
	write(w, p)
}

// presetSave 整体覆盖一份预设（PUT 语义：这个名字现在就是这份配方）。
func (s *Server) presetSave(w http.ResponseWriter, r *http.Request) {
	store := s.presetStore(w)
	if store == nil {
		return
	}
	var req struct {
		Recipe json.RawMessage `json:"recipe"`
	}
	if err := decodeBody(w, r, &req); err != nil {
		writeErr(w, http.StatusBadRequest, err)
		return
	}
	p, err := store.Save(r.PathValue("name"), req.Recipe)
	if err != nil {
		writePresetErr(w, err)
		return
	}
	write(w, p)
}

func (s *Server) presetDelete(w http.ResponseWriter, r *http.Request) {
	store := s.presetStore(w)
	if store == nil {
		return
	}
	if err := store.Remove(r.PathValue("name")); err != nil {
		writePresetErr(w, err)
		return
	}
	write(w, map[string]any{"ok": true})
}

func writePresetErr(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, preset.ErrNotFound):
		writeErr(w, http.StatusNotFound, err)
	case errors.Is(err, preset.ErrInvalidName), errors.Is(err, preset.ErrInvalidRecipe):
		writeErr(w, http.StatusBadRequest, err)
	default:
		writeErr(w, http.StatusInternalServerError, err)
	}
}
