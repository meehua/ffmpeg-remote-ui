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

import type { GpuDevice, HWProbe } from '../../api/types';
import type { MessageKey } from '../../i18n';
import type { Platform } from '../workspace/args';

/**
 * 一次实测最多试几个值。
 *
 * 与服务器端的 maxHWProbes 对应：那边每个值都要起一个 FFmpeg 进程，数量得压住。
 * 这里是提前截断，免得用户填一连串值之后才被服务器驳回。
 */
const hwProbeLimit = 8;

/** 一条可以喂给 `-init_hw_device <type>=hw:<node>` 的节点候选。 */
export interface HwNodeOption {
  /** 节点本身，也就是 `<node>` 那一段。 */
  value: string;
  /** 显示的一行文字。 */
  text: string;
  /** 悬浮说明，帮人认出这是哪块卡。 */
  detail: string;
}

/**
 * 「不指定节点」这一项的值。
 *
 * 空串不是「没有值」：节点留空正是让 FFmpeg 自己挑设备，它是一个正经选项，
 * 所以它得在下拉里有自己的一行，而不是靠占位符假装成没填。
 */
export const hwNodeAuto = '';

/**
 * 「下面自己填」这一项的值。
 *
 * 它不是设备节点，而是一个只在下拉里存在的开关：选中表示「不从上面的候选里挑」。
 * 用 NUL 开头是为了它绝不可能与真的节点撞上——节点要么是路径、要么是序号，都是人
 * 选得出来的普通文本。这个值本身永远不会被写进设置。
 */
export const hwNodeManual = '\u0000manual';

/**
 * 一条选项是哪种来历。
 *
 * 界面靠它决定这一行的结论写什么词（可用 / 不可用 / 未实测），也让「这台设备有结论」
 * 与「它只是清单里的一个名字」在视觉上分得开。
 */
export type HwNodeKind = 'auto' | 'ok' | 'fail' | 'listed' | 'untested' | 'manual';

