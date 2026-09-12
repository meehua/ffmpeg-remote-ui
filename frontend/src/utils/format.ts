/** 拼接类名，忽略空值。 */
export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ');
}

/**
 * 判断一个来自 JSON 的值是不是普通对象。
 *
 * 存档、预设与接口响应都是从外部读进来的，用它可以先把「形状不对」的情况
 * 挡在外面，后面的字段读取就不必层层判空。
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 1536 → "1.5 KB"，用于展示文件大小与码率。 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** exponent;
  return `${value >= 100 || exponent === 0 ? Math.round(value) : value.toFixed(1)} ${units[exponent]}`;
}

/** 3725 → "1:02:05"，用于展示媒体时长。 */
export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '—';
  const total = Math.round(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

/** ffprobe 的数值字段都是字符串，这里统一解析。 */
export function toNumber(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number.parseFloat(String(value ?? ''));
  return Number.isFinite(parsed) ? parsed : 0;
}

// 服务器的路径在 Windows 上用反斜杠，而界面里到处都在取文件名、比前缀。
// 这些地方因此要同时认两种分隔符，否则 Windows 上 baseName 会把整条路径原样返回。

/** 只取路径的最后一段，用于列表里显示文件名。 */
export function baseName(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, '');
  const index = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
  return index >= 0 ? trimmed.slice(index + 1) : path;
}

/** 目录路径，与 baseName 配套。 */
export function dirName(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, '');
  const index = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
  return index > 0 ? trimmed.slice(0, index) : '/';
}

/**
 * path 在 root 之下时返回相对 root 的那一段（保留原分隔符），否则返回 null。
 *
 * 两种分隔符都认，理由同上：只按 `/` 判断的话，「还原原目录结构」在 Windows 上
 * 会一声不响地退化成平铺，而且从界面上看不出哪里错了。
 */
export function relativeTo(path: string, root: string): string | null {
  const base = root.replace(/[\\/]+$/, '');
  if (base === '' || path.slice(0, base.length) !== base) {
    return null;
  }
  const separator = path[base.length];
  if (separator !== '/' && separator !== '\\') {
    return null;
  }
  return path.slice(base.length + 1);
}
