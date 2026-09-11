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
 * 拆分/引号规则与后端 internal/ffmpeg 完全一致：界面上看到的参数切分，
 * 就是服务器最终执行的那一份，避免「预览对了、执行错了」。
 */

import type { CliScope } from '../../api/types';
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
export interface CliValue {
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
 * 一类流的编码设置。
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
  options: Record<string, string>;
}

/**
 * 一次硬件设备初始化，对应 `-init_hw_device <type>=hw[:<device>]`。
 *
 * 选项名来自 ffmpeg 的 Global options（`-h full` 原文：`-init_hw_device
 * <args>  initialise hardware device`）。类型与节点都是服务器报告的事实，
 * 这里不做任何型号推断，因此它保留结构化的两个字段，而不是一个自由文本框。
 */
export interface HwDeviceSetting {
  /** 设备类型，例如 qsv、vaapi、cuda。 */
  type: string;
  /** 设备节点，例如 /dev/dri/renderD129；留空表示交给 FFmpeg 自己挑。 */
  device: string;
}

export interface EncodeSettings {
  /** 命令行选项：选项名（不含 -）-> 取值。分节信息由界面按需查 cliHelp。 */
  cli: Record<string, CliValue>;
  /** 每类流的设置；没配置过的类别就是缺席，界面按空处理。 */
  streams: Record<string, StreamSetting>;
  hwDevice: HwDeviceSetting;
}

export const emptySettings: EncodeSettings = {
  cli: {},
  streams: {},
  hwDevice: { type: '', device: '' },
};

/**
 * 覆盖输出文件：`-y` 是 ffmpeg 的 Global options 之一，所以它是 cli 里的一个
 * 开关，而不是设置对象上一个自成一体的布尔字段。
 */
export function hasOverwrite(settings: EncodeSettings): boolean {
  return settings.cli.y !== undefined;
}

export function withOverwrite(settings: EncodeSettings, on: boolean): EncodeSettings {
  const cli = { ...settings.cli };
  if (on) {
    cli.y = { value: '', takesValue: false, position: 'global' };
  } else {
    delete cli.y;
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
function normalizeOptions(raw: unknown): Record<string, string> {
  if (!isRecord(raw)) {
    return {};
  }
  const out: Record<string, string> = {};
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

function normalizeCli(raw: unknown): Record<string, CliValue> {
  if (!isRecord(raw)) {
    return {};
  }
  const out: Record<string, CliValue> = {};
  for (const [name, value] of Object.entries(raw)) {
    if (!isRecord(value)) {
      continue;
    }
    out[name] = {
      value: stringOr(value.value),
      takesValue: typeof value.takesValue === 'boolean' ? value.takesValue : true,
      position: normalizePosition(value.position),
      spec: typeof value.spec === 'string' && value.spec !== '' ? value.spec : undefined,
    };
  }
  return out;
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
    out[spec] = { codec: stringOr(value.codec), options: normalizeOptions(value.options) };
  }
  return out;
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
  const hw = isRecord(record.hwDevice) ? record.hwDevice : {};
  const hwDevice = { type: stringOr(hw.type), device: stringOr(hw.device) };

  // 旧结构（编码器直接放在顶层，只有视频与音频两类）迁移过来。
  if (!isRecord(record.cli) && !isRecord(record.streams)) {
    return { ...fromLegacy(record), hwDevice };
  }

  return { cli: normalizeCli(record.cli), streams: normalizeStreams(record.streams), hwDevice };
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
      streams[spec] = { codec, options };
    }
  }
  return { cli: {}, streams, hwDevice: { type: '', device: '' } };
}

/* ---------------------------------------------------------------- argv */

export interface BuildRequest {
  input: string;
  output: string;
  settings: EncodeSettings;
  /** 手写补充参数，插在输出文件之前。 */
  extraArgs: string;
}

function appendOptions(args: string[], options: Record<string, string>): void {
  for (const [name, value] of Object.entries(options)) {
    const trimmed = value.trim();
    if (trimmed !== '') {
      args.push(`-${name}`, trimmed);
    }
  }
}

