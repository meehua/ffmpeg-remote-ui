import { useMemo, useState } from 'react';

import { api } from '../../api/client';
import type {
  CliHelp,
  CliOption,
  CliSection,
  FFOption,
  GpuDevice,
  Snapshot,
} from '../../api/types';
import { Field, Select, Switch, TextInput } from '../../components/Controls';
import { ErrorNote, Spinner } from '../../components/Display';
import { useAsync, useDebounced } from '../../hooks/useAsync';
import type { MessageKey } from '../../i18n';
import { useI18n } from '../../i18n/LocaleProvider';
import { cx } from '../../utils/format';
import {
  defaultPosition,
  type CliPosition,
  type CliValue,
  type EncodeSettings,
  type StreamSetting,
} from './args';
import styles from './CommandBuilder.module.css';

interface CommandBuilderProps {
  snapshot: Snapshot;
  /** ffmpeg 自己的命令行拓扑（`ffmpeg -h`）；控件的结构完全跟着它。 */
  cliHelp: CliHelp | null;
  /** 服务器上真实存在的显示设备，用作硬件设备节点候选。 */
  devices: GpuDevice[];
  settings: EncodeSettings;
  onChange: (next: EncodeSettings) => void;
}

const emptyStream: StreamSetting = { codec: '', options: {} };

/**
 * `ffmpeg -encoders` 表头图例里各媒体类型对应的 flags 首字母。
 *
 * 这是 ffmpeg 自己的 flag 列写法（"V..... = Video" 之类），不是本程序对
 * 编码器能力的判断。
 */
const MEDIA_FLAG: Record<string, string> = { video: 'V', audio: 'A', subtitle: 'S', data: 'D' };

/** 媒体类型的显示名；类型本身来自 ffmpeg 的分节，映射不中就用原文。 */
const MEDIA_KEY: Record<string, MessageKey> = {
  video: 'builder.media.video',
  audio: 'builder.media.audio',
  subtitle: 'builder.media.subtitle',
  data: 'builder.media.data',
};

interface StreamKindInfo {
  /** ffmpeg 的流定位符：v / a / s / d。 */
  spec: string;
  media: string;
}

/**
 * 从 ffmpeg 的分节里取出流类别。
 *
 * 有几路流可以设置，不写死在代码里：ffmpeg 有哪几个带媒体类型的分节，界面就
 * 有哪几路设置。所以 ffmpeg 将来多一类流，界面自动多一块。
 */
function streamKindsOf(cliHelp: CliHelp | null): StreamKindInfo[] {
  if (!cliHelp) {
    return [];
  }
  const out: StreamKindInfo[] = [];
  const seen = new Set<string>();
  for (const section of cliHelp.sections) {
    const { media, spec } = section;
    if (!media || !spec || seen.has(spec)) {
      continue;
    }
    seen.add(spec);
    out.push({ spec, media });
  }
  return out;
}

/**
 * 由服务器真实能力驱动的参数构建器。
 *
 * 这里的结构不是设计出来的，是**读出来的**：
 *
 *   - 有哪几路流 → ffmpeg 的 Video/Audio/Subtitle/Data options 分节；
 *   - 每路流可选哪些编码器 → `ffmpeg -encoders` 的 flags 列；
 *   - 每个编码器的可调参数 → `ffmpeg -h encoder=<名>`；
 *   - 命令行有哪些选项、哪个要取值、属于哪一段 → `ffmpeg -h` 的分节与占位符。
 *
 * 硬件设备是唯一保留结构化的特例：它的值由「类型 + 节点」拼成，两者分别来自
 * `ffmpeg -init_hw_device list` 与 /dev/dri，都是服务器报告的事实。
 * 多 GPU 的机器上 FFmpeg 自己挑设备可能挑错（表现为「打开编码器失败」），
 * 所以把选择权交给用户，而不是替它猜。
 */
