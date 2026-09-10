import { useMemo, useState } from 'react';

import { api } from '../../api/client';
import type { GpuDevice, Job, LogLine, Snapshot } from '../../api/types';
import { Button, ButtonRow, Field, Switch, TextArea, TextInput } from '../../components/Controls';
import { EmptyState, ErrorNote } from '../../components/Display';
import { Pane, Panes } from '../../components/Pane';
import { useAction } from '../../hooks/useAsync';
import { baseName } from '../../utils/format';
import { JobPanel } from '../jobs/JobPanel';
import { CommandBuilder } from '../workspace/CommandBuilder';
import { buildArgs, emptySettings, joinArgs, type EncodeSettings } from '../workspace/args';
import styles from './BatchView.module.css';

interface BatchViewProps {
  snapshot: Snapshot | null;
  /** 服务器上真实存在的 DRM 设备，供「硬件设备」选择使用。 */
  devices: GpuDevice[];
  jobs: Job[];
  logs: Record<string, LogLine[]>;
}

const PREVIEW_LIMIT = 12;

/** 按「目录 + 原名 + 后缀 + 扩展名」推出输出路径。 */
function outputPathFor(input: string, dir: string, suffix: string, ext: string): string {
  const name = baseName(input);
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const wanted = ext.trim().replace(/^\./, '');
  const original = dot > 0 ? name.slice(dot + 1) : '';
  const extension = wanted !== '' ? wanted : original;
  const tail = extension === '' ? '' : `.${extension}`;
  return `${dir.replace(/\/+$/, '')}/${stem}${suffix}${tail}`;
}

/** 批处理：一组输入文件套用同一套参数。 */
export function BatchView({ snapshot, devices, jobs, logs }: BatchViewProps) {
  const [inputs, setInputs] = useState('');
  const [outDir, setOutDir] = useState('');
  const [suffix, setSuffix] = useState('');
  const [ext, setExt] = useState('');
  const [settings, setSettings] = useState<EncodeSettings>(emptySettings);
  const [extraArgs, setExtraArgs] = useState('');
  const [overwrite, setOverwrite] = useState(false);
  const [report, setReport] = useState<string | null>(null);

  const submit = useAction();

  const plan = useMemo(() => {
    return inputs
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '')
      .map((input) => {
        const output = outDir.trim() === '' ? '' : outputPathFor(input, outDir.trim(), suffix, ext);
        return {
          input,
          output,
          args: buildArgs({ input, output, settings, extraArgs, overwrite }),
        };
      });
  }, [inputs, outDir, suffix, ext, settings, extraArgs, overwrite]);

  const ready = plan.length > 0 && outDir.trim() !== '';

  const enqueueAll = async () => {
    setReport(null);
    let done = 0;
    const ok = await submit.run(async () => {
      // 逐个提交：服务器有并发上限，一次丢进去也不会更快，反而更难看清结果。
      for (const item of plan) {
        await api.createJob({ input: item.input, output: item.output, args: item.args });
        done += 1;
      }
    });
    setReport(ok ? `已加入 ${done} 个任务。` : `已加入 ${done} 个任务后中断。`);
  };

  return (
    <Panes columns={2}>
      <Pane
        title="待处理文件"
        description="每行一个服务器上的绝对路径；输出目录必须已经存在。"
      >
        <Field label="输入文件（每行一个）">
          <TextArea
            value={inputs}
            rows={8}
            spellCheck={false}
            placeholder={'/data/media/a.mkv\n/data/media/b.mkv'}
            onChange={(event) => setInputs(event.target.value)}
          />
        </Field>

        <div className={styles.grid}>
          <Field label="输出目录">
            <TextInput
              value={outDir}
              placeholder="/data/out"
              onChange={(event) => setOutDir(event.target.value)}
            />
          </Field>
          <Field label="文件名后缀" hint="例如 _x265">
            <TextInput value={suffix} onChange={(event) => setSuffix(event.target.value)} />
          </Field>
          <Field label="输出扩展名" hint="留空保留原扩展名">
            <TextInput value={ext} placeholder="mp4" onChange={(event) => setExt(event.target.value)} />
          </Field>
        </div>

        <Field
          label="附加参数"
          hint="原样插在输出文件之前，对这批次里的每个文件都生效。"
        >
          <TextArea
            value={extraArgs}
            rows={3}
            spellCheck={false}
            placeholder="-movflags +faststart"
            onChange={(event) => setExtraArgs(event.target.value)}
          />
        </Field>

        <Switch label="覆盖已存在的输出文件（-y）" checked={overwrite} onChange={setOverwrite} />
      </Pane>

      <Pane
        title="参数与提交"
        narrow
        description="参数与工作区一致：全部来自服务器 FFmpeg 的能力。"
      >
        {snapshot ? (
          <CommandBuilder
            snapshot={snapshot}
            devices={devices}
            settings={settings}
            onChange={setSettings}
          />
        ) : (
          <EmptyState title="正在读取 FFmpeg 能力" hint="读取完成后才能选择编码器。" />
        )}

        <div className={styles.plan}>
          <p className={styles.planTitle}>
            将生成 {plan.length} 个任务
            {plan.length > PREVIEW_LIMIT ? `（下面只列出前 ${PREVIEW_LIMIT} 个）` : ''}
          </p>
          {plan.length === 0 ? (
            <p className={styles.planHint}>填入输入文件与输出目录后会在这里列出每个输出路径。</p>
          ) : (
            <ul className={styles.planList}>
              {plan.slice(0, PREVIEW_LIMIT).map((item) => (
                <li key={item.input} className={styles.planItem}>
                  <span className={styles.planFrom} title={item.input}>
                    {baseName(item.input)}
                  </span>
                  <span aria-hidden="true">→</span>
                  <span className={styles.planTo} title={item.output}>
                    {baseName(item.output)}
                  </span>
                </li>
              ))}
            </ul>
          )}
          {plan[0] ? <pre className={styles.command}>{joinArgs(['ffmpeg', ...plan[0].args])}</pre> : null}
        </div>

        {submit.error ? <ErrorNote>{submit.error}</ErrorNote> : null}
        {report ? <p className={styles.report}>{report}</p> : null}

        <ButtonRow>
          <Button variant="primary" disabled={!ready || submit.pending} onClick={enqueueAll}>
            {submit.pending ? '提交中…' : '全部加入队列'}
          </Button>
        </ButtonRow>
        {ready ? null : <p className={styles.planHint}>需要至少一个输入文件，并填好输出目录。</p>}

        <JobPanel jobs={jobs} logs={logs} />
      </Pane>
    </Panes>
  );
}
