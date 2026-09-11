// Package preset 把用户攒下来的「编码配方」存成用户目录里的 JSON 文件。
//
// 存储刻意做得很薄：本包不认识任何 FFmpeg 概念，只保证一份 JSON 被可靠地
// 写进 <配置目录>/presets/<名字>.json，并能原样读回来。配方本身的结构由
// 前端定义（见 frontend/src/features/presets/recipe.ts），前端会在读取时
// 做一次宽容解析并补上缺省值，因此这里新增字段、前端升级版本都不需要改后端。
//
// 这样做的好处是：预设文件是干净、可读、可手工编辑的 JSON，后端也不会因为
// 界面调整而要跟着发版。
package preset

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/meehua/ffmpeg-remote-ui/internal/apierr"
)

// 扩展名与长度限制。
const (
	ext = ".json"
	// MaxNameRunes 限制名字长度：文件系统通常限 255 字节，留足余量。
	MaxNameRunes = 64
	// MaxRecipeBytes 限制单份配方大小；配方是参数集合，远小于这个数。
	MaxRecipeBytes = 256 << 10
)

var (
	// ErrInvalidName 表示预设名不能被安全地用作文件名。
	ErrInvalidName = errors.New("预设名不合法")
	// ErrNotFound 表示预设不存在。
	ErrNotFound = errors.New("预设不存在")
	// ErrInvalidRecipe 表示配方不是合法的 JSON 对象。
	ErrInvalidRecipe = errors.New("配方必须是合法的 JSON 对象")

	// errNotFound 是带码的「预设不存在」。调用方仍按哨兵值判断（errors.Is），
	// 码与文案由它一并带出去。
	errNotFound = apierr.Newf(apierr.CodePresetNotFound, "预设不存在").Wrap(ErrNotFound)
)

// nameErr 造一条「预设名不合法」的具体原因，并保留哨兵供调用方判断。
func nameErr(code apierr.Code, params map[string]any, message string) error {
	return apierr.New(code, params, "%s", message).Wrap(ErrInvalidName)
}

// recipeErr 同上，用于配方校验。
func recipeErr(code apierr.Code, params map[string]any, message string) error {
	return apierr.New(code, params, "%s", message).Wrap(ErrInvalidRecipe)
}

// Preset 是一份完整的预设。
type Preset struct {
	Name      string `json:"name"`
	UpdatedAt string `json:"updatedAt"`
	// Recipe 由前端定义，这里原样保存。
	Recipe json.RawMessage `json:"recipe"`
}

// Meta 是列表里的一项，不带配方内容。
type Meta struct {
	Name      string `json:"name"`
	UpdatedAt string `json:"updatedAt"`
	Size      int64  `json:"size"`
}

// Store 是预设目录的读写入口。
type Store struct {
	dir string
}

// NewStore 打开（必要时创建）预设目录。
func NewStore(dir string) (*Store, error) {
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, apierr.New(apierr.CodePresetDirCreateFailed,
			map[string]any{"dir": dir, "cause": err.Error()},
			"无法创建预设目录 %s: %v", dir, err)
	}
	return &Store{dir: dir}, nil
}

// Dir 返回预设目录，供界面提示用户文件放在哪里。
func (s *Store) Dir() string { return s.dir }

// List 返回全部预设，按名字排序。
//
// 单个文件解析失败不会让整个列表失败：坏文件被跳过并作为警告返回，
// 用户因此仍能看到其余预设，同时知道哪个文件需要修。
func (s *Store) List() ([]Meta, []*apierr.Warning, error) {
	entries, err := os.ReadDir(s.dir)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return nil, nil, nil
		}
		return nil, nil, apierr.New(apierr.CodePresetDirReadFailed,
			map[string]any{"dir": s.dir, "cause": err.Error()},
			"无法读取预设目录 %s: %v", s.dir, err)
	}

	var out []Meta
	var warnings []*apierr.Warning
	for _, entry := range entries {
		name := entry.Name()
		if entry.IsDir() || !strings.HasSuffix(name, ext) || strings.HasPrefix(name, ".") {
			continue
		}
		info, err := entry.Info()
		if err != nil {
			warnings = append(warnings, apierr.New(apierr.CodePresetItemUnreadable,
				map[string]any{"name": name, "cause": err.Error()},
				"无法读取 %s：%v", name, err))
			continue
		}
		p, err := s.Get(strings.TrimSuffix(name, ext))
		if err != nil {
			warnings = append(warnings, apierr.New(apierr.CodePresetItemNotUsable,
				map[string]any{"name": name, "cause": err.Error()},
				"%s 不是可用的预设：%v", name, err))
			continue
		}
		out = append(out, Meta{Name: p.Name, UpdatedAt: p.UpdatedAt, Size: info.Size()})
	}

	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	return out, warnings, nil
}

// Get 读取一份预设。返回的名字以文件名为准，避免文件内容与文件名不一致。
func (s *Store) Get(name string) (Preset, error) {
	if err := ValidateName(name); err != nil {
		return Preset{}, err
	}
	raw, err := os.ReadFile(s.path(name))
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return Preset{}, errNotFound
		}
		return Preset{}, apierr.New(apierr.CodePresetReadFailed,
			map[string]any{"name": name, "cause": err.Error()},
			"无法读取预设 %s: %v", name, err)
	}

	var p Preset
	if err := json.Unmarshal(raw, &p); err != nil {
		return Preset{}, apierr.New(apierr.CodePresetFileInvalidJSON,
			map[string]any{"name": name, "cause": err.Error()},
			"预设文件不是合法 JSON: %v", err)
	}
	p.Name = name
	return p, nil
}

