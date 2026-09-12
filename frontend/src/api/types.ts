/**
 * 与后端 JSON 一一对应的类型。
 *
 * 这里刻意不引入任何生成器：接口很窄，手写类型比维护一套代码生成更直接，
 * 也更容易在这里写清楚「哪些字段是 FFmpeg 原样给出的」。
 */

/* ---------------------------------------------------------------- 能力快照 */

/** FFmpeg 列表型输出（-encoders/-filters/...）中的一行。 */
export interface FFItem {
  flags?: string;
  name: string;
  description?: string;
  /** 名称之后按原顺序保留的列。 */
  columns?: string[];
  /** 已标注语义的列，例如滤镜的 io、像素格式的 bitsPerPixel。 */
  extra?: Record<string, unknown>;
}

/** 某一时刻 FFmpeg 暴露的全部能力。 */
export interface Snapshot {
  generatedAt: string;
  ffmpegPath: string;
  ffprobePath: string;
  version: string;
  buildConfig: string;
  hwaccels: string[];
  /** `ffmpeg -init_hw_device list`：这套 FFmpeg 支持的硬件设备类型。 */
  hwDeviceTypes: string[];
  encoders: FFItem[];
  decoders: FFItem[];
  filters: FFItem[];
  formats: FFItem[];
  muxers: FFItem[];
  demuxers: FFItem[];
  bitstreamFilters: FFItem[];
  protocols: FFItem[];
  devices: FFItem[];
  pixelFormats: FFItem[];
  sampleFormats: FFItem[];
  layouts: FFItem[];
  colors: FFItem[];
  dispositions: FFItem[];
}

/* ---------------------------------------------------------------- -h 结构 */

export type OptionScope = 'encoding' | 'decoding' | 'shared';
export type OptionMedia = 'video' | 'audio' | 'subtitle' | 'data';

export interface FFOptionValue {
  name: string;
  value?: string;
  description?: string;
}

/** 单个 AVOption，取值、默认值、都来自 ffmpeg -h。 */
export interface FFOption {
  name: string;
  type?: string;
  flags?: string;
  scope?: OptionScope;
  media?: OptionMedia;
  runtime?: boolean;
  perStream?: boolean;
  description?: string;
  hasDefault?: boolean;
  default?: string;
  range?: string;
  min?: string;
  max?: string;
  unit?: string;
  values?: FFOptionValue[];
}

export interface FFSection {
  name: string;
  options: FFOption[];
}

export interface FFStreamPort {
  index: number;
  name?: string;
  media?: string;
  note?: string;
}

export interface FFProperty {
  name: string;
  value: string;
}

export interface FFHelp {
  target: string;
  name: string;
  kind?: string;
  title?: string;
  summary?: string;
  properties?: FFProperty[];
  capabilities?: string[];
  threading?: string[];
  pixelFormats?: string[];
  sampleFormats?: string[];
  codecs?: string[];
  frameRates?: string[];
  inputs?: FFStreamPort[];
  outputs?: FFStreamPort[];
  sections?: FFSection[];
  options?: FFOption[];
  raw: string;
}

/* ------------------------------------------------------------ 错误与警告 */

/** 供界面插值的参数；与后端 apierr 的 Params 一一对应。 */
export type ErrorParams = Record<string, string | number>;

/**
 * 一条不阻断主流程的提示（坏掉的预设文件、被忽略的配置项）。
 *
 * 与错误同构：后端只给码与参数，用哪种语言说由界面决定；message 是兜底原文。
 */
export interface ApiWarning {
  code: string;
  params?: ErrorParams;
  message?: string;
}

/** -h 查询失败时后端仍会带上原始输出，方便直接展示 ffmpeg 的抱怨。 */
export interface HelpResponse {
  error?: string;
  /** 带码时的错误标识（见 internal/apierr）；没有码就只能显示 error。 */
  code?: string;
  params?: ErrorParams;
  help?: FFHelp;
}

/* ---------------------------------------------------------------- ffprobe */

export interface FfprobeStream {
  index: number;
  codec_name?: string;
  codec_long_name?: string;
  codec_type?: string;
  profile?: string;
  width?: number;
  height?: number;
  pix_fmt?: string;
  sample_rate?: string;
  channels?: number;
  channel_layout?: string;
  bit_rate?: string;
  duration?: string;
  avg_frame_rate?: string;
  r_frame_rate?: string;
  nb_frames?: string;
  tags?: Record<string, string>;
}

