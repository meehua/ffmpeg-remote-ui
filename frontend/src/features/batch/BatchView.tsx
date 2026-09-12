import { useMemo, useState } from 'react';

import { api } from '../../api/client';
import type { CliHelp, GpuDevice, Job, LogLine, Snapshot } from '../../api/types';
import { Button, ButtonRow, Field, Switch, TextArea, TextInput } from '../../components/Controls';
import { EmptyState, ErrorNote } from '../../components/Display';
import { Pane, Panes } from '../../components/Pane';
import { useAction, useAsync } from '../../hooks/useAsync';
import { usePersistentState } from '../../hooks/usePersistentState';
import { useI18n } from '../../i18n/LocaleProvider';
import { baseName, relativeTo } from '../../utils/format';
import { JobPanel } from '../jobs/JobPanel';
import { PresetBar } from '../presets/PresetBar';
import type { Recipe } from '../presets/recipe';
import { CommandBuilder } from '../workspace/CommandBuilder';
import {
  buildArgs,
  emptySettings,
  hasOverwrite,
  joinArgs,
  normalizeSettings,
  withOverwrite,
  type EncodeSettings,
  type Platform,
} from '../workspace/args';
import { ExtensionPicker } from './ExtensionPicker';
import styles from './BatchView.module.css';

interface BatchViewProps {
  snapshot: Snapshot | null;
  /** ffmpeg 自己的命令行拓扑；控件的结构跟着它走。 */
  cliHelp: CliHelp | null;
  /** 服务器上真实存在的设备，供「硬件设备」选择使用。 */
  devices: GpuDevice[];
  /** 服务器所在平台：手写参数与命令预览按它的规则处理。 */
  platform: Platform;
  jobs: Job[];
  logs: Record<string, LogLine[]>;
}

const PREVIEW_LIMIT = 12;

/** 去掉最后一个扩展名；没有扩展名时原样返回。 */
function stripExtension(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(0, dot) : name;
}

/**
 * 输入文件相对扫描根的那一段（保留子目录、去掉扩展名）。
 *
 * 返回 null 表示这个文件不在扫描根下（用户手工加进来的，或者换了扫描根），
 * 此时退回平铺到输出目录，而不是猜一个结构出来。
 */
function relativeStem(input: string, root: string): string | null {
  const rel = relativeTo(input, root.trim());
  if (rel === null) {
    return null;
  }
  const name = baseName(rel);
  return rel.slice(0, rel.length - name.length) + stripExtension(name);
}

interface OutputNaming {
  dir: string;
  suffix: string;
  ext: string;
  /** 还原目录结构时的参照根；为空表示平铺。 */
  root: string;
}

/**
 * 按「目录 + 相对路径 + 后缀 + 扩展名」推出输出路径。
 *
 * 扩展名始终由「输出扩展名」设置决定：还原目录结构只负责把文件放回原来的
 * 子目录，命名仍然归命名设置管，两件事互不干扰。
 */
function outputPathFor(input: string, naming: OutputNaming): string {
  const name = baseName(input);
  const original = name.slice(stripExtension(name).length).replace(/^\./, '');
  const wanted = naming.ext.trim().replace(/^\./, '');
  const extension = wanted !== '' ? wanted : original;
  const tail = extension === '' ? '' : `.${extension}`;

  const prefix = relativeStem(input, naming.root) ?? stripExtension(name);
  return `${naming.dir.replace(/\/+$/, '')}/${prefix}${naming.suffix}${tail}`;
}

/** 输出文件所在的目录，去重后用于提交前预先创建。 */
function uniqueDirs(outputs: string[]): string[] {
  const dirs = new Set<string>();
  for (const output of outputs) {
    const index = output.lastIndexOf('/');
    if (index > 0) {
      dirs.add(output.slice(0, index));
    }
  }
  return [...dirs];
}