export function CommandBuilder({
  snapshot,
  cliHelp,
  devices,
  settings,
  onChange,
}: CommandBuilderProps) {
  const { t } = useI18n();
  const renderNodes = useMemo(() => devices.filter((item) => item.renderNode), [devices]);
  const streamKinds = useMemo(() => streamKindsOf(cliHelp), [cliHelp]);

  const setHwDevice = (patch: Partial<EncodeSettings['hwDevice']>) =>
    onChange({ ...settings, hwDevice: { ...settings.hwDevice, ...patch } });

  return (
    <div className={styles.builder}>
      <Field label={t('builder.hwDevice')} hint={t('builder.hwDevice.hint')}>
        <Select
          value={settings.hwDevice.type}
          onChange={(event) => setHwDevice({ type: event.target.value })}
        >
          <option value="">{t('builder.hwDevice.none')}</option>
          {snapshot.hwDeviceTypes.map((type) => (
            <option key={type} value={type}>
              {type}
            </option>
          ))}
        </Select>
      </Field>

      {snapshot.hwDeviceTypes.length === 0 ? (
        <p className={styles.sectionMeta}>{t('builder.hwDevice.empty')}</p>
      ) : null}

      {settings.hwDevice.type !== '' ? (
        <Field label={t('builder.hwNode')} hint={t('builder.hwNode.hint')}>
          <Select
            value={settings.hwDevice.device}
            onChange={(event) => setHwDevice({ device: event.target.value })}
          >
            <option value="">{t('builder.hwNode.auto')}</option>
            {renderNodes.map((device) => (
              <option
                key={device.id}
                value={device.renderNode}
                title={[device.deviceName, device.pciAddress, device.driver].filter(Boolean).join(' · ')}
              >
                {/* 有型号就优先显示型号（认卡直观），没有则回退到 vendor:device ID；
                    节点始终跟在后面，因为同型号的两块卡得靠它区分。 */}
                {[
                  device.deviceName || `${device.vendor ?? ''}:${device.deviceId ?? ''}`,
                  device.renderNode,
                ]
                  .filter(Boolean)
                  .join(' · ')}
              </option>
            ))}
          </Select>
        </Field>
      ) : null}

      {streamKinds.map((kind) => (
        <StreamEditor
          key={kind.spec}
          kind={kind}
          snapshot={snapshot}
          stream={settings.streams[kind.spec] ?? emptyStream}
          onChange={(next) =>
            onChange({ ...settings, streams: { ...settings.streams, [kind.spec]: next } })
          }
        />
      ))}

      <CliOptions
        cliHelp={cliHelp}
        cli={settings.cli}
        onChange={(cli) => onChange({ ...settings, cli })}
      />
    </div>
  );
}

/* ---------------------------------------------------------------- 每路流 */

interface StreamEditorProps {
  kind: StreamKindInfo;
  snapshot: Snapshot;
  stream: StreamSetting;
  onChange: (next: StreamSetting) => void;
}

/** 一路流的编码器与它的参数。 */
function StreamEditor({ kind, snapshot, stream, onChange }: StreamEditorProps) {
  const { t } = useI18n();
  const flag = MEDIA_FLAG[kind.media] ?? '';
  const encoders = useMemo(
    () => snapshot.encoders.filter((item) => flag !== '' && item.flags?.startsWith(flag)),
    [snapshot.encoders, flag],
  );
  const media = MEDIA_KEY[kind.media] ? t(MEDIA_KEY[kind.media]) : kind.media;

  return (
    <>
      <Field label={t('builder.stream.encoder', { media })} hint={t('builder.stream.encoder.hint')}>
        <Select
          value={stream.codec}
          onChange={(event) => onChange({ codec: event.target.value, options: {} })}
        >
          <option value="">{t('builder.stream.codec.unset')}</option>
          <option value="copy">{t('builder.stream.codec.copy')}</option>
          {encoders.map((item) => (
            <option key={item.name} value={item.name}>
              {item.name} · {item.description ?? ''}
            </option>
          ))}
        </Select>
      </Field>

      {encoders.length === 0 ? (
        <p className={styles.sectionMeta}>
          {t('builder.stream.encoder.empty', { media, flag: flag || '?' })}
        </p>
      ) : null}

      {stream.codec !== '' && stream.codec !== 'copy' ? (
        <OptionSection
          label={t('builder.stream.options', { codec: stream.codec })}
          target="encoder"
          name={stream.codec}
          values={stream.options}
          onChange={(options) => onChange({ ...stream, options })}
        />
      ) : null}
    </>
  );
}

/* ---------------------------------------------------------------- 命令行选项 */

interface CliOptionsProps {
  cliHelp: CliHelp | null;
  cli: Record<string, CliValue>;
  onChange: (next: Record<string, CliValue>) => void;
}

/**
 * ffmpeg 的命令行选项面板。
 *
 * 分组、选项名、是否要取值、说明文字，全部来自 `ffmpeg -h`：程序只负责把它们
 * 摆成控件，并记下每个选项该插在命令行的哪一段。以前这些最常用的选项
 * （`-ss`、`-t`、`-f`、`-metadata`、`-c`、`-filter`…）根本进不了程序，只能靠
 * 「附加参数」手写；现在它们是这里的一行。
 */
