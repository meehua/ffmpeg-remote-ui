import { useMemo, useState } from 'react';

import { api } from '../../api/client';
import type {
  CliHelp,
  CliOption,
  CliSection,
  FFItem,
  FFOptionGroups,
  GpuDevice,
  HWProbe,
  Snapshot,
} from '../../api/types';
import { Button, Field, Select, Switch, TextArea, TextInput } from '../../components/Controls';
import { ErrorNote, Spinner } from '../../components/Display';
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
  emptyStream,
  type CliEntry,
  type CliPosition,
  type EncodeSettings,
  type FilterComplexSetting,
  type FormatSetting,
  type HwDeviceSetting,
  type ProtocolSetting,
  type StreamSetting,
} from './args';
import { FilterAssistant } from './FilterAssistant';
import { OptionSection } from './OptionSection';
import styles from './CommandBuilder.module.css';

interface CommandBuilderProps {
  snapshot: Snapshot;
  /** ffmpeg 自己的命令行拓扑（`ffmpeg -h`）；控件的结构完全跟着它。 */
  cliHelp: CliHelp | null;
  /** 服务器上真实存在的显示设备，用作硬件设备节点候选。 */
  devices: GpuDevice[];
  settings: EncodeSettings;
  onChange: (next: EncodeSettings) => void;
  /** 输入/输出地址：协议区从它的 scheme 认出这次用的是什么协议。批处理一次处理多个文件，没有单一地址，所以两者是可选的。 */
  input?: string;
  output?: string;
}

/**
 * `ffmpeg -encoders` / `-decoders` 表头图例里各媒体类型对应的 flags 首字母。
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

/** 按名字合并几组组件，先出现的说话（demuxer 自己的说明比设备表更具体）。 */
function mergeItems(...groups: FFItem[][]): FFItem[] {
  const seen = new Set<string>();
  const out: FFItem[] = [];
  for (const group of groups) {
    for (const item of group) {
      if (seen.has(item.name)) {
        continue;
      }
      seen.add(item.name);
      out.push(item);
    }
  }
  return out;
}

/**
 * 取出 `-devices` 里支持某一侧的设备。
 *
 * flags 列写着这个设备支持哪一侧（`D` = demux、`E` = mux），与 ffmpeg 对 demuxer /
 * muxer 的写法是同一套。FFmpeg 把设备实现成 demuxer 或 muxer，所以设备要并进对应
 * 那一侧的 `-f` 候选里：alsa、fbdev、xvfb 这些**可以作为输出设备**，只把 `-devices`
 * 整份并进输入侧，输出侧就一个设备都选不到。
 */
function devicesFor(items: FFItem[], side: 'D' | 'E'): FFItem[] {
  return items.filter((item) => item.flags?.includes(side));
}

/**
 * 把一段滤镜片段接到链尾。链非空时用 ffmpeg 的 ',' 分隔（多个滤镜就是一条链）。
 */
function appendFilter(chain: string, snippet: string): string {
  const head = chain.trim().replace(/,$/, '');
  return head === '' ? snippet : `${head},${snippet}`;
}

/**
 * 从地址里读出协议名：`rtmp://…` 的 rtmp、`file:/x` 的 file。
 *
 * 只做字符串切割，不判断这个协议能不能用——候选里本来就只列 `ffmpeg -protocols`
 * 报出来的那些。地址没有 scheme 时（普通路径）返回空串，也就是这个方向不需要
 * 协议参数。单字母 + 紧跟分隔符的是 Windows 盘符（C:\…），不是协议。
 */
function schemeOf(address: string | undefined): string {
  const match = /^\s*([A-Za-z][A-Za-z0-9+.-]*):/.exec(address ?? '');
  if (!match) {
    return '';
  }
  const rest = (address ?? '').slice(match[0].length);
  if (match[1].length === 1 && (rest.startsWith('\\') || rest.startsWith('/'))) {
    return '';
  }
  return match[1].toLowerCase();
}