/** 批处理：一组输入文件套用同一套参数。 */
export function BatchView({ snapshot, cliHelp, devices, platform, jobs, logs }: BatchViewProps) {
  const { t } = useI18n();
  // 与工作区同理：状态放进浏览器本地存档，来回切换与刷新都不会白填。
  const [inputs, setInputs] = usePersistentState('batch.inputs', '');
  const [outDir, setOutDir] = usePersistentState('batch.outDir', '');
  const [suffix, setSuffix] = usePersistentState('batch.suffix', '');
  const [ext, setExt] = usePersistentState('batch.ext', '');
  const [settings, setSettings] = usePersistentState<EncodeSettings>(
    'batch.settings',
    emptySettings,
    normalizeSettings,
  );
  const [extraArgs, setExtraArgs] = usePersistentState('batch.extraArgs', '');

  const [scanDir, setScanDir] = usePersistentState('batch.scanDir', '');
  const [scanExts, setScanExts] = usePersistentState('batch.scanExts', '');
  const [keepTree, setKeepTree] = usePersistentState('batch.keepTree', true);

  const [report, setReport] = useState<string | null>(null);
  const [scanNote, setScanNote] = useState<string | null>(null);

  // 输出扩展名的候选来自 muxer：能写什么格式由 ffmpeg 说了算，
  // 这里只是把它的说法摆成一个可下拉的列表。
  const muxerExtensions = useAsync(() => api.extensions('muxer'), []);

  const submit = useAction();
  const scan = useAction();

  const plan = useMemo(() => {
    const dir = outDir.trim();
    return inputs
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '')
      .map((input) => {
        const output =
          dir === ''
            ? ''
            : outputPathFor(input, { dir, suffix, ext, root: keepTree ? scanDir : '' });
        return { input, output, args: buildArgs({ input, output, settings, extraArgs, platform }) };
      });
  }, [inputs, outDir, suffix, ext, scanDir, keepTree, settings, extraArgs, platform]);

  const ready = plan.length > 0 && outDir.trim() !== '';

  const recipe: Recipe = useMemo(
    () => ({ settings, extraArgs, naming: { suffix, ext } }),
    [settings, extraArgs, suffix, ext],
  );

  const applyRecipe = (loaded: Recipe) => {
    setSettings(loaded.settings);
    setExtraArgs(loaded.extraArgs);
    if (loaded.naming) {
      setSuffix(loaded.naming.suffix);
      setExt(loaded.naming.ext);
    }
  };

  const runScan = async () => {
    setScanNote(null);
    const dir = scanDir.trim();
    if (dir === '') {
      return;
    }
    await scan.run(async () => {
      const result = await api.scan(dir, scanExts);
      if (result.files.length > 0) {
        setInputs(result.files.map((file) => file.path).join('\n'));
      }
      // 每条独立成句，再由分隔符拼起来（英文用空格，中文不用）。
      const notes = [t('batch.result.found', { count: result.files.length })];
      if (result.skipped > 0) {
        notes.push(t('batch.result.skipped', { count: result.skipped }));
      }
      if (result.truncated) {
        notes.push(t('batch.result.truncated', { limit: result.limit }));
      }
      if (result.files.length === 0) {
        notes.push(t('batch.result.hint'));
      }
      setScanNote(notes.join(t('common.sentenceSeparator')));
    });
  };

  const enqueueAll = async () => {
    setReport(null);
    let done = 0;
    const ok = await submit.run(async () => {
      // ffmpeg 不会自己创建目录：还原目录结构时输出会落到若干子目录里，
      // 所以先把它们建出来，否则整批任务会在启动时失败。
      const dirs = uniqueDirs(plan.map((item) => item.output));
      if (dirs.length > 0) {
        await api.createDirs(dirs);
      }
      // 逐个提交：服务器有并发上限，一次丢进去也不会更快，反而更难看清结果。
      for (const item of plan) {
        await api.createJob({ input: item.input, output: item.output, args: item.args });
        done += 1;
      }
    });
    setReport(
      ok
        ? t('batch.report.done', { count: done })
        : t('batch.report.interrupted', { count: done }),
    );
  };

  /** 预览里只显示相对输出目录的那一段，长前缀没有信息量。 */
  const shorten = (path: string): string => relativeTo(path, outDir.trim()) ?? baseName(path);

  return (
    <Panes columns={2}>
      <Pane title={t('batch.title')} description={t('batch.description')}>
        <Field label={t('batch.scanDir')} hint={t('batch.scanDir.hint')}>
          <div className={styles.scanRow}>
            {/* 路径示例与语言无关，两种语言下都说得通。 */}
            <TextInput
              value={scanDir}
              placeholder="/data/media/inbox"
              onChange={(event) => setScanDir(event.target.value)}
            />
            <TextInput
              value={scanExts}
              placeholder="mkv, mp4"
              aria-label={t('batch.scanExts.aria')}
              onChange={(event) => setScanExts(event.target.value)}
            />
            <Button compact disabled={scanDir.trim() === '' || scan.pending} onClick={runScan}>
              {scan.pending ? t('batch.scanning') : t('batch.scan')}
            </Button>
          </div>
        </Field>
        {scan.error ? <ErrorNote>{scan.error}</ErrorNote> : null}
        {scanNote ? <p className={styles.planHint}>{scanNote}</p> : null}

        <ExtensionPicker target="demuxer" value={scanExts} onChange={setScanExts} />

        <Field label={t('batch.inputs')}>
          <TextArea
            value={inputs}
            rows={8}
            spellCheck={false}
            placeholder={'/data/media/a.mkv\n/data/media/b.mkv'}
            onChange={(event) => setInputs(event.target.value)}
          />
        </Field>

        <div className={styles.grid}>
          <Field label={t('batch.outDir')} hint={t('batch.outDir.hint')}>
            <TextInput
              value={outDir}
              placeholder="/data/out"
              onChange={(event) => setOutDir(event.target.value)}
            />
          </Field>
          <Field label={t('batch.suffix')} hint={t('batch.suffix.hint')}>
            <TextInput value={suffix} onChange={(event) => setSuffix(event.target.value)} />
          </Field>
          <Field label={t('batch.ext')} hint={t('batch.ext.hint')}>
            {/* 候选来自 muxer 报的扩展名，用 datalist 挂在输入框上：
                既能选，也能直接敲一个 ffmpeg 没写进帮助里的写法。 */}
            <TextInput
              list="frui-muxer-extensions"
              value={ext}
              placeholder="mp4"
              onChange={(event) => setExt(event.target.value)}
            />
          </Field>
        </div>

        <datalist id="frui-muxer-extensions">
          {(muxerExtensions.data?.extensions ?? []).map((item) => (
            <option key={item} value={item} />
          ))}
        </datalist>

        <Switch label={t('batch.keepTree')} checked={keepTree} onChange={setKeepTree} />
        <p className={styles.planHint}>
          {keepTree
            ? scanDir.trim() === ''
              ? t('batch.keepTree.noRoot')
              : t('batch.keepTree.root', { root: scanDir.trim() })
            : t('batch.keepTree.off')}
        </p>

        <Field label={t('batch.extraArgs')} hint={t('batch.extraArgs.hint')}>
          <TextArea
            value={extraArgs}
            rows={3}
            spellCheck={false}
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

      <Pane narrow title={t('batch.params.title')} description={t('batch.params.description')}>
        <PresetBar recipe={recipe} onLoad={applyRecipe} />

        {snapshot ? (
          <CommandBuilder
            snapshot={snapshot}
            cliHelp={cliHelp}
            devices={devices}
            settings={settings}
            onChange={setSettings}
          />
        ) : (
          <EmptyState
            title={t('workspace.capability.loading')}
            hint={t('batch.capability.hint')}
          />
        )}

        <div className={styles.plan}>
          <p className={styles.planTitle}>
            {plan.length > PREVIEW_LIMIT
              ? t('batch.plan.title.truncated', { count: plan.length, limit: PREVIEW_LIMIT })
              : t('batch.plan.title', { count: plan.length })}
          </p>
          {plan.length === 0 ? (
            <p className={styles.planHint}>{t('batch.plan.empty')}</p>
          ) : (
            <ul className={styles.planList}>
              {plan.slice(0, PREVIEW_LIMIT).map((item) => (
                <li key={item.input} className={styles.planItem}>
                  <span className={styles.planFrom} title={item.input}>
                    {shorten(item.input)}
                  </span>
                  <span aria-hidden="true">→</span>
                  <span className={styles.planTo} title={item.output}>
                    {shorten(item.output)}
                  </span>
                </li>
              ))}
            </ul>
          )}
          {plan[0] ? (
            <pre className={styles.command}>{joinArgs(['ffmpeg', ...plan[0].args], platform)}</pre>
          ) : null}
        </div>

        {submit.error ? <ErrorNote>{submit.error}</ErrorNote> : null}
        {report ? <p className={styles.report}>{report}</p> : null}

        <ButtonRow>
          <Button variant="primary" disabled={!ready || submit.pending} onClick={enqueueAll}>
            {submit.pending ? t('batch.submitting') : t('batch.submit')}
          </Button>
        </ButtonRow>
        {ready ? null : <p className={styles.planHint}>{t('batch.notReady')}</p>}

        <JobPanel jobs={jobs} logs={logs} />
      </Pane>
    </Panes>
  );
}
