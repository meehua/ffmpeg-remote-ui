// pci.ids 解析：把 sysfs 里的 vendor/device ID 翻译成人类可读的型号名。
//
// 只用于显示。项目对硬件能力的态度是「一切以 FFmpeg 的运行时报告为准」，
// 型号名不参与任何能力判断——它只是个标签，帮用户在有多块 GPU 时认出哪块是哪块。
// 数据库缺失或查不到时留空，界面回退显示 ID。
package hardware

import (
	"bufio"
	"io"
	"os"
	"strconv"
	"strings"
	"sync"
)

// pciIDsPaths 是各发行版放置 PCI ID 数据库的常见位置。
var pciIDsPaths = []string{
	"/usr/share/hwdata/pci.ids", // RHEL / Fedora
	"/usr/share/misc/pci.ids",   // Debian / Ubuntu
	"/usr/share/pci.ids",        // Arch
	"/var/lib/pciutils/pci.ids", // 部分发行版
	"/usr/local/share/pci.ids",  // 手工安装
}

// pciIDs 是查表用的最小数据集：厂商标 + 厂商下的设备名。
type pciIDs struct {
	vendors map[string]string
	devices map[string]string // key 为 "vendor:device"
}

var (
	pciOnce sync.Once
	pciDB   *pciIDs
)

// lookupPCINames 返回厂商与设备型号，查不到就返回空字符串。
func lookupPCINames(vendor, device string) (string, string) {
	return loadPCIIDs().lookup(vendor, device)
}

// lookup 在已加载的数据库里查型号；库为空（或压根没加载成功）时安静返回空串。
func (db *pciIDs) lookup(vendor, device string) (string, string) {
	if db == nil {
		return "", ""
	}
	vid := normalizePCIID(vendor)
	if vid == "" {
		return "", ""
	}
	name := db.vendors[vid]
	did := normalizePCIID(device)
	if did == "" {
		return name, ""
	}
	return name, db.devices[vid+":"+did]
}

// loadPCIIDs 只在第一次调用时读取数据库，之后的调用复用结果。
func loadPCIIDs() *pciIDs {
	pciOnce.Do(func() {
		db := &pciIDs{vendors: map[string]string{}, devices: map[string]string{}}
		for _, path := range pciIDsPaths {
			f, err := os.Open(path)
			if err != nil {
				continue
			}
			parsePCIIDs(f, db)
			f.Close()
			// 找到第一个能打开的就够了，不合并多份数据库。
			break
		}
		pciDB = db
	})
	return pciDB
}

// parsePCIIDs 读取 pci.ids 的行式格式：
//
//	8086  Intel Corporation
//		3e9b  CoffeeLake-H GT2 [UHD Graphics 630]
//			1bd7 子厂商 子系统      （两层缩进，忽略）
//
// 缩进层级即语义，所以这里按前导制表符判断，而不是靠字段个数。
func parsePCIIDs(r io.Reader, db *pciIDs) {
	sc := bufio.NewScanner(r)
	// pci.ids 单行可能很长（某些条目名称带完整型号描述）。
	sc.Buffer(make([]byte, 0, 64*1024), 1<<20)

	vendor := ""
	for sc.Scan() {
		line := sc.Text()
		switch {
		case line == "" || strings.HasPrefix(line, "#"):
			continue
		case strings.HasPrefix(line, "\t\t"):
			// 子系统行：对「认卡」没有帮助。
			continue
		case strings.HasPrefix(line, "\t"):
			if vendor == "" {
				continue
			}
			if id, name, ok := splitIDName(strings.TrimLeft(line, "\t")); ok {
				db.devices[vendor+":"+id] = name
			}
		default:
			if id, name, ok := splitIDName(line); ok {
				vendor = id
				db.vendors[id] = name
			}
		}
	}
}

// splitIDName 拆出形如 "3e9b  CoffeeLake-H GT2 [UHD Graphics 630]" 里的 ID 与名称。
//
// ID 必须是 4 位十六进制，这样注释、空行与格式异常的行都会被自然排除。
func splitIDName(line string) (string, string, bool) {
	line = strings.TrimSpace(line)
	i := strings.IndexAny(line, " \t")
	if i <= 0 {
		return "", "", false
	}
	id, name := line[:i], strings.TrimSpace(line[i:])
	if len(id) != 4 || name == "" {
		return "", "", false
	}
	if _, err := strconv.ParseUint(id, 16, 32); err != nil {
		return "", "", false
	}
	return strings.ToLower(id), name, true
}

// normalizePCIID 把 sysfs 的 "0x8086" 归一成 pci.ids 使用的 "8086"。
func normalizePCIID(raw string) string {
	s := strings.ToLower(strings.TrimSpace(raw))
	s = strings.TrimPrefix(s, "0x")
	if len(s) != 4 {
		return ""
	}
	if _, err := strconv.ParseUint(s, 16, 32); err != nil {
		return ""
	}
	return s
}
