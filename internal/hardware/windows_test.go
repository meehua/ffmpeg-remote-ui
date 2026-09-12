//go:build windows

package hardware

import "testing"

func TestParseMatchingDeviceID(t *testing.T) {
	cases := []struct {
		in     string
		vendor string
		device string
	}{
		{`PCI\VEN_8086&DEV_3E9B&SUBSYS_12345678&REV_02`, "0x8086", "0x3e9b"},
		{`PCI\VEN_10DE&DEV_1C82`, "0x10de", "0x1c82"},
		{`USB\VID_1234&PID_5678`, "", ""},
		{"", "", ""},
	}
	for _, c := range cases {
		vendor, device := parseMatchingDeviceID(c.in)
		if vendor != c.vendor || device != c.device {
			t.Errorf("parseMatchingDeviceID(%q) = (%q, %q)，期望 (%q, %q)",
				c.in, vendor, device, c.vendor, c.device)
		}
	}
}

func TestIsAdapterIndex(t *testing.T) {
	yes := []string{"0000", "0001", "1234"}
	no := []string{"", "000", "00000", "Properties", "000a", "0O00"}
	for _, name := range yes {
		if !isAdapterIndex(name) {
			t.Errorf("isAdapterIndex(%q) = false，期望 true", name)
		}
	}
	for _, name := range no {
		if isAdapterIndex(name) {
			t.Errorf("isAdapterIndex(%q) = true，期望 false", name)
		}
	}
}

// 注册表读不读得到、机器上有没有显示适配器，都不该让接口变成 null——
// 前端拿到 null 之后一句 .length 就会把整棵 React 树带下去。
//
// 这里不假装机器上有几块 GPU：只要求返回的不是 nil。本机跑这个测试时
// 日志里会打出实际发现的设备，可以直接看出注册表那条路通不通。
func TestDiscoverRenderNodesNeverNull(t *testing.T) {
	devices := DiscoverRenderNodes()
	if devices == nil {
		t.Fatal("应当返回空切片而不是 nil")
	}
	t.Logf("发现 %d 个显示适配器", len(devices))
	for _, d := range devices {
		t.Logf("  %s | %s | %s | %s %s", d.ID, d.DeviceName, d.Driver, d.Vendor, d.DeviceID)
	}
}
