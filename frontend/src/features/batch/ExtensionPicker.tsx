import { useMemo, useState } from 'react';

import { api } from '../../api/client';
import { Button, ButtonRow, TextInput } from '../../components/Controls';
import { ErrorNote, Spinner } from '../../components/Display';
import { useAsync, useDebounced } from '../../hooks/useAsync';
import { cx } from '../../utils/format';
import styles from './ExtensionPicker.module.css';

/** 把逗号/空白分隔的取值拆成小写扩展名列表。 */
export function parseExtensions(value: string): string[] {
  return value
    .split(/[,;\s]+/)
    .map((item) => item.trim().toLowerCase().replace(/^\./, ''))
    .filter((item) => item !== '');
}

/** 去重后拼回逗号分隔的取值，顺序稳定，便于人读也便于 diff。 */
export function joinExtensions(items: Iterable<string>): string {
  return [...new Set(items)].sort().join(', ');
}

interface ExtensionPickerProps {
  /** 数据来源方向：输入侧看 demuxer，输出侧看 muxer。 */
  target: 'demuxer' | 'muxer';
  /** 当前取值（逗号分隔）。 */
  value: string;
  onChange: (value: string) => void;
}

/**
 * 扩展名选择面板。
 *
 * 候选列表整份来自 ffmpeg：输入侧是 demuxer 的 `Common extensions`，输出侧是
 * muxer 的。程序里没有「常见格式」这种表——那正是只能由 ffmpeg 回答的问题。
 * 因此列表里会出现一些冷门扩展名，配合搜索用就好。
 */
export function ExtensionPicker({ target, value, onChange }: ExtensionPickerProps) {
  const list = useAsync(() => api.extensions(target), [target]);
  const [search, setSearch] = useState('');
  const query = useDebounced(search, 150).trim().toLowerCase();

  const selected = useMemo(() => new Set(parseExtensions(value)), [value]);
  const all = list.data?.extensions ?? [];
  const visible = query === '' ? all : all.filter((ext) => ext.includes(query));

  const toggle = (ext: string) => {
    const next = new Set(selected);
    if (next.has(ext)) {
      next.delete(ext);
    } else {
      next.add(ext);
    }
    onChange(joinExtensions(next));
  };

  return (
    <details className={styles.picker}>
      <summary className={styles.summary}>
        <span>{target === 'demuxer' ? '从 ffmpeg 选择输入扩展名' : '从 ffmpeg 选择输出扩展名'}</span>
        <span className={styles.meta}>
          {list.loading ? '读取中…' : `已选 ${selected.size} / ${all.length}`}
        </span>
      </summary>

      <div className={styles.body}>
        {list.error ? <ErrorNote>{list.error}</ErrorNote> : null}
        {list.loading ? <Spinner label="汇总 ffmpeg 报告的扩展名" /> : null}

        {all.length > 0 ? (
          <>
            <p className={styles.note}>
              列表来自 ffmpeg 在 {target} 帮助里写的 Common extensions。
              「全部」只勾选当前筛选出来的 {visible.length} 个，不会把整张表一次性选中。
            </p>

            <TextInput
              type="search"
              value={search}
              placeholder="筛选扩展名"
              aria-label="筛选扩展名"
              onChange={(event) => setSearch(event.target.value)}
            />

            <ButtonRow>
              <Button
                compact
                disabled={visible.length === 0}
                onClick={() => onChange(joinExtensions([...selected, ...visible]))}
              >
                全部（勾选当前 {visible.length} 个）
              </Button>
              <Button compact variant="ghost" onClick={() => onChange('')}>
                清空
              </Button>
            </ButtonRow>

            <ul className={styles.list}>
              {visible.map((ext) => (
                <li key={ext}>
                  <label className={cx(styles.item, selected.has(ext) && styles.itemOn)}>
                    <input type="checkbox" checked={selected.has(ext)} onChange={() => toggle(ext)} />
                    <span>{ext}</span>
                  </label>
                </li>
              ))}
            </ul>
          </>
        ) : null}
      </div>
    </details>
  );
}
