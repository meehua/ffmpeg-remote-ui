/**
 * 转码设置的模型与 argv 生成。
 *
 * 模型刻意贴着 ffmpeg 的命令行本身：
 *
 *   - 命令行选项按 `ffmpeg -h` 的分节组织，程序不维护自己的选项分类表；
 *   - 每类流（视频/音频/字幕/数据）的设置，对应 ffmpeg 的 Video/Audio/
 *     Subtitle/Data options 分节——因此这里没有把「只有视频和音频」写死；
 *   - 选项插在命令行的哪一段，默认值由 ffmpeg 在分节标题里的措辞决定。
 *
 * 参数的来源也全部是 ffmpeg 自己：编码器/解码器/滤镜/bsf/muxer/demuxer/
 * 协议的私有 AVOptions 各有各的 `-h <target>=<名>`，公共上下文那层在
 * `-h full`（见 api.optionGroups）。模型只负责把它们放到命令行上正确的位置，
 * 不判断哪个参数有用。
 *
 * 拆分/引号规则与后端 internal/ffmpeg 完全一致（两边都按平台分 POSIX 与 cmd 两套）：
 * 界面上看到的参数切分，就是服务器最终执行的那一份，避免「预览对了、执行错了」。
 */

import type { CliHelp, CliScope } from '../../api/types';
import { isRecord } from '../../utils/format';

/* ---------------------------------------------------------------- 命令选项 */

/** 选项插在命令行的哪一段。 */
export type CliPosition = 'global' | 'input' | 'output';

/**
 * 一个已启用的命令行选项。
 *
 * 位置单独存一份，而不是每次从分节现推：ffmpeg 帮助里的分节分类与实际的位置
 * 约束并不总是一致——`-hwaccel` 被列在 "Advanced Video options" 下，可放进
 * 输出侧时 ffmpeg 会直接报 "you are trying to apply an input option to an
 * output file"。与其在代码里给它开一个特例，不如把位置做成可改的字段。
 */
export interface CliEntry {
  /** 选项名，不含前导 '-'。 */
  name: string;
  /** 选项值；开关型选项这里是空串。 */
  value: string;
  /** ffmpeg 是否需要这个选项取值（没有占位符的就是开关）。 */
  takesValue: boolean;
  position: CliPosition;
  /**
   * 流定位符（v/a/s/d），只在 ffmpeg 给这个选项标了 `[:<stream_spec>]` 时有意义。
   *
   * 它是必须的：`-filter` 不带 `:a` 会作用到视频流上，`-filter:a loudnorm=…`
   * 才是「只处理音频」。留空表示 ffmpeg 的默认范围（对全部流生效）。
   */
  spec?: string;
}

/**
 * 一组「选项名 -> 取值」。
 *
 * 组件的私有参数（编码器、解码器、滤镜、bsf、muxer、协议…）都用这个形状带着：
 * 取值一律是 ffmpeg 自己定义的字符串，界面只负责原样交回去。
 */
export type OptionValues = Record<string, string>;

/**
 * 输入或输出侧的格式组件：`-f` 指定的那个名字，以及它自己的参数。
 *
 * 输入侧的候选来自 demuxer 与设备（FFmpeg 把 v4l2 这类设备实现成 demuxer），
 * 输出侧来自 muxer。名字和参数都来自 `ffmpeg -h <target>=<名>`：`-movflags
 * +faststart` 里的 movflags 就是 muxer 自己注册的 AVOption，程序不维护清单。
 */
export interface FormatSetting {
  /** `-f` 的取值；空串表示不生成 `-f`，由 ffmpeg 按文件名推断。 */
  name: string;
  /** 该组件的私有 AVOptions，直接作为命令行选项生成。 */
  options: OptionValues;
}

/**
 * 一个协议及其参数。
 *
 * 协议名来自输入/输出地址的 scheme（`rtmp://…` → rtmp）。候选值取自
 * `ffmpeg -protocols`，参数取自 `ffmpeg -h protocol=<名>`——例如 http 的
 * `-http_proxy`，它同样是注册在 URLContext 上的普通选项。
 */
export interface ProtocolSetting {
  /** 协议名；空串表示这个方向不生成协议参数。 */
  name: string;
  options: OptionValues;
}

/** `-filter_complex` 的图，以及把它的输出接到输出文件上的 `-map`。 */
export interface FilterComplexSetting {
  /** 滤镜图原文，例如 `[0:v]scale=1280:-1[outv]`。 */
  graph: string;
  /** 按顺序生成的 `-map` 取值，例如 `[outv]` 或 `0:a`。 */
  maps: string[];
}

/**
 * 一类流的编解码设置。
 *
 * 键是 ffmpeg 的流定位符（v/a/s/d）。它不写死在这里，而是由界面从
 * `/api/ffmpeg/cli` 的分节里取（Video options → v，Audio options → a …）。
 */