function CliOptions({ cliHelp, cli, onChange }: CliOptionsProps) {
  const { t } = useI18n();
  const [search, setSearch] = useState('');
  const query = useDebounced(search, 150).trim().toLowerCase();

  const sections = useMemo(() => filterSections(cliHelp, query), [cliHelp, query]);
  // 流定位符的候选取自 ffmpeg 的媒体类型分节：ffmpeg 认识哪几类流，
  // 这里就有几个可选值，程序不自己列一份 v/a/s/d。
  const specs = useMemo(() => streamKindsOf(cliHelp), [cliHelp]);
  const enabled = useMemo(
    () => Object.values(cli).filter((item) => !item.takesValue || item.value.trim() !== '').length,
    [cli],
  );

  const setValue = (name: string, next: CliValue | null) => {
    const copy = { ...cli };
    if (next === null) {
      delete copy[name];
    } else {
      copy[name] = next;
    }
    onChange(copy);
  };

  if (!cliHelp) {
    return (
      <section className={styles.section}>
        <Spinner label={t('builder.cli.loading')} />
      </section>
    );
  }

  return (
    <section className={styles.section}>
      <header className={styles.sectionHead}>
        <h3 className={styles.sectionTitle}>{t('builder.cli.title')}</h3>
        <span className={styles.sectionMeta}>
          {t('builder.cli.summary', {
            level: cliHelp.level || t('builder.cli.defaultLevel'),
            count: enabled,
          })}
        </span>
      </header>

      <TextInput
        type="search"
        value={search}
        placeholder={t('builder.cli.search')}
        aria-label={t('builder.cli.search.aria')}
        onChange={(event) => setSearch(event.target.value)}
      />

      {sections.length === 0 ? <p className={styles.sectionMeta}>{t('builder.cli.noMatch')}</p> : null}

      {sections.map((section) => (
        <details className={styles.cliSection} key={section.name} open={query !== ''}>
          <summary className={styles.cliSummary}>
            {/* 分节名是 ffmpeg 的原文标题，保持它自己的语言。 */}
            <span className={styles.cliName}>{section.name}</span>
            <span className={styles.cliMeta}>
              {t('builder.cli.sectionCount', { count: section.options.length })}
            </span>
          </summary>
          <ul className={styles.options}>
            {section.options.map((option) => (
              <li key={option.name}>
                <CliOptionRow
                  option={option}
                  section={section}
                  specs={specs}
                  value={cli[option.name]}
                  onChange={(next) => setValue(option.name, next)}
                />
              </li>
            ))}
          </ul>
        </details>
      ))}
    </section>
  );
}

/** 按搜索词过滤：一节里没有命中项就整节收起，不用让人看一堆空标题。 */
function filterSections(cliHelp: CliHelp | null, query: string): CliSection[] {
  if (!cliHelp) {
    return [];
  }
  if (query === '') {
    return cliHelp.sections;
  }
  return cliHelp.sections
    .map((section) => ({
      ...section,
      options: section.options.filter(
        (option) =>
          option.name.toLowerCase().includes(query) ||
          (option.description ?? '').toLowerCase().includes(query),
      ),
    }))
    .filter((section) => section.options.length > 0);
}

interface CliOptionRowProps {
  option: CliOption;
  section: CliSection;
  /** 可用的流定位符，来自 ffmpeg 的媒体类型分节。 */
  specs: StreamKindInfo[];
  /** 缺省表示这个选项还没启用。 */
  value: CliValue | undefined;
  onChange: (next: CliValue | null) => void;
}

/**
 * 一个命令行选项。
 *
 * 控件形态直接由 ffmpeg 决定：给了 `<占位符>` 就是要取值（文本框），没有的就是
 * 开关（勾选框）。两个可改的小选择器都只在 ffmpeg 自己说不清楚时出现：
 *
 *   - 位置：它把 `-hwaccel` 归在 "Advanced Video options" 下，可放进输出侧时
 *     ffmpeg 会报 "you are trying to apply an input option to an output file"；
 *   - 流定位符：`-filter` 不带 `:a` 会落到视频流上，`-filter:a` 才只处理音频。
 *
 * 两者都是 ffmpeg 的语法本身，程序只负责把选择权交出来。
 */
