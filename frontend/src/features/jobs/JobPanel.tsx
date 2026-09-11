import { useState } from 'react';

import { api } from '../../api/client';
import type { Job, JobStatus, LogLine } from '../../api/types';
import { Button, ButtonRow } from '../../components/Controls';
import { Badge, CopyButton, EmptyState, ErrorNote, ProgressBar } from '../../components/Display';
import { toError } from '../../hooks/useAsync';
import type { MessageKey } from '../../i18n';
import { useI18n } from '../../i18n/LocaleProvider';
import { baseName, formatBytes } from '../../utils/format';
import styles from './JobPanel.module.css';

const TONE: Record<JobStatus, 'neutral' | 'accent' | 'ok' | 'warn' | 'danger'> = {
  queued: 'neutral',
  running: 'accent',
  done: 'ok',
  failed: 'danger',
  cancelled: 'warn',
};

const STATUS_KEY: Record<JobStatus, MessageKey> = {
  queued: 'job.status.queued',
  running: 'job.status.running',
  done: 'job.status.done',
  failed: 'job.status.failed',
  cancelled: 'job.status.cancelled',
};

interface JobPanelProps {
  jobs: Job[];
  logs: Record<string, LogLine[]>;
}

/** 任务列表：状态、进度、操作与日志。工作区与批处理共用。 */
export function JobPanel({ jobs, logs }: JobPanelProps) {
  const { t, has } = useI18n();
  const [openId, setOpenId] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<Error | null>(null);

  const act = async (id: string, task: () => Promise<unknown>) => {
    setBusyId(id);
    setError(null);
    try {
      await task();
    } catch (cause: unknown) {
      setError(toError(cause));
    } finally {
      setBusyId(null);
    }
  };

  if (jobs.length === 0) {
    return <EmptyState title={t('job.empty.title')} hint={t('job.empty.hint')} />;
  }

  return (
    <div className={styles.list}>
      {error ? <ErrorNote error={error} /> : null}

      {jobs.map((job) => {
        const lines = logs[job.id] ?? [];
        const open = openId === job.id;
        const busy = busyId === job.id;
        const active = job.status === 'running' || job.status === 'queued';
        // 阶段码由服务器上报（见 internal/queue）；表里没有就照原样显示，
        // 免得新版服务器加了阶段、旧界面反而什么都不显示。
        const phaseKey = `job.phase.${job.phase ?? ''}`;

        return (
          <article key={job.id} className={styles.job}>
            <header className={styles.head}>
              <p className={styles.paths}>
                <span className={styles.path} title={job.input}>
                  {baseName(job.input)}
                </span>
                <span className={styles.arrow} aria-hidden="true">
                  →
                </span>
                <span className={styles.path} title={job.output}>
                  {baseName(job.output)}
                </span>
              </p>
              <Badge tone={TONE[job.status]}>{t(STATUS_KEY[job.status])}</Badge>
            </header>

            {job.status === 'running' ? (
              <div className={styles.progressRow}>
                {/* 有些设置（例如 -re 限速）下 ffmpeg 暂时报不出已处理时长，
                    此时显示流动的「进行中」，比一个停在 0% 的进度条诚实。 */}
                <ProgressBar value={job.progress} indeterminate={job.progress <= 0} />
                <span className={styles.metric}>
                  {job.progress > 0 ? `${job.progress.toFixed(1)}%` : t('job.progress.indeterminate')}
                </span>
                {job.speed ? <span className={styles.metric}>{job.speed}</span> : null}
                {job.bitrate ? <span className={styles.metric}>{job.bitrate}</span> : null}
              </div>
            ) : null}

            {job.status === 'queued' && job.position > 0 ? (
              <p className={styles.meta}>{t('job.position', { position: job.position })}</p>
            ) : null}

            {job.status === 'running' && job.phase ? (
              <p className={styles.meta}>{has(phaseKey) ? t(phaseKey) : job.phase}</p>
            ) : null}

            {job.totalSize && job.totalSize > 0 ? (
              <p className={styles.meta}>{t('job.written', { size: formatBytes(job.totalSize) })}</p>
            ) : null}

            <p className={styles.command} title={job.command}>
              {job.command}
            </p>

            {job.error ? (
              <ErrorNote
                code={job.errorCode}
                params={job.errorParams}
                fallback={job.error}
              />
            ) : null}

            <ButtonRow>
              {active ? (
                <Button
                  compact
                  variant="danger"
                  disabled={busy}
                  onClick={() => act(job.id, () => api.cancelJob(job.id))}
                >
                  {t('common.cancel')}
                </Button>
              ) : (
                <>
                  <Button compact disabled={busy} onClick={() => act(job.id, () => api.retryJob(job.id))}>
                    {t('common.retry')}
                  </Button>
                  <Button
                    compact
                    variant="ghost"
                    disabled={busy}
                    onClick={() => act(job.id, () => api.deleteJob(job.id))}
                  >
                    {t('common.delete')}
                  </Button>
                </>
              )}

              <Button
                compact
                variant="ghost"
                aria-expanded={open}
                onClick={() => setOpenId(open ? null : job.id)}
              >
                {open ? t('job.logs.hide') : t('job.logs.show', { count: lines.length })}
              </Button>

              <CopyButton compact text={job.command} label={t('job.copyCommand')} />
            </ButtonRow>

            {open ? (
              <pre className={styles.log}>
                {lines.length > 0
                  ? lines.map((line) => line.line).join('\n')
                  : t('job.log.empty')}
              </pre>
            ) : null}
          </article>
        );
      })}
    </div>
  );
}
