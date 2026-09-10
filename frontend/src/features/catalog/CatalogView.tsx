import { useMemo, useState } from 'react';

import { api } from '../../api/client';
import type { FFOption, FFItem, Snapshot } from '../../api/types';
import { Button, TextInput } from '../../components/Controls';
import { Badge, DataList, EmptyState, ErrorNote, Spinner } from '../../components/Display';
import { Pane, Panes } from '../../components/Pane';
import { Tabs } from '../../components/Tabs';
import { useAsync, useDebounced } from '../../hooks/useAsync';
import styles from './CatalogView.module.css';

type CatalogKey =
  | 'encoders'
  | 'decoders'
  | 'filters'
  | 'formats'
  | 'muxers'
  | 'demuxers'
  | 'bitstreamFilters'
  | 'protocols'
  | 'devices'
  | 'pixelFormats'
  | 'sampleFormats'
  | 'layouts'
  | 'colors'
  | 'dispositions';

type CategoryKey = CatalogKey | 'hwaccels';

interface Category {
  key: CategoryKey;
  label: string;
  /** 对应的 `ffmpeg -h` 目标；为空表示这类条目没有独立帮助。 */
  target?: string;
}

const CATEGORIES: ReadonlyArray<Category> = [
  { key: 'encoders', label: '编码器', target: 'encoder' },
  { key: 'decoders', label: '解码器', target: 'decoder' },
  { key: 'filters', label: '滤镜', target: 'filter' },
  { key: 'muxers', label: '封装', target: 'muxer' },
  { key: 'demuxers', label: '解封装', target: 'demuxer' },
  { key: 'bitstreamFilters', label: '码流滤镜', target: 'bsf' },
  { key: 'protocols', label: '协议', target: 'protocol' },
  { key: 'devices', label: '设备', target: 'device' },
  { key: 'hwaccels', label: '硬件加速' },
  { key: 'pixelFormats', label: '像素格式' },
  { key: 'sampleFormats', label: '采样格式' },
  { key: 'layouts', label: '声道布局' },
  { key: 'colors', label: '颜色名' },
  { key: 'dispositions', label: '流处置' },
  { key: 'formats', label: '容器格式' },
];

function itemsOf(snapshot: Snapshot, key: CategoryKey): FFItem[] {
  if (key === 'hwaccels') {
    return snapshot.hwaccels.map((name) => ({ name }));
  }
  return snapshot[key] as FFItem[];
}

interface CatalogViewProps {
  snapshot: Snapshot | null;
  onRefresh: () => Promise<void>;
  refreshing: boolean;
}

/**
 * 能力浏览。
 *
 * 这里展示的每一项都是服务器 FFmpeg 自己报告的，点开还能看到 `-h` 的
 * 结构化结果与原始文本——「FFmpeg 是能力的唯一事实来源」在这个页面上
 * 是可验证的，而不是一句口号。
 */