export interface StreamSetting {
  /**
   * 编码器名。`copy` 是 ffmpeg 的流拷贝语义（原文：'copy' to copy stream
   * without reencoding）；空串表示**不生成** `-c:<spec>`，此时 ffmpeg 会用
   * 输出格式的默认编码器重新编码——这并不是「保留原流」。
   */
  codec: string;
  /** 该编码器的 AVOptions，条目来自 `ffmpeg -h encoder=<名>`。 */
  options: OptionValues;
  /**
   * 解码器名，对应**输入侧**的 `-c:<spec>`。
   *
   * 与 codec 分开存：解码器必须早于 `-i`，编码器必须晚于它，两者在命令行上
   * 是两个不同的位置。空串的含义与 codec 相同——不生成这一段。
   */
  decoder: string;
  /** 解码器的 AVOptions，条目来自 `ffmpeg -h decoder=<名>`。 */
  decoderOptions: OptionValues;
  /**
   * bitstream filter 名，对应 `-bsf:<spec>`。
   *
   * 它与滤镜不是一回事：滤镜处理解码之后的帧，bsf 处理还没解开的码流，
   * 所以它落在编码之后、进容器之前。
   */
  bitstreamFilter: string;
  /** 该 bsf 的 AVOptions，条目来自 `ffmpeg -h bsf=<名>`。 */
  bitstreamOptions: OptionValues;
  /**
   * 这一路流的简单滤镜链，对应 `-filter:<spec>`。
   *
   * 存的是 ffmpeg 的滤镜图原文（`scale=1280:-1,fps=30`）。参数不在这里结构化：
   * 滤镜图是可嵌套的语法，硬拆成表单只会挡住 ffmpeg 支持的写法。需要成图、
   * 需要多路输入时用 filterComplex。
   */
  filter: string;
}

/**
 * 一次硬件设备初始化，对应 `-init_hw_device <type>=<name>[:<device>]`。
 *
 * 选项名来自 ffmpeg 的 Global options（`-h full` 原文：`-init_hw_device
 * <args>  initialise hardware device`）。类型与节点都是服务器报告的事实，
 * 这里不做任何型号推断，因此它保留结构化的两个字段，而不是一个自由文本框。
 *
 * 输入侧与输出侧各有一份：两侧可以要不同的类型（输入用 cuda 解码、输出用 qsv
 * 编码是常见组合），也都可以留空。ffmpeg 允许 `-init_hw_device` 出现多次，但
 * 设备名必须唯一——名字怎么取、以及它绑到哪一侧，见 buildArgs。
 */
export interface HwDeviceSetting {
  /** 设备类型，例如 qsv、vaapi、cuda；空串表示这一侧不初始化。 */
  type: string;
  /** 设备节点，例如 /dev/dri/renderD129；留空表示交给 FFmpeg 自己挑。 */
  device: string;
}

export interface EncodeSettings {
  /**
   * 命令行选项，**按顺序**排列。
   *
   * 是数组而不是「名字 -> 取值」的映射：ffmpeg 允许同一个选项重复出现
   * （`-map`、`-metadata`…），映射结构上就存不下第二份。哪些选项可以重复、
   * 能重复几次，只有用户知道，所以这里不做任何预判——顺序就是命令里的顺序。
   */
  cli: CliEntry[];
  /** 每类流的设置；没配置过的类别就是缺席，界面按空处理。 */
  streams: Record<string, StreamSetting>;
  /** 输入侧要初始化的硬件设备；留空表示这一侧不初始化。 */
  inputHardware: HwDeviceSetting;
  /** 输出侧要初始化的硬件设备；留空表示这一侧不初始化。 */
  outputHardware: HwDeviceSetting;
  /** 输入侧：`-f` 指定的 demuxer（设备也在这一列）及其实例参数。 */
  inputFormat: FormatSetting;
  /** 输出侧：`-f` 指定的 muxer 及其实例参数。 */
  outputFormat: FormatSetting;
  /** 输入地址的协议参数；协议名从地址的 scheme 读出。 */
  inputProtocol: ProtocolSetting;
  /** 输出地址的协议参数。 */
  outputProtocol: ProtocolSetting;
  /** `-filter_complex` 的图与它挂到输出上的 `-map`。 */
  filterComplex: FilterComplexSetting;
}

/** 一路流的空白设置；界面在某类流还没配置过时用它兜底。 */
export const emptyStream: StreamSetting = {
  codec: '',
  options: {},
  decoder: '',
  decoderOptions: {},
  bitstreamFilter: '',
  bitstreamOptions: {},
  filter: '',
};

