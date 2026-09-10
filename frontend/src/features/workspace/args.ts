/**
 * 拼装 ffmpeg 的 argv，以及预览用的命令行文本。
 *
 * 拆分/引号规则与后端 internal/ffmpeg 完全一致：界面上看到的参数切分，
 * 就是服务器最终执行的那一份，避免「预览对了、执行错了」。
 */

export interface EncodeSettings {
  videoCodec: string;
  audioCodec: string;
  /** 选项名 -> 值；空字符串表示「保持 ffmpeg 默认」。 */
  videoOptions: Record<string, string>;
  audioOptions: Record<string, string>;
  /** 硬件设备初始化；type 为空表示不初始化，交给 FFmpeg 默认行为。 */
  hwDevice: HwDeviceSetting;
}

/**
 * 一次硬件设备初始化，对应 `-init_hw_device <type>=hw[:<device>]`。
 *
 * type 来自 `ffmpeg -init_hw_device list`，device 来自服务器上真实存在的
 * render node——两者都是服务器报告的事实，这里不做任何型号推断。
 */
export interface HwDeviceSetting {
  /** 设备类型，例如 qsv、vaapi、cuda。 */
  type: string;
  /** 设备节点，例如 /dev/dri/renderD129；留空表示交给 FFmpeg 自己挑。 */
  device: string;
}

export const emptySettings: EncodeSettings = {
  videoCodec: '',
  audioCodec: '',
  videoOptions: {},
  audioOptions: {},
  hwDevice: { type: '', device: '' },
};

export interface BuildRequest {
  input: string;
  output: string;
  settings: EncodeSettings;
  /** 手写补充参数，插在输出文件之前。 */
  extraArgs: string;
  overwrite: boolean;
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
 * 按 ffmpeg 的参数顺序拼装：全局选项 → 输入 → 输出选项 → 输出文件。
 * 输出侧的编解码器与参数必须位于 -i 之后、输出文件之前，否则会被当成输入选项。
 */
export function buildArgs({ input, output, settings, extraArgs, overwrite }: BuildRequest): string[] {
  const args = ['-hide_banner'];
  if (overwrite) {
    args.push('-y');
  }

  // 硬件设备必须放在任何输入之前：它是全局选项，负责建立一个具名设备，
  // 后面的 -c:v 才可能引用它（-hwaccel 这类输入选项同理）。放到 -i 之后就晚了。
  //
  // 例外：-qsv_device 这类「设备路径」选项本身就是全局选项，位置不敏感，
  // 放在附加参数里同样能生效；但显式初始化设备仍然更可靠，尤其是多 GPU 时。
  const hw = settings.hwDevice;
  if (hw.type !== '') {
    const device = hw.device.trim();
    args.push('-init_hw_device', device === '' ? `${hw.type}=hw` : `${hw.type}=hw:${device}`);
  }

  args.push('-i', input);

  if (settings.videoCodec !== '') {
    args.push('-c:v', settings.videoCodec);
    appendOptions(args, settings.videoOptions);
  }
  if (settings.audioCodec !== '') {
    args.push('-c:a', settings.audioCodec);
    appendOptions(args, settings.audioOptions);
  }

  args.push(...splitArgs(extraArgs));
  args.push(output);
  return args;
}

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
