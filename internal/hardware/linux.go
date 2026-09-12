//go:build linux

package hardware

import (
	"bufio"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

// DiscoverRenderNodes 只依赖 /dev/dri 与 sysfs。
//
// 返回空切片而不是 nil，这样 JSON 里是 [] 而不会变成 null，
// 前端不需要为“没有 GPU”写额外的判空分支。
func DiscoverRenderNodes() []Device {
	devices := []Device{}
	cards := cardNodes()

	for _, node := range glob("/dev/dri/renderD*") {
		sysfs := sysfsDevicePath(node)
		d := Device{
			ID:         fmt.Sprintf("drm:%s", filepath.Base(node)),
			RenderNode: node,
			CardNode:   cards[sysfs],
			SysfsPath:  sysfs,
			// 喂给 FFmpeg 的那一段就是 render node 本身：它不依赖显示会话，
			// 是 Linux 上 vaapi / qsv 这类类型真正要的节点。
			HwNode:     node,
			Properties: map[string]string{},
		}
		d.Driver = readDriver(sysfs)
		d.Vendor = readOne(sysfs, "vendor")
		d.DeviceID = readOne(sysfs, "device")
		// 型号名只用于显示；数据库缺失时留空，界面回退展示 ID。
		d.VendorName, d.DeviceName = lookupPCINames(d.Vendor, d.DeviceID)
		d.PCIAddress = pciAddress(sysfs)
		readUevent(filepath.Join(sysfs, "uevent"), d.Properties)
		devices = append(devices, d)
	}

	sort.SliceStable(devices, func(i, j int) bool { return devices[i].ID < devices[j].ID })
	return devices
}

func glob(pattern string) []string {
	matches, err := filepath.Glob(pattern)
	if err != nil {
		return nil
	}
	sort.Strings(matches)
	return matches
}

// sysfsDevicePath 返回节点在 sysfs 里对应的真实设备目录。
func sysfsDevicePath(node string) string {
	base := filepath.Join("/sys/class/drm", filepath.Base(node), "device")
	if real, err := filepath.EvalSymlinks(base); err == nil {
		return real
	}
	return base
}

// cardNodes 建立「真实设备目录 -> /dev/dri/cardN」的映射，
// 因为 render node 与 card node 通过同一个 sysfs 设备关联。
func cardNodes() map[string]string {
	out := map[string]string{}
	for _, node := range glob("/dev/dri/card*") {
		if real, err := filepath.EvalSymlinks(filepath.Join("/sys/class/drm", filepath.Base(node), "device")); err == nil {
			out[real] = node
		}
	}
	return out
}

func readDriver(path string) string {
	link, err := filepath.EvalSymlinks(filepath.Join(path, "driver"))
	if err != nil {
		return ""
	}
	return filepath.Base(link)
}

func readOne(path, name string) string {
	b, err := os.ReadFile(filepath.Join(path, name))
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(b))
}

// pciAddress 从 sysfs 路径里取出 PCI 地址，例如 0000:01:00.0。
func pciAddress(path string) string {
	for _, part := range strings.Split(filepath.ToSlash(path), "/") {
		if strings.Count(part, ":") == 1 && strings.Count(part, ".") == 1 {
			return part
		}
	}
	return ""
}

func readUevent(path string, dst map[string]string) {
	f, err := os.Open(path)
	if err != nil {
		return
	}
	defer f.Close()

	sc := bufio.NewScanner(f)
	for sc.Scan() {
		if key, value, ok := strings.Cut(sc.Text(), "="); ok {
			dst[key] = value
		}
	}
}
