import { useState } from 'react';

import { api } from '../../api/client';
import type { FileEntry } from '../../api/types';
import { Button, TextInput } from '../../components/Controls';
import { EmptyState, ErrorNote, Spinner } from '../../components/Display';
import { Tabs } from '../../components/Tabs';
import { useAsync, useDebounced } from '../../hooks/useAsync';
import { useI18n } from '../../i18n/LocaleProvider';
import { cx, formatBytes } from '../../utils/format';
import styles from './FileBrowser.module.css';

export type PickMode = 'file' | 'dir';

/** 浏览器此刻在为哪个字段挑东西。 */
export interface PickScope {
  id: string;
  label: string;
}

interface FileBrowserProps {
  /** 当前选中的路径，用于高亮。 */
  value: string;
  /** 选中文件或切换目录时触发。 */
  onPick: (path: string) => void;
  /**
   * file：点文件才选中；dir：进入目录即选中（适合挑选输出目录）。
   */
  mode?: PickMode;
  /**
   * 这个浏览器在为哪几个字段挑东西；给了就在顶部显示一条切换条。
   *
   * 输入与输出各放一个浏览器，一屏里就有两个几乎一样的列表——既占地方，又容易
   * 点错（点了半天才发现写进了另一个字段）。一个浏览器换个目标用，谁在被挑就
   * 始终一清二楚。
   */
  scopes?: readonly PickScope[];
  scope?: string;
  onScopeChange?: (id: string) => void;
}

/**
 * 服务器文件浏览器。
 *
 * 目录结构完全由服务器返回（包括哪些根目录可用），浏览器不假设任何本地路径。
 * 进入目录就会把该目录作为选中值上报，因此「挑输出目录」不需要额外的按钮。
 */
export function FileBrowser({
  value,
  onPick,
  mode = 'file',
  scopes,
  scope,
  onScopeChange,
}: FileBrowserProps) {
  const { t } = useI18n();
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
      {scopes && scopes.length > 1 ? (
        <Tabs
          label={t('workspace.source.title')}
          value={scope ?? scopes[0].id}
          onChange={(next) => onScopeChange?.(next)}
          items={scopes.map((item) => ({ id: item.id, label: item.label }))}
        />
      ) : null}

      <div className={styles.toolbar}>
        <Button compact disabled={!data?.parent} onClick={() => data?.parent && setDir(data.parent)}>
          {t('file.up')}
        </Button>
        <Button compact variant="ghost" disabled={!dir} onClick={() => setDir('')}>
          {t('file.root')}
        </Button>
      </div>

      <p className={styles.location} title={data?.path || t('file.location.none')}>
        {data?.path || t('file.location.pick')}
      </p>

      <TextInput
        type="search"
        value={search}
        placeholder={t('file.filter')}
        aria-label={t('file.filter')}
        onChange={(event) => setSearch(event.target.value)}
      />

      {resource.loading ? <Spinner label={t('file.reading')} /> : null}
      {resource.error ? <ErrorNote>{resource.error}</ErrorNote> : null}

      {!resource.loading && entries.length === 0 ? (
        <EmptyState title={t('file.empty.title')} hint={t('file.empty.hint')} />
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
