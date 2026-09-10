package hardware

import (
	"os"
	"strings"
	"testing"
)

const samplePCIIDs = `#	List of PCI IDs
#
# 注释与空行都不该被当成条目

8086  Intel Corporation
	3e9b  CoffeeLake-H GT2 [UHD Graphics 630]
	4905  DG1 [Iris Xe MAX Graphics]
		1bd7  Some Subsystem
10de  NVIDIA Corporation
	1c82  GP107 [GeForce GTX 1050 Ti]

1234  Broken vendor without tab indented devices
zzzz  Invalid vendor id
`

func TestParsePCIIDs(t *testing.T) {
	db := &pciIDs{vendors: map[string]string{}, devices: map[string]string{}}
	parsePCIIDs(strings.NewReader(samplePCIIDs), db)

	if got := db.vendors["8086"]; got != "Intel Corporation" {
		t.Errorf("厂商 8086 = %q", got)
	}
	if got := db.devices["8086:3e9b"]; got != "CoffeeLake-H GT2 [UHD Graphics 630]" {
		t.Errorf("型号 8086:3e9b = %q", got)
	}
	if got := db.devices["8086:4905"]; got != "DG1 [Iris Xe MAX Graphics]" {
		t.Errorf("型号 8086:4905 = %q", got)
	}
	// 子系统行（两层缩进）不该覆盖设备名。
	if got := db.devices["8086:1bd7"]; got != "" {
		t.Errorf("子系统行被误当作设备: %q", got)
	}
	// 非法 ID 不该进表。
	if _, ok := db.vendors["zzzz"]; ok {
		t.Error("非法厂商 ID 被记入")
	}
}

func TestNormalizePCIID(t *testing.T) {
	cases := map[string]string{
		"0x8086": "8086",
		"0X3E9B": "3e9b",
		"4905":   "4905",
		"":       "",
		"0x":     "",
		"xyz":    "",
		"12345":  "",
	}
	for in, want := range cases {
		if got := normalizePCIID(in); got != want {
			t.Errorf("normalizePCIID(%q) = %q，期望 %q", in, got, want)
		}
	}
}

func TestSplitIDName(t *testing.T) {
	if id, name, ok := splitIDName("3e9b  CoffeeLake-H GT2 [UHD Graphics 630]"); !ok || id != "3e9b" || name != "CoffeeLake-H GT2 [UHD Graphics 630]" {
		t.Errorf("正常行解析失败: %q %q %v", id, name, ok)
	}
	if _, _, ok := splitIDName("没有 ID 的一行"); ok {
		t.Error("缺少 ID 的行不应解析成功")
	}
	if _, _, ok := splitIDName("3e9b"); ok {
		t.Error("只有 ID 没有名称的行不应解析成功")
	}
}

// lookup 是界面真正依赖的入口：脏输入与缺失数据库都要能安静退回空串。
func TestLookup(t *testing.T) {
	db := &pciIDs{vendors: map[string]string{}, devices: map[string]string{}}
	parsePCIIDs(strings.NewReader(samplePCIIDs), db)

	if v, d := db.lookup("0x8086", "0x3e9b"); v != "Intel Corporation" || d != "CoffeeLake-H GT2 [UHD Graphics 630]" {
		t.Errorf("查 UHD 630 得到 %q / %q", v, d)
	}
	if _, d := db.lookup("0x8086", "0x4905"); d != "DG1 [Iris Xe MAX Graphics]" {
		t.Errorf("查 DG1 得到 %q", d)
	}
	// 只有厂商、没有设备 ID 时仍然给出厂商名。
	if v, d := db.lookup("0x8086", ""); v == "" || d != "" {
		t.Errorf("仅厂商查询得到 %q / %q", v, d)
	}
	// 未知设备：厂商名有、型号为空。
	if v, d := db.lookup("0x8086", "0xffff"); v == "" || d != "" {
		t.Errorf("未知设备得到 %q / %q", v, d)
	}
	// 数据库没加载成功时不得 panic、不得猜测。
	var empty *pciIDs
	if v, d := empty.lookup("0x8086", "0x3e9b"); v != "" || d != "" {
		t.Errorf("空数据库得到 %q / %q", v, d)
	}
	// 空输入同样安静返回。
	if v, d := db.lookup("", ""); v != "" || d != "" {
		t.Errorf("空输入得到 %q / %q", v, d)
	}
}

// 真实系统上的 pci.ids（存在时）应当能被解析出我们关心的两块卡。
func TestParseRealDatabaseIfPresent(t *testing.T) {
	path := ""
	for _, p := range pciIDsPaths {
		if _, err := os.Stat(p); err == nil {
			path = p
			break
		}
	}
	if path == "" {
		t.Skip("本机没有 pci.ids，跳过")
	}

	f, err := os.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()

	db := &pciIDs{vendors: map[string]string{}, devices: map[string]string{}}
	parsePCIIDs(f, db)

	if len(db.vendors) == 0 {
		t.Fatal("解析出的厂商数为 0，格式可能变了")
	}
	if got := db.vendors["8086"]; got == "" {
		t.Error("Intel 厂商名缺失")
	}
}