/**
 * 由服务器真实能力驱动的参数构建器。
 *
 * 这里的结构不是设计出来的，是**读出来的**：
 *
 *   - 有哪几路流 → ffmpeg 的 Video/Audio/Subtitle/Data options 分节；
 *   - 每路流可选哪些编码器/解码器 → `ffmpeg -encoders` / `-decoders` 的 flags 列；
 *   - 每个组件的可调参数 → `ffmpeg -h <target>=<名>`（编码器、解码器、滤镜、bsf、
 *     muxer、demuxer、协议各查各的）；
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
  input,
  output,
}: CommandBuilderProps) {
  const { t } = useI18n();
  const streamKinds = useMemo(() => streamKindsOf(cliHelp), [cliHelp]);

  // ffmpeg 的公共上下文选项（`-h full` 里的 AVCodecContext 等）。它与具体
  // 编码器无关，所以整块只取一次，再按每路流的媒体类型筛出适用的那部分。
  //
  // 少了这一层，界面上的「编码器参数」就只是「编码器私有参数」：
  // `-c:v hevc_qsv -global_quality 21` 里的 global_quality 根本进不来。
  const codecGroups = useAsync(() => api.optionGroups(), []);

  return (
    <div className={styles.builder}>
      {/* 输入侧与输出侧各一个硬件设备。两侧可以要不同的类型（输入用 cuda 解码、
          输出用 qsv 编码是常见组合），也都可以留空。 */}
      <HardwareSection
        label={t('builder.hwDevice.input')}
        setting={settings.inputHardware}
        types={snapshot.hwDeviceTypes}
        devices={devices}
        onChange={(inputHardware) => onChange({ ...settings, inputHardware })}
      />

      <HardwareSection
        label={t('builder.hwDevice.output')}
        setting={settings.outputHardware}
        types={snapshot.hwDeviceTypes}
        devices={devices}
        onChange={(outputHardware) => onChange({ ...settings, outputHardware })}
      />

      {/* 下面这条说的是两侧共同的前提，所以只写一遍：FFmpeg 报的是它支持哪些类型，
          与这台机器上究竟有什么卡是两回事。 */}
      {snapshot.hwDeviceTypes.length === 0 ? (
        <p className={styles.sectionMeta}>{t('builder.hwDevice.empty')}</p>
      ) : devices.length === 0 ? (
        <p className={styles.sectionMeta}>{t('builder.hwDevice.noDevices')}</p>
      ) : (
        <p className={styles.sectionMeta}>{t('builder.hwDevice.typeMatch')}</p>
      )}

      {/* 公共上下文层取不到时会少掉一整层参数，那是「FFmpeg 说得出、界面看不到」
          的老毛病又回来了，所以这里必须显式报出来，而不是让它静默地少一块。 */}
      {codecGroups.error ? <ErrorNote>{codecGroups.error.message}</ErrorNote> : null}

      {streamKinds.map((kind) => (
        <StreamEditor
          key={kind.spec}
          kind={kind}
          snapshot={snapshot}
          codecGroups={codecGroups.data}
          stream={settings.streams[kind.spec] ?? emptyStream}
          onChange={(next) =>
            onChange({ ...settings, streams: { ...settings.streams, [kind.spec]: next } })
          }
        />
      ))}

      {/* 输入侧的格式：`-f <demuxer>`。设备也在这一列——FFmpeg 把 v4l2、alsa 这类
          设备实现成 demuxer/muxer，所以设备按 `-devices` 的 flags 分到各自的侧面：
          两个方向都能选到设备，只支持 mux 的那些不会跑到输入侧来。 */}
      <FormatSection
        title={t('builder.format.input.title')}
        hint={t('builder.format.input.hint')}
        target="demuxer"
        candidates={mergeItems(snapshot.demuxers, devicesFor(snapshot.devices, 'D'))}
        setting={settings.inputFormat}
        onChange={(inputFormat) => onChange({ ...settings, inputFormat })}
      />

      <FormatSection
        title={t('builder.format.output.title')}
        hint={t('builder.format.output.hint')}
        target="muxer"
        candidates={mergeItems(snapshot.muxers, devicesFor(snapshot.devices, 'E'))}
        setting={settings.outputFormat}
        onChange={(outputFormat) => onChange({ ...settings, outputFormat })}
      />

      {/* 协议参数。协议名从地址的 scheme 认出来（也可以在选单里改），参数本身是
          注册在 URLContext 上的普通选项（-http_proxy、-timeout…）。 */}
      <ProtocolSection
        title={t('builder.protocol.input.title')}
        address={input}
        protocols={snapshot.protocols}
        setting={settings.inputProtocol}
        onChange={(inputProtocol) => onChange({ ...settings, inputProtocol })}
      />

      <ProtocolSection
        title={t('builder.protocol.output.title')}
        address={output}
        protocols={snapshot.protocols}
        setting={settings.outputProtocol}
        onChange={(outputProtocol) => onChange({ ...settings, outputProtocol })}
      />

      <FilterComplexEditor
        snapshot={snapshot}
        setting={settings.filterComplex}
        onChange={(filterComplex) => onChange({ ...settings, filterComplex })}
      />

      <CliOptions
        cliHelp={cliHelp}
        cli={settings.cli}
        onChange={(cli) => onChange({ ...settings, cli })}
      />
    </div>
  );
}

