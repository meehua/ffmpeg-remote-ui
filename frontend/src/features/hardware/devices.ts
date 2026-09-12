/**
 * 设备清单怎么读、怎么写给人看——只此一处。
 *
 * 服务器报出来的设备（`/api/hardware`）与 FFmpeg 报出来的设备类型
 * （快照里的 `hwDeviceTypes`）是两份不同的事实：「硬件」页要把设备摊开给人看，
 * 「编码参数」面板要从中挑一个节点。在这之前两处各写了一遍筛选与拼接，于是同一
 * 件事有了两种说法——一边认 `renderNode`，一边认 `hwNode`，改一处就会漏另一处。
 *
 * 这个模块只做「把事实摆成界面要用的形状」，不含任何能力判断：哪块卡能不能编
 * 某种编码，答案永远来自 FFmpeg 的运行时报告，不来自这里。
 */

import type { GpuDevice } from '../../api/types';
import type { MessageKey } from '../../i18n';
import type { Platform } from '../workspace/args';

/** 一条可以喂给 `-init_hw_device <type>=hw:<node>` 的节点候选。 */
export interface HwNodeOption {
  /** 节点本身，也就是 `<node>` 那一段。 */
  value: string;
  /** 下拉里显示的一行文字。 */
  label: string;
  /** 悬浮说明，帮人认出这是哪块卡。 */
  detail: string;
}

/** 「硬件」页的一行字段；文案键留给调用方按当前语言渲染。 */
export interface DeviceRow {
  labelKey: MessageKey;
  value: string;
}

/** 设备的显示名：有型号就用型号（认卡最直观），没有就退回厂商:设备 ID。 */
export function deviceTitle(device: GpuDevice): string {
  if (device.deviceName) {
    return device.deviceName;
  }
  const ids = [device.vendor, device.deviceId].filter(Boolean).join(':');
  return ids || device.id;
}

/** 悬浮说明：认卡用得上的标签，空的丢掉。 */
export function deviceDetail(device: GpuDevice): string {
  return [device.vendorName, device.pciAddress, device.driver].filter(Boolean).join(' · ');
}

/**
 * 能当节点用的设备。
 *
 * 判据只有「服务器给没给这个设备的 HwNode」——它是 Linux 的 DRM 节点还是
 * Windows 的适配器序号，由服务器端的发现实现决定，界面不需要知道。
 */
export function hwNodeOptions(devices: GpuDevice[]): HwNodeOption[] {
  return devices.flatMap((device) =>
    device.hwNode
      ? [
          {
            value: device.hwNode,
            // 节点始终跟在后面：同型号的两块卡只能靠它区分。
            label: `${deviceTitle(device)} · ${device.hwNode}`,
            detail: deviceDetail(device),
          },
        ]
      : [],
  );
}

/**
 * 「硬件」页要列出的字段。
 *
 * render node、card node、sysfs 与 PCI 地址都是 DRM 那一套概念，只存在于 Linux；
 * 没有它们的平台上列出来只是占地方。HwNode 两边都有意义，所以它不在这个分支里。
 */
export function deviceRows(device: GpuDevice, platform: Platform): DeviceRow[] {
  const rows: DeviceRow[] = [
    { labelKey: 'hw.field.model', value: device.deviceName || '—' },
    { labelKey: 'hw.field.vendor', value: device.vendorName || '—' },
    { labelKey: 'hw.field.ids', value: `${device.vendor ?? '—'} / ${device.deviceId ?? '—'}` },
    { labelKey: 'hw.field.hwNode', value: device.hwNode ?? '—' },
  ];

  if (platform === 'posix') {
    rows.push(
      { labelKey: 'hw.field.renderNode', value: device.renderNode ?? '—' },
      { labelKey: 'hw.field.cardNode', value: device.cardNode ?? '—' },
      { labelKey: 'hw.field.pci', value: device.pciAddress ?? '—' },
      { labelKey: 'hw.field.sysfs', value: device.sysfsPath ?? '—' },
    );
  }

  return rows;
}
