import { useState } from 'react';

import { api } from '../../api/client';
import type { FileEntry } from '../../api/types';
import { Button, TextInput } from '../../components/Controls';
import { EmptyState, ErrorNote, Spinner } from '../../components/Display';
import { useAsync, useDebounced } from '../../hooks/useAsync';
import { cx, formatBytes } from '../../utils/format';
import styles from './FileBrowser.module.css';

export type PickMode = 'file' | 'dir';

interface FileBrowserProps {
  /** 当前选中的路径，用于高亮。 */
  value: string;
  /** 选中文件或切换目录时触发。 */
  onPick: (path: string) => void;
  /**
   * file：点文件才选中；dir：进入目录即选中（适合挑选输出目录）。
   */
  mode?: PickMode;
}

/**
 * 服务器文件浏览器。
 *
 * 目录结构完全由服务器返回（包括哪些根目录可用），浏览器不假设任何本地路径。
 * 进入目录就会把该目录作为选中值上报，因此「挑输出目录」不需要额外的按钮。
 */
export function FileBrowser({ value, onPick, mode = 'file' }: FileBrowserProps) {
  const [dir, setDir] = useState('');
  const [search, setSearch] = useState('');
  const query = useDebounced(search, 150).trim().toLowerCase();

  const resource = useAsync(() => api.files(dir === '' ? undefined : dir), [dir]);
  const data = resource.data;

  const entries = (data?.entries ?? []).filter((entry) =>
    query === '' ? true : entry.name.toLowerCase().includes(query),
  );

  const enter = (entry: FileEntry) => {
    if (entry.dir) {
      setDir(entry.path);
      setSearch('');
      if (mode === 'dir') onPick(entry.path);
      return;
    }
    onPick(entry.path);
  };

  return (
    <div className={styles.browser}>
      <div className={styles.toolbar}>
        <Button compact disabled={!data?.parent} onClick={() => data?.parent && setDir(data.parent)}>
          ↑ 上一级
        </Button>
        <Button compact variant="ghost" disabled={!dir} onClick={() => setDir('')}>
          根目录
        </Button>
      </div>

      <p className={styles.location} title={data?.path || '未选择目录'}>
        {data?.path || '选择要浏览的位置'}
      </p>

      <TextInput
        type="search"
        value={search}
        placeholder="按名称过滤"
        aria-label="按名称过滤"
        onChange={(event) => setSearch(event.target.value)}
      />

      {resource.loading ? <Spinner label="读取目录" /> : null}
      {resource.error ? <ErrorNote>{resource.error}</ErrorNote> : null}

      {!resource.loading && entries.length === 0 ? (
        <EmptyState title="这个目录里没有可显示的条目" hint="隐藏文件与子目录之外的内容都会被列出。" />
      ) : null}

      <ul className={styles.entries}>
        {entries.map((entry) => (
          <li key={entry.path}>
            <button
              type="button"
              className={cx(styles.entry, value === entry.path && styles.selected)}
              onClick={() => enter(entry)}
              title={entry.path}
            >
              <span className={styles.icon} aria-hidden="true">
                {entry.dir ? '▸' : '·'}
              </span>
              <span className={styles.name}>{entry.name}</span>
              <span className={styles.size}>{entry.dir ? '' : formatBytes(entry.size)}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
