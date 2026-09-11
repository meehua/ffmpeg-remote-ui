import { useState } from 'react';

import { api } from './api/client';
import type { ConfigInfo, RuntimeConfig } from './api/types';
import { Badge, ErrorNote } from './components/Display';
import { ErrorBoundary } from './components/ErrorBoundary';
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
  const config = useAsync(() => api.config(), []);
  // ffmpeg 自己的命令行拓扑：界面的控件结构跟着它，所以只取一次、全局共用。
  const cliHelp = useAsync(() => api.cli(), []);
  const { jobs, logs, connected } = useJobStream();

  const active = jobs.filter((job) => job.status === 'running' || job.status === 'queued').length;
  // 每一份远程数据都要参与报错：少了 cliHelp 这一项，它加载失败时用户看到的
  // 只会是一个转不完的「正在读取命令行选项」。
  const failure = snapshot.error ?? hardware.error ?? cliHelp.error ?? config.error;

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
          {hardware.data ? <Badge>{hardware.data.devices?.length ?? 0} 个 DRM 设备</Badge> : null}
        </div>
      </header>

      <main className={styles.main}>
        {failure ? (
          <div className={styles.notice}>
            <ErrorNote>{failure}</ErrorNote>
          </div>
        ) : null}

        {config.data ? (
          <div className={styles.notice}>
            <ConfigNotice info={config.data} />
          </div>
        ) : null}

        {/* 功能域各自兜底：某一页渲染出错时，侧栏与顶栏还在，用户能切走继续用别的。 */}
        <div className={styles.viewport}>
          <ErrorBoundary label="这个功能域">
            {section === 'workspace' ? (
              <WorkspaceView
                snapshot={snapshot.data}
                cliHelp={cliHelp.data}
                hardware={hardware.data}
                jobs={jobs}
                logs={logs}
              />
            ) : null}

            {section === 'batch' ? (
              <BatchView
                snapshot={snapshot.data}
                cliHelp={cliHelp.data}
                devices={hardware.data?.devices ?? []}
                jobs={jobs}
                logs={logs}
              />
            ) : null}

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
          </ErrorBoundary>
        </div>
      </main>
    </div>
  );
}

/* ---------------------------------------------------------------- 运行时设置 */

const CONFIG_FIELDS: ReadonlyArray<{ key: keyof RuntimeConfig; label: string }> = [
  { key: 'httpAddr', label: '监听地址' },
  { key: 'mediaRoots', label: '媒体目录' },
  { key: 'ffmpegPath', label: 'ffmpeg' },
  { key: 'ffprobePath', label: 'ffprobe' },
  { key: 'maxConcurrentJobs', label: '并发上限' },
];

const SOURCE_LABEL: Record<string, string> = {
  env: '环境变量',
  file: '配置文件',
  default: '默认值',
};

function describeValue(key: keyof RuntimeConfig, values: RuntimeConfig): string {
  if (key === 'mediaRoots') {
    // 后端的约定是「列不出东西就给空数组」，但显示设置的面板不该因为一个字段
    // 把整页带走，所以这里再兜一层。
    const roots = values.mediaRoots ?? [];
    return roots.length > 0 ? roots.join('、') : '未限制';
  }
  const value = values[key];
  return value === '' ? '（空）' : String(value);
}

/**
 * 运行时设置面板。
 *
 * 平时收成一行，只在本次运行刚刚生成配置文件时自动展开——那一刻用户最需要
 * 知道「这些设置从哪来、以后去哪改」。每一项都标出它是被环境变量、配置文件
 * 还是默认值决定的，用来回答「我改了文件怎么没生效」这类问题。
 */
function ConfigNotice({ info }: { info: ConfigInfo }) {
  return (
    <details className={cx(styles.config, info.created && styles.configNew)} open={info.created}>
      <summary className={styles.configSummary}>
        <span>
          {info.created
            ? '已生成初始配置文件，以后直接改它即可（环境变量仍能临时覆盖）'
            : '运行时设置'}
        </span>
        <span className={styles.configPath}>{info.path || '未能确定配置文件位置'}</span>
      </summary>

      <ul className={styles.configList}>
        {CONFIG_FIELDS.map((field) => (
          <li className={styles.configItem} key={field.key}>
            <span className={styles.configKey}>{field.label}</span>
            <span className={styles.configValue} title={describeValue(field.key, info.values)}>
              {describeValue(field.key, info.values)}
            </span>
            <span className={styles.configSource}>
              {SOURCE_LABEL[info.sources?.[field.key] ?? ''] ?? '未知来源'}
            </span>
          </li>
        ))}
      </ul>

      {(info.warnings ?? []).map((warning) => (
        <ErrorNote key={warning}>{warning}</ErrorNote>
      ))}

      <p className={styles.configHint}>
        预设文件也在这个目录下：{info.presetsDir || '（未能确定）'}
      </p>
    </details>
  );
}
