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
import type { MessageKey } from './i18n';
import { useI18n, type I18n } from './i18n/LocaleProvider';
import { LocaleSwitch } from './i18n/LocaleSwitch';
import { cx } from './utils/format';
import styles from './App.module.css';

type SectionId = 'workspace' | 'batch' | 'catalog' | 'hardware';

/**
 * 四个功能域。这里切的是「哪一页」；页内各模块之间的切换是另一回事，
 * 由分栏容器负责，且只在窄屏出现（见 components/Pane.tsx）。
 */
const SECTIONS: ReadonlyArray<{ id: SectionId; labelKey: MessageKey; hintKey: MessageKey }> = [
  { id: 'workspace', labelKey: 'app.nav.workspace', hintKey: 'app.nav.workspace.hint' },
  { id: 'batch', labelKey: 'app.nav.batch', hintKey: 'app.nav.batch.hint' },
  { id: 'catalog', labelKey: 'app.nav.catalog', hintKey: 'app.nav.catalog.hint' },
  { id: 'hardware', labelKey: 'app.nav.hardware', hintKey: 'app.nav.hardware.hint' },
];

/**
 * 应用外壳。
 *
 * 外壳只做两件事：切换功能域、订阅一次事件流。所有功能域共用同一份
 * FFmpeg 能力快照与任务列表，因此切换页面不会重新查询服务器。
 */
export function App() {
  const { t } = useI18n();
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
            <span className={styles.brandName}>{t('app.brand')}</span>
            {/* 版本号长起来会被省略号截断，title 兜住全文。 */}
            <span className={styles.brandMeta} title={shortVersion ?? undefined}>
              {shortVersion ?? t('app.brand.loading')}
            </span>
          </span>
        </div>

        <nav className={styles.nav} aria-label={t('app.nav.label')}>
          {SECTIONS.map((item) => (
            <button
              key={item.id}
              type="button"
              className={cx(styles.navItem, section === item.id && styles.navActive)}
              aria-current={section === item.id ? 'page' : undefined}
              onClick={() => setSection(item.id)}
            >
              <span className={styles.navLabel}>{t(item.labelKey)}</span>
              <span className={styles.navHint}>{t(item.hintKey)}</span>
            </button>
          ))}
        </nav>

        <div className={styles.status}>
          <Badge tone={connected ? 'ok' : 'warn'}>
            {connected ? t('app.status.connected') : t('app.status.disconnected')}
          </Badge>
          {active > 0 ? <Badge tone="accent">{t('app.status.active', { count: active })}</Badge> : null}
          {hardware.data ? (
            <Badge>{t('app.status.devices', { count: hardware.data.devices?.length ?? 0 })}</Badge>
          ) : null}
          <LocaleSwitch />
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
          <ErrorBoundary scopeKey="app.boundary.scope.view">
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
                hardware={hardware.data}
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

const CONFIG_FIELDS: ReadonlyArray<{ key: keyof RuntimeConfig; labelKey: MessageKey }> = [
  { key: 'httpAddr', labelKey: 'config.field.httpAddr' },
  { key: 'mediaRoots', labelKey: 'config.field.mediaRoots' },
  { key: 'ffmpegPath', labelKey: 'config.field.ffmpegPath' },
  { key: 'ffprobePath', labelKey: 'config.field.ffprobePath' },
  { key: 'maxConcurrentJobs', labelKey: 'config.field.maxConcurrentJobs' },
];

/** 后端的 sources 是稳定枚举（见 internal/config），显示文案在这里映射。 */
const SOURCE_KEY: Record<string, MessageKey> = {
  env: 'config.source.env',
  file: 'config.source.file',
  default: 'config.source.default',
};

function describeValue(key: keyof RuntimeConfig, values: RuntimeConfig, t: I18n['t']): string {
  if (key === 'mediaRoots') {
    // 后端的约定是「列不出东西就给空数组」，但显示设置的面板不该因为一个字段
    // 把整页带走，所以这里再兜一层。
    const roots = values.mediaRoots ?? [];
    return roots.length > 0 ? roots.join(t('common.listSeparator')) : t('config.value.unlimited');
  }
  const value = values[key];
  return value === '' ? t('common.empty') : String(value);
}

/**
 * 运行时设置面板。
 *
 * 平时收成一行，只在本次运行刚刚生成配置文件时自动展开——那一刻用户最需要
 * 知道「这些设置从哪来、以后去哪改」。每一项都标出它是被环境变量、配置文件
 * 还是默认值决定的，用来回答「我改了文件怎么没生效」这类问题。
 */
function ConfigNotice({ info }: { info: ConfigInfo }) {
  const { t } = useI18n();

  return (
    <details className={cx(styles.config, info.created && styles.configNew)} open={info.created}>
      <summary className={styles.configSummary}>
        <span>{info.created ? t('config.created') : t('config.title')}</span>
        <span className={styles.configPath}>{info.path || t('config.path.missing')}</span>
      </summary>

      <ul className={styles.configList}>
        {CONFIG_FIELDS.map((field) => (
          <li className={styles.configItem} key={field.key}>
            <span className={styles.configKey}>{t(field.labelKey)}</span>
            <span className={styles.configValue} title={describeValue(field.key, info.values, t)}>
              {describeValue(field.key, info.values, t)}
            </span>
            <span className={styles.configSource}>
              {t(SOURCE_KEY[info.sources?.[field.key] ?? ''] ?? 'config.source.unknown')}
            </span>
          </li>
        ))}
      </ul>

      {(info.warnings ?? []).map((warning) => (
        <ErrorNote
          key={warning.code}
          code={warning.code}
          params={warning.params}
          fallback={warning.message}
        />
      ))}

      <p className={styles.configHint}>
        {t('config.hint.presets', { dir: info.presetsDir || t('config.value.missing') })}
      </p>
    </details>
  );
}