// Save 写入一份预设，同名时覆盖。名字与时间戳由存储决定，
// 调用方给出的 Name / UpdatedAt 会被忽略。
func (s *Store) Save(name string, recipe json.RawMessage) (Preset, error) {
	if err := ValidateName(name); err != nil {
		return Preset{}, err
	}
	if err := validateRecipe(recipe); err != nil {
		return Preset{}, err
	}
	if err := os.MkdirAll(s.dir, 0o700); err != nil {
		return Preset{}, apierr.New(apierr.CodePresetDirCreateFailed,
			map[string]any{"dir": s.dir, "cause": err.Error()},
			"无法创建预设目录 %s: %v", s.dir, err)
	}

	p := Preset{
		Name:      name,
		UpdatedAt: time.Now().UTC().Format(time.RFC3339),
		Recipe:    recipe,
	}
	data, err := json.MarshalIndent(p, "", "  ")
	if err != nil {
		return Preset{}, err
	}
	data = append(data, '\n')

	// 原子写入：先写临时文件再改名，中途失败不会留下半截预设。
	path := s.path(name)
	tmp, err := os.CreateTemp(s.dir, "."+name+".tmp*")
	if err != nil {
		return Preset{}, apierr.New(apierr.CodePresetWriteFailed,
			map[string]any{"name": name, "cause": err.Error()},
			"无法写入预设 %s: %v", name, err)
	}
	tmpName := tmp.Name()
	defer os.Remove(tmpName)

	if _, err := tmp.Write(data); err != nil {
		tmp.Close()
		return Preset{}, apierr.New(apierr.CodePresetWriteFailed,
			map[string]any{"name": name, "cause": err.Error()},
			"无法写入预设 %s: %v", name, err)
	}
	if err := tmp.Close(); err != nil {
		return Preset{}, apierr.New(apierr.CodePresetWriteFailed,
			map[string]any{"name": name, "cause": err.Error()},
			"无法写入预设 %s: %v", name, err)
	}
	if err := os.Chmod(tmpName, 0o600); err != nil {
		return Preset{}, apierr.New(apierr.CodePresetWriteFailed,
			map[string]any{"name": name, "cause": err.Error()},
			"无法写入预设 %s: %v", name, err)
	}
	if err := os.Rename(tmpName, path); err != nil {
		return Preset{}, apierr.New(apierr.CodePresetWriteFailed,
			map[string]any{"name": name, "cause": err.Error()},
			"无法写入预设 %s: %v", name, err)
	}
	return p, nil
}

// Remove 删除一份预设。
func (s *Store) Remove(name string) error {
	if err := ValidateName(name); err != nil {
		return err
	}
	if err := os.Remove(s.path(name)); err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return errNotFound
		}
		return apierr.New(apierr.CodePresetRemoveFailed,
			map[string]any{"name": name, "cause": err.Error()},
			"无法删除预设 %s: %v", name, err)
	}
	return nil
}

func (s *Store) path(name string) string {
	return filepath.Join(s.dir, name+ext)
}

// ValidateName 判断一个名字能否安全地当作文件名。
//
// 预设名直接变成文件名，因此这里必须拦住路径分隔符、上跳写法与控制字符：
// 名字里带 "/" 或 ".." 就不是「起个名字」，而是在指定别处的路径。
func ValidateName(name string) error {
	if name == "" {
		return nameErr(apierr.CodePresetNameEmpty, nil, "预设名不合法：不能为空")
	}
	if !utf8.ValidString(name) {
		return nameErr(apierr.CodePresetNameNotUTF8, nil, "预设名不合法：不是合法的 UTF-8")
	}
	if utf8.RuneCountInString(name) > MaxNameRunes {
		return nameErr(apierr.CodePresetNameTooLong,
			map[string]any{"max": MaxNameRunes},
			fmt.Sprintf("预设名不合法：不能超过 %d 个字符", MaxNameRunes))
	}
	if name == "." || name == ".." || strings.HasPrefix(name, ".") {
		return nameErr(apierr.CodePresetNameLeadingDot, nil, "预设名不合法：不能以点开头")
	}
	for _, r := range name {
		if r < 0x20 || r == 0x7f {
			return nameErr(apierr.CodePresetNameControlChar, nil, "预设名不合法：不能包含控制字符")
		}
		switch r {
		case '/', '\\', '*', '?', ':', '"', '<', '>', '|':
			return nameErr(apierr.CodePresetNameForbidden,
				map[string]any{"char": string(r)},
				fmt.Sprintf("预设名不合法：不能包含 %q", r))
		}
	}
	if strings.HasSuffix(name, " ") {
		return nameErr(apierr.CodePresetNameTrailingGap, nil, "预设名不合法：结尾不能是空格")
	}
	return nil
}

// validateRecipe 要求配方是一个 JSON 对象。
//
// 不深究里面的字段：那是前端的契约，改了前端不该让后端跟着发版。
// 但一个 JSON 数组或裸字符串在这里存下去，读的时候一定要出错，不如现在就拦。
func validateRecipe(recipe json.RawMessage) error {
	trimmed := bytes.TrimSpace(recipe)
	if len(trimmed) == 0 {
		return recipeErr(apierr.CodePresetRecipeEmpty, nil, "配方必须是合法的 JSON 对象：为空")
	}
	if len(trimmed) > MaxRecipeBytes {
		return recipeErr(apierr.CodePresetRecipeTooLarge,
			map[string]any{"max": MaxRecipeBytes},
			fmt.Sprintf("配方必须是合法的 JSON 对象：超过 %d 字节", MaxRecipeBytes))
	}
	if trimmed[0] != '{' || !json.Valid(trimmed) {
		return apierr.Newf(apierr.CodePresetRecipeInvalid, "配方必须是合法的 JSON 对象").
			Wrap(ErrInvalidRecipe)
	}
	return nil
}