/* ---------------------------------------------------------------- 硬件设备 */

interface HardwareSectionProps {
  /** 这一侧的名字：「输入硬件类型」/「输出硬件类型」。 */
  label: string;
  /** 这一侧的设备：类型 + 节点，都可以留空。 */
  setting: HwDeviceSetting;
  /** 这套 FFmpeg 报告的设备类型（`-init_hw_device list`）。 */
  types: string[];
  /** 服务器上真实存在的显示设备，用作设备节点候选。 */
  devices: GpuDevice[];
  onChange: (next: HwDeviceSetting) => void;
}

/**
 * 一侧的硬件设备：类型 + 设备节点 + 实测。
 *
 * 输入侧与输出侧各渲染一次。两份各自记着自己的实测结果——同一个 `1` 在 cuda 眼里
 * 是第 1 块 NVIDIA 卡、在 qsv 眼里是软件实现，换了类型旧结论就不作数，所以只在
 * 类型对得上时才采用。
 *
 * 设备节点那一格不预填、也不从设备清单里推：候选里既有清单系统给出的名字，也有
 * 实测过的值，还有「不指定」——那一条就是让 FFmpeg 自己挑。每一行的结论都来自
 * FFmpeg 的原话。
 */
function HardwareSection({ label, setting, types, devices, onChange }: HardwareSectionProps) {
  const { t } = useI18n();
  const [probes, setProbes] = useState<{ type: string; results: HWProbe[] } | null>(null);
  const probe = useAction();
  const results = probes && probes.type === setting.type ? probes.results : null;

  // 下拉停在「手动填写」那一项时才出文本框。它与设备值是两回事：值仍然存在
  // setting.device 里，这个标记只表示「不从上面的候选里挑」。
  const [manual, setManual] = useState(false);

  const nodes = useMemo(
    () => hwNodeChoices(devices, results, setting.device),
    [devices, results, setting.device],
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
    const type = setting.type;
    const candidates = probeCandidates(devices, setting.device);
    void probe.run(async () => {
      const result = await api.hardwareProbe(type, candidates);
      setProbes({ type, results: result.results });
    });
  };

  return (
    <>
      <Field label={label} hint={t('builder.hwDevice.hint')}>
        <Select
          value={setting.type}
          aria-label={label}
          onChange={(event) => onChange({ ...setting, type: event.target.value })}
        >
          <option value="">{t('builder.hwDevice.none')}</option>
          {types.map((type) => (
            <option key={type} value={type}>
              {type}
            </option>
          ))}
        </Select>
      </Field>

      {setting.type === '' ? null : (
        <>
          <Field label={t('builder.hwNode')} hint={t('builder.hwNode.hint')}>
            <Select
              value={manual ? hwNodeManual : setting.device}
              aria-label={t('builder.hwNode')}
              onChange={(event) => {
                const next = event.target.value;
                setManual(next === hwNodeManual);
                // 选了「手动填写」不动设备值：上一个值还留着，用户接着改它的文本。
                if (next !== hwNodeManual) {
                  onChange({ ...setting, device: next });
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
                value={setting.device}
                placeholder={t('builder.hwNode.placeholder')}
                aria-label={t('builder.hwNode')}
                onChange={(event) => onChange({ ...setting, device: event.target.value })}
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
      )}
    </>
  );
}

/* ---------------------------------------------------------------- 每路流 */

interface StreamEditorProps {
  kind: StreamKindInfo;
  snapshot: Snapshot;
  /** ffmpeg 的公共上下文选项（`-h full`）；还没取到时为 null。 */
  codecGroups: FFOptionGroups | null;
  stream: StreamSetting;
  onChange: (next: StreamSetting) => void;
}

/**
 * 一路流的编解码设置。
 *
 * 五块内容对应 ffmpeg 命令行上五个不同的位置，所以它们的顺序也是命令行的顺序：
 * 解码器（早于 -i）→ 编码器 → bsf → 简单滤镜链（都在输出侧）。
 */
function StreamEditor({ kind, snapshot, codecGroups, stream, onChange }: StreamEditorProps) {
  const { t } = useI18n();
  const flag = MEDIA_FLAG[kind.media] ?? '';
  // 编码器与解码器都按 ffmpeg 自己报的 flags 列筛：有哪几路流就有几次筛选，
  // 程序不维护任何组件清单。
  const encoders = useMemo(
    () => snapshot.encoders.filter((item) => flag !== '' && item.flags?.startsWith(flag)),
    [snapshot.encoders, flag],
  );
  const decoders = useMemo(
    () => snapshot.decoders.filter((item) => flag !== '' && item.flags?.startsWith(flag)),
    [snapshot.decoders, flag],
  );
  const media = MEDIA_KEY[kind.media] ? t(MEDIA_KEY[kind.media]) : kind.media;

  return (
    <>
      <Field label={t('builder.stream.encoder', { media })} hint={t('builder.stream.encoder.hint')}>
        <Select
          value={stream.codec}
          onChange={(event) => onChange({ ...stream, codec: event.target.value, options: {} })}
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
          media={kind.media}
          codecGroups={codecGroups}
          ownTitle={t('builder.options.own.title')}
          ownHint={t('builder.options.own.hint', { codec: stream.codec })}
          values={stream.options}
          onChange={(options) => onChange({ ...stream, options })}
        />
      ) : null}

      {/* 解码器必须早于 -i，所以它单独一块，且与编码器分开存。 */}
      <Field label={t('builder.stream.decoder', { media })} hint={t('builder.stream.decoder.hint')}>
        <Select
          value={stream.decoder}
          onChange={(event) => onChange({ ...stream, decoder: event.target.value, decoderOptions: {} })}
        >
          <option value="">{t('builder.stream.decoder.unset')}</option>
          {decoders.map((item) => (
            <option key={item.name} value={item.name}>
              {item.name} · {item.description ?? ''}
            </option>
          ))}
        </Select>
      </Field>

      {stream.decoder !== '' ? (
        <OptionSection
          label={t('builder.stream.decoder.options', { decoder: stream.decoder })}
          target="decoder"
          name={stream.decoder}
          ownTitle={t('builder.options.component.own.title')}
          ownHint={t('builder.options.component.own.hint', { name: stream.decoder })}
          values={stream.decoderOptions}
          onChange={(decoderOptions) => onChange({ ...stream, decoderOptions })}
        />
      ) : null}

      {/* 简单滤镜链：`-filter:<spec>` 的原文。它处理的是这一路流解码之后的帧。 */}
      <Field label={t('builder.stream.filter', { media })} hint={t('builder.stream.filter.hint')}>
        <TextArea
          rows={2}
          spellCheck={false}
          value={stream.filter}
          placeholder={t('builder.stream.filter.placeholder')}
          onChange={(event) => onChange({ ...stream, filter: event.target.value })}
        />
      </Field>

      <FilterAssistant
        filters={snapshot.filters}
        onInsert={(snippet) => onChange({ ...stream, filter: appendFilter(stream.filter, snippet) })}
      />

      {/* bitstream filter：处理还没解开的码流，落在编码之后、进容器之前。 */}
      <Field label={t('builder.stream.bsf', { media })} hint={t('builder.stream.bsf.hint')}>
        <Select
          value={stream.bitstreamFilter}
          onChange={(event) =>
            onChange({ ...stream, bitstreamFilter: event.target.value, bitstreamOptions: {} })
          }
        >
          <option value="">{t('builder.stream.bsf.unset')}</option>
          {snapshot.bitstreamFilters.map((item) => (
            <option key={item.name} value={item.name}>
              {item.name} · {item.description ?? ''}
            </option>
          ))}
        </Select>
      </Field>

      {stream.bitstreamFilter !== '' ? (
        <OptionSection
          label={t('builder.stream.bsf.options', { bsf: stream.bitstreamFilter })}
          target="bsf"
          name={stream.bitstreamFilter}
          ownTitle={t('builder.options.component.own.title')}
          ownHint={t('builder.options.component.own.hint', { name: stream.bitstreamFilter })}
          values={stream.bitstreamOptions}
          onChange={(bitstreamOptions) => onChange({ ...stream, bitstreamOptions })}
        />
      ) : null}
    </>
  );
}

/* ---------------------------------------------------------------- 格式与协议 */

interface FormatSectionProps {
  title: string;
  hint: string;
  /** 参数来源的 target：demuxer / muxer。 */
  target: string;
  /** 候选组件：来自 `-demuxers` / `-muxers`（输入侧还并上 `-devices`）。 */
  candidates: FFItem[];
  setting: FormatSetting;
  onChange: (next: FormatSetting) => void;
}

/**
 * 一处 `-f` 设置：用哪个容器（或设备），以及它自己的参数。
 *
 * 名字与参数都来自 FFmpeg：`-movflags +faststart`、`-video_size 640x480` 这些
 * 就是 muxer/demuxer 注册在 AVFormatContext 上的 AVOption。留空表示不生成 `-f`，
 * 由 ffmpeg 按文件名推断。
 */
function FormatSection({
  title,
  hint,
  target,
  candidates,
  setting,
  onChange,
}: FormatSectionProps) {
  const { t } = useI18n();

  return (
    <section className={styles.section}>
      <header className={styles.sectionHead}>
        <span className={styles.sectionTitle}>{title}</span>
        <span className={styles.sectionMeta}>{hint}</span>
      </header>

      <Select
        value={setting.name}
        aria-label={title}
        onChange={(event) => onChange({ name: event.target.value, options: {} })}
      >
        <option value="">{t('builder.format.none')}</option>
        {candidates.map((item) => (
          <option key={item.name} value={item.name}>
            {item.name} · {item.description ?? ''}
          </option>
        ))}
      </Select>

      {candidates.length === 0 ? (
        <p className={styles.sectionMeta}>{t('builder.format.empty')}</p>
      ) : null}

      {setting.name !== '' ? (
        <OptionSection
          label={t('builder.options.component.title', { name: setting.name })}
          target={target}
          name={setting.name}
          ownTitle={t('builder.options.component.own.title')}
          ownHint={t('builder.options.component.own.hint', { name: setting.name })}
          values={setting.options}
          onChange={(options) => onChange({ ...setting, options })}
        />
      ) : null}
    </section>
  );
}

interface ProtocolSectionProps {
  title: string;
  /** 这一侧的地址；没有（批处理）时协议只能手选。 */
  address?: string;
  /** 全部协议，来自 `ffmpeg -protocols`。 */
  protocols: FFItem[];
  setting: ProtocolSetting;
  onChange: (next: ProtocolSetting) => void;
}

/**
 * 一处协议参数。
 *
 * 协议从地址的 scheme 认出来（`rtmp://…` → rtmp），也可以在选单里改；拿不准的
 * 话空着就行。参数取自 `ffmpeg -h protocol=<名>`，例如 http 的 `-http_proxy`：
 * 它们和 muxer 的参数一样，是注册在 URLContext 上的普通命令行选项。
 */
function ProtocolSection({ title, address, protocols, setting, onChange }: ProtocolSectionProps) {
  const { t } = useI18n();
  const detected = schemeOf(address);
  // 选单里没挑时就用地址里认出来的那个：这正是「按地址自动」的含义。
  const active = setting.name !== '' ? setting.name : detected;
  // 有的协议不在 `-protocols` 里（例如 file 只出现在输入侧的那一段），
  // 认出来了就补进候选，免得选单里显示不出当前用的到底是什么。
  const known = protocols.some((item) => item.name === detected);

  return (
    <section className={styles.section}>
      <header className={styles.sectionHead}>
        <span className={styles.sectionTitle}>{title}</span>
        <span className={styles.sectionMeta}>{t('builder.protocol.hint')}</span>
      </header>

      <Select
        value={setting.name}
        aria-label={title}
        onChange={(event) => onChange({ name: event.target.value, options: {} })}
      >
        <option value="">
          {detected === '' ? t('builder.protocol.none') : t('builder.protocol.auto', { scheme: detected })}
        </option>
        {known || detected === '' ? null : <option value={detected}>{detected}</option>}
        {protocols.map((item) => (
          <option key={item.name} value={item.name}>
            {item.name} · {item.description ?? ''}
          </option>
        ))}
      </Select>

      {active !== '' ? (
        <OptionSection
          label={t('builder.options.component.title', { name: active })}
          target="protocol"
          name={active}
          ownTitle={t('builder.options.component.own.title')}
          ownHint={t('builder.options.component.own.hint', { name: active })}
          values={setting.options}
          onChange={(options) => onChange({ ...setting, options })}
        />
      ) : null}
    </section>
  );
}

/* ---------------------------------------------------------------- 滤镜图 */

interface FilterComplexEditorProps {
  snapshot: Snapshot;
  setting: FilterComplexSetting;
  onChange: (next: FilterComplexSetting) => void;
}

/**
 * `-filter_complex`：一条可以多进多出的滤镜图，以及把它的输出接到输出文件上的
 * `-map`。
 *
 * 与每路流的简单滤镜链分工不同：`-filter:v` 只能一路进一路出，图可以拆分、并联、
 * 合并多路流（画中画、混音都在这一档）。图本身是自由文本——它的语法是可嵌套的，
 * 表单表达不了；参数仍然可以借上面的滤镜参数助手生成。
 */
function FilterComplexEditor({ snapshot, setting, onChange }: FilterComplexEditorProps) {
  const { t } = useI18n();
  const maps = setting.maps;

  const setMap = (index: number, value: string) =>
    onChange({ ...setting, maps: maps.map((item, i) => (i === index ? value : item)) });
  const addMap = () => onChange({ ...setting, maps: [...maps, ''] });
  const removeMap = (index: number) =>
    onChange({ ...setting, maps: maps.filter((_, i) => i !== index) });

  return (
    <details className={styles.section} open={setting.graph.trim() !== ''}>
      <summary className={styles.sectionHead}>
        <span className={styles.sectionTitle}>{t('builder.filterComplex.title')}</span>
        <span className={styles.sectionMeta}>
          {t('builder.filterComplex.summary', { count: maps.length })}
        </span>
      </summary>

      <p className={styles.sectionMeta}>{t('builder.filterComplex.hint')}</p>

      <Field label={t('builder.filterComplex.graph')}>
        <TextArea
          rows={3}
          spellCheck={false}
          value={setting.graph}
          placeholder="[0:v]scale=1280:-1[outv]"
          onChange={(event) => onChange({ ...setting, graph: event.target.value })}
        />
      </Field>

      <FilterAssistant
        filters={snapshot.filters}
        onInsert={(snippet) => onChange({ ...setting, graph: appendFilter(setting.graph, snippet) })}
      />

      {/* -map 的取值是自由文本（`[outv]`、`0:a`、`1:v:0`…），顺序有意义，
          所以这里不排序、也不去重。 */}
      <p className={styles.optionGroupHead}>
        <span className={styles.optionGroupTitle}>{t('builder.filterComplex.maps')}</span>
        <span className={styles.sectionMeta}>{t('builder.filterComplex.maps.hint')}</span>
      </p>

      <ul className={styles.options}>
        {maps.map((map, index) => (
          // 列表只增删、不重排，所以下标当 key 是稳的。
          // eslint-disable-next-line react/no-array-index-key
          <li key={index}>
            <div className={styles.valueRow}>
              <TextInput
                value={map}
                placeholder={t('builder.filterComplex.map.placeholder')}
                aria-label={t('builder.filterComplex.maps')}
                onChange={(event) => setMap(index, event.target.value)}
              />
              <Button compact variant="ghost" onClick={() => removeMap(index)}>
                {t('builder.filterComplex.map.remove')}
              </Button>
            </div>
          </li>
        ))}
      </ul>

      <div className={styles.probe}>
        <Button compact onClick={addMap}>
          {t('builder.filterComplex.map.add')}
        </Button>
      </div>
    </details>
  );
}

/* ---------------------------------------------------------------- 命令行选项 */

interface CliOptionsProps {
  cliHelp: CliHelp | null;
  cli: CliEntry[];
  onChange: (next: CliEntry[]) => void;
}

/**
 * ffmpeg 的命令行选项面板。
 *
 * 分组、选项名、是否要取值、说明文字，全部来自 `ffmpeg -h`：程序只负责把它们
 * 摆成控件，并记下每个选项该插在命令行的哪一段。以前这些最常用的选项
 * （`-ss`、`-t`、`-f`、`-metadata`、`-c`、`-filter`…）根本进不了程序，只能靠
 * 「附加参数」手写；现在它们是这里的一行。
 *
 * 一个选项可以出现多份：`-map`、`-metadata`、`-attach` 这些都是要重复写的，
 * 所以存的是有序列表而不是「名字 -> 取值」。哪些选项能重复，程序不预判——
 * 想在哪个选项上再加一条，就点哪个选项的「再添一条」。
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
    () => cli.filter((item) => !item.takesValue || item.value.trim() !== '').length,
    [cli],
  );

  /**
   * 换掉某个选项名的全部条目。
   *
   * 同名条目在命令里只由一个位置决定（它们分别生成一条选项），所以整体替换时
   * 落在第一条原本的位置上，其余选项的相对顺序不受影响。
   */
  const setEntries = (name: string, entries: CliEntry[]) => {
    const next: CliEntry[] = [];
    let inserted = false;
    for (const entry of cli) {
      if (entry.name !== name) {
        next.push(entry);
        continue;
      }
      if (!inserted) {
        next.push(...entries);
        inserted = true;
      }
    }
    if (!inserted) {
      next.push(...entries);
    }
    onChange(next);
  };

  /** 某个选项名当前的条目；没有就是空数组。 */
  const entriesOf = (name: string) => cli.filter((entry) => entry.name === name);

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
                  entries={entriesOf(option.name)}
                  onChange={(next) => setEntries(option.name, next)}
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
  /** 这个选项名当前的全部条目；空数组表示它还没启用。 */
  entries: CliEntry[];
  onChange: (next: CliEntry[]) => void;
}