/**
 * 按 ffmpeg 的参数分层拼装：
 *
 *   全局选项 → 硬件设备 → 输入侧选项 → -i 输入 → 每类流的编码设置 →
 *   输出侧选项 → 手写补充参数 → 输出文件
 *
 * 这个层次不是一份手写的顺序表，而是「选项属于 ffmpeg 的哪一段」的直接结果：
 * 全局选项必须最先，输入侧选项必须早于它作用的输入，输出侧选项与流设置必须
 * 晚于输入、早于输出文件。
 *
 * `-hide_banner` 不在这里生成：服务器执行前会自己补上（见 internal/server 的
 * runJob），免得界面把一个纯日志开关当成转码设置。
 */
export function buildArgs({ input, output, settings, extraArgs }: BuildRequest): string[] {
  const args: string[] = [];

  appendCli(args, settings.cli, 'global');

  // 硬件设备是全局选项（-h full: "-init_hw_device <args> initialise hardware
  // device"）。它的值由类型与节点拼成，两者都取自服务器报告的事实。
  const hw = settings.hwDevice;
  if (hw.type !== '') {
    const device = hw.device.trim();
    args.push('-init_hw_device', device === '' ? `${hw.type}=hw` : `${hw.type}=hw:${device}`);
  }

  appendCli(args, settings.cli, 'input');
  args.push('-i', input);

  for (const [spec, stream] of Object.entries(settings.streams)) {
    if (stream.codec === '') {
      continue;
    }
    args.push(`-c:${spec}`, stream.codec);
    appendOptions(args, stream.options);
  }

  appendCli(args, settings.cli, 'output');
  args.push(...splitArgs(extraArgs));
  args.push(output);
  return args;
}

/**
 * 追加某一层的命令行选项。
 *
 * 按选项名排序后再输出，这样同一份设置永远生成同一个命令——预设才有可复现
 * 的意义，改动 diff 起来也不会因为对象键序而抖动。
 */
function appendCli(args: string[], cli: Record<string, CliValue>, position: CliPosition): void {
  const names = Object.keys(cli)
    .filter((name) => cli[name].position === position)
    .sort();

  for (const name of names) {
    const option = cli[name];
    // ffmpeg 允许这种选项带 `:<stream_spec>`（帮助原文里的 `[:<stream_spec>]`）。
    // 少了它，`-filter loudnorm=…` 会落到视频流上；`-filter:a` 才是本意。
    const flag = option.spec ? `${name}:${option.spec}` : name;
    if (option.takesValue) {
      if (option.value.trim() === '') {
        continue; // 需要取值却还空着：不生成半截参数
      }
      args.push(`-${flag}`, option.value.trim());
    } else {
      args.push(`-${flag}`);
    }
  }
}

/* ---------------------------------------------------------------- 文本 */

/**
 * 拆分手写命令行。
 *
 * 前端只用它做实时预览，因此对未闭合引号保持宽容；服务器端的实现会在
 * 真正执行前给出明确错误。
 */
export function splitArgs(input: string): string[] {
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

const NEEDS_QUOTE = /[\s\\"'$`;&|<>()*?[\]{}#!~]/;

/** 给单个参数加引号，保证拼出来的命令可以原样粘回终端。 */
export function quoteArg(value: string): string {
  if (value === '') {
    return "''";
  }
  if (!NEEDS_QUOTE.test(value)) {
    return value;
  }
  return `'${value.split("'").join("'\\''")}'`;
}

export function joinArgs(args: string[]): string {
  return args.map(quoteArg).join(' ');
}

/** 去掉用户可能连在一起粘贴过来的 ffmpeg/ffprobe 前缀。 */
export function stripToolPrefix(args: string[]): string[] {
  const first = args[0] ?? '';
  const isTool = first === 'ffmpeg' || first === 'ffprobe' || /(^|\/)(ffmpeg|ffprobe)$/.test(first);
  return isTool ? args.slice(1) : args;
}
