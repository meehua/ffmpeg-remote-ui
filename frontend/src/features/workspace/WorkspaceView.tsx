import { useMemo, useState } from 'react';

import { api } from '../../api/client';
import type {
  CliHelp,
  HardwareInfo,
  Job,
  LogLine,
  MediaInfo,
  Snapshot,
} from '../../api/types';
import { Button, ButtonRow, Field, Switch, TextArea, TextInput } from '../../components/Controls';
import { Badge, CopyButton, DataList, EmptyState, ErrorNote, Spinner } from '../../components/Display';
import { Pane, Panes } from '../../components/Pane';
import { useAction, useAsync } from '../../hooks/useAsync';
import { usePersistentState } from '../../hooks/usePersistentState';
import { useI18n, type I18n } from '../../i18n/LocaleProvider';
import { formatBytes, formatDuration, toNumber } from '../../utils/format';
import { JobPanel } from '../jobs/JobPanel';
import { FileBrowser } from '../media/FileBrowser';
import { PresetBar } from '../presets/PresetBar';
import type { Recipe } from '../presets/recipe';
import { CommandBuilder } from './CommandBuilder';
import {
  buildArgs,
  emptySettings,
  hasOverwrite,
  joinArgs,
  normalizeSettings,
  platformOf,
  splitArgs,
  stripToolPrefix,
  withOverwrite,
  type EncodeSettings,
} from './args';
import styles from './WorkspaceView.module.css';

interface WorkspaceViewProps {
  snapshot: Snapshot | null;
  /** ffmpeg 自己的命令行拓扑；控件的结构跟着它走。 */
  cliHelp: CliHelp | null;
  hardware: HardwareInfo | null;
  jobs: Job[];
  logs: Record<string, LogLine[]>;
}

/**
 * 默认设置：覆盖输出文件。
 *
 * `-y` 是 ffmpeg Global options 里的一个选项，所以它存在 cli 里，而不是设置
 * 对象上一个自成一体的布尔字段——界面上那个开关读写的就是它。
 */
const initialSettings = withOverwrite(emptySettings, true);

/** 工作区：挑服务器上的文件、配参数、看命令、入队。 */
export function WorkspaceView({ snapshot, cliHelp, hardware, jobs, logs }: WorkspaceViewProps) {
  const { t } = useI18n();
  // 表单状态存进浏览器本地存档：切到别的功能域再回来、甚至刷新页面，
  // 已经填好的路径与参数都还在。
  const [input, setInput] = usePersistentState('workspace.input', '');
  const [output, setOutput] = usePersistentState('workspace.output', '');
  const [settings, setSettings] = usePersistentState<EncodeSettings>(
    'workspace.settings',
    initialSettings,
    normalizeSettings,
  );
  const [extraArgs, setExtraArgs] = usePersistentState('workspace.extraArgs', '');
  const [manual, setManual] = usePersistentState('workspace.manual', false);
  const [manualArgs, setManualArgs] = usePersistentState('workspace.manualArgs', '');
  // 「已加入队列」是一次性的反馈，不属于需要保留的配置。
  const [queued, setQueued] = useState(false);

  const probe = useAsync<MediaInfo | null>(
    () => (input === '' ? Promise.resolve(null) : api.probe(input)),
    [input],
  );
  const enqueue = useAction();

  // 引用与拆分规则跟着服务器走：界面在浏览器里跑，但命令是在服务器上执行的，
  // 所以判断依据是服务器报的 GOOS，而不是浏览器所在的系统。
  const platform = platformOf(hardware?.os);

  const args = useMemo(() => {
    if (manual) {
      return stripToolPrefix(splitArgs(manualArgs, platform));
    }
    return buildArgs({ input, output, settings, extraArgs, platform });
  }, [manual, manualArgs, input, output, settings, extraArgs, platform]);

  const command = joinArgs(['ffmpeg', ...args], platform);
  const ready = input.trim() !== '' && output.trim() !== '';

  // 工作区没有批处理的命名选项，所以预设里只放设置与附加参数。
  const recipe: Recipe = useMemo(() => ({ settings, extraArgs }), [settings, extraArgs]);

  const applyRecipe = (loaded: Recipe) => {
    setSettings(loaded.settings);
    setExtraArgs(loaded.extraArgs);
  };

  const submit = async () => {
    setQueued(false);
    const ok = await enqueue.run(() =>
      api.createJob({ input: input.trim(), output: output.trim(), args }),
    );
    setQueued(ok);
  };

  const toManual = () => {
    setManualArgs(joinArgs(args, platform));
    setManual(true);
  };

  return (
    <Panes columns={3}>
      <Pane
        title={t('workspace.source.title')}
        description={t('workspace.source.description')}
        actions={
          hardware ? (
            <Badge>{t('app.status.devices', { count: hardware.devices.length })}</Badge>
          ) : null
        }
      >
        <Field label={t('workspace.input')} hint={t('workspace.input.hint')}>
          <TextInput
            value={input}
            placeholder="/data/media/input.mkv"
            onChange={(event) => setInput(event.target.value)}
          />
        </Field>

        <FileBrowser value={input} onPick={setInput} mode="file" />

        <Field label={t('workspace.output')} hint={t('workspace.output.hint')}>
          <TextInput
            value={output}
            placeholder="/data/out/result.mp4"
            onChange={(event) => setOutput(event.target.value)}
          />
        </Field>

        <details className={styles.fold}>
          <summary className={styles.foldSummary}>{t('workspace.output.browse')}</summary>
          <FileBrowser value={output} onPick={setOutput} mode="dir" />
        </details>

        {probe.loading ? <Spinner label={t('workspace.probe.loading')} /> : null}
        {probe.error ? <ErrorNote>{probe.error}</ErrorNote> : null}
        {probe.data ? <ProbeSummary info={probe.data} /> : null}
      </Pane>

      <Pane
        narrow
        title={t('workspace.params.title')}
        description={t('workspace.params.description')}
      >
        <PresetBar recipe={recipe} onLoad={applyRecipe} />

        {snapshot ? (
          <CommandBuilder
            snapshot={snapshot}
            cliHelp={cliHelp}
            devices={hardware?.devices ?? []}
            settings={settings}
            onChange={setSettings}
          />
        ) : (
          <Spinner label={t('workspace.capability.loading')} />
        )}

        <Field label={t('batch.extraArgs')} hint={t('workspace.extraArgs.hint')}>
          <TextArea
            value={extraArgs}
            rows={3}
            placeholder="-movflags +faststart"
            onChange={(event) => setExtraArgs(event.target.value)}
          />
        </Field>

        <Switch
          label={t('common.overwrite')}
          checked={hasOverwrite(settings)}
          onChange={(on) => setSettings(withOverwrite(settings, on))}
        />
      </Pane>

      <Pane
        title={t('workspace.run.title')}
        description={t('workspace.run.description')}
        actions={
          manual ? (
            <Button compact variant="ghost" onClick={() => setManual(false)}>
              {t('workspace.run.toForm')}
            </Button>
          ) : (
            <Button compact variant="ghost" onClick={toManual}>
              {t('workspace.run.toManual')}
            </Button>
          )
        }
      >
        {manual ? (
          <Field label={t('workspace.manual')} hint={t('workspace.manual.hint')}>
            <TextArea
              value={manualArgs}
              rows={5}
              spellCheck={false}
              placeholder="-i in.mkv -c:v libx264 -crf 23 out.mp4"
              onChange={(event) => setManualArgs(event.target.value)}
            />
          </Field>
        ) : null}

        <div className={styles.preview}>
          <div className={styles.previewHead}>
            <span className={styles.previewLabel}>{t('workspace.preview')}</span>
            <CopyButton compact text={command} />
          </div>
          <pre className={styles.command}>{command}</pre>
        </div>

        {enqueue.error ? <ErrorNote>{enqueue.error}</ErrorNote> : null}
        {queued ? <p className={styles.done}>{t('workspace.queued')}</p> : null}

        <ButtonRow>
          <Button variant="primary" disabled={!ready || enqueue.pending} onClick={submit}>
            {enqueue.pending ? t('workspace.submitting') : t('workspace.enqueue')}
          </Button>
        </ButtonRow>
        {ready ? null : <p className={styles.hint}>{t('workspace.notReady')}</p>}

        <JobPanel jobs={jobs} logs={logs} />
      </Pane>
    </Panes>
  );
}

