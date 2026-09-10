import type {
  CommandPreview,
  FFHelp,
  FilesResponse,
  HardwareInfo,
  Health,
  HelpResponse,
  Job,
  LogLine,
  MediaInfo,
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
};

export type { FFHelp };