/** 一份空设置：cli 是空数组（不是空对象），其余字段各自留空。 */
export const emptySettings: EncodeSettings = {
  cli: [],
  streams: {},
  inputHardware: { type: '', device: '' },
  outputHardware: { type: '', device: '' },
  inputFormat: { name: '', options: {} },
  outputFormat: { name: '', options: {} },
  inputProtocol: { name: '', options: {} },
  outputProtocol: { name: '', options: {} },
  filterComplex: { graph: '', maps: [] },
};

/**
 * 覆盖输出文件：`-y` 是 ffmpeg 的 Global options 之一，所以它是 cli 里的一个
 * 开关，而不是设置对象上一个自成一体的布尔字段。
 */
export function hasOverwrite(settings: EncodeSettings): boolean {
  // 同一个选项可以出现多份（`-y` 也不例外），所以这里问的是「有没有」，
  // 而不是「第一条是谁」。
  return settings.cli.some((entry) => entry.name === 'y');
}

export function withOverwrite(settings: EncodeSettings, on: boolean): EncodeSettings {
  const cli = settings.cli.filter((entry) => entry.name !== 'y');
  if (on) {
    // 全局选项只能落在命令行最前面，所以它排在最前。`-y` 重复出现没有意义，
    // 上面已经把它清掉，这里只补一份。
    cli.unshift({ name: 'y', value: '', takesValue: false, position: 'global' });
  }
  return { ...settings, cli };
}

/**
 * 从 ffmpeg 的分节推导选项的默认插入位置。
 *
 * 判据是 ffmpeg 写在标题里的措辞，与后端 CliSection.Scope 同一套规则。
 * "input and output" 默认放输入侧：`-ss` 这类选项放在输入之前是快速定位，
 * 更符合直觉；需要精确截取时用户可以自己改。
 */
export function defaultPosition(scope: CliScope): CliPosition {
  switch (scope) {
    case 'global':
      return 'global';
    case 'input':
    case 'both':
      return 'input';
    default:
      return 'output';
  }
}

/* ---------------------------------------------------------------- 外部数据 */

function stringOr(raw: unknown, fallback = ''): string {
  return typeof raw === 'string' ? raw : fallback;
}

/** 收拢一组「选项名 -> 值」；非字符串与空值都丢掉。 */
function normalizeOptions(raw: unknown): OptionValues {
  if (!isRecord(raw)) {
    return {};
  }
  const out: OptionValues = {};
  for (const [name, value] of Object.entries(raw)) {
    if (typeof value === 'string' && value !== '') {
      out[name] = value;
    }
  }
  return out;
}

function normalizePosition(raw: unknown): CliPosition {
  return raw === 'global' || raw === 'input' || raw === 'output' ? raw : 'output';
}

/** 从一份（形状未知的）数据里拼出一个选项条目。 */
function entryFrom(name: string, raw: unknown): CliEntry {
  const record = isRecord(raw) ? raw : {};
  return {
    name,
    value: stringOr(record.value),
    takesValue: typeof record.takesValue === 'boolean' ? record.takesValue : true,
    position: normalizePosition(record.position),
    spec: typeof record.spec === 'string' && record.spec !== '' ? record.spec : undefined,
  };
}

/**
 * 收拢命令行选项。
 *
 * 两种形状都收：现在的数组，以及 v2 预设里的「名字 -> 取值」映射（那时同一个
 * 选项只能出现一次）。映射按它自己的键序转成数组——那正是它当时显示的顺序。
 */
function normalizeEntries(raw: unknown): CliEntry[] {
  if (Array.isArray(raw)) {
    const out: CliEntry[] = [];
    for (const item of raw) {
      if (!isRecord(item)) {
        continue;
      }
      const name = stringOr(item.name);
      if (name !== '') {
        out.push(entryFrom(name, item));
      }
    }
    return out;
  }

  if (isRecord(raw)) {
    return Object.entries(raw)
      .filter(([, value]) => isRecord(value))
      .map(([name, value]) => entryFrom(name, value));
  }

  return [];
}

function normalizeStreams(raw: unknown): Record<string, StreamSetting> {
  if (!isRecord(raw)) {
    return {};
  }
  const out: Record<string, StreamSetting> = {};
  for (const [spec, value] of Object.entries(raw)) {
    if (!isRecord(value)) {
      continue;
    }
    out[spec] = {
      codec: stringOr(value.codec),
      options: normalizeOptions(value.options),
      decoder: stringOr(value.decoder),
      decoderOptions: normalizeOptions(value.decoderOptions),
      bitstreamFilter: stringOr(value.bitstreamFilter),
      bitstreamOptions: normalizeOptions(value.bitstreamOptions),
      filter: stringOr(value.filter),
    };
  }
  return out;
}

function normalizeFormat(raw: unknown): FormatSetting {
  const record = isRecord(raw) ? raw : {};
  return { name: stringOr(record.name), options: normalizeOptions(record.options) };
}