/**
 * 一个命令行选项。
 *
 * 控件形态直接由 ffmpeg 决定：给了 `<占位符>` 就是要取值（文本框），没有的就是
 * 开关（勾选框）。两个可改的小选择器都只在 ffmpeg 自己说不清楚时出现：
 *
 *   - 位置：它把 `-hwaccel` 归在 "Advanced video options" 下，可放进输出侧时
 *     ffmpeg 会报 "you are trying to apply an input option to an output file"；
 *   - 流定位符：`-filter` 不带 `:a` 会落到视频流上，`-filter:a` 才只处理音频。
 *
 * 两者都是 ffmpeg 的语法本身，程序只负责把选择权交出来。
 *
 * 要取值的选项可以出现多份（同一个名字连着写好几条），每条各自一个输入框；
 * 「再添一条」不判断这个选项该不该重复——ffmpeg 会接受，或者由用户自己看着办。
 */
function CliOptionRow({ option, section, specs, entries, onChange }: CliOptionRowProps) {
  const { t } = useI18n();
  const enabled = entries.length > 0;
  const takesValue = option.takesValue === true;
  const first = entries[0];
  const position = first?.position ?? defaultPosition(section.scope);
  const spec = first?.spec ?? '';
  const showPosition =
    enabled && (section.scope === 'stream' || section.scope === 'both' || section.scope === 'other');

  /** 一层新的空白条目；名字、位置、流定位符都沿用它自己当前的样子。 */
  const blank = (value: string): CliEntry => ({
    name: option.name,
    value,
    takesValue,
    position,
    ...(spec === '' ? {} : { spec }),
  });

  const patchAll = (next: Partial<CliEntry>) =>
    onChange(entries.map((entry) => ({ ...entry, ...next })));

  const setValueAt = (index: number, value: string) => {
    if (entries.length === 0) {
      if (value !== '') {
        onChange([blank(value)]);
      }
      return;
    }
    // 需要取值却清空了：这一条就不该再生成，直接去掉（只有一条时整项也取消）。
    if (value === '' && entries.length === 1) {
      onChange([]);
      return;
    }
    onChange(entries.map((entry, i) => (i === index ? { ...entry, value } : entry)));
  };

  const removeAt = (index: number) => onChange(entries.filter((_, i) => i !== index));

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
              patchAll({ spec: event.target.value === '' ? undefined : event.target.value })
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
            onChange={(event) => patchAll({ position: event.target.value as CliPosition })}
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

          {/* 还没启用时也要有一个输入框：它是这个选项的唯一入口。 */}
          {(entries.length === 0 ? [null] : entries).map((entry, index) => (
            // 列表只增删、不重排，所以下标当 key 是稳的。
            // eslint-disable-next-line react/no-array-index-key
            <div className={styles.valueRow} key={index}>
              <TextInput
                value={entry?.value ?? ''}
                placeholder={option.placeholder ?? ''}
                aria-label={`-${option.name}`}
                onChange={(event) => setValueAt(index, event.target.value)}
              />
              {entries.length > 1 ? (
                <Button compact variant="ghost" onClick={() => removeAt(index)}>
                  {t('builder.cli.removeValue')}
                </Button>
              ) : null}
            </div>
          ))}

          {enabled ? (
            <div className={styles.probe}>
              <Button compact onClick={() => onChange([...entries, blank('')])}>
                {t('builder.cli.addValue')}
              </Button>
            </div>
          ) : null}
        </>
      ) : (
        <Switch
          label={option.description || `-${option.name}`}
          checked={enabled}
          onChange={(on) => onChange(on ? [blank('')] : [])}
        />
      )}
    </div>
  );
}
