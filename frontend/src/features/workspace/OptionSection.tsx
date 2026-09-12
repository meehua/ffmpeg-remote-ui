import { useMemo, useState } from 'react';

import { api } from '../../api/client';
import type { FFOption, FFOptionGroups, OptionMedia } from '../../api/types';
import { Select, TextInput } from '../../components/Controls';
import { ErrorNote, Spinner } from '../../components/Display';
import { ScrollArea } from '../../components/ScrollArea';
import { useAsync, useDebounced } from '../../hooks/useAsync';
import { useI18n } from '../../i18n/LocaleProvider';
import { cx } from '../../utils/format';
import type { OptionValues } from './args';
import styles from './CommandBuilder.module.css';

/**
 * 一个组件的参数区。
 *
 * 参数来自两处**不同**的来源，所以分成两组摆，而不是并成一张表：
 *
 *   - 组件自己注册的那层（`ffmpeg -h <target>=<名>`）：编码器的 crf、解码器的
 *     skip_loop_filter、muxer 的 movflags、bsf 的 aud、滤镜的 w/h 都在这里；
 *   - ffmpeg 的公共上下文层（`ffmpeg -h full` 的 AVCodecContext）：global_quality、
 *     b、maxrate、profile… 它们对每个编码器都成立，因此不在上面那份输出里。
 *
 * 两层合起来才是「这个组件真正能用的参数」。并成一张表就等于把「这属于谁」
 * 又丢了——同一个名字在两层里的说明与默认值未必相同。
 *
 * 第二层只有编码器有（`codecGroups` 传进来才有），所以这里把它做成可选的：
 * 解码器、滤镜、bsf、muxer、协议都只用到第一层，而它们用的是同一个组件。
 */
export interface OptionSectionProps {
  label: string;
  /** 参数来源：`ffmpeg -h <target>=<name>` 里的 target。 */
  target: string;
  /** 参数来源里的组件名。 */
  name: string;
  /**
   * 这类流/组件的媒体类型，用来筛公共上下文层里适用的项。
   * 不传表示不筛（没有公共层时它也没有用武之地）。
   */
  media?: string;
  /** ffmpeg 的公共上下文选项（`-h full` 的 codec 层）；没有这一层时为 null。 */
  codecGroups?: FFOptionGroups | null;
  /** 私有层的标题与说明——不同组件的措辞不同，由调用方给。 */
  ownTitle: string;
  ownHint: string;
  values: OptionValues;
  onChange: (next: OptionValues) => void;
}