/** 设备节点下拉里的一行。 */
export interface HwNodeChoice {
  /** 选中后写进设置的值；手填那一项是哨兵，界面另有处理。 */
  value: string;
  kind: HwNodeKind;
  /**
   * 这一行说的是哪台设备：型号在前、标识符在后。
   *
   * 只有设备行有；「自动选择」、手填的项与手填过的值都没有设备可写，留空。
   */
  text: string;
  /** 悬浮说明：有实测的放完整原文，只有名字的放认卡用得上的标签。 */
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
 * 厂商:设备 ID——认卡的标识符。清单里带的是注册表的写法（`0x1234` / `0x5678`），
 * 这里按 PCI 的通行写法归一到 `1234:5678`：短一点，也是各处文档通用的那一种。
 */
function idsOf(device: GpuDevice): string {
  const part = (value: string | undefined) =>
    value ? value.trim().toLowerCase().replace(/^0x/, '') : '';
  return [part(device.vendor), part(device.deviceId)].filter((item) => item !== '').join(':');
}

/** 设备的名字：型号在前（人认卡靠它），标识符跟在后（同型号的两块卡只能靠它分）。 */
export function deviceLabel(device: GpuDevice): string {
  return [deviceTitle(device), idsOf(device)].filter((part) => part !== '').join(' · ');
}

/**
 * 设备清单里那些**系统自己给出了名字**的设备值，可以直接当候选摆出来。
 *
 * 判据只有「服务器给没给这个设备的 HwNode」：只有名字本身就是设备标识的设备才有，
 * 例如 Linux 的 `/dev/dri/renderD128`。Windows 上的显示适配器只有注册表子键序号，
 * 而 FFmpeg 数的是 DXGI 的物理适配器，两套编号不是一回事，于是服务器那边干脆留空，
 * 这里也就空着——不给候选，好过给一个要用户去赌的数字。
 *
 * 有候选也不等于「就该填它」：同一个值在不同类型里的含义由 FFmpeg 解释（qsv 收到
 * 的其实是 MFX 实现选择符），能不能用一律以实测为准，见 probeCandidates。
 */
export function hwNodeOptions(devices: GpuDevice[]): HwNodeOption[] {
  return devices.flatMap((device) =>
    device.hwNode
      ? [{ value: device.hwNode, text: deviceLabel(device), detail: deviceDetail(device) }]
      : [],
  );
}

/**
 * 实测要试哪些值。
 *
 * 除了清单里那些确定的名字，还穷举 0、1、2、3 几个小序数：Windows 上的 d3d11va、
 * cuda 就是靠序号选设备，而程序不可能知道机器上排到了几号。与其让用户去猜，不如
 * 让 FFmpeg 每个都答一遍——这是**穷举**，不是映射表：这里没有任何「哪块卡是几号」
 * 的说法，号码的含义完全由 FFmpeg 的回答给出。
 *
 * 正因如此，序号在 qsv 这类类型上试出来的结论要连同原文一起看：同一个 `1` 在 qsv
 * 眼里是 MFX 的「软件实现」，失败与哪块卡无关。程序不替用户下结论，也不隐藏这一层：
 * 它只负责把 FFmpeg 的回答摆回去。
 */
export function probeCandidates(devices: GpuDevice[], current: string): string[] {
  const values = ['', '0', '1', '2', '3', ...hwNodeOptions(devices).map((node) => node.value)];
  if (current.trim() !== '') {
    values.push(current.trim());
  }
  // 去重：用户手填的 0 与穷举出来的 0 是同一个候选，不必试用两遍。
  return [...new Set(values)].slice(0, hwProbeLimit);
}

/**
 * 设备节点下拉里的全部选项：**一行一台设备**。
 *
 * 设备行只来自服务器自己那份检测清单（`/api/hardware`），而且只列检测本身给出名字的
 * 那些——那个名字就是能填进 `-init_hw_device` 的值（Linux 上的 `/dev/dri/renderD128`
 * 就是）。检测给不出值的设备不列：宁可不写，也不替用户猜一个数字填进去（Windows 上
 * 的显示适配器就是这种，注册表子键序号与 FFmpeg 认的适配器序号对不上）。
 *
 * 实测（见 probeCandidates）只回答「这个值能不能用」，结论按值相等写回它自己那一行，
 * 此外不做任何跨设备的对照：FFmpeg 报不报「这个值落在了哪块卡上」按类型各不相同——
 * d3d11va 会说它用的是哪块设备，cuda 在 verbose、debug、trace 三级日志下都只说它加载
 * 了 cuDeviceGetName 这类符号，qsv 报的又是它自己挑中的子设备——从输出里抠设备名只会
 * 抠出一层脆壳，所以这里不抠。测过的值若不属于任何一台有名字的设备，就不占一行。
 */
export function hwNodeChoices(
  devices: GpuDevice[],
  probes: HWProbe[] | null,
  current: string,
): HwNodeChoice[] {
  const tried = probes ?? [];
  const used = new Set<string>();

  // 「不指定」：空节点是一个正经选项，它自己的实测结论写在它这一行上。
  const autoItem = tried.find((item) => item.node === hwNodeAuto);
  if (autoItem) {
    used.add(hwNodeAuto);
  }
  const auto: HwNodeChoice = {
    value: hwNodeAuto,
    kind: autoItem ? (autoItem.ok ? 'ok' : 'fail') : 'auto',
    text: '',
    detail: autoItem?.error ?? '',
  };

  const rows: HwNodeChoice[] = [];
  for (const option of hwNodeOptions(devices)) {
    if (used.has(option.value)) {
      continue;
    }
    used.add(option.value);
    // 这个值实测过就带上结论：按值相等对上，不需要认出它是哪块卡。
    const item = tried.find((probe) => probe.node === option.value);
    rows.push({
      value: option.value,
      kind: item ? (item.ok ? 'ok' : 'fail') : 'listed',
      text: option.text,
      detail: item?.error || option.detail,
    });
  }

  // 手填过、但这一轮没测到的值（也可能测过而换了类型，结果已经作废）：摆出来让人
  // 看见自己填的是什么，否则下拉会显示成别的候选。
  const typed = current.trim();
  const untested: HwNodeChoice[] =
    typed === '' || typed === hwNodeManual || used.has(typed)
      ? []
      : [{ value: typed, kind: 'untested', text: '', detail: '' }];

  return [
    auto,
    ...rows,
    ...untested,
    // 手填永远是最后一项：它是「上面都不合适」的出口，不该夹在候选中间。
    { value: hwNodeManual, kind: 'manual', text: '', detail: '' },
  ];
}

/**
 * 「硬件」页要列出的字段。
 *
 * render node、card node、sysfs 与 PCI 地址都是 DRM 那一套概念，只存在于 Linux；
 * 没有它们的平台上列出来只是占地方。设备值（HwNode）也一样只在 Linux 上有，
 * 而且它与 render node 是同一个路径，所以不另列一行。
 */
export function deviceRows(device: GpuDevice, platform: Platform): DeviceRow[] {
  const rows: DeviceRow[] = [
    { labelKey: 'hw.field.model', value: device.deviceName || '—' },
    { labelKey: 'hw.field.vendor', value: device.vendorName || '—' },
    { labelKey: 'hw.field.ids', value: `${device.vendor ?? '—'} / ${device.deviceId ?? '—'}` },
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
