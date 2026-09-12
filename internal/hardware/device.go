// Package hardware 只依据操作系统自身提供的信息发现计算设备，
// 不根据厂商或型号推断任何 FFmpeg 能力。
//
// 发现方式按平台分开：Linux 读 /dev/dri 与 sysfs（linux.go），Windows 读注册表里
// 登记的显示适配器（windows.go）。两边给出同一个 Device 结构，因此界面不必为平台
// 分叉。设备清单的用途只有一个——多块 GPU 时认出哪块是哪块；编解码能力一律以
// FFmpeg 的运行时报告为准。
package hardware

// Device 是一块被发现的计算设备。
//
// 它是「给人看的一张标签」，不是能力声明：型号名与厂商名来自系统自己的记录，
// 拿不到时留空，界面回退显示 ID。
//
// RenderNode / CardNode / SysfsPath 是 Linux 的概念（DRM render node 与 sysfs
// 路径），在没有这套东西的平台上留空。
type Device struct {
	ID         string `json:"id"`
	RenderNode string `json:"renderNode,omitempty"`
	CardNode   string `json:"cardNode,omitempty"`
	SysfsPath  string `json:"sysfsPath,omitempty"`
	// HwNode 是这个设备本身的名字里、能直接当 `-init_hw_device <type>=hw:<node>`
	// 用的那一段，只在系统给出确定名字时才填：Linux 上是 /dev/dri/renderD* 的路径，
	// 它既是系统里真实存在的设备文件，也是文档里 vaapi 一类接受的写法。
	//
	// Windows 上留空。那里的显示适配器只有注册表子键序号，而 FFmpeg 数的是 DXGI 的
	// 物理适配器，两套编号不是一回事（实测：注册表第 3 个子键是虚拟显示适配器，
	// FFmpeg 的 2 号却是核显）。宁可不给候选，也不给一个要用户去赌的数字。
	//
	// 更要紧的是：这个字段并不表示「所有类型都该填它」。同一个值在不同类型里的
	// 含义由 FFmpeg 自己解释——cuda 数的是 CUDA 设备，qsv 收到的却是 MFX 实现
	// 选择符（`1` 在它眼里是「软件实现」）——所以界面上它只作为可填的候选摆出来，
	// 能不能用一律以实测为准。
	HwNode     string            `json:"hwNode,omitempty"`
	Driver     string            `json:"driver,omitempty"`
	Vendor     string            `json:"vendor,omitempty"`
	DeviceID   string            `json:"deviceId,omitempty"`
	VendorName string            `json:"vendorName,omitempty"`
	DeviceName string            `json:"deviceName,omitempty"`
	PCIAddress string            `json:"pciAddress,omitempty"`
	Properties map[string]string `json:"properties,omitempty"`
}