function normalizeProtocol(raw: unknown): ProtocolSetting {
  const record = isRecord(raw) ? raw : {};
  return { name: stringOr(record.name), options: normalizeOptions(record.options) };
}

function normalizeFilterComplex(raw: unknown): FilterComplexSetting {
  const record = isRecord(raw) ? raw : {};
  const maps = Array.isArray(record.maps)
    ? record.maps.filter((item): item is string => typeof item === 'string' && item.trim() !== '')
    : [];
  return { graph: stringOr(record.graph), maps };
}

/**
 * 收拢一处硬件设备设置。
 *
 * 按顺序取第一个是对象的来源：新结构有 `inputHardware` / `outputHardware` 两份，
 * 旧结构只有一份 `hwDevice`。旧的那份迁到**输出侧**：那时的单格挂在「编码参数」
 * 面板上，填它多半是为了用硬件编码，而输出侧正是生成 `-filter_hw_device` 的那一侧
 * （`-init_hw_device qsv=hw -filter_hw_device hw -c:v h264_qsv` 是 ffmpeg 那边的常见
 * 写法）。迁到输入侧会顺带打开硬件解码，那更可能改掉一份老预设本来能跑的行为。
 */
function normalizeHardware(...sources: unknown[]): HwDeviceSetting {
  for (const source of sources) {
    if (isRecord(source)) {
      return { type: stringOr(source.type), device: stringOr(source.device) };
    }
  }
  return { type: '', device: '' };
}

/**
 * 把外部来的数据收拢成 EncodeSettings。
 *
 * 数据来源有三个：浏览器本地存档、服务器上的预设文件，以及更早版本的界面。
 * 三者都可能缺字段、多字段或类型不对，因此这里刻意宽容：问题只影响对应的
 * 那一项，其余照常恢复——一份过时的预设不该让整个界面崩掉。
 */
export function normalizeSettings(raw: unknown): EncodeSettings {
  const record = isRecord(raw) ? raw : {};

  // 旧结构（编码器直接放在顶层，只有视频与音频两类）迁移过来。
  const hasCli = isRecord(record.cli) || Array.isArray(record.cli);
  if (!hasCli && !isRecord(record.streams)) {
    return {
      ...fromLegacy(record),
      inputHardware: normalizeHardware(record.inputHardware),
      outputHardware: normalizeHardware(record.outputHardware, record.hwDevice),
    };
  }

  return {
    cli: normalizeEntries(record.cli),
    streams: normalizeStreams(record.streams),
    inputHardware: normalizeHardware(record.inputHardware),
    outputHardware: normalizeHardware(record.outputHardware, record.hwDevice),
    inputFormat: normalizeFormat(record.inputFormat),
    outputFormat: normalizeFormat(record.outputFormat),
    inputProtocol: normalizeProtocol(record.inputProtocol),
    outputProtocol: normalizeProtocol(record.outputProtocol),
    filterComplex: normalizeFilterComplex(record.filterComplex),
  };
}

/**
 * 从旧结构（`videoCodec` / `audioCodec` / `videoOptions` / `audioOptions`）迁移。
 *
 * 编码器的参数原样搬到对应的流里。编码器为空时**保持「不生成 -c:x」**，
 * 不顺手改成 `copy`：旧界面那句「保留原流」其实是错的（不指定编码器时
 * ffmpeg 会用输出格式的默认编码器重编），但迁移不该悄悄改变转码结果——
 * 把文案改对、让用户自己选 copy 才负责。
 */
function fromLegacy(record: Record<string, unknown>): EncodeSettings {
  const streams: Record<string, StreamSetting> = {};
  for (const [spec, codecKey, optionsKey] of [
    ['v', 'videoCodec', 'videoOptions'],
    ['a', 'audioCodec', 'audioOptions'],
  ] as const) {
    const codec = stringOr(record[codecKey]);
    const options = normalizeOptions(record[optionsKey]);
    if (codec !== '' || Object.keys(options).length > 0) {
      streams[spec] = { ...emptyStream, codec, options };
    }
  }
  return { ...emptySettings, streams };
}

/* ---------------------------------------------------------------- argv */

export interface BuildRequest {
  input: string;
  output: string;
  settings: EncodeSettings;
  /** 手写补充参数，插在输出文件之前。 */
  extraArgs: string;
  /** 服务器所在平台：手写参数与命令预览都按它的规则处理。 */
  platform?: Platform;
  /**
   * ffmpeg 自己的命令行拓扑（`-h long`），用来读出「类型专用设备选项」。
   *
   * 输出侧那块卡怎么被指名由它决定：`<类型>_device` 这类选项（`qsv_device`、
   * `vaapi_device`…）才是给编解码器指定设备的那个开关，而 `-filter_hw_device`
   * 按文档只管滤镜。映射由 hardwareDeviceOptionsOf 从这份帮助里读出来。
   */
  cliHelp?: CliHelp | null;
}

