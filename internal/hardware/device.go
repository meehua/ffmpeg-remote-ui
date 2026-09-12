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
	ID         string            `json:"id"`
	RenderNode string            `json:"renderNode,omitempty"`
	CardNode   string            `json:"cardNode,omitempty"`
	SysfsPath  string            `json:"sysfsPath,omitempty"`
	Driver     string            `json:"driver,omitempty"`
	Vendor     string            `json:"vendor,omitempty"`
	DeviceID   string            `json:"deviceId,omitempty"`
	VendorName string            `json:"vendorName,omitempty"`
	DeviceName string            `json:"deviceName,omitempty"`
	PCIAddress string            `json:"pciAddress,omitempty"`
	Properties map[string]string `json:"properties,omitempty"`
}