export function CatalogView({ snapshot, onRefresh, refreshing }: CatalogViewProps) {
  const [categoryKey, setCategoryKey] = useState<CategoryKey>('encoders');
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<{ target: string; name: string } | null>(null);

  const query = useDebounced(search, 150).trim().toLowerCase();

  const category = CATEGORIES.find((item) => item.key === categoryKey) ?? CATEGORIES[0];
  const all = useMemo(
    () => (snapshot ? itemsOf(snapshot, categoryKey) : []),
    [snapshot, categoryKey],
  );

  const entries = useMemo(() => {
    if (query === '') return all;
    return all.filter(
      (item) =>
        item.name.toLowerCase().includes(query) ||
        (item.description ?? '').toLowerCase().includes(query),
    );
  }, [all, query]);

  if (!snapshot) {
    return (
      <Panes columns={1}>
        <Pane title="能力" description="等待服务器返回 FFmpeg 能力。">
          <Spinner label="读取中" />
        </Pane>
      </Panes>
    );
  }

  return (
    <Panes columns={2}>
      <Pane
        title="能力清单"
        description="列表直接来自服务器的 ffmpeg，程序不内置任何能力表。"
        actions={
          <Button compact variant="ghost" disabled={refreshing} onClick={() => void onRefresh()}>
            {refreshing ? '重新查询中…' : '重新查询'}
          </Button>
        }
      >
        <Tabs
          label="能力类别"
          value={categoryKey}
          onChange={(next) => {
            setCategoryKey(next);
            setSelected(null);
          }}
          items={CATEGORIES.map((item) => ({
            id: item.key,
            label: item.label,
            count: itemsOf(snapshot, item.key).length,
          }))}
        />

        <TextInput
          type="search"
          value={search}
          placeholder={`在「${category.label}」中搜索`}
          aria-label="搜索能力"
          onChange={(event) => setSearch(event.target.value)}
        />

        <p className={styles.count}>
          {entries.length} / {all.length} 项
        </p>

        {entries.length === 0 ? (
          <EmptyState title="没有匹配的条目" />
        ) : (
          <ul className={styles.list}>
            {entries.map((item) => {
              const active = selected?.name === item.name && selected.target === category.target;
              return (
                <li key={item.name}>
                  <button
                    type="button"
                    className={active ? `${styles.entry} ${styles.entryActive}` : styles.entry}
                    disabled={!category.target}
                    onClick={() =>
                      category.target ? setSelected({ target: category.target, name: item.name }) : undefined
                    }
                  >
                    <span className={styles.entryName}>{item.name}</span>
                    {item.flags ? <span className={styles.flags}>{item.flags}</span> : null}
                    <span className={styles.entryDesc}>{item.description ?? ''}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </Pane>

      <Pane
        title="条目详情"
        description="展开自 ffmpeg -h；参数的类型、默认值与取值范围都是 FFmpeg 给出的。"
      >
        {selected ? (
          <HelpPanel target={selected.target} name={selected.name} />
        ) : (
          <EmptyState
            title="还没有选中条目"
            hint="在左侧点一个编码器、滤镜或封装格式，这里会列出它的全部参数。"
          />
        )}
      </Pane>
    </Panes>
  );
}

/* ---------------------------------------------------------------- 详情 */

function HelpPanel({ target, name }: { target: string; name: string }) {
  const resource = useAsync(() => api.help(target, name), [target, name]);
  const payload = resource.data;
  const help = payload?.help;

  if (resource.loading) {
    return <Spinner label="读取 ffmpeg -h" />;
  }
  if (resource.error) {
    return <ErrorNote>{resource.error}</ErrorNote>;
  }
  if (!help) {
    return <EmptyState title="没有返回内容" />;
  }

  const facts: Array<{ label: string; value: string }> = [];
  for (const property of help.properties ?? []) {
    facts.push({ label: property.name, value: property.value });
  }
  if (help.inputs?.length) {
    facts.push({
      label: '输入端口',
      value: help.inputs.map((port) => `${port.name ?? '?'}（${port.media ?? '不限'}）`).join('、'),
    });
  }
  if (help.outputs?.length) {
    facts.push({
      label: '输出端口',
      value: help.outputs.map((port) => `${port.name ?? '?'}（${port.media ?? '不限'}）`).join('、'),
    });
  }
  if (help.capabilities?.length) {
    facts.push({ label: '通用能力', value: help.capabilities.join('、') });
  }
  if (help.threading?.length) {
    facts.push({ label: '多线程', value: help.threading.join('、') });
  }
  if (help.codecs?.length) {
    facts.push({ label: '支持编解码', value: help.codecs.join('、') });
  }
  if (help.sampleFormats?.length) {
    facts.push({ label: '采样格式', value: help.sampleFormats.join(' ') });
  }

  return (
    <div className={styles.help}>
      {payload?.error ? <ErrorNote>{payload.error}</ErrorNote> : null}

      <header className={styles.helpHead}>
        <h3 className={styles.helpTitle}>{help.title ?? `${target}: ${name}`}</h3>
        {help.kind ? <Badge tone="accent">{help.kind}</Badge> : null}
      </header>

      {help.summary ? <p className={styles.helpSummary}>{help.summary}</p> : null}
      {facts.length > 0 ? <DataList dense items={facts} /> : null}

      {help.pixelFormats?.length ? (
        <section className={styles.helpSection}>
          <h4 className={styles.helpSectionTitle}>支持的像素格式</h4>
          <div className={styles.chips}>
            {help.pixelFormats.map((format) => (
              <Badge key={format} mono>
                {format}
              </Badge>
            ))}
          </div>
        </section>
      ) : null}

      {(help.sections ?? []).map((section) => (
        <section className={styles.helpSection} key={section.name}>
          <h4 className={styles.helpSectionTitle}>
            {section.name}
            <span className={styles.helpSectionCount}>{section.options.length} 个参数</span>
          </h4>
          <ul className={styles.optionList}>
            {section.options.map((option) => (
              <li key={option.name}>
                <OptionRow option={option} />
              </li>
            ))}
          </ul>
        </section>
      ))}

      <details className={styles.raw}>
        <summary className={styles.rawSummary}>ffmpeg -h 的原始输出</summary>
        <pre className={styles.pre}>{help.raw}</pre>
      </details>
    </div>
  );
}

function OptionRow({ option }: { option: FFOption }) {
  return (
    <div className={styles.option}>
      <div className={styles.optionHead}>
        <code className={styles.optionName}>-{option.name}</code>
        {option.type ? <span className={styles.optionType}>{option.type}</span> : null}
        {option.runtime ? <span className={styles.optionType}>运行时</span> : null}
      </div>
      {option.description ? <p className={styles.optionDesc}>{option.description}</p> : null}
      {option.hasDefault || option.range || option.unit ? (
        <p className={styles.optionFacts}>
          {option.hasDefault ? <span>默认 {option.default || '（空）'}</span> : null}
          {option.range ? <span>范围 {option.range}</span> : null}
          {option.unit ? <span>单位 {option.unit}</span> : null}
        </p>
      ) : null}
      {option.values && option.values.length > 0 ? (
        <p className={styles.optionValues}>
          {option.values.map((value) => `${value.name}${value.value ? `=${value.value}` : ''}`).join(' · ')}
        </p>
      ) : null}
    </div>
  );
}