/** 追加一组组件私有参数：`-<名> <取值>`。空值不生成半截参数。 */
function appendOptionValues(args: string[], options: OptionValues): void {
  for (const [name, value] of Object.entries(options)) {
    const trimmed = value.trim();
    if (trimmed !== '') {
      args.push(`-${name}`, trimmed);
    }
  }
}

/**
 * 组件名 + 它自己的参数组成一段文本：`name=key=value:key2=value2`。
 *
 * 滤镜与 bsf 的写法相同（`key=value` 对，多个用 ':' 连），区别只在滤镜链里
 * 多个滤镜用 ',' 分隔、而每路流只有一个 bsf。没有参数时就只有名字。
 *
 * 界面上的滤镜参数助手也用这个函数生成片段，所以「助手预览里看到的」就是
 * 「命令里生成的」。
 */
export function componentParams(name: string, values: OptionValues): string {
  const params = Object.entries(values)
    .filter(([, value]) => value.trim() !== '')
    .map(([key, value]) => `${key}=${value.trim()}`);
  return params.length === 0 ? name : `${name}=${params.join(':')}`;
}

/**
 * bsf 的取值：名字后面直接跟它自己的参数。
 *
 * 实测 `-bsf:v h264_metadata=aud=insert:colour_primaries=1` 可用——bsf 的
 * AVOptions 注册在 AVBSFContext 上，ffmpeg 解析这段文本的方式与滤镜参数一致。
 */
function bitstreamValue(stream: StreamSetting): string {
  return componentParams(stream.bitstreamFilter, stream.bitstreamOptions);
}

/**
 * 追加 filter_complex 与它的 -map。
 *
 * 图为空时整段都不生成：空的 `-filter_complex ''` 会让 ffmpeg 直接报错，
 * 而「没配过滤镜」正是一份设置的常态。
 */
function appendFilterComplex(args: string[], complex: FilterComplexSetting): void {
  const graph = complex.graph.trim();
  if (graph === '') {
    return;
  }
  args.push('-filter_complex', graph);
  for (const label of complex.maps) {
    const trimmed = label.trim();
    if (trimmed !== '') {
      args.push('-map', trimmed);
    }
  }
}

/** 追加一路流的输出侧设置：编码器 → bsf → 简单滤镜链。 */
function appendStreamOutput(args: string[], spec: string, stream: StreamSetting): void {
  if (stream.codec !== '') {
    args.push(`-c:${spec}`, stream.codec);
    appendOptionValues(args, stream.options);
  }
  if (stream.bitstreamFilter !== '') {
    args.push(`-bsf:${spec}`, bitstreamValue(stream));
  }
  const filter = stream.filter.trim();
  if (filter !== '') {
    args.push(`-filter:${spec}`, filter);
  }
}

/** 一次设备初始化在命令行上要用的名字：类型名，重名时加序号（`qsv2`）。 */
function hwDeviceName(type: string, names: Set<string>): string {
  let name = type;
  for (let n = 2; names.has(name); n += 1) {
    name = `${type}${n}`;
  }
  names.add(name);
  return name;
}

/**
 * `-init_hw_device` 的取值。
 *
 * 设备节点放在参数里的哪个位置**按类型不同**，这不是本程序的规矩，是 ffmpeg 文档
 * 写死的语法（`ffmpeg -h full` 只有一行 `<args>`，这一层只在 man/官网文档里）：
 *
 *   - QSV 的 `device` 位置收的是 MFX 实现（`hw`、`auto_any`、`hw2`…），DRM 节点得用
 *     `child_device=` 传。官方原文：`-init_hw_device qsv:hw,child_device=/dev/dri/renderD129`
 *     —— "Create a QSV device with MFX_IMPL_HARDWARE on DRM render node …"。把节点写进
 *     device 位置（`qsv=qsv2:/dev/dri/renderD129`）不会报错，却会被当成实现选择符，
 *     设备于是退回默认那块——两块卡都落在核显上就是这么来的。
 *   - 其余类型的 `device` 位置本身就是设备：cuda 是序号、vaapi 是 DRM 节点路径。
 */
function hwDeviceArg(type: string, name: string, device: string): string {
  if (device === '') {
    return `${type}=${name}`;
  }
  return type === 'qsv' ? `${type}=${name}:hw,child_device=${device}` : `${type}=${name}:${device}`;
}

/**
 * 从 `ffmpeg -h long` 的帮助里读出「类型专用设备选项」：类型 -> 选项名。
 *
 * 判据是 ffmpeg 自己的命名——`<类型>_device`（"Advanced global options" 里的
 * `qsv_device`、`vaapi_device`…）。所以这不是本程序维护的类型清单：ffmpeg 给某个
 * 类型加了设备选项，这里自动就有。
 *
 * 它决定输出侧那块卡怎么被指名。多卡时官方给的就是它（`-qsv_device <节点>`）；
 * 而 `-filter_hw_device` 按文档只管滤镜，拿它当编码器的选卡开关是不起作用的。
 */