export interface FfprobeFormat {
  format_name?: string;
  format_long_name?: string;
  start_time?: string;
  duration?: string;
  size?: string;
  bit_rate?: string;
  nb_streams?: number;
  tags?: Record<string, string>;
}

export interface MediaInfo {
  streams: FfprobeStream[];
  format: FfprobeFormat;
}

/* ---------------------------------------------------------------- 任务 */

export type JobStatus = 'queued' | 'running' | 'done' | 'failed' | 'cancelled';

export interface Job {
  id: string;
  label?: string;
  input: string;
  output: string;
  args: string[];
  command: string;
  status: JobStatus;
  /** 0-100；无法估算比例时保持 0。 */
  progress: number;
  /** 阶段码（probe / transcode），来自服务器；显示文案由界面查表。 */
  phase?: string;
  /** 排队位置，0 表示不在排队中。 */
  position: number;
  durationMs?: number;
  outTimeMs?: number;
  frame?: number;
  fps?: number;
  speed?: string;
  bitrate?: string;
  totalSize?: number;
  attempts: number;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  error?: string;
  /** 带码的失败原因；事件流是单向推送，所以码挂在任务对象本身。 */
  errorCode?: string;
  errorParams?: ErrorParams;
}

export interface LogLine {
  jobId: string;
  seq: number;
  line: string;
}

/* ---------------------------------------------------------------- 文件与硬件 */

export interface FileEntry {
  name: string;
  path: string;
  dir: boolean;
  size: number;
  modTime: string;
  ext?: string;
}

export interface FilesResponse {
  path: string;
  parent?: string;
  roots: string[];
  entries: FileEntry[];
}

export interface GpuDevice {
  id: string;
  renderNode?: string;
  cardNode?: string;
  sysfsPath?: string;
  /**
   * 这个设备**自己名字里**能直接当 `-init_hw_device <type>=hw:<node>` 用的那一段，
   * 只在系统给出确定名字时才有（Linux 的 DRM 节点路径）。Windows 上的显示适配器
   * 只有注册表子键序号，与 FFmpeg 认的适配器序号不是同一套编号，所以那边为空。
   *
   * 它是「可以拿来试的值」，不是「该填的值」：同一个值在不同类型里的含义由 FFmpeg
   * 解释，能不能用一律以实测结果为准。
   */
  hwNode?: string;
  driver?: string;
  vendor?: string;
  deviceId?: string;
  /** 来自系统 PCI ID 数据库的厂商名，仅用于显示；查不到时为空。 */
  vendorName?: string;
  /** 来自系统 PCI ID 数据库的型号名，仅用于显示；查不到时为空。 */
  deviceName?: string;
  pciAddress?: string;
  properties?: Record<string, string>;
}

export interface HardwareInfo {
  os: string;
  arch: string;
  devices: GpuDevice[];
}

/**
 * 一次「这个类型配这个设备值能不能用」的实测结果。
 *
 * 判断依据是服务器真的初始化了一次设备，所以它回答的正是「本机能不能用」——
 * 这是程序无从推断、只有 FFmpeg 自己知道的事。
 */
export interface HWProbe {
  type: string;
  /** 被实测的设备值；空串表示不指定节点。 */
  node: string;
  ok: boolean;
  /**
   * FFmpeg 自己说的「这个值落在了哪块设备上」，界面靠它回答「0 是哪块卡」。
   *
   * 取自 FFmpeg 的 `Using device 8086:9a60 (Intel(R) UHD Graphics).` 那一行，
   * 只搬 `Using device ` 之后那段。有些类型不打印这行（cuda 就是），那就为空。
   */
  device?: string;
  /** 这次初始化最后落下的一句话，失败时它就是原因本身（"Error creating a MFX session: -9."）。 */
  note?: string;
  /**
   * FFmpeg 就这次初始化说过的话（原样截取，成功也给），界面收在「原文」里。
   *
   * 它是 device / note 的来源，也是它们取不到时的退路。程序不翻译这些行。
   */
  output?: string;
  /** 失败时 FFmpeg 自己的报错原文。 */
  error?: string;
}

export interface HWProbeResponse {
  type: string;
  results: HWProbe[];
}

export interface Health {
  ok: boolean;
  go: string;
  os: string;
  arch: string;
  time: string;
  maxParallel: number;
}

