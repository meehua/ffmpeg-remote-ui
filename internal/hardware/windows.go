//go:build windows

package hardware

import (
	"sort"
	"strconv"
	"strings"
	"syscall"
	"unsafe"
)

// displayClassKey 是 Windows 登记「显示适配器」这一类设备的注册表位置。
// 它下面的每个 0000、0001… 子键就是一块显示适配器。
//
// 它的性质与 Linux 那边的 sysfs 一样：是操作系统自己维护的设备清单，不是我们从
// 型号名反推出来的能力表。这里读到的每一个字段都只是标签。
const displayClassKey = `SYSTEM\CurrentControlSet\Control\Class\{4d36e968-e325-11ce-bfc1-08002be10318}`

// 注册表 API 直接调 advapi32，不为几行调用引入第三方依赖。
var (
	advapi32             = syscall.NewLazyDLL("advapi32.dll")
	procRegOpenKeyExW    = advapi32.NewProc("RegOpenKeyExW")
	procRegEnumKeyExW    = advapi32.NewProc("RegEnumKeyExW")
	procRegQueryValueExW = advapi32.NewProc("RegQueryValueExW")
	procRegCloseKey      = advapi32.NewProc("RegCloseKey")
)

const (
	hkeyLocalMachine = 0x80000002
	hkeyRead         = 0x20019 // KEY_READ
	regSZ            = 1       // REG_SZ
	regExpandSZ      = 2       // REG_EXPAND_SZ
)

// DiscoverRenderNodes 返回 Windows 上登记在册的显示适配器。
//
// 名字沿用 Linux 那边的叫法（那里的设备就是 DRM render node），返回的也是同一个
// Device 结构，于是 /api/hardware 与界面都不用为平台分叉。Windows 没有 DRM
// render node，RenderNode / CardNode / SysfsPath 一律留空，只有 HwNode 填成
// 适配器序号——界面列「设备节点」候选时看的就是它。
//
// 读不到任何东西时返回空切片而不是 nil：JSON 里是 [] 而不是 null，前端不必为
// 「没有 GPU」另写一个判空分支。注册表读不动也只是这里空着，不影响其余功能。
func DiscoverRenderNodes() []Device {
	devices := []Device{}
	for _, index := range adapterIndexes() {
		if d, ok := readAdapter(index); ok {
			devices = append(devices, d)
		}
	}
	sort.SliceStable(devices, func(i, j int) bool { return devices[i].ID < devices[j].ID })
	return devices
}

// adapterIndexes 列出显示适配器类下面的 0000、0001… 子键。
func adapterIndexes() []string {
	root, err := openRegKey(displayClassKey)
	if err != nil {
		return nil
	}
	defer closeRegKey(root)

	var out []string
	for i := 0; ; i++ {
		name, err := enumRegKey(root, i)
		if err != nil {
			// 枚举到尽头（或中途出错）就停：能读多少列多少。
			break
		}
		// 类键下面还混着 Properties、Configuration 这类非设备子键，
		// 它们不是四位数字，跳过。
		if isAdapterIndex(name) {
			out = append(out, name)
		}
	}
	return out
}

