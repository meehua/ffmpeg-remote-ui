import type { HardwareInfo, Snapshot } from '../../api/types';
import { Badge, DataList, EmptyState } from '../../components/Display';
import { Pane, Panes } from '../../components/Pane';
import { useI18n } from '../../i18n/LocaleProvider';
import { platformOf } from '../workspace/args';
import styles from './HardwareView.module.css';

interface HardwareViewProps {
  snapshot: Snapshot | null;
  hardware: HardwareInfo | null;
}

/** 硬件页：只陈列服务器实际报告的东西，不做能力推断。 */
export function HardwareView({ snapshot, hardware }: HardwareViewProps) {
  const { t, formatDate } = useI18n();
  const devices = hardware?.devices ?? [];
  // 设备字段与加速方法都随服务器平台变，所以这里也照服务器说的来，
  // 而不是照浏览器所在的系统猜。
  const platform = platformOf(hardware?.os);

  return (
    <Panes columns={2}>
      <Pane title={t('hw.devices.title')} description={t('hw.devices.description')}>
        {hardware === null ? (
          <EmptyState title={t('hw.devices.loading')} />
        ) : devices.length === 0 ? (
          <EmptyState title={t('hw.devices.empty.title')} hint={t('hw.devices.empty.hint')} />
        ) : (
          <ul className={styles.devices}>
            {devices.map((device) => (
              <li className={styles.device} key={device.id}>
                <header className={styles.deviceHead}>
                  {/* 有型号就用型号当标题，认卡比看 ID 直观得多。 */}
                  <span className={styles.deviceId}>
                    {device.deviceName || device.pciAddress || device.id}
                  </span>
                  {device.driver ? <Badge tone="accent">{device.driver}</Badge> : null}
                </header>

                <DataList
                  dense
                  items={[
                    { label: t('hw.field.model'), value: device.deviceName || '—' },
                    { label: t('hw.field.vendor'), value: device.vendorName || '—' },
                    {
                      label: t('hw.field.ids'),
                      value: `${device.vendor ?? '—'} / ${device.deviceId ?? '—'}`,
                    },
                    // render node、card node、sysfs 与 PCI 地址都是 DRM 那一套的概念，
                    // 没有它们的平台上这几项恒为空，列出来只是占地方。
                    ...(platform === 'posix'
                      ? [
                          { label: t('hw.field.renderNode'), value: device.renderNode ?? '—' },
                          { label: t('hw.field.cardNode'), value: device.cardNode ?? '—' },
                          { label: t('hw.field.pci'), value: device.pciAddress ?? '—' },
                          { label: t('hw.field.sysfs'), value: device.sysfsPath ?? '—' },
                        ]
                      : []),
                  ]}
                />

                {device.properties && Object.keys(device.properties).length > 0 ? (
                  <details className={styles.raw}>
                    <summary className={styles.rawSummary}>{t('hw.raw.fields')}</summary>
                    <pre className={styles.pre}>
                      {Object.entries(device.properties)
                        .map(([key, value]) => `${key}=${value}`)
                        .join('\n')}
                    </pre>
                  </details>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </Pane>

      <Pane title={t('hw.accel.title')} description={t('hw.accel.description')}>
        {snapshot === null ? (
          <EmptyState title={t('hw.accel.loading')} />
        ) : (
          <>
            <div className={styles.chips}>
              {snapshot.hwaccels.length === 0 ? (
                <span className={styles.muted}>{t('hw.accel.empty')}</span>
              ) : (
                snapshot.hwaccels.map((item) => (
                  <Badge tone="accent" mono key={item}>
                    {item}
                  </Badge>
                ))
              )}
            </div>

            <DataList
              items={[
                {
                  label: t('hw.meta.os'),
                  value: hardware ? `${hardware.os} / ${hardware.arch}` : '—',
                },
                { label: t('hw.meta.ffmpeg'), value: snapshot.ffmpegPath },
                { label: t('hw.meta.ffprobe'), value: snapshot.ffprobePath },
                { label: t('hw.meta.version'), value: snapshot.version },
                // 时刻按当前语言格式化，跟界面其余部分保持一致。
                { label: t('hw.meta.queriedAt'), value: formatDate(snapshot.generatedAt) },
                {
                  label: t('hw.meta.codecs'),
                  value: `${snapshot.encoders.length} / ${snapshot.decoders.length}`,
                },
                {
                  label: t('hw.meta.filters'),
                  value: `${snapshot.filters.length} / ${snapshot.formats.length}`,
                },
              ]}
            />

            <details className={styles.raw}>
              <summary className={styles.rawSummary}>{t('hw.raw.version')}</summary>
              <pre className={styles.pre}>{snapshot.buildConfig}</pre>
            </details>
          </>
        )}
      </Pane>
    </Panes>
  );
}