export function hardwareDeviceOptionsOf(cliHelp: CliHelp | null): Record<string, string> {
  const options: Record<string, string> = {};
  for (const section of cliHelp?.sections ?? []) {
    for (const option of section.options) {
      const match = /^([a-z0-9]+)_device$/.exec(option.name);
      if (match) {
        options[match[1]] = option.name;
      }
    }
  }
  return options;
}

/**
 * 按 ffmpeg 的参数分层拼装：
 *
 *   全局选项 → 硬件设备（创建 + 输出侧绑定）→ 输入协议参数 → 输入侧选项 →
 *   -f 输入格式 → 输入侧的硬件解码（-hwaccel）→ 每类流的解码器 → -i 输入 →
 *   filter_complex 与 -map → 每类流的编码设置（编码器 → bsf → 简单滤镜链）→
 *   输出侧选项 → -f 输出格式 → 输出协议参数 → 手写补充参数 → 输出文件
 *
 * 这个层次不是一份手写的顺序表，而是「选项属于 ffmpeg 的哪一段」的直接结果：
 * 全局选项必须最先；解码器与输入侧选项必须早于它作用的输入；编码器、bsf、
 * 滤镜与输出侧选项必须晚于输入、早于输出文件。
 *
 * `-hide_banner` 不在这里生成：服务器执行前会自己补上（见 internal/server 的
 * runJob），免得界面把一个纯日志开关当成转码设置。
 */
export function buildArgs({
  input,
  output,
  settings,
  extraArgs,
  platform = 'posix',
  cliHelp = null,
}: BuildRequest): string[] {
  const args: string[] = [];

  // 输出侧那块卡怎么被指名，取决于这套 ffmpeg 报了哪些「类型专用设备选项」。
  const hardwareDeviceOptions = hardwareDeviceOptionsOf(cliHelp);

  appendCli(args, settings.cli, 'global');

  // 硬件设备：两侧各可指定一块，并且各自**指名到它该管的那一侧**。
  //
  // `-init_hw_device` 只负责把设备创建出来，它不记得哪块是给输入、哪块是给输出的
  // ——同类型有多个时 ffmpeg 自己挑一个，所以「输入用哪块、输出用哪块」必须在命令行
  // 上另说一句。两句都取自 ffmpeg 自己的选项，而且**只有这两句管用**：
  //
  //   - 输入侧那块用于解码：`-hwaccel <类型> -hwaccel_device <名>`。两个都是
  //     input-only 的选项，所以落在下面输入段（-i 之前）。
  //   - 输出侧那块用于编码：该类型的专用设备选项，例如 QSV 的 `-qsv_device <节点>`。
  //     别拿 `-filter_hw_device` 当这个开关用：ffmpeg 文档说它「把命名的设备交给所有
  //     滤镜」（"Pass the hardware device called name to all filters in any filter
  //     graph… a global setting, so all filters will receive the same device"），
  //     对编码器选哪块卡不起作用。ffmpeg 没报这种专用选项时才退回它。
  //
  // 设备名取类型名（`qsv=qsv`），重名时给后一条加序号（`qsv2`）：ffmpeg 要求设备名
  // 唯一，而两侧完全可能选同一个类型、不同的设备——两块卡各管一边就是这样。
  const hwNames = new Set<string>();
  const inputHwType = settings.inputHardware.type.trim();
  const inputHwDevice = settings.inputHardware.device.trim();
  const outputHwType = settings.outputHardware.type.trim();
  const outputHwDevice = settings.outputHardware.device.trim();
  const outputHwOption = hardwareDeviceOptions[outputHwType];

  let inputHwName = '';
  if (inputHwType !== '') {
    inputHwName = hwDeviceName(inputHwType, hwNames);
    args.push('-init_hw_device', hwDeviceArg(inputHwType, inputHwName, inputHwDevice));
  }

  if (outputHwType !== '') {
    const sameInitialisation =
      inputHwType !== '' && inputHwType === outputHwType && inputHwDevice === outputHwDevice;

    // 输出侧那块要**两条**指名一起写：它们各管一层，指向的是同一块卡。
    //
    //   - `-filter_hw_device <名>`：文档说它「把命名的设备交给滤镜图」，而输出流的
    //     编码器正是从滤镜图继承 hw_device_ctx 的——这是「编码器用哪块卡」最直接的
    //     一步。
    //   - 该类型自己的 `<类型>_device <节点>`（ffmpeg 帮助里就是这么命名的，例如
    //     `-qsv_device`）：多卡时官方给的就是它。
    //
    // 只写其中一条时，编码器在某些情况下仍会落回默认设备（两台机器上的现象都是这样），
    // 所以两条都写——它们不冲突，指向同一块卡。
    const name = sameInitialisation ? inputHwName : hwDeviceName(outputHwType, hwNames);
    if (!sameInitialisation) {
      args.push('-init_hw_device', hwDeviceArg(outputHwType, name, outputHwDevice));
    }
    args.push('-filter_hw_device', name);
    if (outputHwOption !== undefined && outputHwDevice !== '') {
      args.push(`-${outputHwOption}`, outputHwDevice);
    }
  }

  // 协议参数是注册在 URLContext 上的普通选项（-http_proxy、-timeout…），
  // 按它作用的方向摆在对应文件之前。
  appendOptionValues(args, settings.inputProtocol.options);
  appendCli(args, settings.cli, 'input');
  if (settings.inputFormat.name !== '') {
    args.push('-f', settings.inputFormat.name);
  }
  appendOptionValues(args, settings.inputFormat.options);

  // 输入侧那块设备用于解码。放在这里是因为 -hwaccel 与 -hwaccel_device 都是
  // input-only 的选项：它们必须落在所作用的那个输入之前。
  if (inputHwName !== '') {
    args.push('-hwaccel', inputHwType, '-hwaccel_device', inputHwName);
  }

  // 解码器必须早于 -i：它作用于这个输入的码流。没指定时整段不生成，
  // 由 ffmpeg 自己选解码器。
  for (const [spec, stream] of Object.entries(settings.streams)) {
    if (stream.decoder === '') {
      continue;
    }
    args.push(`-c:${spec}`, stream.decoder);
    appendOptionValues(args, stream.decoderOptions);
  }

  args.push('-i', input);

  appendFilterComplex(args, settings.filterComplex);

  for (const [spec, stream] of Object.entries(settings.streams)) {
    appendStreamOutput(args, spec, stream);
  }

  appendCli(args, settings.cli, 'output');
  if (settings.outputFormat.name !== '') {
    args.push('-f', settings.outputFormat.name);
  }
  appendOptionValues(args, settings.outputFormat.options);
  appendOptionValues(args, settings.outputProtocol.options);

  args.push(...splitArgs(extraArgs, platform));
  args.push(output);
  return args;
}