// readAdapter 读出一个适配器子键里的信息。
//
// 连型号名都没有的子键直接丢掉：那是被卸载或禁用后留下的残迹，列出来只会让人困惑。
func readAdapter(index string) (Device, bool) {
	key, err := openRegKey(displayClassKey + `\` + index)
	if err != nil {
		return Device{}, false
	}
	defer closeRegKey(key)

	values := map[string]string{}
	for _, name := range []string{
		"DriverDesc",
		"ProviderName",
		"DriverVersion",
		"DriverDate",
		"InfPath",
		"MatchingDeviceId",
		"HardwareInformation.ChipType",
		"HardwareInformation.AdapterString",
		"HardwareInformation.BiosString",
	} {
		if v, ok := queryRegString(key, name); ok {
			values[name] = v
		}
	}

	desc := values["DriverDesc"]
	if desc == "" {
		return Device{}, false
	}

	d := Device{
		ID: "display:" + index,
		// 驱动版本放在 Device.Driver 里：Linux 那边这里放的是内核驱动名（i915…），
		// Windows 上没有对应的短名字，驱动版本是同一个位置上最有信息量的东西。
		Driver:     values["DriverVersion"],
		VendorName: values["ProviderName"],
		DeviceName: desc,
		// Windows 没有 DRM 节点可填，d3d11va / dxva2 这类类型收的是适配器序号，
		// 于是「设备节点」在 Windows 上填序号：界面那一格不再是空的。
		HwNode: adapterNumber(index),
		// 原始键值原样交给界面，用户点开就能看到全部字段，
		// 我们不需要为每个寄存器式的取值编一套字段名。
		Properties: values,
	}
	d.Vendor, d.DeviceID = parseMatchingDeviceID(values["MatchingDeviceId"])
	return d, true
}

// adapterNumber 把注册表子键名（0000、0001…）转成适配器序号（0、1…）。
//
// 去掉前导零：写进 `-init_hw_device` 的是序号本身，`0000` 不是 FFmpeg 认的写法。
// 子键顺序就是显示适配器的枚举顺序，所以它通常与 FFmpeg 认的那个序号是同一条；
// 但这不是操作系统给出的承诺，真对不上时把节点留空、让 FFmpeg 自己挑更稳。
func adapterNumber(index string) string {
	n, err := strconv.Atoi(index)
	if err != nil {
		return index
	}
	return strconv.Itoa(n)
}

// isAdapterIndex 判断子键名是不是设备序号：恰好四位数字（0000、0001…）。
func isAdapterIndex(name string) bool {
	if len(name) != 4 {
		return false
	}
	for i := 0; i < len(name); i++ {
		if name[i] < '0' || name[i] > '9' {
			return false
		}
	}
	return true
}

// parseMatchingDeviceID 从形如 PCI\VEN_8086&DEV_3E9B&SUBSYS_… 的值里取出厂商与
// 设备 ID，格式与 Linux 那边 sysfs 报出来的一致（0x8086 / 0x3e9b）。
//
// 取不到就留空：这两个字段只是为了让同一套界面字段两边都填得上，缺了不影响任何判断。
func parseMatchingDeviceID(id string) (vendor, device string) {
	fields := strings.FieldsFunc(strings.ToUpper(id), func(r rune) bool {
		return r == '&' || r == '\\'
	})
	for _, field := range fields {
		switch {
		case strings.HasPrefix(field, "VEN_"):
			vendor = "0x" + strings.ToLower(strings.TrimPrefix(field, "VEN_"))
		case strings.HasPrefix(field, "DEV_"):
			device = "0x" + strings.ToLower(strings.TrimPrefix(field, "DEV_"))
		}
	}
	return vendor, device
}

// ---------------------------------------------------------------- 注册表调用

func openRegKey(path string) (syscall.Handle, error) {
	sub, err := syscall.UTF16PtrFromString(path)
	if err != nil {
		return 0, err
	}
	var handle syscall.Handle
	ret, _, _ := procRegOpenKeyExW.Call(
		uintptr(hkeyLocalMachine),
		uintptr(unsafe.Pointer(sub)),
		0,
		uintptr(hkeyRead),
		uintptr(unsafe.Pointer(&handle)),
	)
	if ret != 0 {
		return 0, syscall.Errno(ret)
	}
	return handle, nil
}

func closeRegKey(handle syscall.Handle) {
	procRegCloseKey.Call(uintptr(handle))
}

// enumRegKey 返回第 i 个子键的名字；没有更多子键时返回错误。
func enumRegKey(handle syscall.Handle, i int) (string, error) {
	buf := make([]uint16, 256)
	size := uint32(len(buf))
	ret, _, _ := procRegEnumKeyExW.Call(
		uintptr(handle),
		uintptr(i),
		uintptr(unsafe.Pointer(&buf[0])),
		uintptr(unsafe.Pointer(&size)),
		0, 0, 0, 0,
	)
	if ret != 0 {
		return "", syscall.Errno(ret)
	}
	return syscall.UTF16ToString(buf[:size]), nil
}

// queryRegString 读一个字符串值（REG_SZ / REG_EXPAND_SZ），其余类型一律当作没有。
//
// 分两次调用是 RegQueryValueEx 的固定用法：先问需要多长的缓冲区，再取数据。
func queryRegString(handle syscall.Handle, name string) (string, bool) {
	sub, err := syscall.UTF16PtrFromString(name)
	if err != nil {
		return "", false
	}

	var (
		typ  uint32
		size uint32
	)
	ret, _, _ := procRegQueryValueExW.Call(
		uintptr(handle),
		uintptr(unsafe.Pointer(sub)),
		0,
		uintptr(unsafe.Pointer(&typ)),
		0,
		uintptr(unsafe.Pointer(&size)),
	)
	if ret != 0 || size == 0 {
		return "", false
	}
	if typ != regSZ && typ != regExpandSZ {
		return "", false
	}

	// size 是字节数，而缓冲区收的是 UTF-16 码元；多留一个位置给结尾的 NUL。
	buf := make([]uint16, size/2+1)
	ret, _, _ = procRegQueryValueExW.Call(
		uintptr(handle),
		uintptr(unsafe.Pointer(sub)),
		0,
		uintptr(unsafe.Pointer(&typ)),
		uintptr(unsafe.Pointer(&buf[0])),
		uintptr(unsafe.Pointer(&size)),
	)
	if ret != 0 {
		return "", false
	}
	if s := syscall.UTF16ToString(buf); s != "" {
		return s, true
	}
	return "", false
}
