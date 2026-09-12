import { useMemo, useState } from 'react';

import { api } from '../../api/client';
import type {
  CliHelp,
  CliOption,
  CliSection,
  FFOption,
  GpuDevice,
  HWProbe,
  Snapshot,
} from '../../api/types';
import { Button, Field, Select, Switch, TextInput } from '../../components/Controls';
import { ErrorNote, Spinner } from '../../components/Display';
import { ScrollArea } from '../../components/ScrollArea';
import { useAction, useAsync, useDebounced } from '../../hooks/useAsync';
import type { MessageKey } from '../../i18n';
import { useI18n } from '../../i18n/LocaleProvider';
import { cx } from '../../utils/format';
import {
  hwNodeAuto,
  hwNodeChoices,
  hwNodeManual,
  probeCandidates,
  type HwNodeChoice,
  type HwNodeKind,
} from '../hardware/devices';
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
 * 每种设备节点候选中间那半句的词。
 *
 * 清单里那些名字（listed）不在这张表里：它们的文字本身就是型号与标识符，再加一个
 * 状态词只是噪声。auto 与 manual 两项也不在：它们各自有一句话（不指定、手动填写），
 * 那是这一项「是什么」，与实测结论不是一回事。
 */
const NODE_STATUS: Partial<Record<HwNodeKind, MessageKey>> = {
  ok: 'builder.hwProbe.ok',
  fail: 'builder.hwProbe.failed',
  untested: 'builder.hwNode.untested',
};

/**
 * 一行候选的文字：这一行说的是谁，然后是结论。
 *
 * 认卡靠型号，所以设备行的开头就是型号（标识符紧随其后，同型号的两块卡只能靠它
 * 分）；「自动选择」与被手填过的值没有型号可写，就写它们自己（不指定、那个值）。
 * 结论永远排最后：它是这一行的注脚，不是这一行在说谁。
 */
