import type {
  CliHelp,
  CommandPreview,
  ConfigInfo,
  ExtensionsResult,
  FFHelp,
  FilesResponse,
  HardwareInfo,
  Health,
  HelpResponse,
  Job,
  LogLine,
  MediaInfo,
  PresetListResponse,
  PresetRecord,
  ScanResponse,
  Snapshot,
} from './types';

/** 后端返回的错误体是 { error: string }，这里统一成一种异常。 */
export class ApiError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, init);
  const raw = await response.text();

  let payload: unknown = null;
  if (raw) {
    try {
      payload = JSON.parse(raw);
    } catch {
      payload = raw;
    }
  }

  if (!response.ok) {
    const message =
      payload && typeof payload === 'object' && 'error' in payload
        ? String((payload as { error: unknown }).error)
        : `${response.status} ${response.statusText}`;
    throw new ApiError(message, response.status);
  }
  return payload as T;
}

const jsonPost = (body: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

const query = (params: Record<string, string | undefined>): string => {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== '') {
      search.set(key, value);
    }
  }
  const text = search.toString();
  return text ? `?${text}` : '';
};

export const api = {
  health: () => request<Health>('/api/health'),

  /** 读取服务器上 FFmpeg 的完整能力。 */
  snapshot: () => request<Snapshot>('/api/ffmpeg'),

  /** 让服务器重新查询 FFmpeg（换了版本之后用）。 */
  refreshSnapshot: () => request<Snapshot>('/api/ffmpeg/refresh', { method: 'POST' }),

  /**
   * ffmpeg 自己的命令行拓扑（分节 → 选项）。
   *
   * 界面的控件结构直接跟着它走：有哪些段、每段有哪些选项、哪个选项要取值，
   * 全部由 ffmpeg 决定，程序不维护自己的选项表。
   */
  cli: (level = 'long') => request<CliHelp>(`/api/ffmpeg/cli${query({ level })}`),

  /**
   * ffmpeg 自己声明的文件扩展名。
   *
   * 输入侧用 demuxer、输出侧用 muxer：两侧能读能写的格式并不相同。
   */
  extensions: (target: 'demuxer' | 'muxer') =>
    request<ExtensionsResult>(`/api/ffmpeg/extensions${query({ target })}`),

  /**
   * 读取某个组件的 ffmpeg -h。
   *
   * 目标不存在时后端返回 200 并在 body 里带 error，因为 ffmpeg 的原始
   * 输出比一句「查询失败」有用得多，这里照原样交给界面展示。
   */
  help: (target: string, name: string) =>
    request<HelpResponse>(`/api/ffmpeg/help${query({ target, name })}`).then(
      (response): HelpResponse => response ?? {},
    ),

  probe: (path: string) => request<MediaInfo>(`/api/probe${query({ path })}`),

  files: (path?: string) => request<FilesResponse>(`/api/files${query({ path })}`),

  hardware: () => request<HardwareInfo>('/api/hardware'),

  /** 把 argv 或手写文本变成最终命令；两种输入都由服务器解释。 */
  command: (input: { args: string[] } | { text: string }) =>
    request<CommandPreview>('/api/command', jsonPost(input)),

  jobs: () => request<Job[]>('/api/jobs'),

  createJob: (body: { input: string; output: string; args: string[]; label?: string }) =>
    request<Job>('/api/jobs', jsonPost(body)),

  cancelJob: (id: string) => request<unknown>(`/api/jobs/${encodeURIComponent(id)}/cancel`, { method: 'POST' }),

  retryJob: (id: string) => request<Job>(`/api/jobs/${encodeURIComponent(id)}/retry`, { method: 'POST' }),

  deleteJob: (id: string) =>
    request<unknown>(`/api/jobs/${encodeURIComponent(id)}`, { method: 'DELETE' }),

  clearFinished: () => request<{ removed: number }>('/api/jobs/clear', { method: 'POST' }),

  jobLog: (id: string) =>
    request<{ id: string; lines: LogLine[] }>(`/api/jobs/${encodeURIComponent(id)}/log`),

  /** 本次运行的生效设置，以及每一项的来源。 */
  config: () => request<ConfigInfo>('/api/config'),

  /** 递归列出一个目录下的媒体候选文件。 */
  scan: (path: string, ext = '', limit?: number) =>
    request<ScanResponse>(`/api/files/scan${query({ path, ext, limit: limit?.toString() })}`),

  /** 创建输出目录（含父目录）；批量任务还原目录结构时用。 */
  createDirs: (dirs: string[]) =>
    request<{ created: number; existing: number }>('/api/dirs', jsonPost({ dirs })),

  presets: () => request<PresetListResponse>('/api/presets'),

  readPreset: (name: string) => request<PresetRecord>(`/api/presets/${encodeURIComponent(name)}`),

  /** 覆盖保存一份预设（PUT 语义：这个名字现在就是这份配方）。 */
  savePreset: (name: string, recipe: unknown) =>
    request<PresetRecord>(`/api/presets/${encodeURIComponent(name)}`, {
      ...jsonPost({ recipe }),
      method: 'PUT',
    }),

  deletePreset: (name: string) =>
    request<unknown>(`/api/presets/${encodeURIComponent(name)}`, { method: 'DELETE' }),
};

export type { FFHelp };
