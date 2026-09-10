import { useState } from 'react';

import { api } from './api/client';
import { Badge, ErrorNote } from './components/Display';
import { BatchView } from './features/batch/BatchView';
import { CatalogView } from './features/catalog/CatalogView';
import { HardwareView } from './features/hardware/HardwareView';
import { WorkspaceView } from './features/workspace/WorkspaceView';
import { useAsync } from './hooks/useAsync';
import { useJobStream } from './hooks/useJobStream';
import { cx } from './utils/format';
import styles from './App.module.css';

type SectionId = 'workspace' | 'batch' | 'catalog' | 'hardware';

const SECTIONS: ReadonlyArray<{ id: SectionId; label: string; hint: string }> = [
  { id: 'workspace', label: '工作区', hint: '配置并执行一次转码' },
  { id: 'batch', label: '批处理', hint: '多个文件套用同一组参数' },
  { id: 'catalog', label: '能力', hint: '服务器 FFmpeg 的全部能力' },
  { id: 'hardware', label: '硬件', hint: 'DRM 设备与加速方法' },
];

/**
 * 应用外壳。
 *
 * 外壳只做两件事：切换功能域、订阅一次事件流。所有功能域共用同一份
 * FFmpeg 能力快照与任务列表，因此切换页面不会重新查询服务器。
 */
export function App() {
  const [section, setSection] = useState<SectionId>('workspace');

  const snapshot = useAsync(() => api.snapshot(), []);
  const hardware = useAsync(() => api.hardware(), []);
  const { jobs, logs, connected } = useJobStream();

  const active = jobs.filter((job) => job.status === 'running' || job.status === 'queued').length;
  const failure = snapshot.error ?? hardware.error;

  const refreshSnapshot = async () => {
    await api.refreshSnapshot();
    snapshot.reload();
  };

  const shortVersion = snapshot.data?.version.replace(/^ffmpeg version\s*/i, '').split(' ')[0];

  return (
    <div className={styles.shell}>
      <header className={styles.bar}>
        <div className={styles.brand}>
          <span className={styles.mark} aria-hidden="true" />
          <span className={styles.brandText}>
            <span className={styles.brandName}>FFmpeg Remote UI</span>
            <span className={styles.brandMeta}>{shortVersion ?? '正在读取服务器能力…'}</span>
          </span>
        </div>

        <nav className={styles.nav} aria-label="功能域">
          {SECTIONS.map((item) => (
            <button
              key={item.id}
              type="button"
              className={cx(styles.navItem, section === item.id && styles.navActive)}
              aria-current={section === item.id ? 'page' : undefined}
              onClick={() => setSection(item.id)}
            >
              <span className={styles.navLabel}>{item.label}</span>
              <span className={styles.navHint}>{item.hint}</span>
            </button>
          ))}
        </nav>

        <div className={styles.status}>
          <Badge tone={connected ? 'ok' : 'warn'}>{connected ? '已连接' : '事件流断开'}</Badge>
          {active > 0 ? <Badge tone="accent">{active} 个进行中</Badge> : null}
          {hardware.data ? <Badge>{hardware.data.devices.length} 个 DRM 设备</Badge> : null}
        </div>
      </header>

      <main className={styles.main}>
        {failure ? (
          <div className={styles.notice}>
            <ErrorNote>{failure}</ErrorNote>
          </div>
        ) : null}

        <div className={styles.viewport}>
          {section === 'workspace' ? (
            <WorkspaceView snapshot={snapshot.data} hardware={hardware.data} jobs={jobs} logs={logs} />
          ) : null}

          {section === 'batch' ? <BatchView snapshot={snapshot.data} jobs={jobs} logs={logs} /> : null}

          {section === 'catalog' ? (
            <CatalogView
              snapshot={snapshot.data}
              onRefresh={refreshSnapshot}
              refreshing={snapshot.loading}
            />
          ) : null}

          {section === 'hardware' ? (
            <HardwareView snapshot={snapshot.data} hardware={hardware.data} />
          ) : null}
        </div>
      </main>
    </div>
  );
}
