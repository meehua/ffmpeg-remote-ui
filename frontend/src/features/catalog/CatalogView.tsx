import { useMemo, useState } from 'react';

import { api } from '../../api/client';
import type { FFOption, FFItem, Snapshot } from '../../api/types';
import { Button, TextInput } from '../../components/Controls';
import { Badge, DataList, EmptyState, ErrorNote, Spinner } from '../../components/Display';
import { Pane, Panes } from '../../components/Pane';
import { ScrollArea } from '../../components/ScrollArea';
import { Tabs } from '../../components/Tabs';
import { useAsync, useDebounced } from '../../hooks/useAsync';
import type { MessageKey } from '../../i18n';
import { useI18n } from '../../i18n/LocaleProvider';
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
  labelKey: MessageKey;
  /** 对应的 `ffmpeg -h` 目标；为空表示这类条目没有独立帮助。 */
  target?: string;
}

const CATEGORIES: ReadonlyArray<Category> = [
  { key: 'encoders', labelKey: 'catalog.encoders', target: 'encoder' },
  { key: 'decoders', labelKey: 'catalog.decoders', target: 'decoder' },
  { key: 'filters', labelKey: 'catalog.filters', target: 'filter' },
  { key: 'muxers', labelKey: 'catalog.muxers', target: 'muxer' },
  { key: 'demuxers', labelKey: 'catalog.demuxers', target: 'demuxer' },
  { key: 'bitstreamFilters', labelKey: 'catalog.bitstreamFilters', target: 'bsf' },
  { key: 'protocols', labelKey: 'catalog.protocols', target: 'protocol' },
  { key: 'devices', labelKey: 'catalog.devices', target: 'device' },
  { key: 'hwaccels', labelKey: 'catalog.hwaccels' },
  { key: 'pixelFormats', labelKey: 'catalog.pixelFormats' },
  { key: 'sampleFormats', labelKey: 'catalog.sampleFormats' },
  { key: 'layouts', labelKey: 'catalog.layouts' },
  { key: 'colors', labelKey: 'catalog.colors' },
  { key: 'dispositions', labelKey: 'catalog.dispositions' },
  { key: 'formats', labelKey: 'catalog.formats' },
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
 *
 * 两侧内容都可能极长（一个编码器动辄上百个参数，某一类条目几千条），所以两栏
 * 都把滚动交给 ScrollArea：切换条、搜索框与栏标题因此始终留在视线里，而不是被
 * 内容推着走。
 */
export function CatalogView({ snapshot, onRefresh, refreshing }: CatalogViewProps) {
  const { t } = useI18n();
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
        <Pane title={t('catalog.loading.title')} description={t('catalog.loading.description')}>
          <Spinner label={t('common.reading')} />
        </Pane>
      </Panes>
    );
  }

  return (
    <Panes columns={2}>
      <Pane
        title={t('catalog.title')}
        description={t('catalog.description')}
        actions={
          <Button compact variant="ghost" disabled={refreshing} onClick={() => void onRefresh()}>
            {refreshing ? t('catalog.refreshing') : t('catalog.refresh')}
          </Button>
        }
      >
        <div className={styles.tabBar}>
          <Tabs
            label={t('catalog.tabs')}
            value={categoryKey}
            onChange={(next) => {
              setCategoryKey(next);
              setSelected(null);
            }}
            items={CATEGORIES.map((item) => ({
              id: item.key,
              label: t(item.labelKey),
              count: itemsOf(snapshot, item.key).length,
            }))}
          />
        </div>

        <TextInput
          type="search"
          value={search}
          placeholder={t('catalog.search', { label: t(category.labelKey) })}
          aria-label={t('catalog.search.aria')}
          onChange={(event) => setSearch(event.target.value)}
        />

        <p className={styles.count}>
          {t('catalog.count', { shown: entries.length, total: all.length })}
        </p>

        {/* 单独滚动这一份列表是有理由的：它是全站唯一长度完全由服务器决定的列表
            （编码器动辄几千条），其余列表都在几十条以内，跟着栏一起滚反而更省事，
            也少一个滚轮目标。 */}
        {entries.length === 0 ? (
          <EmptyState title={t('catalog.empty')} />
        ) : (
          <ScrollArea label={t('catalog.list.aria', { label: t(category.labelKey) })}>
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
          </ScrollArea>
        )}
      </Pane>

      <Pane title={t('catalog.detail.title')} description={t('catalog.detail.description')}>
        {selected ? (
          <ScrollArea label={t('catalog.detail.title')}>
            <HelpPanel target={selected.target} name={selected.name} />
          </ScrollArea>
        ) : (
          <EmptyState
            title={t('catalog.detail.empty.title')}
            hint={t('catalog.detail.empty.hint')}
          />
        )}
      </Pane>
    </Panes>
  );
}

