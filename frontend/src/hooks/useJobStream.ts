import { useEffect, useState } from 'react';

import type { Job, LogLine } from '../api/types';

/** 每个任务在内存里保留的日志行数，与服务器端的环形缓冲保持一致。 */
const MAX_LOG_LINES = 400;

export interface JobStream {
  jobs: Job[];
  logs: Record<string, LogLine[]>;
  connected: boolean;
}

/**
 * 订阅服务器的事件流。
 *
 * 选 SSE 而不是轮询：服务器在连接建立时会先补一份全量任务快照，之后的
 * 增量以 job/log 事件到达，所以这里既不用自己算差量，也不必定时拉取。
 * EventSource 断线后浏览器会自动重连，重连时会再收到一份全量快照，
 * 状态因此总是收敛的。
 */
export function useJobStream(): JobStream {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [logs, setLogs] = useState<Record<string, LogLine[]>>({});
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    const source = new EventSource('/api/events');

    source.addEventListener('open', () => setConnected(true));
    source.addEventListener('error', () => setConnected(false));

    /*
     * reset 表示「接下来是全量快照」：首次连接和服务器因丢事件而重同步都会发它。
     * 这里无条件丢弃旧的任务列表，于是两种情况下客户端都会收敛到同一状态——
     * 不需要去分辨这次到底是哪一种。
     */
    source.addEventListener('reset', () => setJobs([]));

    source.addEventListener('job', (event) => {
      const job = JSON.parse((event as MessageEvent<string>).data) as Job;
      setJobs((previous) => {
        const index = previous.findIndex((item) => item.id === job.id);
        if (index === -1) {
          return [job, ...previous];
        }
        const next = previous.slice();
        next[index] = job;
        return next;
      });
    });

    source.addEventListener('log', (event) => {
      const line = JSON.parse((event as MessageEvent<string>).data) as LogLine;
      setLogs((previous) => {
        const existing = previous[line.jobId] ?? [];
        const merged = [...existing, line];
        return {
          ...previous,
          [line.jobId]:
            merged.length > MAX_LOG_LINES ? merged.slice(merged.length - MAX_LOG_LINES) : merged,
        };
      });
    });

    return () => source.close();
  }, []);

  return { jobs, logs, connected };
}