/* ---------------------------------------------------------------- ffprobe */

function ProbeSummary({ info }: { info: MediaInfo }) {
  const { t } = useI18n();
  const format = info.format ?? {};

  return (
    <div className={styles.probe}>
      <DataList
        dense
        items={[
          {
            label: t('workspace.probe.container'),
            // 容器名来自 ffprobe，是它自己的原文。
            value: format.format_long_name ?? format.format_name ?? t('common.unknown'),
          },
          { label: t('workspace.probe.duration'), value: formatDuration(toNumber(format.duration)) },
          { label: t('workspace.probe.size'), value: formatBytes(toNumber(format.size)) },
          {
            label: t('workspace.probe.bitrate'),
            value: format.bit_rate
              ? `${Math.round(toNumber(format.bit_rate) / 1000)} kb/s`
              : '—',
          },
        ]}
      />

      {info.streams.length === 0 ? (
        <EmptyState
          title={t('workspace.probe.noStreams.title')}
          hint={t('workspace.probe.noStreams.hint')}
        />
      ) : (
        <ul className={styles.streams}>
          {info.streams.map((stream) => (
            <li className={styles.stream} key={stream.index}>
              {/* codec_type / codec_name 是 ffprobe 报出来的值，保持原文。 */}
              <Badge tone="neutral">{stream.codec_type ?? t('workspace.probe.stream.unknownType')}</Badge>
              <span className={styles.streamName}>
                #{stream.index} {stream.codec_name ?? t('common.unknown')}
              </span>
              <span className={styles.streamMeta}>{describeStream(stream, t)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function describeStream(stream: MediaInfo['streams'][number], t: I18n['t']): string {
  const parts: string[] = [];
  if (stream.width && stream.height) {
    parts.push(`${stream.width}×${stream.height}`);
  }
  if (stream.pix_fmt) {
    parts.push(stream.pix_fmt);
  }
  if (stream.channels) {
    parts.push(t('workspace.probe.stream.channels', { count: stream.channels }));
  }
  if (stream.sample_rate) {
    parts.push(`${stream.sample_rate} Hz`);
  }
  if (stream.channel_layout) {
    parts.push(stream.channel_layout);
  }
  return parts.join(' · ');
}