function CliOptionRow({ option, section, specs, value, onChange }: CliOptionRowProps) {
  const { t } = useI18n();
  const enabled = value !== undefined;
  const takesValue = option.takesValue === true;
  const position = value?.position ?? defaultPosition(section.scope);
  const spec = value?.spec ?? '';
  const showPosition =
    enabled && (section.scope === 'stream' || section.scope === 'both' || section.scope === 'other');

  /** 用当前已选的位置与流定位符拼一份新取值。 */
  const patch = (next: Partial<CliValue>): CliValue => ({
    value: value?.value ?? '',
    takesValue,
    position,
    ...(spec === '' ? {} : { spec }),
    ...next,
  });

  return (
    <div className={cx(styles.row, enabled && styles.rowSet)}>
      <div className={styles.rowHead}>
        <span className={styles.flag}>-{option.name}</span>
        {takesValue && option.placeholder ? (
          <span className={styles.type}>{option.placeholder}</span>
        ) : null}
        {enabled && option.streamSpec && specs.length > 0 ? (
          <Select
            className={styles.position}
            value={spec}
            aria-label={t('builder.cli.spec.aria', { name: option.name })}
            onChange={(event) =>
              onChange(
                patch({ spec: event.target.value === '' ? undefined : event.target.value }),
              )
            }
          >
            <option value="">{t('builder.cli.spec.all')}</option>
            {specs.map((item) => (
              <option key={item.spec} value={item.spec}>
                {MEDIA_KEY[item.media] ? t(MEDIA_KEY[item.media]) : item.media}
              </option>
            ))}
          </Select>
        ) : null}
        {showPosition ? (
          <Select
            className={styles.position}
            value={position}
            aria-label={t('builder.cli.position.aria', { name: option.name })}
            onChange={(event) => onChange(patch({ position: event.target.value as CliPosition }))}
          >
            <option value="input">{t('builder.cli.position.input')}</option>
            <option value="output">{t('builder.cli.position.output')}</option>
          </Select>
        ) : null}
      </div>

      {takesValue ? (
        <>
          {/* 说明文字来自 ffmpeg -h，是它自己的英文原文。 */}
          {option.description ? <p className={styles.desc}>{option.description}</p> : null}
          <TextInput
            value={value?.value ?? ''}
            placeholder={option.placeholder ?? ''}
            aria-label={`-${option.name}`}
            onChange={(event) => {
              const text = event.target.value;
              onChange(text === '' ? null : patch({ value: text }));
            }}
          />
        </>
      ) : (
        <Switch
          label={option.description || `-${option.name}`}
          checked={enabled}
          onChange={(on) => onChange(on ? patch({ value: '' }) : null)}
        />
      )}
    </div>
  );
}

/* ---------------------------------------------------------------- 参数区 */

interface OptionSectionProps {
  label: string;
  target: string;
  name: string;
  values: Record<string, string>;
  onChange: (next: Record<string, string>) => void;
}

function OptionSection({ label, target, name, values, onChange }: OptionSectionProps) {
  const { t } = useI18n();
  const [search, setSearch] = useState('');
  const query = useDebounced(search, 150).trim().toLowerCase();
  const help = useAsync(() => api.help(target, name), [target, name]);

  const options = help.data?.help?.options ?? [];
  const filtered = query === ''
    ? options
    : options.filter(
        (option) =>
          option.name.toLowerCase().includes(query) ||
          (option.description ?? '').toLowerCase().includes(query),
      );

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
          {help.loading ? t('common.reading') : t('builder.options.count', { count: options.length })}
        </span>
      </header>

      {help.error ? <ErrorNote>{help.error}</ErrorNote> : null}
      {/* ffmpeg 自己的抱怨照原样展示。 */}
      {help.data?.error ? <ErrorNote>{help.data.error}</ErrorNote> : null}
      {help.loading ? <Spinner label={t('catalog.help.loading')} /> : null}

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

      <TextInput
        type="search"
        value={search}
        placeholder={t('builder.options.search')}
        aria-label={t('builder.options.search.aria', { label })}
        onChange={(event) => setSearch(event.target.value)}
      />

      {!help.loading && filtered.length === 0 ? (
        <p className={styles.sectionMeta}>{t('builder.options.noMatch')}</p>
      ) : null}

      <ul className={styles.options}>
        {filtered.map((option) => (
          <li key={option.name}>
            <OptionRow
              option={option}
              value={values[option.name] ?? ''}
              onChange={(value) => setValue(option.name, value)}
            />
          </li>
        ))}
      </ul>
    </section>
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

  const numeric = option.type === 'int' || option.type === 'int64' || option.type === 'uint64' || option.type === 'float' || option.type === 'double';
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