/**
 * 追加某一层的命令行选项。
 *
 * 顺序就是数组里的顺序，不另排序：同一个选项重复出现时（连着好几条 `-map`）
 * 先后本来就有意义，而用户加进来时的顺序正是他要的那个顺序。
 */
function appendCli(args: string[], cli: CliEntry[], position: CliPosition): void {
  for (const entry of cli) {
    if (entry.position !== position) {
      continue;
    }
    // ffmpeg 允许这种选项带 `:<stream_spec>`（帮助原文里的 `[:<stream_spec>]`）。
    // 少了它，`-filter loudnorm=…` 会落到视频流上；`-filter:a` 才是本意。
    const flag = entry.spec ? `${entry.name}:${entry.spec}` : entry.name;
    if (entry.takesValue) {
      const value = entry.value.trim();
      if (value === '') {
        continue; // 需要取值却还空着：不生成半截参数
      }
      args.push(`-${flag}`, value);
    } else {
      args.push(`-${flag}`);
    }
  }
}

/* ---------------------------------------------------------------- 文本 */

/**
 * 服务器所在平台——argv 的引用与拆分规则按它分两套。
 *
 * 这两套规则与后端 internal/ffmpeg 的 args_posix.go / args_windows.go 一一对应：
 * 界面上的预览必须就是服务器最终执行的那一份，否则「预览对了、执行错了」。
 * 改任何一边都要同步改另一边。
 */
export type Platform = 'windows' | 'posix';

/** 把服务器报告的 GOOS 归一成引用规则认得的两个平台之一。 */
export function platformOf(os: string | undefined): Platform {
  return os !== undefined && os.toLowerCase() === 'windows' ? 'windows' : 'posix';
}

export function splitArgs(input: string, platform: Platform = 'posix'): string[] {
  return platform === 'windows' ? splitArgsWindows(input) : splitArgsPosix(input);
}

/**
 * 拆分手写命令行，POSIX shell 的常用子集：单引号与双引号都能引用，
 * 反斜杠在单引号外是转义前缀。
 *
 * 前端只用它做实时预览，因此对未闭合引号保持宽容；服务器端的实现会在
 * 真正执行前给出明确错误。
 */
