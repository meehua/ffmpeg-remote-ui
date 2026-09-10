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

/** -h 查询失败时后端仍会带上原始输出，方便直接展示 ffmpeg 的抱怨。 */
export interface HelpResponse {
  error?: string;
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
  driver?: string;
  vendor?: string;
  deviceId?: string;
  pciAddress?: string;
  properties?: Record<string, string>;
}

export interface HardwareInfo {
  os: string;
  arch: string;
  devices: GpuDevice[];
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
