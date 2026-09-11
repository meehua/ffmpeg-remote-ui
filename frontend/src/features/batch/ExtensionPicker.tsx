import { useMemo, useState } from 'react';

import { api } from '../../api/client';
import { Button, ButtonRow, TextInput } from '../../components/Controls';
import { ErrorNote, Spinner } from '../../components/Display';
import { useAsync, useDebounced } from '../../hooks/useAsync';
import { useI18n } from '../../i18n/LocaleProvider';
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
  const { t } = useI18n();
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
        <span>{target === 'demuxer' ? t('ext.summary.input') : t('ext.summary.output')}</span>
        <span className={styles.meta}>
          {list.loading
            ? t('common.reading')
            : t('ext.selected', { selected: selected.size, total: all.length })}
        </span>
      </summary>

      <div className={styles.body}>
        {list.error ? <ErrorNote>{list.error}</ErrorNote> : null}
        {list.loading ? <Spinner label={t('ext.loading')} /> : null}

        {all.length > 0 ? (
          <>
            <p className={styles.note}>
              {t('ext.note', { target, visible: visible.length })}
            </p>

            <TextInput
              type="search"
              value={search}
              placeholder={t('ext.filter')}
              aria-label={t('ext.filter')}
              onChange={(event) => setSearch(event.target.value)}
            />

            <ButtonRow>
              <Button
                compact
                disabled={visible.length === 0}
                onClick={() => onChange(joinExtensions([...selected, ...visible]))}
              >
                {t('ext.selectAll', { visible: visible.length })}
              </Button>
              <Button compact variant="ghost" onClick={() => onChange('')}>
                {t('ext.clear')}
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
