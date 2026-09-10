import { useState } from 'react';

import { api } from '../../api/client';
import type { Job, JobStatus, LogLine } from '../../api/types';
import { Button, ButtonRow } from '../../components/Controls';
import { Badge, CopyButton, EmptyState, ErrorNote, ProgressBar } from '../../components/Display';
import { baseName, formatBytes } from '../../utils/format';
import styles from './JobPanel.module.css';

const TONE: Record<JobStatus, 'neutral' | 'accent' | 'ok' | 'warn' | 'danger'> = {
  queued: 'neutral',
  running: 'accent',
  done: 'ok',
  failed: 'danger',
  cancelled: 'warn',
};

const LABEL: Record<JobStatus, string> = {
  queued: '排队中',
  running: '运行中',
  done: '已完成',
  failed: '失败',
  cancelled: '已取消',
};

interface JobPanelProps {
  jobs: Job[];
  logs: Record<string, LogLine[]>;
}

/** 任务列表：状态、进度、操作与日志。工作区与批处理共用。 */
export function JobPanel({ jobs, logs }: JobPanelProps) {
  const [openId, setOpenId] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const act = async (id: string, task: () => Promise<unknown>) => {
    setBusyId(id);
    setError(null);
    try {
      await task();
    } catch (cause: unknown) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusyId(null);
    }
  };

  if (jobs.length === 0) {
    return (
      <EmptyState
        title="队列是空的"
        hint="配置好输入与输出后加入队列，任务会实时出现在这里，进度由服务器推送。"
      />
    );
  }

  return (
    <div className={styles.list}>
      {error ? <ErrorNote>{error}</ErrorNote> : null}

      {jobs.map((job) => {
        const lines = logs[job.id] ?? [];
        const open = openId === job.id;
        const busy = busyId === job.id;
        const active = job.status === 'running' || job.status === 'queued';

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
              <Badge tone={TONE[job.status]}>{LABEL[job.status]}</Badge>
            </header>

            {job.status === 'running' ? (
              <div className={styles.progressRow}>
                {/* 有些设置（例如 -re 限速）下 ffmpeg 暂时报不出已处理时长，
                    此时显示流动的「进行中」，比一个停在 0% 的进度条诚实。 */}
                <ProgressBar value={job.progress} indeterminate={job.progress <= 0} />
                <span className={styles.metric}>
                  {job.progress > 0 ? `${job.progress.toFixed(1)}%` : '进行中'}
                </span>
                {job.speed ? <span className={styles.metric}>{job.speed}</span> : null}
                {job.bitrate ? <span className={styles.metric}>{job.bitrate}</span> : null}
              </div>
            ) : null}

            {job.status === 'queued' && job.position > 0 ? (
              <p className={styles.meta}>排队位置 {job.position}</p>
            ) : null}

            {job.status === 'running' && job.phase ? <p className={styles.meta}>{job.phase}</p> : null}

            {job.totalSize && job.totalSize > 0 ? (
              <p className={styles.meta}>已写出 {formatBytes(job.totalSize)}</p>
            ) : null}

            <p className={styles.command} title={job.command}>
              {job.command}
            </p>

            {job.error ? <ErrorNote>{job.error}</ErrorNote> : null}

            <ButtonRow>
              {active ? (
                <Button compact variant="danger" disabled={busy} onClick={() => act(job.id, () => api.cancelJob(job.id))}>
                  取消
                </Button>
              ) : (
                <>
                  <Button compact disabled={busy} onClick={() => act(job.id, () => api.retryJob(job.id))}>
                    重试
                  </Button>
                  <Button compact variant="ghost" disabled={busy} onClick={() => act(job.id, () => api.deleteJob(job.id))}>
                    删除
                  </Button>
                </>
              )}

              <Button
                compact
                variant="ghost"
                aria-expanded={open}
                onClick={() => setOpenId(open ? null : job.id)}
              >
                {open ? '收起日志' : `日志 (${lines.length})`}
              </Button>

              <CopyButton compact text={job.command} label="复制命令" />
            </ButtonRow>

            {open ? (
              <pre className={styles.log}>
                {lines.length > 0 ? lines.map((line) => line.line).join('\n') : '（暂时没有输出）'}
              </pre>
            ) : null}
          </article>
        );
      })}
    </div>
  );
}