/* ---------------------------------------------------------------- 详情 */

function HelpPanel({ target, name }: { target: string; name: string }) {
  const { t } = useI18n();
  const resource = useAsync(() => api.help(target, name), [target, name]);
  const payload = resource.data;
  const help = payload?.help;

  if (resource.loading) {
    return <Spinner label={t('catalog.help.loading')} />;
  }
  if (resource.error) {
    return <ErrorNote>{resource.error}</ErrorNote>;
  }
  if (!help) {
    return <EmptyState title={t('catalog.help.empty')} />;
  }

  // 列表分隔用当前语言的标点（中文顿号 / 英文逗号）。
  const separator = t('common.listSeparator');
  const port = (item: { name?: string; media?: string }) =>
    t('catalog.port', { name: item.name ?? '?', media: item.media ?? t('common.any') });

  const facts: Array<{ label: string; value: string }> = [];
  for (const property of help.properties ?? []) {
    facts.push({ label: property.name, value: property.value });
  }
  if (help.inputs?.length) {
    facts.push({
      label: t('catalog.fact.inputs'),
      value: help.inputs.map(port).join(separator),
    });
  }
  if (help.outputs?.length) {
    facts.push({
      label: t('catalog.fact.outputs'),
      value: help.outputs.map(port).join(separator),
    });
  }
  if (help.capabilities?.length) {
    facts.push({ label: t('catalog.fact.capabilities'), value: help.capabilities.join(separator) });
  }
  if (help.threading?.length) {
    facts.push({ label: t('catalog.fact.threading'), value: help.threading.join(separator) });
  }
  if (help.codecs?.length) {
    facts.push({ label: t('catalog.fact.codecs'), value: help.codecs.join(separator) });
  }
  if (help.sampleFormats?.length) {
    facts.push({ label: t('catalog.fact.sampleFormats'), value: help.sampleFormats.join(' ') });
  }

  return (
    <div className={styles.help}>
      {/* ffmpeg 自己的抱怨照原样展示，那是它的原文，不翻译。 */}
      {payload?.error ? <ErrorNote>{payload.error}</ErrorNote> : null}

      <header className={styles.helpHead}>
        <h3 className={styles.helpTitle}>{help.title ?? `${target}: ${name}`}</h3>
        {help.kind ? <Badge tone="accent">{help.kind}</Badge> : null}
      </header>

      {help.summary ? <p className={styles.helpSummary}>{help.summary}</p> : null}
      {facts.length > 0 ? <DataList dense items={facts} /> : null}

      {help.pixelFormats?.length ? (
        <section className={styles.helpSection}>
          <h4 className={styles.helpSectionTitle}>{t('catalog.pixelFormats.title')}</h4>
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
          {/* 分节名是 ffmpeg 的原文标题，保持它自己的语言。 */}
          <h4 className={styles.helpSectionTitle}>
            {section.name}
            <span className={styles.helpSectionCount}>
              {t('catalog.section.count', { count: section.options.length })}
            </span>
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
        <summary className={styles.rawSummary}>{t('catalog.help.raw')}</summary>
        <pre className={styles.pre}>{help.raw}</pre>
      </details>
    </div>
  );
}

function OptionRow({ option }: { option: FFOption }) {
  const { t } = useI18n();

  return (
    <div className={styles.option}>
      <div className={styles.optionHead}>
        <code className={styles.optionName}>-{option.name}</code>
        {option.type ? <span className={styles.optionType}>{option.type}</span> : null}
        {option.runtime ? <span className={styles.optionType}>{t('common.runtime')}</span> : null}
      </div>
      {/* 说明文字来自 ffmpeg -h，是它自己的英文原文。 */}
      {option.description ? <p className={styles.optionDesc}>{option.description}</p> : null}
      {option.hasDefault || option.range || option.unit ? (
        <p className={styles.optionFacts}>
          {option.hasDefault ? (
            <span>{t('option.default', { value: option.default || t('common.empty') })}</span>
          ) : null}
          {option.range ? <span>{t('option.range', { value: option.range })}</span> : null}
          {option.unit ? <span>{t('option.unit', { value: option.unit })}</span> : null}
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