export interface CommandPreview {
  args: string[];
  command: string;
}

/* ---------------------------------------------------------------- 运行时设置 */

/** 每个设置的来源：环境变量 / 配置文件 / 内置默认值。 */
export type ConfigSource = 'env' | 'file' | 'default';

/** 一次运行的生效设置。 */
export interface RuntimeConfig {
  httpAddr: string;
  /** 允许访问的媒体根目录；为空表示不限制。 */
  mediaRoots: string[];
  ffmpegPath: string;
  ffprobePath: string;
  maxConcurrentJobs: number;
}

export interface ConfigInfo {
  /** 配置文件路径；拿不到用户配置目录时为空。 */
  path: string;
  /** 预设目录，和配置文件在同一个父目录下。 */
  presetsDir: string;
  /** 本次运行是否新建了配置文件。 */
  created: boolean;
  values: RuntimeConfig;
  /** 字段名 -> 来源。 */
  sources: Record<string, ConfigSource>;
  /** 需要让用户知道但不致命的问题。 */
  warnings?: ApiWarning[];
}

/* ---------------------------------------------------------------- 预设 */

export interface PresetMeta {
  name: string;
  updatedAt: string;
  size: number;
}

export interface PresetListResponse {
  /** 预设目录的绝对路径。 */
  dir: string;
  items: PresetMeta[];
  /** 目录里读不动的文件；只提示，不影响其余预设。 */
  warnings?: ApiWarning[];
}

/** 一份预设；recipe 的结构由前端定义（见 features/presets/recipe.ts）。 */
export interface PresetRecord {
  name: string;
  updatedAt: string;
  recipe: unknown;
}

/* ---------------------------------------------------------------- 目录扫描 */

export interface ScanFile {
  path: string;
  /** 相对扫描根的路径，用于在输出目录里还原目录结构。 */
  rel: string;
  size: number;
  modTime: string;
  ext?: string;
}

export interface ScanResponse {
  root: string;
  files: ScanFile[];
  /** 本次生效的扩展名过滤；为空表示不过滤。 */
  exts: string[] | null;
  /** 过滤前见过的普通文件数。 */
  visited: number;
  /** 读不了而跳过的条目数。 */
  skipped: number;
  /** 达到上限、还有文件没收进来。 */
  truncated: boolean;
  limit: number;
}

/* ---------------------------------------------------------------- 命令行拓扑 */

/**
 * ffmpeg 命令行上一个选项的元信息，全部来自 `ffmpeg -h`。
 *
 * 界面据此决定控件形态与插入位置，因此这里不需要、也不允许有本程序自己
 * 维护的选项表。
 */
export interface CliOption {
  /** 不含前导 "-"，与 ffmpeg 输出一致。 */
  name: string;
  /** ffmpeg 允许它带 `:<stream_spec>` 后缀。 */
  streamSpec?: boolean;
  /** 需要取值；没有占位符的就是开关型选项。 */
  takesValue?: boolean;
  /** ffmpeg 给出的占位符原文，例如 `<time_off>`。 */
  placeholder?: string;
  description?: string;
}

/** 作用范围，由 ffmpeg 写在分节标题里的措辞推出来。 */
export type CliScope = 'global' | 'input' | 'output' | 'both' | 'stream' | 'other';

export interface CliSection {
  /** ffmpeg 的原文标题，例如 "Advanced per-file options (input-only)"。 */
  name: string;
  scope: CliScope;
  /** 媒体类型（video/audio/subtitle/data）；通用分节没有。 */
  media?: string;
  /** 媒体类型的流定位符（v/a/s/d）。 */
  spec?: string;
  options: CliOption[];
}

/** `ffmpeg -h [level]` 的结构化结果：ffmpeg 命令行本身的拓扑。 */
export interface CliHelp {
  level: string;
  sections: CliSection[];
  raw: string;
}

/**
 * ffmpeg 自己声明的文件扩展名汇总。
 *
 * 输入侧取 demuxer（能读什么），输出侧取 muxer（能写什么）。这份列表里
 * 不会出现本程序写进去的扩展名——它整份来自 `ffmpeg -h <target>=<name>`
 * 里的 "Common extensions"。
 */
export interface ExtensionsResult {
  target: string;
  extensions: string[];
  /** 该方向上的组件总数，以及其中报了扩展名的数量。 */
  components: number;
  withExtensions: number;
}