function hwNodeLabel(node: HwNodeChoice, t: (key: string) => string): string {
  const parts: string[] = [];
  if (node.kind === 'manual') {
    parts.push(t('builder.hwNode.manual'));
  } else if (node.kind === 'untested') {
    parts.push(node.value);
  } else if (node.value === hwNodeAuto) {
    // 认「不指定」认的是值不是 kind：实测之后它的 kind 已经是结论了。
    parts.push(t('builder.hwNode.auto'));
  } else {
    parts.push(node.text);
  }

  const key = NODE_STATUS[node.kind];
  if (key) {
    parts.push(t(key));
  }
  return parts.filter((part) => part !== '').join(' · ');
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
 * 硬件设备是唯一保留结构化的特例：它的值由「类型 + 节点」拼成，类型来自
 * `ffmpeg -init_hw_device list`，节点则是用户可以填、也可以不填的一段字符。
 * 这一段是什么意思只有 FFmpeg 自己知道——同一个 `1` 在 cuda 眼里是「第 1 块
 * NVIDIA 卡」，在 qsv 眼里是「软件实现」，在 d3d11va 眼里是「第 1 个 DXGI 适配器」，
 * 所以这里既不预填也不推断：能试的值交给实测，答案连着 FFmpeg 的原文一起摆出来。
 */
export function CommandBuilder({
  snapshot,
  cliHelp,
  devices,
  settings,
  onChange,
}: CommandBuilderProps) {
  const { t } = useI18n();
  const streamKinds = useMemo(() => streamKindsOf(cliHelp), [cliHelp]);

  const setHwDevice = (patch: Partial<EncodeSettings['hwDevice']>) =>
    onChange({ ...settings, hwDevice: { ...settings.hwDevice, ...patch } });

  // 实测结果连着它测的是哪个类型一起存：同一个 `1` 在 cuda 眼里是第 1 块 NVIDIA 卡、
  // 在 qsv 眼里是软件实现，换了类型旧结论就不作数，所以只在类型对得上时才采用。
  const [probes, setProbes] = useState<{ type: string; results: HWProbe[] } | null>(null);
  const probe = useAction();
  const results = probes && probes.type === settings.hwDevice.type ? probes.results : null;

  // 下拉停在「手动填写」那一项时才出文本框。它与设备值是两回事：值仍然存在
  // settings.hwDevice.device 里，这个标记只表示「不从上面的候选里挑」。
  const [manual, setManual] = useState(false);

  // 设备节点的全部候选：不指定、实测过的值、清单里系统给了名字的值、手填过的值，
  // 最后是手填这一项。每一条的结论都是 FFmpeg 说的，界面不替它下判断。
  const nodes = useMemo(
    () => hwNodeChoices(devices, results, settings.hwDevice.device),
    [devices, results, settings.hwDevice.device],
  );
  // 手填过的值也留着文本框：否则重开一次界面，下拉停在那条「未实测」上，想改都没处改。
  const editing = manual || nodes.some((node) => node.kind === 'untested');

  /**
   * 让服务器把当前类型配每个候选都试一遍。
   *
   * 候选里既有「不指定」（第一个该试的组合），也有几个小序数与设备清单里的名字；
   * 哪些是序数、哪些能用，都不是这里判断的——界面只是把一串值报上去，让 FFmpeg
   * 每个都回答一次，再把它的原话摆回来。
   */
  const runProbe = () => {
    const type = settings.hwDevice.type;
    const candidates = probeCandidates(devices, settings.hwDevice.device);
    void probe.run(async () => {
      const result = await api.hardwareProbe(type, candidates);
      setProbes({ type, results: result.results });
    });
  };

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

      {/* 两条互斥的提醒，说的是同一件事的两面：ffmpeg 报的是「这套 FFmpeg 支持
          哪些类型」，与机器上究竟有哪块卡是两回事。一台设备都没发现时要先讲清
          「可能用不了」，发现了设备也要讲清「类型对不上照样用不了」。 */}
      {devices.length === 0 ? (
        <p className={styles.sectionMeta}>{t('builder.hwDevice.noDevices')}</p>
      ) : (
        <p className={styles.sectionMeta}>{t('builder.hwDevice.typeMatch')}</p>
      )}

      {settings.hwDevice.type !== '' ? (
        <>
          {/* 设备值不预填、也不从设备清单里推：候选里既有清单给出的名字，也有实测过的
              值，还有「不指定」——那一条就是让 FFmpeg 自己挑，实测会把它排在最前面。
              每条候选写着的结论都来自 FFmpeg，完整原文挂在该选项的 title 上。 */}
          <Field label={t('builder.hwNode')} hint={t('builder.hwNode.hint')}>
            <Select
              value={manual ? hwNodeManual : settings.hwDevice.device}
              aria-label={t('builder.hwNode')}
              onChange={(event) => {
                const next = event.target.value;
                setManual(next === hwNodeManual);
                // 选了「手动填写」不动设备值：上一个值还留着，用户接着改它的文本。
                if (next !== hwNodeManual) {
                  setHwDevice({ device: next });
                }
              }}
            >
              {nodes.map((node) => (
                <option
                  key={node.value === '' ? 'auto' : node.value}
                  value={node.value}
                  title={node.detail || undefined}
                >
                  {hwNodeLabel(node, t)}
                </option>
              ))}
            </Select>
          </Field>

          {editing ? (
            <Field label={t('builder.hwNode.manual')}>
              <TextInput
                value={settings.hwDevice.device}
                placeholder={t('builder.hwNode.placeholder')}
                aria-label={t('builder.hwNode')}
                onChange={(event) => setHwDevice({ device: event.target.value })}
              />
            </Field>
          ) : null}

          {/* 「哪个设备值能用」不靠猜：让服务器真的初始化一次，由 FFmpeg 回答；回答
              随后出现在上面的下拉里，每个值那一行写的就是它给的结论。 */}
          <div className={styles.probe}>
            <Button compact onClick={runProbe} disabled={probe.pending}>
              {probe.pending ? t('builder.hwProbe.running') : t('builder.hwProbe.run')}
            </Button>
            <span className={styles.sectionMeta}>{t('builder.hwProbe.hint')}</span>
          </div>

          {probe.error ? <ErrorNote>{probe.error.message}</ErrorNote> : null}
        </>
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
    // 整块默认收起：`ffmpeg -h long` 光分节就有近二十个，全摊开没必要的长。
    // 各分节自己也是折叠块，点开这里之后仍是一屏看得完的标题列表。
    // 「几项已启用」留在标题行上，收起时也不丢信息。
    <details className={styles.section}>
      <summary className={styles.sectionHead}>
        {/* summary 只收短语内容，标题因此用 span 而不是 h3，字重在样式里补回来。 */}
        <span className={styles.sectionTitle}>{t('builder.cli.title')}</span>
        <span className={styles.sectionMeta}>
          {t('builder.cli.summary', {
            level: cliHelp.level || t('builder.cli.defaultLevel'),
            count: enabled,
          })}
        </span>
      </summary>

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
    </details>
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

      {/* 参数是平铺的，一个编码器动辄上百项——限高之后交给它自己滚：宽屏时不再
          把这一栏撑到几千像素；窄屏不受影响，照旧跟着文档流走。
          上限取 min(50vh, 24rem)：屏幕矮时按视口走，屏幕高时不超过 24rem，
          免得一个参数列表就把这一栏里后面的大块挤出视线。 */}
      <ScrollArea label={label} maxBlockSize="min(50vh, 24rem)">
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
      </ScrollArea>
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
