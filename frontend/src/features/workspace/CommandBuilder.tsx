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
  /** 服务器上真实存在的 DRM 设备，用作硬件设备节点候选。 */
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

const MEDIA_LABEL: Record<string, string> = {
  video: '视频',
  audio: '音频',
  subtitle: '字幕',
  data: '数据',
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
  const renderNodes = useMemo(() => devices.filter((item) => item.renderNode), [devices]);
  const streamKinds = useMemo(() => streamKindsOf(cliHelp), [cliHelp]);

  const setHwDevice = (patch: Partial<EncodeSettings['hwDevice']>) =>
    onChange({ ...settings, hwDevice: { ...settings.hwDevice, ...patch } });

  return (
    <div className={styles.builder}>
      <Field
        label="硬件设备"
        hint="设备类型与节点都取自服务器；多 GPU 时显式指定可避免 FFmpeg 挑错设备。"
      >
        <Select
          value={settings.hwDevice.type}
          onChange={(event) => setHwDevice({ type: event.target.value })}
        >
          <option value="">不初始化（交给 FFmpeg 默认）</option>
          {snapshot.hwDeviceTypes.map((type) => (
            <option key={type} value={type}>
              {type}
            </option>
          ))}
        </Select>
      </Field>

      {snapshot.hwDeviceTypes.length === 0 ? (
        <p className={styles.sectionMeta}>
          这套 FFmpeg 没有报告任何硬件设备类型（`-init_hw_device list` 为空）。
        </p>
      ) : null}

      {settings.hwDevice.type !== '' ? (
        <Field label="设备节点" hint="留空表示让 FFmpeg 在选中的类型里自己挑。">
          <Select
            value={settings.hwDevice.device}
            onChange={(event) => setHwDevice({ device: event.target.value })}
          >
            <option value="">自动选择</option>
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
  const flag = MEDIA_FLAG[kind.media] ?? '';
  const encoders = useMemo(
    () => snapshot.encoders.filter((item) => flag !== '' && item.flags?.startsWith(flag)),
    [snapshot.encoders, flag],
  );
  const label = MEDIA_LABEL[kind.media] ?? kind.media;

  return (
    <>
      <Field
        label={`${label}编码器`}
        hint="copy 表示这一路直接复制、不重新编码；留空则由输出格式自己挑编码器。"
      >
        <Select
          value={stream.codec}
          onChange={(event) => onChange({ codec: event.target.value, options: {} })}
        >
          <option value="">不设置（由输出格式选默认编码器）</option>
          <option value="copy">copy · 直接复制流，不重新编码</option>
          {encoders.map((item) => (
            <option key={item.name} value={item.name}>
              {item.name} · {item.description ?? ''}
            </option>
          ))}
        </Select>
      </Field>

      {encoders.length === 0 ? (
        <p className={styles.sectionMeta}>
          这套 FFmpeg 没有报告{label}编码器（`-encoders` 里没有 {flag || '该'} 类）。
        </p>
      ) : null}

      {stream.codec !== '' && stream.codec !== 'copy' ? (
        <OptionSection
          label={`${stream.codec} 参数`}
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
        <Spinner label="正在读取 ffmpeg 的命令行选项" />
      </section>
    );
  }

  return (
    <section className={styles.section}>
      <header className={styles.sectionHead}>
        <h3 className={styles.sectionTitle}>命令行选项</h3>
        <span className={styles.sectionMeta}>
          ffmpeg -h {cliHelp.level || '（默认档）'} · {enabled} 项已启用
        </span>
      </header>

      <TextInput
        type="search"
        value={search}
        placeholder="搜索选项名或说明"
        aria-label="搜索命令行选项"
        onChange={(event) => setSearch(event.target.value)}
      />

      {sections.length === 0 ? <p className={styles.sectionMeta}>没有匹配的选项。</p> : null}

      {sections.map((section) => (
        <details className={styles.cliSection} key={section.name} open={query !== ''}>
          <summary className={styles.cliSummary}>
            <span className={styles.cliName}>{section.name}</span>
            <span className={styles.cliMeta}>{section.options.length} 项</span>
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
            aria-label={`-${option.name} 作用的流`}
            onChange={(event) =>
              onChange(
                patch({ spec: event.target.value === '' ? undefined : event.target.value }),
              )
            }
          >
            <option value="">全部流</option>
            {specs.map((item) => (
              <option key={item.spec} value={item.spec}>
                {MEDIA_LABEL[item.media] ?? item.media}
              </option>
            ))}
          </Select>
        ) : null}
        {showPosition ? (
          <Select
            className={styles.position}
            value={position}
            aria-label={`-${option.name} 的插入位置`}
            onChange={(event) => onChange(patch({ position: event.target.value as CliPosition }))}
          >
            <option value="input">放在输入侧</option>
            <option value="output">放在输出侧</option>
          </Select>
        ) : null}
      </div>

      {takesValue ? (
        <>
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
          {help.loading ? '读取中…' : `${options.length} 个可调参数`}
        </span>
      </header>

      {help.error ? <ErrorNote>{help.error}</ErrorNote> : null}
      {help.data?.error ? <ErrorNote>{help.data.error}</ErrorNote> : null}
      {help.loading ? <Spinner label="读取 ffmpeg -h" /> : null}

      {assigned.length > 0 ? (
        <ul className={styles.chips}>
          {assigned.map(([optionName, value]) => (
            <li key={optionName}>
              <button
                type="button"
                className={styles.chip}
                title="点击清除"
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
        placeholder="搜索参数名或说明"
        aria-label={`搜索 ${label}`}
        onChange={(event) => setSearch(event.target.value)}
      />

      {!help.loading && filtered.length === 0 ? (
        <p className={styles.sectionMeta}>没有匹配的参数。</p>
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
  const id = `opt-${option.name}`;
  const set = value !== '';

  return (
    <div className={cx(styles.row, set && styles.rowSet)}>
      <div className={styles.rowHead}>
        <label className={styles.flag} htmlFor={id}>
          -{option.name}
        </label>
        {option.type ? <span className={styles.type}>{option.type}</span> : null}
        {option.runtime ? <span className={styles.tag}>运行时</span> : null}
      </div>

      {option.description ? <p className={styles.desc}>{option.description}</p> : null}

      <OptionControl id={id} option={option} value={value} onChange={onChange} />

      {option.hasDefault || option.range ? (
        <p className={styles.facts}>
          {option.hasDefault ? <span>默认 {option.default || '（空）'}</span> : null}
          {option.range ? <span>范围 {option.range}</span> : null}
          {option.unit ? <span>单位 {option.unit}</span> : null}
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
  const values = option.values ?? [];

  if (values.length > 0) {
    return (
      <Select id={id} value={value} onChange={(event) => onChange(event.target.value)}>
        <option value="">（使用默认）</option>
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
        <option value="">（使用默认）</option>
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