function splitArgsPosix(input: string): string[] {
  const args: string[] = [];
  let current = '';
  let quote = '';
  let escaped = false;
  let started = false;

  const flush = () => {
    if (started) {
      args.push(current);
      current = '';
      started = false;
    }
  };

  for (const char of input) {
    if (escaped) {
      current += char;
      escaped = false;
      started = true;
      continue;
    }
    if (char === '\\' && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote !== '') {
      if (char === quote) {
        quote = '';
      } else {
        current += char;
      }
      started = true;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      started = true;
      continue;
    }
    if (/\s/.test(char)) {
      flush();
      continue;
    }
    current += char;
    started = true;
  }

  if (escaped) {
    current += '\\';
  }
  flush();
  return args;
}

/**
 * 拆分手写命令行，cmd.exe 的常用子集：只有双引号是引用符，反斜杠是路径分隔符。
 *
 * 两个区别都来自 Windows 的实际情况：引号外的反斜杠是普通字符（否则
 * C:\Users\me\a.mp4 会被吃成 C:Usersmea.mp4），而单引号不是 cmd 的引用符——
 * ffmpeg 的 filtergraph 恰恰爱用它（subtitles='x.srt'），必须原样留着。
 *
 * 引号内的反斜杠按 CommandLineToArgvW 的规则处理：2n 个反斜杠加一个引号是
 * n 个反斜杠加一个引号定界符，2n+1 个则是 n 个反斜杠加一个字面引号。这条规则
 * 与服务器端一致，也与 Windows 自己解析命令行时一致。
 */
function splitArgsWindows(input: string): string[] {
  const args: string[] = [];
  let current = '';
  let quoted = false;
  let started = false;

  const flush = () => {
    if (started) {
      args.push(current);
      current = '';
      started = false;
    }
  };

  // 用码点数组而不是 for...of：引号内的反斜杠要成组处理，需要向前看。
  const chars = Array.from(input);
  for (let i = 0; i < chars.length; i++) {
    const char = chars[i];

    if (quoted && char === '\\') {
      let n = 0;
      while (i + n < chars.length && chars[i + n] === '\\') {
        n += 1;
      }
      if (i + n < chars.length && chars[i + n] === '"') {
        current += '\\'.repeat(Math.floor(n / 2));
        started = true;
        if (n % 2 === 1) {
          current += '"'; // 奇数个：这个引号是字面字符，引用区继续
        } else {
          quoted = false; // 偶数个：这个引号是引用区的结束定界符
        }
        i += n; // 循环自增再吃掉那个引号
        continue;
      }
      // 后面不是引号：反斜杠只是普通字符，一个都不能少。
      current += '\\'.repeat(n);
      started = true;
      i += n - 1;
      continue;
    }

    if (char === '"') {
      quoted = !quoted;
      started = true;
      continue;
    }
    if (!quoted && /\s/.test(char)) {
      flush();
      continue;
    }
    current += char;
    started = true;
  }
  flush();
  return args;
}

/** 给单个参数加引号，保证拼出来的命令可以原样粘回终端。 */
export function quoteArg(value: string, platform: Platform = 'posix'): string {
  return platform === 'windows' ? quoteArgWindows(value) : quoteArgPosix(value);
}

const NEEDS_QUOTE = /[\s\\"'$`;&|<>()*?[\]{}#!~]/;

/** POSIX：单引号内除单引号本身外无需转义，是最不容易出错的引用方式。 */
function quoteArgPosix(value: string): string {
  if (value === '') {
    return "''";
  }
  if (!NEEDS_QUOTE.test(value)) {
    return value;
  }
  return `'${value.split("'").join("'\\''")}'`;
}

/**
 * Windows：含空白或引号时用双引号包裹，引号前的反斜杠按 2n/2n+1 翻倍。
 *
 * 末尾的反斜杠必须翻倍，否则它会把收尾引号本身转义掉——这正是 Windows 上
 * 「路径以反斜杠结尾」出错的由来。生成出来的写法在 cmd 与 PowerShell 里都能直接粘贴。
 */
function quoteArgWindows(value: string): string {
  if (value === '') {
    return '""';
  }
  if (!/[\s"]/.test(value)) {
    return value;
  }

  let out = '"';
  let slashes = 0;
  for (const char of value) {
    if (char === '\\') {
      slashes += 1;
      continue;
    }
    out += char === '"' ? '\\'.repeat(slashes * 2 + 1) : '\\'.repeat(slashes);
    out += char;
    slashes = 0;
  }
  out += '\\'.repeat(slashes * 2);
  return `${out}"`;
}

export function joinArgs(args: string[], platform: Platform = 'posix'): string {
  return args.map((arg) => quoteArg(arg, platform)).join(' ');
}

/** 去掉用户可能连在一起粘贴过来的 ffmpeg/ffprobe 前缀（认得盘符与 .exe）。 */
export function stripToolPrefix(args: string[]): string[] {
  const base = (args[0] ?? '').split(/[\\/]/).pop() ?? '';
  const name = base.toLowerCase().replace(/\.exe$/, '');
  return name === 'ffmpeg' || name === 'ffprobe' ? args.slice(1) : args;
}