export function OptionSection({
  label,
  target,
  name,
  media,
  codecGroups = null,
  ownTitle,
  ownHint,
  values,
  onChange,
}: OptionSectionProps) {
  const { t } = useI18n();
  const [search, setSearch] = useState('');
  const query = useDebounced(search, 150).trim().toLowerCase();
  const help = useAsync(() => api.help(target, name), [target, name]);

  const own = help.data?.help?.options ?? [];
  const common = useMemo(
    () => commonCodecOptions(codecGroups, media ?? ''),
    [codecGroups, media],
  );

  // 两层里同名的选项只算一次，且算在组件私有层上：它更具体，说明与默认值
  // 都贴着这个组件。去掉重名之后，公共层这一组就只剩这个组件真正独有
  // 不到的那些通用参数（global_quality、b、maxrate…）。
  //
  // 渲染顺序是宽 → 窄：先「所有编码器共享的」，再「这个组件自己的」。
  const ownNames = useMemo(() => new Set(own.map((option) => option.name)), [own]);
  const shared = useMemo(
    () => common.options.filter((option) => !ownNames.has(option.name)),
    [common, ownNames],
  );

  const matches = (option: FFOption) =>
    query === '' ||
    option.name.toLowerCase().includes(query) ||
    (option.description ?? '').toLowerCase().includes(query);
  const ownShown = own.filter(matches);
  const sharedShown = shared.filter(matches);

  const assigned = Object.entries(values).filter(([, value]) => value.trim() !== '');

  const setValue = (optionName: string, value: string) => {
    const next = { ...values };
    if (value === '') {
      delete next[optionName];
    } else {
      next[optionName] = value;
    }
    onChange(next);
  };

  return (
    <section className={styles.section}>
      <header className={styles.sectionHead}>
        <h3 className={styles.sectionTitle}>{label}</h3>
        <span className={styles.sectionMeta}>
          {help.loading
            ? t('common.reading')
            : t('builder.options.count', { count: own.length + shared.length })}
        </span>
      </header>

      {help.error ? <ErrorNote>{help.error}</ErrorNote> : null}
      {/* ffmpeg 自己的抱怨照原样展示。 */}
      {help.data?.error ? <ErrorNote>{help.data.error}</ErrorNote> : null}
      {help.loading ? <Spinner label={t('catalog.help.loading')} /> : null}

      {/* 这个组件一个参数都没有是 FFmpeg 的正常答案（h264_mp4toannexb 就是这样），
          所以这里只说「它没有」，不报错。 */}
      {!help.loading && help.data?.help && own.length === 0 && common.options.length === 0 ? (
        <p className={styles.sectionMeta}>{t('builder.options.none')}</p>
      ) : null}

      {assigned.length > 0 ? (
        <ul className={styles.chips}>
          {assigned.map(([optionName, value]) => (
            <li key={optionName}>
              <button
                type="button"
                className={styles.chip}
                title={t('builder.options.chip.clear')}
                onClick={() => setValue(optionName, '')}
              >
                <span className={styles.chipKey}>{optionName}</span>
                <span className={styles.chipValue}>{value}</span>
                <span aria-hidden="true">×</span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}

      {own.length + common.options.length > 0 ? (
        <TextInput
          type="search"
          value={search}
          placeholder={t('builder.options.search')}
          aria-label={t('builder.options.search.aria', { label })}
          onChange={(event) => setSearch(event.target.value)}
        />
      ) : null}

      {!help.loading && ownShown.length === 0 && sharedShown.length === 0 && query !== '' ? (
        <p className={styles.sectionMeta}>{t('builder.options.noMatch')}</p>
      ) : null}

      {sharedShown.length > 0 ? (
        <OptionList
          title={t('builder.options.shared.title')}
          hint={t('builder.options.shared.hint', { component: common.component })}
          options={sharedShown}
          values={values}
          onChange={setValue}
        />
      ) : null}

      {ownShown.length > 0 ? (
        <OptionList
          title={ownTitle}
          hint={ownHint}
          options={ownShown}
          values={values}
          onChange={setValue}
        />
      ) : null}
    </section>
  );
}

/**
 * 从公共上下文层里挑出适用于这类流的编码选项。
 *
 * 两个判据都来自 FFmpeg 写在选项上的 flags，不是这里另立的规则：
 *
 *   - scope：只留编码侧可用的（encoding / shared）；解码专用的与编码无关。
 *   - media：留「没限定媒体」的，以及限定里含这类流的。空表示 FFmpeg 没有
 *     限定——那是「不知道」，不是「不适用」，所以保留而不是丢掉。
 */
function commonCodecOptions(
  groups: FFOptionGroups | null,
  media: string,
): { component: string; options: FFOption[] } {
  if (!groups) {
    return { component: '', options: [] };
  }
  const out: FFOption[] = [];
  let component = '';
  for (const group of groups.groups) {
    if (group.component !== 'codec') {
      continue;
    }
    if (component === '') {
      component = group.name;
    }
    for (const option of group.options) {
      if (option.scope !== undefined && option.scope !== 'encoding' && option.scope !== 'shared') {
        continue;
      }
      const medias = option.media ?? [];
      if (medias.length > 0 && !medias.includes(media as OptionMedia)) {
        continue;
      }
      out.push(option);
    }
  }
  return { component, options: out };
}

interface OptionListProps {
  title: string;
  hint: string;
  options: FFOption[];
  values: Record<string, string>;
  onChange: (optionName: string, value: string) => void;
}

/**
 * 一组参数的列表。
 *
 * 限高之后交给它自己滚：一个编码器动辄上百项，宽屏时不再把这一栏撑到几千像素；
 * 窄屏不受影响，照旧跟着文档流走。上限取 min(50vh, 24rem)：屏幕矮时按视口走，
 * 屏幕高时不超过 24rem，免得一个参数列表就把这一栏里后面的大块挤出视线。
 */
function OptionList({ title, hint, options, values, onChange }: OptionListProps) {
  return (
    <div className={styles.optionGroup}>
      <p className={styles.optionGroupHead}>
        <span className={styles.optionGroupTitle}>{title}</span>
        <span className={styles.sectionMeta}>{hint}</span>
      </p>
      <ScrollArea label={title} maxBlockSize="min(50vh, 24rem)">
        <ul className={styles.options}>
          {options.map((option) => (
            <li key={option.name}>
              <OptionRow
                option={option}
                value={values[option.name] ?? ''}
                onChange={(value) => onChange(option.name, value)}
              />
            </li>
          ))}
        </ul>
      </ScrollArea>
    </div>
  );
}

/* ---------------------------------------------------------------- 单个参数 */

interface OptionRowProps {
  option: FFOption;
  value: string;
  onChange: (value: string) => void;
}

function OptionRow({ option, value, onChange }: OptionRowProps) {
  const { t } = useI18n();
  const id = `opt-${option.name}`;
  const set = value !== '';

  return (
    <div className={cx(styles.row, set && styles.rowSet)}>
      <div className={styles.rowHead}>
        <label className={styles.flag} htmlFor={id}>
          -{option.name}
        </label>
        {option.type ? <span className={styles.type}>{option.type}</span> : null}
        {option.runtime ? <span className={styles.tag}>{t('common.runtime')}</span> : null}
      </div>

      {/* 说明文字来自 ffmpeg -h，是它自己的英文原文。 */}
      {option.description ? <p className={styles.desc}>{option.description}</p> : null}

      <OptionControl id={id} option={option} value={value} onChange={onChange} />

      {option.hasDefault || option.range ? (
        <p className={styles.facts}>
          {option.hasDefault ? (
            <span>{t('option.default', { value: option.default || t('common.empty') })}</span>
          ) : null}
          {option.range ? <span>{t('option.range', { value: option.range })}</span> : null}
          {option.unit ? <span>{t('option.unit', { value: option.unit })}</span> : null}
        </p>
      ) : null}
    </div>
  );
}

/** 按 FFmpeg 给出的类型选择控件：有枚举就下拉，数值就数字框，其余是文本框。 */
function OptionControl({
  id,
  option,
  value,
  onChange,
}: {
  id: string;
  option: FFOption;
  value: string;
  onChange: (value: string) => void;
}) {
  const { t } = useI18n();
  const values = option.values ?? [];

  if (values.length > 0) {
    return (
      <Select id={id} value={value} onChange={(event) => onChange(event.target.value)}>
        <option value="">{t('option.useDefault')}</option>
        {values.map((item) => (
          <option key={`${item.name}-${item.value ?? ''}`} value={item.value ?? item.name}>
            {item.name}
            {item.value ? ` = ${item.value}` : ''}
            {item.description ? ` · ${item.description}` : ''}
          </option>
        ))}
      </Select>
    );
  }

  if (option.type === 'boolean') {
    return (
      <Select id={id} value={value} onChange={(event) => onChange(event.target.value)}>
        <option value="">{t('option.useDefault')}</option>
        <option value="true">true</option>
        <option value="false">false</option>
      </Select>
    );
  }

  const numeric =
    option.type === 'int' ||
    option.type === 'int64' ||
    option.type === 'uint64' ||
    option.type === 'float' ||
    option.type === 'double';
  const min = Number.isFinite(Number(option.min)) ? Number(option.min) : undefined;
  const max = Number.isFinite(Number(option.max)) ? Number(option.max) : undefined;

  return (
    <TextInput
      id={id}
      type={numeric ? 'number' : 'text'}
      step={option.type === 'float' || option.type === 'double' ? 'any' : undefined}
      min={min}
      max={max}
      value={value}
      placeholder={option.hasDefault ? String(option.default ?? '') : ''}
      onChange={(event) => onChange(event.target.value)}
    />
  );
}
