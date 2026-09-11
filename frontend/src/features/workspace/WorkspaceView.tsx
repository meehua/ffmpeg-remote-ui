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

  const args = useMemo(() => {
    if (manual) {
      return stripToolPrefix(splitArgs(manualArgs));
    }
    return buildArgs({ input, output, settings, extraArgs });
  }, [manual, manualArgs, input, output, settings, extraArgs]);

  const command = joinArgs(['ffmpeg', ...args]);
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
    setManualArgs(joinArgs(args));
    setManual(true);
  };

  return (
    <Panes columns={3}>
      <Pane
        title="源与目标"
        description="路径都在服务器上；浏览器只负责挑选，不参与计算。"
        actions={hardware ? <Badge>{hardware.devices.length} 个 DRM 设备</Badge> : null}
      >
        <Field label="输入文件" hint="留空表示还没选；下面是服务器上的目录。">
          <TextInput
            value={input}
            placeholder="/data/media/input.mkv"
            onChange={(event) => setInput(event.target.value)}
          />
        </Field>

        <FileBrowser value={input} onPick={setInput} mode="file" />

        <Field label="输出文件" hint="输出目录必须已存在。">
          <TextInput
            value={output}
            placeholder="/data/out/result.mp4"
            onChange={(event) => setOutput(event.target.value)}
          />
        </Field>

        <details className={styles.fold}>
          <summary className={styles.foldSummary}>选择输出目录</summary>
          <FileBrowser value={output} onPick={setOutput} mode="dir" />
        </details>

        {probe.loading ? <Spinner label="读取媒体信息" /> : null}
        {probe.error ? <ErrorNote>{probe.error}</ErrorNote> : null}
        {probe.data ? <ProbeSummary info={probe.data} /> : null}
      </Pane>

      <Pane
        title="编码参数"
        narrow
        description="流与选项的结构来自 ffmpeg 自己的分节，取值来自它的 -h 输出。"
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
          <Spinner label="正在读取 FFmpeg 能力" />
        )}

        <Field label="附加参数" hint="原样插在输出文件之前，用于构建器还没覆盖到的场景。">
          <TextArea
            value={extraArgs}
            rows={3}
            placeholder="-movflags +faststart"
            onChange={(event) => setExtraArgs(event.target.value)}
          />
        </Field>

        <Switch
          label="覆盖已存在的输出文件（-y）"
          checked={hasOverwrite(settings)}
          onChange={(on) => setSettings(withOverwrite(settings, on))}
        />
      </Pane>

      <Pane
        title="执行"
        description="命令在服务器上执行，进度由服务器实时推送。"
        actions={
          manual ? (
            <Button compact variant="ghost" onClick={() => setManual(false)}>
              回到表单
            </Button>
          ) : (
            <Button compact variant="ghost" onClick={toManual}>
              改为手写
            </Button>
          )
        }
      >
        {manual ? (
          <Field label="手写参数" hint="按 shell 习惯书写，引号与反斜杠与终端一致。">
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
            <span className={styles.previewLabel}>将执行</span>
            <CopyButton compact text={command} />
          </div>
          <pre className={styles.command}>{command}</pre>
        </div>

        {enqueue.error ? <ErrorNote>{enqueue.error}</ErrorNote> : null}
        {queued ? <p className={styles.done}>已加入队列。</p> : null}

        <ButtonRow>
          <Button variant="primary" disabled={!ready || enqueue.pending} onClick={submit}>
            {enqueue.pending ? '提交中…' : '加入队列'}
          </Button>
        </ButtonRow>
        {ready ? null : <p className={styles.hint}>填好输入与输出后才能入队。</p>}

        <JobPanel jobs={jobs} logs={logs} />
      </Pane>
    </Panes>
  );
}

/* ---------------------------------------------------------------- ffprobe */

function ProbeSummary({ info }: { info: MediaInfo }) {
  const format = info.format ?? {};

  return (
    <div className={styles.probe}>
      <DataList
        dense
        items={[
          { label: '容器', value: format.format_long_name ?? format.format_name ?? '未知' },
          { label: '时长', value: formatDuration(toNumber(format.duration)) },
          { label: '大小', value: formatBytes(toNumber(format.size)) },
          {
            label: '总码率',
            value: format.bit_rate ? `${Math.round(toNumber(format.bit_rate) / 1000)} kb/s` : '—',
          },
        ]}
      />

      {info.streams.length === 0 ? (
        <EmptyState title="没有解析到流" hint="文件可能不是媒体，或者 ffprobe 无法识别。" />
      ) : (
        <ul className={styles.streams}>
          {info.streams.map((stream) => (
            <li className={styles.stream} key={stream.index}>
              <Badge tone="neutral">{stream.codec_type ?? '流'}</Badge>
              <span className={styles.streamName}>
                #{stream.index} {stream.codec_name ?? '未知'}
              </span>
              <span className={styles.streamMeta}>{describeStream(stream)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function describeStream(stream: MediaInfo['streams'][number]): string {
  const parts: string[] = [];
  if (stream.width && stream.height) {
    parts.push(`${stream.width}×${stream.height}`);
  }
  if (stream.pix_fmt) {
    parts.push(stream.pix_fmt);
  }
  if (stream.channels) {
    parts.push(`${stream.channels} 声道`);
  }
  if (stream.sample_rate) {
    parts.push(`${stream.sample_rate} Hz`);
  }
  if (stream.channel_layout) {
    parts.push(stream.channel_layout);
  }
  return parts.join(' · ');
}
