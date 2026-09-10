import { useMemo, useState } from 'react';

import { api } from '../../api/client';
import type { FFOption, GpuDevice, Snapshot } from '../../api/types';
import { Field, Select, TextInput } from '../../components/Controls';
import { ErrorNote, Spinner } from '../../components/Display';
import { useAsync, useDebounced } from '../../hooks/useAsync';
import { cx } from '../../utils/format';
import type { EncodeSettings } from './args';
import styles from './CommandBuilder.module.css';

interface CommandBuilderProps {
  snapshot: Snapshot;
  /** 服务器上真实存在的 DRM 设备，用作硬件设备节点候选。 */
  devices: GpuDevice[];
  settings: EncodeSettings;
  onChange: (next: EncodeSettings) => void;
}

/**
 * 由服务器真实能力驱动的参数构建器。
 *
 * 编码器候选来自 `ffmpeg -encoders`，每个编码器的可调参数来自
 * `ffmpeg -h encoder=<名>`：取值、默认值、范围都照抄 FFmpeg 的输出，
 * 因此 FFmpeg 升级后这里自动跟着变，程序里没有任何内置参数表。
 *
 * 硬件设备同理：类型来自 `ffmpeg -init_hw_device list`，节点来自 /dev/dri。
 * 多 GPU 的机器上 FFmpeg 自己挑设备可能挑错（表现为「打开编码器失败」），
 * 所以这里把选择权交给用户，而不是替它猜。
 */
export function CommandBuilder({ snapshot, devices, settings, onChange }: CommandBuilderProps) {
  const videoEncoders = useMemo(
    () => snapshot.encoders.filter((item) => item.flags?.startsWith('V')),
    [snapshot.encoders],
  );
  const audioEncoders = useMemo(
    () => snapshot.encoders.filter((item) => item.flags?.startsWith('A')),
    [snapshot.encoders],
  );
  const renderNodes = useMemo(() => devices.filter((item) => item.renderNode), [devices]);

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
              <option key={device.id} value={device.renderNode}>
                {device.renderNode}
                {device.pciAddress ? ` · ${device.pciAddress}` : ''}
                {device.driver ? ` · ${device.driver}` : ''}
              </option>
            ))}
          </Select>
        </Field>
      ) : null}

      <Field label="视频编码器" hint="保留原视频流时不重新编码，速度最快。">
        <Select
          value={settings.videoCodec}
          onChange={(event) =>
            onChange({ ...settings, videoCodec: event.target.value, videoOptions: {} })
          }
        >
          <option value="">不设置（保留原视频流）</option>
          {videoEncoders.map((item) => (
            <option key={item.name} value={item.name}>
              {item.name} · {item.description ?? ''}
            </option>
          ))}
        </Select>
      </Field>

      {settings.videoCodec !== '' ? (
        <OptionSection
          label={`${settings.videoCodec} 参数`}
          target="encoder"
          name={settings.videoCodec}
          values={settings.videoOptions}
          onChange={(next) => onChange({ ...settings, videoOptions: next })}
        />
      ) : null}

      <Field label="音频编码器" hint="保留原音频流时不重新编码。">
        <Select
          value={settings.audioCodec}
          onChange={(event) =>
            onChange({ ...settings, audioCodec: event.target.value, audioOptions: {} })
          }
        >
          <option value="">不设置（保留原音频流）</option>
          {audioEncoders.map((item) => (
            <option key={item.name} value={item.name}>
              {item.name} · {item.description ?? ''}
            </option>
          ))}
        </Select>
      </Field>

      {settings.audioCodec !== '' ? (
        <OptionSection
          label={`${settings.audioCodec} 参数`}
          target="encoder"
          name={settings.audioCodec}
          values={settings.audioOptions}
          onChange={(next) => onChange({ ...settings, audioOptions: next })}
        />
      ) : null}
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
